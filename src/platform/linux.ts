/**
 * linux.ts — Desktop Linux platform implementation
 *
 * Delegates /proc operations to common.ts helpers (shared with Android).
 * Uses notify-send for desktop notifications. Gracefully no-ops for
 * Android-specific features (ADB, terminal tabs, radio control, phantom processes).
 * Uses systemd-inhibit for sleep inhibition when available.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
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

/**
 * Desktop Linux implementation of the Platform interface.
 *
 * Procfs operations are identical to Android — the common.ts helpers cover both.
 * Desktop-specific: notify-send for notifications, /sys/class/power_supply/BAT0
 * for battery, systemd-inhibit for wake/sleep lock.
 */
export class LinuxPlatform implements Platform {
  readonly id: PlatformId = "linux";
  readonly hasAdb = false;

  // -- Memory ----------------------------------------------------------------

  /** Read system memory from /proc/meminfo (identical to Android) */
  getSystemMemory(): SystemMemoryInfo | null {
    return readProcMeminfo();
  }

  // -- Process info ----------------------------------------------------------

  /** Read utime+stime CPU ticks for a PID from /proc/PID/stat */
  readProcessCpuTicks(pid: number): number | null {
    return readProcStatCpuTicks(pid);
  }

  /** Build process tree from /proc: ppid → children with CPU ticks */
  buildProcessTree(): Map<number, { pid: number; ticks: number }[]> {
    return buildProcTree();
  }

  /** Check if a process is alive via /proc/PID existence */
  isProcessAlive(pid: number): boolean {
    return isProcAlive(pid);
  }

  /** Read the cwd of a process via /proc/PID/cwd symlink */
  readProcessCwd(pid: number): string | null {
    return readProcCwd(pid);
  }

  /** Walk ancestor chain to check if any parent has the given comm name */
  hasAncestorComm(pid: number, comm: string, maxDepth?: number): boolean {
    return hasProcAncestorComm(pid, comm, maxDepth);
  }

  // -- Notifications ---------------------------------------------------------

  /**
   * Send a desktop notification via notify-send.
   * If id is provided, attempts --replace-id (supported by libnotify-based
   * implementations like GNOME, but not universally available).
   */
  notify(title: string, content: string, id?: string): void {
    const args: string[] = [];
    if (id) {
      // --replace-id is a GNOME/libnotify extension — harmless if unsupported
      args.push("--replace-id", id);
    }
    args.push(title, content);
    spawnSync("notify-send", args, {
      timeout: 5000,
      stdio: "ignore",
    });
  }

  /** Send a notification with raw args passed directly to notify-send */
  notifyWithArgs(args: string[]): void {
    spawnSync("notify-send", args, {
      timeout: 5000,
      stdio: "ignore",
    });
  }

  /** Remove a notification by id — not supported by notify-send (no-op) */
  removeNotification(_id: string): void {
    // notify-send is fire-and-forget; no dismiss/remove API exists
  }

  killTrackedNotifyProcesses(): void {
    // No-op on Linux desktop — notify-send doesn't hang
  }

  // -- Battery ---------------------------------------------------------------

  /**
   * Read battery status from /sys/class/power_supply/BAT0/.
   * Returns null if BAT0 doesn't exist (desktop without battery, or different
   * power supply naming). This covers most laptops; servers return null.
   */
  getBatteryStatus(): BatteryInfo | null {
    const base = "/sys/class/power_supply/BAT0";
    if (!existsSync(base)) return null;

    try {
      const capacity = parseInt(
        readFileSync(`${base}/capacity`, "utf-8").trim(),
        10,
      );
      const statusStr = readFileSync(`${base}/status`, "utf-8").trim();

      // Temperature: BAT0/temp is in tenths of a degree Celsius on many kernels
      let temperature = 0;
      try {
        temperature = parseInt(
          readFileSync(`${base}/temp`, "utf-8").trim(),
          10,
        ) / 10;
      } catch {
        // temp file is optional — many desktop batteries don't expose it
      }

      return {
        percentage: isNaN(capacity) ? 0 : capacity,
        charging: statusStr === "Charging" || statusStr === "Full",
        temperature,
        health: "UNKNOWN", // Desktop Linux doesn't expose battery health like Android
      };
    } catch {
      return null;
    }
  }

  /**
   * Disable radios — not applicable on desktop Linux.
   * NetworkManager could be scripted, but that's too intrusive for an
   * orchestrator. Log a warning so the caller knows it's a no-op.
   */
  disableRadios(): void {
    console.log("[linux] disableRadios: no-op on desktop Linux (use NetworkManager directly)");
  }

  /** Re-enable radios — not applicable on desktop Linux */
  enableRadios(): void {
    // No-op: radio control is Android-specific
  }

  /** Send a critical battery alert via notify-send */
  sendBatteryAlert(pct: number): void {
    spawnSync("notify-send", [
      "--urgency=critical",
      "LOW BATTERY",
      `Battery at ${pct}% and not charging.`,
    ], {
      timeout: 5000,
      stdio: "ignore",
    });
  }

  // -- Wake lock -------------------------------------------------------------

  /**
   * Acquire a sleep inhibitor via systemd-inhibit.
   * Spawns a detached `systemd-inhibit sleep infinity` process that keeps the
   * idle inhibitor active for the daemon's lifetime. Returns false if
   * systemd-inhibit is not available (non-systemd distros).
   */
  acquireWakeLock(): boolean {
    try {
      // Check if systemd-inhibit exists before trying
      const check = spawnSync("which", ["systemd-inhibit"], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (check.status !== 0) return false;

      // Spawn detached — survives parent exit. The inhibitor stays active
      // as long as the child process lives; when daemon shuts down,
      // the child is orphaned and eventually reaped, releasing the lock.
      const child = spawn(
        "systemd-inhibit",
        [
          "--what=idle",
          "--who=operad",
          "--why=Session orchestrator active",
          "--mode=block",
          "sleep", "infinity",
        ],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  // -- Session env -----------------------------------------------------------

  /**
   * Build clean env for tmux child processes.
   * Strips Claude nesting variables so spawned Claude sessions don't think
   * they're inside another CC session. No LD_PRELOAD injection needed
   * on desktop Linux (that's an Android/bun-termux workaround).
   */
  cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };

    // Strip Claude Code nesting detection vars
    delete env.CLAUDECODE;
    delete env.CLAUDE_TMPDIR;

    // Remove all CLAUDE_CODE_* and ENABLE_CLAUDE_CODE_* env vars
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDE_CODE_") || key.startsWith("ENABLE_CLAUDE_CODE_")) {
        delete env[key];
      }
    }

    return env;
  }

  /**
   * Build env for am/termux-am commands.
   * No-op on desktop Linux — there are no Android activity manager commands.
   */
  amEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
  }

  /**
   * Inject LD_PRELOAD into tmux global environment.
   * No-op on desktop Linux — libtermux-exec is Android-only.
   */
  ensureTmuxLdPreload(): void {
    // Not needed on desktop Linux
  }

  // -- Terminal tabs ---------------------------------------------------------

  /**
   * Create a terminal tab attached to a tmux session.
   * On desktop Linux, tmux sessions are accessed directly — no tab creation needed.
   */
  createTerminalTab(_sessionName: string): boolean {
    return false;
  }

  /** Bring the terminal app to foreground — no-op on desktop */
  bringTerminalToForeground(): void {
    // Desktop window managers handle focus; no automated action needed
  }

  /** Run a script in a new terminal tab — not applicable on desktop */
  runScriptInTab(_scriptPath: string, _cwd: string, _tabName: string): boolean {
    return false;
  }

  // -- ADB -------------------------------------------------------------------

  /** ADB binary path — not applicable on desktop Linux */
  resolveAdbPath(): string | null {
    return null;
  }

  /** Apply Android phantom process killer fix — no-op on desktop */
  applyPhantomFix(_adbBin: string, _serialArgs: string[]): void {
    // Android-specific OOM/phantom process protections not needed on desktop
  }

  /** Resolve local IP address via ip route */
  resolveLocalIp(): string | null {
    return resolveLocalIpViaRoute();
  }

  // -- Budget ----------------------------------------------------------------

  /** Count phantom processes — always 0 on desktop (no Android phantom limit) */
  countPhantomProcesses(): number {
    return 0;
  }

  // -- Paths -----------------------------------------------------------------

  /**
   * Config file search paths in priority order.
   * Follows XDG conventions: ~/.config/<app>/
   * Checks operad (current), drey (previous), tmx (legacy) names.
   */
  configPaths(): string[] {
    const home = homedir();
    return [
      join(home, ".config", "operad", "operad.toml"),
      join(home, ".config", "drey", "drey.toml"),
      join(home, ".config", "tmx", "tmx.toml"),
    ];
  }

  /**
   * Default IPC socket path.
   * Prefers $XDG_RUNTIME_DIR (typically /run/user/<uid>, tmpfs, cleaned on logout).
   * Falls back to /tmp if XDG_RUNTIME_DIR is not set.
   */
  defaultSocketPath(): string {
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    if (runtimeDir && existsSync(runtimeDir)) {
      return join(runtimeDir, "operad.sock");
    }
    return "/tmp/operad.sock";
  }

  /** Default state file path under ~/.local/share/operad/ */
  defaultStatePath(): string {
    return join(homedir(), ".local", "share", "operad", "state.json");
  }

  /** Default log directory under ~/.local/share/operad/logs/ */
  defaultLogDir(): string {
    return join(homedir(), ".local", "share", "operad", "logs");
  }

  /**
   * Resolve full path for a named binary.
   * Uses `which` to find the binary on PATH; returns the bare name as
   * fallback (lets the shell resolve it at exec time).
   */
  resolveBinaryPath(name: string): string {
    try {
      const result = spawnSync("which", [name], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const resolved = result.stdout?.trim();
      if (result.status === 0 && resolved) return resolved;
    } catch {
      // Fall through to bare name
    }
    return name;
  }

  /**
   * Resolve the runtime (bun/node) wrapper path for spawning child processes.
   * Prefers bun, falls back to node, last resort process.argv[0].
   * Unlike Android/Termux, no special wrapper detection is needed on desktop.
   */
  resolveRuntimePath(): string {
    // Try bun first (preferred runtime)
    try {
      const result = spawnSync("which", ["bun"], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const resolved = result.stdout?.trim();
      if (result.status === 0 && resolved) return resolved;
    } catch {
      // Fall through
    }

    // Try node
    try {
      const result = spawnSync("which", ["node"], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const resolved = result.stdout?.trim();
      if (result.status === 0 && resolved) return resolved;
    } catch {
      // Fall through
    }

    // Last resort: the current process binary
    return process.argv[0];
  }
}
