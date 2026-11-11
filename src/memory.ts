/**
 * memory.ts — System and per-process memory monitoring
 *
 * Parses /proc/meminfo for system-wide stats and uses `ps` to compute
 * per-session RSS including all child processes (MCP servers, LSP, etc.).
 * Defines pressure levels for dashboard display.
 */

import { execSync } from "node:child_process";
import type { Logger } from "./log.js";
import { detectPlatform } from "./platform/platform.js";
import { getSessionPanePids } from "./session.js";

/** Memory pressure levels based on MemAvailable thresholds */
export type MemoryPressure = "normal" | "warning" | "critical" | "emergency";

/** MemAvailable thresholds (MB) below which each pressure band activates */
export interface PressureThresholds {
  warningMb: number;
  criticalMb: number;
  emergencyMb: number;
}

/**
 * Classify memory pressure from MemAvailable (MB) against thresholds.
 * Pure. Strict less-than, emergency checked first — so a value exactly at a
 * threshold lands in the safer (less-severe) band.
 */
export function classifyPressure(availableMb: number, t: PressureThresholds): MemoryPressure {
  if (availableMb < t.emergencyMb) return "emergency";
  if (availableMb < t.criticalMb) return "critical";
  if (availableMb < t.warningMb) return "warning";
  return "normal";
}

/**
 * Used-memory percentage from total + available (MB). Pure.
 * Guards against a zero/negative denominator (returns 0).
 */
export function computeUsedPct(totalMb: number, availableMb: number): number {
  return totalMb > 0 ? Math.round(((totalMb - availableMb) / totalMb) * 100) : 0;
}

/** System-wide memory snapshot */
export interface SystemMemory {
  /** Total physical RAM in MB */
  total_mb: number;
  /** Available memory in MB (MemAvailable from /proc/meminfo) */
  available_mb: number;
  /** Total swap in MB */
  swap_total_mb: number;
  /** Free swap in MB */
  swap_free_mb: number;
  /** Current pressure level */
  pressure: MemoryPressure;
  /** Used memory percentage (0-100) */
  used_pct: number;
}

/** Per-process RSS entry from ps */
interface PsEntry {
  pid: number;
  ppid: number;
  rss_kb: number;
}


export class MemoryMonitor {
  private log: Logger;
  private warningMb: number;
  private criticalMb: number;
  private emergencyMb: number;
  /** Cached ps output with TTL to avoid blocking execSync on every call */
  private psCache: { entries: PsEntry[]; ts: number } | null = null;
  private static readonly PS_CACHE_TTL_MS = 5_000;

  /** Process-list source; `ps` unless a test substitutes one. */
  private listProcesses: (() => PsEntry[]) | null;

  constructor(
    log: Logger,
    warningMb = 2000,
    criticalMb = 1200,
    emergencyMb = 800,
    opts: { listProcesses?: () => PsEntry[] } = {},
  ) {
    this.listProcesses = opts.listProcesses ?? null;
    this.log = log;
    this.warningMb = warningMb;
    this.criticalMb = criticalMb;
    this.emergencyMb = emergencyMb;
  }

  /** Update pressure thresholds (e.g. from config reload) */
  setThresholds(warningMb: number, criticalMb: number, emergencyMb: number): void {
    this.warningMb = warningMb;
    this.criticalMb = criticalMb;
    this.emergencyMb = emergencyMb;
  }

  /** Read system memory stats via platform abstraction */
  getSystemMemory(): SystemMemory {
    const plat = detectPlatform();
    const info = plat.getSystemMemory();

    if (!info) {
      this.log.warn("Failed to read system memory");
      return {
        total_mb: 0,
        available_mb: 0,
        swap_total_mb: 0,
        swap_free_mb: 0,
        pressure: "normal",
        used_pct: 0,
      };
    }

    const totalMb = Math.round(info.total_kb / 1024);
    const availableMb = Math.round(info.available_kb / 1024);

    return {
      total_mb: totalMb,
      available_mb: availableMb,
      swap_total_mb: Math.round(info.swap_total_kb / 1024),
      swap_free_mb: Math.round(info.swap_free_kb / 1024),
      pressure: this.classifyPressure(availableMb),
      used_pct: computeUsedPct(totalMb, availableMb),
    };
  }

  /** Classify pressure from MemAvailable using this monitor's thresholds */
  private classifyPressure(availableMb: number): MemoryPressure {
    return classifyPressure(availableMb, {
      warningMb: this.warningMb,
      criticalMb: this.criticalMb,
      emergencyMb: this.emergencyMb,
    });
  }

  /**
   * Total RSS of the process trees rooted at `roots` (a session's panes):
   * each root and all its descendants, every process counted once even when
   * roots repeat or one lies inside another's tree.
   */
  getProcessTreeRss(roots: number | readonly number[]): { rss_mb: number; process_count: number } {
    const entries = this.getAllProcesses();
    const counted = new Map<number, PsEntry>();
    for (const rootPid of typeof roots === "number" ? [roots] : roots) {
      const root = entries.find((e) => e.pid === rootPid);
      if (root) counted.set(root.pid, root);
      for (const d of this.findDescendants(rootPid, entries)) counted.set(d.pid, d);
    }
    const totalKb = [...counted.values()].reduce((sum, e) => sum + e.rss_kb, 0);
    return {
      rss_mb: Math.round(totalKb / 1024),
      process_count: counted.size,
    };
  }

  /**
   * PIDs of every pane in a tmux session, across all its windows (empty when
   * there is no such session). Delegates to session.ts, the one place that
   * talks to tmux — this used to run its own `list-panes` against only the
   * CURRENT window, so processes in other windows went unmeasured.
   */
  getSessionPids(sessionName: string): number[] {
    return getSessionPanePids(sessionName);
  }

  /** Invalidate ps cache (call at the start of each poll cycle) */
  invalidatePsCache(): void {
    this.psCache = null;
  }

  /** Parse ps output to get all processes with pid, ppid, rss (cached for 5s) */
  private getAllProcesses(): PsEntry[] {
    if (this.listProcesses) return this.listProcesses();
    const now = Date.now();
    if (this.psCache && now - this.psCache.ts < MemoryMonitor.PS_CACHE_TTL_MS) {
      return this.psCache.entries;
    }

    try {
      const output = execSync("ps -e -o pid=,ppid=,rss= 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const entries: PsEntry[] = [];
      for (const line of output.trim().split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          entries.push({
            pid: parseInt(parts[0], 10),
            ppid: parseInt(parts[1], 10),
            rss_kb: parseInt(parts[2], 10),
          });
        }
      }
      this.psCache = { entries, ts: now };
      return entries;
    } catch {
      this.log.warn("Failed to read process list via ps");
      return [];
    }
  }

  /** Find all descendant processes of a given PID */
  private findDescendants(rootPid: number, entries: PsEntry[]): PsEntry[] {
    const children: PsEntry[] = [];
    const stack = [rootPid];

    while (stack.length > 0) {
      const parent = stack.pop()!;
      for (const entry of entries) {
        if (entry.ppid === parent && entry.pid !== rootPid) {
          children.push(entry);
          stack.push(entry.pid);
        }
      }
    }

    return children;
  }
}
