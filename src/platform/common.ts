/**
 * common.ts — Shared /proc helpers for Android and Linux
 *
 * Both platforms use procfs for memory, CPU ticks, process trees, and
 * process introspection. These helpers are imported by android.ts and linux.ts.
 */

import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { SystemMemoryInfo } from "./platform.js";

/**
 * Pure parser: extract SystemMemoryInfo from the text content of /proc/meminfo.
 *
 * Returns **null** when the two load-bearing fields are absent, rather than
 * defaulting them to 0.
 *
 * Defaulting was actively dangerous: `available_kb: 0` is not "unknown", it is
 * "no memory left". A truncated or unusual /proc/meminfo therefore classified
 * as `emergency`, which SIGSTOPs every idle session and force-stops flagged
 * Android apps every 5s — and because the reading never improves, pressure
 * never returns to `normal`, so the auto-resume branch never runs and the
 * sessions stay frozen. Callers already treat null as "unknown" and hold at
 * `normal`, which is the correct fail-safe direction.
 *
 * Swap fields keep the 0 default: absent swap genuinely means zero swap.
 *
 * Extracted so it can be unit-tested with fixture strings.
 */
export function parseMeminfo(content: string): SystemMemoryInfo | null {
  const fields = new Map<string, number>();

  for (const line of content.split("\n")) {
    const match = line.match(/^(\w+):\s+(\d+)\s+kB/);
    if (match) {
      fields.set(match[1], parseInt(match[2], 10));
    }
  }

  const total = fields.get("MemTotal");
  const available = fields.get("MemAvailable");
  // MemTotal of 0 is equally nonsensical and would make every percentage
  // computation divide by zero.
  if (total == null || available == null || total <= 0) return null;

  return {
    total_kb: total,
    available_kb: available,
    swap_total_kb: fields.get("SwapTotal") ?? 0,
    swap_free_kb: fields.get("SwapFree") ?? 0,
  };
}

/**
 * Parse /proc/meminfo into a SystemMemoryInfo struct.
 * Returns null if /proc/meminfo is unreadable.
 */
export function readProcMeminfo(): SystemMemoryInfo | null {
  try {
    const content = readFileSync("/proc/meminfo", "utf-8");
    return parseMeminfo(content);
  } catch {
    return null;
  }
}

/**
 * Read utime + stime from /proc/PID/stat.
 * Fields 14+15 (1-indexed). The comm field (2) can contain spaces/parens,
 * so we parse after the last ')'.
 */
export function readProcStatCpuTicks(pid: number): number | null {
  try {
    const content = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return parseProcStatTicks(content);
  } catch {
    return null;
  }
}

/** Parse utime + stime from a /proc/PID/stat line */
export function parseProcStatTicks(statLine: string): number | null {
  const closeParen = statLine.lastIndexOf(")");
  if (closeParen === -1) return null;

  const fields = statLine.slice(closeParen + 2).split(" ");
  // After ')' and space: index 11=utime (field 14), 12=stime (field 15)
  const utime = parseInt(fields[11], 10);
  const stime = parseInt(fields[12], 10);

  if (isNaN(utime) || isNaN(stime)) return null;
  return utime + stime;
}

/**
 * Pure parser: extract the parent PID (ppid) from a /proc/PID/stat line.
 * The comm field (index 2) can contain spaces and parentheses, so we anchor
 * after the LAST ')' in the line — the same strategy used for ticks.
 * Returns null for malformed lines (no ')', non-numeric ppid).
 * Extracted so it can be unit-tested independently.
 */
export function parseProcStatPpid(statLine: string): number | null {
  const closeParen = statLine.lastIndexOf(")");
  if (closeParen === -1) return null;

  // After ')' + ' ' + state + ' ': fields[0]=state, fields[1]=ppid
  const fields = statLine.slice(closeParen + 2).split(" ");
  const ppid = parseInt(fields[1], 10);
  if (isNaN(ppid)) return null;
  return ppid;
}

/**
 * Build process tree from /proc: maps ppid → children with CPU ticks.
 * Scans all numeric entries in /proc, reads each stat file.
 */
export function buildProcTree(): Map<number, { pid: number; ticks: number }[]> {
  const childrenOf = new Map<number, { pid: number; ticks: number }[]>();

  try {
    const procEntries = readdirSync("/proc").filter((e) => /^\d+$/.test(e));

    for (const entry of procEntries) {
      try {
        const pid = parseInt(entry, 10);
        const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
        const ppid = parseProcStatPpid(stat);
        const ticks = parseProcStatTicks(stat);
        if (ppid === null || ticks === null) continue;

        let children = childrenOf.get(ppid);
        if (!children) {
          children = [];
          childrenOf.set(ppid, children);
        }
        children.push({ pid, ticks });
      } catch {
        // Process may have exited between readdir and stat read
      }
    }
  } catch {
    // Can't read /proc
  }

  return childrenOf;
}

/** Check if a process is alive by testing for /proc/PID */
export function isProcAlive(pid: number): boolean {
  return existsSync(`/proc/${pid}`);
}

/** Read the cwd of a process via /proc/PID/cwd symlink */
export function readProcCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Walk the ancestor chain of a PID using /proc/PID/stat (ppid)
 * and /proc/PID/comm. Returns true if any ancestor's comm matches.
 * Stops after maxDepth hops or at PID 1.
 */
export function hasProcAncestorComm(pid: number, comm: string, maxDepth = 15): boolean {
  let current = pid;
  for (let depth = 0; depth < maxDepth; depth++) {
    // Read ppid from /proc/PID/stat using the shared pure parser
    let ppid: number;
    try {
      const stat = readFileSync(`/proc/${current}/stat`, "utf-8");
      const parsed = parseProcStatPpid(stat);
      if (parsed === null) return false;
      ppid = parsed;
    } catch {
      return false;
    }

    if (ppid <= 1) return false;

    // Check if parent's comm matches
    try {
      const parentComm = readFileSync(`/proc/${ppid}/comm`, "utf-8").trim();
      if (parentComm === comm || parentComm.startsWith(comm + ":")) return true;
    } catch {
      return false;
    }

    current = ppid;
  }
  return false;
}

/**
 * Resolve local IP address via `ip route get 1`.
 * Returns the src address, or null if unavailable.
 */
export function resolveLocalIpViaRoute(): string | null {
  try {
    const result = spawnSync("ip", ["route", "get", "1"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.stdout) {
      const match = result.stdout.match(/src\s+(\S+)/);
      if (match) return match[1];
    }
  } catch { /* fall through */ }

  // Fallback: ifconfig
  try {
    const result = spawnSync("ifconfig", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.stdout) {
      const match = result.stdout.match(/inet\s+((?:192|10|172)\.\d+\.\d+\.\d+)/);
      if (match) return match[1];
    }
  } catch { /* no network info */ }

  return null;
}
