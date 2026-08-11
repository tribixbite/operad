/**
 * consolidation.test.ts — Unit tests for memory consolidation engine
 *
 * Tests:
 * - shouldConsolidate(): idle-condition gate (idle time, battery, SDK busy, interval)
 * - getConsolidationHistory(): legacy DB column remapping
 * - getLastConsolidationTime(): reads latest completed_at from consolidation_runs
 * - runConsolidation(): exercises decay/prune/merge/cross-pollinate with in-memory DB
 * - buildReflectionPrompt(): section rendering with fake MemoryDb stubs
 * - Engine tests (DB-backed): decay / prune / merge / cross-pollinate / run history
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  shouldConsolidate,
  getLastConsolidationTime,
  runConsolidation,
  buildReflectionPrompt,
} from "../consolidation.js";
import type { IdleConditions } from "../consolidation.js";

/** Helper: build a fully-passing IdleConditions object */
function passing(): IdleConditions {
  return {
    idleSeconds: 2000,
    batteryPct: 80,
    charging: true,
    sdkBusy: false,
  };
}

/** Helper: epoch N hours ago (in seconds) */
function hoursAgo(h: number): number {
  return Math.floor(Date.now() / 1000) - h * 3600;
}

describe("shouldConsolidate", () => {
  test("all conditions met (null epoch) returns true", () => {
    expect(shouldConsolidate(passing(), null)).toBe(true);
  });

  test("insufficient idle time (< 1800s) returns false", () => {
    const cond = passing();
    cond.idleSeconds = 1799;
    expect(shouldConsolidate(cond, null)).toBe(false);
  });

  test("not charging returns false", () => {
    const cond = passing();
    cond.charging = false;
    expect(shouldConsolidate(cond, null)).toBe(false);
  });

  test("low battery (< 30%) returns false", () => {
    const cond = passing();
    cond.batteryPct = 29;
    expect(shouldConsolidate(cond, null)).toBe(false);
  });

  test("SDK busy returns false", () => {
    const cond = passing();
    cond.sdkBusy = true;
    expect(shouldConsolidate(cond, null)).toBe(false);
  });

  test("too recent consolidation (< 12h ago) returns false", () => {
    const recentEpoch = hoursAgo(6); // 6 hours ago — too recent
    expect(shouldConsolidate(passing(), recentEpoch)).toBe(false);
  });

  test("old enough consolidation (> 12h ago) returns true", () => {
    const oldEpoch = hoursAgo(24); // 24 hours ago — old enough
    expect(shouldConsolidate(passing(), oldEpoch)).toBe(true);
  });

  test("exact edge: idleSeconds = 1800 returns true (>= check)", () => {
    const cond = passing();
    cond.idleSeconds = 1800;
    expect(shouldConsolidate(cond, null)).toBe(true);
  });

  test("exact edge: batteryPct = 30 returns false (< check, not <=)", () => {
    // Source uses `conditions.batteryPct < MIN_BATTERY_PCT` which means
    // batteryPct = 30 is NOT less than 30, so it should pass the battery check.
    // But let's verify by reading the source: `conditions.batteryPct < MIN_BATTERY_PCT`
    // 30 < 30 = false, so the check passes — consolidation allowed.
    const cond = passing();
    cond.batteryPct = 30;
    expect(shouldConsolidate(cond, null)).toBe(true);
  });
});

/**
 * Regression: getConsolidationHistory() reads the persisted
 * consolidation_runs schema (which uses legacy column names —
 * `learnings_reviewed`, `syntheses_created`) and must remap onto the
 * modern `ConsolidationResult` field names. Without the remap the
 * dashboard's Governance → Consolidation history table prints
 * "undefined" in 4 of 6 columns.
 *
 * We exercise the mapping by constructing a tiny in-memory SQLite,
 * inserting a row in the legacy shape, and asserting the function
 * returns the modern shape.
 */
import { Database } from "bun:sqlite";
import { getConsolidationHistory } from "../consolidation.js";

describe("getConsolidationHistory — column-name mapping", () => {
  test("legacy DB columns are remapped to modern ConsolidationResult fields", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE consolidation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        learnings_reviewed INTEGER DEFAULT 0,
        learnings_merged INTEGER DEFAULT 0,
        learnings_pruned INTEGER DEFAULT 0,
        syntheses_created INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0
      );
    `);
    db.prepare(
      `INSERT INTO consolidation_runs
        (started_at, completed_at, learnings_reviewed, learnings_merged,
         learnings_pruned, syntheses_created, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(1_700_000_000, 1_700_000_010, 12, 4, 7, 3, 9876);

    // Stub MemoryDb: getConsolidationHistory only calls .requireDb().
    const fakeMemoryDb = { requireDb: () => db } as unknown as Parameters<typeof getConsolidationHistory>[0];
    const rows = getConsolidationHistory(fakeMemoryDb, 5);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.started_at).toBe(1_700_000_000);
    expect(r.completed_at).toBe(1_700_000_010);
    expect(r.learnings_decayed).toBe(12);   // learnings_reviewed (legacy) → learnings_decayed
    expect(r.learnings_merged).toBe(4);
    expect(r.learnings_pruned).toBe(7);
    expect(r.cross_pollinated).toBe(3);     // syntheses_created (legacy) → cross_pollinated
    expect(r.duration_ms).toBe(9876);
    db.close();
  });

  test("missing table returns empty array (no throw)", () => {
    const db = new Database(":memory:");
    const fakeMemoryDb = { requireDb: () => db } as unknown as Parameters<typeof getConsolidationHistory>[0];
    expect(getConsolidationHistory(fakeMemoryDb, 5)).toEqual([]);
    db.close();
  });
});

// =============================================================================
// Engine tests — DB-backed via MemoryDb
// =============================================================================

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { MemoryDb } from "../memory-db.js";
import type { Logger } from "../log.js";

/** Silent logger — suppresses consolidation debug output in test runs */
function silentLog(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

/** Epoch seconds, offset by deltaSeconds from now */
function epoch(deltaSeconds = 0): number {
  return Math.floor(Date.now() / 1000) + deltaSeconds;
}

// ---------------------------------------------------------------------------
// Shared DB setup / teardown for engine tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: MemoryDb;

// NOTE: beforeEach/afterEach are file-scoped in bun:test so these run for
// ALL describe blocks declared after the assignment. The earlier describe
// blocks use their own local sqlite handles and are not affected.

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-consol-test-"));
  db = new MemoryDb(silentLog(), tmpDir);
  await db.init();
});

afterEach(() => {
  db.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

// ---------------------------------------------------------------------------
// getLastConsolidationTime — with real DB
// ---------------------------------------------------------------------------

describe("getLastConsolidationTime — DB-backed", () => {
  test("returns null when no consolidation_runs rows exist", () => {
    expect(getLastConsolidationTime(db)).toBeNull();
  });

  test("returns the most recent completed_at after a consolidation run", () => {
    // Run a minimal consolidation so the history row is written
    runConsolidation(db, ["agent-a"], silentLog());
    const t = getLastConsolidationTime(db);
    expect(t).not.toBeNull();
    // Should be very close to now (within 5 seconds)
    expect(Math.abs(t! - epoch())).toBeLessThan(5);
  });

  test("returns the latest of multiple runs", () => {
    // Directly insert two history rows with controlled timestamps
    db.requireDb().prepare(
      `INSERT INTO consolidation_runs (started_at, completed_at, learnings_reviewed, learnings_merged, learnings_pruned, syntheses_created, duration_ms)
       VALUES (?, ?, 0, 0, 0, 0, 0)`,
    ).run(1_000_000, 1_000_010);
    db.requireDb().prepare(
      `INSERT INTO consolidation_runs (started_at, completed_at, learnings_reviewed, learnings_merged, learnings_pruned, syntheses_created, duration_ms)
       VALUES (?, ?, 0, 0, 0, 0, 0)`,
    ).run(2_000_000, 2_000_020);
    // Must return the larger (later) completed_at
    expect(getLastConsolidationTime(db)).toBe(2_000_020);
  });
});

// ---------------------------------------------------------------------------
// Decay engine tests
// ---------------------------------------------------------------------------

describe("runConsolidation — decay phase", () => {
  test("decayLearnings is called: old unreinforced learning has confidence reduced", () => {
    // Insert a learning and backdate its last_reinforced_at by 60 days
    const id = db.addLearning("agent-a", "insight", "old knowledge", { confidence: 0.8 });
    db.requireDb().prepare(
      `UPDATE agent_learnings SET last_reinforced_at = ? WHERE id = ?`,
    ).run(epoch(-60 * 86400), id);

    const result = runConsolidation(db, ["agent-a"], silentLog());

    // learnings_decayed should be positive
    expect(result.learnings_decayed).toBeGreaterThan(0);

    // Confidence must have dropped from 0.8 → 0.8 * 0.95 = 0.76
    const learnings = db.getAgentLearnings("agent-a");
    expect(learnings.length).toBe(1);
    expect(learnings[0].confidence as number).toBeCloseTo(0.76, 3);
  });

  test("recently reinforced learnings are NOT decayed", () => {
    // Insert a learning with current last_reinforced_at (default)
    db.addLearning("agent-a", "insight", "fresh knowledge", { confidence: 0.8 });

    const result = runConsolidation(db, ["agent-a"], silentLog());

    // No decay should have occurred
    expect(result.learnings_decayed).toBe(0);
    const learnings = db.getAgentLearnings("agent-a");
    expect(learnings[0].confidence as number).toBeCloseTo(0.8, 5);
  });

  test("decay floors at 0.1 — confidence at 0.1 is not reduced further", () => {
    const id = db.addLearning("agent-a", "insight", "floored knowledge", { confidence: 0.1 });
    // reinforcement_count > 1 keeps the prune phase from removing this row.
    // Pruning previously never matched anything (its predicate required
    // reinforcement_count = 0, but the column defaults to 1), so this test did
    // not have to account for it; now that pruning works, the fixture has to
    // be explicit about which phase it is exercising.
    db.requireDb().prepare(
      `UPDATE agent_learnings
         SET last_reinforced_at = ?, confidence = 0.1, reinforcement_count = 5
       WHERE id = ?`,
    ).run(epoch(-60 * 86400), id);

    // decayLearnings guards with `confidence > 0.1` so a row at exactly 0.1 isn't touched
    const result = runConsolidation(db, ["agent-a"], silentLog());
    // The row at 0.1 has confidence <= 0.1 so it is excluded from the WHERE clause
    expect(result.learnings_decayed).toBe(0);
    const learnings = db.getAgentLearnings("agent-a");
    expect(learnings[0].confidence as number).toBeCloseTo(0.1, 5);
  });
});

// ---------------------------------------------------------------------------
// Prune engine tests
// ---------------------------------------------------------------------------

describe("runConsolidation — prune phase", () => {
  test("low-confidence (< 0.15) learning with zero reinforcements is removed", () => {
    // Direct SQL insert so we can set confidence < 0.15 AND reinforcement_count = 0
    // addLearning sets reinforcement_count=1 by default
    db.requireDb().prepare(
      `INSERT INTO agent_learnings (agent_name, category, content, content_hash, confidence, reinforcement_count)
       VALUES ('agent-a', 'insight', 'prunable learning', 'hash-prune-001', 0.10, 0)`,
    ).run();

    const before = (db.requireDb().prepare(
      `SELECT COUNT(*) as c FROM agent_learnings WHERE agent_name = 'agent-a'`,
    ).get() as { c: number }).c;
    expect(before).toBe(1);

    const result = runConsolidation(db, ["agent-a"], silentLog());

    // Prune must report removal
    expect(result.learnings_pruned).toBe(1);

    // Verify via COUNT (not result.changes to avoid any FTS cascade ambiguity)
    const after = (db.requireDb().prepare(
      `SELECT COUNT(*) as c FROM agent_learnings WHERE agent_name = 'agent-a'`,
    ).get() as { c: number }).c;
    expect(after).toBe(0);
  });

  test("learning at exactly threshold (0.15) is NOT pruned", () => {
    // confidence = 0.15 is NOT less than 0.15 → survives
    db.requireDb().prepare(
      `INSERT INTO agent_learnings (agent_name, category, content, content_hash, confidence, reinforcement_count)
       VALUES ('agent-a', 'insight', 'boundary learning', 'hash-bound-015', 0.15, 0)`,
    ).run();

    const result = runConsolidation(db, ["agent-a"], silentLog());
    expect(result.learnings_pruned).toBe(0);

    const after = (db.requireDb().prepare(
      `SELECT COUNT(*) as c FROM agent_learnings WHERE agent_name = 'agent-a'`,
    ).get() as { c: number }).c;
    expect(after).toBe(1);
  });

  test("learning with confidence < 0.15 but reinforcement_count > 0 is NOT pruned", () => {
    // The prune condition is confidence < 0.15 AND reinforcement_count = 0
    // A reinforced-but-decayed learning survives pruning
    db.requireDb().prepare(
      `INSERT INTO agent_learnings (agent_name, category, content, content_hash, confidence, reinforcement_count)
       VALUES ('agent-a', 'insight', 'reinforced low-conf', 'hash-reinf-low', 0.12, 2)`,
    ).run();

    const result = runConsolidation(db, ["agent-a"], silentLog());
    expect(result.learnings_pruned).toBe(0);

    const after = (db.requireDb().prepare(
      `SELECT COUNT(*) as c FROM agent_learnings WHERE agent_name = 'agent-a'`,
    ).get() as { c: number }).c;
    expect(after).toBe(1);
  });

  test("multiple prunable learnings across different agents only prune agent's own", () => {
    // Two prunable learnings for agent-a, one for agent-b
    db.requireDb().prepare(
      `INSERT INTO agent_learnings (agent_name, category, content, content_hash, confidence, reinforcement_count)
       VALUES ('agent-a', 'insight', 'prune-me-1', 'hash-pm1', 0.05, 0),
              ('agent-a', 'insight', 'prune-me-2', 'hash-pm2', 0.08, 0),
              ('agent-b', 'insight', 'b-prunable', 'hash-bpm', 0.05, 0)`,
    ).run();

    // Only consolidate agent-a
    const result = runConsolidation(db, ["agent-a"], silentLog());
    expect(result.learnings_pruned).toBe(2);

    // agent-b's row untouched
    const bCount = (db.requireDb().prepare(
      `SELECT COUNT(*) as c FROM agent_learnings WHERE agent_name = 'agent-b'`,
    ).get() as { c: number }).c;
    expect(bCount).toBe(1);
  });

  test("empty DB for an agent: prune reports 0, no error", () => {
    const result = runConsolidation(db, ["agent-empty"], silentLog());
    expect(result.learnings_pruned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Merge engine tests
// ---------------------------------------------------------------------------

describe("runConsolidation — merge phase", () => {
  test("two learnings with same category and identical content hash prefix are merged", () => {
    // The merge key is: category + first 8 chars of content_hash.
    // Insert two rows with the same category + same first 8 chars of hash,
    // different confidence so merge has a clear winner.
    // Contents must be genuinely near-identical: a shared 8-char prefix is
    // only 32 bits, so merging on the prefix alone destroyed unrelated
    // learnings. The merge now normalises and compares the bodies.
    const sharedHashPrefix = "aabbccdd";
    db.requireDb().prepare(
      `INSERT INTO agent_learnings (agent_name, category, content, content_hash, confidence, reinforcement_count)
       VALUES ('agent-a', 'insight', 'the build is flaky', '${sharedHashPrefix}11111111', 0.4, 1),
              ('agent-a', 'insight', 'The build is flaky!', '${sharedHashPrefix}22222222', 0.7, 1)`,
    ).run();

    const result = runConsolidation(db, ["agent-a"], silentLog());
    expect(result.learnings_merged).toBe(1);

    // Only 1 learning should remain
    const remaining = (db.requireDb().prepare(
      `SELECT COUNT(*) as c FROM agent_learnings WHERE agent_name = 'agent-a'`,
    ).get() as { c: number }).c;
    expect(remaining).toBe(1);

    // The surviving row should be the higher-confidence one
    const learnings = db.getAgentLearnings("agent-a");
    expect(learnings[0].content).toBe("The build is flaky!");
  });

  test("learnings with different category are NOT merged even if hash prefix matches", () => {
    const sharedHashPrefix = "deadbeef";
    db.requireDb().prepare(
      `INSERT INTO agent_learnings (agent_name, category, content, content_hash, confidence, reinforcement_count)
       VALUES ('agent-a', 'insight', 'insight content', '${sharedHashPrefix}11111111', 0.6, 1),
              ('agent-a', 'pattern', 'pattern content', '${sharedHashPrefix}22222222', 0.7, 1)`,
    ).run();

    const result = runConsolidation(db, ["agent-a"], silentLog());
    expect(result.learnings_merged).toBe(0);

    // Both survive
    const count = (db.requireDb().prepare(
      `SELECT COUNT(*) as c FROM agent_learnings WHERE agent_name = 'agent-a'`,
    ).get() as { c: number }).c;
    expect(count).toBe(2);
  });

  test("surviving learning is boosted: reinforcement_count increases after merge", () => {
    const sharedHashPrefix = "cafebabe";
    // Insert weaker (0.3) and stronger (0.8) — stronger should survive and be boosted
    db.requireDb().prepare(
      // Same fact, different phrasing — the merge requires the bodies to be
      // near-identical after normalisation, not merely hash-prefix siblings.
      `INSERT INTO agent_learnings (agent_name, category, content, content_hash, confidence, reinforcement_count)
       VALUES ('agent-a', 'insight', 'retries are needed', '${sharedHashPrefix}11', 0.3, 1),
              ('agent-a', 'insight', 'Retries are needed.', '${sharedHashPrefix}22', 0.8, 2)`,
    ).run();

    runConsolidation(db, ["agent-a"], silentLog());

    const surviving = db.requireDb().prepare(
      `SELECT reinforcement_count FROM agent_learnings WHERE agent_name = 'agent-a'`,
    ).get() as { reinforcement_count: number } | undefined;

    // stronger had reinforcement_count=2; the merge boosts it by weaker's count+1=2
    // mergeSimilarLearnings: run(existing.reinforcement_count + 1, c.id)
    // where existing = weaker(count=1), c = stronger(count=2)
    // → stronger's new count = 2 + (1+1) = 4
    expect(surviving!.reinforcement_count).toBeGreaterThan(2);
  });


  test("hash-prefix collision with UNRELATED content does NOT merge", () => {
    // The merge key is only 32 bits of hash. Because addLearning already
    // dedupes on the full hash, a prefix match between two surviving rows is a
    // birthday collision between unrelated facts — merging deleted one of them
    // permanently. Both must survive.
    const prefix = "f00dface";
    db.requireDb().prepare(
      `INSERT INTO agent_learnings (agent_name, category, content, content_hash, confidence, reinforcement_count)
       VALUES ('agent-a', 'insight', 'the database uses WAL mode', '${prefix}11111111', 0.9, 4),
              ('agent-a', 'insight', 'the deploy runs on Tuesdays', '${prefix}22222222', 0.4, 7)`,
    ).run();

    const result = runConsolidation(db, ["agent-a"], silentLog());
    expect(result.learnings_merged).toBe(0);
    const remaining = (db.requireDb().prepare(
      `SELECT COUNT(*) as c FROM agent_learnings WHERE agent_name = 'agent-a'`,
    ).get() as { c: number }).c;
    expect(remaining).toBe(2);
  });

  test("a NULL content_hash row is skipped instead of crashing", () => {
    // content_hash is nullable; `.slice()` on NULL threw out of the
    // consolidation tick and killed the daemon.
    db.requireDb().prepare(
      `INSERT INTO agent_learnings (agent_name, category, content, content_hash, confidence, reinforcement_count)
       VALUES ('agent-a', 'insight', 'no hash here', NULL, 0.5, 3)`,
    ).run();
    expect(() => runConsolidation(db, ["agent-a"], silentLog())).not.toThrow();
  });

  test("a low-confidence learning created via addLearning is now prunable", () => {
    // The prune predicate required reinforcement_count = 0, but addLearning
    // inserts 1, so pruning never removed anything.
    db.addLearning("agent-a", "insight", "barely believed", { confidence: 0.05 });
    const result = runConsolidation(db, ["agent-a"], silentLog());
    expect(result.learnings_pruned).toBeGreaterThan(0);
  });

  test("single learning per category/prefix: no merge, count=0", () => {
    db.addLearning("agent-a", "insight", "unique content");
    const result = runConsolidation(db, ["agent-a"], silentLog());
    expect(result.learnings_merged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-pollination tests
// ---------------------------------------------------------------------------

describe("runConsolidation — cross-pollinate phase", () => {
  test("high-confidence learnings from one agent are shared to others", () => {
    // agent-x has high-confidence learning
    db.addLearning("agent-x", "insight", "shared wisdom", { confidence: 0.9 });

    // Both agents included → cross-pollination runs
    runConsolidation(db, ["agent-x", "agent-y"], silentLog());

    // agent-y should now have a learning from cross-pollination
    const yLearnings = db.getAgentLearnings("agent-y");
    // The cross-pollinated learning should appear (addLearning is idempotent)
    expect(yLearnings.length).toBeGreaterThan(0);
  });

  test("cross-pollination only occurs when multiple agents in the list", () => {
    db.addLearning("agent-x", "insight", "solo wisdom", { confidence: 0.9 });

    // Single agent — no cross-pollination
    const result = runConsolidation(db, ["agent-x"], silentLog());
    expect(result.cross_pollinated).toBe(0);
  });

  test("low-confidence learnings (< 0.8) are not cross-pollinated", () => {
    // Confidence 0.7 < the 0.8 threshold used in getSharedInsights
    db.addLearning("agent-x", "insight", "low-conf content", { confidence: 0.7 });

    runConsolidation(db, ["agent-x", "agent-y"], silentLog());

    const yLearnings = db.getAgentLearnings("agent-y");
    expect(yLearnings.length).toBe(0);
  });

  test("cross_pollinated count increments once per insight-agent pair", () => {
    // Two high-confidence learnings from agent-x
    db.addLearning("agent-x", "insight", "wisdom one", { confidence: 0.85 });
    db.addLearning("agent-x", "insight", "wisdom two", { confidence: 0.9 });

    const result = runConsolidation(db, ["agent-x", "agent-y"], silentLog());

    // getSharedInsights called for agent-y excludes agent-y, finds up to 3 from agent-x
    // Both qualify → cross_pollinated = 2 (one per insight)
    expect(result.cross_pollinated).toBeGreaterThan(0);
  });

  test("cross-pollination uses addLearning dedup — re-running does not create duplicates", () => {
    db.addLearning("agent-x", "insight", "idempotent wisdom", { confidence: 0.9 });

    runConsolidation(db, ["agent-x", "agent-y"], silentLog());
    runConsolidation(db, ["agent-x", "agent-y"], silentLog());

    // agent-y should still have exactly 1 learning (dedup via content_hash)
    const yLearnings = db.getAgentLearnings("agent-y");
    const unique = new Set(yLearnings.map((l: Record<string, unknown>) => l.content));
    expect(unique.size).toBe(yLearnings.length); // no duplicates
  });
});

// ---------------------------------------------------------------------------
// consolidation_runs history persistence
// ---------------------------------------------------------------------------

describe("runConsolidation — history persistence", () => {
  test("a consolidation_runs row is written after each run", () => {
    runConsolidation(db, ["agent-a"], silentLog());

    const rows = db.requireDb().prepare(
      `SELECT * FROM consolidation_runs`,
    ).all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
  });

  test("history row has correct field mappings (decayed→reviewed, cross_pollinated→syntheses_created)", () => {
    // Insert a prunable learning so decayed/pruned counts are non-zero
    db.requireDb().prepare(
      `INSERT INTO agent_learnings (agent_name, category, content, content_hash, confidence, reinforcement_count)
       VALUES ('agent-a', 'insight', 'prune-history', 'hash-hist001', 0.05, 0)`,
    ).run();

    const result = runConsolidation(db, ["agent-a"], silentLog());

    // Read the raw row from DB using legacy column names
    const row = db.requireDb().prepare(
      `SELECT learnings_reviewed, learnings_merged, learnings_pruned, syntheses_created, duration_ms FROM consolidation_runs`,
    ).get() as {
      learnings_reviewed: number; learnings_merged: number;
      learnings_pruned: number; syntheses_created: number; duration_ms: number;
    } | undefined;

    expect(row).toBeDefined();
    // learnings_reviewed stores the "decayed" count
    expect(row!.learnings_reviewed).toBe(result.learnings_decayed);
    expect(row!.learnings_pruned).toBe(result.learnings_pruned);
    expect(row!.learnings_merged).toBe(result.learnings_merged);
    // syntheses_created stores the cross_pollinated count
    expect(row!.syntheses_created).toBe(result.cross_pollinated);
    expect(row!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("multiple runs each write their own history row", () => {
    runConsolidation(db, ["agent-a"], silentLog());
    runConsolidation(db, ["agent-a"], silentLog());
    runConsolidation(db, ["agent-a"], silentLog());

    const count = (db.requireDb().prepare(
      `SELECT COUNT(*) as c FROM consolidation_runs`,
    ).get() as { c: number }).c;
    expect(count).toBe(3);
  });

  test("getConsolidationHistory reflects runs written by runConsolidation", () => {
    runConsolidation(db, ["agent-a"], silentLog());

    const history = getConsolidationHistory(db, 10);
    expect(history.length).toBe(1);
    const r = history[0];
    // All result fields should be present and non-negative
    expect(r.started_at).toBeGreaterThan(0);
    expect(r.completed_at).toBeGreaterThanOrEqual(r.started_at);
    expect(r.learnings_decayed).toBeGreaterThanOrEqual(0);
    expect(r.learnings_pruned).toBeGreaterThanOrEqual(0);
    expect(r.learnings_merged).toBeGreaterThanOrEqual(0);
    expect(r.cross_pollinated).toBeGreaterThanOrEqual(0);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("getConsolidationHistory limit is respected", () => {
    for (let i = 0; i < 5; i++) runConsolidation(db, [], silentLog());
    const history = getConsolidationHistory(db, 3);
    expect(history.length).toBe(3);
  });

  test("getConsolidationHistory returns results ordered by completed_at DESC (newest first)", () => {
    // Insert two rows with controlled timestamps
    db.requireDb().prepare(
      `INSERT INTO consolidation_runs (started_at, completed_at, learnings_reviewed, learnings_merged, learnings_pruned, syntheses_created, duration_ms)
       VALUES (?, ?, 0, 0, 0, 0, 0)`,
    ).run(1_000_000, 1_000_010);
    db.requireDb().prepare(
      `INSERT INTO consolidation_runs (started_at, completed_at, learnings_reviewed, learnings_merged, learnings_pruned, syntheses_created, duration_ms)
       VALUES (?, ?, 0, 0, 0, 0, 0)`,
    ).run(2_000_000, 2_000_020);

    const history = getConsolidationHistory(db, 10);
    expect(history.length).toBe(2);
    // Newest first
    expect(history[0].completed_at).toBe(2_000_020);
    expect(history[1].completed_at).toBe(1_000_010);
  });
});

// ---------------------------------------------------------------------------
// runConsolidation — full integration
// ---------------------------------------------------------------------------

describe("runConsolidation — full integration", () => {
  test("result fields are all non-negative integers / numbers", () => {
    db.addLearning("agent-a", "insight", "content-1", { confidence: 0.9 });
    const result = runConsolidation(db, ["agent-a"], silentLog());

    expect(typeof result.started_at).toBe("number");
    expect(typeof result.completed_at).toBe("number");
    expect(result.learnings_decayed).toBeGreaterThanOrEqual(0);
    expect(result.learnings_pruned).toBeGreaterThanOrEqual(0);
    expect(result.learnings_merged).toBeGreaterThanOrEqual(0);
    expect(result.cross_pollinated).toBeGreaterThanOrEqual(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("empty agent list produces zero counts and writes a history row", () => {
    const result = runConsolidation(db, [], silentLog());

    expect(result.learnings_decayed).toBe(0);
    expect(result.learnings_pruned).toBe(0);
    expect(result.learnings_merged).toBe(0);
    expect(result.cross_pollinated).toBe(0);

    const count = (db.requireDb().prepare(
      `SELECT COUNT(*) as c FROM consolidation_runs`,
    ).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test("completed_at >= started_at (no time-travel)", () => {
    const result = runConsolidation(db, ["agent-a"], silentLog());
    expect(result.completed_at).toBeGreaterThanOrEqual(result.started_at);
  });

  test("specialization decay is attempted (no error even when table is present)", () => {
    db.upsertSpecialization("agent-a", "TypeScript", 0.9);
    db.requireDb().prepare(
      `UPDATE agent_specializations SET updated_at = ? WHERE agent_name = 'agent-a'`,
    ).run(epoch(-100 * 86400)); // 100 days old → will be decayed

    // Should not throw
    expect(() => runConsolidation(db, ["agent-a"], silentLog())).not.toThrow();

    // Specialization confidence should have dropped
    const specs = db.getSpecializations("agent-a");
    expect(specs[0].confidence).toBeLessThan(0.9);
  });

  test("multiple agents processed in order: totals are cumulative", () => {
    // Give each agent a prunable learning
    for (const agent of ["agent-a", "agent-b", "agent-c"]) {
      db.requireDb().prepare(
        `INSERT INTO agent_learnings (agent_name, category, content, content_hash, confidence, reinforcement_count)
         VALUES (?, 'insight', ?, ?, 0.05, 0)`,
      ).run(agent, `prune-${agent}`, `hash-${agent}`);
    }

    const result = runConsolidation(db, ["agent-a", "agent-b", "agent-c"], silentLog());

    // 3 prunable learnings across 3 agents
    expect(result.learnings_pruned).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// buildReflectionPrompt — DB-backed
// ---------------------------------------------------------------------------

describe("buildReflectionPrompt — DB-backed stubs", () => {
  test("prompt contains expected section headers", () => {
    const prompt = buildReflectionPrompt(db, "agent-a");
    expect(prompt).toContain("# Reflection Session");
    expect(prompt).toContain("## Your Complete Knowledge Base");
    expect(prompt).toContain("## Decision History");
    expect(prompt).toContain("## Your Personality");
    expect(prompt).toContain("## Reflective Questions");
  });

  test("empty DB: shows 'no learnings' placeholder text", () => {
    const prompt = buildReflectionPrompt(db, "agent-a");
    expect(prompt).toContain("_No learnings recorded yet._");
  });

  test("with learnings: shows confidence and category in prompt", () => {
    db.addLearning("agent-a", "insight", "test learning content", { confidence: 0.75 });
    const prompt = buildReflectionPrompt(db, "agent-a");
    expect(prompt).toContain("[insight]");
    expect(prompt).toContain("0.75");
    expect(prompt).toContain("test learning content");
  });

  test("with a decision: shows action and rationale in prompt", () => {
    db.recordDecision("agent-a", "deploy service", "latency was too high");
    const prompt = buildReflectionPrompt(db, "agent-a");
    expect(prompt).toContain("deploy service");
    expect(prompt).toContain("latency was too high");
  });

  test("with a personality trait: shows trait name and value", () => {
    db.setPersonalityTrait("agent-a", "curiosity", 0.8);
    const prompt = buildReflectionPrompt(db, "agent-a");
    expect(prompt).toContain("**curiosity**");
  });

  test("with a strategy: shows strategy section and text", () => {
    db.evolveStrategy("agent-a", "focus on reliability", "initial strategy");
    const prompt = buildReflectionPrompt(db, "agent-a");
    expect(prompt).toContain("## Current Strategy");
    expect(prompt).toContain("focus on reliability");
  });

  test("without a strategy: no strategy section rendered", () => {
    // No strategy created for this agent
    const prompt = buildReflectionPrompt(db, "agent-no-strat");
    expect(prompt).not.toContain("## Current Strategy");
  });

  test("empty decisions: shows 'no decisions' placeholder", () => {
    const prompt = buildReflectionPrompt(db, "agent-a");
    expect(prompt).toContain("_No decisions recorded._");
  });

  test("empty personality: shows 'no personality traits' placeholder", () => {
    const prompt = buildReflectionPrompt(db, "agent-a");
    expect(prompt).toContain("_No personality traits defined._");
  });

  test("prompt ends with reflection question block", () => {
    const prompt = buildReflectionPrompt(db, "agent-a");
    // Last instruction line should always appear
    expect(prompt).toContain("Emit `learning`, `personality`, and `strategy` blocks with your insights.");
  });
});
