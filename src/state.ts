/**
 * state.ts — JSON state file R/W and session state transitions
 *
 * Persists restart counts, uptime timestamps, and error messages to disk.
 * For actual running status, always trust `tmux list-sessions` over persisted state.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionState, SessionStatus, SystemMemorySnapshot, BatterySnapshot, TmxState, SessionConfig } from "./types.js";
import { VALID_TRANSITIONS } from "./types.js";
import type { Logger } from "./log.js";

/**
 * Migrate persisted state to the current schema version.
 * Returns the mutated state and an optional user-visible notice string.
 * Safe to call on every boot — no-op when already at current version.
 */
export function migrateState(state: any): { state: any; notice: string | null } {
  const version: number = state.schemaVersion ?? 1;
  if (version < 2) {
    state.schemaVersion = 2;
    return {
      state,
      notice: [
        "operad v0.4.0: cognitive/OODA/mindMeld defaults changed to opt-in for fresh installs.",
        "Your existing settings are preserved.",
        "To apply new opt-in defaults explicitly: operad switchboard reset",
      ].join("\n"),
    };
  }
  return { state, notice: null };
}

/** Create a fresh session state entry */
export function newSessionState(name: string): SessionState {
  return {
    name,
    status: "pending",
    uptime_start: null,
    restart_count: 0,
    last_error: null,
    last_health_check: null,
    consecutive_failures: 0,
    tmux_pid: null,
    rss_mb: null,
    activity: null,
    suspended: false,
    auto_suspended: false,
    last_output: null,
    claude_status: null,
    bound_jsonl_id: null,
  };
}

/** Create a fresh daemon state */
export function newDaemonState(): TmxState {
  return {
    daemon_start: new Date().toISOString(),
    boot_complete: false,
    adb_fixed: false,
    sessions: {},
  };
}

export class StateManager {
  private state: TmxState;
  private statePath: string;
  private log: Logger;

  constructor(statePath: string, log: Logger) {
    this.statePath = statePath;
    this.log = log;

    // Ensure parent directory exists
    const dir = dirname(statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Load existing state or create fresh
    this.state = this.loadFromDisk();
  }

  /** Get the full state snapshot */
  getState(): TmxState {
    return this.state;
  }

  /** Get state for a specific session */
  getSession(name: string): SessionState | undefined {
    return this.state.sessions[name];
  }

  /** Initialize session states from config, preserving existing entries */
  initFromConfig(sessions: SessionConfig[]): void {
    for (const session of sessions) {
      if (!this.state.sessions[session.name]) {
        this.state.sessions[session.name] = newSessionState(session.name);
      }
    }
    // Remove state entries for sessions no longer in config
    for (const name of Object.keys(this.state.sessions)) {
      if (!sessions.find((s) => s.name === name)) {
        this.log.info(`Removing stale state for session '${name}'`, { session: name });
        delete this.state.sessions[name];
      }
    }
    this.persist();
  }

  /** Remove a session from state entirely */
  removeSession(name: string): void {
    if (this.state.sessions[name]) {
      delete this.state.sessions[name];
      this.persist();
    }
  }

  /** Transition a session to a new status with validation */
  transition(name: string, to: SessionStatus, error?: string): boolean {
    const session = this.state.sessions[name];
    if (!session) {
      this.log.error(`Cannot transition unknown session '${name}'`, { session: name });
      return false;
    }

    const from = session.status;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed?.includes(to)) {
      this.log.warn(`Invalid transition ${from} → ${to} for '${name}'`, { session: name });
      return false;
    }

    session.status = to;

    // Track state-specific metadata
    switch (to) {
      case "running":
        session.uptime_start = new Date().toISOString();
        session.consecutive_failures = 0;
        session.last_error = null;
        break;
      case "starting":
        // Increment restart count if coming from degraded (auto-restart)
        if (from === "degraded") {
          session.restart_count++;
        }
        break;
      case "failed":
        session.last_error = error ?? "Unknown failure";
        session.uptime_start = null;
        break;
      case "stopped":
        session.uptime_start = null;
        break;
      case "pending":
        // Reset restart count on manual start
        session.restart_count = 0;
        session.consecutive_failures = 0;
        session.last_error = null;
        break;
    }

    this.log.info(`${name}: ${from} → ${to}${error ? ` (${error})` : ""}`, { session: name });
    this.persist();
    return true;
  }

  /** Record a health check result */
  /**
   * Reset `restart_count` for a session that has been up long enough to count
   * as recovered. Returns true if it changed.
   *
   * The counter was only reset on a transition to `pending` (a manual start),
   * so it accumulated for the daemon's lifetime: a session that flapped and
   * fully recovered three times over a month was then permanently `failed` on
   * the next blip. It cannot simply be cleared on reaching `running` either —
   * the auto-restart path goes degraded → starting → running, so that would
   * stop the backoff escalating and make max_restarts unreachable. Sustained
   * healthy uptime is the signal that the restart actually worked.
   */
  decayRestartCount(name: string, minUptimeMs: number): boolean {
    const session = this.state.sessions[name];
    if (!session || session.status !== "running") return false;
    if (session.restart_count === 0) return false;
    if (!session.uptime_start) return false;
    const upMs = Date.now() - new Date(session.uptime_start).getTime();
    if (!Number.isFinite(upMs) || upMs < minUptimeMs) return false;
    session.restart_count = 0;
    this.log.info(
      `${name}: stable for ${Math.round(upMs / 60000)}min — restart count reset`,
      { session: name },
    );
    this.persist();
    return true;
  }

  recordHealthCheck(name: string, healthy: boolean, message?: string): void {
    const session = this.state.sessions[name];
    if (!session) return;

    session.last_health_check = new Date().toISOString();

    if (healthy) {
      session.consecutive_failures = 0;
    } else {
      session.consecutive_failures++;
      session.last_error = message ?? "Health check failed";
    }

    this.persist();
  }

  /** Mark the boot sequence as complete */
  setBootComplete(complete: boolean): void {
    this.state.boot_complete = complete;
    this.persist();
  }

  /** Mark ADB fix status */
  setAdbFixed(fixed: boolean): void {
    this.state.adb_fixed = fixed;
    this.persist();
  }

  /** Update daemon start time (e.g., on daemon restart) */
  resetDaemonStart(): void {
    this.state.daemon_start = new Date().toISOString();
    this.persist();
  }

  /** Set tmux PID for a session */
  setTmuxPid(name: string, pid: number | null): void {
    const session = this.state.sessions[name];
    if (session) {
      session.tmux_pid = pid;
      this.persist();
    }
  }

  /** Update memory/activity metrics for a session (does not persist — transient data) */
  updateSessionMetrics(
    name: string,
    rss_mb: number | null,
    activity: SessionState["activity"],
    lastOutput?: string | null,
    claudeStatus?: SessionState["claude_status"],
  ): void {
    const session = this.state.sessions[name];
    if (session) {
      session.rss_mb = rss_mb;
      session.activity = activity;
      if (lastOutput !== undefined) session.last_output = lastOutput;
      if (claudeStatus !== undefined) session.claude_status = claudeStatus;
      // Don't persist — these are ephemeral metrics updated every poll cycle
    }
  }

  /** Update system memory snapshot (transient, not persisted) */
  updateSystemMemory(memory: SystemMemorySnapshot | null): void {
    this.state.memory = memory;
  }

  /** Update battery snapshot (transient, not persisted) */
  updateBattery(battery: BatterySnapshot | null): void {
    this.state.battery = battery;
  }

  /** Mark a session as suspended (SIGSTOP'd) */
  setSuspended(name: string, suspended: boolean, auto = false): void {
    const session = this.state.sessions[name];
    if (!session) return;
    session.suspended = suspended;
    if (auto) session.auto_suspended = suspended;
    if (!suspended) session.auto_suspended = false;
    this.persist();
  }

  /** Force-set a session's status (for adoption/reconciliation) */
  forceStatus(name: string, status: SessionStatus): void {
    const session = this.state.sessions[name];
    if (!session) return;
    session.status = status;
    this.persist();
  }

  // -- Persistence ------------------------------------------------------------

  /**
   * Move an unreadable state file aside before it is overwritten.
   *
   * A parse or shape failure used to log one warning and return a fresh
   * state, and the very next persist() — milliseconds later, via
   * initFromConfig() — wrote over the original. Restart counts, autostart
   * pins and bound_jsonl_id vanished along with any chance of working out
   * why. Writes here are atomic (temp + rename), so a corrupt file always
   * came from outside operad, which is exactly when the evidence is worth
   * keeping. Only the most recent corruption is retained; a repeating
   * failure must not fill the disk with copies.
   */
  private quarantineStateFile(reason: string): void {
    const backup = `${this.statePath}.corrupt`;
    try {
      copyFileSync(this.statePath, backup);
      this.log.warn(`Corrupt state file saved to ${backup} (${reason})`);
    } catch (err) {
      this.log.warn(`Could not preserve corrupt state file: ${err}`);
    }
  }

  private loadFromDisk(): TmxState {
    try {
      if (existsSync(this.statePath)) {
        const content = readFileSync(this.statePath, "utf-8");
        const parsed = JSON.parse(content);
        // Validate top-level shape
        if (!parsed || typeof parsed !== "object" || !parsed.daemon_start || !parsed.sessions || typeof parsed.sessions !== "object") {
          this.log.warn("State file has invalid shape, starting fresh");
          this.quarantineStateFile("invalid shape");
          return newDaemonState();
        }
        // Validate each session entry — drop malformed entries instead of crashing
        const validSessions: Record<string, SessionState> = {};
        for (const [name, raw] of Object.entries(parsed.sessions)) {
          const s = raw as Record<string, unknown>;
          if (s && typeof s === "object" && typeof s.status === "string" && typeof s.name === "string") {
            // Ensure numeric fields are actually numbers
            if (typeof s.restart_count !== "number") s.restart_count = 0;
            if (typeof s.consecutive_failures !== "number") s.consecutive_failures = 0;
            validSessions[name] = s as unknown as SessionState;
          } else {
            this.log.warn(`Dropping malformed session state for '${name}'`);
          }
        }
        parsed.sessions = validSessions;
        return parsed as TmxState;
      }
    } catch (err) {
      this.log.warn(`Failed to load state from ${this.statePath}, starting fresh`, {
        error: String(err),
      });
      if (existsSync(this.statePath)) this.quarantineStateFile(String(err));
    }
    return newDaemonState();
  }

  /**
   * Bind (or clear, with null) the Claude conversation JSONL a session is
   * tracking. Set by the live-JSONL binder when 2+ sessions share a project
   * path. Persisted so the binding survives daemon restarts; a no-op when
   * the value is unchanged to avoid needless writes from the poll loop.
   */
  setBoundJsonl(name: string, jsonlId: string | null): void {
    const s = this.state.sessions[name];
    if (!s || s.bound_jsonl_id === jsonlId) return;
    s.bound_jsonl_id = jsonlId;
    this.persist();
  }

  // -- Autostart pins ---------------------------------------------------------

  /** All persisted autostart overrides (name → forced enabled flag). */
  getAutostartOverrides(): Record<string, boolean> {
    return this.state.autostart_overrides ?? {};
  }

  /**
   * Pin (or unpin) a session for autostart. Persisted so the user's ⭐
   * choice survives daemon restarts; applied over the boot-resolved
   * `enabled` flag on the next boot and immediately by the caller.
   */
  setAutostartOverride(name: string, enabled: boolean): void {
    if (!this.state.autostart_overrides) this.state.autostart_overrides = {};
    this.state.autostart_overrides[name] = enabled;
    this.persist();
  }

  /** Drop a session's autostart override (e.g. when it's removed). */
  clearAutostartOverride(name: string): void {
    if (this.state.autostart_overrides && name in this.state.autostart_overrides) {
      delete this.state.autostart_overrides[name];
      this.persist();
    }
  }

  /** Flush state to disk immediately (public wrapper for persist) */
  flush(): void {
    this.persist();
  }

  /** Write state to disk atomically (write to .tmp then rename) */
  private persist(): void {
    try {
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n");
      renameSync(tmp, this.statePath);
    } catch (err) {
      this.log.error(`Failed to persist state: ${err}`);
    }
  }
}
