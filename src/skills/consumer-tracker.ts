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
}

export class ConsumerTracker {
  private refs = new Map<string, ActiveRef>();
  private nextSerial = 0;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

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
   * Acquire a pin. Returns a release function the caller MUST invoke
   * (typically in `finally`). The returned function is idempotent.
   */
  acquire(kind: ConsumerKind, refId?: string): () => void {
    const id = refId ?? `${kind}:${this.nextSerial++}`;
    const key = `${kind}:${id}`;
    this.refs.set(key, { kind, ref_id: id, acquired_at: Date.now() });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs.delete(key);
    };
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
