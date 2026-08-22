/**
 * claude-session.ts — Claude Code JSONL resolution, token tracking,
 * conversation parsing, and timeline merging.
 *
 * Maps operad session names → JSONL files and extracts structured data
 * from Claude Code's conversation logs.
 */

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type {
  SessionTokenUsage, ProjectTokenUsage,
  TokenDayBucket, TokenTotals, TokenRange, TokenRangeSummary,
  TokenRangeProject, TokenRangeSession,
  ConversationEntry, ConversationBlock, ConversationPage,
  TimelineEvent, DailyCost,
} from "./types.js";

import { homedir } from "node:os";

// Resolve the Claude config locations LAZILY rather than capturing homedir()
// at module load. A module-level `const HOME = homedir()` freezes whatever
// homedir() returned the first time this file was imported — which, under a
// test that has installed a global mock.module("node:os") (skills-e2e /
// skills-crash), can be a temp dir, and then every consumer reads the wrong
// projects/history path for the rest of the process. Reading
// process.env.HOME || homedir() at call time keeps it correct regardless of
// import order or $HOME relocation (same convention as tools.ts /
// session-resolver.ts). homedir() doesn't change at runtime in production, so
// this is behaviourally identical there.
function claudeHome(): string { return process.env.HOME || homedir(); }
function claudeDir(): string { return join(claudeHome(), ".claude"); }
function projectsDir(): string { return join(claudeDir(), "projects"); }
function historyPath(): string { return join(claudeDir(), "history.jsonl"); }

// -- Pricing (per million tokens) -------------------------------------------

/**
 * Published rates in USD per million tokens, by model.
 *
 * This was a single flat `{input: 15, output: 75, ...}` applied to every model
 * — Claude 3 Opus / Opus 4-era rates. Every figure derived from it was wrong by
 * whatever ratio the actual model differed by: Opus 5 is $5/$25, so all-time
 * cost read 3x high, while Haiku 4.5 ($1/$5) read 15x high.
 *
 * Only models with a published rate appear here. A model that is missing is
 * reported as UNPRICED rather than being charged someone else's rate — see
 * {@link priceBuckets}. Guessing is what produced the bug this replaces.
 */
interface ModelRates {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

const MODEL_RATES: Readonly<Record<string, ModelRates>> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * Cache rates are multiples of a model's input rate, not separate numbers.
 *
 * The 5m/1h split matters more than it looks: on this machine 89% of all
 * cache-creation tokens were 1-hour writes, which bill at 2x input — so
 * charging every write at the 5m 1.25x rate under-counted the dominant path by
 * 60%. Claude Code records the split under `usage.cache_creation`.
 */
const CACHE_MULTIPLIER = {
  read: 0.1,
  write5m: 1.25,
  write1h: 2.0,
} as const;

/** Model id used by Claude Code for entries it generates itself (never billed). */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Strip a dated snapshot suffix so `claude-haiku-4-5-20251001` prices as
 * `claude-haiku-4-5`. Snapshots share their alias's rate.
 */
export function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/** Published rates for a model, or null when it has none. */
function ratesFor(model: string): ModelRates | null {
  return MODEL_RATES[normalizeModelId(model)] ?? null;
}

/** Token counts split the way pricing actually needs them. */
export interface RateBuckets {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute-TTL cache writes (1.25x input). */
  cacheWrite5m: number;
  /** 1-hour-TTL cache writes (2x input). */
  cacheWrite1h: number;
}

function emptyBuckets(): RateBuckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

function addBuckets(into: RateBuckets, from: RateBuckets): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite5m += from.cacheWrite5m;
  into.cacheWrite1h += from.cacheWrite1h;
}

function bucketTotal(b: RateBuckets): number {
  return b.input + b.output + b.cacheRead + b.cacheWrite5m + b.cacheWrite1h;
}

/** Cost of one model's buckets, and whether it could be priced at all. */
function costOfBuckets(model: string, b: RateBuckets): { cost: number; priced: boolean } {
  // Synthetic entries are Claude Code's own bookkeeping; they carry no usage
  // and are never billed, so they are "priced" at exactly zero rather than
  // being reported as an unpriced gap the user should worry about.
  if (normalizeModelId(model) === SYNTHETIC_MODEL) return { cost: 0, priced: true };
  const r = ratesFor(model);
  if (!r) return { cost: 0, priced: false };
  const usd =
    b.input * r.input
    + b.output * r.output
    + b.cacheRead * r.input * CACHE_MULTIPLIER.read
    + b.cacheWrite5m * r.input * CACHE_MULTIPLIER.write5m
    + b.cacheWrite1h * r.input * CACHE_MULTIPLIER.write1h;
  return { cost: usd / 1_000_000, priced: true };
}

/**
 * Price a per-model bucket map.
 *
 * Returns the tokens it could NOT price separately, so a caller can say
 * "$X, plus N tokens from models with no published rate" instead of quietly
 * reporting a total that is missing them.
 */
export function priceBuckets(byModel: Map<string, RateBuckets>): {
  cost_usd: number;
  unpriced_tokens: number;
  unpriced_models: string[];
} {
  let cost = 0;
  let unpricedTokens = 0;
  const unpriced: string[] = [];
  for (const [model, buckets] of byModel) {
    const { cost: c, priced } = costOfBuckets(model, buckets);
    if (priced) {
      cost += c;
    } else {
      unpricedTokens += bucketTotal(buckets);
      unpriced.push(normalizeModelId(model));
    }
  }
  return { cost_usd: cost, unpriced_tokens: unpricedTokens, unpriced_models: unpriced.sort() };
}

// -- Path mangling -----------------------------------------------------------

/** Mangle a project path to match Claude Code's directory naming convention */
export function manglePath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

// -- JSONL file resolution ---------------------------------------------------

interface JsonlFileInfo {
  id: string;       // UUID from filename
  path: string;     // absolute path
  mtime: number;    // modification timestamp (ms)
  size: number;     // file size in bytes
}

/**
 * Extract the custom title (nickname) from a Claude session JSONL file.
 * Scans for the LAST `type: "custom-title"` entry (most recent rename).
 * Returns null if no title found or file unreadable.
 */
function extractSessionTitle(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    // Quick bail if no custom-title anywhere in the file
    if (!content.includes("custom-title")) return null;

    let title: string | null = null;
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.includes("custom-title")) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; customTitle?: string };
        if (entry.type === "custom-title" && entry.customTitle) {
          title = entry.customTitle;
        }
      } catch { /* skip malformed lines */ }
    }
    return title;
  } catch {
    return null;
  }
}

/** List all JSONL files for a project path, sorted by mtime descending */
export function resolveJsonlFiles(projectPath: string): JsonlFileInfo[] {
  const mangled = manglePath(projectPath);
  const dir = join(projectsDir(), mangled);
  if (!existsSync(dir)) return [];

  const results: JsonlFileInfo[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const fullPath = join(dir, entry);
      try {
        const st = statSync(fullPath);
        if (!st.isFile()) continue;
        results.push({
          id: entry.replace(".jsonl", ""),
          path: fullPath,
          mtime: st.mtimeMs,
          size: st.size,
        });
      } catch { /* skip unreadable files */ }
    }
  } catch { /* dir unreadable */ }

  // Most recent first
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

/**
 * Find the active JSONL file for a project by looking up the most recent
 * sessionId in history.jsonl. Falls back to most recently modified JSONL.
 */
export function resolveActiveJsonl(projectPath: string): JsonlFileInfo | null {
  const files = resolveJsonlFiles(projectPath);
  if (files.length === 0) return null;

  // Try to find the active session from history.jsonl
  if (existsSync(historyPath())) {
    try {
      const content = readFileSync(historyPath(), "utf-8");
      const lines = content.trim().split("\n");
      // Read from end to find most recent entry for this project
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 500); i--) {
        try {
          const entry = JSON.parse(lines[i]) as { project?: string; sessionId?: string };
          if (entry.project === projectPath && entry.sessionId) {
            const match = files.find(f => f.id === entry.sessionId);
            if (match) return match;
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* history unreadable */ }
  }

  // Fallback: most recently modified
  return files[0];
}

// -- Session ↔ conversation binding ------------------------------------------

/**
 * Read the timestamp of a conversation's FIRST entry — i.e. when the
 * conversation was created. Stable (unlike mtime, which advances as the
 * conversation grows), so it's the right key for pairing a fresh `cc`
 * session to the JSONL it created. Returns epoch ms, or null when the
 * file is empty/unreadable or has no parseable timestamp in its head.
 */
export function readConversationStartTime(jsonlPath: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(jsonlPath, "r");
    // 8 KB is plenty to cover the first few entries even with a long
    // summary line; we only need the first one carrying a timestamp.
    const buf = Buffer.alloc(8192);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString("utf-8", 0, bytes);
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { timestamp?: string };
        if (entry.timestamp) {
          const ms = Date.parse(entry.timestamp);
          if (!Number.isNaN(ms)) return ms;
        }
      } catch { /* partial last line / non-JSON — try the next */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** One operad claude session that needs a conversation bound to it. */
export interface BindableSession {
  name: string;
  /** Session uptime_start as epoch ms (0 if unknown). */
  startedAtMs: number;
  /** config.session_id — a resume target binds directly to this id. */
  resumeId?: string | null;
}

/** A candidate conversation for pairing (id + creation time). */
export interface ConversationCandidate {
  id: string;
  startMs: number;
}

/**
 * PURE pairing: bind each session of ONE project to a distinct
 * conversation. Order of precedence:
 *   1. Sticky — keep a prior binding if its file still exists.
 *   2. Resume — a session with a `resumeId` binds to that conversation.
 *   3. Fresh — remaining sessions, in start order, each claim the
 *      earliest-created unclaimed conversation that began at/after the
 *      session started (minus a grace window for clock skew between
 *      `uptime_start` and the conversation's first entry).
 *
 * Separated from disk IO so the pairing logic is unit-testable. Returns
 * name → conversation id (only sessions that got a binding are present).
 */
export function pairSessionsToConversations(
  sessions: BindableSession[],
  candidates: ConversationCandidate[],
  existing: Record<string, string>,
  graceMs = 60_000,
): Record<string, string> {
  const result: Record<string, string> = {};
  const claimed = new Set<string>();
  const valid = new Map(candidates.map((c) => [c.id, c]));

  // 1. Sticky bindings that still point at a live, unclaimed conversation.
  for (const s of sessions) {
    const prev = existing[s.name];
    if (prev && valid.has(prev) && !claimed.has(prev)) {
      result[s.name] = prev;
      claimed.add(prev);
    }
  }
  // 2. Resume targets.
  for (const s of sessions) {
    if (result[s.name]) continue;
    if (s.resumeId && valid.has(s.resumeId) && !claimed.has(s.resumeId)) {
      result[s.name] = s.resumeId;
      claimed.add(s.resumeId);
    }
  }
  // 3. Fresh sessions paired by start order with unclaimed conversations.
  const unbound = sessions
    .filter((s) => !result[s.name])
    .sort((a, b) => a.startedAtMs - b.startedAtMs);
  if (unbound.length > 0) {
    const free = candidates
      .filter((c) => !claimed.has(c.id))
      .sort((a, b) => a.startMs - b.startMs);
    for (const s of unbound) {
      const idx = free.findIndex((c) => c.startMs >= s.startedAtMs - graceMs);
      if (idx >= 0) {
        const [pick] = free.splice(idx, 1);
        result[s.name] = pick.id;
        claimed.add(pick.id);
      }
    }
  }
  return result;
}

/**
 * IO wrapper around {@link pairSessionsToConversations}: resolves the
 * project's JSONL files (reading each candidate's creation time only when
 * there are unbound sessions to place) and returns the name → id map.
 */
export function bindProjectConversations(
  projectPath: string,
  sessions: BindableSession[],
  existing: Record<string, string>,
  graceMs = 60_000,
): Record<string, string> {
  const files = resolveJsonlFiles(projectPath);
  if (files.length === 0) return {};
  const candidates: ConversationCandidate[] = files.map((f) => ({
    id: f.id,
    // mtime as a cheap default; the precise first-entry time is only read
    // for genuinely-unbound candidates inside the pure pass via the map
    // below. We pre-read all here since the file set per project is small.
    startMs: readConversationStartTime(f.path) ?? f.mtime,
  }));
  return pairSessionsToConversations(sessions, candidates, existing, graceMs);
}

// -- Token usage streaming ---------------------------------------------------

/**
 * Mutable per-day accumulator. Kept separate from the immutable
 * {@link TokenDayBucket} wire type so incremental scans can keep adding to it.
 */
interface DayAccumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  turns: number;
  /** Per-model, per-cache-TTL split — the only thing cost can be derived from. */
  byModel: Map<string, RateBuckets>;
}

/**
 * Incremental scan state for one JSONL file.
 *
 * Claude Code conversation logs are strictly append-only, which lets us treat
 * a grown file as "previous state + new tail" and parse only the appended
 * bytes. That is the difference between re-reading a 48MB log on every poll
 * and reading the few KB that were actually added.
 */
interface ScanState {
  /** Bytes already consumed from the file. */
  size: number;
  /** mtime at the time `size` bytes were consumed — used for the no-op fast path. */
  mtimeMs: number;
  /** Trailing bytes after the last newline (an entry still being written). */
  partial: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  turns: number;
  /** date (YYYY-MM-DD, local) → running totals for that day. */
  days: Map<string, DayAccumulator>;
  /** Per-model, per-cache-TTL split for the whole file — the basis for cost. */
  byModel: Map<string, RateBuckets>;
  /** Last touch, for LRU eviction. */
  accessTime: number;
}

/**
 * Per-path incremental scan cache.
 *
 * Previously this was keyed by `path|mtime|size` and capped at 10 entries.
 * With a real working set of 28+ conversation files that guaranteed 100%
 * eviction thrash — every `/api/tokens` poll re-parsed the entire corpus
 * (measured: ~137MB and 1.1–1.6s per call, with five consecutive identical
 * calls all paying full price). Keying by path (so a grown file updates its
 * entry instead of adding a new one) and sizing the cap above the plausible
 * file count makes repeat polls cache hits.
 */
const scanCache = new Map<string, ScanState>();
const TOKEN_CACHE_MAX = 512;

/**
 * In-flight scans, keyed by path, so concurrent callers (multiple dashboard
 * tabs, or a poll overlapping a manual refresh) share one read instead of
 * each doing the same work.
 */
const inflightScans = new Map<string, Promise<SessionTokenUsage>>();

/** Evict least-recently-used entries if the cache exceeds its cap. */
function evictTokenCache(): void {
  while (scanCache.size > TOKEN_CACHE_MAX) {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [key, val] of scanCache) {
      if (val.accessTime < oldestTime) {
        oldestTime = val.accessTime;
        oldest = key;
      }
    }
    if (!oldest) return;
    scanCache.delete(oldest);
  }
}

/**
 * Reset a scan state to "nothing consumed". Used for a first scan and when a
 * file shrinks (truncated or replaced), where the append assumption is void.
 */
function freshScanState(): ScanState {
  return {
    size: 0,
    mtimeMs: 0,
    partial: "",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    turns: 0,
    days: new Map(),
    byModel: new Map(),
    accessTime: Date.now(),
  };
}

/** Local-time `YYYY-MM-DD` for an ISO timestamp; null when unparseable. */
function localDateKey(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const ms = d.getTime();
  if (Number.isNaN(ms)) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Fold a day accumulator into the immutable wire shape. */
function toDayBucket(date: string, a: DayAccumulator): TokenDayBucket {
  return {
    date,
    input_tokens: a.input,
    output_tokens: a.output,
    cache_read_tokens: a.cacheRead,
    cache_creation_tokens: a.cacheCreation,
    total_tokens: a.input + a.output + a.cacheRead + a.cacheCreation,
    turns: a.turns,
    // Priced from this day's own per-model split, so a day that mixed Opus and
    // Haiku is not charged at one blended rate.
    ...(() => {
      const p = priceBuckets(a.byModel);
      return {
        cost_usd: p.cost_usd,
        unpriced_tokens: p.unpriced_tokens,
        unpriced_models: p.unpriced_models,
      };
    })(),
  };
}

/** Test seam: drop all cached scan state. */
export function resetTokenCache(): void {
  scanCache.clear();
  inflightScans.clear();
}

/**
 * USD cost of one model's tokens. Returns 0 for a model with no published
 * rate — callers that need to distinguish "free" from "unpriced" should use
 * {@link priceBuckets}, which reports the unpriced tokens separately.
 */
export function calculateCost(model: string, buckets: RateBuckets): number {
  return costOfBuckets(model, buckets).cost;
}

/**
 * Stream-parse a JSONL file to extract total token usage.
 * Uses readline for memory efficiency on large files (57MB+).
 * Results are LRU-cached by file path+mtime+size.
 */
export async function streamTokenUsage(jsonlPath: string): Promise<SessionTokenUsage> {
  const existing = inflightScans.get(jsonlPath);
  if (existing) return existing;

  const scan = scanTokenUsage(jsonlPath).finally(() => {
    inflightScans.delete(jsonlPath);
  });
  inflightScans.set(jsonlPath, scan);
  return scan;
}

/**
 * Apply one JSONL line to a scan state. Only assistant entries carry usage.
 */
function applyLine(state: ScanState, line: string): void {
  // Cheap substring reject before the (comparatively costly) JSON.parse.
  if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) return;

  try {
    const entry = JSON.parse(line) as {
      type?: string;
      timestamp?: string;
      message?: {
        role?: string;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
          /**
           * Present on current logs; splits cache writes by TTL. The two bill
           * at different multiples of the input rate (1.25x vs 2x), so this is
           * load-bearing for cost, not just detail.
           */
          cache_creation?: {
            ephemeral_5m_input_tokens?: number;
            ephemeral_1h_input_tokens?: number;
          };
        };
        stop_reason?: string | null;
      };
    };

    if (entry.type !== "assistant") return;

    const usage = entry.message?.usage;
    // A final assistant turn is one that carries a stop_reason.
    const isTurn = Boolean(entry.message?.stop_reason);
    if (!usage && !isTurn) return;

    const input = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    const cacheRead = usage?.cache_read_input_tokens ?? 0;
    const cacheCreation = usage?.cache_creation_input_tokens ?? 0;

    // Prefer the TTL breakdown; `cache_creation_input_tokens` is its sum, so
    // using both would double-count. Older logs predate the 1h TTL and carry
    // only the scalar — those are 5-minute writes by definition.
    const split = usage?.cache_creation;
    const write5m = split ? (split.ephemeral_5m_input_tokens ?? 0) : cacheCreation;
    const write1h = split ? (split.ephemeral_1h_input_tokens ?? 0) : 0;

    // An entry with usage but no model cannot be priced against any rate. Bucket
    // it under a sentinel so its tokens surface as unpriced rather than being
    // silently attributed to whichever model happened to come last.
    const model = entry.message?.model ?? "unknown";
    const perEntry: RateBuckets = {
      input, output, cacheRead, cacheWrite5m: write5m, cacheWrite1h: write1h,
    };
    let modelBuckets = state.byModel.get(model);
    if (!modelBuckets) {
      modelBuckets = emptyBuckets();
      state.byModel.set(model, modelBuckets);
    }
    addBuckets(modelBuckets, perEntry);

    state.input += input;
    state.output += output;
    state.cacheRead += cacheRead;
    state.cacheCreation += cacheCreation;
    if (isTurn) state.turns++;

    // Attribute the same numbers to the entry's calendar day so range views
    // (today / this week / all time) come from this one pass.
    const dateKey = localDateKey(entry.timestamp);
    if (!dateKey) return;
    let bucket = state.days.get(dateKey);
    if (!bucket) {
      bucket = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, turns: 0, byModel: new Map() };
      state.days.set(dateKey, bucket);
    }
    let dayModel = bucket.byModel.get(model);
    if (!dayModel) {
      dayModel = emptyBuckets();
      bucket.byModel.set(model, dayModel);
    }
    addBuckets(dayModel, perEntry);
    bucket.input += input;
    bucket.output += output;
    bucket.cacheRead += cacheRead;
    bucket.cacheCreation += cacheCreation;
    if (isTurn) bucket.turns++;
  } catch { /* skip malformed lines */ }
}

/**
 * Bring the cached scan state for `jsonlPath` up to date and materialise it.
 *
 * Three paths:
 *  - unchanged (same size+mtime) → pure cache hit, no I/O beyond the stat;
 *  - grown → read only `[cachedSize, currentSize)` and keep accumulating;
 *  - shrunk → the append-only assumption is broken, so rescan from zero.
 */
async function scanTokenUsage(jsonlPath: string): Promise<SessionTokenUsage> {
  const st = statSync(jsonlPath);
  let state = scanCache.get(jsonlPath);

  if (state && st.size < state.size) {
    // Truncated, rotated, or replaced — previous accumulation is invalid.
    state = undefined;
  }
  if (!state) {
    state = freshScanState();
    scanCache.set(jsonlPath, state);
  }
  state.accessTime = Date.now();

  const upToDate = state.size === st.size && state.mtimeMs === st.mtimeMs;
  if (!upToDate && st.size > state.size) {
    // Read only the appended tail. `end` is inclusive in createReadStream.
    const start = state.size;
    const end = st.size - 1;
    const stream = createReadStream(jsonlPath, {
      start,
      end,
      // Larger chunks mean fewer syscalls on a cold scan; the `for await`
      // loop still returns to the event loop between chunks, so a 48MB
      // first read stays interleaved with other daemon work.
      highWaterMark: 256 * 1024,
    });
    const decoder = new StringDecoder("utf8");

    // The decoded remainder is carried across calls rather than re-read.
    //
    // That deserves a note, because it is only safe for a reason that is not
    // obvious. A poll can land mid-write, so the tail can end inside a
    // multi-byte UTF-8 sequence; `decoder.end()` then flushes it as U+FFFD and
    // the continuation bytes decode to another U+FFFD on the next read, so the
    // reassembled line really does differ from what was written. It stays
    // harmless because JSON's own syntax is ASCII — a multi-byte character can
    // only ever appear inside a string VALUE, and U+FFFD is legal there. So
    // `JSON.parse` still succeeds and `usage` is read correctly; only a couple
    // of characters of text nothing here reads are mangled. Verified against a
    // deliberately split sequence.
    //
    // If this scan ever starts extracting message TEXT, that stops being
    // acceptable: switch to advancing `size` to the last complete line and
    // re-reading the fragment, which is exact.
    let carry = state.partial;
    try {
      for await (const chunk of stream) {
        carry += decoder.write(chunk as Buffer);
        // Process every complete line in the buffer, keeping the remainder.
        let nl = carry.indexOf("\n");
        while (nl !== -1) {
          const line = carry.slice(0, nl);
          carry = carry.slice(nl + 1);
          if (line.length > 0) applyLine(state, line);
          nl = carry.indexOf("\n");
        }
      }
      carry += decoder.end();
    } catch {
      // A read failure leaves the state consistent with what was consumed so
      // far; drop the cache entry so the next call retries from scratch.
      scanCache.delete(jsonlPath);
      throw new Error(`Failed reading ${jsonlPath}`);
    }

    // Whatever follows the last newline is an entry still being written.
    state.partial = carry;
    state.size = st.size;
    state.mtimeMs = st.mtimeMs;
  } else if (!upToDate) {
    // Same size but a different mtime (rewritten in place at equal length):
    // record the new mtime so the fast path engages next time.
    state.mtimeMs = st.mtimeMs;
  }

  evictTokenCache();

  const daily = [...state.days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, acc]) => toDayBucket(date, acc));

  const priced = priceBuckets(state.byModel);

  return {
    session_id: basename(jsonlPath, ".jsonl"),
    jsonl_path: jsonlPath,
    input_tokens: state.input,
    output_tokens: state.output,
    cache_read_tokens: state.cacheRead,
    cache_creation_tokens: state.cacheCreation,
    turns: state.turns,
    cost_usd: priced.cost_usd,
    unpriced_tokens: priced.unpriced_tokens,
    unpriced_models: priced.unpriced_models,
    file_size_bytes: st.size,
    last_modified: new Date(st.mtimeMs).toISOString(),
    daily,
  };
}

/**
 * Get aggregated token usage for all JSONL files of a project.
 */
export async function getProjectTokenUsage(
  name: string,
  projectPath: string,
): Promise<ProjectTokenUsage> {
  const files = resolveJsonlFiles(projectPath);
  const sessions: SessionTokenUsage[] = [];

  for (const file of files) {
    try {
      const usage = await streamTokenUsage(file.path);
      // Skip sessions with zero usage
      if (usage.turns > 0 || usage.output_tokens > 0) {
        sessions.push(usage);
      }
    } catch { /* skip unreadable files */ }
  }

  const total = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    turns: 0,
    cost_usd: 0,
    unpriced_tokens: 0,
    unpriced_models: [] as string[],
  };
  for (const s of sessions) {
    total.input_tokens += s.input_tokens;
    total.output_tokens += s.output_tokens;
    total.cache_read_tokens += s.cache_read_tokens;
    total.cache_creation_tokens += s.cache_creation_tokens;
    total.turns += s.turns;
    total.cost_usd += s.cost_usd;
    total.unpriced_tokens += s.unpriced_tokens;
    for (const m of s.unpriced_models) {
      if (!total.unpriced_models.includes(m)) total.unpriced_models.push(m);
    }
  }
  total.unpriced_models.sort();

  return { name, path: projectPath, sessions, total };
}

// -- Range aggregation --------------------------------------------------------

/** A zeroed {@link TokenTotals}. */
function emptyTotals(): TokenTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 0,
    turns: 0,
    cost_usd: 0,
    unpriced_tokens: 0,
    unpriced_models: [],
  };
}

/** Accumulate `src` into `dst` in place. */
function addTotals(dst: TokenTotals, src: TokenTotals): void {
  dst.input_tokens += src.input_tokens;
  dst.output_tokens += src.output_tokens;
  dst.cache_read_tokens += src.cache_read_tokens;
  dst.cache_creation_tokens += src.cache_creation_tokens;
  dst.total_tokens += src.total_tokens;
  dst.turns += src.turns;
  dst.cost_usd += src.cost_usd;
}

/**
 * Inclusive lower bound for a range, as a local `YYYY-MM-DD` key.
 *
 * - `day`  → today only
 * - `week` → the last 7 calendar days (today inclusive), matching how the
 *            dashboard's other rolling stats read
 * - `all`  → no bound
 */
export function rangeStartKey(range: TokenRange, now = new Date()): string | null {
  if (range === "all") return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "week") start.setDate(start.getDate() - 6);
  const y = start.getFullYear();
  const m = String(start.getMonth() + 1).padStart(2, "0");
  const d = String(start.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Build the range-scoped summary the dashboard's Tokens panel renders.
 *
 * `projects` are the already-scanned per-project usages, so this is pure
 * in-memory folding — switching ranges in the UI costs no extra file I/O
 * beyond the (now incremental) rescan of whatever changed.
 */
export function summariseTokenRange(
  projects: ProjectTokenUsage[],
  range: TokenRange,
  now = new Date(),
): Omit<TokenRangeSummary, "generated_at" | "scan_ms"> {
  const since = rangeStartKey(range, now);
  const totals = emptyTotals();
  const dailyMap = new Map<string, TokenDayBucket>();
  const outProjects: TokenRangeProject[] = [];

  for (const project of projects) {
    const projectTotals = emptyTotals();
    const outSessions: TokenRangeSession[] = [];

    for (const session of project.sessions) {
      const sessionTotals = emptyTotals();

      for (const bucket of session.daily) {
        if (since && bucket.date < since) continue;
        addTotals(sessionTotals, bucket);

        // Fold into the cross-project daily series.
        let day = dailyMap.get(bucket.date);
        if (!day) {
          day = { ...emptyTotals(), date: bucket.date };
          dailyMap.set(bucket.date, day);
        }
        addTotals(day, bucket);
      }

      // Drop sessions that contributed nothing to this range.
      if (sessionTotals.total_tokens === 0 && sessionTotals.turns === 0) continue;
      outSessions.push({
        session_id: session.session_id,
        project: project.name,
        path: session.jsonl_path,
        totals: sessionTotals,
        last_modified: session.last_modified,
      });
      addTotals(projectTotals, sessionTotals);
    }

    if (projectTotals.total_tokens === 0 && projectTotals.turns === 0) continue;
    outSessions.sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
    outProjects.push({
      name: project.name,
      path: project.path,
      totals: projectTotals,
      sessions: outSessions,
    });
    addTotals(totals, projectTotals);
  }

  outProjects.sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
  const daily = [...dailyMap.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );

  return { range, since, totals, projects: outProjects, daily };
}

// -- Conversation tail reader -------------------------------------------------

/** Truncate a string to max length, appending ... if truncated */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

/** Extract text content from a user message */
function extractUserContent(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return (message.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  }
  return "";
}

/** Parse assistant message content blocks into structured ConversationBlocks */
function parseAssistantBlocks(content: unknown[]): { blocks: ConversationBlock[]; text: string } {
  const blocks: ConversationBlock[] = [];
  const textParts: string[] = [];

  for (const block of content as Array<{
    type?: string;
    text?: string;
    thinking?: string;
    name?: string;
    input?: unknown;
    content?: unknown;
  }>) {
    switch (block.type) {
      case "text":
        blocks.push({ type: "text", text: block.text ?? "" });
        textParts.push(block.text ?? "");
        break;
      case "thinking":
        blocks.push({ type: "thinking", text: truncate(block.thinking ?? "", 500) });
        break;
      case "tool_use":
        blocks.push({
          type: "tool_use",
          tool_name: block.name ?? "unknown",
          tool_input: truncate(
            typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
            200,
          ),
        });
        break;
      case "tool_result":
        blocks.push({
          type: "tool_result",
          tool_result: truncate(
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? ""),
            1000,
          ),
        });
        break;
      // Skip other types (signatures, etc.)
    }
  }

  return { blocks, text: textParts.join("\n") };
}

/**
 * Read conversation entries from the tail of a JSONL file.
 * Reads backwards in 64KB chunks for efficiency on large files.
 * Coalesces streaming assistant entries (stop_reason: null → keep only final).
 */
export function readConversationTail(
  jsonlPath: string,
  limit = 20,
  beforeUuid?: string,
): { entries: ConversationEntry[]; hasMore: boolean } {
  if (!existsSync(jsonlPath)) return { entries: [], hasMore: false };

  const st = statSync(jsonlPath);
  if (st.size === 0) return { entries: [], hasMore: false };

  // Read file in reverse 64KB chunks to find entries near the tail
  const CHUNK_SIZE = 65536;
  const fd = openSync(jsonlPath, "r");
  const entries: ConversationEntry[] = [];
  let reachedBeforeUuid = !beforeUuid; // If no cursor, start from end
  let hasMore = false;

  try {
    let offset = st.size;
    let remainder = "";
    const linesToParse: string[] = [];

    // Collect enough lines by reading backwards
    while (offset > 0 && linesToParse.length < limit * 10) {
      const readSize = Math.min(CHUNK_SIZE, offset);
      offset -= readSize;
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, offset);
      const chunk = buf.toString("utf-8") + remainder;
      const lines = chunk.split("\n");

      // First element may be partial (unless we're at file start)
      remainder = offset > 0 ? (lines.shift() ?? "") : "";

      // Add lines in reverse order (most recent first)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line) linesToParse.push(line);
      }

      if (linesToParse.length >= limit * 10) break;
    }

    // If there's still a remainder from the very beginning of the file
    if (remainder.trim()) {
      linesToParse.push(remainder.trim());
    }

    // Parse lines (already in reverse chronological order) and collect entries
    // We need to coalesce streaming assistant messages and track UUIDs
    const rawEntries: Array<{
      uuid: string;
      type: string;
      timestamp: string;
      entry: ConversationEntry;
    }> = [];

    for (const line of linesToParse) {
      // Quick prefix filter — skip non-conversation entries
      if (line.includes('"type":"file-history-snapshot"') || line.includes('"type": "file-history-snapshot"')) continue;
      if (line.includes('"type":"progress"') || line.includes('"type": "progress"')) continue;

      try {
        const raw = JSON.parse(line) as {
          type?: string;
          uuid?: string;
          timestamp?: string;
          message?: {
            role?: string;
            content?: unknown;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            model?: string;
            stop_reason?: string | null;
          };
        };

        if (!raw.uuid || !raw.type) continue;

        if (raw.type === "user" && raw.message) {
          const content = extractUserContent(raw.message);

          // Check if this is a tool_result continuation (no human text, just tool responses)
          if (!content && Array.isArray(raw.message.content)) {
            const toolResults = (raw.message.content as Array<{ type?: string; content?: unknown; tool_use_id?: string }>)
              .filter(b => b.type === "tool_result");
            if (toolResults.length > 0) {
              // Parse as tool_result entries
              const { blocks } = parseAssistantBlocks(raw.message.content as unknown[]);
              rawEntries.push({
                uuid: raw.uuid,
                type: "tool_result",
                timestamp: raw.timestamp ?? "",
                entry: {
                  uuid: raw.uuid,
                  type: "tool_result",
                  timestamp: raw.timestamp ?? "",
                  content: "",
                  blocks,
                },
              });
              continue;
            }
          }
          // Skip truly empty entries with no meaningful content
          if (!content) continue;
          rawEntries.push({
            uuid: raw.uuid,
            type: "user",
            timestamp: raw.timestamp ?? "",
            entry: {
              uuid: raw.uuid,
              type: "user",
              timestamp: raw.timestamp ?? "",
              content,
            },
          });
        } else if (raw.type === "assistant" && raw.message) {
          const contentArr = Array.isArray(raw.message.content) ? raw.message.content : [];
          const { blocks, text } = parseAssistantBlocks(contentArr);
          const usage = raw.message.usage;

          rawEntries.push({
            uuid: raw.uuid,
            type: "assistant",
            timestamp: raw.timestamp ?? "",
            entry: {
              uuid: raw.uuid,
              type: "assistant",
              timestamp: raw.timestamp ?? "",
              content: text,
              blocks,
              usage: usage ? {
                input: usage.input_tokens ?? 0,
                output: usage.output_tokens ?? 0,
                cache_read: usage.cache_read_input_tokens ?? 0,
                cache_create: usage.cache_creation_input_tokens ?? 0,
              } : undefined,
              model: raw.message.model,
            },
          });
        }
      } catch { /* skip malformed lines */ }
    }

    // Claude Code writes one JSONL line per API call — no streaming partials.
    // rawEntries are in reverse chronological order (newest first).
    // Apply beforeUuid cursor and limit.
    for (const raw of rawEntries) {
      if (!reachedBeforeUuid) {
        if (raw.uuid === beforeUuid) {
          reachedBeforeUuid = true;
        }
        continue;
      }

      entries.push(raw.entry);
      if (entries.length >= limit) {
        hasMore = true;
        break;
      }
    }

    // Check if there are more entries beyond what we collected
    if (!hasMore && entries.length < rawEntries.length - (beforeUuid ? 1 : 0)) {
      hasMore = true;
    }
  } finally {
    closeSync(fd);
  }

  // Reverse to chronological order (oldest first)
  entries.reverse();
  return { entries, hasMore };
}

/**
 * Get a paginated conversation page for a session.
 */
export function getConversationPage(
  projectPath: string,
  sessionId?: string,
  limit = 20,
  beforeUuid?: string,
): ConversationPage {
  const files = resolveJsonlFiles(projectPath);
  const sessionList = files.map(f => {
    const title = extractSessionTitle(f.path) ?? undefined;
    return {
      id: f.id,
      last_modified: new Date(f.mtime).toISOString(),
      title,
    };
  });

  // Resolve JSONL file
  let jsonlFile: JsonlFileInfo | null = null;
  if (sessionId) {
    jsonlFile = files.find(f => f.id === sessionId) ?? null;
  }
  if (!jsonlFile) {
    jsonlFile = resolveActiveJsonl(projectPath);
  }

  if (!jsonlFile) {
    return {
      entries: [],
      oldest_uuid: null,
      has_more: false,
      session_id: "",
      session_list: sessionList,
    };
  }

  const { entries, hasMore } = readConversationTail(jsonlFile.path, limit, beforeUuid);

  return {
    entries,
    oldest_uuid: entries.length > 0 ? entries[0].uuid : null,
    has_more: hasMore,
    session_id: jsonlFile.id,
    session_list: sessionList,
  };
}

// -- Timeline reader ----------------------------------------------------------

/**
 * Read and merge timeline events from trace.log and JSONL user entries.
 * Filters trace.log lines by session name, parses timestamps.
 */
export function readTimeline(
  sessionName: string,
  tracePath: string,
  jsonlPath?: string,
  since?: string,
  limit = 100,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const sinceDate = since ? new Date(since) : null;

  // 1. Parse trace.log for session-related events
  if (existsSync(tracePath)) {
    try {
      const content = readFileSync(tracePath, "utf-8");
      const lines = content.split("\n");
      // Get file modification date for constructing full timestamps
      const traceStat = statSync(tracePath);
      const fileDate = new Date(traceStat.mtimeMs).toISOString().slice(0, 10);

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes(sessionName)) continue;

        // Parse HH:MM:SS.mmm prefix
        const timeMatch = line.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s+(.+)/);
        if (!timeMatch) continue;

        const timestamp = `${fileDate}T${timeMatch[1]}Z`;
        if (sinceDate && new Date(timestamp) < sinceDate) continue;

        events.push({
          timestamp,
          source: "trace",
          event: timeMatch[2].trim(),
        });

        if (events.length >= limit * 2) break; // Collect extra for merge
      }
    } catch { /* trace unreadable */ }
  }

  // 2. Parse JSONL user entries for conversation events
  if (jsonlPath && existsSync(jsonlPath)) {
    try {
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n");

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        // Quick prefix check
        if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;

        try {
          const entry = JSON.parse(line) as {
            type?: string;
            timestamp?: string;
            message?: { content?: unknown };
          };
          if (entry.type !== "user" || !entry.timestamp) continue;

          if (sinceDate && new Date(entry.timestamp) < sinceDate) continue;

          const content = extractUserContent(entry.message ?? {});
          events.push({
            timestamp: entry.timestamp,
            source: "conversation",
            event: "User prompt",
            detail: truncate(content, 80),
          });

          if (events.length >= limit * 3) break;
        } catch { /* skip malformed */ }
      }
    } catch { /* jsonl unreadable */ }
  }

  // Sort by timestamp descending and limit
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return events.slice(0, limit);
}

// -- Conversation delta (live streaming) --------------------------------------

/**
 * Get new conversation entries after a given UUID.
 * Reads the tail of the active JSONL file and returns entries newer than afterUuid.
 * Returns null if no active JSONL file or no new entries.
 */
export function getConversationDelta(
  projectPath: string,
  afterUuid: string | null,
  limit = 10,
): { entries: ConversationEntry[]; session_id: string } | null {
  const active = resolveActiveJsonl(projectPath);
  if (!active) return null;

  // Read last 50 entries (enough to catch new ones since last check)
  const { entries } = readConversationTail(active.path, 50);
  if (entries.length === 0) return null;

  if (!afterUuid) {
    // First call — return the last `limit` entries
    return {
      entries: entries.slice(-limit),
      session_id: active.id,
    };
  }

  // Find afterUuid and return everything after it
  const idx = entries.findIndex(e => e.uuid === afterUuid);
  if (idx < 0) {
    // UUID not found in recent entries — return last few as catchup
    return {
      entries: entries.slice(-limit),
      session_id: active.id,
    };
  }

  const newEntries = entries.slice(idx + 1);
  if (newEntries.length === 0) return null;

  return {
    entries: newEntries.slice(-limit),
    session_id: active.id,
  };
}

// -- Daily cost timeline ------------------------------------------------------

/**
 * Compute daily cost aggregation across all Claude sessions for the last N days.
 * Stream-parses JSONL files, bucketing assistant entries by UTC date.
 */
export async function getDailyCostTimeline(
  projects: Array<{ name: string; path: string }>,
  days = 14,
): Promise<DailyCost[]> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const dailyMap = new Map<string, DailyCost>();

  for (const project of projects) {
    const files = resolveJsonlFiles(project.path);

    for (const file of files) {
      // Skip files not modified within the window
      if (file.mtime < cutoff) continue;

      // Stream-parse the JSONL file
      const content = readFileSync(file.path, "utf-8");
      const lines = content.split("\n");

      for (const line of lines) {
        if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) continue;

        try {
          const raw = JSON.parse(line) as {
            type?: string;
            timestamp?: string;
            message?: {
              model?: string;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_creation?: {
                  ephemeral_5m_input_tokens?: number;
                  ephemeral_1h_input_tokens?: number;
                };
              };
              stop_reason?: string | null;
            };
          };

          if (raw.type !== "assistant" || !raw.timestamp) continue;

          const ts = new Date(raw.timestamp);
          if (ts.getTime() < cutoff) continue;

          const dateKey = ts.toISOString().slice(0, 10); // YYYY-MM-DD
          const usage = raw.message?.usage;
          if (!usage) continue;

          // Priced against this entry's own model, like the main scanner.
          // An unpriced model contributes 0 rather than being charged an
          // unrelated model's rate.
          const model = raw.message?.model ?? "unknown";
          const cc = usage.cache_creation;
          const inputCost = calculateCost(model, {
            ...emptyBuckets(), input: usage.input_tokens ?? 0,
          });
          const outputCost = calculateCost(model, {
            ...emptyBuckets(), output: usage.output_tokens ?? 0,
          });
          const cacheCost = calculateCost(model, {
            ...emptyBuckets(),
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite5m: cc ? (cc.ephemeral_5m_input_tokens ?? 0) : (usage.cache_creation_input_tokens ?? 0),
            cacheWrite1h: cc ? (cc.ephemeral_1h_input_tokens ?? 0) : 0,
          });

          let day = dailyMap.get(dateKey);
          if (!day) {
            day = {
              date: dateKey,
              input_cost: 0,
              output_cost: 0,
              cache_cost: 0,
              total_cost: 0,
              turns: 0,
              sessions: [],
            };
            dailyMap.set(dateKey, day);
          }

          day.input_cost += inputCost;
          day.output_cost += outputCost;
          day.cache_cost += cacheCost;
          day.total_cost += inputCost + outputCost + cacheCost;

          if (raw.message?.stop_reason) {
            day.turns++;
          }

          // Track per-session costs within the day
          let sessionEntry = day.sessions.find(s => s.session_id === file.id);
          if (!sessionEntry) {
            sessionEntry = { session_id: file.id, name: project.name, cost: 0 };
            day.sessions.push(sessionEntry);
          }
          sessionEntry.cost += inputCost + outputCost + cacheCost;
        } catch {
          // Skip malformed lines
        }
      }
    }
  }

  // Sort by date ascending
  return [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
}
