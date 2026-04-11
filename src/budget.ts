/**
 * budget.ts — Phantom process counter (informational only)
 *
 * Counts descendants of the app PID via platform abstraction.
 * On Android: counts descendants of TERMUX_APP_PID (what PhantomProcessList tracks).
 * On desktop: always returns 0 (no phantom process concept).
 *
 * Uses a 30s cache to avoid blocking the event loop with ps every
 * time the dashboard polls status (every 15s via SSE).
 */

import type { Logger } from "./log.js";
import { detectPlatform } from "./platform/platform.js";

/** Simple process count snapshot for dashboard display */
export interface ProcessCount {
  /** Number of phantom processes (descendants of app PID) */
  phantom_procs: number;
}

/** Cache TTL for process count (ms) */
const CACHE_TTL = 30_000;

export class BudgetTracker {
  private log: Logger;
  /** Cached count + timestamp to avoid blocking every 15s */
  private cachedCount = 0;
  private cacheTime = 0;

  constructor(_budget: number, log: Logger) {
    this.log = log;
  }

  /** Get snapshot for dashboard/status display (cached 30s) */
  check(): ProcessCount {
    const now = Date.now();
    if (now - this.cacheTime > CACHE_TTL) {
      this.cachedCount = detectPlatform().countPhantomProcesses();
      this.cacheTime = now;
    }
    return { phantom_procs: this.cachedCount };
  }

  /** Always true — phantom killer is disabled, never block anything */
  canStartSession(): boolean {
    return true;
  }

  /** No-op — kept for config reload compatibility */
  setBudget(_budget: number): void {}
}
