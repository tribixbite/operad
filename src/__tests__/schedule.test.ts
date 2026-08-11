/**
 * schedule.test.ts — Tests for schedule.ts (ScheduleEngine + nextCronTime)
 *
 * Covers:
 *  - nextCronTime: every/star/range/list field syntax, invalid expressions,
 *    exact minute alignment, multi-day and year-boundary cases, fields out of range
 *  - ScheduleEngine.upsert: interval schedule, cron schedule, upsert idempotency,
 *    partial-update reset (consecutive_failures → 0 on re-upsert)
 *  - ScheduleEngine.getAll: unfiltered, filtered by agentName
 *  - ScheduleEngine.delete: removes existing schedule, returns false for unknown
 *  - ScheduleEngine.setEnabled: enable/disable by id
 *  - ScheduleEngine — poll loop (manual invocation via exposed pollDueSchedules shim):
 *      successful handler → run_count++, consecutive_failures=0, next_run_at updated
 *      failed handler → consecutive_failures++, still enabled (below threshold)
 *      3 consecutive failures → auto-disable (enabled=0, next_run_at=null)
 *      handler throws → treated as failure, same auto-disable path
 *      non-due schedule (next_run_at in future) → handler not called
 *  - computeNextRun: interval math, cron-backed next run, null for neither
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MemoryDb } from "../memory-db.js";
import { ScheduleEngine, nextCronTime } from "../schedule.js";
import type { ScheduleRecord, ScheduleHandler } from "../schedule.js";
import type { Logger } from "../log.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLog(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

/** Epoch seconds, offset from now */
function epoch(delta = 0): number {
  return Math.floor(Date.now() / 1000) + delta;
}

/** A handler that always succeeds */
function successHandler(costUsd = 0): ScheduleHandler {
  return async () => ({ success: true, costUsd });
}

/** A handler that always reports failure */
function failHandler(): ScheduleHandler {
  return async () => ({ success: false });
}

/** A handler that throws */
function throwHandler(): ScheduleHandler {
  return async () => { throw new Error("kaboom"); };
}

/**
 * Subclass that exposes pollDueSchedules and computeNextRun for direct testing,
 * and allows clock injection via now() override.
 */
class TestableScheduleEngine extends ScheduleEngine {
  constructor(db: MemoryDb, log: Logger, handler: ScheduleHandler) {
    super(db, log, handler);
  }

  /** Directly trigger the poll loop without waiting for the 30s timer */
  async poll(): Promise<void> {
    // Access private method via type cast
    await (this as any).pollDueSchedules();
  }

  /** Directly compute next run from outside (exercises private method) */
  computeNext(cronExpr: string | null, intervalMinutes: number | null, afterEpoch: number): number | null {
    return (this as any).computeNextRun(cronExpr, intervalMinutes, afterEpoch);
  }
}

let tmpDir: string;
let db: MemoryDb;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-sched-test-"));
  db = new MemoryDb(silentLog(), tmpDir);
  await db.init();
});

afterEach(() => {
  db.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

// ---------------------------------------------------------------------------
// nextCronTime — pure cron computation
// ---------------------------------------------------------------------------

describe("nextCronTime — invalid expressions", () => {
  test("returns null for empty string", () => {
    expect(nextCronTime("", new Date())).toBeNull();
  });

  test("returns null for expression with fewer than 5 fields", () => {
    expect(nextCronTime("* * * *", new Date())).toBeNull();
  });

  test("returns null for expression with more than 5 fields", () => {
    expect(nextCronTime("* * * * * *", new Date())).toBeNull();
  });

  test("returns null for step=0 in step field", () => {
    // */0 is invalid (divide by zero)
    expect(nextCronTime("*/0 * * * *", new Date())).toBeNull();
  });

  test("returns null for a value outside field range", () => {
    // minute 60 is out of range (0-59)
    expect(nextCronTime("60 * * * *", new Date())).toBeNull();
  });
});

describe("nextCronTime — wildcard (*)", () => {
  test("'* * * * *' fires 1 minute after the reference date", () => {
    // Reference: 2025-01-15T12:00:00Z (a Wednesday)
    const after = new Date("2025-01-15T12:00:00Z");
    const next = nextCronTime("* * * * *", after);
    expect(next).not.toBeNull();
    // Next fire = +1 minute exactly
    expect(next!.getTime()).toBe(after.getTime() + 60_000);
  });

  test("'* * * * *' result is always 60s after after (second boundary stripped)", () => {
    // After has non-zero seconds — they should be zeroed in the candidate
    const after = new Date("2025-03-10T08:45:30Z");
    const next = nextCronTime("* * * * *", after)!;
    // Seconds should be 0
    expect(next.getUTCSeconds()).toBe(0);
    // Should be 2025-03-10T08:46:00Z
    expect(next.getTime()).toBe(new Date("2025-03-10T08:46:00Z").getTime());
  });
});

describe("nextCronTime — specific minute/hour", () => {
  test("'30 9 * * *' next fire after 09:30 is next day at 09:30", () => {
    const after = new Date("2025-01-15T09:30:00Z");
    const next = nextCronTime("30 9 * * *", after)!;
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(30);
    // Must be the day AFTER (since after == fire time, next is +1 minute → same day 09:31,
    // which is not at minute=30/hour=9, so advances to next day)
    expect(next.getUTCDate()).toBe(16); // Jan 16
  });

  test("'0 0 * * *' fires at midnight — next fire after 23:59 is midnight next day", () => {
    const after = new Date("2025-06-01T23:59:00Z");
    const next = nextCronTime("0 0 * * *", after)!;
    expect(next.toISOString()).toBe("2025-06-02T00:00:00.000Z");
  });

  test("'0 12 * * *' fires in about 12h if current time is midnight", () => {
    const after = new Date("2025-04-10T00:00:00Z");
    const next = nextCronTime("0 12 * * *", after)!;
    expect(next.toISOString()).toBe("2025-04-10T12:00:00.000Z");
  });
});

describe("nextCronTime — step syntax (*/N)", () => {
  test("'*/15 * * * *' fires at next :00, :15, :30, or :45", () => {
    const after = new Date("2025-01-01T10:01:00Z");
    const next = nextCronTime("*/15 * * * *", after)!;
    expect(next.getUTCMinutes()).toBe(15);
    expect(next.getUTCHours()).toBe(10);
  });

  test("'0 */6 * * *' fires every 6 hours (0h, 6h, 12h, 18h)", () => {
    const after = new Date("2025-01-01T06:00:00Z"); // just past 06:00:00
    const next = nextCronTime("0 */6 * * *", after)!;
    expect(next.getUTCHours()).toBe(12);
    expect(next.getUTCMinutes()).toBe(0);
  });
});

describe("nextCronTime — range syntax (A-B)", () => {
  test("'0 9-11 * * *' fires at 10:00 when after=09:01", () => {
    const after = new Date("2025-03-05T09:01:00Z");
    const next = nextCronTime("0 9-11 * * *", after)!;
    expect(next.getUTCHours()).toBe(10);
    expect(next.getUTCMinutes()).toBe(0);
  });

  test("'30-35 * * * *' fires at :31 when after is :30", () => {
    const after = new Date("2025-03-05T14:30:00Z");
    const next = nextCronTime("30-35 * * * *", after)!;
    expect(next.getUTCMinutes()).toBe(31);
  });
});

describe("nextCronTime — list syntax (A,B,C)", () => {
  test("'0 8,12,18 * * *' after 08:01 fires at 12:00", () => {
    const after = new Date("2025-02-20T08:01:00Z");
    const next = nextCronTime("0 8,12,18 * * *", after)!;
    expect(next.getUTCHours()).toBe(12);
    expect(next.getUTCMinutes()).toBe(0);
  });

  test("'0,30 * * * *' fires at :00 then :30 of next hour after :30", () => {
    const after = new Date("2025-02-20T10:30:00Z");
    const next = nextCronTime("0,30 * * * *", after)!;
    expect(next.getUTCHours()).toBe(11);
    expect(next.getUTCMinutes()).toBe(0);
  });
});

describe("nextCronTime — day-of-week / day-of-month", () => {
  /**
   * POSIX cron semantics: the dom/dow union applies ONLY when both fields are
   * restricted. When just one is restricted the other is ignored entirely.
   *
   * The previous implementation expanded `*` into the full set, losing the
   * "is this restricted?" distinction, so the OR was always satisfied and
   * "0 9 * * 1" fired daily. This docblock and the test below described that
   * as intended behaviour; it was a bug, and a costly one — every weekly
   * agent schedule ran 7x.
   */
  test("'0 9 * * 1' fires only on Mondays", () => {
    // 2025-01-15 is a Wednesday at 09:00:00 UTC; the next Monday is Jan 20.
    const after = new Date("2025-01-15T09:00:00Z");
    const next = nextCronTime("0 9 * * 1", after)!;
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getUTCDay()).toBe(1);
    expect(next.getUTCDate()).toBe(20);
  });

  test("'0 9 1 * 1' fires at 09:00 on the next Monday or 1st (whichever comes first)", () => {
    // 2025-01-15 Wed 09:01 → next match is Jan 20 (Monday) or Feb 1 (1st)
    // Jan 20 is Monday, comes before Feb 1
    const after = new Date("2025-01-15T09:01:00Z");
    const next = nextCronTime("0 9 1 * 1", after)!;
    // Should be Jan 20 (Monday) at 09:00 since that's before Feb 1
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCDate()).toBeLessThanOrEqual(31);
    expect(next.getUTCMonth()).toBe(0); // still January
  });

  test("'0 0 * 1 *' (any midnight in January) fires at next midnight in Jan", () => {
    // dom=* and dow=* → every midnight in January qualifies
    const after = new Date("2025-01-01T00:01:00Z");
    const next = nextCronTime("0 0 * 1 *", after)!;
    // Next midnight in January = Jan 2 00:00
    expect(next.getUTCMonth()).toBe(0); // January
    expect(next.getUTCDate()).toBe(2);
    expect(next.getUTCHours()).toBe(0);
    expect(next.getUTCMinutes()).toBe(0);
  });

  test("'0 0 * * 0' (wildcard dom + Sunday dow) fires at next 00:00", () => {
    // 2025-01-18 is Saturday at 23:59 — dom is * so every day matches
    const after = new Date("2025-01-18T23:59:00Z");
    const next = nextCronTime("0 0 * * 0", after)!;
    // dom=* → fires at next midnight = Jan 19 00:00 (Sunday in this case, but
    // dom=* means it fires next midnight regardless of dow)
    expect(next.getUTCHours()).toBe(0);
    expect(next.getUTCMinutes()).toBe(0);
    // Jan 19 2025 is a Sunday — happens to match both dom=* and dow=0
    expect(next.getUTCDate()).toBe(19);
  });
});

// ---------------------------------------------------------------------------
// ScheduleEngine — computeNextRun (via TestableScheduleEngine.computeNext)
// ---------------------------------------------------------------------------

describe("ScheduleEngine — computeNext", () => {
  test("interval schedule: next = afterEpoch + intervalMinutes * 60", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    const after = epoch();
    const next = engine.computeNext(null, 30, after);
    expect(next).toBe(after + 30 * 60);
  });

  test("interval of 0 minutes → null (invalid interval)", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    const next = engine.computeNext(null, 0, epoch());
    expect(next).toBeNull();
  });

  test("negative interval → null", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    expect(engine.computeNext(null, -5, epoch())).toBeNull();
  });

  test("cron schedule: next is a valid future epoch", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    const after = Math.floor(new Date("2025-01-15T10:00:00Z").getTime() / 1000);
    const next = engine.computeNext("0 12 * * *", null, after);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(after);
  });

  test("both null → returns null (one-shot / no repeat)", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    expect(engine.computeNext(null, null, epoch())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ScheduleEngine — upsert / getAll / delete / setEnabled
// ---------------------------------------------------------------------------

describe("ScheduleEngine — upsert", () => {
  test("upsert with interval creates a record and returns a positive ID", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    const id = engine.upsert({
      agentName: "optimizer",
      scheduleName: "daily-check",
      intervalMinutes: 60,
      prompt: "run analysis",
    });
    expect(id).toBeGreaterThan(0);
  });

  test("upserted interval schedule has correct fields", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    engine.upsert({
      agentName: "optimizer",
      scheduleName: "hourly",
      intervalMinutes: 60,
      prompt: "check status",
      maxBudgetUsd: 0.5,
      createdBy: "test",
    });
    const [rec] = engine.getAll("optimizer") as ScheduleRecord[];
    expect(rec.agent_name).toBe("optimizer");
    expect(rec.schedule_name).toBe("hourly");
    expect(rec.interval_minutes).toBe(60);
    expect(rec.max_budget_usd).toBeCloseTo(0.5, 5);
    expect(rec.created_by).toBe("test");
    expect(rec.enabled).toBe(1);
    expect(rec.run_count).toBe(0);
    expect(rec.consecutive_failures).toBe(0);
  });

  test("upsert with cron stores cron_expr", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    engine.upsert({
      agentName: "ideator",
      scheduleName: "morning",
      cronExpr: "0 9 * * *",
      prompt: "generate ideas",
    });
    const [rec] = engine.getAll("ideator") as ScheduleRecord[];
    expect(rec.cron_expr).toBe("0 9 * * *");
    expect(rec.interval_minutes).toBeNull();
  });

  test("upsert on existing (agent_name, schedule_name) updates the record (idempotent)", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    engine.upsert({ agentName: "a", scheduleName: "s", intervalMinutes: 30, prompt: "v1" });
    engine.upsert({ agentName: "a", scheduleName: "s", intervalMinutes: 60, prompt: "v2" });
    const recs = engine.getAll("a") as ScheduleRecord[];
    expect(recs.length).toBe(1);
    expect(recs[0].interval_minutes).toBe(60);
    expect(recs[0].prompt).toBe("v2");
  });

  test("re-upsert resets consecutive_failures to 0", async () => {
    const engine = new TestableScheduleEngine(db, silentLog(), failHandler());
    engine.upsert({ agentName: "a", scheduleName: "s", intervalMinutes: 1, prompt: "x" });
    engine.start();
    // Make schedule due immediately AFTER start (start() calls recomputeAllNextRuns)
    db.requireDb().prepare(
      `UPDATE agent_schedules SET next_run_at = ? WHERE agent_name = 'a'`,
    ).run(epoch(-10));
    await engine.poll(); // 1 failure
    engine.stop();

    const [before] = engine.getAll("a") as ScheduleRecord[];
    expect(before.consecutive_failures).toBe(1);

    // Re-upsert should reset failures
    engine.upsert({ agentName: "a", scheduleName: "s", intervalMinutes: 1, prompt: "y" });
    const [after] = engine.getAll("a") as ScheduleRecord[];
    expect(after.consecutive_failures).toBe(0);
  });
});

describe("ScheduleEngine — getAll", () => {
  test("getAll() with no filter returns all schedules", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    engine.upsert({ agentName: "agent-a", scheduleName: "s1", intervalMinutes: 10, prompt: "x" });
    engine.upsert({ agentName: "agent-b", scheduleName: "s2", intervalMinutes: 20, prompt: "y" });
    const all = engine.getAll();
    expect(all.length).toBe(2);
  });

  test("getAll('agent-a') returns only agent-a schedules", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    engine.upsert({ agentName: "agent-a", scheduleName: "s1", intervalMinutes: 10, prompt: "x" });
    engine.upsert({ agentName: "agent-b", scheduleName: "s2", intervalMinutes: 20, prompt: "y" });
    const forA = engine.getAll("agent-a");
    expect(forA.length).toBe(1);
    expect((forA[0] as ScheduleRecord).agent_name).toBe("agent-a");
  });

  test("getAll() on empty DB returns empty array", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    expect(engine.getAll()).toEqual([]);
  });
});

describe("ScheduleEngine — delete", () => {
  test("delete removes a schedule and returns true", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    engine.upsert({ agentName: "agt", scheduleName: "del-me", intervalMinutes: 5, prompt: "x" });
    const ok = engine.delete("agt", "del-me");
    expect(ok).toBe(true);
    expect(engine.getAll("agt")).toEqual([]);
  });

  test("delete for non-existent schedule returns false", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    expect(engine.delete("ghost", "missing")).toBe(false);
  });
});

describe("ScheduleEngine — setEnabled", () => {
  test("setEnabled(id, false) disables a schedule", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    const id = engine.upsert({ agentName: "a", scheduleName: "s", intervalMinutes: 5, prompt: "x" });
    engine.setEnabled(id, false);
    const [rec] = engine.getAll("a") as ScheduleRecord[];
    expect(rec.enabled).toBe(0);
  });

  test("setEnabled(id, true) re-enables a disabled schedule", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    const id = engine.upsert({ agentName: "a", scheduleName: "s", intervalMinutes: 5, prompt: "x" });
    engine.setEnabled(id, false);
    engine.setEnabled(id, true);
    const [rec] = engine.getAll("a") as ScheduleRecord[];
    expect(rec.enabled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ScheduleEngine — poll loop (success / failure / auto-disable)
// ---------------------------------------------------------------------------

describe("ScheduleEngine — poll: successful handler", () => {
  test("due schedule fires handler, increments run_count, resets consecutive_failures", async () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler(0.01));
    engine.upsert({ agentName: "agt", scheduleName: "run-me", intervalMinutes: 60, prompt: "go" });
    engine.start();
    // Set due AFTER start() (which calls recomputeAllNextRuns)
    db.requireDb().prepare(
      `UPDATE agent_schedules SET next_run_at = ?, consecutive_failures = 2 WHERE agent_name = 'agt'`,
    ).run(epoch(-10));
    await engine.poll();
    engine.stop();

    const [rec] = engine.getAll("agt") as ScheduleRecord[];
    expect(rec.run_count).toBe(1);
    expect(rec.consecutive_failures).toBe(0);
    expect(rec.last_run_at).not.toBeNull();
    // next_run_at should be updated (+ 60 minutes)
    expect(rec.next_run_at).toBeGreaterThan(epoch());
  });

  test("successful handler accumulates total_cost_usd", async () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler(0.05));
    engine.upsert({ agentName: "agt", scheduleName: "cost-test", intervalMinutes: 60, prompt: "go" });
    engine.start();
    db.requireDb().prepare(
      `UPDATE agent_schedules SET next_run_at = ? WHERE agent_name = 'agt'`,
    ).run(epoch(-10));
    await engine.poll();
    engine.stop();

    const [rec] = engine.getAll("agt") as ScheduleRecord[];
    expect(rec.total_cost_usd).toBeCloseTo(0.05, 5);
  });

  test("schedule not yet due does NOT fire", async () => {
    let calls = 0;
    const engine = new TestableScheduleEngine(db, silentLog(), async () => {
      calls++;
      return { success: true };
    });
    engine.upsert({ agentName: "agt", scheduleName: "future", intervalMinutes: 60, prompt: "later" });
    // next_run_at is far in the future (default set by upsert)
    engine.start();
    await engine.poll();
    engine.stop();

    expect(calls).toBe(0);
    const [rec] = engine.getAll("agt") as ScheduleRecord[];
    expect(rec.run_count).toBe(0);
  });
});

describe("ScheduleEngine — poll: failure handler", () => {
  test("1 failure → consecutive_failures=1, still enabled", async () => {
    const engine = new TestableScheduleEngine(db, silentLog(), failHandler());
    engine.upsert({ agentName: "agt", scheduleName: "fail-once", intervalMinutes: 5, prompt: "x" });
    engine.start();
    // Set due AFTER start() (which calls recomputeAllNextRuns)
    db.requireDb().prepare(
      `UPDATE agent_schedules SET next_run_at = ? WHERE agent_name = 'agt'`,
    ).run(epoch(-5));
    await engine.poll();
    engine.stop();

    const [rec] = engine.getAll("agt") as ScheduleRecord[];
    expect(rec.consecutive_failures).toBe(1);
    expect(rec.enabled).toBe(1);
    expect(rec.run_count).toBe(1); // counted even on failure
  });

  test("3 consecutive failures → auto-disable (enabled=0, next_run_at=null)", async () => {
    const engine = new TestableScheduleEngine(db, silentLog(), failHandler());
    engine.upsert({ agentName: "agt", scheduleName: "auto-dis", intervalMinutes: 5, prompt: "x" });

    // Start, then force due for each poll
    engine.start();
    for (let i = 0; i < 3; i++) {
      db.requireDb().prepare(
        `UPDATE agent_schedules SET next_run_at = ?, enabled = 1 WHERE agent_name = 'agt'`,
      ).run(epoch(-5));
      await engine.poll();
    }
    engine.stop();

    const [rec] = engine.getAll("agt") as ScheduleRecord[];
    expect(rec.consecutive_failures).toBe(3);
    expect(rec.enabled).toBe(0);
    expect(rec.next_run_at).toBeNull();
  });

  test("throwing handler is treated as failure (auto-disable after 3)", async () => {
    const engine = new TestableScheduleEngine(db, silentLog(), throwHandler());
    engine.upsert({ agentName: "agt", scheduleName: "throw-test", intervalMinutes: 5, prompt: "x" });

    engine.start();
    for (let i = 0; i < 3; i++) {
      db.requireDb().prepare(
        `UPDATE agent_schedules SET next_run_at = ?, enabled = 1 WHERE agent_name = 'agt'`,
      ).run(epoch(-5));
      await engine.poll();
    }
    engine.stop();

    const [rec] = engine.getAll("agt") as ScheduleRecord[];
    expect(rec.enabled).toBe(0);
    expect(rec.next_run_at).toBeNull();
  });
});

describe("ScheduleEngine — start/stop lifecycle", () => {
  test("start() is idempotent — calling twice doesn't create duplicate timers", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    engine.start();
    engine.start(); // second call should be a no-op
    engine.stop();
    // If we get here without error, the engine handled double-start correctly
    expect(true).toBe(true);
  });

  test("stop() after stop() does not throw", () => {
    const engine = new TestableScheduleEngine(db, silentLog(), successHandler());
    engine.start();
    engine.stop();
    expect(() => engine.stop()).not.toThrow();
  });

  test("poll after stop() does not fire handlers (running=false guard)", async () => {
    let calls = 0;
    const engine = new TestableScheduleEngine(db, silentLog(), async () => {
      calls++;
      return { success: true };
    });
    engine.upsert({ agentName: "agt", scheduleName: "stale", intervalMinutes: 5, prompt: "x" });
    db.requireDb().prepare(
      `UPDATE agent_schedules SET next_run_at = ? WHERE agent_name = 'agt'`,
    ).run(epoch(-10));
    // Do NOT start — running=false
    await engine.poll();
    expect(calls).toBe(0);
  });
});

// -- POSIX day-of-month / day-of-week semantics -----------------------------
//
// `*` was expanded into the full set, which destroyed the "is this field
// restricted?" information POSIX cron needs. `doms.has(dom) || dows.has(dow)`
// was therefore always true whenever either field was `*`, so almost every
// real expression fired daily — a weekly agent schedule burned 7x the tokens.

describe("nextCronTime — dom/dow restriction semantics", () => {
  // A Tuesday, so a Monday-only rule must skip ahead rather than match today.
  const TUE = new Date("2026-08-11T00:00:00Z");
  const dayOf = (d: Date | null) =>
    d ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] : null;

  test("dow-only restriction lands on that weekday, not tomorrow", () => {
    const d = nextCronTime("0 9 * * 1", TUE);
    expect(dayOf(d)).toBe("Mon");
    expect(d!.toISOString()).toBe("2026-08-17T09:00:00.000Z");
  });

  test("dom-only restriction lands on that date", () => {
    expect(nextCronTime("0 0 5 * *", TUE)!.getUTCDate()).toBe(5);
    expect(nextCronTime("0 9 1 * *", TUE)!.getUTCDate()).toBe(1);
  });

  test("a weekday range excludes the weekend", () => {
    // Walk a fortnight of fires; none may be Sat/Sun.
    let cur = TUE;
    for (let i = 0; i < 40; i++) {
      cur = nextCronTime("*/15 9-17 * * 1-5", cur)!;
      expect(["Sat", "Sun"]).not.toContain(dayOf(cur));
    }
  });

  test("both fields restricted is a union, per POSIX", () => {
    // 1st of the month OR any Monday.
    const d = nextCronTime("0 0 1 * 1", TUE)!;
    const isFirst = d.getUTCDate() === 1;
    const isMonday = dayOf(d) === "Mon";
    expect(isFirst || isMonday).toBe(true);
  });

  test("neither field restricted fires every day", () => {
    const d = nextCronTime("0 3 * * *", TUE)!;
    expect(d.toISOString()).toBe("2026-08-11T03:00:00.000Z");
  });

  test("dow=7 is Sunday, the common alias that used to return null", () => {
    const d = nextCronTime("0 0 * * 7", TUE);
    expect(d).not.toBeNull();
    expect(dayOf(d)).toBe("Sun");
  });

  test("dow=0 and dow=7 agree", () => {
    expect(nextCronTime("0 0 * * 0", TUE)!.toISOString())
      .toBe(nextCronTime("0 0 * * 7", TUE)!.toISOString());
  });

  test("a weekly schedule fires 7 days apart, not daily", () => {
    const first = nextCronTime("0 9 * * 1", TUE)!;
    const second = nextCronTime("0 9 * * 1", first)!;
    const days = (second.getTime() - first.getTime()) / 86_400_000;
    expect(days).toBe(7);
  });

  test("a monthly schedule does not fire again the next day", () => {
    const first = nextCronTime("0 0 5 * *", TUE)!;
    const second = nextCronTime("0 0 5 * *", first)!;
    const days = (second.getTime() - first.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
  });
});
