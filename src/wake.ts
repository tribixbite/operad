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
import type { Platform } from "./platform/platform.js";
import { detectPlatform } from "./platform/platform.js";

/** The slice of Platform this manager needs — the whole seam for testing. */
export type WakeLockPlatform = Pick<Platform, "acquireWakeLock" | "isWakeLockHeld">;

export class WakeLockManager {
  private policy: WakeLockPolicy;
  private held = false;
  private log: Logger;
  private injectedPlatform: WakeLockPlatform | null;

  /**
   * `platform` is injectable so tests can script the OS side directly.
   *
   * Deliberately NOT done with `mock.module("../platform/platform.js")`:
   * bun:test applies module mocks process-wide, so one file doing that breaks
   * every other test file in the run. Tried it — 237 unrelated failures.
   */
  constructor(policy: WakeLockPolicy, log: Logger, platform?: WakeLockPlatform) {
    this.policy = policy;
    this.log = log;
    this.injectedPlatform = platform ?? null;
  }

  /** Resolved lazily, so production keeps using the detectPlatform singleton. */
  private plat(): WakeLockPlatform {
    return this.injectedPlatform ?? detectPlatform();
  }

  /**
   * Acquire the wake lock unless we are sure one is already held.
   *
   * `this.held` used to be the only gate, and it latched: set once on the
   * first successful acquire and never cleared. On Android that made a lost
   * lock permanent. `termux-wake-lock` exits 0 once the intent is delivered,
   * so the daemon marked itself held; the lock later went away with the
   * Termux service, `acquire()` early-returned on the stale flag forever
   * after, and `operad status` kept printing "wake: held". This device ran
   * that way for over a day, suspending freely, while `dumpsys power` listed
   * no Termux lock at all.
   *
   * The OS is consulted first now. Acquiring is idempotent and cheap on every
   * platform here, so when the OS cannot answer (null) we re-acquire rather
   * than trust the flag.
   */
  acquire(): void {
    const plat = this.plat();
    if (plat.isWakeLockHeld() === true) {
      this.held = true;
      return;
    }
    const ok = plat.acquireWakeLock();
    if (ok) {
      if (!this.held) this.log.info("Wake lock acquired");
      this.held = true;
    } else {
      this.held = false;
      this.log.error("Failed to acquire wake lock");
    }
  }

  /**
   * Whether the wake lock is currently held, per the OS where it can say.
   *
   * This is what `operad status` prints, so it must not be a cached intention.
   */
  isHeld(): boolean {
    const actual = this.plat().isWakeLockHeld();
    if (actual !== null) this.held = actual;
    return this.held;
  }

  /**
   * Re-check the lock and re-acquire if the OS has dropped it.
   *
   * Called from the health timer. Without this nothing ever notices a lost
   * lock: the device then suspends, and because `sleep` does not advance
   * across suspend, both the daemon's timers and watchdog.sh's poll loop
   * freeze together. Measured here before the fix — 60 supervision gaps of
   * 5-10 minutes (worst 5h43m) totalling 933 minutes over three days, with
   * the daemon silent in 17 of 18 sampled windows.
   *
   * Returns true when a lock had to be re-taken, so the caller can say so.
   */
  verify(): boolean {
    if (this.policy === "never") return false;
    const plat = this.plat();
    const actual = plat.isWakeLockHeld();
    // null = platform cannot tell. Re-acquiring blindly every health sweep
    // would be noise, so leave the state alone and let acquire() handle it.
    if (actual === null || actual === true) {
      if (actual === true) this.held = true;
      return false;
    }
    if (!this.held) return false; // never acquired yet — not a loss
    this.log.warn(
      "Wake lock was dropped by the OS — re-acquiring. "
      + "While it is gone the device can suspend, which freezes the daemon "
      + "and the watchdog together.",
    );
    this.held = false;
    this.acquire();
    return true;
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
