/**
 * wake.ts — Wake lock / sleep inhibitor management (acquire-only)
 *
 * Manages the system wake lock via platform abstraction.
 * Android: termux-wake-lock (NEVER released — Android kills bg processes).
 * Linux: systemd-inhibit (if available).
 * macOS: caffeinate -i (prevents idle sleep).
 *
 * Policy controls when to acquire:
 *   always           — acquire on daemon start
 *   active_sessions  — acquire when any session is running
 *   boot_only        — acquire during boot
 *   never            — never acquire
 */

import type { WakeLockPolicy, SessionState } from "./types.js";
import type { Logger } from "./log.js";
import { detectPlatform } from "./platform/platform.js";

export class WakeLockManager {
  private policy: WakeLockPolicy;
  private held = false;
  private log: Logger;

  constructor(policy: WakeLockPolicy, log: Logger) {
    this.policy = policy;
    this.log = log;
  }

  /** Acquire the wake lock if not already held */
  acquire(): void {
    if (this.held) return;
    const ok = detectPlatform().acquireWakeLock();
    if (ok) {
      this.held = true;
      this.log.info("Wake lock acquired");
    } else {
      this.log.error("Failed to acquire wake lock");
    }
  }

  /** Whether the wake lock is currently held */
  isHeld(): boolean {
    return this.held;
  }

  /**
   * Evaluate the policy and acquire if appropriate.
   * NOTE: Wake lock is NEVER released by the daemon. Only acquire paths exist.
   */
  evaluate(phase: "boot_start" | "boot_end" | "shutdown" | "session_change", sessions?: Record<string, SessionState>): void {
    switch (this.policy) {
      case "always":
        this.acquire();
        break;

      case "active_sessions":
        if (sessions) {
          const hasActive = Object.values(sessions).some(
            (s) => s.status === "running" || s.status === "starting" || s.status === "degraded"
          );
          if (hasActive) {
            this.acquire();
          }
        }
        break;

      case "boot_only":
        if (phase === "boot_start") {
          this.acquire();
        }
        break;

      case "never":
        break;
    }
  }
}
