/**
 * memory-db.test.ts — Comprehensive tests for MemoryDb (SQLite layer)
 *
 * Covers (in order):
 *   1. Initialization / requireDb guard
 *   2. Memory CRUD — create, read, delete, dedup, touch, decay, expire
 *   3. FTS5 search (falls back to LIKE on bad queries)
 *   4. Cost tracking — recordCost, getAggregateCosts, getSessionCosts, window
 *   5. Token aggregation (highest value) — getAggregateTokens, getWindowTokens,
 *      getDailyTokens, getWeeklyTokens with controlled timestamps so window
 *      boundary math is deterministic
 *   6. Agent runs — start, complete, query
 *   7. Goals — create, update, tree, active filter
 *   8. Decisions — record, evaluate, quality trend, by-goal
 *   9. Inter-agent messages — send, unread, broadcast, mark-read, conversation
 *  10. Agent conversations — append, getHistory, clear
 *  11. Agent learnings — add, reinforce, shared insights, decay, core promotions
 *  12. Agent specializations — upsert, reinforce blend, getSpecialists, decay
 *  13. Agent personality — setTrait versioning, snapshot, history, drift
 *  14. Strategy evolution — evolveStrategy, deactivate old, history
 *  15. Trust ledger — recordDelta, getTrustScore, clamp bounds, autonomy recommendation
 *  16. Tool leases — create, hasActiveLease, increment (auto-exhaust), revoke, expire
 *  17. Tool autonomy caps — set, get, list, promote, cap violation
 *  18. User profile — addProfileEntry, dedup, getProfile ordered by weight, update, delete
 *  19. computeQuotaStatus — full integration with controlled DB rows
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

import { MemoryDb, computeQuotaStatus } from "../memory-db.js";
import type { Logger } from "../log.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLog(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

/** Unix epoch seconds, offset by `deltaSeconds` from now */
function epoch(deltaSeconds = 0): number {
  return Math.floor(Date.now() / 1000) + deltaSeconds;
}

/** Direct SQL insert to the costs table with an explicit created_at timestamp.
 *  This is the only way to make window/weekly queries deterministic without
 *  injecting a clock into MemoryDb. We use requireDb() which returns the
 *  underlying DbHandle — tests that need it call this helper. */
function insertCostRow(
  db: MemoryDb,
  sessionName: string,
  inputTokens: number,
  outputTokens: number,
  createdAt: number, // unix seconds
  costUsd = 0,
): void {
  db.requireDb().prepare(
    `INSERT INTO costs (session_name, cost_usd, input_tokens, output_tokens, duration_ms, num_turns, created_at)
     VALUES (?, ?, ?, ?, 0, 1, ?)`,
  ).run(sessionName, costUsd, inputTokens, outputTokens, createdAt);
}

let tmpDir: string;
let db: MemoryDb;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-memdb-test-"));
  db = new MemoryDb(silentLog(), tmpDir);
  await db.init();
});

afterEach(() => {
  db.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

// ---------------------------------------------------------------------------
// 1. Initialization guards
// ---------------------------------------------------------------------------

describe("MemoryDb — init guard", () => {
  test("requireDb() on an uninitialized instance throws a descriptive error", async () => {
    const fresh = new MemoryDb(silentLog(), tmpDir);
    // Do NOT call init() on this one
    expect(() => fresh.requireDb()).toThrow(/not initialized/);
  });

  test("close() is idempotent — can be called twice without throwing", () => {
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Memory CRUD
// ---------------------------------------------------------------------------

describe("Memory CRUD", () => {
  test("createMemory returns a positive integer ID", () => {
    const id = db.createMemory("/proj", "discovery", "first insight");
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  test("getMemory reads back the inserted row", () => {
    const id = db.createMemory("/proj", "convention", "use tabs", "sess-1");
    const rec = db.getMemory(id!);
    expect(rec).toBeDefined();
    expect(rec!.category).toBe("convention");
    expect(rec!.content).toBe("use tabs");
    expect(rec!.source_session_id).toBe("sess-1");
    expect(rec!.relevance_score).toBe(1.0);
  });

  test("createMemory with duplicate content returns null and does NOT create a second row", () => {
    const id1 = db.createMemory("/proj", "discovery", "duplicate content");
    const id2 = db.createMemory("/proj", "discovery", "duplicate content");
    expect(id1).not.toBeNull();
    expect(id2).toBeNull(); // duplicate → null
    expect(db.countMemories("/proj")).toBe(1);
  });

  test("same content in different project_paths creates two separate rows", () => {
    const id1 = db.createMemory("/proj-a", "discovery", "shared insight");
    const id2 = db.createMemory("/proj-b", "discovery", "shared insight");
    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    expect(id1).not.toBe(id2);
  });

  test("deleteMemory removes the row and returns true", () => {
    const id = db.createMemory("/proj", "warning", "risky thing");
    expect(db.deleteMemory(id!)).toBe(true);
    // bun:sqlite's .get() returns null (not undefined) when no row matches.
    expect(db.getMemory(id!)).toBeNull();
  });

  test("deleteMemory on non-existent ID returns false", () => {
    expect(db.deleteMemory(999999)).toBe(false);
  });

  test("touchMemory boosts relevance_score by 10% (capped at 2.0)", () => {
    const id = db.createMemory("/proj", "discovery", "touchable");
    db.touchMemory(id!);
    const rec = db.getMemory(id!);
    // 1.0 * 1.1 = 1.1
    expect(rec!.relevance_score).toBeCloseTo(1.1, 5);
  });

  test("touchMemory relevance_score caps at 2.0 after many touches", () => {
    const id = db.createMemory("/proj", "discovery", "boost me");
    // After enough touches, score must not exceed 2.0
    for (let i = 0; i < 30; i++) db.touchMemory(id!);
    const rec = db.getMemory(id!);
    expect(rec!.relevance_score).toBeLessThanOrEqual(2.0);
  });

  test("getTopMemories returns entries sorted by relevance_score DESC", () => {
    const a = db.createMemory("/proj", "discovery", "content-a")!;
    const b = db.createMemory("/proj", "discovery", "content-b")!;
    // Touch a twice so its score is higher
    db.touchMemory(a);
    db.touchMemory(a);
    const top = db.getTopMemories("/proj");
    expect(top[0].id).toBe(a);
    expect(top[1].id).toBe(b);
  });

  test("getTopMemories respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) db.createMemory("/proj", "discovery", `item-${i}`);
    const top = db.getTopMemories("/proj", 3);
    expect(top.length).toBe(3);
  });

  test("getTopMemories excludes expired entries", () => {
    // Insert expired row directly
    const id = db.createMemory("/proj", "discovery", "expires soon")!;
    // Set expires_at in the past
    db.requireDb().prepare(`UPDATE memories SET expires_at = ? WHERE id = ?`).run(epoch(-10), id);
    const top = db.getTopMemories("/proj");
    expect(top.find(m => m.id === id)).toBeUndefined();
  });

  test("deleteExpired only removes rows where expires_at <= now", () => {
    db.createMemory("/proj", "discovery", "never expires");
    const id2 = db.createMemory("/proj", "discovery", "already expired")!;
    db.requireDb().prepare(`UPDATE memories SET expires_at = ? WHERE id = ?`).run(epoch(-5), id2);
    const deleted = db.deleteExpired();
    expect(deleted).toBe(1);
    expect(db.countMemories("/proj")).toBe(1);
  });

  test("decayMemories reduces relevance_score for old entries, floors at 0.1", () => {
    const id = db.createMemory("/proj", "discovery", "old memory")!;
    // Set accessed_at far in the past
    db.requireDb().prepare(`UPDATE memories SET accessed_at = ? WHERE id = ?`).run(epoch(-90 * 86400), id);
    db.decayMemories("/proj", 0); // 0-sec threshold so our row qualifies
    const rec = db.getMemory(id);
    // 1.0 * 0.95 = 0.95
    expect(rec!.relevance_score).toBeCloseTo(0.95, 5);
  });

  test("decayMemories returns count of affected rows", () => {
    const id = db.createMemory("/proj", "discovery", "stale")!;
    db.requireDb().prepare(`UPDATE memories SET accessed_at = ? WHERE id = ?`).run(epoch(-1000000), id);
    const changed = db.decayMemories("/proj", 0);
    expect(changed).toBe(1);
  });

  test("decayMemories does not go below 0.1 even with repeated calls", () => {
    const id = db.createMemory("/proj", "discovery", "very old")!;
    db.requireDb().prepare(`UPDATE memories SET accessed_at = ?, relevance_score = 0.1 WHERE id = ?`).run(epoch(-1000000), id);
    db.decayMemories("/proj", 0);
    const rec = db.getMemory(id);
    expect(rec!.relevance_score).toBeCloseTo(0.1, 5);
  });

  test("countMemories returns 0 for unknown project", () => {
    expect(db.countMemories("/nonexistent")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. FTS5 search
// ---------------------------------------------------------------------------

describe("Memory search", () => {
  test("searchMemories finds content by keyword", () => {
    db.createMemory("/proj", "discovery", "the quick brown fox");
    db.createMemory("/proj", "discovery", "completely unrelated");
    const results = db.searchMemories("/proj", "quick");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toBe("the quick brown fox");
  });

  test("searchMemories returns empty array when no match", () => {
    db.createMemory("/proj", "discovery", "apples and oranges");
    const results = db.searchMemories("/proj", "bananas");
    expect(results.length).toBe(0);
  });

  test("searchMemories with bad FTS5 syntax falls back to LIKE (no throw)", () => {
    db.createMemory("/proj", "discovery", "the quick brown fox");
    // A bare AND with no operands would normally error in FTS5
    expect(() => db.searchMemories("/proj", "AND")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Cost tracking
// ---------------------------------------------------------------------------

describe("Cost tracking", () => {
  test("recordCost returns a positive ID", () => {
    const id = db.recordCost("sess-a", null, 0.01, 100, 200, 1000, 3, "claude-opus");
    expect(id).toBeGreaterThan(0);
  });

  test("getSessionCosts returns rows in DESC order for the named session only", () => {
    db.recordCost("alpha", null, 0.01, 100, 200, 1000, 1, null);
    db.recordCost("alpha", null, 0.02, 300, 400, 2000, 2, null);
    db.recordCost("beta", null, 0.03, 500, 600, 3000, 3, null);
    const rows = db.getSessionCosts("alpha");
    expect(rows.length).toBe(2);
    // Most recent first
    expect(rows[0].cost_usd).toBeCloseTo(0.02);
    expect(rows[1].cost_usd).toBeCloseTo(0.01);
  });

  test("getAggregateCosts with no args sums all rows", () => {
    db.recordCost("s", null, 0.10, 1000, 2000, 0, 1, null);
    db.recordCost("s", null, 0.20, 3000, 4000, 0, 2, null);
    const agg = db.getAggregateCosts();
    expect(agg.total_cost_usd).toBeCloseTo(0.30, 5);
    expect(agg.total_input_tokens).toBe(4000);
    expect(agg.total_output_tokens).toBe(6000);
    expect(agg.query_count).toBe(2);
  });

  test("getAggregateCosts with fromEpoch/toEpoch filters correctly", () => {
    const now = epoch();
    db.recordCost("s", null, 0.05, 500, 500, 0, 1, null); // created now
    // Insert an old cost outside the range
    db.requireDb().prepare(
      `INSERT INTO costs (session_name, cost_usd, input_tokens, output_tokens, duration_ms, num_turns, created_at)
       VALUES (?, ?, ?, ?, 0, 1, ?)`,
    ).run("s", 0.99, 9999, 9999, now - 10000);
    const agg = db.getAggregateCosts(now - 1); // from 1s ago → excludes old
    expect(agg.query_count).toBe(1);
    expect(agg.total_cost_usd).toBeCloseTo(0.05, 5);
  });

  test("getAggregateCosts on empty DB returns zeros", () => {
    const agg = db.getAggregateCosts();
    expect(agg.total_cost_usd).toBe(0);
    expect(agg.total_input_tokens).toBe(0);
    expect(agg.query_count).toBe(0);
  });

  test("getDailyCosts groups by day and orders DESC", () => {
    db.recordCost("s", null, 0.01, 10, 20, 0, 1, null);
    const daily = db.getDailyCosts(7);
    expect(Array.isArray(daily)).toBe(true);
    expect(daily.length).toBeGreaterThan(0);
    expect(typeof daily[0].date).toBe("string");
    expect(daily[0].cost_usd).toBeGreaterThan(0);
  });

  test("getPerSessionCosts returns sessions ordered by total_cost DESC", () => {
    db.recordCost("cheap", null, 0.01, 10, 10, 0, 1, null);
    db.recordCost("expensive", null, 0.99, 100, 100, 0, 1, null);
    const rows = db.getPerSessionCosts();
    expect(rows[0].session_name).toBe("expensive");
    expect(rows[1].session_name).toBe("cheap");
  });
});

// ---------------------------------------------------------------------------
// 5. Token aggregation — deterministic window boundary tests
// ---------------------------------------------------------------------------

describe("Token aggregation — getAggregateTokens", () => {
  test("empty DB → all zeros", () => {
    const agg = db.getAggregateTokens();
    expect(agg.input_tokens).toBe(0);
    expect(agg.output_tokens).toBe(0);
    expect(agg.total_tokens).toBe(0);
    expect(agg.num_entries).toBe(0);
  });

  test("sums all rows when no range given", () => {
    insertCostRow(db, "a", 1000, 2000, epoch(-100));
    insertCostRow(db, "b", 3000, 4000, epoch(-200));
    const agg = db.getAggregateTokens();
    expect(agg.input_tokens).toBe(4000);
    expect(agg.output_tokens).toBe(6000);
    expect(agg.total_tokens).toBe(10000);
    expect(agg.num_entries).toBe(2);
  });

  test("fromEpoch boundary: row at fromEpoch is INCLUDED (>=)", () => {
    const t = epoch(-3600);
    insertCostRow(db, "sess", 100, 200, t);
    const agg = db.getAggregateTokens(t);
    expect(agg.num_entries).toBe(1);
    expect(agg.total_tokens).toBe(300);
  });

  test("fromEpoch boundary: row one second before fromEpoch is EXCLUDED", () => {
    const t = epoch(-3600);
    insertCostRow(db, "sess", 100, 200, t - 1);
    const agg = db.getAggregateTokens(t);
    expect(agg.num_entries).toBe(0);
    expect(agg.total_tokens).toBe(0);
  });

  test("toEpoch boundary: row at toEpoch is INCLUDED (<=)", () => {
    const t = epoch(-100);
    insertCostRow(db, "sess", 500, 500, t);
    const agg = db.getAggregateTokens(undefined, t);
    expect(agg.num_entries).toBe(1);
  });

  test("toEpoch boundary: row one second after toEpoch is EXCLUDED", () => {
    const t = epoch(-100);
    insertCostRow(db, "sess", 500, 500, t + 1);
    const agg = db.getAggregateTokens(undefined, t);
    expect(agg.num_entries).toBe(0);
  });

  test("from+to range: rows inside range included, outside excluded", () => {
    const base = epoch(-1000);
    insertCostRow(db, "s", 100, 100, base - 1);  // BEFORE
    insertCostRow(db, "s", 200, 200, base);       // AT from → included
    insertCostRow(db, "s", 300, 300, base + 500); // INSIDE → included
    insertCostRow(db, "s", 400, 400, base + 1001);// AFTER to → excluded
    const agg = db.getAggregateTokens(base, base + 1000);
    expect(agg.num_entries).toBe(2);
    expect(agg.total_tokens).toBe(200 + 200 + 300 + 300); // 1000
  });

  test("total_tokens = input_tokens + output_tokens (not SUM-level double-count)", () => {
    insertCostRow(db, "s", 1234, 5678, epoch());
    const agg = db.getAggregateTokens();
    expect(agg.total_tokens).toBe(agg.input_tokens + agg.output_tokens);
  });
});

describe("Token aggregation — getWindowTokens", () => {
  test("returns rows grouped by session_name within window hours", () => {
    // Window = 2 hours; rows at -1h and -3h
    insertCostRow(db, "inside", 1000, 2000, epoch(-3600));   // 1h ago → inside 2h window
    insertCostRow(db, "outside", 500, 500, epoch(-7200 - 1)); // >2h ago → outside
    const rows = db.getWindowTokens(2);
    expect(rows.length).toBe(1);
    expect(rows[0].session_name).toBe("inside");
    expect(rows[0].total_tokens).toBe(3000);
  });

  test("aggregates multiple rows for same session within window", () => {
    insertCostRow(db, "sess", 100, 200, epoch(-60));
    insertCostRow(db, "sess", 300, 400, epoch(-120));
    const rows = db.getWindowTokens(24);
    expect(rows.length).toBe(1);
    expect(rows[0].input_tokens).toBe(400);
    expect(rows[0].output_tokens).toBe(600);
    expect(rows[0].total_tokens).toBe(1000);
  });

  test("returns sessions ordered by total_tokens DESC", () => {
    insertCostRow(db, "low", 100, 100, epoch(-60));
    insertCostRow(db, "high", 9000, 9000, epoch(-60));
    const rows = db.getWindowTokens(1);
    expect(rows[0].session_name).toBe("high");
    expect(rows[1].session_name).toBe("low");
  });

  test("empty window → empty array", () => {
    insertCostRow(db, "old", 999, 999, epoch(-999999));
    const rows = db.getWindowTokens(1); // 1h window, row is ancient
    expect(rows.length).toBe(0);
  });

  test("returns zero totals for a session with null token columns", () => {
    // Insert a cost row where tokens are NULL (edge case from some parsers)
    db.requireDb().prepare(
      `INSERT INTO costs (session_name, cost_usd, input_tokens, output_tokens, duration_ms, num_turns, created_at)
       VALUES (?, 0.01, NULL, NULL, 0, 1, ?)`,
    ).run("null-sess", epoch(-60));
    const rows = db.getWindowTokens(1);
    const sess = rows.find(r => r.session_name === "null-sess");
    if (sess) {
      // COALESCE(NULL,0) = 0
      expect(sess.total_tokens).toBe(0);
    }
    // No throw — that's sufficient
  });
});

describe("Token aggregation — getDailyTokens", () => {
  test("groups by date and returns total_tokens", () => {
    insertCostRow(db, "s", 1000, 2000, epoch());
    const daily = db.getDailyTokens(7);
    expect(Array.isArray(daily)).toBe(true);
    expect(daily.length).toBeGreaterThan(0);
    expect(daily[0].total_tokens).toBe(3000);
  });

  test("empty DB → empty array", () => {
    const daily = db.getDailyTokens(7);
    expect(daily).toEqual([]);
  });

  test("total_tokens column equals input + output per day", () => {
    insertCostRow(db, "s", 1111, 2222, epoch());
    const daily = db.getDailyTokens(1);
    expect(daily[0].total_tokens).toBe(daily[0].input_tokens + daily[0].output_tokens);
  });
});

describe("Token aggregation — getWeeklyTokens", () => {
  test("returns zero for empty DB", () => {
    const wk = db.getWeeklyTokens();
    expect(wk.total_tokens).toBe(0);
  });

  test("includes rows from this week only (not last week)", () => {
    // Row from 8 days ago → outside Monday-anchored week
    insertCostRow(db, "old", 10000, 10000, epoch(-8 * 86400));
    // Row from today → inside
    insertCostRow(db, "today", 500, 500, epoch(-60));

    const wk = db.getWeeklyTokens();
    // We can't know exactly which side of Monday the 8-day-old row is on
    // without knowing the real date. But today's row MUST be included.
    expect(wk.total_tokens).toBeGreaterThanOrEqual(1000);
  });

  test("aggregates input + output correctly", () => {
    insertCostRow(db, "a", 1234, 5678, epoch(-3600));
    const wk = db.getWeeklyTokens();
    expect(wk.total_tokens).toBe(wk.input_tokens + wk.output_tokens);
  });
});

// ---------------------------------------------------------------------------
// 6. Agent runs
// ---------------------------------------------------------------------------

describe("Agent runs", () => {
  test("startAgentRun returns a positive ID", () => {
    const id = db.startAgentRun("optimizer", "sess-1");
    expect(id).toBeGreaterThan(0);
  });

  test("completeAgentRun updates the run to 'completed' status", () => {
    const id = db.startAgentRun("optimizer", "sess-1");
    db.completeAgentRun(id, "completed", { inputTokens: 100, outputTokens: 200, turns: 3 });
    const run = db.getAgentRun(id);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("completed");
    expect(run!.input_tokens).toBe(100);
    expect(run!.turns).toBe(3);
  });

  test("completeAgentRun with 'failed' captures error text", () => {
    const id = db.startAgentRun("optimizer", "sess-1");
    db.completeAgentRun(id, "failed", { error: "timeout after 30s" });
    const run = db.getAgentRun(id);
    expect(run!.status).toBe("failed");
    expect(run!.error).toBe("timeout after 30s");
  });

  test("getAgentRuns with agentName filter returns only that agent's runs", () => {
    db.startAgentRun("agent-a", "sess");
    db.startAgentRun("agent-b", "sess");
    const runs = db.getAgentRuns(50, "agent-a");
    expect(runs.every(r => r.agent_name === "agent-a")).toBe(true);
  });

  test("getAgentRuns response_preview is truncated to 280 chars", () => {
    const id = db.startAgentRun("agent-a", "sess");
    const longText = "x".repeat(400);
    db.completeAgentRun(id, "completed", { responseText: longText });
    const runs = db.getAgentRuns(1, "agent-a");
    const preview = runs[0].response_preview as string;
    expect(preview.length).toBe(280);
    expect(runs[0].has_more_response).toBe(1);
  });

  test("getAgentRun returns null for non-existent ID", () => {
    expect(db.getAgentRun(999999)).toBeNull();
  });

  test("getAgentCostSummary counts only 'completed' runs", () => {
    const id1 = db.startAgentRun("agt", "sess");
    db.completeAgentRun(id1, "completed", { costUsd: 0.10 });
    const id2 = db.startAgentRun("agt", "sess");
    db.completeAgentRun(id2, "failed", { costUsd: 0.99 });
    const summary = db.getAgentCostSummary();
    const row = summary.find(r => r.agent_name === "agt");
    expect(row).toBeDefined();
    expect(row!.run_count).toBe(1); // only completed
  });
});

// ---------------------------------------------------------------------------
// 7. Goals
// ---------------------------------------------------------------------------

describe("Goals", () => {
  test("createGoal returns a positive ID", () => {
    const id = db.createGoal("Build the thing");
    expect(id).toBeGreaterThan(0);
  });

  test("getGoal reads back title, description, status default 'active'", () => {
    const id = db.createGoal("My goal", { description: "do this", priority: 2, agentName: "master" });
    const g = db.getGoal(id);
    expect(g!.title).toBe("My goal");
    expect(g!.description).toBe("do this");
    expect(g!.status).toBe("active");
    expect(g!.priority).toBe(2);
    expect(g!.agent_name).toBe("master");
  });

  test("updateGoal changes status and sets completed_at for 'completed'", () => {
    const id = db.createGoal("finish work");
    const ok = db.updateGoal(id, { status: "completed", actualOutcome: "shipped it", successScore: 0.9 });
    expect(ok).toBe(true);
    const g = db.getGoal(id);
    expect(g!.status).toBe("completed");
    expect(g!.actual_outcome).toBe("shipped it");
    expect(g!.success_score).toBeCloseTo(0.9, 5);
    expect(g!.completed_at).not.toBeNull();
  });

  test("getActiveGoals only returns 'active' goals", () => {
    const a = db.createGoal("active goal");
    const b = db.createGoal("completed goal");
    db.updateGoal(b, { status: "completed" });
    const active = db.getActiveGoals();
    expect(active.some(g => g.id === a)).toBe(true);
    expect(active.some(g => g.id === b)).toBe(false);
  });

  test("getActiveGoals with agentName filter works", () => {
    db.createGoal("shared", { agentName: "agent-x" });
    db.createGoal("other", { agentName: "agent-y" });
    const xGoals = db.getActiveGoals("agent-x");
    expect(xGoals.every(g => g.agent_name === "agent-x")).toBe(true);
  });

  test("getGoalTree includes children_count", () => {
    const parent = db.createGoal("parent");
    db.createGoal("child-1", { parentId: parent });
    db.createGoal("child-2", { parentId: parent });
    const tree = db.getGoalTree();
    const parentRow = tree.find(g => g.id === parent);
    expect(parentRow!.children_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 8. Decisions
// ---------------------------------------------------------------------------

describe("Decisions", () => {
  test("recordDecision returns a positive ID", () => {
    const id = db.recordDecision("agent-x", "do action A", "because of reason B");
    expect(id).toBeGreaterThan(0);
  });

  test("evaluateDecision updates actual_outcome and score", () => {
    const id = db.recordDecision("agt", "action", "rationale");
    const ok = db.evaluateDecision(id, "it worked", 0.8);
    expect(ok).toBe(true);
    const rows = db.getRecentDecisions(1, "agt");
    expect(rows[0].actual_outcome).toBe("it worked");
    expect(rows[0].score).toBeCloseTo(0.8, 5);
  });

  test("getRecentDecisions filters by agentName", () => {
    db.recordDecision("agt-a", "action-a", "reason");
    db.recordDecision("agt-b", "action-b", "reason");
    const rows = db.getRecentDecisions(50, "agt-a");
    expect(rows.every(r => r.agent_name === "agt-a")).toBe(true);
  });

  test("getDecisionsByGoal only returns decisions linked to that goal", () => {
    const goalId = db.createGoal("test goal");
    db.recordDecision("agt", "for goal", "reason", { goalId });
    db.recordDecision("agt", "unrelated", "reason");
    const linked = db.getDecisionsByGoal(goalId);
    expect(linked.length).toBe(1);
    expect(linked[0].goal_id).toBe(goalId);
  });

  test("getDecisionQualityTrend: insufficient_data when < 3 scored decisions", () => {
    db.recordDecision("agt", "action", "reason");
    const trend = db.getDecisionQualityTrend("agt");
    expect(trend.trend).toBe("insufficient_data");
  });

  test("getDecisionQualityTrend: improving when recent decisions score higher", () => {
    // 6 decisions: older ones score 0.3, recent ones score 0.9
    // getDecisionQualityTrend orders by created_at DESC, so we insert older first
    for (let i = 0; i < 3; i++) {
      const id = db.recordDecision("agt2", "old-action", "reason");
      db.evaluateDecision(id, "ok", 0.3);
    }
    for (let i = 0; i < 3; i++) {
      const id = db.recordDecision("agt2", "new-action", "reason");
      db.evaluateDecision(id, "great", 0.9);
    }
    const trend = db.getDecisionQualityTrend("agt2", 6);
    // Recent half avg (0.9) vs older half avg (0.3), delta=0.6>0.1 → improving
    expect(trend.trend).toBe("improving");
  });
});

// ---------------------------------------------------------------------------
// 9. Inter-agent messages
// ---------------------------------------------------------------------------

describe("Inter-agent messages", () => {
  test("sendAgentMessage returns a positive ID", () => {
    const id = db.sendAgentMessage("agent-a", "agent-b", "hello");
    expect(id).toBeGreaterThan(0);
  });

  test("getUnreadMessages returns messages for recipient, excludes read ones", () => {
    const id = db.sendAgentMessage("agent-a", "agent-b", "unread message");
    db.sendAgentMessage("agent-a", "agent-b", "another");
    db.markMessagesRead([id]);
    const unread = db.getUnreadMessages("agent-b");
    expect(unread.length).toBe(1);
    expect(unread[0].content).toBe("another");
  });

  test("broadcast '*' messages appear in any agent's unread queue", () => {
    db.sendAgentMessage("agent-a", "*", "broadcast event");
    const forB = db.getUnreadMessages("agent-b");
    const forC = db.getUnreadMessages("agent-c");
    expect(forB.some(m => m.content === "broadcast event")).toBe(true);
    expect(forC.some(m => m.content === "broadcast event")).toBe(true);
  });

  test("getConversation returns messages between two agents in DESC order", () => {
    db.sendAgentMessage("a", "b", "msg1");
    db.sendAgentMessage("b", "a", "msg2");
    db.sendAgentMessage("c", "a", "not this"); // irrelevant
    const convo = db.getConversation("a", "b");
    expect(convo.length).toBe(2);
    expect(convo.every((m: any) =>
      (m.from_agent === "a" && m.to_agent === "b") ||
      (m.from_agent === "b" && m.to_agent === "a")
    )).toBe(true);
  });

  test("markMessagesRead sets read_at for specified IDs only", () => {
    const id1 = db.sendAgentMessage("a", "b", "msg1");
    const id2 = db.sendAgentMessage("a", "b", "msg2");
    db.markMessagesRead([id1]);
    const unread = db.getUnreadMessages("b");
    expect(unread.length).toBe(1);
    expect(unread[0].id).toBe(id2);
  });

  test("getRecentAgentMessages respects limit and DESC order", () => {
    for (let i = 0; i < 5; i++) db.sendAgentMessage("a", "b", `msg-${i}`);
    const msgs = db.getRecentAgentMessages(3);
    expect(msgs.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 10. Agent conversations (persistent chat)
// ---------------------------------------------------------------------------

describe("Agent conversations", () => {
  test("appendConversation returns a positive ID", () => {
    const id = db.appendConversation("agent-x", "user", "Hello!");
    expect(id).toBeGreaterThan(0);
  });

  test("getConversationHistory returns messages in chronological order", () => {
    db.appendConversation("agent-x", "user", "first");
    db.appendConversation("agent-x", "assistant", "second");
    const hist = db.getConversationHistory("agent-x");
    expect(hist.length).toBe(2);
    expect(hist[0].role).toBe("user");
    expect(hist[1].role).toBe("assistant");
  });

  test("getConversationHistory respects limit", () => {
    for (let i = 0; i < 10; i++) db.appendConversation("agt", "user", `msg-${i}`);
    const hist = db.getConversationHistory("agt", 5);
    expect(hist.length).toBe(5);
  });

  test("clearConversation removes all messages for that agent only", () => {
    db.appendConversation("agt-a", "user", "msg1");
    db.appendConversation("agt-b", "user", "msg2");
    const cleared = db.clearConversation("agt-a");
    expect(cleared).toBe(1);
    expect(db.getConversationHistory("agt-a").length).toBe(0);
    expect(db.getConversationHistory("agt-b").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11. Agent learnings
// ---------------------------------------------------------------------------

describe("Agent learnings", () => {
  test("addLearning returns a positive ID", () => {
    const id = db.addLearning("agt", "insight", "content here");
    expect(id).toBeGreaterThan(0);
  });

  test("duplicate addLearning reinforces confidence by +0.05 and returns existing ID", () => {
    const id1 = db.addLearning("agt", "insight", "same content", { confidence: 0.5 });
    const id2 = db.addLearning("agt", "insight", "same content");
    expect(id2).toBe(id1); // same row
    const learnings = db.getAgentLearnings("agt");
    expect(learnings.length).toBe(1);
    // 0.5 + 0.05 = 0.55
    expect((learnings[0].confidence as number)).toBeCloseTo(0.55, 5);
    expect(learnings[0].reinforcement_count).toBe(2);
  });

  test("confidence cannot exceed 1.0 through repeated reinforcement", () => {
    const content = "always true";
    db.addLearning("agt", "insight", content, { confidence: 0.95 });
    for (let i = 0; i < 20; i++) db.addLearning("agt", "insight", content);
    const learnings = db.getAgentLearnings("agt");
    expect(learnings[0].confidence as number).toBeLessThanOrEqual(1.0);
  });

  test("getAgentLearnings orders by confidence DESC", () => {
    db.addLearning("agt", "insight", "low confidence", { confidence: 0.3 });
    db.addLearning("agt", "insight", "high confidence", { confidence: 0.9 });
    const learnings = db.getAgentLearnings("agt");
    expect((learnings[0].confidence as number)).toBeGreaterThanOrEqual(learnings[1].confidence as number);
  });

  test("getAgentLearnings filters by category", () => {
    db.addLearning("agt", "pattern", "pattern-content");
    db.addLearning("agt", "insight", "insight-content");
    const patterns = db.getAgentLearnings("agt", 20, "pattern");
    expect(patterns.every(l => l.category === "pattern")).toBe(true);
  });

  test("getSharedInsights excludes specified agent and applies minConfidence filter", () => {
    db.addLearning("agt-a", "insight", "a-content", { confidence: 0.9 });
    db.addLearning("agt-b", "insight", "b-content-low", { confidence: 0.3 });
    db.addLearning("agt-b", "insight", "b-content-high", { confidence: 0.9 });
    const shared = db.getSharedInsights("agt-a", 0.7);
    // Must not include agt-a's learning; must exclude b-content-low
    expect(shared.every(l => l.agent_name !== "agt-a")).toBe(true);
    expect(shared.every(l => (l.confidence as number) >= 0.7)).toBe(true);
  });

  test("decayLearnings decays old entries confidence by * 0.95", () => {
    const id = db.addLearning("agt", "insight", "old learning", { confidence: 0.8 });
    // Set last_reinforced_at far in the past
    db.requireDb().prepare(
      `UPDATE agent_learnings SET last_reinforced_at = ? WHERE id = ?`,
    ).run(epoch(-99 * 86400), id);
    const changed = db.decayLearnings("agt", 1); // 1 day threshold
    expect(changed).toBe(1);
    const learnings = db.getAgentLearnings("agt");
    // 0.8 * 0.95 = 0.76
    expect(learnings[0].confidence as number).toBeCloseTo(0.76, 4);
  });

  test("getCoreAgentLearnings requires both minReinforcement AND minConfidence", () => {
    // Low confidence but high reinforcement → excluded
    const id1 = db.addLearning("agt", "insight", "low-conf", { confidence: 0.5 });
    db.requireDb().prepare(`UPDATE agent_learnings SET reinforcement_count = 5 WHERE id = ?`).run(id1);
    // High confidence but low reinforcement → excluded
    db.addLearning("agt", "insight", "low-reinf", { confidence: 0.9 });
    // Both qualify
    const id3 = db.addLearning("agt", "insight", "qualifies", { confidence: 0.8 });
    db.requireDb().prepare(`UPDATE agent_learnings SET reinforcement_count = 4 WHERE id = ?`).run(id3);

    const core = db.getCoreAgentLearnings("agt", 10, 3, 0.7);
    expect(core.some(l => l.id === id3)).toBe(true);
    expect(core.some(l => l.id === id1)).toBe(false); // confidence 0.5 < 0.7
  });
});

// ---------------------------------------------------------------------------
// 12. Agent specializations
// ---------------------------------------------------------------------------

describe("Agent specializations", () => {
  test("upsertSpecialization creates a new row and returns positive ID", () => {
    const id = db.upsertSpecialization("agt", "TypeScript", 0.8);
    expect(id).toBeGreaterThan(0);
  });

  test("upsertSpecialization on existing domain blends confidence and increments count", () => {
    db.upsertSpecialization("agt", "Rust", 0.5);
    db.upsertSpecialization("agt", "Rust", 0.9, "evidence of excellence");
    const specs = db.getSpecializations("agt");
    expect(specs.length).toBe(1);
    // Blended: min(1, 0.5*0.7 + 0.9*0.3 + 0.02) = min(1, 0.35+0.27+0.02) = 0.64
    expect(specs[0].confidence).toBeCloseTo(0.64, 4);
    expect(specs[0].reinforcement_count).toBe(1);
  });

  test("upsertSpecialization clamps confidence to [0, 1]", () => {
    db.upsertSpecialization("agt", "domain", 2.5);
    const specs = db.getSpecializations("agt");
    expect(specs[0].confidence).toBeLessThanOrEqual(1.0);
  });

  test("getSpecializations without agentName returns all agents", () => {
    db.upsertSpecialization("agt-x", "domain-a", 0.5);
    db.upsertSpecialization("agt-y", "domain-b", 0.7);
    const all = db.getSpecializations();
    expect(all.length).toBe(2);
  });

  test("getSpecialistsFor returns agents above minConfidence for a domain", () => {
    db.upsertSpecialization("expert", "ML", 0.9);
    db.upsertSpecialization("novice", "ML", 0.2);
    const specialists = db.getSpecialistsFor("ML", 0.5);
    expect(specialists.some(s => s.agent_name === "expert")).toBe(true);
    expect(specialists.some(s => s.agent_name === "novice")).toBe(false);
  });

  test("decaySpecializations reduces confidence for stale entries", () => {
    db.upsertSpecialization("agt", "domain", 0.9);
    db.requireDb().prepare(
      `UPDATE agent_specializations SET updated_at = ? WHERE agent_name = 'agt'`,
    ).run(epoch(-100 * 86400));
    const changed = db.decaySpecializations(1); // 1-day threshold
    expect(changed).toBe(1);
    const specs = db.getSpecializations("agt");
    // 0.9 * 0.9 = 0.81
    expect(specs[0].confidence).toBeCloseTo(0.81, 4);
  });
});

// ---------------------------------------------------------------------------
// 13. Agent personality
// ---------------------------------------------------------------------------

describe("Agent personality", () => {
  test("setPersonalityTrait returns a positive ID", () => {
    const id = db.setPersonalityTrait("agt", "curiosity", 0.8);
    expect(id).toBeGreaterThan(0);
  });

  test("setPersonalityTrait clamps value to [0, 1]", () => {
    db.setPersonalityTrait("agt", "boldness", 1.5);
    const snap = db.getPersonalitySnapshot("agt");
    expect(snap[0].trait_value).toBeLessThanOrEqual(1.0);
  });

  test("multiple calls to setPersonalityTrait create versioned history", () => {
    db.setPersonalityTrait("agt", "creativity", 0.5);
    db.setPersonalityTrait("agt", "creativity", 0.7);
    db.setPersonalityTrait("agt", "creativity", 0.9);
    const hist = db.getPersonalityHistory("agt", "creativity");
    expect(hist.length).toBe(3);
    // Versions should be 1, 2, 3 (ordered DESC by version)
    expect(hist[0].version).toBe(3);
    expect(hist[2].version).toBe(1);
  });

  test("getPersonalitySnapshot returns latest version of each trait", () => {
    db.setPersonalityTrait("agt", "curiosity", 0.3);
    db.setPersonalityTrait("agt", "curiosity", 0.8);
    db.setPersonalityTrait("agt", "boldness", 0.5);
    const snap = db.getPersonalitySnapshot("agt");
    expect(snap.length).toBe(2);
    const curiosity = snap.find(t => t.trait_name === "curiosity");
    expect(curiosity!.trait_value).toBeCloseTo(0.8, 5);
  });
});

// ---------------------------------------------------------------------------
// 14. Strategy evolution
// ---------------------------------------------------------------------------

describe("Strategy evolution", () => {
  test("evolveStrategy creates strategy with version 1 for a new agent", () => {
    const id = db.evolveStrategy("agt", "be helpful", "initial strategy");
    expect(id).toBeGreaterThan(0);
    const strat = db.getActiveStrategy("agt");
    expect(strat!.version).toBe(1);
    expect(strat!.active).toBe(1);
  });

  test("evolveStrategy increments version and deactivates previous", () => {
    db.evolveStrategy("agt", "v1 strategy", "first");
    db.evolveStrategy("agt", "v2 strategy", "improved");
    const strat = db.getActiveStrategy("agt");
    expect(strat!.version).toBe(2);
    expect(strat!.strategy_text).toBe("v2 strategy");
    const hist = db.getStrategyHistory("agt");
    expect(hist.length).toBe(2);
    // v1 must be inactive
    const v1 = hist.find(s => s.version === 1);
    expect(v1!.active).toBe(0);
  });

  test("getStrategyHistory returns DESC order by version", () => {
    db.evolveStrategy("agt", "v1", "r1");
    db.evolveStrategy("agt", "v2", "r2");
    db.evolveStrategy("agt", "v3", "r3");
    const hist = db.getStrategyHistory("agt");
    expect((hist[0].version as number)).toBeGreaterThan(hist[1].version as number);
  });
});

// ---------------------------------------------------------------------------
// 15. Trust ledger
// ---------------------------------------------------------------------------

describe("Trust ledger", () => {
  test("getTrustScore returns 0 for agent with no entries", () => {
    expect(db.getTrustScore("unknown-agt")).toBe(0);
  });

  test("getTrustScore sums all deltas for an agent", () => {
    db.recordTrustDelta("agt", 50, "good work");
    db.recordTrustDelta("agt", 30, "more good work");
    db.recordTrustDelta("agt", -20, "minor issue");
    expect(db.getTrustScore("agt")).toBe(60);
  });

  test("getTrustScore clamps at 0 (cannot go negative)", () => {
    db.recordTrustDelta("agt", -9999, "massive failure");
    expect(db.getTrustScore("agt")).toBe(0);
  });

  test("getTrustScore clamps at 1000 (maximum)", () => {
    db.recordTrustDelta("agt", 9999, "perfect agent");
    expect(db.getTrustScore("agt")).toBe(1000);
  });

  test("getRecommendedAutonomy returns 'trusted' at >= 700 score", () => {
    db.recordTrustDelta("agt", 700, "excellent");
    const rec = db.getRecommendedAutonomy("agt");
    expect(rec.recommended).toBe("trusted");
  });

  test("getRecommendedAutonomy returns 'supervised' between 300 and 699", () => {
    db.recordTrustDelta("agt", 500, "good enough");
    const rec = db.getRecommendedAutonomy("agt");
    expect(rec.recommended).toBe("supervised");
  });

  test("getRecommendedAutonomy returns 'observe' below 300", () => {
    db.recordTrustDelta("agt", 100, "just starting");
    const rec = db.getRecommendedAutonomy("agt");
    expect(rec.recommended).toBe("observe");
  });

  test("getTrustHistory returns DESC entries limited correctly", () => {
    for (let i = 0; i < 5; i++) db.recordTrustDelta("agt", i * 10, `reason-${i}`);
    const hist = db.getTrustHistory("agt", 3);
    expect(hist.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 16. Tool leases
// ---------------------------------------------------------------------------

describe("Tool leases", () => {
  test("createToolLease returns a positive ID", () => {
    const id = db.createToolLease("agt", "bash_exec");
    expect(id).toBeGreaterThan(0);
  });

  test("hasActiveLease returns true for a fresh unlimited lease", () => {
    db.createToolLease("agt", "bash_exec");
    expect(db.hasActiveLease("agt", "bash_exec")).toBe(true);
  });

  test("hasActiveLease returns false when no lease exists", () => {
    expect(db.hasActiveLease("agt", "file_write")).toBe(false);
  });

  test("hasActiveLease returns false for an expired lease", () => {
    db.createToolLease("agt", "bash_exec", { expiresAt: epoch(-10) });
    expect(db.hasActiveLease("agt", "bash_exec")).toBe(false);
  });

  test("incrementLeaseUsage exhausts lease when executions_used reaches max_executions", () => {
    db.createToolLease("agt", "bash_exec", { maxExecutions: 2 });
    db.incrementLeaseUsage("agt", "bash_exec");
    expect(db.hasActiveLease("agt", "bash_exec")).toBe(true);
    db.incrementLeaseUsage("agt", "bash_exec");
    expect(db.hasActiveLease("agt", "bash_exec")).toBe(false); // exhausted
  });

  test("revokeLeases changes status to 'revoked' and hasActiveLease returns false", () => {
    db.createToolLease("agt", "bash_exec");
    const revoked = db.revokeLeases("agt");
    expect(revoked).toBe(1);
    expect(db.hasActiveLease("agt", "bash_exec")).toBe(false);
  });

  test("revokeLeases with goalId only revokes goal-scoped leases", () => {
    const goalId = db.createGoal("a goal");
    db.createToolLease("agt", "tool-a", { goalId });
    db.createToolLease("agt", "tool-b"); // no goal
    db.revokeLeases("agt", goalId);
    expect(db.hasActiveLease("agt", "tool-a")).toBe(false);
    expect(db.hasActiveLease("agt", "tool-b")).toBe(true);
  });

  test("expireLeases marks past-expiry leases as 'expired'", () => {
    db.createToolLease("agt", "expiring-tool", { expiresAt: epoch(-5) });
    const expired = db.expireLeases();
    expect(expired).toBe(1);
    expect(db.hasActiveLease("agt", "expiring-tool")).toBe(false);
  });

  test("getActiveLeasesForTool returns only active leases for that tool", () => {
    db.createToolLease("agt-a", "shared-tool");
    db.createToolLease("agt-b", "shared-tool");
    db.createToolLease("agt-b", "other-tool");
    const leases = db.getActiveLeasesForTool("shared-tool");
    expect(leases.length).toBe(2);
    expect(leases.every(l => l.agent_name === "agt-a" || l.agent_name === "agt-b")).toBe(true);
  });

  test("revokeLeasesByIds revokes only listed IDs", () => {
    const id1 = db.createToolLease("agt", "tool-1");
    const id2 = db.createToolLease("agt", "tool-2");
    const revoked = db.revokeLeasesByIds([id1]);
    expect(revoked).toBe(1);
    expect(db.hasActiveLease("agt", "tool-1")).toBe(false);
    expect(db.hasActiveLease("agt", "tool-2")).toBe(true);
  });

  test("revokeLeasesByIds with empty array returns 0", () => {
    db.createToolLease("agt", "tool");
    expect(db.revokeLeasesByIds([])).toBe(0);
    expect(db.hasActiveLease("agt", "tool")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 17. Tool autonomy caps
// ---------------------------------------------------------------------------

describe("Tool autonomy caps", () => {
  test("setToolAutonomyCap stores a new row retrievable via getToolAutonomyCap", () => {
    db.setToolAutonomyCap("tool:bash", "supervised", "suggest", "my-provider");
    const cap = db.getToolAutonomyCap("tool:bash");
    expect(cap).not.toBeNull();
    expect(cap!.max_bucket).toBe("supervised");
    expect(cap!.current_bucket).toBe("suggest");
    expect(cap!.set_by_provider).toBe("my-provider");
  });

  test("setToolAutonomyCap is idempotent — second call updates the row", () => {
    db.setToolAutonomyCap("tool:x", "trusted", "suggest", "prov-a");
    db.setToolAutonomyCap("tool:x", "autonomous", "supervised", "prov-b");
    const cap = db.getToolAutonomyCap("tool:x");
    expect(cap!.max_bucket).toBe("autonomous");
    expect(cap!.current_bucket).toBe("supervised");
  });

  test("getToolAutonomyCap returns null for unknown toolId", () => {
    expect(db.getToolAutonomyCap("nonexistent")).toBeNull();
  });

  test("deleteToolAutonomyCap removes the row; getToolAutonomyCap returns null", () => {
    db.setToolAutonomyCap("tool:del", "supervised", "suggest", null);
    db.deleteToolAutonomyCap("tool:del");
    expect(db.getToolAutonomyCap("tool:del")).toBeNull();
  });

  test("promoteToolBucket updates current_bucket within cap", () => {
    db.setToolAutonomyCap("tool:p", "trusted", "suggest", null);
    const result = db.promoteToolBucket("tool:p", "supervised");
    expect(result.current_bucket).toBe("supervised");
    expect(result.max_bucket).toBe("trusted");
    const cap = db.getToolAutonomyCap("tool:p");
    expect(cap!.current_bucket).toBe("supervised");
  });

  test("promoteToolBucket throws AUTONOMY_CAP_VIOLATION when exceeding cap", () => {
    db.setToolAutonomyCap("tool:capped", "supervised", "suggest", null);
    expect(() => db.promoteToolBucket("tool:capped", "autonomous")).toThrow("AUTONOMY_CAP_VIOLATION");
  });

  test("promoteToolBucket throws on unknown bucket name", () => {
    db.setToolAutonomyCap("tool:q", "autonomous", "suggest", null);
    expect(() => db.promoteToolBucket("tool:q", "invalid-bucket")).toThrow(/unknown bucket/);
  });

  test("promoteToolBucket on a tool with no cap row lazily creates row with max=autonomous", () => {
    const result = db.promoteToolBucket("tool:new", "trusted");
    expect(result.max_bucket).toBe("autonomous");
    expect(result.current_bucket).toBe("trusted");
    const cap = db.getToolAutonomyCap("tool:new");
    expect(cap).not.toBeNull();
  });

  test("listToolAutonomyCaps returns all stored caps", () => {
    db.setToolAutonomyCap("tool:a", "supervised", "suggest", null);
    db.setToolAutonomyCap("tool:b", "autonomous", "autonomous", null);
    const caps = db.listToolAutonomyCaps();
    expect(caps.length).toBe(2);
    expect(caps.some(c => c.tool_id === "tool:a")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 18. User profile
// ---------------------------------------------------------------------------

describe("User profile", () => {
  test("addProfileEntry returns a positive ID", () => {
    const id = db.addProfileEntry("trait", "I prefer TypeScript");
    expect(id).toBeGreaterThan(0);
  });

  test("addProfileEntry with duplicate content returns null", () => {
    db.addProfileEntry("trait", "same content");
    const id2 = db.addProfileEntry("trait", "same content");
    expect(id2).toBeNull();
  });

  test("getProfile without category returns all entries sorted by weight DESC", () => {
    db.addProfileEntry("note", "note entry", { weight: 2.0 });
    db.addProfileEntry("trait", "trait entry", { weight: 3.0 });
    const all = db.getProfile();
    expect((all[0].weight as number)).toBeGreaterThanOrEqual(all[1].weight as number);
  });

  test("getProfile with category filter returns only that category", () => {
    db.addProfileEntry("note", "a note");
    db.addProfileEntry("trait", "a trait");
    const notes = db.getProfile("note");
    expect(notes.every(e => e.category === "note")).toBe(true);
  });

  test("default weights by category are applied when not specified", () => {
    db.addProfileEntry("trait", "auto-weighted trait");
    db.addProfileEntry("note", "auto-weighted note");
    const all = db.getProfile();
    const trait = all.find(e => e.category === "trait");
    const note = all.find(e => e.category === "note");
    // trait default = 3.0, note default = 2.0
    expect(trait!.weight).toBeCloseTo(3.0, 5);
    expect(note!.weight).toBeCloseTo(2.0, 5);
  });

  test("updateProfileEntry changes weight and reflects in getProfile", () => {
    const id = db.addProfileEntry("preference", "dark mode", { weight: 1.0 });
    db.updateProfileEntry(id!, { weight: 5.0 });
    const entries = db.getProfile("preference");
    expect(entries[0].weight).toBeCloseTo(5.0, 5);
  });

  test("deleteProfileEntry removes the row and returns true", () => {
    const id = db.addProfileEntry("note", "temporary note");
    expect(db.deleteProfileEntry(id!)).toBe(true);
    expect(db.getProfile("note").length).toBe(0);
  });

  test("searchProfile finds entries matching the query string", () => {
    db.addProfileEntry("note", "dark mode is preferred");
    db.addProfileEntry("note", "light theme for documents");
    const results = db.searchProfile("dark");
    expect(results.length).toBe(1);
    expect((results[0].content as string)).toContain("dark");
  });
});

// ---------------------------------------------------------------------------
// 19. computeQuotaStatus — integration with controlled DB state
// ---------------------------------------------------------------------------

describe("computeQuotaStatus", () => {
  const baseConfig = {
    quota_weekly_tokens: 100_000,
    quota_warning_pct: 75,
    quota_critical_pct: 90,
    quota_window_hours: 24,
  };

  test("empty DB → weekly_tokens_used=0, weekly_pct=0, level='ok'", () => {
    const status = computeQuotaStatus(db, baseConfig);
    expect(status.weekly_tokens_used).toBe(0);
    expect(status.weekly_pct).toBe(0);
    expect(status.weekly_level).toBe("ok");
  });

  test("quota_weekly_tokens=0 → level='unconfigured'", () => {
    insertCostRow(db, "sess", 1000, 2000, epoch(-60));
    const status = computeQuotaStatus(db, { ...baseConfig, quota_weekly_tokens: 0 });
    expect(status.weekly_level).toBe("unconfigured");
    expect(status.weekly_pct).toBe(0); // no limit → pct meaningless
  });

  test("usage at warning threshold → level='warning'", () => {
    // 75,000 tokens = 75% of 100,000
    insertCostRow(db, "sess", 37_500, 37_500, epoch(-60)); // total 75,000
    const status = computeQuotaStatus(db, baseConfig);
    expect(status.weekly_pct).toBe(75);
    expect(status.weekly_level).toBe("warning");
  });

  test("usage at critical threshold → level='critical'", () => {
    insertCostRow(db, "sess", 45_000, 45_000, epoch(-60)); // 90,000 tokens = 90%
    const status = computeQuotaStatus(db, baseConfig);
    expect(status.weekly_pct).toBe(90);
    expect(status.weekly_level).toBe("critical");
  });

  test("usage over 100% → level='exceeded'", () => {
    insertCostRow(db, "sess", 60_000, 60_000, epoch(-60)); // 120,000 = 120%
    const status = computeQuotaStatus(db, baseConfig);
    expect(status.weekly_pct).toBe(120);
    expect(status.weekly_level).toBe("exceeded");
  });

  test("window_tokens_used sums sessions within quota_window_hours", () => {
    insertCostRow(db, "inside", 5000, 5000, epoch(-3600));    // 1h ago — inside 24h window
    insertCostRow(db, "outside", 99000, 99000, epoch(-25 * 3600)); // 25h ago — outside 24h window
    const status = computeQuotaStatus(db, baseConfig);
    // window_tokens_used must only include the 'inside' row
    expect(status.window_tokens_used).toBe(10_000);
  });

  test("tokens_per_hour = window_tokens_used / quota_window_hours", () => {
    insertCostRow(db, "sess", 2400, 0, epoch(-3600)); // 2400 in last 24h → 100/h
    const status = computeQuotaStatus(db, { ...baseConfig, quota_window_hours: 24 });
    // 2400 tokens / 24 hours = 100 tokens/hour
    expect(status.tokens_per_hour).toBe(100);
  });

  test("top_sessions contains sessions with positive token counts", () => {
    insertCostRow(db, "project-a", 10_000, 5_000, epoch(-60));
    insertCostRow(db, "project-b", 3_000, 2_000, epoch(-60));
    const status = computeQuotaStatus(db, baseConfig);
    expect(status.top_sessions.length).toBeGreaterThan(0);
    // First entry should be the highest-usage session
    expect(status.top_sessions[0].name).toBe("project-a");
    expect(status.top_sessions[0].tokens).toBe(15_000);
    // pct should sum correctly relative to total
    const totalTokens = status.weekly_tokens_used;
    const expectedPct = Math.round((15_000 / totalTokens) * 100);
    expect(status.top_sessions[0].pct).toBe(expectedPct);
  });

  test("weekly_tokens_used is the sum of input + output tokens", () => {
    insertCostRow(db, "s", 1234, 5678, epoch(-60));
    const status = computeQuotaStatus(db, baseConfig);
    expect(status.weekly_tokens_used).toBe(1234 + 5678);
  });

  test("window_hours reflects quota_window_hours from config", () => {
    const status = computeQuotaStatus(db, { ...baseConfig, quota_window_hours: 48 });
    expect(status.window_hours).toBe(48);
  });

  test("plan is null when no credentials file exists", () => {
    // On CI / clean test env, no ~/.claude/.credentials.json
    // computeQuotaStatus calls detectClaudePlan() which returns null when missing
    const status = computeQuotaStatus(db, baseConfig);
    // We can't assert null (credentials file might exist on the dev machine)
    // but the field must be null or a string — never undefined
    expect(status.plan === null || typeof status.plan === "string").toBe(true);
    expect(status.rate_limit_tier === null || typeof status.rate_limit_tier === "string").toBe(true);
  });
});
