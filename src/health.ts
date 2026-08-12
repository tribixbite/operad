/**
 * health.ts — Unified health checks for all session types
 *
 * Strategies:
 *   tmux_alive  — session exists in tmux
 *   http        — GET endpoint returns 2xx
 *   process     — process name/pattern found via pgrep
 *   custom      — shell command exits 0
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { HealthCheckConfig, HealthResult, SessionConfig, TmxConfig } from "./types.js";
import { detectPlatform } from "./platform/platform.js";
import type { Logger } from "./log.js";
import type { StateManager } from "./state.js";
import { sessionExists, isTmuxServerAlive } from "./session.js";
import { getHealthConfig } from "./config.js";
import { getRuntime } from "./runtimes/index.js";

/** Run a single health check for a session */
export function checkSessionHealth(
  sessionName: string,
  healthConfig: HealthCheckConfig,
  log: Logger,
): HealthResult {
  const start = Date.now();

  try {
    switch (healthConfig.check) {
      case "tmux_alive":
        return tmuxAliveCheck(sessionName, start);

      case "http":
        if (!healthConfig.url) {
          return { session: sessionName, healthy: false, message: "HTTP check missing 'url' config", duration_ms: Date.now() - start };
        }
        return httpCheck(sessionName, healthConfig.url, start);

      case "process":
        if (!healthConfig.process_pattern) {
          return { session: sessionName, healthy: false, message: "Process check missing 'process_pattern' config", duration_ms: Date.now() - start };
        }
        return processCheck(sessionName, healthConfig.process_pattern, start);

      case "custom":
        if (!healthConfig.command) {
          return { session: sessionName, healthy: false, message: "Custom check missing 'command' config", duration_ms: Date.now() - start };
        }
        return customCheck(sessionName, healthConfig.command, start);

      default:
        return {
          session: sessionName,
          healthy: false,
          message: `Unknown check type: ${healthConfig.check}`,
          duration_ms: Date.now() - start,
        };
    }
  } catch (err) {
    return {
      session: sessionName,
      healthy: false,
      message: `Health check error: ${err}`,
      duration_ms: Date.now() - start,
    };
  }
}

/** Check if a tmux session exists */
function tmuxAliveCheck(sessionName: string, startMs: number): HealthResult {
  const alive = sessionExists(sessionName);
  return {
    session: sessionName,
    healthy: alive,
    message: alive ? "tmux session alive" : "tmux session not found",
    duration_ms: Date.now() - startMs,
  };
}

/** HTTP health check — GET url, expect 2xx */
function httpCheck(sessionName: string, url: string, startMs: number): HealthResult {
  try {
    // Use curl for HTTP checks (universally available)
    const result = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", url], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    const code = parseInt(result.stdout?.trim() ?? "0", 10);
    const healthy = code >= 200 && code < 300;
    return {
      session: sessionName,
      healthy,
      message: healthy ? `HTTP ${code}` : `HTTP ${code} (expected 2xx)`,
      duration_ms: Date.now() - startMs,
    };
  } catch (err) {
    return {
      session: sessionName,
      healthy: false,
      message: `HTTP check failed: ${err}`,
      duration_ms: Date.now() - startMs,
    };
  }
}

/**
 * Process pattern check.
 *
 * Two caveats the caller should understand, both pre-existing:
 *
 *  • The match is machine-wide. `pgrep -f <pattern>` finds ANY process whose
 *    command line matches, not just this session's, so a loose pattern can
 *    report a dead session as healthy because something unrelated matches.
 *    Patterns are user-supplied via `process_pattern`, so this is documented
 *    rather than changed — narrowing it silently would break configs that
 *    currently work.
 *
 *  • pgrep does not exist on Windows. It previously returned status !== 0
 *    there, which reads as "not found" — a permanently unhealthy session and
 *    therefore an endless restart loop creating tmux sessions. A missing
 *    pgrep is now distinguished from a genuine miss and reported as an
 *    unusable check rather than a failure.
 */
function processCheck(sessionName: string, pattern: string, startMs: number): HealthResult {
  const result = spawnSync("pgrep", ["-f", pattern], {
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });

  // ENOENT (no pgrep) surfaces as result.error; a real miss is status 1.
  if (result.error) {
    return {
      session: sessionName,
      healthy: true, // fail open: an unusable probe must not trigger restarts
      message:
        `Process check unavailable on this platform (${(result.error as NodeJS.ErrnoException).code ?? "spawn failed"}) — `
        + `treating '${pattern}' as healthy; use check = "tmux_alive" instead`,
      duration_ms: Date.now() - startMs,
    };
  }

  const found = result.status === 0;
  return {
    session: sessionName,
    healthy: found,
    message: found ? `Process '${pattern}' found` : `Process '${pattern}' not found`,
    duration_ms: Date.now() - startMs,
  };
}

/** Custom command check — exit 0 = healthy */
function customCheck(sessionName: string, command: string, startMs: number): HealthResult {
  try {
    execSync(command, { timeout: 10_000, stdio: "ignore" });
    return {
      session: sessionName,
      healthy: true,
      message: "Custom check passed",
      duration_ms: Date.now() - startMs,
    };
  } catch {
    return {
      session: sessionName,
      healthy: false,
      message: "Custom check failed",
      duration_ms: Date.now() - startMs,
    };
  }
}

/**
 * PID-based health check for adopted (bare/non-tmux) sessions.
 *
 * Plain `kill(pid, 0)` checks "some process with this PID exists" — but PIDs
 * are recycled on busy systems, so an exited bare process whose PID was
 * picked up by an unrelated daemon would silently look "healthy". We
 * therefore also peek at `/proc/<pid>/cmdline` (when available) and require
 * a marker token to match. The marker is derived from the original
 * SessionConfig.command; we use a distinctive substring (the first word of
 * the command, falling back to the session name) so cmdline drift across
 * shell wrappers (`sh -c "termux-x11 :1 …"` → child `termux-x11 :1 …`)
 * still matches.
 *
 * `expectedCmdline` is empty/null when we have no config to compare against
 * — in that case we fall back to liveness-only, preserving prior behaviour.
 */
function pidAliveCheck(
  sessionName: string,
  pid: number,
  startMs: number,
  expectedCmdline?: string | null,
): HealthResult {
  const alive = detectPlatform().isProcessAlive(pid);
  if (!alive) {
    return {
      session: sessionName,
      healthy: false,
      message: `Process PID ${pid} not found`,
      duration_ms: Date.now() - startMs,
    };
  }

  if (expectedCmdline) {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      // /proc cmdline uses NUL separators; flatten to single string for substring match.
      const flat = raw.replace(/\0/g, " ").trim();
      if (flat && !flat.includes(expectedCmdline)) {
        return {
          session: sessionName,
          healthy: false,
          message:
            `Process PID ${pid} alive but cmdline doesn't match — ` +
            `expected '${expectedCmdline}', got '${flat.slice(0, 80)}'`,
          duration_ms: Date.now() - startMs,
        };
      }
    } catch {
      // /proc unavailable (non-Linux) — fall back to liveness-only.
    }
  }

  return {
    session: sessionName,
    healthy: true,
    message: `Process PID ${pid} alive`,
    duration_ms: Date.now() - startMs,
  };
}

/**
 * Pick a distinctive substring from a session's command for cmdline matching.
 * Strips leading shell prefixes and env assignments so we match the actual
 * binary the session was meant to spawn. Returns null when the input doesn't
 * yield a usefully-specific token (very short / generic words).
 */
export function deriveCmdlineMarker(
  sessionName: string,
  command?: string | null,
  config?: SessionConfig,
): string | null {
  // No usable command → no marker, and therefore a liveness-only check.
  //
  // This used to fall back to the SESSION NAME, which is operad's own label
  // and never appears in the process's cmdline. Adopted Claude sessions have
  // no `command` (the runtime builds it), so the check failed on every sweep:
  // healthy → degraded within two sweeps → auto-restart spawned a SECOND
  // Claude in the same project directory while the original kept running.
  // Two agents writing the same repo is far worse than a missed liveness
  // signal, so an underivable marker now means "PID liveness only".
  let source = command;
  if (!source && config) {
    // For agent runtimes the startup command is what actually exec'd, so it
    // yields the right binary name ("claude", "opencode", "codex").
    const runtime = getRuntime(config.type);
    if (runtime) {
      try { source = runtime.startupCommand(config); } catch { source = null; }
    }
  }
  if (!source) return null;
  const command2 = source;
  return deriveFromCommand(command2);
}

/** Extract the first meaningful executable token from a shell command. */
function deriveFromCommand(command: string): string | null {
  // Strip env-var assignments and leading `sh -c` so we look at what the
  // shell actually executes. Then take the first token.
  let stripped = command.replace(/^\s*sh\s+-c\s+['"]?/, "");
  stripped = stripped.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/g, "");
  // Skip obvious leading no-op preambles like `rm -f … ;` / `sleep 3 &&`.
  const preambleMatch = stripped.match(/^(?:rm\s+-f[^;&]*[;&]+|sleep\s+\d+\s*&&\s*)+/);
  if (preambleMatch) stripped = stripped.slice(preambleMatch[0].length);
  const firstToken = stripped.trim().split(/\s+/)[0] ?? "";
  if (firstToken.length >= 4 && !/^(bash|sh|exec)$/.test(firstToken)) {
    // Use the basename: a startup command may be an absolute path
    // (/data/.../bin/claude) while the running process shows just `claude`,
    // or vice versa. The basename is the part both forms share.
    const base = firstToken.split("/").pop() || firstToken;
    return base.length >= 4 ? base : firstToken;
  }
  return null;
}

/**
 * Run a single health check for a session by config.
 * Derives the appropriate HealthCheckConfig from the session config (falling back
 * to tmux_alive if no health config is specified), then delegates to checkSessionHealth.
 *
 * Currently unused — kept as a building block for future per-session health probing
 * outside the full sweep loop.
 */
export async function checkSingleSessionHealth(
  sessionName: string,
  config: SessionConfig,
): Promise<{ healthy: boolean; reason?: string }> {
  // Derive health check config: session-level override, or tmux_alive fallback
  const healthConfig: HealthCheckConfig = config.health ?? {
    check: "tmux_alive",
    unhealthy_threshold: 2,
  };
  const result = checkSessionHealth(sessionName, healthConfig, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any);
  return { healthy: result.healthy, reason: result.message };
}

/**
 * Run a full health sweep across all running/degraded sessions.
 * Updates state and returns results.
 * @param adoptedPids Map of session name → bare PID for non-tmux sessions
 */
/**
 * Continuous healthy uptime after which a session's restart_count is cleared.
 * Long enough that a restart which merely "came up" and then failed again
 * still escalates the backoff and can reach max_restarts.
 */
const RESTART_DECAY_MS = 30 * 60 * 1000;

export function runHealthSweep(
  config: TmxConfig,
  state: StateManager,
  log: Logger,
  adoptedPids?: Map<string, number>,
): HealthResult[] {
  const results: HealthResult[] = [];
  const adopted = adoptedPids ?? new Map<string, number>();

  // First, verify tmux server is alive (only affects non-adopted sessions)
  const tmuxAlive = isTmuxServerAlive();
  if (!tmuxAlive) {
    for (const session of config.sessions) {
      const s = state.getSession(session.name);
      if (!s) continue;
      // Skip adopted sessions — they don't need tmux
      if (adopted.has(session.name)) continue;
      if (s.status === "running" || s.status === "degraded" || s.status === "starting") {
        log.error(`Tmux server not running — marking '${session.name}' as failed`);
        state.transition(session.name, "failed", "Tmux server not running");
        results.push({
          session: session.name,
          healthy: false,
          message: "Tmux server not running",
          duration_ms: 0,
        });
      }
    }
  }

  for (const session of config.sessions) {
    const s = state.getSession(session.name);
    if (!s) continue;

    // Only health-check running or degraded sessions
    if (s.status !== "running" && s.status !== "degraded") continue;

    // Use PID-based check for adopted (non-tmux) sessions
    const adoptedPid = adopted.get(session.name);
    const healthConfig = getHealthConfig(session, config.health_defaults);
    let result: HealthResult;
    if (adoptedPid !== undefined) {
      // Match cmdline as well as liveness so PID reuse can't keep a
      // dead bare service looking healthy. Prefer an explicit
      // process_pattern from the session's health config: the marker
      // derived from the launch command's first token can never match a
      // service whose wrapper re-execs to a different argv0 (e.g.
      // termux-x11 → `app_process … com.termux.x11.Loader`), which would
      // otherwise wedge the service in an endless restart loop despite
      // the process being perfectly alive. Fall back to the heuristic
      // marker when no pattern is configured.
      const marker =
        healthConfig.check === "process" && healthConfig.process_pattern
          ? healthConfig.process_pattern
          : deriveCmdlineMarker(session.name, session.command, session);
      result = pidAliveCheck(session.name, adoptedPid, Date.now(), marker);
    } else if (!tmuxAlive) {
      continue; // Already handled above
    } else {
      result = checkSessionHealth(session.name, healthConfig, log);
    }
    results.push(result);

    // Record the result in state (mutates s in place)
    state.recordHealthCheck(session.name, result.healthy, result.message);

    // Re-read session state after mutation to get current consecutive_failures
    const updated = state.getSession(session.name);
    if (!updated) continue;

    if (result.healthy) {
      // If degraded and now healthy, transition back to running
      if (updated.status === "degraded") {
        state.transition(session.name, "running");
        log.info(`Session '${session.name}' recovered`, { session: session.name });
      }
      // A session that has been up and healthy for a sustained period has
      // recovered; its accumulated restart count should not follow it around
      // forever and eventually trip max_restarts on an unrelated blip.
      state.decayRestartCount(session.name, RESTART_DECAY_MS);
    } else {
      log.warn(`Health check failed for '${session.name}': ${result.message}`, {
        session: session.name,
        consecutive_failures: updated.consecutive_failures,
        threshold: healthConfig.unhealthy_threshold,
      });

      // Check if we've exceeded the unhealthy threshold
      if (updated.consecutive_failures >= healthConfig.unhealthy_threshold) {
        if (updated.status === "running") {
          state.transition(session.name, "degraded");
        } else if (updated.status === "degraded") {
          // Check if we should auto-restart or fail
          if (updated.restart_count >= session.max_restarts) {
            state.transition(session.name, "failed",
              `Exceeded max restarts (${session.max_restarts})`);
          }
          // Auto-restart is handled by the daemon's main loop
        }
      }
    }
  }

  return results;
}
