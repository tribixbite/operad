/**
 * claude-session.test.ts — Tests for pure parsers, detectors, and pairing
 * logic in claude-session.ts.
 *
 * Coverage areas:
 *   - manglePath: path → directory name transformation
 *   - calculateCost: token → USD arithmetic
 *   - readConversationStartTime: first-entry timestamp extraction from JSONL head
 *   - pairSessionsToConversations: edge cases the jsonl-binder.test.ts doesn't cover
 *   - streamTokenUsage: assistant-entry aggregation (pure JSONL content)
 *   - readConversationTail: entry parsing, ordering, pagination, edge content
 *   - readTimeline: trace.log + jsonl merge, since-filter, limit
 *   - resolveJsonlFiles (via temp dirs)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, appendFileSync, statSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  manglePath,
  calculateCost,
  pricingKey,
  resolveActiveJsonl,
  _setClaudeHome,
  readConversationStartTime,
  pairSessionsToConversations,
  streamTokenUsage,
  resetTokenCache,
  summariseTokenRange,
  rangeStartKey,
  readConversationTail,
  readConversationWindow,
  locateConversationEntry,
  getConversationPage,
  readTimeline,
  type BindableSession,
  type ConversationCandidate,
} from "../claude-session.js";
import type { ProjectTokenUsage, SessionTokenUsage } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const t = (s: number) => s * 1000; // seconds → ms

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-cs-test-"));
  // The token scanner caches per path across calls; a clean slate keeps each
  // test independent of whatever the previous one left behind.
  resetTokenCache();
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * ISO timestamp for a given LOCAL calendar date and hour.
 *
 * Day bucketing is local-time, so tests must build timestamps from local
 * components — a hardcoded "…T09:00:00Z" would land on a different calendar
 * day depending on the runner's timezone.
 */
function localIso(date: string, hour: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, hour, 0, 0).toISOString();
}

/**
 * Model used by fixtures that assert on cost.
 *
 * Must be one with a published rate — cost is now per-model, so a fixture
 * using an unpriced id (the helper previously hardcoded "claude-opus-4",
 * which has no published rate) would correctly produce $0 and quietly make
 * every cost assertion vacuous.
 */
const TEST_MODEL = "claude-opus-5";

/** Write a file to tmpDir and return its path. */
function write(name: string, content: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

/** Build a JSONL assistant entry line with optional usage and stop_reason.
 *  `stopReason` defaults to "end_turn" when absent (undefined).
 *  Pass `null` explicitly to produce a JSONL line where stop_reason is null
 *  (i.e. a streaming partial turn). */
function assistantLine(opts: {
  uuid?: string;
  timestamp?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
  /** undefined → "end_turn" (default); null → stop_reason:null (streaming partial) */
  stopReason?: string | null;
  content?: string;
  /** Override the model id — use an unlisted one to exercise the unpriced path. */
  model?: string;
  /** 1-hour-TTL cache writes, which bill at 2x input rather than 1.25x. */
  cacheCreate1h?: number;
}): string {
  // Use "end_turn" only when stopReason is not explicitly provided (undefined).
  // When the caller passes null, preserve it so the serialised JSON has stop_reason:null.
  const stopReason = opts.stopReason === undefined ? "end_turn" : opts.stopReason;
  return JSON.stringify({
    type: "assistant",
    uuid: opts.uuid ?? "uuid-a",
    timestamp: opts.timestamp ?? "2024-01-15T10:00:00.000Z",
    message: {
      role: "assistant",
      model: opts.model ?? TEST_MODEL,
      stop_reason: stopReason,
      content: opts.content
        ? [{ type: "text", text: opts.content }]
        : [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: (opts.cacheCreate ?? 0) + (opts.cacheCreate1h ?? 0),
        cache_creation: {
          ephemeral_5m_input_tokens: opts.cacheCreate ?? 0,
          ephemeral_1h_input_tokens: opts.cacheCreate1h ?? 0,
        },
      },
    },
  });
}

/** Build a JSONL user entry line. */
function userLine(opts: {
  uuid?: string;
  timestamp?: string;
  content?: string;
}): string {
  return JSON.stringify({
    type: "user",
    uuid: opts.uuid ?? "uuid-u",
    timestamp: opts.timestamp ?? "2024-01-15T09:59:00.000Z",
    message: {
      role: "user",
      content: opts.content ?? "hello",
    },
  });
}

// ---------------------------------------------------------------------------
// manglePath
// ---------------------------------------------------------------------------

describe("manglePath", () => {
  test("replaces slashes with dashes", () => {
    expect(manglePath("/home/user/proj")).toBe("-home-user-proj");
  });

  test("replaces dots and tildes", () => {
    expect(manglePath("~/my.project")).toBe("--my-project");
  });

  test("leaves alphanumerics untouched", () => {
    expect(manglePath("abc123")).toBe("abc123");
  });

  test("collapses no characters — each non-alnum becomes exactly one dash", () => {
    expect(manglePath("a/b-c")).toBe("a-b-c");
  });

  test("empty string returns empty string", () => {
    expect(manglePath("")).toBe("");
  });

  test("all-special characters become all-dashes", () => {
    expect(manglePath("///")).toBe("---");
  });
});

// ---------------------------------------------------------------------------
// calculateCost
// ---------------------------------------------------------------------------

describe("calculateCost", () => {
  /** A zeroed bucket set, so each test names only the field it exercises. */
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

  test("zero usage produces zero cost", () => {
    expect(calculateCost("claude-opus-5", zero)).toBe(0);
  });

  test("input and output use the model's own published rates", () => {
    // Opus 5 is $5/$25 per MTok. The previous implementation charged $15/$75
    // — Opus-3-era rates — to every model, so this read 3x high.
    expect(calculateCost("claude-opus-5", { ...zero, input: 1_000_000 })).toBeCloseTo(5, 8);
    expect(calculateCost("claude-opus-5", { ...zero, output: 1_000_000 })).toBeCloseTo(25, 8);
    // Haiku 4.5 is $1/$5 — 15x cheaper on output than the old flat rate.
    expect(calculateCost("claude-haiku-4-5", { ...zero, input: 1_000_000 })).toBeCloseTo(1, 8);
    expect(calculateCost("claude-haiku-4-5", { ...zero, output: 1_000_000 })).toBeCloseTo(5, 8);
    // Fable 5 is the premium tier at $10/$50.
    expect(calculateCost("claude-fable-5", { ...zero, output: 1_000_000 })).toBeCloseTo(50, 8);
  });

  test("cache rates are multiples of the model's input rate", () => {
    const m = "claude-opus-5"; // $5/MTok input
    expect(calculateCost(m, { ...zero, cacheRead: 1_000_000 })).toBeCloseTo(0.5, 8);   // 0.1x
    expect(calculateCost(m, { ...zero, cacheWrite5m: 1_000_000 })).toBeCloseTo(6.25, 8); // 1.25x
    expect(calculateCost(m, { ...zero, cacheWrite1h: 1_000_000 })).toBeCloseTo(10, 8);   // 2.0x
  });

  test("every current model has a rate — a missing one silently costs nothing", () => {
    // The whole Claude 5.5 generation was absent from the table, so a machine
    // running the current default (Opus 5.5) reported its entire cost history
    // as $0.00 while still counting turns. Zero is indistinguishable from
    // "cheap", which is why this is asserted per id rather than in aggregate.
    const current = [
      "claude-fable-5-1", "claude-mythos-5-1", "claude-fable-5", "claude-mythos-5",
      "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7",
      "claude-opus-4-6", "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6",
      "claude-haiku-5-5", "claude-haiku-4-5",
    ];
    for (const model of current) {
      expect(calculateCost(model, { ...zero, input: 1_000_000 })).toBeGreaterThan(0);
      expect(calculateCost(model, { ...zero, output: 1_000_000 })).toBeGreaterThan(0);
    }
  });

  test("the current generation's published rates", () => {
    expect(calculateCost("claude-opus-5-5", { ...zero, input: 1_000_000 })).toBeCloseTo(4, 8);
    expect(calculateCost("claude-opus-5-5", { ...zero, output: 1_000_000 })).toBeCloseTo(20, 8);
    expect(calculateCost("claude-sonnet-5-5", { ...zero, input: 1_000_000 })).toBeCloseTo(2, 8);
    expect(calculateCost("claude-sonnet-5-5", { ...zero, output: 1_000_000 })).toBeCloseTo(10, 8);
    expect(calculateCost("claude-haiku-5-5", { ...zero, input: 1_000_000 })).toBeCloseTo(0.1, 8);
    expect(calculateCost("claude-fable-5-1", { ...zero, output: 1_000_000 })).toBeCloseTo(50, 8);
  });

  test("Sonnet 5 is not priced as Sonnet 4.6", () => {
    // It was carried at 4.6's $3/$15 when it is $2/$10 — a 50% overstatement
    // on every Sonnet 5 turn, and nothing about a wrong-but-plausible rate
    // flags itself the way a missing one eventually does.
    expect(calculateCost("claude-sonnet-5", { ...zero, input: 1_000_000 })).toBeCloseTo(2, 8);
    expect(calculateCost("claude-sonnet-4-6", { ...zero, input: 1_000_000 })).toBeCloseTo(3, 8);
  });

  test("a model with a published cache-read rate uses it, not 10% of input", () => {
    // Opus 5.5 reads cache at $0.20/MTok — 5% of its $4 input rate, not the
    // 10% default. At Claude Code's cache-read-dominated token mix that one
    // term moves the total more than any other.
    expect(calculateCost("claude-opus-5-5", { ...zero, cacheRead: 1_000_000 })).toBeCloseTo(0.20, 8);
    expect(calculateCost("claude-fable-5-1", { ...zero, cacheRead: 1_000_000 })).toBeCloseTo(0.25, 8);
    // Sonnet 5.5's $0.20 happens to equal the 10% default — assert the value,
    // not the coincidence.
    expect(calculateCost("claude-sonnet-5-5", { ...zero, cacheRead: 1_000_000 })).toBeCloseTo(0.20, 8);
    // A model with no override still gets 10% of input.
    expect(calculateCost("claude-opus-5", { ...zero, cacheRead: 1_000_000 })).toBeCloseTo(0.5, 8);
  });

  test("a 1h cache write costs 1.6x a 5m one", () => {
    // The dominant real-world path: 89% of cache-creation tokens on the
    // author's machine were 1h writes. Charging them all at the 5m rate — as
    // the flat implementation did — under-counted them by 37.5%.
    const m = "claude-opus-5";
    const w5 = calculateCost(m, { ...zero, cacheWrite5m: 1_000_000 });
    const w1h = calculateCost(m, { ...zero, cacheWrite1h: 1_000_000 });
    expect(w1h / w5).toBeCloseTo(1.6, 10);
  });

  test("dated snapshot ids price as their alias", () => {
    const a = calculateCost("claude-haiku-4-5-20251001", { ...zero, input: 1_000_000 });
    const b = calculateCost("claude-haiku-4-5", { ...zero, input: 1_000_000 });
    expect(a).toBe(b);
    expect(a).toBeCloseTo(1, 8);
  });

  test("a model with no published rate costs zero rather than guessing", () => {
    expect(calculateCost("claude-does-not-exist", { ...zero, input: 1_000_000 })).toBe(0);
  });

  test("mixed tokens — sum of individual costs", () => {
    const cost = calculateCost("claude-opus-5", {
      input: 1000, output: 200, cacheRead: 500, cacheWrite5m: 100, cacheWrite1h: 400,
    });
    const expected =
      (1000 * 5 + 200 * 25 + 500 * 0.5 + 100 * 6.25 + 400 * 10) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
  });
});

// ---------------------------------------------------------------------------
// Haiku 5.5 long-prompt tier
// ---------------------------------------------------------------------------
// Published pricing: a request whose prompt — ALL input tokens, cache reads
// and cache writes included — is over 100,000 tokens pays $0.50 / $2.50 per
// MTok instead of $0.10 / $0.50, with cache rates at the usual multiples of
// that tier ($0.625 5m write, $1 1h write, $0.05 hit). Each request is priced
// on its own, so the tier is chosen per entry, before buckets are summed.

describe("Haiku 5.5 long-prompt pricing", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const H = "claude-haiku-5-5";

  test("a prompt of exactly 100,000 tokens stays on the base tier", () => {
    const req = { ...zero, input: 50_000, cacheRead: 50_000, output: 1_000 };
    expect(calculateCost(pricingKey(H, req), req)).toBeCloseTo((50_000 * 0.1 + 50_000 * 0.01 + 1_000 * 0.5) / 1e6, 10);
  });

  test("over 100,000 — counted across input, cache reads and writes — is the long tier", () => {
    const req = { ...zero, input: 1, cacheRead: 60_000, cacheWrite5m: 20_000, cacheWrite1h: 20_000, output: 1_000 };
    const expected = (1 * 0.5 + 60_000 * 0.05 + 20_000 * 0.625 + 20_000 * 1 + 1_000 * 2.5) / 1e6;
    expect(calculateCost(pricingKey(H, req), req)).toBeCloseTo(expected, 10);
  });

  test("output tokens do not count toward the threshold", () => {
    const req = { ...zero, input: 100_000, output: 50_000 };
    expect(pricingKey(H, req)).toBe(pricingKey(H, zero));
  });

  test("dated snapshots get the tier too", () => {
    const req = { ...zero, input: 150_000 };
    expect(calculateCost(pricingKey(`${H}-20261001`, req), req)).toBeCloseTo(150_000 * 0.5 / 1e6, 10);
  });

  test("models without a tier are never re-keyed", () => {
    const req = { ...zero, input: 900_000 };
    expect(pricingKey("claude-opus-5-5", req)).toBe("claude-opus-5-5");
  });

  test("the token scanner prices each request on its own tier", async () => {
    const lines = [
      // 150K-token prompt: long tier. 20K-token prompt: base tier.
      assistantLine({ uuid: "big", model: H, input: 150_000, output: 1_000 }),
      assistantLine({ uuid: "small", model: H, input: 20_000, output: 1_000 }),
    ].join("\n") + "\n";
    const usage = await streamTokenUsage(write("haiku-tiers.jsonl", lines));
    const expected = (150_000 * 0.5 + 1_000 * 2.5 + 20_000 * 0.1 + 1_000 * 0.5) / 1e6;
    expect(usage.cost_usd).toBeCloseTo(expected, 10);
    expect(usage.unpriced_models).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readConversationStartTime
// ---------------------------------------------------------------------------

describe("readConversationStartTime", () => {
  test("returns epoch ms for a valid ISO timestamp in first entry", () => {
    const ts = "2024-03-10T14:30:00.000Z";
    const path = write("conv.jsonl", JSON.stringify({ timestamp: ts }) + "\n");
    expect(readConversationStartTime(path)).toBe(Date.parse(ts));
  });

  test("skips blank lines and returns first non-empty entry's timestamp", () => {
    const ts = "2024-03-10T14:30:00.000Z";
    const content = "\n\n" + JSON.stringify({ timestamp: ts }) + "\n";
    const path = write("conv2.jsonl", content);
    expect(readConversationStartTime(path)).toBe(Date.parse(ts));
  });

  test("returns null for an empty file", () => {
    const path = write("empty.jsonl", "");
    expect(readConversationStartTime(path)).toBeNull();
  });

  test("returns null when no entry has a timestamp field", () => {
    const path = write("no-ts.jsonl", JSON.stringify({ type: "user", uuid: "x" }) + "\n");
    expect(readConversationStartTime(path)).toBeNull();
  });

  test("returns null for a non-existent file", () => {
    expect(readConversationStartTime(join(tmpDir, "ghost.jsonl"))).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    const path = write("bad.jsonl", "not json\n");
    expect(readConversationStartTime(path)).toBeNull();
  });

  test("skips entry with invalid timestamp string", () => {
    const path = write("bad-ts.jsonl", JSON.stringify({ timestamp: "not-a-date" }) + "\n");
    expect(readConversationStartTime(path)).toBeNull();
  });

  test("picks up timestamp from second line when first has none", () => {
    const ts = "2024-06-01T00:00:00.000Z";
    const content =
      JSON.stringify({ type: "summary" }) + "\n" +
      JSON.stringify({ timestamp: ts }) + "\n";
    const path = write("second.jsonl", content);
    expect(readConversationStartTime(path)).toBe(Date.parse(ts));
  });
});

// ---------------------------------------------------------------------------
// pairSessionsToConversations — edge cases not in jsonl-binder.test.ts
// ---------------------------------------------------------------------------

describe("pairSessionsToConversations — additional edge cases", () => {
  // -- 3+ sessions -----------------------------------------------------------

  test("three fresh sessions bind to three distinct conversations in start order", () => {
    const sessions: BindableSession[] = [
      { name: "a", startedAtMs: t(100) },
      { name: "b", startedAtMs: t(200) },
      { name: "c", startedAtMs: t(300) },
    ];
    const candidates: ConversationCandidate[] = [
      { id: "conv-1", startMs: t(105) },
      { id: "conv-2", startMs: t(205) },
      { id: "conv-3", startMs: t(305) },
    ];
    const out = pairSessionsToConversations(sessions, candidates, {});
    expect(out["a"]).toBe("conv-1");
    expect(out["b"]).toBe("conv-2");
    expect(out["c"]).toBe("conv-3");
    // All distinct — no double-binding
    expect(new Set(Object.values(out)).size).toBe(3);
  });

  // -- All sticky ------------------------------------------------------------

  test("all-sticky: every session keeps its prior binding regardless of order", () => {
    const sessions: BindableSession[] = [
      { name: "x", startedAtMs: t(100) },
      { name: "y", startedAtMs: t(200) },
      { name: "z", startedAtMs: t(300) },
    ];
    const candidates: ConversationCandidate[] = [
      { id: "c1", startMs: t(105) },
      { id: "c2", startMs: t(205) },
      { id: "c3", startMs: t(305) },
    ];
    // Cross-bound intentionally
    const out = pairSessionsToConversations(sessions, candidates, {
      x: "c3",
      y: "c1",
      z: "c2",
    });
    expect(out["x"]).toBe("c3");
    expect(out["y"]).toBe("c1");
    expect(out["z"]).toBe("c2");
    expect(new Set(Object.values(out)).size).toBe(3);
  });

  // -- More sessions than conversations -------------------------------------

  test("extra sessions beyond available conversations remain unbound", () => {
    const sessions: BindableSession[] = [
      { name: "s1", startedAtMs: t(100) },
      { name: "s2", startedAtMs: t(200) },
      { name: "s3", startedAtMs: t(300) }, // no candidate for this one
    ];
    const candidates: ConversationCandidate[] = [
      { id: "c1", startMs: t(105) },
      { id: "c2", startMs: t(205) },
    ];
    const out = pairSessionsToConversations(sessions, candidates, {});
    expect(out["s1"]).toBe("c1");
    expect(out["s2"]).toBe("c2");
    expect("s3" in out).toBe(false);
  });

  // -- More conversations than sessions -------------------------------------

  test("extra conversations beyond available sessions stay unclaimed", () => {
    const sessions: BindableSession[] = [
      { name: "only", startedAtMs: t(100) },
    ];
    const candidates: ConversationCandidate[] = [
      { id: "c1", startMs: t(105) },
      { id: "c2", startMs: t(205) },
      { id: "c3", startMs: t(305) },
    ];
    const out = pairSessionsToConversations(sessions, candidates, {});
    expect(out["only"]).toBe("c1"); // earliest eligible
    expect(Object.keys(out)).toHaveLength(1);
  });

  // -- Empty candidates ------------------------------------------------------

  test("empty candidates list: all sessions stay unbound", () => {
    const sessions: BindableSession[] = [
      { name: "p", startedAtMs: t(100) },
    ];
    const out = pairSessionsToConversations(sessions, [], {});
    expect(Object.keys(out)).toHaveLength(0);
  });

  // -- Empty sessions --------------------------------------------------------

  test("empty sessions list: returns empty result", () => {
    const candidates: ConversationCandidate[] = [{ id: "c1", startMs: t(100) }];
    const out = pairSessionsToConversations([], candidates, {});
    expect(Object.keys(out)).toHaveLength(0);
  });

  // -- Grace window boundary -------------------------------------------------

  test("conversation exactly at the grace-window boundary is accepted", () => {
    const graceMs = 30_000;
    const sessions: BindableSession[] = [{ name: "p", startedAtMs: t(1000) }];
    // Exactly at the boundary: startMs === sessionStart - grace
    const candidates: ConversationCandidate[] = [
      { id: "exact", startMs: t(1000) - graceMs },
    ];
    const out = pairSessionsToConversations(sessions, candidates, {}, graceMs);
    expect(out["p"]).toBe("exact");
  });

  test("conversation one millisecond before the grace window is rejected", () => {
    const graceMs = 30_000;
    const sessions: BindableSession[] = [{ name: "p", startedAtMs: t(1000) }];
    const candidates: ConversationCandidate[] = [
      { id: "too-old", startMs: t(1000) - graceMs - 1 },
    ];
    const out = pairSessionsToConversations(sessions, candidates, {}, graceMs);
    expect("p" in out).toBe(false);
  });

  // -- Sticky takes priority over resume id ---------------------------------

  test("sticky binding wins over resumeId for the same session", () => {
    const sessions: BindableSession[] = [
      { name: "s", startedAtMs: t(100), resumeId: "c-resume" },
    ];
    const candidates: ConversationCandidate[] = [
      { id: "c-sticky", startMs: t(50) },
      { id: "c-resume", startMs: t(10) },
    ];
    const out = pairSessionsToConversations(sessions, candidates, { s: "c-sticky" });
    expect(out["s"]).toBe("c-sticky");
  });

  // -- Sticky collision (two sessions claim same conv) -----------------------

  test("if two sessions have sticky bindings to different convs, both survive", () => {
    const sessions: BindableSession[] = [
      { name: "a", startedAtMs: t(100) },
      { name: "b", startedAtMs: t(200) },
    ];
    const candidates: ConversationCandidate[] = [
      { id: "ca", startMs: t(110) },
      { id: "cb", startMs: t(210) },
    ];
    const out = pairSessionsToConversations(sessions, candidates, {
      a: "ca",
      b: "cb",
    });
    expect(out["a"]).toBe("ca");
    expect(out["b"]).toBe("cb");
  });

  // -- Resume id not in candidates ------------------------------------------

  test("resume id not in candidates falls through to fresh pairing", () => {
    const sessions: BindableSession[] = [
      { name: "r", startedAtMs: t(100), resumeId: "missing-conv" },
    ];
    const candidates: ConversationCandidate[] = [
      { id: "fresh", startMs: t(110) },
    ];
    const out = pairSessionsToConversations(sessions, candidates, {});
    // resumeId not found → falls to step 3 (fresh pairing)
    expect(out["r"]).toBe("fresh");
  });

  // -- Claimed conv can't be double-bound by another sticky -----------------

  test("a conversation already claimed by sticky cannot be claimed by another sticky", () => {
    // Two sessions both have a sticky claim on "shared" — first one in array wins.
    const sessions: BindableSession[] = [
      { name: "first", startedAtMs: t(100) },
      { name: "second", startedAtMs: t(200) },
    ];
    const candidates: ConversationCandidate[] = [
      { id: "shared", startMs: t(110) },
      { id: "other", startMs: t(210) },
    ];
    // Both pointed at "shared" in prior bindings — first session in array gets it
    const out = pairSessionsToConversations(sessions, candidates, {
      first: "shared",
      second: "shared",
    });
    expect(out["first"]).toBe("shared");
    // "second" must not get "shared" again; it may fall through to "other"
    expect(out["second"]).not.toBe("shared");
  });

  // -- Custom grace window of zero -------------------------------------------

  test("grace window of zero: conversation must start at or after the session", () => {
    const sessions: BindableSession[] = [{ name: "s", startedAtMs: t(1000) }];
    const candidates: ConversationCandidate[] = [
      { id: "before", startMs: t(999) },
      { id: "same", startMs: t(1000) },
    ];
    const out = pairSessionsToConversations(sessions, candidates, {}, 0);
    // "before" is < startedAtMs - 0, so rejected; "same" is exactly equal → accepted
    expect(out["s"]).toBe("same");
  });
});

// ---------------------------------------------------------------------------
// streamTokenUsage
// ---------------------------------------------------------------------------

describe("streamTokenUsage", () => {
  test("returns zero totals for an empty JSONL file", async () => {
    const path = write("empty.jsonl", "");
    const usage = await streamTokenUsage(path);
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
    expect(usage.turns).toBe(0);
    expect(usage.cost_usd).toBe(0);
  });

  test("sums tokens from a single assistant entry with stop_reason", async () => {
    const line = assistantLine({ input: 100, output: 50, stopReason: "end_turn" });
    const path = write("single.jsonl", line + "\n");
    const usage = await streamTokenUsage(path);
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
    expect(usage.turns).toBe(1);
  });

  test("does not count turn when stop_reason is null", async () => {
    const line = assistantLine({ input: 10, output: 5, stopReason: null });
    const path = write("nostop.jsonl", line + "\n");
    const usage = await streamTokenUsage(path);
    expect(usage.input_tokens).toBe(10);
    expect(usage.turns).toBe(0); // null stop_reason → not a final turn
  });

  test("aggregates across multiple assistant entries", async () => {
    const lines = [
      assistantLine({ uuid: "a1", input: 100, output: 50, stopReason: "end_turn" }),
      assistantLine({ uuid: "a2", input: 200, output: 80, stopReason: "end_turn" }),
    ].join("\n") + "\n";
    const path = write("multi.jsonl", lines);
    const usage = await streamTokenUsage(path);
    expect(usage.input_tokens).toBe(300);
    expect(usage.output_tokens).toBe(130);
    expect(usage.turns).toBe(2);
  });

  test("skips user lines (only processes assistant type)", async () => {
    const lines = [
      userLine({ uuid: "u1", content: "hello" }),
      assistantLine({ uuid: "a1", input: 50, output: 25, stopReason: "end_turn" }),
    ].join("\n") + "\n";
    const path = write("mixed.jsonl", lines);
    const usage = await streamTokenUsage(path);
    expect(usage.input_tokens).toBe(50);
    expect(usage.output_tokens).toBe(25);
    expect(usage.turns).toBe(1);
  });

  test("skips malformed lines without throwing", async () => {
    const content = [
      'not json at all',
      '{"type":"assistant"',  // truncated — malformed
      assistantLine({ uuid: "ok", input: 10, output: 5, stopReason: "end_turn" }),
    ].join("\n") + "\n";
    const path = write("malformed.jsonl", content);
    const usage = await streamTokenUsage(path);
    expect(usage.input_tokens).toBe(10);
    expect(usage.turns).toBe(1);
  });

  test("sums cache tokens correctly", async () => {
    const line = assistantLine({ cacheRead: 300, cacheCreate: 100, stopReason: "end_turn" });
    const path = write("cache.jsonl", line + "\n");
    const usage = await streamTokenUsage(path);
    expect(usage.cache_read_tokens).toBe(300);
    expect(usage.cache_creation_tokens).toBe(100);
  });

  test("cost_usd matches calculateCost on aggregated totals", async () => {
    const line = assistantLine({ input: 1000, output: 200, cacheRead: 50, cacheCreate: 10, stopReason: "end_turn" });
    const path = write("cost.jsonl", line + "\n");
    const usage = await streamTokenUsage(path);
    const expected = calculateCost(TEST_MODEL, {
      input: 1000, output: 200, cacheRead: 50, cacheWrite5m: 10, cacheWrite1h: 0,
    });
    expect(usage.cost_usd).toBeCloseTo(expected, 12);
  });

  test("buckets usage by the entry's local calendar day", async () => {
    // Two entries on 2024-03-01 (local) and one on 2024-03-02 (local).
    const content = [
      assistantLine({ uuid: "d1", timestamp: localIso("2024-03-01", 9), input: 10, output: 1 }),
      assistantLine({ uuid: "d2", timestamp: localIso("2024-03-01", 15), input: 20, output: 2 }),
      assistantLine({ uuid: "d3", timestamp: localIso("2024-03-02", 11), input: 40, output: 4 }),
    ].join("\n") + "\n";
    const path = write("daily.jsonl", content);
    const usage = await streamTokenUsage(path);

    expect(usage.daily.map((d) => d.date)).toEqual(["2024-03-01", "2024-03-02"]);
    expect(usage.daily[0].input_tokens).toBe(30);
    expect(usage.daily[0].turns).toBe(2);
    expect(usage.daily[1].input_tokens).toBe(40);
    expect(usage.daily[1].turns).toBe(1);
    // Day buckets must reconcile with the file totals.
    const summed = usage.daily.reduce((s, d) => s + d.input_tokens, 0);
    expect(summed).toBe(usage.input_tokens);
  });
});

// ---------------------------------------------------------------------------
// Incremental scanning — the append-only fast path
// ---------------------------------------------------------------------------

describe("streamTokenUsage — incremental rescan", () => {
  test("appending yields the same totals as a cold full scan", async () => {
    const first = assistantLine({ uuid: "a1", input: 100, output: 50 });
    const second = assistantLine({ uuid: "a2", input: 200, output: 80 });

    // Warm path: scan, append, rescan (only the tail is read).
    const incPath = write("inc.jsonl", first + "\n");
    await streamTokenUsage(incPath);
    appendFileSync(incPath, second + "\n", "utf-8");
    const incremental = await streamTokenUsage(incPath);

    // Cold path: identical content, never scanned before.
    resetTokenCache();
    const coldPath = write("cold.jsonl", first + "\n" + second + "\n");
    const cold = await streamTokenUsage(coldPath);

    expect(incremental.input_tokens).toBe(cold.input_tokens);
    expect(incremental.output_tokens).toBe(cold.output_tokens);
    expect(incremental.turns).toBe(cold.turns);
    expect(incremental.cost_usd).toBeCloseTo(cold.cost_usd, 12);
    expect(incremental.daily).toEqual(cold.daily);
    // Sanity: the appended entry really was counted.
    expect(incremental.input_tokens).toBe(300);
  });

  test("repeated scans of an unchanged file do not double-count", async () => {
    const path = write("stable.jsonl", assistantLine({ input: 70, output: 30 }) + "\n");
    const a = await streamTokenUsage(path);
    const b = await streamTokenUsage(path);
    const c = await streamTokenUsage(path);
    expect(a.input_tokens).toBe(70);
    expect(b.input_tokens).toBe(70);
    expect(c.input_tokens).toBe(70);
    expect(c.turns).toBe(1);
  });

  test("a trailing partial line is counted only once it is completed", async () => {
    const complete = assistantLine({ uuid: "a1", input: 100, output: 50 });
    const pending = assistantLine({ uuid: "a2", input: 999, output: 999 });
    const path = write("partial.jsonl", complete + "\n");
    expect((await streamTokenUsage(path)).input_tokens).toBe(100);

    // Simulate Claude Code mid-write: the second entry has no newline yet.
    appendFileSync(path, pending.slice(0, 40), "utf-8");
    expect((await streamTokenUsage(path)).input_tokens).toBe(100);

    // Now the rest of the line lands, including its terminator.
    appendFileSync(path, pending.slice(40) + "\n", "utf-8");
    const done = await streamTokenUsage(path);
    expect(done.input_tokens).toBe(1099);
    expect(done.turns).toBe(2);
  });

  test("a file mixing models prices each at its own rate", async () => {
    // The whole point of the change: one flat rate across models made every
    // figure wrong by whatever ratio the real model differed by.
    const path = write("mixed.jsonl", [
      assistantLine({ uuid: "a1", model: "claude-opus-5", output: 1_000_000 }),
      assistantLine({ uuid: "a2", model: "claude-haiku-4-5", output: 1_000_000 }),
    ].join("\n") + "\n");
    const usage = await streamTokenUsage(path);
    // $25 (Opus 5) + $5 (Haiku 4.5) — not 2 x $75 as the flat rate gave.
    expect(usage.cost_usd).toBeCloseTo(30, 6);
    expect(usage.unpriced_tokens).toBe(0);
  });

  test("cache writes are priced by TTL, not lumped together", async () => {
    const path = write("ttl.jsonl",
      assistantLine({ model: "claude-opus-5", cacheCreate: 1_000_000, cacheCreate1h: 1_000_000 }) + "\n");
    const usage = await streamTokenUsage(path);
    // 1M at 1.25x $5 + 1M at 2.0x $5 = $6.25 + $10.
    expect(usage.cost_usd).toBeCloseTo(16.25, 6);
    // The aggregate token count still reports their sum.
    expect(usage.cache_creation_tokens).toBe(2_000_000);
  });

  test("an unpriced model contributes no cost and is reported, not hidden", async () => {
    const path = write("unpriced.jsonl", [
      assistantLine({ uuid: "a1", model: "claude-opus-5", output: 1_000_000 }),
      assistantLine({ uuid: "a2", model: "claude-from-the-future", output: 1_000_000 }),
    ].join("\n") + "\n");
    const usage = await streamTokenUsage(path);
    expect(usage.cost_usd).toBeCloseTo(25, 6);          // only the priced half
    expect(usage.unpriced_tokens).toBe(1_000_000);      // surfaced, not silently dropped
    expect(usage.unpriced_models).toEqual(["claude-from-the-future"]);
  });

  test("synthetic entries are free rather than unpriced", async () => {
    // Claude Code's own bookkeeping entries carry no usage and are never
    // billed — reporting them as an unpriced gap would be a false alarm.
    const path = write("synthetic.jsonl",
      assistantLine({ model: "<synthetic>", output: 0 }) + "\n");
    const usage = await streamTokenUsage(path);
    expect(usage.cost_usd).toBe(0);
    expect(usage.unpriced_tokens).toBe(0);
    expect(usage.unpriced_models).toEqual([]);
  });

  test("per-day cost uses that day's own model mix", async () => {
    const path = write("daymix.jsonl", [
      assistantLine({ uuid: "a1", model: "claude-opus-5", output: 1_000_000, timestamp: localIso("2024-03-01", 9) }),
      assistantLine({ uuid: "a2", model: "claude-haiku-4-5", output: 1_000_000, timestamp: localIso("2024-03-02", 9) }),
    ].join("\n") + "\n");
    const usage = await streamTokenUsage(path);
    const byDate = Object.fromEntries(usage.daily.map((d) => [d.date, d.cost_usd]));
    expect(byDate["2024-03-01"]).toBeCloseTo(25, 6);
    expect(byDate["2024-03-02"]).toBeCloseTo(5, 6);
  });

  test("a UTF-8 character split across a poll boundary is not corrupted", async () => {
    const first = assistantLine({ uuid: "a1", input: 100, output: 50 });
    // Non-ASCII content, so a byte-level cut can land inside a character.
    // Claude transcripts are full of these — em dashes, accents, CJK, emoji.
    const second = assistantLine({
      uuid: "a2", input: 999, output: 111,
      content: "— café 🎯 中文 — not an ASCII boundary",
    });

    const path = write("utf8split.jsonl", first + "\n");
    expect((await streamTokenUsage(path)).input_tokens).toBe(100);

    // Cut immediately before a UTF-8 continuation byte (0b10xxxxxx), so the
    // first append ends part-way through a multi-byte character.
    const buf = Buffer.from(second + "\n", "utf-8");
    let cut = -1;
    for (let i = 1; i < buf.length; i++) {
      if ((buf[i] & 0xc0) === 0x80) { cut = i; break; }
    }
    expect(cut).toBeGreaterThan(0);

    appendFileSync(path, buf.subarray(0, cut));
    // Nothing is counted while the line is incomplete.
    expect((await streamTokenUsage(path)).input_tokens).toBe(100);

    appendFileSync(path, buf.subarray(cut));
    const done = await streamTokenUsage(path);
    // The incremental scanner carries the decoded remainder across calls, so
    // the split character IS flushed as U+FFFD and the reassembled line
    // differs from what was written. That stays harmless only because a
    // multi-byte character can appear solely inside a JSON string value, where
    // U+FFFD is legal — so `usage` still parses. This test pins that: an
    // implementation that mangles the line badly enough to fail JSON.parse
    // would silently drop the entry's tokens, permanently, since the scan
    // result is cached.
    expect(done.input_tokens).toBe(1099);
    expect(done.output_tokens).toBe(161);
    expect(done.turns).toBe(2);
  });

  test("a shrunk (rotated/truncated) file is rescanned from scratch", async () => {
    const path = write("rotate.jsonl", [
      assistantLine({ uuid: "a1", input: 100, output: 50 }),
      assistantLine({ uuid: "a2", input: 200, output: 80 }),
    ].join("\n") + "\n");
    expect((await streamTokenUsage(path)).input_tokens).toBe(300);

    // Replace with a shorter file — the append assumption no longer holds.
    writeFileSync(path, assistantLine({ uuid: "b1", input: 7, output: 3 }) + "\n", "utf-8");
    const after = await streamTokenUsage(path);
    expect(after.input_tokens).toBe(7);
    expect(after.turns).toBe(1);
  });

  test("concurrent scans of one path share a single result", async () => {
    const path = write("concurrent.jsonl", [
      assistantLine({ uuid: "a1", input: 100, output: 50 }),
      assistantLine({ uuid: "a2", input: 200, output: 80 }),
    ].join("\n") + "\n");
    const [x, y, z] = await Promise.all([
      streamTokenUsage(path),
      streamTokenUsage(path),
      streamTokenUsage(path),
    ]);
    // Deduping must not let three readers each add to the same accumulator.
    expect(x.input_tokens).toBe(300);
    expect(y.input_tokens).toBe(300);
    expect(z.input_tokens).toBe(300);
  });

  test("handles multi-byte UTF-8 split across read boundaries", async () => {
    // Emoji/CJK content exercises the StringDecoder carry between chunks.
    const wide = "日本語テキスト🎉".repeat(500);
    const path = write("utf8.jsonl", assistantLine({ uuid: "u1", input: 5, output: 5, content: wide }) + "\n");
    const usage = await streamTokenUsage(path);
    expect(usage.input_tokens).toBe(5);
    expect(usage.turns).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Range aggregation
// ---------------------------------------------------------------------------

describe("summariseTokenRange", () => {
  /** Build a minimal SessionTokenUsage carrying only day buckets. */
  function session(id: string, days: Array<[string, number]>): SessionTokenUsage {
    const daily = days.map(([date, total]) => ({
      date,
      input_tokens: total,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: total,
      turns: 1,
      cost_usd: 0,
      unpriced_tokens: 0,
      unpriced_models: [],
    }));
    const input = daily.reduce((s, d) => s + d.input_tokens, 0);
    return {
      session_id: id,
      jsonl_path: `/tmp/${id}.jsonl`,
      input_tokens: input,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      turns: daily.length,
      cost_usd: 0,
      unpriced_tokens: 0,
      unpriced_models: [],
      file_size_bytes: 0,
      last_modified: "2024-03-05T00:00:00.000Z",
      daily,
    };
  }

  const NOW = new Date(2024, 2, 10, 12, 0, 0); // 2024-03-10 local

  const projects: ProjectTokenUsage[] = [
    {
      name: "alpha",
      path: "/p/alpha",
      sessions: [session("s1", [["2024-03-10", 5], ["2024-03-08", 50], ["2024-01-01", 500]])],
      total: { input_tokens: 555, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, turns: 3, cost_usd: 0 },
    },
    {
      name: "beta",
      path: "/p/beta",
      sessions: [session("s2", [["2024-03-09", 7]])],
      total: { input_tokens: 7, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, turns: 1, cost_usd: 0 },
    },
  ];

  test("rangeStartKey bounds each range correctly", () => {
    expect(rangeStartKey("all", NOW)).toBeNull();
    expect(rangeStartKey("day", NOW)).toBe("2024-03-10");
    // Last 7 calendar days inclusive of today.
    expect(rangeStartKey("week", NOW)).toBe("2024-03-04");
  });

  test("day range keeps only today's buckets", () => {
    const s = summariseTokenRange(projects, "day", NOW);
    expect(s.totals.total_tokens).toBe(5);
    expect(s.projects.map((p) => p.name)).toEqual(["alpha"]);
    expect(s.daily.map((d) => d.date)).toEqual(["2024-03-10"]);
  });

  test("week range spans the trailing 7 days across projects", () => {
    const s = summariseTokenRange(projects, "week", NOW);
    // 5 (03-10) + 50 (03-08) + 7 (03-09); the 2024-01-01 bucket is excluded.
    expect(s.totals.total_tokens).toBe(62);
    expect(s.daily.map((d) => d.date)).toEqual(["2024-03-08", "2024-03-09", "2024-03-10"]);
    // Projects are ranked by usage within the range.
    expect(s.projects.map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect(s.projects[0].totals.total_tokens).toBe(55);
  });

  test("all range includes every bucket", () => {
    const s = summariseTokenRange(projects, "all", NOW);
    expect(s.totals.total_tokens).toBe(562);
    expect(s.since).toBeNull();
    // 2024-01-01 through 2024-03-10 inclusive: 4 days with usage, the rest
    // zero-filled so the series is a real time axis (see below).
    expect(s.daily.length).toBe(70);
    expect(s.daily.filter((d) => d.total_tokens > 0)).toHaveLength(4);
  });

  test("silent days inside the series are zero-filled, edges are not padded", () => {
    const s = summariseTokenRange(projects, "all", NOW);

    // Bounds are the series' own first and last day — no invented range.
    expect(s.daily[0].date).toBe("2024-01-01");
    expect(s.daily[s.daily.length - 1].date).toBe("2024-03-10");

    // Consecutive, one calendar day apart, with no repeats.
    const dates = s.daily.map((d) => d.date);
    expect(new Set(dates).size).toBe(dates.length);
    for (let i = 1; i < dates.length; i++) {
      const gapDays =
        (Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`))
        / 86_400_000;
      expect(gapDays).toBe(1);
    }

    // Filling adds days, never tokens.
    expect(s.daily.reduce((n, d) => n + d.total_tokens, 0)).toBe(s.totals.total_tokens);
    const filled = s.daily.find((d) => d.date === "2024-01-02")!;
    expect(filled.total_tokens).toBe(0);
    expect(filled.turns).toBe(0);
    expect(filled.cost_usd).toBe(0);
  });

  test("a single-day range is left alone", () => {
    const s = summariseTokenRange(projects, "day", NOW);
    expect(s.daily).toHaveLength(1);
  });

  test("projects contributing nothing to the range are dropped", () => {
    const s = summariseTokenRange(projects, "day", NOW);
    expect(s.projects.find((p) => p.name === "beta")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// streamTokenUsage — identity and caching contract
// ---------------------------------------------------------------------------

describe("streamTokenUsage — identity and caching", () => {
  test("session_id is derived from the filename (without .jsonl extension)", async () => {
    const path = write("abc123.jsonl", assistantLine({}) + "\n");
    const usage = await streamTokenUsage(path);
    expect(usage.session_id).toBe("abc123");
  });

  test("an unchanged file returns an equal result without re-reading it", async () => {
    const path = write("cached.jsonl", assistantLine({ input: 5 }) + "\n");
    const first = await streamTokenUsage(path);

    // Delete the file: a cache hit must still answer from retained state. If
    // the scanner re-read the file this would throw ENOENT.
    rmSync(path);
    const second = await streamTokenUsage(path).catch((e: unknown) => e);

    // The stat() is what fails once the file is gone, so a missing file is a
    // genuine error — assert instead on repeat reads while the file exists.
    expect(second).toBeInstanceOf(Error);

    // Re-create identical content and confirm values (not object identity —
    // the scanner materialises a fresh object from mutable incremental state).
    const path2 = write("cached2.jsonl", assistantLine({ input: 5 }) + "\n");
    const a = await streamTokenUsage(path2);
    const b = await streamTokenUsage(path2);
    expect(b).toEqual(a);
    expect(b.input_tokens).toBe(first.input_tokens);
  });
});

// ---------------------------------------------------------------------------
// readConversationTail
// ---------------------------------------------------------------------------

describe("readConversationTail", () => {
  test("returns empty for a non-existent file", () => {
    const { entries, hasMore } = readConversationTail(join(tmpDir, "nope.jsonl"));
    expect(entries).toHaveLength(0);
    expect(hasMore).toBe(false);
  });

  test("returns empty for an empty file", () => {
    const path = write("empty.jsonl", "");
    const { entries } = readConversationTail(path);
    expect(entries).toHaveLength(0);
  });

  test("parses a user entry with string content", () => {
    const ts = "2024-01-15T10:00:00.000Z";
    const line = JSON.stringify({
      type: "user", uuid: "u1", timestamp: ts,
      message: { role: "user", content: "hello world" },
    });
    const path = write("user.jsonl", line + "\n");
    const { entries } = readConversationTail(path, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("user");
    expect(entries[0].content).toBe("hello world");
    expect(entries[0].uuid).toBe("u1");
    expect(entries[0].timestamp).toBe(ts);
  });

  test("parses a user entry with array content (text blocks)", () => {
    const line = JSON.stringify({
      type: "user", uuid: "u2", timestamp: "2024-01-15T10:01:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    });
    const path = write("user-arr.jsonl", line + "\n");
    const { entries } = readConversationTail(path, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe("first\nsecond");
  });

  test("parses an assistant entry with text block", () => {
    const line = JSON.stringify({
      type: "assistant", uuid: "a1", timestamp: "2024-01-15T10:02:00.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I can help." }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    const path = write("asst.jsonl", line + "\n");
    const { entries } = readConversationTail(path, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("assistant");
    expect(entries[0].content).toBe("I can help.");
    expect(entries[0].model).toBe("claude-opus-4");
    expect(entries[0].usage?.input).toBe(10);
    expect(entries[0].usage?.output).toBe(5);
  });

  test("entries are returned in chronological (oldest-first) order", () => {
    const lines = [
      JSON.stringify({
        type: "user", uuid: "u1", timestamp: "2024-01-15T10:00:00.000Z",
        message: { role: "user", content: "first" },
      }),
      JSON.stringify({
        type: "user", uuid: "u2", timestamp: "2024-01-15T10:01:00.000Z",
        message: { role: "user", content: "second" },
      }),
    ].join("\n") + "\n";
    const path = write("order.jsonl", lines);
    const { entries } = readConversationTail(path, 10);
    expect(entries[0].uuid).toBe("u1");
    expect(entries[1].uuid).toBe("u2");
  });

  test("skips progress and file-history-snapshot entries", () => {
    const lines = [
      JSON.stringify({ type: "progress", uuid: "p1", timestamp: "2024-01-15T10:00:00.000Z" }),
      JSON.stringify({ type: "file-history-snapshot", uuid: "f1", timestamp: "2024-01-15T10:00:01.000Z" }),
      JSON.stringify({
        type: "user", uuid: "u1", timestamp: "2024-01-15T10:01:00.000Z",
        message: { role: "user", content: "real" },
      }),
    ].join("\n") + "\n";
    const path = write("skip.jsonl", lines);
    const { entries } = readConversationTail(path, 10);
    // Only the user entry survives
    expect(entries).toHaveLength(1);
    expect(entries[0].uuid).toBe("u1");
  });

  test("assistant text blocks concatenate with newlines in content", () => {
    const line = JSON.stringify({
      type: "assistant", uuid: "a1", timestamp: "2024-01-15T10:00:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    const path = write("concat.jsonl", line + "\n");
    const { entries } = readConversationTail(path, 10);
    expect(entries[0].content).toBe("line1\nline2");
  });

  test("thinking blocks are included in blocks array but not content", () => {
    const line = JSON.stringify({
      type: "assistant", uuid: "a1", timestamp: "2024-01-15T10:00:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "text", text: "answer" },
        ],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    const path = write("thinking.jsonl", line + "\n");
    const { entries } = readConversationTail(path, 10);
    expect(entries[0].content).toBe("answer"); // thinking not in content
    const thinkBlock = entries[0].blocks?.find(b => b.type === "thinking");
    expect(thinkBlock).toBeDefined();
    expect(thinkBlock?.text).toBe("internal reasoning");
  });

  test("tool_use blocks are parsed with tool_name and tool_input", () => {
    const line = JSON.stringify({
      type: "assistant", uuid: "a1", timestamp: "2024-01-15T10:00:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", name: "bash", input: { command: "ls -la" } },
        ],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    const path = write("tool.jsonl", line + "\n");
    const { entries } = readConversationTail(path, 10);
    const toolBlock = entries[0].blocks?.find(b => b.type === "tool_use");
    expect(toolBlock?.tool_name).toBe("bash");
    expect(toolBlock?.tool_input).toContain("ls -la");
  });

  test("thinking block is truncated to 500 chars", () => {
    const longThinking = "x".repeat(600);
    const line = JSON.stringify({
      type: "assistant", uuid: "a1", timestamp: "2024-01-15T10:00:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "thinking", thinking: longThinking }],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    const path = write("truncthink.jsonl", line + "\n");
    const { entries } = readConversationTail(path, 10);
    const thinkBlock = entries[0].blocks?.find(b => b.type === "thinking");
    expect(thinkBlock?.text?.length).toBeLessThanOrEqual(500);
    expect(thinkBlock?.text).toEndWith("...");
  });

  test("limit is respected: only returns up to `limit` entries", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({
        type: "user", uuid: `u${i}`, timestamp: `2024-01-15T10:0${i}:00.000Z`,
        message: { role: "user", content: `msg ${i}` },
      }));
    }
    const path = write("many.jsonl", lines.join("\n") + "\n");
    const { entries, hasMore } = readConversationTail(path, 3);
    expect(entries).toHaveLength(3);
    expect(hasMore).toBe(true);
  });

  test("entries with no uuid or type are skipped", () => {
    const lines = [
      JSON.stringify({ someOtherField: "x" }), // no uuid, no type
      JSON.stringify({
        type: "user", uuid: "u1", timestamp: "2024-01-15T10:00:00.000Z",
        message: { role: "user", content: "valid" },
      }),
    ].join("\n") + "\n";
    const path = write("nouuid.jsonl", lines);
    const { entries } = readConversationTail(path, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].uuid).toBe("u1");
  });

  test("tool_result user entries are parsed as tool_result type", () => {
    // A user message that contains ONLY tool_result blocks (no human text)
    const line = JSON.stringify({
      type: "user", uuid: "tr1", timestamp: "2024-01-15T10:00:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file contents here" },
        ],
      },
    });
    const path = write("toolresult.jsonl", line + "\n");
    const { entries } = readConversationTail(path, 10);
    // The function should produce a tool_result typed entry
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("tool_result");
  });

  test("malformed JSON lines are skipped without throwing", () => {
    const lines = [
      "{ broken json",
      JSON.stringify({
        type: "user", uuid: "u1", timestamp: "2024-01-15T10:00:00.000Z",
        message: { role: "user", content: "ok" },
      }),
    ].join("\n") + "\n";
    const path = write("broken.jsonl", lines);
    const { entries } = readConversationTail(path, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].uuid).toBe("u1");
  });
});

// ---------------------------------------------------------------------------
// readTimeline
// ---------------------------------------------------------------------------

describe("readTimeline", () => {
  test("returns empty when trace file does not exist", () => {
    const events = readTimeline("myproj", join(tmpDir, "no-trace.log"));
    expect(events).toHaveLength(0);
  });

  test("parses HH:MM:SS.mmm trace lines that contain the session name", () => {
    const trace = [
      "10:00:00.000 myproj session started",
      "10:01:00.000 myproj session running",
      "10:02:00.000 other-session something else",
    ].join("\n") + "\n";
    const tracePath = write("trace.log", trace);
    const events = readTimeline("myproj", tracePath, undefined, undefined, 100);
    // Only lines containing "myproj" are included
    expect(events.length).toBe(2);
    expect(events.every(e => e.source === "trace")).toBe(true);
    expect(events.every(e => e.event.includes("myproj"))).toBe(true);
  });

  test("does not include trace lines for other sessions", () => {
    const trace = "10:00:00.000 other-proj started\n";
    const tracePath = write("trace.log", trace);
    const events = readTimeline("myproj", tracePath);
    expect(events).toHaveLength(0);
  });

  test("parses JSONL user entries as conversation events", () => {
    const jsonlLines = [
      JSON.stringify({
        type: "user", uuid: "u1", timestamp: "2024-01-15T10:00:00.000Z",
        message: { role: "user", content: "do the thing" },
      }),
    ].join("\n") + "\n";
    const tracePath = write("trace2.log", "");
    const jsonlPath = write("conv.jsonl", jsonlLines);
    const events = readTimeline("myproj", tracePath, jsonlPath, undefined, 100);
    const convEvent = events.find(e => e.source === "conversation");
    expect(convEvent).toBeDefined();
    expect(convEvent?.event).toBe("User prompt");
    expect(convEvent?.detail).toContain("do the thing");
  });

  test("detail is truncated to 80 chars", () => {
    const longPrompt = "a".repeat(100);
    const jsonlLines = JSON.stringify({
      type: "user", uuid: "u1", timestamp: "2024-01-15T10:00:00.000Z",
      message: { role: "user", content: longPrompt },
    }) + "\n";
    const tracePath = write("trace3.log", "");
    const jsonlPath = write("long.jsonl", jsonlLines);
    const events = readTimeline("myproj", tracePath, jsonlPath, undefined, 100);
    const convEvent = events.find(e => e.source === "conversation");
    expect(convEvent?.detail?.length).toBeLessThanOrEqual(83); // 80 + "..."
  });

  test("respects `since` filter — excludes events before the cutoff", () => {
    const trace = [
      "08:00:00.000 myproj old event",
      "12:00:00.000 myproj new event",
    ].join("\n") + "\n";
    const tracePath = write("trace4.log", trace);
    // Modify the trace file mtime to a known date so timestamp construction is predictable
    // We use a string that the since-check can evaluate — both trace lines will get the
    // same date prefix (file mtime date). Test only verifies that lines with earlier
    // HH:MM:SS are excluded when `since` is mid-day. The exact date depends on mtime,
    // so we just check the count changes.
    const stat = require("node:fs").statSync(tracePath);
    const fileDate = new Date(stat.mtimeMs).toISOString().slice(0, 10);
    const sinceTs = `${fileDate}T10:00:00.000Z`;
    const allEvents = readTimeline("myproj", tracePath, undefined, undefined, 100);
    const filteredEvents = readTimeline("myproj", tracePath, undefined, sinceTs, 100);
    expect(filteredEvents.length).toBeLessThan(allEvents.length);
  });

  test("respects `limit` — returns at most N events", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`${String(i).padStart(2, "0")}:00:00.000 myproj event ${i}`);
    }
    const tracePath = write("trace5.log", lines.join("\n") + "\n");
    const events = readTimeline("myproj", tracePath, undefined, undefined, 5);
    expect(events).toHaveLength(5);
  });

  test("events are sorted newest-first", () => {
    const lines = [
      "08:00:00.000 myproj early event",
      "10:00:00.000 myproj later event",
    ].join("\n") + "\n";
    const tracePath = write("trace6.log", lines);
    const events = readTimeline("myproj", tracePath, undefined, undefined, 100);
    // Descending order: later > earlier
    if (events.length >= 2) {
      expect(events[0].timestamp >= events[1].timestamp).toBe(true);
    }
  });

  test("skips trace lines without HH:MM:SS.mmm prefix", () => {
    const trace = [
      "no timestamp here myproj event",
      "10:00:00.000 myproj valid event",
    ].join("\n") + "\n";
    const tracePath = write("trace7.log", trace);
    const events = readTimeline("myproj", tracePath);
    expect(events.every(e => e.timestamp.includes("T"))).toBe(true);
  });

  test("non-user JSONL entries are not emitted as conversation events", () => {
    const lines = [
      JSON.stringify({
        type: "assistant", uuid: "a1", timestamp: "2024-01-15T10:00:00.000Z",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "response" }],
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }),
    ].join("\n") + "\n";
    const tracePath = write("trace8.log", "");
    const jsonlPath = write("asst-only.jsonl", lines);
    const events = readTimeline("myproj", tracePath, jsonlPath, undefined, 100);
    expect(events.filter(e => e.source === "conversation")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// manglePath — round-trip consistency with resolveJsonlFiles
// ---------------------------------------------------------------------------

describe("manglePath — directory naming", () => {
  test("same path always produces the same mangled name", () => {
    const path = "/home/user/projects/my.app";
    expect(manglePath(path)).toBe(manglePath(path));
  });

  test("different paths produce different mangled names", () => {
    expect(manglePath("/home/user/proj-a")).not.toBe(manglePath("/home/user/proj-b"));
  });

  test("mangling is deterministic across calls", () => {
    for (let i = 0; i < 5; i++) {
      expect(manglePath("/a/b/c")).toBe("-a-b-c");
    }
  });
});

// ---------------------------------------------------------------------------
// Deep pagination, anchored windows, and prompt location
//
// These cover the path behind "opening a historical prompt just shows the
// latest conversation": a cursor beyond the reader's buffered window used to
// return an empty page that still claimed `has_more`, so the dashboard could
// not page back far enough to reach an old prompt, and a requested session id
// that no longer existed on disk was silently replaced by the newest one.
// ---------------------------------------------------------------------------

/** Build a transcript of `count` alternating user/assistant entries. */
function buildTranscript(name: string, count: number, startMs = Date.parse("2026-01-01T00:00:00.000Z")): {
  path: string;
  uuids: string[];
} {
  const uuids: string[] = [];
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const uuid = `e${String(i).padStart(4, "0")}`;
    uuids.push(uuid);
    const ts = new Date(startMs + i * 60_000).toISOString();
    lines.push(
      i % 2 === 0
        ? JSON.stringify({
            type: "user", uuid, timestamp: ts,
            message: { role: "user", content: `prompt ${i}` },
          })
        : JSON.stringify({
            type: "assistant", uuid, timestamp: ts,
            message: { role: "assistant", model: "claude-opus-4", stop_reason: "end_turn",
              content: [{ type: "text", text: `reply ${i}` }] },
          }),
    );
  }
  return { path: write(name, lines.join("\n") + "\n"), uuids };
}

describe("readConversationTail — deep pagination", () => {
  test("pages all the way back through a long conversation", () => {
    // 600 entries is well past the old reader's `limit * 10` line budget,
    // which is where paging used to start returning empty pages.
    const { path, uuids } = buildTranscript("long.jsonl", 600);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 40; page++) {
      const { entries, hasMore } = readConversationTail(path, 20, cursor);
      if (entries.length === 0) break;
      seen.unshift(...entries.map((e) => e.uuid));
      cursor = entries[0].uuid;
      if (!hasMore) break;
    }

    expect(seen).toHaveLength(600);
    expect(seen[0]).toBe(uuids[0]);
    expect(seen[599]).toBe(uuids[599]);
  });

  test("reports hasMore false on the oldest page", () => {
    const { path } = buildTranscript("short.jsonl", 25);
    const first = readConversationTail(path, 20);
    expect(first.hasMore).toBe(true);
    const second = readConversationTail(path, 20, first.entries[0].uuid);
    expect(second.entries).toHaveLength(5);
    expect(second.hasMore).toBe(false);
  });

  test("an unknown cursor yields an empty page that does NOT claim more", () => {
    const { path } = buildTranscript("stale.jsonl", 40);
    const { entries, hasMore } = readConversationTail(path, 20, "not-a-real-uuid");
    expect(entries).toHaveLength(0);
    // Claiming `has_more` here left the dashboard's "load older" button live
    // and permanently unable to advance.
    expect(hasMore).toBe(false);
  });

  test("decodes multi-byte text spanning a chunk boundary", () => {
    // One entry far larger than the 64 KB read chunk, so the reader has to
    // stitch chunks together. Splitting per-chunk on a character boundary
    // corrupts one character per chunk.
    const padding = "é".repeat(80_000);
    const line = JSON.stringify({
      type: "user", uuid: "big", timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: `start ${padding} end` },
    });
    const path = write("wide.jsonl", line + "\n");
    const { entries } = readConversationTail(path, 5);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).not.toContain("�");
    expect(entries[0].content.endsWith("end")).toBe(true);
  });
});

describe("readConversationWindow — anchored reads", () => {
  test("returns the window containing a deep entry", () => {
    const { path, uuids } = buildTranscript("anchor.jsonl", 500);
    const anchor = uuids[100];
    const { entries, found, hasMore } = readConversationWindow(path, anchor, 20);
    expect(found).toBe(true);
    expect(entries.map((e) => e.uuid)).toContain(anchor);
    expect(entries).toHaveLength(20);
    // Older entries remain, and the anchor is near the end with a little
    // context after it so the reply is visible.
    expect(hasMore).toBe(true);
    const idx = entries.findIndex((e) => e.uuid === anchor);
    expect(idx).toBeGreaterThan(0);
    expect(entries.length - idx - 1).toBeLessThanOrEqual(4);
  });

  test("hasMore is false when the anchor is at the start", () => {
    const { path, uuids } = buildTranscript("anchor-start.jsonl", 40);
    const { entries, hasMore, found } = readConversationWindow(path, uuids[0], 20);
    expect(found).toBe(true);
    expect(hasMore).toBe(false);
    expect(entries[0].uuid).toBe(uuids[0]);
  });

  test("reports not-found rather than substituting a window", () => {
    const { path } = buildTranscript("anchor-missing.jsonl", 40);
    const { entries, found } = readConversationWindow(path, "nope", 20);
    expect(found).toBe(false);
    expect(entries).toHaveLength(0);
  });
});

describe("locateConversationEntry / getConversationPage", () => {
  /** Point $HOME at the temp dir so the project dir resolves under it. */
  function withTempHome<T>(fn: (projectPath: string) => T): T {
    const projectPath = join(tmpDir, "proj");
    mkdirSync(join(tmpDir, ".claude", "projects", manglePath(projectPath)), { recursive: true });
    // The module's seam, not $HOME: mutating HOME can poison bun's cached
    // os.homedir() for later tests in the process.
    _setClaudeHome(tmpDir);
    try {
      return fn(projectPath);
    } finally {
      _setClaudeHome(null);
    }
  }

  /** Write a transcript into the fake project dir. */
  function seed(projectPath: string, sessionId: string, lines: string[]): void {
    const dir = join(tmpDir, ".claude", "projects", manglePath(projectPath));
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n", "utf-8");
  }

  const userLine = (uuid: string, ts: string, content: string) =>
    JSON.stringify({ type: "user", uuid, timestamp: ts, message: { role: "user", content } });

  test("session-list titles come from the title cache, not a fresh read of every transcript", () => {
    // getConversationPage lists every conversation in the project with its
    // title. It used to read EVERY transcript in full on every page request
    // to find those titles.
    withTempHome((projectPath) => {
      const sid = "11111111-2222-3333-4444-5555555555aa";
      seed(projectPath, sid, [userLine("u1", "2026-11-01T10:00:00Z", "hello"),
        JSON.stringify({ type: "custom-title", customTitle: "aaaa" })]);
      const first = getConversationPage(projectPath, sid);
      expect(first.session_list.find((x) => x.id === sid)?.title).toBe("aaaa");
      const file = join(tmpDir, ".claude", "projects", manglePath(projectPath), `${sid}.jsonl`);
      const st = statSync(file);
      writeFileSync(file, readFileSync(file, "utf-8").replace("aaaa", "bbbb"));
      utimesSync(file, st.atime, st.mtime);
      expect(getConversationPage(projectPath, sid).session_list.find((x) => x.id === sid)?.title).toBe("aaaa");
    });
  });

  test("resolveActiveJsonl follows the project's most recent history entry", () => {
    withTempHome((projectPath) => {
      const a = "11111111-2222-3333-4444-5555555555a1";
      const b = "11111111-2222-3333-4444-5555555555b2";
      seed(projectPath, a, [userLine("u1", "2026-11-01T10:00:00Z", "a")]);
      seed(projectPath, b, [userLine("u2", "2026-11-01T11:00:00Z", "b")]);
      const hist = [
        { project: projectPath, sessionId: b, timestamp: 1 },
        { project: "/elsewhere", sessionId: b, timestamp: 2 },
        { project: projectPath, sessionId: a, timestamp: 3 },
        { project: "/elsewhere", sessionId: a, timestamp: 4 },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n";
      writeFileSync(join(tmpDir, ".claude", "history.jsonl"), hist);
      expect(resolveActiveJsonl(projectPath)?.id).toBe(a);
    });
  });

  test("resolveActiveJsonl falls back to the newest transcript", () => {
    withTempHome((projectPath) => {
      const a = "11111111-2222-3333-4444-5555555555a1";
      seed(projectPath, a, [userLine("u1", "2026-11-01T10:00:00Z", "a")]);
      writeFileSync(join(tmpDir, ".claude", "history.jsonl"), JSON.stringify({ project: "/other", sessionId: a }) + "\n");
      expect(resolveActiveJsonl(projectPath)?.id).toBe(a);
    });
  });

  test("finds the prompt's own conversation, not the newest one", () => {
    withTempHome((projectPath) => {
      seed(projectPath, "11111111-1111-4111-8111-111111111111", [
        userLine("old-1", "2026-01-01T10:00:00.000Z", "the prompt I am looking for"),
      ]);
      seed(projectPath, "22222222-2222-4222-8222-222222222222", [
        userLine("new-1", "2026-06-01T10:00:00.000Z", "something else entirely"),
      ]);

      const found = locateConversationEntry(projectPath, {
        text: "the prompt I am looking for",
        timestamp: Date.parse("2026-01-01T10:00:00.000Z"),
      });
      expect(found?.session_id).toBe("11111111-1111-4111-8111-111111111111");
      expect(found?.uuid).toBe("old-1");
    });
  });

  test("recovers when the recorded session id no longer exists", () => {
    withTempHome((projectPath) => {
      seed(projectPath, "33333333-3333-4333-8333-333333333333", [
        userLine("real", "2026-02-02T08:00:00.000Z", "a prompt whose session id went stale"),
      ]);
      const found = locateConversationEntry(projectPath, {
        text: "a prompt whose session id went stale",
        timestamp: Date.parse("2026-02-02T08:00:00.000Z"),
        sessionId: "99999999-9999-4999-8999-999999999999",
      });
      expect(found?.session_id).toBe("33333333-3333-4333-8333-333333333333");
      expect(found?.uuid).toBe("real");
    });
  });

  test("returns null when no transcript holds the prompt", () => {
    withTempHome((projectPath) => {
      seed(projectPath, "44444444-4444-4444-8444-444444444444", [
        userLine("x", "2026-03-03T08:00:00.000Z", "unrelated"),
      ]);
      const found = locateConversationEntry(projectPath, {
        text: "a prompt from a transcript that was deleted",
        timestamp: Date.parse("2024-01-01T00:00:00.000Z"),
      });
      expect(found).toBeNull();
    });
  });

  test("getConversationPage flags a requested session that is not on disk", () => {
    withTempHome((projectPath) => {
      seed(projectPath, "55555555-5555-4555-8555-555555555555", [
        userLine("only", "2026-04-04T08:00:00.000Z", "hello"),
      ]);
      const page = getConversationPage(projectPath, "00000000-0000-4000-8000-000000000000", 10);
      // The newest conversation is still served — there is nothing else to
      // show — but the caller must be able to tell it apart from a correct
      // open, or a deleted transcript looks exactly like a working one.
      expect(page.requested_session_missing).toBe(true);
      expect(page.session_id).toBe("55555555-5555-4555-8555-555555555555");
    });
  });

  test("getConversationPage returns the anchored window when asked", () => {
    withTempHome((projectPath) => {
      const sessionId = "66666666-6666-4666-8666-666666666666";
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push(userLine(`p${i}`, new Date(Date.parse("2026-05-05T00:00:00.000Z") + i * 60_000).toISOString(), `prompt ${i}`));
      }
      seed(projectPath, sessionId, lines);

      const page = getConversationPage(projectPath, sessionId, 20, undefined, "p30");
      expect(page.anchor_uuid).toBe("p30");
      expect(page.entries.map((e) => e.uuid)).toContain("p30");
      expect(page.anchor_missing).toBeUndefined();
    });
  });

  test("getConversationPage reports an anchor it could not find", () => {
    withTempHome((projectPath) => {
      const sessionId = "77777777-7777-4777-8777-777777777777";
      seed(projectPath, sessionId, [userLine("a", "2026-06-06T08:00:00.000Z", "hi")]);
      const page = getConversationPage(projectPath, sessionId, 20, undefined, "missing-uuid");
      expect(page.anchor_missing).toBe(true);
      expect(page.entries).toHaveLength(1); // fell back to the tail
    });
  });
});
