/**
 * rest-handler-tokens.test.ts — In-process tests for the token routes:
 * `GET /api/tokens` and the range-scoped `GET /api/token-usage`.
 *
 * These drive the real RestHandler over the fake OrchestratorContext with real
 * JSONL fixtures on disk, so routing, range parsing, live-session filtering and
 * the JSONL scan all run for real.
 *
 * Why /api/token-usage exists at all: the SQLite-backed aggregates
 * (getDailyTokens/getWindowTokens/computeQuotaStatus) read the `costs` table,
 * which only the agent/SDK path ever writes. On an install that does not use
 * those features the table — and therefore /api/tokens-daily and /api/quota —
 * is empty, so the dashboard's daily chart had no data to draw. The JSONL logs
 * are always present, so the range views are derived from them instead.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RestHandler } from "../rest-handler.js";
import { ToolEngine } from "../tool-engine.js";
import { manglePath, resetTokenCache } from "../claude-session.js";
import {
  makeFakeContext,
  fakeAgentEngine,
  type FakeContext,
} from "./helpers/fake-context.js";
import type { TokenRangeSummary, ProjectTokenUsage } from "../types.js";

let fc: FakeContext;
let h: RestHandler;
let originalHome: string | undefined;

/** The project path the fixture session points at. */
const PROJECT_PATH = "/work/alpha";

/**
 * Build an assistant JSONL line at a given local date/hour.
 * Timestamps are constructed from local components because day bucketing is
 * local-time — a literal "…Z" string would land on a different calendar day
 * depending on the runner's timezone.
 */
function assistantLine(opts: {
  uuid: string;
  date: string;
  hour: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreate?: number;
}): string {
  const [y, m, d] = opts.date.split("-").map(Number);
  return JSON.stringify({
    type: "assistant",
    uuid: opts.uuid,
    timestamp: new Date(y, m - 1, d, opts.hour, 0, 0).toISOString(),
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: opts.input,
        output_tokens: opts.output,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
      },
    },
  });
}

/** Local `YYYY-MM-DD` for `daysAgo` days before today. */
function dayKey(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

beforeEach(async () => {
  resetTokenCache();
  fc = await makeFakeContext({
    extraToml: `[[session]]
name = "alpha"
type = "claude"
command = "claude"
path = "${PROJECT_PATH}"
`,
  });

  // Point claude-session.ts's lazily-resolved home at the context temp dir.
  // claudeHome() reads process.env.HOME at call time precisely so this works.
  originalHome = process.env.HOME;
  process.env.HOME = fc.dir;

  const projDir = join(fc.dir, ".claude", "projects", manglePath(PROJECT_PATH));
  mkdirSync(projDir, { recursive: true });

  // Session 1: usage today and 3 days ago.
  writeFileSync(
    join(projDir, "sess-one.jsonl"),
    [
      assistantLine({ uuid: "a1", date: dayKey(0), hour: 9, input: 100, output: 10, cacheRead: 900 }),
      assistantLine({ uuid: "a2", date: dayKey(3), hour: 14, input: 200, output: 20 }),
    ].join("\n") + "\n",
    "utf-8",
  );

  // Session 2: usage 40 days ago only — inside "all", outside "week"/"day".
  writeFileSync(
    join(projDir, "sess-two.jsonl"),
    assistantLine({ uuid: "b1", date: dayKey(40), hour: 11, input: 5000, output: 500 }) + "\n",
    "utf-8",
  );

  // A live session is anything not stopped/failed.
  fc.state.transition("alpha", "running");

  h = new RestHandler(fc.ctx, fakeAgentEngine(), new ToolEngine(fc.ctx));
});

afterEach(() => {
  if (originalHome != null) process.env.HOME = originalHome;
  else delete process.env.HOME;
  resetTokenCache();
  fc.cleanup();
});

describe("GET /api/token-usage", () => {
  test("all range totals every day across both sessions", async () => {
    const res = await h.handleDashboardApi("GET", "/api/token-usage?range=all", "");
    expect(res.status).toBe(200);
    const s = res.data as TokenRangeSummary;

    expect(s.range).toBe("all");
    expect(s.since).toBeNull();
    // 100+10+900 + 200+20 + 5000+500
    expect(s.totals.total_tokens).toBe(6730);
    expect(s.totals.turns).toBe(3);
    expect(s.projects).toHaveLength(1);
    expect(s.projects[0].name).toBe("alpha");
    expect(s.projects[0].sessions).toHaveLength(2);
    // Three distinct days produced usage.
    expect(s.daily).toHaveLength(3);
    // Daily series is ascending and reconciles with the headline total.
    const dates = s.daily.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
    expect(s.daily.reduce((n, d) => n + d.total_tokens, 0)).toBe(s.totals.total_tokens);
  });

  test("week range excludes days outside the trailing 7", async () => {
    const res = await h.handleDashboardApi("GET", "/api/token-usage?range=week", "");
    const s = res.data as TokenRangeSummary;

    // today (1010) + 3 days ago (220); the 40-day-old session is excluded.
    expect(s.totals.total_tokens).toBe(1230);
    expect(s.totals.turns).toBe(2);
    expect(s.since).toBe(dayKey(6));
    expect(s.daily.map((d) => d.date)).toEqual([dayKey(3), dayKey(0)]);
    // The session that contributed nothing in range is dropped entirely.
    expect(s.projects[0].sessions.map((x) => x.session_id)).toEqual(["sess-one"]);
  });

  test("day range keeps only today", async () => {
    const res = await h.handleDashboardApi("GET", "/api/token-usage?range=day", "");
    const s = res.data as TokenRangeSummary;

    expect(s.totals.total_tokens).toBe(1010);
    expect(s.totals.turns).toBe(1);
    expect(s.since).toBe(dayKey(0));
    expect(s.daily).toHaveLength(1);
    expect(s.daily[0].date).toBe(dayKey(0));
    expect(s.daily[0].cache_read_tokens).toBe(900);
  });

  test("an unknown or missing range falls back to all-time", async () => {
    const bogus = await h.handleDashboardApi("GET", "/api/token-usage?range=decade", "");
    expect((bogus.data as TokenRangeSummary).range).toBe("all");

    const none = await h.handleDashboardApi("GET", "/api/token-usage", "");
    expect((none.data as TokenRangeSummary).range).toBe("all");
  });

  test("stopped sessions are excluded", async () => {
    fc.state.transition("alpha", "stopping");
    fc.state.transition("alpha", "stopped");
    const res = await h.handleDashboardApi("GET", "/api/token-usage?range=all", "");
    const s = res.data as TokenRangeSummary;
    expect(s.projects).toHaveLength(0);
    expect(s.totals.total_tokens).toBe(0);
  });

  test("reports the scan duration and a generation timestamp", async () => {
    const res = await h.handleDashboardApi("GET", "/api/token-usage?range=all", "");
    const s = res.data as TokenRangeSummary;
    expect(typeof s.scan_ms).toBe("number");
    expect(s.scan_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(s.generated_at))).toBe(false);
  });
});

describe("GET /api/tokens", () => {
  test("still returns per-project usage with day buckets attached", async () => {
    const res = await h.handleDashboardApi("GET", "/api/tokens", "");
    expect(res.status).toBe(200);
    const projects = res.data as ProjectTokenUsage[];

    expect(projects).toHaveLength(1);
    expect(projects[0].total.input_tokens).toBe(5300);
    const one = projects[0].sessions.find((s) => s.session_id === "sess-one");
    expect(one).toBeDefined();
    expect(one!.daily.map((d) => d.date)).toEqual([dayKey(3), dayKey(0)]);
  });

  test("repeat calls are served from the incremental cache", async () => {
    // Correctness guard for the append-only cache: a second call must not
    // double-count the same file.
    const first = (await h.handleDashboardApi("GET", "/api/tokens", "")).data as ProjectTokenUsage[];
    const second = (await h.handleDashboardApi("GET", "/api/tokens", "")).data as ProjectTokenUsage[];
    expect(second[0].total.input_tokens).toBe(first[0].total.input_tokens);
    expect(second[0].total.turns).toBe(first[0].total.turns);
  });
});
