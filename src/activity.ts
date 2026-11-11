/**
 * activity.ts — CPU-tick based activity detection for tmux sessions
 *
 * Reads /proc/PID/stat fields 14+15 (utime+stime) to compute CPU tick
 * deltas between polls; tree classification also counts fields 16+17
 * (cutime+cstime, reaped children). Active sessions (Claude
 * thinking/executing) show delta > 0; idle sessions (waiting for user) show
 * delta == 0. A negative delta (a descendant exited) counts as active.
 *
 * Confirmed on device: active session delta=7, idle session delta=0.
 *
 * TODO: macOS builds its tree from `ps utime/stime`, which has no cutime
 * equivalent, so reaped children's time still leaves the tree there; only
 * the negative-delta rule protects those sessions.
 */

import type { Logger } from "./log.js";
import { detectPlatform } from "./platform/platform.js";
import type { Platform } from "./platform/platform.js";

/** The platform calls ActivityDetector makes — injectable for unit tests. */
export type ActivityPlatform = Pick<Platform, "readProcessCpuTicks" | "buildProcessTree">;

/** Activity classification for a session */
export type ActivityState = "active" | "idle" | "stopped" | "unknown";

/** Stored CPU ticks for a PID */
interface CpuSnapshot {
  /** utime + stime from /proc/PID/stat */
  ticks: number;
  /** Timestamp of the snapshot */
  ts: number;
  /** Number of consecutive zero-delta polls */
  idle_streak: number;
}

/** Number of consecutive zero-delta polls before classifying as idle (exported for tests) */
export const IDLE_THRESHOLD = 3;

/**
 * Pure activity classifier — no I/O, no state mutation.
 *
 * Given the current tick reading and the previous snapshot, returns the new
 * idle_streak and the resulting ActivityState. Extracted so it can be
 * unit-tested independently of /proc reads.
 *
 * @param currentTicks  utime+stime ticks just read for this poll
 * @param prev          previous snapshot (undefined = first observation)
 * @returns { state, newStreak }
 */
export function classifyActivity(
  currentTicks: number,
  prev: { ticks: number; idle_streak: number } | undefined,
): { state: ActivityState; newStreak: number } {
  if (prev === undefined) {
    // First observation — cannot compute a delta yet
    return { state: "unknown", newStreak: 0 };
  }

  const delta = currentTicks - prev.ticks;

  if (delta > 0) {
    // CPU ticks advanced — session is doing real work
    return { state: "active", newStreak: 0 };
  }

  if (delta < 0) {
    // The total went DOWN: a descendant exited and its time left the tree
    // (unreaped, reparented to init, or a platform without cutime). Something
    // ran and finished — evidence of work, never of idling. Counting it toward
    // the idle streak let a build that keeps spawning short-lived children be
    // classified idle and SIGSTOPped under memory pressure.
    return { state: "active", newStreak: 0 };
  }

  // No tick change — increment idle streak
  const newStreak = prev.idle_streak + 1;
  const state: ActivityState = newStreak >= IDLE_THRESHOLD ? "idle" : "active";
  return { state, newStreak };
}

/** One sweep's process tree: ppid → children, plus a pid → ticks index. */
interface ProcTreeCache {
  childrenOf: Map<number, { pid: number; ticks: number }[]>;
  ticksOf: Map<number, number>;
  ts: number;
}

export class ActivityDetector {
  private log: Logger;
  /** Previous CPU tick snapshots keyed by session name */
  private snapshots = new Map<string, CpuSnapshot>();
  /** Cached /proc tree: ppid → children with ticks. Built once per sweep, shared across sessions. */
  private procCache: ProcTreeCache | null = null;
  /** Cache TTL in ms — rebuild if older than this (matches poll interval) */
  private static readonly PROC_CACHE_TTL_MS = 10_000;

  private platform: ActivityPlatform;

  constructor(log: Logger, platform: ActivityPlatform = detectPlatform()) {
    this.log = log;
    this.platform = platform;
  }

  /**
   * Classify the activity state of a process.
   * Must be called repeatedly (on each poll interval) for delta computation.
   *
   * @param name Session name (used as key for tracking)
   * @param pid Root PID of the process (tmux pane shell)
   * @returns Activity state classification
   */
  classify(name: string, pid: number): ActivityState {
    const ticks = this.readCpuTicks(pid);
    if (ticks === null) {
      // Process doesn't exist
      this.snapshots.delete(name);
      return "stopped";
    }

    const prev = this.snapshots.get(name);
    const now = Date.now();

    if (!prev) {
      // First observation — store baseline, report unknown
      this.snapshots.set(name, { ticks, ts: now, idle_streak: 0 });
      return "unknown";
    }

    const { state, newStreak } = classifyActivity(ticks, prev);
    this.snapshots.set(name, { ticks, ts: now, idle_streak: newStreak });
    return state;
  }

  /**
   * Classify activity for a process tree (sum ticks of pid + all children).
   * More accurate for sessions that spawn many child processes.
   *
   * @param name Session name
   * @param pid Root PID
   * @returns Activity state
   */
  classifyTree(name: string, roots: number | readonly number[]): ActivityState {
    // Every pane of the session counts: work can run in any tmux window, and
    // judging by the first pane alone let a build in window 2 read as idle —
    // which is what memory-pressure auto-suspend stops.
    let ticks: number | null = null;
    for (const root of new Set(typeof roots === "number" ? [roots] : roots)) {
      const t = this.readTreeCpuTicks(root);
      if (t !== null) ticks = (ticks ?? 0) + t;
    }
    if (ticks === null) {
      this.snapshots.delete(name);
      return "stopped";
    }

    const prev = this.snapshots.get(name);
    const now = Date.now();

    if (!prev) {
      this.snapshots.set(name, { ticks, ts: now, idle_streak: 0 });
      return "unknown";
    }

    const { state, newStreak } = classifyActivity(ticks, prev);
    this.snapshots.set(name, { ticks, ts: now, idle_streak: newStreak });
    return state;
  }

  /** Remove tracking state for a session */
  remove(name: string): void {
    this.snapshots.delete(name);
  }

  /** Evict stale entries for sessions no longer in the active set */
  pruneStale(activeNames: Set<string>): void {
    for (const name of this.snapshots.keys()) {
      if (!activeNames.has(name)) this.snapshots.delete(name);
    }
  }

  /**
   * Read utime + stime CPU ticks for a PID via platform abstraction.
   * On Linux/Android: reads /proc/PID/stat fields 14+15.
   * On macOS: parses ps -o utime=,stime= output.
   */
  private readCpuTicks(pid: number): number | null {
    return this.platform.readProcessCpuTicks(pid);
  }

  /** Invalidate the proc cache (call at the start of each sweep) */
  invalidateProcCache(): void {
    this.procCache = null;
  }

  /**
   * Build process tree once per sweep, caching ppid → children with ticks.
   * Shared across all sessions — O(n) instead of O(sessions*procs).
   * Uses platform abstraction (procfs on Linux/Android, ps on macOS).
   */
  private buildProcTree(): ProcTreeCache {
    const now = Date.now();
    if (this.procCache && now - this.procCache.ts < ActivityDetector.PROC_CACHE_TTL_MS) {
      return this.procCache;
    }

    const childrenOf = this.platform.buildProcessTree();
    // pid → tree ticks, so the root's own entry (which on procfs includes
    // its reaped children's cutime/cstime) can be found in O(1).
    const ticksOf = new Map<number, number>();
    for (const children of childrenOf.values()) {
      for (const c of children) ticksOf.set(c.pid, c.ticks);
    }
    this.procCache = { childrenOf, ticksOf, ts: now };
    return this.procCache;
  }

  /**
   * Sum CPU ticks for a process and all its children.
   * Uses the cached proc tree (built once per sweep) for O(tree_depth) lookup.
   *
   * The root's contribution comes from its tree entry when present: there it
   * includes the time of children the root already reaped (cutime/cstime on
   * procfs), which readProcessCpuTicks (own utime+stime) leaves out. A pane
   * shell running `make` is exactly that case.
   */
  private readTreeCpuTicks(rootPid: number): number | null {
    const rootOwnTicks = this.readCpuTicks(rootPid);
    if (rootOwnTicks === null) return null;

    const { childrenOf, ticksOf } = this.buildProcTree();
    let total = ticksOf.get(rootPid) ?? rootOwnTicks;

    // Walk the tree from root → descendants
    const stack = [rootPid];
    const visited = new Set<number>([rootPid]);

    while (stack.length > 0) {
      const parent = stack.pop()!;
      const children = childrenOf.get(parent);
      if (!children) continue;

      for (const child of children) {
        if (visited.has(child.pid)) continue;
        visited.add(child.pid);
        total += child.ticks;
        stack.push(child.pid);
      }
    }

    return total;
  }
}
