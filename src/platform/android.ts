/**
 * android.ts — Android/Termux platform implementation
 *
 * Implements the Platform interface for Termux running on Android.
 * All methods use battle-tested patterns from the original daemon.ts,
 * session.ts, battery.ts, wake.ts, and budget.ts inline code.
 *
 * Key Android/Termux gotchas handled here:
 * - Bun's glibc-runner strips LD_PRELOAD → must re-inject for am/termux-api commands
 * - Bun's spawnSync can't resolve $PREFIX/bin binaries via PATH symlinks
 * - termux-notification can hang indefinitely → spawn detached with hard kill timeout
 * - process.argv[0] under bun resolves to raw buno binary (invalid ELF on Android)
 * - libtermux-exec.so vs libtermux-exec-ld-preload.so: different interceptors for
 *   different use cases (env rewriting vs app_process interception)
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform, PlatformId, SystemMemoryInfo, BatteryInfo } from "./platform.js";
import {
  readProcMeminfo,
  readProcStatCpuTicks,
  buildProcTree,
  isProcAlive,
  readProcCwd,
  hasProcAncestorComm,
  resolveLocalIpViaRoute,
} from "./common.js";

// -- Constants ----------------------------------------------------------------

/** Termux prefix directory — contains bin/, lib/, tmp/, etc. */
const PREFIX = process.env.PREFIX ?? "/data/data/com.termux/files/usr";

/** User home directory */
const HOME = process.env.HOME ?? "/data/data/com.termux/files/home";

/**
 * libtermux-exec.so — the general-purpose exec interceptor.
 * Rewrites /usr/bin/env → $PREFIX/bin/env and similar shebang paths.
 * Used by most Termux:API commands and tmux child processes.
 */
const TERMUX_LD_PRELOAD = join(PREFIX, "lib", "libtermux-exec.so");

/**
 * libtermux-exec-ld-preload.so — the LD_PRELOAD-specific interceptor.
 * Required specifically for am/app_process commands. Without it,
 * `am` silently succeeds (exit 0) but does nothing.
 */
const TERMUX_AM_LD_PRELOAD = join(PREFIX, "lib", "libtermux-exec-ld-preload.so");

// -- Internal helpers ---------------------------------------------------------

/**
 * Resolve full path for a Termux binary.
 * Bun's spawnSync can't find $PREFIX/bin binaries via PATH symlink chains,
 * so we check the candidate path directly before falling back to bare name.
 */
function resolveTermuxBin(name: string): string {
  const candidate = join(PREFIX, "bin", name);
  try {
    if (existsSync(candidate)) return candidate;
  } catch { /* fall through */ }
  return name;
}

/**
 * Environment for Termux:API commands (termux-battery-status, termux-notification, etc.).
 * Bun's glibc-runner strips LD_PRELOAD, but the Termux exec interceptor
 * is required for the underlying am/app_process calls to work.
 */
function termuxApiEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LD_PRELOAD: TERMUX_LD_PRELOAD };
}

/**
 * Build the wrapper-script body that {@link AndroidPlatform.runScriptInTab}
 * writes to `$PREFIX/tmp` before launching it via the TermuxService execute
 * intent. Pure (no IO) so it can be unit-tested.
 *
 * The wrapper sets the terminal title, ensures `libtermux-exec.so` is
 * preloaded, cd's to the project dir, and exec's the target script.
 *
 * The LD_PRELOAD handling is the important part: the TermuxService execute
 * intent runs the wrapper WITHOUT Termux's default `LD_PRELOAD`, so any script
 * (or its children) that exec's a binary with a `#!/usr/bin/env …` shebang —
 * e.g. gradle's `./gradlew` — fails with `/usr/bin/env: bad interpreter: No
 * such file or directory` (exit 126); the Android kernel can't resolve
 * `/usr/bin/env`. libtermux-exec.so restores the `/usr/bin/env →
 * $PREFIX/bin/env` shebang rewriting an interactive Termux shell gets for free.
 *
 * It can't simply be set as an env var, because libtermux-exec must already be
 * loaded into the *process that calls execve* — merely exporting `LD_PRELOAD`
 * in this wrapper bash doesn't load it here. So the wrapper re-exec's itself
 * once with `LD_PRELOAD` set (guarded by `_TMX_LD_REEXEC` to avoid a loop):
 * the wrapper's own shebang is an absolute path that needs no rewriting, and
 * the re-exec'd copy starts with libtermux-exec.so loaded — so its `exec` of
 * the (possibly `/usr/bin/env`-shebanged) target script, and every descendant,
 * get shebang rewriting. The case-statement prepends only if absent.
 *
 * @param ldPreloadLib Absolute path to libtermux-exec.so, or null to skip the
 *   preload entirely (e.g. when the lib is missing).
 */
export function buildRunTabWrapper(
  scriptPath: string,
  cwd: string,
  tabName: string,
  ldPreloadLib: string | null,
): string {
  const lines = [`#!/data/data/com.termux/files/usr/bin/bash`];
  if (ldPreloadLib) {
    lines.push(
      `if [ -z "\${_TMX_LD_REEXEC:-}" ] && [ -f "${ldPreloadLib}" ]; then`,
      `  export _TMX_LD_REEXEC=1`,
      `  case ":\${LD_PRELOAD}:" in *":${ldPreloadLib}:"*) ;; ` +
        `*) export LD_PRELOAD="${ldPreloadLib}\${LD_PRELOAD:+:\$LD_PRELOAD}" ;; esac`,
      `  exec "\$0" "\$@"`,
      `fi`,
    );
  }
  lines.push(
    `printf '\\033]0;build:%s\\007' "${tabName}"`,
    `cd "${cwd}" || exit 1`,
    `exec "${scriptPath}"`,
    "",
  );
  return lines.join("\n");
}

/**
 * Parse `termux-battery-status` (Termux:API) JSON into a BatteryInfo, or null
 * if the output isn't a JSON object. Pure — extracted from getBatteryStatus so
 * the charging-state logic is unit-testable.
 *
 * Charging semantics (preserved verbatim from the original inline parse): a
 * device counts as charging when status is CHARGING/FULL, OR it is plugged in
 * (plugged !== "UNPLUGGED") and not actively discharging. The plugged clause
 * matters so radios aren't disabled while the device is on AC but reporting
 * NOT_CHARGING. Malformed/missing fields fall back to safe defaults rather
 * than propagating undefined.
 */
export function parseTermuxBatteryStatus(raw: string): BatteryInfo | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;

  const status = typeof d.status === "string" ? d.status : "";
  // Missing/non-string plugged behaves as "not UNPLUGGED" (matches original).
  const plugged = typeof d.plugged === "string" ? d.plugged : undefined;
  const percentage = typeof d.percentage === "number"
    ? Math.max(0, Math.min(100, d.percentage))
    : 0;

  return {
    percentage,
    charging: status === "CHARGING" || status === "FULL" ||
      (plugged !== "UNPLUGGED" && status !== "DISCHARGING"),
    temperature: typeof d.temperature === "number" ? d.temperature : 0,
    health: typeof d.health === "string" ? d.health : "UNKNOWN",
  };
}

/**
 * Active notification PIDs — keyed by notification --id.
 * Before spawning a new notification for the same id, we SIGKILL the previous
 * process to prevent pile-up when Termux:API service is unresponsive.
 */
const activeNotifyPids = new Map<string, number>();

/** ALL active termux-api child PIDs (with or without --id) for global cap enforcement */
const allApiPids = new Set<number>();

/**
 * Circuit breaker for Termux:API calls.
 * When the service is unresponsive, consecutive timeouts trip the breaker
 * and all subsequent calls are silently dropped until the service recovers.
 * This prevents the 190+ process burst during boot when states change rapidly.
 */
let circuitBreakerFailCount = 0;
let circuitBreakerOpenUntil = 0;
let circuitBreakerWarnedAt = 0; // throttle so we don't spam every reopen
const CIRCUIT_BREAKER_THRESHOLD = 3;  // trip after 3 consecutive timeouts
const CIRCUIT_BREAKER_COOLDOWN = 30_000; // 30s cooldown before retrying

/**
 * Optional structured-log sink wired up by the daemon so the circuit
 * breaker's open/close events appear in `tmx watch` / `tmx logs` instead
 * of disappearing into stderr. Set via setAndroidLogger() at boot.
 */
type CbLog = (level: "warn" | "info", msg: string) => void;
let cbLog: CbLog = (level, msg) => {
  // Default sink: write to stderr so the message lands in the daemon's
  // captured stderr log even before setAndroidLogger() runs.
  process.stderr.write(`[android] ${level.toUpperCase()} ${msg}\n`);
};
/** Wire up a structured logger for the Termux:API circuit breaker. */
export function setAndroidLogger(log: CbLog): void {
  cbLog = log;
}
/**
 * Hard cap on concurrent termux-api processes to prevent boot-time burst.
 * Covers ALL termux-api calls (notifications, removes, battery, toast).
 */
const MAX_CONCURRENT_API_PROCS = 5;

/**
 * Extract the notification --id from args, if present.
 * Used to track and dedup spawned termux-notification processes.
 */
function extractNotifyId(args: string[]): string | null {
  const idx = args.indexOf("--id");
  return (idx >= 0 && idx + 1 < args.length) ? args[idx + 1] : null;
}

/**
 * Spawn a Termux:API command non-blocking with a hard kill timeout.
 * termux-notification (and friends) can hang indefinitely when Termux:API
 * service is unresponsive — using spawnSync would freeze the event loop.
 *
 * Three layers of protection against process pile-up:
 * 1. Per-ID tracking: kills previous stuck process before spawning replacement
 * 2. Hard timeout: SIGKILL after 8s if process hasn't exited
 * 3. Circuit breaker: after 3 consecutive timeouts, drops all calls for 30s
 */
function spawnTermuxApi(bin: string, args: string[], timeoutMs = 8000): void {
  // Circuit breaker: skip if Termux:API service is known to be unresponsive
  if (circuitBreakerOpenUntil > Date.now()) {
    return;
  }

  // Hard cap: skip if too many termux-api processes are already pending.
  // During boot, session states change rapidly and each change triggers
  // a notification update — without this cap, 190+ processes spawn in seconds.
  if (allApiPids.size >= MAX_CONCURRENT_API_PROCS) {
    return;
  }

  try {
    // Kill previous stuck process group for the same notification id.
    // Negative PID kills the entire process group — critical because
    // termux-notification is a bash wrapper that pipes to /usr/libexec/termux-api.
    // Killing only the bash wrapper orphans the stuck termux-api to init.
    const notifyId = extractNotifyId(args);
    if (notifyId) {
      const prevPid = activeNotifyPids.get(notifyId);
      if (prevPid !== undefined) {
        try { process.kill(-prevPid, "SIGKILL"); } catch { /* already dead */ }
        activeNotifyPids.delete(notifyId);
      }
    }

    const child = spawn(bin, args, {
      stdio: "ignore",
      env: termuxApiEnv(),
      detached: true,
    });

    const pid = child.pid;

    // Track the PID globally and per notification id
    if (pid) allApiPids.add(pid);
    if (notifyId && pid) {
      activeNotifyPids.set(notifyId, pid);
    }

    /** Clean up tracking state for this process */
    const cleanup = () => {
      if (pid) allApiPids.delete(pid);
      if (notifyId) activeNotifyPids.delete(notifyId);
    };

    // Track whether this process was killed by our timeout handler.
    // When we SIGKILL a stuck process, the "exit" event also fires — without
    // this flag, the exit handler resets circuitBreakerFailCount to 0,
    // preventing the circuit breaker from ever tripping.
    let killedByTimeout = false;

    // Hard kill the entire process group after timeout.
    // Use -pid (negative) to kill the process group, not just the wrapper.
    // termux-notification is a bash script that pipes to /usr/libexec/termux-api —
    // killing only the wrapper PID orphans the stuck termux-api grandchild to init.
    // With detached: true, child.pid IS the PGID, so -pid kills the group.
    const timer = setTimeout(() => {
      killedByTimeout = true;
      if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ } }
      // DON'T cleanup() here — leave PID in allApiPids to prevent the slot
      // from being immediately recycled. The exit handler will clean up
      // after the SIGKILL takes effect. Only clear the notification id mapping
      // so the next notification for this id can proceed.
      if (notifyId) activeNotifyPids.delete(notifyId);
      // Timeout = Termux:API service likely unresponsive
      circuitBreakerFailCount++;
      if (circuitBreakerFailCount >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitBreakerOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN;
        // Throttle the warn line so a sustained outage doesn't spam logs
        // every cooldown cycle. Re-warn no more than once per minute.
        if (Date.now() - circuitBreakerWarnedAt > 60_000) {
          cbLog(
            "warn",
            `Termux:API circuit breaker opened — dropping all termux-api calls ` +
            `for ${CIRCUIT_BREAKER_COOLDOWN / 1000}s after ${CIRCUIT_BREAKER_THRESHOLD} ` +
            `consecutive timeouts. Notifications/battery/etc disabled until service recovers.`,
          );
          circuitBreakerWarnedAt = Date.now();
        }
        // Kill all tracked process groups — they're all stuck
        for (const p of allApiPids) {
          try { process.kill(-p, "SIGKILL"); } catch { /* already dead */ }
        }
        // Don't clear allApiPids — exit handlers will clean up as processes die.
        // This prevents new spawns until the slots are actually freed.
        activeNotifyPids.clear();
      }
    }, timeoutMs);

    child.on("exit", () => {
      clearTimeout(timer);
      cleanup();
      // Only reset circuit breaker for processes that exited naturally —
      // NOT for processes we killed via timeout (they'd undo the breaker trip)
      if (!killedByTimeout) {
        const wasOpen = circuitBreakerOpenUntil > 0 && circuitBreakerFailCount > 0;
        circuitBreakerFailCount = 0;
        if (wasOpen && circuitBreakerOpenUntil <= Date.now()) {
          // Cooldown elapsed and a real call succeeded — service is back.
          cbLog("info", "Termux:API circuit breaker closed — service responsive again.");
          circuitBreakerOpenUntil = 0;
          circuitBreakerWarnedAt = 0;
        }
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      cleanup();
    });

    // Detach so child doesn't block parent shutdown
    child.unref();
  } catch {
    // Non-fatal — notification loss is acceptable
  }
}

/**
 * Kill ALL tracked notification processes. Called during daemon shutdown
 * to prevent orphaned termux-api processes from piling up.
 */
export function killAllNotifyProcesses(): void {
  for (const pid of allApiPids) {
    // Kill entire process group (bash wrapper + piped termux-api children)
    try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
  }
  allApiPids.clear();
  activeNotifyPids.clear();
}

/**
 * Kill ALL stale termux-api processes and reap zombie children system-wide.
 * Called on daemon startup to clean up orphans from previous daemon instances
 * that were SIGKILL'd by Android OOM killer (no cleanup handler fires on SIGKILL).
 *
 * Matches on the EXACT process name (`pkill -9 -x`), not the full command
 * line. termux-api helper processes are ephemeral and the daemon immediately
 * re-emits the current status notification, so killing them is safe — but a
 * `-f` substring match over every command line on the device was not: it also
 * matched unrelated processes that merely mentioned "termux-api".
 *
 * Does NOT touch crond. See the comment at the call site below.
 */
function killStaleTermuxApiProcesses(): number {
  let killed = 0;

  // Count stale termux-api processes before killing
  try {
    const countResult = spawnSync("sh", ["-c", "ps -e 2>/dev/null | grep -c 'termux-api'"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    killed = parseInt(countResult.stdout?.trim() ?? "0", 10);
  } catch { /* non-fatal */ }

  // Kill stale termux-api helper processes by EXACT process name.
  //
  // This was `pkill -9 -f termux-api`, which matches the whole command line of
  // every process on the device — so it also killed the user's own
  // `termux-api` invocation, an editor with a termux-api path open, or a
  // running `pkg install termux-api`. `-x` matches the process name only.
  try {
    spawnSync("pkill", ["-9", "-x", "termux-api"], {
      timeout: 5000,
      stdio: "ignore",
    });
  } catch { /* non-fatal — pkill returns 1 if no match */ }

  // NOTE: operad deliberately does NOT kill crond.
  //
  // The previous code counted `[crond]` zombies and, if any existed, ran
  // `pkill -9 crond`. A zombie is already dead and cannot be signalled — so
  // the only process that call could actually kill was the user's LIVE crond,
  // which on Termux is typically started from ~/.termux/boot/ and owns all
  // their cron jobs. One leftover zombie silently destroyed cron on every
  // operad boot. Zombies are reaped by their parent, not by us.

  return killed;
}

// Pre-resolve common binary paths at module load time
const TERMUX_NOTIFICATION_BIN = resolveTermuxBin("termux-notification");
const AM_BIN = resolveTermuxBin("am");

// -- AndroidPlatform ----------------------------------------------------------

/**
 * Android/Termux platform implementation.
 *
 * Delegates proc-based operations to common.ts helpers and implements
 * all Termux-specific functionality (notifications, battery, wake lock,
 * ADB protections, terminal tabs, session environment).
 */
export class AndroidPlatform implements Platform {
  readonly id: PlatformId = "android";
  readonly hasAdb = true;

  /**
   * Track whether LD_PRELOAD has been injected into tmux global env.
   * Only needs to happen once per daemon lifetime — avoid repeat calls.
   */
  private tmuxLdPreloadInjected = false;

  // -- Memory/Process (delegated to common.ts) --------------------------------

  getSystemMemory(): SystemMemoryInfo | null {
    return readProcMeminfo();
  }

  readProcessCpuTicks(pid: number): number | null {
    return readProcStatCpuTicks(pid);
  }

  buildProcessTree(): Map<number, { pid: number; ticks: number }[]> {
    return buildProcTree();
  }

  isProcessAlive(pid: number): boolean {
    return isProcAlive(pid);
  }

  readProcessCwd(pid: number): string | null {
    return readProcCwd(pid);
  }

  hasAncestorComm(pid: number, comm: string, maxDepth?: number): boolean {
    return hasProcAncestorComm(pid, comm, maxDepth);
  }

  // -- Notifications ----------------------------------------------------------

  /**
   * Send a Termux notification (non-blocking).
   * Uses --id and --alert-once when an id is provided to update in place
   * rather than spamming new notifications.
   */
  notify(title: string, content: string, id?: string): void {
    const args = ["--title", title, "--content", content];
    if (id) args.push("--id", id, "--alert-once");
    spawnTermuxApi(TERMUX_NOTIFICATION_BIN, args);
  }

  /** Send a notification with raw args (platform-specific flags like --ongoing, --button1, etc.) */
  notifyWithArgs(args: string[]): void {
    spawnTermuxApi(TERMUX_NOTIFICATION_BIN, args);
  }

  /** Remove a notification by id (non-blocking) */
  removeNotification(id: string): void {
    spawnTermuxApi(resolveTermuxBin("termux-notification-remove"), [id]);
  }

  /** Kill all tracked notification processes to prevent orphan pile-up on shutdown */
  killTrackedNotifyProcesses(): void {
    killAllNotifyProcesses();
  }

  /** Kill stale termux-api processes from previous daemon instances (startup cleanup) */
  killStaleNotifyProcesses(): number {
    return killStaleTermuxApiProcesses();
  }

  // -- Battery ----------------------------------------------------------------

  /**
   * Read current battery status.
   * Primary: termux-battery-status (Termux:API JSON output).
   * Fallback: /sys/class/power_supply/battery/* sysfs files (works without Termux:API).
   */
  getBatteryStatus(): BatteryInfo | null {
    // Prefer sysfs (pure file reads, zero process spawn).
    // On Android, /sys/class/power_supply/battery/ always exists and provides
    // all the data we need. Using termux-battery-status spawns a process that
    // can hang when Termux:API service is unresponsive, leaking orphan processes.
    try {
      const base = "/sys/class/power_supply/battery";
      if (existsSync(base)) {
        const capacity = parseInt(readFileSync(`${base}/capacity`, "utf-8").trim(), 10);
        const statusStr = readFileSync(`${base}/status`, "utf-8").trim();
        let temp = 0;
        try {
          // sysfs temperature is in tenths of a degree Celsius
          temp = parseInt(readFileSync(`${base}/temp`, "utf-8").trim(), 10) / 10;
        } catch { /* temperature is optional */ }
        let health = "UNKNOWN";
        try {
          health = readFileSync(`${base}/health`, "utf-8").trim();
        } catch { /* health is optional */ }

        // A garbage/absent capacity read must not look like a flat battery:
        // 0% + not-charging trips the low-battery action, which calls
        // disableRadios() — wifi and mobile data off. That takes the device
        // off the network (including adb-over-wifi and the dashboard) on one
        // failed read. null means "unknown" and the monitor holds.
        if (isNaN(capacity)) return null;

        return {
          percentage: capacity,
          charging: statusStr === "Charging" || statusStr === "Full",
          temperature: temp,
          health,
        };
      }
    } catch { /* fall through to termux-battery-status */ }

    // Fallback: call /usr/libexec/termux-api BatteryStatus directly.
    // MUST bypass the termux-battery-status bash wrapper because:
    // - The wrapper forks termux-api as a child process
    // - spawnSync's timeout SIGTERM only kills the wrapper, not the child
    // - The orphaned termux-api process leaks to init (PPID=1) forever
    // By calling termux-api directly, spawnSync's killSignal hits the actual process.
    try {
      const bin = join(PREFIX, "libexec", "termux-api");
      const result = spawnSync(bin, ["BatteryStatus"], {
        encoding: "utf-8",
        timeout: 8000,
        killSignal: "SIGKILL",  // SIGTERM may not kill process stuck in Binder IPC
        stdio: ["ignore", "pipe", "pipe"],
        env: termuxApiEnv(),
      });
      if (result.status === 0 && result.stdout) {
        const parsed = parseTermuxBatteryStatus(result.stdout);
        if (parsed) return parsed;
      }
    } catch { /* battery info unavailable */ }

    return null;
  }

  /** Disable wifi and mobile data to conserve battery */
  disableRadios(): void {
    const env = termuxApiEnv();
    const wifiBin = resolveTermuxBin("termux-wifi-enable");

    // Disable WiFi via termux-wifi-enable (Termux:API)
    try {
      spawnSync(wifiBin, ["false"], {
        timeout: 8000,
        stdio: "ignore",
        env,
      });
    } catch { /* non-fatal */ }

    // Disable mobile data via svc (requires adb shell or root-level permissions)
    try {
      spawnSync("svc", ["data", "disable"], { timeout: 3000, stdio: "ignore", env });
    } catch { /* non-fatal */ }
  }

  /** Re-enable wifi and mobile data */
  enableRadios(): void {
    const env = termuxApiEnv();
    const wifiBin = resolveTermuxBin("termux-wifi-enable");

    try {
      spawnSync(wifiBin, ["true"], { timeout: 8000, stdio: "ignore", env });
    } catch { /* non-fatal */ }

    try {
      spawnSync("svc", ["data", "enable"], { timeout: 3000, stdio: "ignore", env });
    } catch { /* non-fatal */ }
  }

  /**
   * Send a low-battery alert notification with max priority + vibration,
   * plus a termux-toast for immediate on-screen visibility.
   */
  sendBatteryAlert(pct: number): void {
    // Use non-blocking spawnTermuxApi instead of spawnSync to avoid
    // blocking the event loop for 8s when Termux:API service is unresponsive
    spawnTermuxApi(resolveTermuxBin("termux-notification"), [
      "--title", "LOW BATTERY",
      "--content", `Battery at ${pct}% and not charging. WiFi & mobile data disabled to conserve power. Plug in to restore.`,
      "--priority", "max",
      "--id", "tmx-battery-low",
      "--vibrate", "500,200,500",
    ]);

    // Also show a termux-toast for immediate visibility (appears as a brief overlay)
    spawnTermuxApi(resolveTermuxBin("termux-toast"), [
      "-b", "red",
      "-c", "white",
      `BATTERY ${pct}% — radios disabled`,
    ]);
  }

  // -- Wake lock --------------------------------------------------------------

  /**
   * Acquire Termux wake lock. Returns true if acquired successfully.
   *
   * The wake lock is NEVER released by the daemon — Android aggressively kills
   * background processes when wake lock is dropped. The old tasker/startup.sh
   * never released, and it was stable. We follow the same acquire-only pattern.
   *
   * Must inject LD_PRELOAD because bun's glibc-runner strips it, and
   * termux-wake-lock invokes `am startservice` internally.
   */
  acquireWakeLock(): boolean {
    try {
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      if (existsSync(TERMUX_LD_PRELOAD)) {
        env.LD_PRELOAD = TERMUX_LD_PRELOAD;
      }
      execSync("termux-wake-lock", { timeout: 5000, stdio: "ignore", env });
      return true;
    } catch {
      return false;
    }
  }

  // -- Session env ------------------------------------------------------------

  /**
   * Build a clean environment for tmux child processes.
   * Strips CLAUDECODE and CLAUDE_CODE_* vars to prevent nested-session
   * detection errors ("cannot launch inside another CC session") when
   * launching Claude Code inside tmux panes spawned by the daemon.
   * Re-injects LD_PRELOAD with libtermux-exec.so for /usr/bin/env rewriting.
   */
  cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };

    // Strip Claude nesting detection variables
    delete env.CLAUDECODE;
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDE_CODE_") || key.startsWith("CLAUDE_TMPDIR")) {
        delete env[key];
      }
    }
    // Also strip ENABLE_CLAUDE_CODE_* variants
    for (const key of Object.keys(env)) {
      if (key.startsWith("ENABLE_CLAUDE_CODE_")) {
        delete env[key];
      }
    }

    // Re-inject LD_PRELOAD for termux-exec (stripped by bun's glibc-runner).
    // libtermux-exec.so rewrites /usr/bin/env → $PREFIX/bin/env so that
    // shebang-based scripts (claude, node, etc.) work in Termux.
    if (existsSync(TERMUX_LD_PRELOAD)) {
      env.LD_PRELOAD = TERMUX_LD_PRELOAD;
    }

    return env;
  }

  /**
   * Build environment for am/termux-am commands.
   * Uses libtermux-exec-ld-preload.so (not the general libtermux-exec.so) —
   * this specific variant is required for app_process to function. Without it,
   * `am` silently succeeds (exit 0) but does nothing at all.
   */
  amEnv(): NodeJS.ProcessEnv {
    return { ...process.env, LD_PRELOAD: TERMUX_AM_LD_PRELOAD };
  }

  /**
   * Inject LD_PRELOAD into the tmux global environment so new sessions
   * inherit termux-exec even when the tmux server was started without it.
   * Safe to call repeatedly — tracked with a boolean flag and uses
   * spawnSync(tmux set-environment -g) which is idempotent.
   */
  ensureTmuxLdPreload(): void {
    if (this.tmuxLdPreloadInjected) return;
    if (!existsSync(TERMUX_LD_PRELOAD)) return;

    const tmuxBin = resolveTermuxBin("tmux");
    const result = spawnSync(tmuxBin, [
      "set-environment", "-g", "LD_PRELOAD", TERMUX_LD_PRELOAD,
    ], {
      timeout: 10_000,
      stdio: "ignore",
    });

    if (result.status === 0) {
      this.tmuxLdPreloadInjected = true;
    }
  }

  // -- Terminal tabs ----------------------------------------------------------

  /**
   * Create a Termux tab attached to a tmux session.
   *
   * Writes an attach script to $PREFIX/tmp/tmx-attach.sh that sets the
   * terminal title (for Termux tab label) and execs into tmux attach.
   * Then sends an intent to TermuxService to execute the script in a new tab.
   *
   * session_action=0 switches to the new session and opens the activity.
   * Falls back to tmux switch-client if TermuxService intent fails.
   */
  createTerminalTab(sessionName: string): boolean {
    const env = this.amEnv();

    // Ensure tmux propagates session name as outer terminal title (Termux tab label).
    // set-titles is a GLOBAL option — `-t session` is silently ignored.
    const tmuxBin = resolveTermuxBin("tmux");
    spawnSync(tmuxBin, ["set-option", "-g", "set-titles", "on"], {
      timeout: 10_000, stdio: "ignore",
    });
    spawnSync(tmuxBin, ["set-option", "-g", "set-titles-string", "#S"], {
      timeout: 10_000, stdio: "ignore",
    });

    // If there's already a client on this session, nothing to do
    const targetClientsResult = spawnSync(tmuxBin, [
      "list-clients", "-t", `=${sessionName}`, "-F", "#{client_tty}",
    ], {
      encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const targetClients = targetClientsResult.status === 0
      ? (targetClientsResult.stdout ?? "").trim()
      : "";
    if (targetClients.length > 0) {
      // Tab already exists — ensure the tab label is correct via OSC title escape
      const clientTty = targetClients.split("\n")[0];
      try { writeFileSync(clientTty, `\x1b]0;${sessionName}\x07`); } catch { /* ignore */ }
      return true;
    }

    // Create the attach script that TermuxService will execute
    const scriptPath = join(PREFIX, "tmp", "tmx-attach.sh");
    try {
      writeFileSync(scriptPath, [
        `#!/data/data/com.termux/files/usr/bin/bash`,
        `printf '\\033]0;%s\\007' "$1"`,
        // `=name` forces tmux to exact-match the session — without it `attach -t foo`
        // prefix-matches and could attach to `foo-2` when only the suffixed exists.
        `exec tmux attach -t "=$1"`,
        "",
      ].join("\n"), { mode: 0o755 });
    } catch { /* best effort — may already exist */ }

    // Primary: create a new Termux tab via TermuxService service_execute intent.
    // This sends an Android intent that creates a new terminal session,
    // opens a new Termux tab, and runs the attach script within it.
    const svcResult = spawnSync(AM_BIN, [
      "startservice",
      "-n", "com.termux/.app.TermuxService",
      "-a", "com.termux.service_execute",
      "-d", `file://${scriptPath}`,
      "--esa", "com.termux.execute.arguments", sessionName,
      "--ei", "com.termux.execute.session_action", "0",
      "--es", "com.termux.execute.shell_name", sessionName,
    ], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env,
    });

    if (svcResult.status === 0) {
      return true;
    }

    // Fallback: switch an existing tmux client to this session.
    // Only works when at least one tmux client exists (e.g. from watchdog.sh).
    const allClientsResult = spawnSync(tmuxBin, [
      "list-clients", "-F", "#{client_name}:#{client_tty}",
    ], {
      encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const allClients = allClientsResult.status === 0
      ? (allClientsResult.stdout ?? "").trim()
      : "";

    if (allClients.length > 0) {
      const firstClient = allClients.split("\n")[0];
      const colonIdx = firstClient.indexOf(":");
      const clientName = firstClient.substring(0, colonIdx);
      const clientTty = firstClient.substring(colonIdx + 1);

      spawnSync(tmuxBin, ["switch-client", "-c", clientName, "-t", `=${sessionName}`], {
        timeout: 10_000, stdio: "ignore",
      });
      spawnSync(tmuxBin, ["refresh-client", "-c", clientName], {
        timeout: 10_000, stdio: "ignore",
      });

      // Write OSC title escape for Termux tab label
      try { writeFileSync(clientTty, `\x1b]0;${sessionName}\x07`); } catch { /* ignore */ }
    }

    return true;
  }

  /** Bring Termux app to foreground via am start intent */
  bringTerminalToForeground(): void {
    const env = this.amEnv();
    spawnSync(AM_BIN, [
      "start", "-n", "com.termux/.app.TermuxActivity",
    ], { timeout: 5000, stdio: "ignore", env });
  }

  /**
   * Run a script in a new Termux tab.
   * Creates a wrapper script that sets the terminal title, cd's to the project
   * directory, and execs the target script. Launched via TermuxService intent.
   */
  runScriptInTab(scriptPath: string, cwd: string, tabName: string): boolean {
    const wrapperPath = join(PREFIX, "tmp", `tmx-run-${tabName}.sh`);
    const env = this.amEnv();
    // libtermux-exec.so must be preloaded so `#!/usr/bin/env` shebangs in the
    // target script (e.g. gradle's ./gradlew) resolve — the TermuxService
    // execute intent does not inherit Termux's default LD_PRELOAD.
    const ldPreloadLib = existsSync(TERMUX_LD_PRELOAD) ? TERMUX_LD_PRELOAD : null;

    // Create wrapper script that sets title, cd's to project dir, runs the script
    try {
      writeFileSync(
        wrapperPath,
        buildRunTabWrapper(scriptPath, cwd, tabName, ldPreloadLib),
        { mode: 0o755 },
      );
    } catch {
      return false;
    }

    // Launch in new Termux tab via TermuxService intent
    const result = spawnSync(AM_BIN, [
      "startservice",
      "-n", "com.termux/.app.TermuxService",
      "-a", "com.termux.service_execute",
      "-d", `file://${wrapperPath}`,
      "--ei", "com.termux.execute.session_action", "0",
      "--es", "com.termux.execute.shell_name", `build:${tabName}`,
    ], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env,
    });

    if (result.status === 0) {
      // Bring Termux to foreground so user can see the build output
      this.bringTerminalToForeground();
      return true;
    }

    return false;
  }

  // -- ADB --------------------------------------------------------------------

  /**
   * Resolve ADB binary path.
   * Bun's spawnSync can't find adb via PATH symlinks, so we try `which adb`
   * first, then fall back to common Termux/Android SDK locations.
   */
  resolveAdbPath(): string | null {
    try {
      const result = spawnSync("which", ["adb"], {
        encoding: "utf-8",
        timeout: 3000,
      });
      if (result.stdout?.trim()) return result.stdout.trim();
    } catch { /* fall through */ }

    // Fallback to common Termux locations
    const candidates = [
      join(PREFIX, "bin", "adb"),
      join(HOME, "android-sdk", "platform-tools", "adb"),
    ];
    for (const p of candidates) {
      try {
        if (existsSync(p)) return p;
      } catch { /* skip */ }
    }

    return null;
  }

  /**
   * Apply Android 12+ process protection fixes via ADB.
   * Mirrors ALL the protections from the old tasker/startup.sh:
   *
   * 1. Phantom process killer disable (device_config max_phantom_processes=MAX_INT
   *    + settings_enable_monitor_phantom_procs=false)
   * 2. Doze whitelist (deviceidle) for Termux + Edge Canary
   * 3. Active standby bucket for Termux + Edge Canary
   * 4. Background execution allow (RUN_ANY_IN_BACKGROUND) for Termux + Edge Canary
   * 5. OOM score adjustment (-200) for Termux main process
   * 6. Set-inactive false to prevent idle classification
   * 7. Lower LMK trigger level to reduce aggressive kills
   * 8. Re-enable Samsung sensor packages (device-specific)
   *
   * @param adbBin - Resolved path to the adb binary
   * @param serialArgs - ADB serial selection args (e.g. ["-s", "127.0.0.1:5555"]), empty if single device
   */
  applyPhantomFix(adbBin: string, serialArgs: string[]): void {
    /** Build adb shell command args with serial prefix */
    const shellArgs = (...shellCmd: string[]): string[] => [
      ...serialArgs, "shell", ...shellCmd,
    ];

    // Package lists — apply protections to both Termux and Edge Canary
    const packages = ["com.termux", "com.microsoft.emmx.canary"];

    // 1. Phantom process killer fix
    const phantomCmds: string[][] = [
      ["/system/bin/device_config", "put", "activity_manager", "max_phantom_processes", "2147483647"],
      ["settings", "put", "global", "settings_enable_monitor_phantom_procs", "false"],
    ];
    for (const cmd of phantomCmds) {
      try {
        spawnSync(adbBin, shellArgs(...cmd), { timeout: 10_000, stdio: "ignore" });
      } catch { /* non-critical — log at caller */ }
    }

    // 2. Doze whitelist — prevent Android from suspending these apps
    for (const pkg of packages) {
      try {
        spawnSync(adbBin, shellArgs("cmd", "deviceidle", "whitelist", `+${pkg}`), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch { /* non-critical */ }
    }

    // 3. Active standby bucket — prevent throttling
    for (const pkg of packages) {
      try {
        spawnSync(adbBin, shellArgs("am", "set-standby-bucket", pkg, "active"), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch { /* non-critical */ }
    }

    // 4. Allow background execution unconditionally
    for (const pkg of packages) {
      try {
        spawnSync(adbBin, shellArgs("cmd", "appops", "set", pkg, "RUN_ANY_IN_BACKGROUND", "allow"), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch { /* non-critical */ }
    }

    // 5. OOM score adjustment — make Termux less likely to be killed by LMK.
    // oom_score_adj ranges from -1000 (never kill) to 1000 (kill first).
    // -200 is moderate — enough to survive pressure spikes without starving
    // foreground apps. Logcat shows Termux main process already at adj=0
    // (foreground), so this mainly protects against transient demotion.
    try {
      const pidResult = spawnSync(adbBin, shellArgs(
        "sh", "-c", "pidof com.termux | head -1",
      ), { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
      const termuxPid = pidResult.stdout?.trim();
      if (termuxPid && /^\d+$/.test(termuxPid)) {
        spawnSync(adbBin, shellArgs(
          "sh", "-c", `echo -200 > /proc/${termuxPid}/oom_score_adj`,
        ), { timeout: 10_000, stdio: "ignore" });
      }
    } catch { /* non-critical */ }

    // 6. Prevent Android from classifying apps as idle (triggers restrictions)
    for (const pkg of packages) {
      try {
        spawnSync(adbBin, shellArgs("cmd", "activity", "set-inactive", pkg, "false"), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch {
        // Non-critical — command may not exist on all Android versions
      }
    }

    // 7. Lower LMK trigger level to reduce aggressive kills under memory pressure
    try {
      spawnSync(adbBin, shellArgs("settings", "put", "global", "low_power_trigger_level", "1"), {
        timeout: 10_000, stdio: "ignore",
      });
    } catch { /* non-critical */ }

    // 8. Re-enable Samsung sensor packages (device-specific, harmless elsewhere)
    const samsungPkgs = [
      "com.samsung.android.ssco",
      "com.samsung.android.mocca",
      "com.samsung.android.camerasdkservice",
    ];
    for (const pkg of samsungPkgs) {
      try {
        spawnSync(adbBin, shellArgs("pm", "enable", pkg), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch { /* non-critical */ }
    }
  }

  /** Resolve local IP address via `ip route get 1` (for ADB serial detection) */
  resolveLocalIp(): string | null {
    return resolveLocalIpViaRoute();
  }

  // -- Budget -----------------------------------------------------------------

  /**
   * Count phantom processes — descendants of TERMUX_APP_PID.
   * Android's PhantomProcessList tracks these; the phantom killer (disabled
   * via device_config on this device) would terminate them at threshold 32.
   *
   * Uses BFS traversal of the process tree built from `ps -e -o pid=,ppid=`.
   */
  countPhantomProcesses(): number {
    const envPid = process.env.TERMUX_APP_PID;
    if (!envPid) return 0;
    const appPid = parseInt(envPid, 10);
    if (isNaN(appPid) || appPid <= 0) return 0;

    try {
      const result = spawnSync("ps", ["-e", "-o", "pid=,ppid="], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.status !== 0 || !result.stdout) return 0;

      // Build parent → children map
      const childrenOf = new Map<number, number[]>();
      for (const line of result.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        if (isNaN(pid) || isNaN(ppid)) continue;
        let siblings = childrenOf.get(ppid);
        if (!siblings) {
          siblings = [];
          childrenOf.set(ppid, siblings);
        }
        siblings.push(pid);
      }

      // BFS from appPid, count descendants (excluding root)
      let count = 0;
      const queue = childrenOf.get(appPid) ?? [];
      const visited = new Set<number>([appPid]);
      while (queue.length > 0) {
        const pid = queue.shift()!;
        if (visited.has(pid)) continue;
        visited.add(pid);
        count++;
        const kids = childrenOf.get(pid);
        if (kids) {
          for (const kid of kids) {
            if (!visited.has(kid)) queue.push(kid);
          }
        }
      }
      return count;
    } catch {
      return 0;
    }
  }

  // -- Paths ------------------------------------------------------------------

  /** Config file search paths in priority order (operad primary, tmx/drey fallback for compat) */
  configPaths(): string[] {
    return [
      join(HOME, ".config", "operad", "operad.toml"),
      join(HOME, ".config", "drey", "drey.toml"),
      join(HOME, ".config", "tmx", "tmx.toml"),
      join(HOME, ".termux", "tmx.toml"),
    ];
  }

  /** Default IPC socket path — uses $PREFIX/tmp since /tmp doesn't exist on Termux */
  defaultSocketPath(): string {
    return join(PREFIX, "tmp", "tmx.sock");
  }

  /** Default state file path */
  defaultStatePath(): string {
    return join(HOME, ".local", "share", "tmx", "state.json");
  }

  /**
   * `operad`, not the legacy `tmx` that holds state.json — this is where the
   * memory database already lives, and moving it would orphan every existing
   * install's agent history.
   */
  defaultDataDir(): string {
    return join(HOME, ".local", "share", "operad");
  }

  /** Default log directory path */
  defaultLogDir(): string {
    return join(HOME, ".local", "share", "tmx", "logs");
  }

  /**
   * Resolve full path for a named binary.
   * Bun's spawnSync can't find $PREFIX/bin binaries via PATH symlink chains,
   * so we check the candidate path directly in $PREFIX/bin/ first.
   */
  resolveBinaryPath(name: string): string {
    return resolveTermuxBin(name);
  }

  /**
   * Resolve the bun runtime wrapper path for spawning child processes.
   *
   * On Termux, `bun` is a bash wrapper that invokes grun (glibc-runner) + buno.
   * process.argv[0] resolves to the raw buno binary which can't run standalone
   * on Android (causes "invalid ELF header"). We must find the wrapper script.
   *
   * Search order:
   * 1. `which bun` — returns the wrapper script path
   * 2. ~/.bun/bin/bun — default bun install location
   * 3. $PREFIX/bin/bun — Termux package location
   * 4. process.argv[0] — last resort, may not work
   */
  resolveRuntimePath(): string {
    // Try `which bun` first — returns the wrapper script path
    try {
      const result = spawnSync("which", ["bun"], {
        encoding: "utf-8",
        timeout: 3000,
      });
      if (result.stdout?.trim()) return result.stdout.trim();
    } catch { /* fall through */ }

    // Fallback: check common install locations
    const candidates = [
      join(HOME, ".bun", "bin", "bun"),
      join(PREFIX, "bin", "bun"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }

    // Last resort — use process.argv[0] and hope for the best
    return process.argv[0];
  }
}
