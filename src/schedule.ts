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
}>;

// -- Minimal cron parser (5-field: min hour dom month dow) --------------------

/**
 * Parse a 5-field cron expression and return the next fire time after `after`.
 * Supports: numbers, *, /step, ranges (1-5), lists (1,3,5).
 * Does NOT support: @yearly, @monthly, etc.
 */
function nextCronTime(expr: string, after: Date): Date | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minSpec, hourSpec, domSpec, monSpec, dowSpec] = fields;

  // Parse individual field into set of valid values
  function parseField(spec: string, min: number, max: number): Set<number> | null {
    const values = new Set<number>();
    for (const part of spec.split(",")) {
      const stepMatch = part.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
      if (stepMatch) {
        const start = stepMatch[1] === "*" ? min : parseInt(stepMatch[2], 10);
        const end = stepMatch[1] === "*" ? max : parseInt(stepMatch[3], 10);
        const step = parseInt(stepMatch[4], 10);
        if (step <= 0) return null;
        for (let i = start; i <= end; i += step) values.add(i);
        continue;
      }
      if (part === "*") {
        for (let i = min; i <= max; i++) values.add(i);
        continue;
      }
      const rangeMatch = part.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const s = parseInt(rangeMatch[1], 10);
        const e = parseInt(rangeMatch[2], 10);
        for (let i = s; i <= e; i++) values.add(i);
        continue;
      }
      const n = parseInt(part, 10);
      if (!isNaN(n) && n >= min && n <= max) {
        values.add(n);
      } else {
        return null; // invalid
      }
    }
    return values.size > 0 ? values : null;
  }

  const minutes = parseField(minSpec, 0, 59);
  const hours = parseField(hourSpec, 0, 23);
  const doms = parseField(domSpec, 1, 31);
  const months = parseField(monSpec, 1, 12);
  const dows = parseField(dowSpec, 0, 6); // 0=Sunday

  if (!minutes || !hours || !doms || !months || !dows) return null;

  // Brute-force search: iterate minute by minute from `after`, cap at 366 days
  const maxIter = 366 * 24 * 60;
  const candidate = new Date(after.getTime() + 60_000); // start 1 min after `after`
  candidate.setUTCSeconds(0, 0);

  for (let i = 0; i < maxIter; i++) {
    const m = candidate.getUTCMinutes();
    const h = candidate.getUTCHours();
    const dom = candidate.getUTCDate();
    const mon = candidate.getUTCMonth() + 1;
    const dow = candidate.getUTCDay();

    if (months.has(mon) && (doms.has(dom) || dows.has(dow)) && hours.has(h) && minutes.has(m)) {
      return candidate;
    }

    candidate.setTime(candidate.getTime() + 60_000);
  }

  return null; // no match within a year
}

// -- ScheduleEngine -----------------------------------------------------------

/** Max consecutive failures before auto-disable */
const MAX_CONSECUTIVE_FAILURES = 3;

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
    return Number(result.lastInsertRowid);
  }

  /** Delete a schedule */
  delete(agentName: string, scheduleName: string): boolean {
    const db = this.db.requireDb();
    const result = db.prepare(
      `DELETE FROM agent_schedules WHERE agent_name = ? AND schedule_name = ?`,
    ).run(agentName, scheduleName);
    return result.changes > 0;
  }

  /** Enable/disable a schedule */
  setEnabled(id: number, enabled: boolean): void {
    const db = this.db.requireDb();
    db.prepare(`UPDATE agent_schedules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
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

    for (const schedule of due) {
      if (!this.running) break;

      this.log.info(`Schedule firing: "${schedule.schedule_name}" for ${schedule.agent_name}`);

      try {
        const result = await this.handler(schedule);

        // Update schedule state
        const nextRun = this.computeNextRun(schedule.cron_expr, schedule.interval_minutes, now);
        if (result.success) {
          db.prepare(
            `UPDATE agent_schedules SET
              last_run_at = ?, next_run_at = ?,
              run_count = run_count + 1, consecutive_failures = 0,
              total_cost_usd = total_cost_usd + ?
             WHERE id = ?`,
          ).run(now, nextRun, result.costUsd ?? 0, schedule.id);
        } else {
          const newFailures = schedule.consecutive_failures + 1;
          const shouldDisable = newFailures >= MAX_CONSECUTIVE_FAILURES;
          db.prepare(
            `UPDATE agent_schedules SET
              last_run_at = ?, next_run_at = ?,
              run_count = run_count + 1, consecutive_failures = ?,
              enabled = ?, total_cost_usd = total_cost_usd + ?
             WHERE id = ?`,
          ).run(now, shouldDisable ? null : nextRun, newFailures, shouldDisable ? 0 : 1, result.costUsd ?? 0, schedule.id);

          if (shouldDisable) {
            this.log.warn(`Schedule "${schedule.schedule_name}" auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
          }
        }
      } catch (err) {
        this.log.warn(`Schedule "${schedule.schedule_name}" execution error: ${err}`);
        // Count as failure
        const newFailures = schedule.consecutive_failures + 1;
        const shouldDisable = newFailures >= MAX_CONSECUTIVE_FAILURES;
        const nextRun = this.computeNextRun(schedule.cron_expr, schedule.interval_minutes, now);
        db.prepare(
          `UPDATE agent_schedules SET
            last_run_at = ?, next_run_at = ?,
            consecutive_failures = ?, enabled = ?
           WHERE id = ?`,
        ).run(now, shouldDisable ? null : nextRun, newFailures, shouldDisable ? 0 : 1, schedule.id);
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

  /** Recompute next_run_at for all enabled schedules (called on startup) */
  private recomputeAllNextRuns(): void {
    const db = this.db.requireDb();
    const now = Math.floor(Date.now() / 1000);
    const schedules = db.prepare(
      `SELECT id, cron_expr, interval_minutes, last_run_at FROM agent_schedules WHERE enabled = 1`,
    ).all() as Array<{ id: number; cron_expr: string | null; interval_minutes: number | null; last_run_at: number | null }>;

    for (const s of schedules) {
      const basis = s.last_run_at ?? now;
      const nextRun = this.computeNextRun(s.cron_expr, s.interval_minutes, basis);
      db.prepare(`UPDATE agent_schedules SET next_run_at = ? WHERE id = ?`).run(nextRun, s.id);
    }

    this.log.debug(`Recomputed next_run_at for ${schedules.length} schedule(s)`);
  }
}
