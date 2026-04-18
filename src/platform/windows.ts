/**
 * windows.ts — Windows platform implementation
 *
 * Implements the Platform interface for Windows (win32).
 *
 * Key notes:
 * - tmux is not native to Windows; users install it via MSYS2 (`pacman -S tmux`)
 *   or run inside WSL. operad does NOT ship tmux.
 * - State/log paths use %LOCALAPPDATA%\operad\ (Windows convention).
 * - Unix sockets are supported on Windows 10+ via Node/Bun; we use a named
 *   socket under %LOCALAPPDATA%\operad\operad.sock.
 * - Process info uses `tasklist` (CSV output) since /proc does not exist.
 * - Battery, wake lock, radio control, phantom budget, and terminal tabs
 *   are no-ops on Windows (stubbed to return sensible defaults).
 * - Notifications use PowerShell's BurntToast-compatible approach via
 *   msg.exe or a simple PowerShell toast — gracefully no-ops if unavailable.
 */

import { existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Platform, PlatformId, SystemMemoryInfo, BatteryInfo } from "./platform.js";

// -- Path helpers -------------------------------------------------------------

/**
 * Resolve the Windows %LOCALAPPDATA% directory.
 * Falls back to %USERPROFILE%\AppData\Local if the env var is missing.
 */
function localAppData(): string {
  return (
    process.env.LOCALAPPDATA ??
    join(process.env.USERPROFILE ?? homedir(), "AppData", "Local")
  );
}

/** Base directory for operad state/logs/socket on Windows */
function operadBase(): string {
  return join(localAppData(), "operad");
}

// -- WindowsPlatform ----------------------------------------------------------

/**
 * Windows platform implementation of the Platform interface.
 *
 * /proc does not exist on Windows, so process introspection is approximated
 * using `tasklist`. Methods that require POSIX-only capabilities (battery,
 * wake lock, radios, terminal tabs, phantom budget) return null / false / 0
 * or perform no-ops.
 */
export class WindowsPlatform implements Platform {
  readonly id: PlatformId = "windows";
  readonly hasAdb = false;

  // -- Memory ------------------------------------------------------------------

  /**
   * Read system memory via `wmic os get FreePhysicalMemory,TotalVisibleMemorySize`.
   * Returns null if wmic is unavailable or output cannot be parsed.
   */
  getSystemMemory(): SystemMemoryInfo | null {
    try {
      const result = spawnSync(
        "wmic",
        ["os", "get", "FreePhysicalMemory,TotalVisibleMemorySize", "/FORMAT:CSV"],
        {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (result.status !== 0 || !result.stdout) return null;

      // CSV output has a header row + blank line + data row:
      //   Node,FreePhysicalMemory,TotalVisibleMemorySize
      //   HOSTNAME,1234567,8388608
      const lines = result.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        const parts = line.split(",");
        // Expect: Node, FreePhysicalMemory, TotalVisibleMemorySize
        if (parts.length < 3) continue;
        const free = parseInt(parts[1], 10);
        const total = parseInt(parts[2], 10);
        if (!isNaN(free) && !isNaN(total) && total > 0) {
          return {
            // wmic returns values in kB already
            total_kb: total,
            available_kb: free,
            swap_total_kb: 0, // swap info requires additional wmic query
            swap_free_kb: 0,
          };
        }
      }
    } catch {
      /* wmic not available or timed out */
    }
    return null;
  }

  // -- Process info ------------------------------------------------------------

  /**
   * Read CPU ticks for a PID.
   * Windows does not expose /proc/PID/stat. We return null — the ActivityDetector
   * degrades gracefully when ticks are unavailable.
   */
  readProcessCpuTicks(_pid: number): number | null {
    return null;
  }

  /**
   * Build process tree using `tasklist /FO CSV /NH`.
   * Returns an empty map — the tree is used for CPU tracking which is unsupported
   * on Windows without /proc. Callers handle empty maps gracefully.
   */
  buildProcessTree(): Map<number, { pid: number; ticks: number }[]> {
    return new Map();
  }

  /**
   * Check if a process is alive via `tasklist /FI "PID eq <pid>"`.
   * Falls back to false on error.
   */
  isProcessAlive(pid: number): boolean {
    try {
      const result = spawnSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (result.status !== 0 || !result.stdout) return false;
      // tasklist returns "INFO: No tasks are running which match the specified criteria."
      // if the process doesn't exist; otherwise it prints a CSV row.
      return result.stdout.includes(`"${pid}"`);
    } catch {
      return false;
    }
  }

  /**
   * Read the cwd of a process.
   * Not available without /proc on Windows — returns null.
   */
  readProcessCwd(_pid: number): string | null {
    return null;
  }

  /**
   * Walk ancestor chain to find a comm match.
   * Not implemented on Windows — returns false.
   */
  hasAncestorComm(_pid: number, _comm: string, _maxDepth?: number): boolean {
    return false;
  }

  // -- Notifications -----------------------------------------------------------

  /**
   * Send a notification via PowerShell's New-BurntToastNotification if available,
   * falling back to a simple powershell MessageBox. Silently no-ops on failure.
   */
  notify(title: string, content: string, _id?: string): void {
    // Attempt a lightweight PowerShell toast notification (Windows 10+)
    try {
      spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // Use the Windows API via COM to show a tray notification
          `
          $notif = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
          $template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
          $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)
          $nodes = $xml.GetElementsByTagName('text')
          $nodes.Item(0).AppendChild($xml.CreateTextNode('${title.replace(/'/g, "''")}')) | Out-Null
          $nodes.Item(1).AppendChild($xml.CreateTextNode('${content.replace(/'/g, "''")}')) | Out-Null
          $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
          $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('operad')
          $notifier.Show($toast)
          `.trim(),
        ],
        { timeout: 5000, stdio: "ignore" },
      );
    } catch {
      // Notification is best-effort — non-fatal
    }
  }

  /** Send a notification with raw args — maps title+content heuristically */
  notifyWithArgs(args: string[]): void {
    // Extract title/content from common arg patterns and delegate
    const titleIdx = args.indexOf("--title");
    const contentIdx = args.indexOf("--content");
    const title = titleIdx >= 0 ? (args[titleIdx + 1] ?? "operad") : "operad";
    const content = contentIdx >= 0 ? (args[contentIdx + 1] ?? "") : args.join(" ");
    this.notify(title, content);
  }

  /** Remove a notification — no standardized dismiss API on Windows */
  removeNotification(_id: string): void {
    // No-op: Windows toast notifications auto-dismiss; no remove-by-id API from CLI
  }

  /** Kill tracked notification processes — no-op on Windows */
  killTrackedNotifyProcesses(): void {
    // Windows toast notifications are fire-and-forget PowerShell invocations
  }

  /** Kill stale notification processes — no-op on Windows */
  killStaleNotifyProcesses(): number {
    return 0;
  }

  // -- Battery -----------------------------------------------------------------

  /**
   * Read battery status via `Get-WmiObject Win32_Battery` in PowerShell.
   * Returns null if no battery is found (desktops) or PowerShell unavailable.
   */
  getBatteryStatus(): BatteryInfo | null {
    try {
      const result = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-WmiObject Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json",
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (result.status !== 0 || !result.stdout?.trim()) return null;

      const data = JSON.parse(result.stdout.trim()) as {
        EstimatedChargeRemaining?: number;
        BatteryStatus?: number;
      };
      if (!data || data.EstimatedChargeRemaining == null) return null;

      // BatteryStatus: 1=Discharging, 2=AC, 3=Fully Charged, 4-9=Charging variants
      const charging = (data.BatteryStatus ?? 1) !== 1;

      return {
        percentage: data.EstimatedChargeRemaining,
        charging,
        temperature: 0, // not exposed by Win32_Battery
        health: "UNKNOWN",
      };
    } catch {
      return null;
    }
  }

  /** Disable radios — not applicable on Windows desktops */
  disableRadios(): void {
    // No-op: radio control is Android-specific
  }

  /** Re-enable radios — not applicable on Windows */
  enableRadios(): void {
    // No-op: radio control is Android-specific
  }

  /** Send a low-battery alert via notification */
  sendBatteryAlert(pct: number): void {
    this.notify("LOW BATTERY", `Battery at ${pct}% and not charging.`);
  }

  // -- Wake lock ---------------------------------------------------------------

  /**
   * Acquire a sleep inhibitor on Windows.
   * Uses `powercfg /requests` heuristic — not a true lock, but prevents
   * screensaver-induced sleep on most configurations. Returns false since
   * there is no equivalent of systemd-inhibit or termux-wake-lock.
   *
   * TODO: implement via SetThreadExecutionState Win32 API via PowerShell if needed
   */
  acquireWakeLock(): boolean {
    return false;
  }

  // -- Session env -------------------------------------------------------------

  /**
   * Build clean env for tmux child processes.
   * Strips Claude nesting detection vars — identical logic to linux.ts.
   * No LD_PRELOAD injection needed on Windows.
   */
  cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };

    delete env.CLAUDECODE;
    delete env.CLAUDE_TMPDIR;

    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDE_CODE_") || key.startsWith("ENABLE_CLAUDE_CODE_")) {
        delete env[key];
      }
    }

    return env;
  }

  /**
   * Build env for am/termux-am commands.
   * No-op on Windows — there are no Android activity manager commands.
   */
  amEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
  }

  /**
   * Inject LD_PRELOAD into tmux environment.
   * No-op on Windows — libtermux-exec is Android-only.
   */
  ensureTmuxLdPreload(): void {
    // Not applicable on Windows
  }

  // -- Terminal tabs -----------------------------------------------------------

  /**
   * Create a terminal tab — not applicable on Windows (no tmux terminal app).
   * Users interact with tmux via MSYS2/WSL terminals directly.
   */
  createTerminalTab(_sessionName: string): boolean {
    return false;
  }

  /** Bring terminal to foreground — no-op on Windows */
  bringTerminalToForeground(): void {
    // No standardized way to focus a console window cross-terminal on Windows
  }

  /** Run a script in a new terminal tab — not applicable on Windows */
  runScriptInTab(_scriptPath: string, _cwd: string, _tabName: string): boolean {
    return false;
  }

  // -- ADB ---------------------------------------------------------------------

  /** ADB binary — not applicable on Windows (no Android platform tools needed) */
  resolveAdbPath(): string | null {
    return null;
  }

  /** Apply Android phantom fix — no-op on Windows */
  applyPhantomFix(_adbBin: string, _serialArgs: string[]): void {
    // Android-specific; not applicable on Windows
  }

  /**
   * Resolve local IP address via `ipconfig`.
   * Returns the first non-loopback IPv4 address found, or null.
   */
  resolveLocalIp(): string | null {
    try {
      const result = spawnSync("ipconfig", [], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0 || !result.stdout) return null;
      // Match first IPv4 Address line (e.g. "   IPv4 Address. . . : 192.168.1.10")
      const match = result.stdout.match(/IPv4 Address[^:]*:\s*(\d+\.\d+\.\d+\.\d+)/i);
      if (match) return match[1];
    } catch { /* fall through */ }
    return null;
  }

  // -- Budget ------------------------------------------------------------------

  /** Count phantom processes — always 0 on Windows (Android-only concept) */
  countPhantomProcesses(): number {
    return 0;
  }

  // -- Paths -------------------------------------------------------------------

  /**
   * Config file search paths in priority order.
   * Uses %APPDATA%\operad (roaming) or %USERPROFILE%\.config\operad (XDG-style)
   * depending on what already exists — new installs land in %APPDATA%\operad.
   */
  configPaths(): string[] {
    const appData =
      process.env.APPDATA ??
      join(process.env.USERPROFILE ?? homedir(), "AppData", "Roaming");
    const userProfile = process.env.USERPROFILE ?? homedir();
    return [
      join(appData, "operad", "operad.toml"),
      join(userProfile, ".config", "operad", "operad.toml"),
    ];
  }

  /**
   * Default IPC socket path.
   * Node.js + Bun support Unix-domain sockets on Windows 10+ (AF_UNIX).
   * Store the socket under %LOCALAPPDATA%\operad\ alongside state.
   */
  defaultSocketPath(): string {
    return join(operadBase(), "operad.sock");
  }

  /** Default state file path under %LOCALAPPDATA%\operad\state.json */
  defaultStatePath(): string {
    return join(operadBase(), "state.json");
  }

  /** Default log directory under %LOCALAPPDATA%\operad\logs\ */
  defaultLogDir(): string {
    return join(operadBase(), "logs");
  }

  /**
   * Resolve full path for a named binary.
   * Uses `where` (Windows equivalent of `which`) to find the binary on PATH.
   */
  resolveBinaryPath(name: string): string {
    try {
      const result = spawnSync("where", [name], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const resolved = result.stdout?.split("\n")[0]?.trim();
      if (result.status === 0 && resolved) return resolved;
    } catch {
      // Fall through to bare name
    }
    return name;
  }

  /**
   * Resolve the runtime (bun/node) wrapper path for spawning child processes.
   * Uses `where` to locate bun or node on PATH.
   */
  resolveRuntimePath(): string {
    // Try bun first (preferred runtime)
    try {
      const result = spawnSync("where", ["bun"], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const resolved = result.stdout?.split("\n")[0]?.trim();
      if (result.status === 0 && resolved) return resolved;
    } catch { /* fall through */ }

    // Try node
    try {
      const result = spawnSync("where", ["node"], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const resolved = result.stdout?.split("\n")[0]?.trim();
      if (result.status === 0 && resolved) return resolved;
    } catch { /* fall through */ }

    return process.argv[0];
  }
}
