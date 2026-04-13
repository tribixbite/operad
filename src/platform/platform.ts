/**
 * platform.ts — Cross-platform abstraction layer
 *
 * Defines the Platform interface and detectPlatform() factory.
 * Each consumer imports `platform` and calls methods without knowing
 * whether it's running on Android/Termux, Linux desktop, or macOS.
 */

/** Supported platform identifiers */
export type PlatformId = "android" | "linux" | "darwin";

/** System memory snapshot from the OS */
export interface SystemMemoryInfo {
  /** Total physical RAM in kB */
  total_kb: number;
  /** Available memory in kB */
  available_kb: number;
  /** Total swap in kB */
  swap_total_kb: number;
  /** Free swap in kB */
  swap_free_kb: number;
}

/** Battery status from the OS */
export interface BatteryInfo {
  /** Battery level 0-100 */
  percentage: number;
  /** Whether device is plugged in / charging */
  charging: boolean;
  /** Temperature in Celsius */
  temperature: number;
  /** Health string (Android-specific, "UNKNOWN" on other platforms) */
  health: string;
}

/**
 * Platform interface — abstracts all OS-specific operations.
 *
 * Implementations live in android.ts, linux.ts, darwin.ts.
 * Methods return null/false/no-op when the capability is unavailable
 * on the current platform (e.g. ADB on macOS, wake lock on Linux).
 */
export interface Platform {
  readonly id: PlatformId;

  // -- Memory (memory.ts) ---------------------------------------------------

  /** Read system memory stats (MemTotal, MemAvailable, swap) */
  getSystemMemory(): SystemMemoryInfo | null;

  // -- Process info (activity.ts, health.ts, session.ts) --------------------

  /** Read utime+stime CPU ticks for a PID (fields 14+15 of /proc/PID/stat) */
  readProcessCpuTicks(pid: number): number | null;

  /**
   * Build process tree: maps ppid → children with CPU ticks.
   * Used by ActivityDetector for tree-wide CPU tracking.
   */
  buildProcessTree(): Map<number, { pid: number; ticks: number }[]>;

  /** Check if a process is alive */
  isProcessAlive(pid: number): boolean;

  /** Read the cwd of a process */
  readProcessCwd(pid: number): string | null;

  /**
   * Walk ancestor chain to check if any parent has the given comm name.
   * Used by session.ts to detect if a PID is inside tmux.
   */
  hasAncestorComm(pid: number, comm: string, maxDepth?: number): boolean;

  // -- Notifications (daemon.ts) --------------------------------------------

  /** Send a user notification (non-blocking) */
  notify(title: string, content: string, id?: string): void;

  /** Send a notification with raw args (platform-specific flags) */
  notifyWithArgs(args: string[]): void;

  /** Remove a notification by id */
  removeNotification(id: string): void;

  /** Kill all tracked notification processes (cleanup for shutdown). No-op on non-Android. */
  killTrackedNotifyProcesses(): void;

  /** Kill stale termux-api processes from previous daemon instances (startup cleanup). Returns count killed. */
  killStaleNotifyProcesses(): number;

  // -- Battery (battery.ts) -------------------------------------------------

  /** Read current battery status, or null if unavailable */
  getBatteryStatus(): BatteryInfo | null;

  /** Disable wifi and mobile data (battery saver) */
  disableRadios(): void;

  /** Re-enable wifi and mobile data */
  enableRadios(): void;

  /** Send a low-battery alert notification */
  sendBatteryAlert(pct: number): void;

  // -- Wake lock (wake.ts) --------------------------------------------------

  /** Acquire a wake/sleep inhibitor. Returns true if acquired. */
  acquireWakeLock(): boolean;

  // -- Session env (session.ts) ---------------------------------------------

  /**
   * Build clean env for tmux child processes.
   * Strips Claude nesting vars; on Android, re-injects LD_PRELOAD.
   */
  cleanEnv(): NodeJS.ProcessEnv;

  /**
   * Build env for am/termux-am commands.
   * On Android, injects libtermux-exec-ld-preload.so.
   * No-op (returns process.env copy) on other platforms.
   */
  amEnv(): NodeJS.ProcessEnv;

  /**
   * Inject LD_PRELOAD into tmux global environment.
   * Android-only; no-op on other platforms.
   */
  ensureTmuxLdPreload(): void;

  // -- Terminal tabs (session.ts) — no-op on desktop -------------------------

  /**
   * Create a terminal tab attached to a tmux session.
   * Android: Termux tab via TermuxService intent.
   * Desktop: no-op (tmux sessions suffice).
   */
  createTerminalTab(sessionName: string): boolean;

  /** Bring the terminal app to foreground */
  bringTerminalToForeground(): void;

  /**
   * Run a script in a new terminal tab.
   * Android: new Termux tab via intent.
   * Desktop: no-op.
   */
  runScriptInTab(scriptPath: string, cwd: string, tabName: string): boolean;

  // -- ADB (daemon.ts) — Android only ----------------------------------------

  /** Whether this platform supports ADB operations */
  readonly hasAdb: boolean;

  /** Resolve ADB binary path, or null if unavailable */
  resolveAdbPath(): string | null;

  /** Apply Android phantom process killer fix + Doze whitelist */
  applyPhantomFix(adbBin: string, serialArgs: string[]): void;

  /** Resolve local IP address (for ADB serial detection) */
  resolveLocalIp(): string | null;

  // -- Budget (budget.ts) — Android only ------------------------------------

  /** Count phantom processes (descendants of Termux app PID). Returns 0 on non-Android. */
  countPhantomProcesses(): number;

  // -- Paths (config.ts, tmx.ts) --------------------------------------------

  /** Config file search paths in priority order */
  configPaths(): string[];

  /** Default IPC socket path */
  defaultSocketPath(): string;

  /** Default state file path */
  defaultStatePath(): string;

  /** Default log directory path */
  defaultLogDir(): string;

  /**
   * Resolve full path for a named binary.
   * Android: checks $PREFIX/bin/; others: uses `which` or PATH.
   */
  resolveBinaryPath(name: string): string;

  /**
   * Resolve the runtime (bun/node) wrapper path for spawning child processes.
   * Android: finds bun wrapper (not raw buno binary).
   * Others: process.argv[0] or `which bun/node`.
   */
  resolveRuntimePath(): string;
}

// -- Detection & singleton ---------------------------------------------------

let _platform: Platform | null = null;

/**
 * Detect and return the platform singleton.
 * Detection: TERMUX_VERSION env → android, process.platform === "darwin" → darwin, else → linux.
 */
export function detectPlatform(): Platform {
  if (_platform) return _platform;

  let id: PlatformId;
  if (process.env.TERMUX_VERSION) {
    id = "android";
  } else if (process.platform === "darwin") {
    id = "darwin";
  } else {
    id = "linux";
  }

  // Lazy-load the implementation to avoid pulling in all platform code
  switch (id) {
    case "android": {
      const { AndroidPlatform } = require("./android.js");
      _platform = new AndroidPlatform();
      break;
    }
    case "darwin": {
      const { DarwinPlatform } = require("./darwin.js");
      _platform = new DarwinPlatform();
      break;
    }
    case "linux": {
      const { LinuxPlatform } = require("./linux.js");
      _platform = new LinuxPlatform();
      break;
    }
  }

  return _platform!;
}

/** Reset the platform singleton (for testing) */
export function resetPlatform(): void {
  _platform = null;
}
