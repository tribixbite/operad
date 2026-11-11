/**
 * schedule.ts — Persistent scheduling engine for agent runs
 *
 * Replaces in-memory scheduledOodaTimer with SQLite-backed schedules that
 * survive daemon restarts. Supports both cron expressions and simple
 * interval-based scheduling. Auto-disables after consecutive failures.
 *
 * Poll-based: checks every 30s for due schedules (efficient via precomputed
 * next_run_at index). No long-lived timers to lose on restart.
 */

import type { MemoryDb } from "./memory-db.js";
import type { Logger } from "./log.js";

// -- Types --------------------------------------------------------------------

/** Schedule record from the agent_schedules table */
export interface ScheduleRecord {
  id: number;
  agent_name: string;
  schedule_name: string;
  cron_expr: string | null;
  interval_minutes: number | null;
  prompt: string;
  enabled: number;
  max_budget_usd: number | null;
  last_run_at: number | null;
  next_run_at: number | null;
  total_cost_usd: number;
  run_count: number;
  consecutive_failures: number;
  created_by: string;
  created_at: number;
}

/** Schedule creation input */
export interface ScheduleInput {
  agentName: string;
  scheduleName: string;
  /** 5-field cron expression (mutually exclusive with intervalMinutes) */
  cronExpr?: string;
  /** Simple interval in minutes (mutually exclusive with cronExpr) */
  intervalMinutes?: number;
  prompt: string;
  maxBudgetUsd?: number;
  createdBy?: string;
}

/** Callback invoked when a schedule fires */
export type ScheduleHandler = (schedule: ScheduleRecord) => Promise<{
  success: boolean;
  costUsd?: number;
  /**
   * The run did not happen for a transient reason — the SDK was attached to a
   * session, the bridge was busy, quota was exhausted. This is NOT a failure:
   * counting it as one auto-disabled the schedule after three polls, so
   * attaching to a session for 90 seconds permanently killed the user's
   * nightly job with no event and no notification.
   */
  deferred?: boolean;
}>;

// -- Minimal cron parser (5-field: min hour dom month dow) --------------------

/**
 * One comma-separated element of a cron field:
 *   `*`, `N`, `N-M`, each optionally followed by `/STEP`.
 * `N/STEP` means N..max stepping by STEP (Vixie cron extension).
 * Anchored so trailing garbage (`5x`) and empty elements are rejected —
 * the previous parseInt fallback accepted `5x` as 5 and `5/10` as 5.
 */
const CRON_PART = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;

/**
 * Parse one cron field into its set of allowed values, or null when any
 * element is malformed or out of [min, max]. Ranges must be ascending and
 * every bound is checked — `20-30` in the hour field was silently accepted
 * and simply never matched past 23.
 */
function parseCronField(spec: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const m = CRON_PART.exec(part);
    if (!m) return null;
    const [, star, startStr, endStr, stepStr] = m;
    const step = stepStr !== undefined ? parseInt(stepStr, 10) : 1;
    if (step < 1) return null;

    let start: number;
    let end: number;
    if (star) {
      start = min;
      end = max;
    } else {
      start = parseInt(startStr, 10);
      // `N` alone is a single value; `N/STEP` runs to the field max.
      end = endStr !== undefined ? parseInt(endStr, 10) : stepStr !== undefined ? max : start;
    }
    if (start < min || end > max || start > end) return null;
    for (let i = start; i <= end; i += step) values.add(i);
  }
  return values.size > 0 ? values : null;
}

/**
 * Parse a 5-field cron expression and return the next fire time after `after`.
 * Supports: numbers, *, ranges (1-5), lists (1,3,5), and /step on `*`, a
 * range or a single start value (`5/10` = 5,15,…,55).
 * Does NOT support: @yearly, @monthly, names (MON, JAN), L/W/#.
 *
 * Fields are matched in the daemon process's LOCAL time zone, as crontab(5)
 * does — `0 9 * * *` means 09:00 on the wall clock. The zone is whatever the
 * runtime resolves (the `TZ` env var, else the system zone). Note: Bun on
 * Termux does not read Android's zone setting and falls back to UTC unless
 * `TZ` is exported.
 *
 * TODO: DST edges follow the naive wall-clock walk — a time inside a
 * spring-forward gap is skipped that day, and one inside the repeated
 * fall-back hour can fire twice. Vixie cron special-cases both.
 *
 * Exported for unit testing — use ScheduleEngine for production scheduling.
 */
export function nextCronTime(expr: string, after: Date): Date | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minSpec, hourSpec, domSpec, monSpec, dowSpec] = fields;

  const minutes = parseCronField(minSpec, 0, 59);
  const hours = parseCronField(hourSpec, 0, 23);
  const doms = parseCronField(domSpec, 1, 31);
  const months = parseCronField(monSpec, 1, 12);
  const dows = parseCronField(dowSpec, 0, 7); // 0 and 7 both mean Sunday

  if (!minutes || !hours || !doms || !months || !dows) return null;

  // POSIX cron: when BOTH day-of-month and day-of-week are restricted the
  // match is a union; when only one is restricted the other is ignored.
  // Expanding `*` into the full set destroyed that distinction, so
  // `doms.has(dom) || dows.has(dow)` was always true whenever either field
  // was `*` — i.e. for almost every real expression. `0 9 * * 1` (Mondays)
  // fired every day, and a weekly agent schedule burned 7× the tokens.
  const domRestricted = domSpec.trim() !== "*";
  const dowRestricted = dowSpec.trim() !== "*";

  // Sunday as 7 must also match getDay()'s 0.
  if (dows.has(7)) dows.add(0);

  // Brute-force search: iterate minute by minute from `after`, cap at 366 days.
  // Stepping absolute time by 60s and reading local fields keeps the walk
  // monotonic across DST changes. Every zone offset in use is a whole number
  // of minutes, so zeroing local seconds is a minute boundary in UTC too.
  const maxIter = 366 * 24 * 60;
  const candidate = new Date(after.getTime() + 60_000); // start 1 min after `after`
  candidate.setSeconds(0, 0);

  for (let i = 0; i < maxIter; i++) {
    const m = candidate.getMinutes();
    const h = candidate.getHours();
    const dom = candidate.getDate();
    const mon = candidate.getMonth() + 1;
    const dow = candidate.getDay();

    const dayMatches =
      domRestricted && dowRestricted
        ? doms.has(dom) || dows.has(dow)   // both restricted → union
        : domRestricted
          ? doms.has(dom)                  // only dom restricted → dow ignored
          : dowRestricted
            ? dows.has(dow)                // only dow restricted → dom ignored
            : true;                        // neither restricted → every day

    if (months.has(mon) && dayMatches && hours.has(h) && minutes.has(m)) {
      return candidate;
    }

    candidate.setTime(candidate.getTime() + 60_000);
  }

  return null; // no match within a year
}

// -- ScheduleEngine -----------------------------------------------------------

/** Max consecutive failures before auto-disable */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Seconds before a deferred run is retried (capped at its natural next slot) */
const DEFER_RETRY_SEC = 60;

/**
 * ScheduleEngine — persistent schedule polling and execution.
 * Call start() after daemon init, stop() on shutdown.
 */
export class ScheduleEngine {
  private db: MemoryDb;
  private log: Logger;
  private handler: ScheduleHandler;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /**
   * Schedules with a handler currently in flight.
   *
   * The poll awaited the handler — an SDK agent run, often minutes — before
   * writing next_run_at, so the next 30s tick saw the same row still due and
   * fired it again, and again. Tracking in-flight ids per schedule keeps one
   * long run from being re-entered while still letting other schedules fire.
   */
  private inFlight = new Set<number>();

  constructor(db: MemoryDb, log: Logger, handler: ScheduleHandler) {
    this.db = db;
    this.log = log;
    this.handler = handler;
  }

  /** Start polling for due schedules every 30s */
  start(): void {
    if (this.pollTimer) return;
    this.running = true;
    // Recompute next_run_at for all enabled schedules on startup (survives restart)
    this.recomputeAllNextRuns();
    this.pollTimer = setInterval(() => {
      this.pollDueSchedules().catch((err) => {
        this.log.warn(`Schedule poll error: ${err}`);
      });
    }, 30_000);
    this.log.info("Schedule engine started (30s poll interval)");
  }

  /** Stop polling */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.log.info("Schedule engine stopped");
  }

  /** Create or update a persistent schedule */
  upsert(input: ScheduleInput): number {
    const db = this.db.requireDb();
    const now = Math.floor(Date.now() / 1000);
    const nextRun = this.computeNextRun(input.cronExpr ?? null, input.intervalMinutes ?? null, now);

    // Upsert using UNIQUE(agent_name, schedule_name)
    const result = db.prepare(
      `INSERT INTO agent_schedules (agent_name, schedule_name, cron_expr, interval_minutes, prompt, max_budget_usd, next_run_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_name, schedule_name) DO UPDATE SET
         cron_expr = excluded.cron_expr,
         interval_minutes = excluded.interval_minutes,
         prompt = excluded.prompt,
         max_budget_usd = excluded.max_budget_usd,
         next_run_at = excluded.next_run_at,
         enabled = 1,
         consecutive_failures = 0`,
    ).run(
      input.agentName, input.scheduleName,
      input.cronExpr ?? null, input.intervalMinutes ?? null,
      input.prompt, input.maxBudgetUsd ?? null,
      nextRun, input.createdBy ?? "agent",
    );

    this.log.info(`Schedule "${input.scheduleName}" for ${input.agentName}: next run at ${nextRun ? new Date(nextRun * 1000).toISOString() : "none"}`);

    // On the ON CONFLICT … DO UPDATE branch SQLite reports the connection's
    // last *insert* rowid, which belongs to some other row entirely. Callers
    // returned that as the schedule id, so the dashboard then PATCHed — and
    // disabled — the wrong schedule. Read the real id back instead.
    const row = db.prepare(
      `SELECT id FROM agent_schedules WHERE agent_name = ? AND schedule_name = ?`,
    ).get(input.agentName, input.scheduleName) as { id: number } | undefined;
    return row ? row.id : Number(result.lastInsertRowid);
  }

  /** Delete a schedule */
  delete(agentName: string, scheduleName: string): boolean {
    const db = this.db.requireDb();
    const result = db.prepare(
      `DELETE FROM agent_schedules WHERE agent_name = ? AND schedule_name = ?`,
    ).run(agentName, scheduleName);
    return result.changes > 0;
  }

  /**
   * Enable/disable a schedule.
   *
   * Auto-disable writes next_run_at = NULL and the poll only selects rows with
   * a non-null next_run_at, so flipping `enabled` alone left a re-enabled
   * schedule dormant until the next daemon restart. Enabling a schedule that
   * was disabled (or has no next run) therefore re-arms it from now and clears
   * the failure streak that disabled it. An already-enabled, armed schedule
   * is left untouched so a redundant enable cannot push its next run out.
   */
  setEnabled(id: number, enabled: boolean): void {
    const db = this.db.requireDb();
    if (!enabled) {
      db.prepare(`UPDATE agent_schedules SET enabled = 0 WHERE id = ?`).run(id);
      return;
    }
    const row = db.prepare(
      `SELECT enabled, next_run_at, cron_expr, interval_minutes FROM agent_schedules WHERE id = ?`,
    ).get(id) as Pick<ScheduleRecord, "enabled" | "next_run_at" | "cron_expr" | "interval_minutes"> | null | undefined;
    if (!row) return;
    if (row.enabled === 1 && row.next_run_at !== null) return;
    const nextRun = this.computeNextRun(row.cron_expr, row.interval_minutes, Math.floor(Date.now() / 1000));
    db.prepare(
      `UPDATE agent_schedules SET enabled = 1, consecutive_failures = 0, next_run_at = ? WHERE id = ?`,
    ).run(nextRun, id);
  }

  /** Get all schedules (optionally filtered by agent) */
  getAll(agentName?: string): ScheduleRecord[] {
    const db = this.db.requireDb();
    if (agentName) {
      return db.prepare(
        `SELECT * FROM agent_schedules WHERE agent_name = ? ORDER BY next_run_at`,
      ).all(agentName) as unknown as ScheduleRecord[];
    }
    return db.prepare(`SELECT * FROM agent_schedules ORDER BY next_run_at`).all() as unknown as ScheduleRecord[];
  }

  /** Poll for and execute due schedules */
  private async pollDueSchedules(): Promise<void> {
    if (!this.running) return;

    const db = this.db.requireDb();
    const now = Math.floor(Date.now() / 1000);

    // Find all enabled schedules where next_run_at <= now
    const due = db.prepare(
      `SELECT * FROM agent_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
    ).all(now) as unknown as ScheduleRecord[];

    // Re-reads a row and keeps it only if it is still enabled and due.
    const stillDue = db.prepare(
      `SELECT * FROM agent_schedules WHERE id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
    );

    for (const snapshot of due) {
      if (!this.running) break;
      if (this.inFlight.has(snapshot.id)) {
        this.log.debug(`Schedule "${snapshot.schedule_name}" still running — not re-entering`);
        continue;
      }
      // `due` was read before earlier iterations awaited their handlers —
      // possibly minutes ago. An overlapping poll may have fired (or deferred)
      // this schedule meanwhile, or it was disabled/edited. Firing from the
      // stale snapshot ran it twice and wrote a stale consecutive_failures.
      // bun:sqlite's .get() yields null when no row matches.
      const schedule = stillDue.get(snapshot.id, Math.floor(Date.now() / 1000)) as unknown as ScheduleRecord | null | undefined;
      if (!schedule) continue;

      this.log.info(`Schedule firing: "${schedule.schedule_name}" for ${schedule.agent_name}`);

      this.inFlight.add(schedule.id);
      try {
        const result = await this.handler(schedule);

        // Schedule from a FRESH clock, not the one captured before the handler
        // ran. A run lasting longer than the interval otherwise produced a
        // next_run_at already in the past, so the very next tick refired it.
        const doneAt = Math.floor(Date.now() / 1000);
        const nextRun = this.computeNextRun(schedule.cron_expr, schedule.interval_minutes, doneAt);

        if (result.deferred) {
          // Transient: retry soon, do not touch the failure counter, and do
          // not bump run_count — nothing ran. Rescheduling a full cycle out
          // meant one deferral (a session attached at 02:00) skipped the
          // whole night; retry after DEFER_RETRY_SEC instead, but never later
          // than the schedule's own next slot.
          const retryAt = doneAt + DEFER_RETRY_SEC;
          const attemptAt = nextRun === null ? retryAt : Math.min(retryAt, nextRun);
          db.prepare(
            `UPDATE agent_schedules SET next_run_at = ? WHERE id = ?`,
          ).run(attemptAt, schedule.id);
          this.log.debug(`Schedule "${schedule.schedule_name}" deferred; next attempt at ${attemptAt}`);
        } else if (result.success) {
          db.prepare(
            `UPDATE agent_schedules SET
              last_run_at = ?, next_run_at = ?,
              run_count = run_count + 1, consecutive_failures = 0,
              total_cost_usd = total_cost_usd + ?
             WHERE id = ?`,
          ).run(doneAt, nextRun, result.costUsd ?? 0, schedule.id);
        } else {
          const newFailures = schedule.consecutive_failures + 1;
          const shouldDisable = newFailures >= MAX_CONSECUTIVE_FAILURES;
          db.prepare(
            `UPDATE agent_schedules SET
              last_run_at = ?, next_run_at = ?,
              run_count = run_count + 1, consecutive_failures = ?,
              enabled = ?, total_cost_usd = total_cost_usd + ?
             WHERE id = ?`,
          ).run(doneAt, shouldDisable ? null : nextRun, newFailures, shouldDisable ? 0 : 1, result.costUsd ?? 0, schedule.id);

          if (shouldDisable) {
            this.log.warn(`Schedule "${schedule.schedule_name}" auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
          }
        }
      } catch (err) {
        this.log.warn(`Schedule "${schedule.schedule_name}" execution error: ${err}`);
        // Count as failure. run_count is bumped here too so the accounting
        // matches the success:false branch, which it previously did not.
        const doneAt = Math.floor(Date.now() / 1000);
        const newFailures = schedule.consecutive_failures + 1;
        const shouldDisable = newFailures >= MAX_CONSECUTIVE_FAILURES;
        const nextRun = this.computeNextRun(schedule.cron_expr, schedule.interval_minutes, doneAt);
        db.prepare(
          `UPDATE agent_schedules SET
            last_run_at = ?, next_run_at = ?,
            run_count = run_count + 1,
            consecutive_failures = ?, enabled = ?
           WHERE id = ?`,
        ).run(doneAt, shouldDisable ? null : nextRun, newFailures, shouldDisable ? 0 : 1, schedule.id);
      } finally {
        this.inFlight.delete(schedule.id);
      }
    }
  }

  /** Compute next_run_at epoch from cron or interval */
  private computeNextRun(cronExpr: string | null, intervalMinutes: number | null, afterEpoch: number): number | null {
    const after = new Date(afterEpoch * 1000);

    if (cronExpr) {
      const next = nextCronTime(cronExpr, after);
      return next ? Math.floor(next.getTime() / 1000) : null;
    }

    if (intervalMinutes && intervalMinutes > 0) {
      return afterEpoch + intervalMinutes * 60;
    }

    return null; // one-shot schedule (no repeat)
  }

  /**
   * Fill in next_run_at for enabled schedules that have none (called on
   * startup).
   *
   * A pending next_run_at is the schedule's own state and is kept. This used
   * to recompute every row from `last_run_at ?? now`, so a never-run interval
   * schedule was pushed a full interval out on each restart — a daemon that
   * restarts more often than the interval starved it forever. A next_run_at
   * already in the past simply fires once on the first poll (catch-up).
   */
  private recomputeAllNextRuns(): void {
    const db = this.db.requireDb();
    const now = Math.floor(Date.now() / 1000);
    const schedules = db.prepare(
      `SELECT id, cron_expr, interval_minutes, last_run_at FROM agent_schedules
        WHERE enabled = 1 AND next_run_at IS NULL`,
    ).all() as Array<{ id: number; cron_expr: string | null; interval_minutes: number | null; last_run_at: number | null }>;

    for (const s of schedules) {
      const basis = s.last_run_at ?? now;
      const nextRun = this.computeNextRun(s.cron_expr, s.interval_minutes, basis);
      db.prepare(`UPDATE agent_schedules SET next_run_at = ? WHERE id = ?`).run(nextRun, s.id);
    }

    this.log.debug(`Recomputed next_run_at for ${schedules.length} schedule(s)`);
  }
}
