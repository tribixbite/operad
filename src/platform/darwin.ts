/**
 * darwin.ts — macOS platform implementation
 *
 * Uses macOS-native tools (sysctl, vm_stat, ps, osascript, caffeinate, pmset)
 * instead of /proc for system introspection. Implements the Platform interface
 * for macOS desktops and laptops.
 */

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { BatteryInfo, Platform, SystemMemoryInfo } from "./platform.js";

/** macOS reports CLK_TCK as 100 (kern.clockrate → hz=100) */
const CLK_TCK = 100;

/**
 * Execute a command synchronously and return trimmed stdout, or null on failure.
 * Used throughout for small system queries where latency is acceptable.
 */
function execQuiet(cmd: string, args: string[], timeoutMs = 5000): string | null {
  try {
    const result = spawnSync(cmd, args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    /* command not found or timed out */
  }
  return null;
}

/**
 * Parse macOS ps time format "MM:SS.mm" into fractional seconds.
 * ps -o utime/stime outputs elapsed CPU time as minutes:seconds.centiseconds.
 * Returns NaN if the format is unrecognizable.
 */
function parsePsTime(timeStr: string): number {
  const trimmed = timeStr.trim();

  // Format: "MM:SS.mm" (e.g. "2:45.30" = 2min 45.30s)
  const match = trimmed.match(/^(\d+):(\d+)\.(\d+)$/);
  if (match) {
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    // Centiseconds — pad or truncate to 2 digits for consistency
    const centiseconds = parseInt(match[3].slice(0, 2).padEnd(2, "0"), 10);
    return minutes * 60 + seconds + centiseconds / 100;
  }

  // Some ps versions may output just seconds (unlikely on macOS, but be safe)
  const plain = parseFloat(trimmed);
  if (!isNaN(plain)) return plain;

  return NaN;
}

export class DarwinPlatform implements Platform {
  readonly id = "darwin" as const;
  readonly hasAdb = false;

  // -- Memory ---------------------------------------------------------------

  /**
   * Read system memory via sysctl + vm_stat.
   *
   * Total: `sysctl -n hw.memsize` (bytes → kB)
   * Available: vm_stat reports page counts; available ≈ free + inactive +
   *   speculative + purgeable pages. Page size from vm_stat header.
   * Swap: `sysctl -n vm.swapusage` (total/used/free in MB with suffixes)
   */
  getSystemMemory(): SystemMemoryInfo | null {
    // Total physical RAM in bytes
    const totalBytesStr = execQuiet("sysctl", ["-n", "hw.memsize"]);
    if (!totalBytesStr) return null;
    const totalBytes = parseInt(totalBytesStr, 10);
    if (isNaN(totalBytes)) return null;
    const total_kb = Math.round(totalBytes / 1024);

    // vm_stat for page-level memory breakdown
    const vmStatOutput = execQuiet("vm_stat", []);
    let available_kb = 0;

    if (vmStatOutput) {
      // First line: "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
      const pageSizeMatch = vmStatOutput.match(/page size of (\d+) bytes/);
      const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

      // Parse "Pages free:", "Pages inactive:", "Pages speculative:", "Pages purgeable:"
      const pageFields: Record<string, number> = {};
      for (const line of vmStatOutput.split("\n")) {
        const m = line.match(/^(.+?):\s+(\d+)/);
        if (m) {
          pageFields[m[1].trim()] = parseInt(m[2], 10);
        }
      }

      const freePages = pageFields["Pages free"] ?? 0;
      const inactivePages = pageFields["Pages inactive"] ?? 0;
      const speculativePages = pageFields["Pages speculative"] ?? 0;
      const purgeablePages = pageFields["Pages purgeable"] ?? 0;

      const availablePages = freePages + inactivePages + speculativePages + purgeablePages;
      available_kb = Math.round((availablePages * pageSize) / 1024);
    }

    // Swap from sysctl — format: "total = 2048.00M  used = 512.00M  free = 1536.00M  ..."
    let swap_total_kb = 0;
    let swap_free_kb = 0;

    const swapOutput = execQuiet("sysctl", ["-n", "vm.swapusage"]);
    if (swapOutput) {
      const totalMatch = swapOutput.match(/total\s*=\s*([\d.]+)M/);
      const usedMatch = swapOutput.match(/used\s*=\s*([\d.]+)M/);
      if (totalMatch) {
        swap_total_kb = Math.round(parseFloat(totalMatch[1]) * 1024);
      }
      if (totalMatch && usedMatch) {
        const totalMB = parseFloat(totalMatch[1]);
        const usedMB = parseFloat(usedMatch[1]);
        swap_free_kb = Math.round((totalMB - usedMB) * 1024);
      }
    }

    return { total_kb, available_kb, swap_total_kb, swap_free_kb };
  }

  // -- Process info ---------------------------------------------------------

  /**
   * Read CPU ticks for a single PID using `ps -o utime=,stime= -p PID`.
   * Converts MM:SS.mm times to ticks (seconds * CLK_TCK).
   */
  readProcessCpuTicks(pid: number): number | null {
    const output = execQuiet("ps", ["-o", "utime=,stime=", "-p", String(pid)]);
    if (!output) return null;

    // Output is two time fields separated by whitespace, e.g. "  0:02.45   0:00.12"
    const parts = output.trim().split(/\s+/);
    if (parts.length < 2) return null;

    const utime = parsePsTime(parts[0]);
    const stime = parsePsTime(parts[1]);
    if (isNaN(utime) || isNaN(stime)) return null;

    return Math.round((utime + stime) * CLK_TCK);
  }

  /**
   * Build full process tree from `ps -eo pid=,ppid=,utime=,stime=`.
   * Returns Map<ppid, children[]> matching the /proc version's structure.
   */
  buildProcessTree(): Map<number, { pid: number; ticks: number }[]> {
    const childrenOf = new Map<number, { pid: number; ticks: number }[]>();

    const output = execQuiet("ps", ["-eo", "pid=,ppid=,utime=,stime="]);
    if (!output) return childrenOf;

    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Each line: "  PID  PPID  MM:SS.mm  MM:SS.mm"
      const parts = trimmed.split(/\s+/);
      if (parts.length < 4) continue;

      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      const utime = parsePsTime(parts[2]);
      const stime = parsePsTime(parts[3]);

      if (isNaN(pid) || isNaN(ppid) || isNaN(utime) || isNaN(stime)) continue;

      const ticks = Math.round((utime + stime) * CLK_TCK);

      let children = childrenOf.get(ppid);
      if (!children) {
        children = [];
        childrenOf.set(ppid, children);
      }
      children.push({ pid, ticks });
    }

    return childrenOf;
  }

  /** Check if a process is alive via kill(pid, 0) signal test */
  isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read process working directory via lsof.
   * `lsof -a -p PID -d cwd -Fn` outputs "p<pid>\nn<path>" lines.
   */
  readProcessCwd(pid: number): string | null {
    const output = execQuiet("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    if (!output) return null;

    // Find the line starting with 'n' (name field) — that's the path
    for (const line of output.split("\n")) {
      if (line.startsWith("n") && line.length > 1) {
        return line.slice(1);
      }
    }
    return null;
  }

  /**
   * Walk ancestor chain to check if any parent has the given comm name.
   * Uses `ps -o ppid=,comm= -p PID` at each step. Stops at PID 1 or maxDepth.
   */
  hasAncestorComm(pid: number, comm: string, maxDepth = 15): boolean {
    let current = pid;

    for (let depth = 0; depth < maxDepth; depth++) {
      const output = execQuiet("ps", ["-o", "ppid=,comm=", "-p", String(current)]);
      if (!output) return false;

      const trimmed = output.trim();
      // Format: "  PPID /path/to/comm" or "  PPID comm"
      const parts = trimmed.split(/\s+/, 2);
      if (parts.length < 2) return false;

      const ppid = parseInt(parts[0], 10);
      if (isNaN(ppid) || ppid <= 1) return false;

      // comm may be a full path on macOS — extract basename
      const parentComm = parts[1].split("/").pop() ?? parts[1];
      if (parentComm === comm || parentComm.startsWith(comm + ":")) {
        return true;
      }

      current = ppid;
    }

    return false;
  }

  // -- Notifications --------------------------------------------------------

  /**
   * Send a macOS notification via osascript.
   * The `id` parameter is ignored — macOS notifications auto-dismiss and
   * AppleScript's `display notification` has no stable identifier mechanism.
   */
  notify(title: string, content: string, _id?: string): void {
    // Escape double quotes in title and content for AppleScript string safety
    const safeTitle = title.replace(/"/g, '\\"');
    const safeContent = content.replace(/"/g, '\\"');

    spawnSync("osascript", [
      "-e",
      `display notification "${safeContent}" with title "${safeTitle}"`,
    ], {
      timeout: 5000,
      stdio: "ignore",
    });
  }

  /**
   * Send a notification with raw osascript args.
   * Joins all args into a single AppleScript display notification command.
   */
  notifyWithArgs(args: string[]): void {
    const content = args.join(" ").replace(/"/g, '\\"');
    spawnSync("osascript", [
      "-e",
      `display notification "${content}"`,
    ], {
      timeout: 5000,
      stdio: "ignore",
    });
  }

  /** No-op — macOS notifications auto-dismiss, no stable ID to cancel */
  removeNotification(_id: string): void {
    // macOS has no straightforward API to remove a specific notification
  }

  // -- Battery --------------------------------------------------------------

  /**
   * Read battery status from `pmset -g batt`.
   *
   * Example output:
   *   Now drawing from 'AC Power'
   *    -InternalBattery-0 (id=1234567)	85%; charging; 1:23 remaining present: true
   *
   * Temperature from ioreg (value in centi-Celsius, divide by 100).
   * Returns null on desktop Macs without a battery.
   */
  getBatteryStatus(): BatteryInfo | null {
    const output = execQuiet("pmset", ["-g", "batt"]);
    if (!output) return null;

    // Check for InternalBattery line — desktop Macs won't have one
    const batteryLine = output.split("\n").find((l) => l.includes("InternalBattery"));
    if (!batteryLine) return null;

    // Extract percentage: "85%"
    const pctMatch = batteryLine.match(/(\d+)%/);
    const percentage = pctMatch ? parseInt(pctMatch[1], 10) : 0;

    // Charging status: "charging", "discharging", "charged", "AC attached"
    const charging =
      batteryLine.includes("charging") && !batteryLine.includes("discharging");

    // Temperature from ioreg — optional, not all Macs expose this
    let temperature = 0;
    const ioregOutput = execQuiet("ioreg", [
      "-r",
      "-n",
      "AppleSmartBattery",
      "-d",
      "1",
    ]);
    if (ioregOutput) {
      // "Temperature" = 2890  (centi-Celsius → 28.90 °C)
      const tempMatch = ioregOutput.match(/"Temperature"\s*=\s*(\d+)/);
      if (tempMatch) {
        temperature = parseInt(tempMatch[1], 10) / 100;
      }
    }

    return {
      percentage,
      charging,
      temperature,
      health: "UNKNOWN", // macOS doesn't expose a simple health string
    };
  }

  /**
   * Disable WiFi radio via networksetup.
   * Best-effort — may require admin privileges on some configurations.
   */
  disableRadios(): void {
    // en0 is the default WiFi interface on most Macs
    spawnSync("networksetup", ["-setairportpower", "en0", "off"], {
      timeout: 5000,
      stdio: "ignore",
    });
  }

  /** Re-enable WiFi radio */
  enableRadios(): void {
    spawnSync("networksetup", ["-setairportpower", "en0", "on"], {
      timeout: 5000,
      stdio: "ignore",
    });
  }

  /** Send a low-battery alert as a macOS notification with a sound */
  sendBatteryAlert(pct: number): void {
    const safeMsg = `Battery at ${pct}%. Connect charger.`;
    spawnSync("osascript", [
      "-e",
      `display notification "${safeMsg}" with title "Low Battery" sound name "Basso"`,
    ], {
      timeout: 5000,
      stdio: "ignore",
    });
  }

  // -- Wake lock ------------------------------------------------------------

  /**
   * Prevent idle sleep by spawning `caffeinate -i` detached.
   * The -i flag creates an assertion to prevent system idle sleep.
   * The process is unref'd so it outlives the parent if needed.
   */
  acquireWakeLock(): boolean {
    try {
      const child = spawn("caffeinate", ["-i"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  // -- Session env ----------------------------------------------------------

  /**
   * Build clean env for tmux child processes.
   * Strips Claude Code nesting variables to prevent "cannot launch inside
   * another CC session" errors. No LD_PRELOAD needed on macOS.
   */
  cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };

    // Strip Claude Code nesting indicators
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

  /** No special env needed for am commands on macOS (am doesn't exist here) */
  amEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
  }

  /** No-op — LD_PRELOAD injection is Android-only */
  ensureTmuxLdPreload(): void {
    // macOS doesn't need LD_PRELOAD for tmux
  }

  // -- Terminal tabs --------------------------------------------------------

  /**
   * Open a new Terminal.app tab attached to a tmux session.
   * Uses AppleScript to tell Terminal.app to run a tmux attach command.
   */
  createTerminalTab(sessionName: string): boolean {
    // Escape session name for shell safety within AppleScript
    const safeName = sessionName.replace(/'/g, "'\\''");

    const result = spawnSync("osascript", [
      "-e",
      `tell application "Terminal"
  activate
  do script "tmux attach -t '${safeName}'"
end tell`,
    ], {
      timeout: 10000,
      stdio: "ignore",
    });

    return result.status === 0;
  }

  /** Bring Terminal.app to foreground via AppleScript */
  bringTerminalToForeground(): void {
    spawnSync("osascript", [
      "-e",
      'tell application "Terminal" to activate',
    ], {
      timeout: 5000,
      stdio: "ignore",
    });
  }

  /**
   * Run a script in a new Terminal.app tab.
   * Changes to the working directory first, then exec's the script.
   */
  runScriptInTab(scriptPath: string, cwd: string, _tabName: string): boolean {
    // Escape paths for shell within AppleScript
    const safePath = scriptPath.replace(/'/g, "'\\''");
    const safeCwd = cwd.replace(/'/g, "'\\''");

    const result = spawnSync("osascript", [
      "-e",
      `tell application "Terminal"
  activate
  do script "cd '${safeCwd}' && exec '${safePath}'"
end tell`,
    ], {
      timeout: 10000,
      stdio: "ignore",
    });

    return result.status === 0;
  }

  // -- ADB (not available on macOS) -----------------------------------------

  /** ADB is not available on macOS (self-targeting) */
  resolveAdbPath(): string | null {
    return null;
  }

  /** No-op — phantom process killer is Android-specific */
  applyPhantomFix(_adbBin: string, _serialArgs: string[]): void {
    // Not applicable on macOS
  }

  /**
   * Resolve local IP address via `route -n get default` + ifconfig.
   * Falls back to scanning ifconfig output for a private IP.
   */
  resolveLocalIp(): string | null {
    // Primary: get default route interface, then its IP
    const routeOutput = execQuiet("route", ["-n", "get", "default"]);
    if (routeOutput) {
      const ifaceMatch = routeOutput.match(/interface:\s*(\S+)/);
      if (ifaceMatch) {
        const ifconfigOutput = execQuiet("ifconfig", [ifaceMatch[1]]);
        if (ifconfigOutput) {
          // Match inet (IPv4) address, skip 127.x.x.x
          const inetMatch = ifconfigOutput.match(/inet\s+((?!127\.)\d+\.\d+\.\d+\.\d+)/);
          if (inetMatch) return inetMatch[1];
        }
      }
    }

    // Fallback: scan all interfaces for a private IP
    const allIfconfig = execQuiet("ifconfig", []);
    if (allIfconfig) {
      const privateIpMatch = allIfconfig.match(
        /inet\s+((?:192\.168|10\.|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+)/
      );
      if (privateIpMatch) return privateIpMatch[1];
    }

    return null;
  }

  // -- Budget ---------------------------------------------------------------

  /** Always 0 — phantom process counting is Android-only */
  countPhantomProcesses(): number {
    return 0;
  }

  // -- Paths ----------------------------------------------------------------

  /**
   * Config file search paths in priority order.
   * Supports current (operad) and legacy (drey, tmx) names.
   */
  configPaths(): string[] {
    const home = homedir();
    return [
      `${home}/.config/operad/operad.toml`,
      `${home}/.config/drey/drey.toml`,
      `${home}/.config/tmx/tmx.toml`,
    ];
  }

  /** Default IPC socket in /tmp (writable without Termux $PREFIX) */
  defaultSocketPath(): string {
    return "/tmp/operad.sock";
  }

  /** Default state file path under XDG-style data dir */
  defaultStatePath(): string {
    return `${homedir()}/.local/share/operad/state.json`;
  }

  /** Default log directory under XDG-style data dir */
  defaultLogDir(): string {
    return `${homedir()}/.local/share/operad/logs`;
  }

  /**
   * Resolve full path for a named binary.
   * Tries `which` first, then /usr/local/bin (Homebrew default), then bare name.
   */
  resolveBinaryPath(name: string): string {
    // Prefer `which` for PATH-resolved location
    const whichResult = execQuiet("which", [name]);
    if (whichResult) return whichResult;

    // Homebrew default install location
    const homebrewPath = `/usr/local/bin/${name}`;
    // Also check Apple Silicon Homebrew path
    const armHomebrewPath = `/opt/homebrew/bin/${name}`;

    try {
      // Check /usr/local/bin first (Intel Mac Homebrew)
      const result = spawnSync("test", ["-x", homebrewPath], {
        timeout: 1000,
        stdio: "ignore",
      });
      if (result.status === 0) return homebrewPath;
    } catch { /* fall through */ }

    try {
      // Check /opt/homebrew/bin (Apple Silicon Homebrew)
      const result = spawnSync("test", ["-x", armHomebrewPath], {
        timeout: 1000,
        stdio: "ignore",
      });
      if (result.status === 0) return armHomebrewPath;
    } catch { /* fall through */ }

    // Last resort: bare name, let PATH resolve at execution time
    return name;
  }

  /**
   * Resolve the runtime binary path for spawning child processes.
   * Prefers bun, falls back to node, then process.argv[0].
   */
  resolveRuntimePath(): string {
    const bunPath = execQuiet("which", ["bun"]);
    if (bunPath) return bunPath;

    const nodePath = execQuiet("which", ["node"]);
    if (nodePath) return nodePath;

    // Last resort — may be the raw binary path
    return process.argv[0];
  }
}
