/**
 * skills/consumer-tracker.ts — Process-local registry of active tool
 * consumers across the daemon's five caller kinds.
 *
 * Spec §3.7 + §7.3. Phase A0 only blocked installs while a workflow
 * run was active; round-4 review correctly pointed out that single-
 * shot REST / IPC / OODA / scheduled-run tool callers would silently
 * race the install with the same outcome the gate claimed to prevent.
 *
 * The tracker is daemon-process-local (no persistence) because:
 *   • all five caller kinds run in the same process
 *   • a daemon crash naturally clears in-flight work along with the
 *     pin set, so we don't want survivors holding stale references
 *
 * Acquire / release contract per caller (from spec §3.7):
 *   • WorkflowEngine.run() — wraps the run; refs survive across nodes
 *   • AgentEngine OODA cycle — wraps each tick
 *   • REST handlers that call ToolExecutor — wrap the request
 *   • IPC handlers that call ToolExecutor — wrap the command
 *   • ScheduleEngine fire — wraps the handler invocation
 *
 * Callers MUST release in a finally block; a leaked acquisition will
 * permanently block installs until daemon restart. The tracker emits a
 * structured log line if a ref is held longer than 5 minutes.
 */

import type { Logger } from "../log.js";
import type { MemoryDb } from "../memory-db.js";

export type ConsumerKind =
  | "workflow_run"
  | "agent_cycle"
  | "rest_request"
  | "ipc_call"
  | "scheduled_run";

interface ActiveRef {
  kind: ConsumerKind;
  ref_id: string;
  acquired_at: number;
  generation: number;
}

/**
 * Phase C pin handle. acquire() now returns this object instead of a
 * bare release function so callers can read the snapshotted
 * `generation` and pass it to ToolExecutor.execute / agent dispatch.
 *
 * Release is still idempotent — the handle stays valid (no-op) once
 * released, matching the round-2-reviewer-validated finally-block
 * pattern.
 */
export interface PinHandle {
  generation: number;
  release: () => void;
}

export class ConsumerTracker {
  private refs = new Map<string, ActiveRef>();
  private nextSerial = 0;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Optional generation supplier — when present, acquire() snapshots
   * the current generation at pin time. The Daemon wires this to
   * `() => toolExecutor.getCurrentGeneration()` so Phase C lookups
   * route through the snapshot. Tests can omit it (defaults to gen 0).
   */
  private genSupplier: () => number = () => 0;
  /** Optional db handle for persisting pin → generation refs. */
  private db: MemoryDb | null = null;

  constructor(private log: Logger | null = null) {
    // Periodic stale-pin warning. Disabled in tests by passing log=null.
    if (this.log) {
      this.staleCheckTimer = setInterval(() => this.warnStale(), 60_000);
      // Don't keep the process alive solely for this timer.
      if (typeof (this.staleCheckTimer as any).unref === "function") {
        (this.staleCheckTimer as any).unref();
      }
    }
  }

  /**
   * Wire the live-generation supplier + persistent store. Called by
   * the Daemon after ToolExecutor + MemoryDb are constructed.
   * Optional — without it, the tracker still works in-process but
   * pins don't persist to skill_generation_refs and never snapshot a
   * meaningful generation.
   */
  bindGeneration(genSupplier: () => number, db: MemoryDb | null = null): void {
    this.genSupplier = genSupplier;
    this.db = db;
  }

  /**
   * Acquire a pin. Returns a PinHandle whose `generation` field carries
   * the snapshotted ToolExecutor generation — pass this to
   * `ToolExecutor.execute(..., gen)` so a concurrent skill install
   * doesn't tear the registry under your run.
   *
   * Callers MUST invoke `.release()` in a finally block. The release
   * function is idempotent; leaked pins fire a 5-minute stale-pin
   * warning (see warnStale).
   */
  acquire(kind: ConsumerKind, refId?: string): PinHandle {
    const id = refId ?? `${kind}:${this.nextSerial++}`;
    const key = `${kind}:${id}`;
    const generation = this.genSupplier();
    const acquired_at = Date.now();
    this.refs.set(key, { kind, ref_id: id, acquired_at, generation });

    // Persist to skill_generation_refs so the GC pass-2 SQL gate
    // (skills/gc.ts runPass2) sees this pin even after daemon
    // restart — long workflow runs survive restarts.
    if (this.db) {
      try {
        this.db.requireDb().prepare(
          `INSERT INTO skill_generation_refs
             (generation, ref_kind, ref_id, acquired_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(generation, ref_kind, ref_id) DO NOTHING`,
        ).run(generation, kind, id, Math.floor(acquired_at / 1000));
      } catch (err) {
        // DB write failure is non-fatal; in-process Map still tracks.
        this.log?.warn(`ConsumerTracker DB persist failed: ${(err as Error).message}`);
      }
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.refs.delete(key);
      if (this.db) {
        try {
          this.db.requireDb().prepare(
            `DELETE FROM skill_generation_refs
              WHERE generation = ? AND ref_kind = ? AND ref_id = ?`,
          ).run(generation, kind, id);
        } catch (err) {
          this.log?.warn(`ConsumerTracker DB release failed: ${(err as Error).message}`);
        }
      }
    };
    return { generation, release };
  }

  /** Snapshot of currently-held pins. Empty array means safe to install. */
  list(): Array<{ kind: ConsumerKind; ref_id: string }> {
    return Array.from(this.refs.values()).map((r) => ({
      kind: r.kind,
      ref_id: r.ref_id,
    }));
  }

  /** Count of active pins. */
  size(): number {
    return this.refs.size;
  }

  /** Stop the stale-check timer. Call on daemon shutdown. */
  shutdown(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
  }

  private warnStale(): void {
    if (!this.log) return;
    const now = Date.now();
    for (const ref of this.refs.values()) {
      const age = now - ref.acquired_at;
      if (age > 5 * 60_000) {
        this.log.warn(
          `Consumer pin held > ${Math.round(age / 1000)}s: kind=${ref.kind} ref_id=${ref.ref_id}. Possible leak — installs will be blocked until released.`,
        );
      }
    }
  }
}
