/**
 * wake.test.ts — WakeLockManager acquire/verify semantics.
 *
 * These pin the bug that made supervision unreliable on Android. `acquire()`
 * gated on a private `held` boolean that latched: set true on the first
 * successful acquire, never cleared. `termux-wake-lock` exits 0 as soon as the
 * intent is delivered, so the daemon marked itself held; when the lock later
 * went away with the Termux service, `acquire()` early-returned on the stale
 * flag forever after and `operad status` kept printing "wake: held".
 *
 * The consequence was not cosmetic. With no wake lock the device suspends, and
 * `sleep` counts CLOCK_MONOTONIC, which does not advance across suspend — so
 * the daemon's timers and watchdog.sh's poll loop froze together. Measured on
 * the author's device: 60 supervision gaps of 5-10 minutes (worst 5h43m),
 * 933 minutes total over three days, with the daemon silent in 17 of 18
 * sampled windows.
 *
 * Convention: import source with .js extension (esbuild CJS output).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Logger } from "../log.js";
import { WakeLockManager } from "../wake.js";
import type { WakeLockPlatform } from "../wake.js";

// -- Fake platform -----------------------------------------------------------
//
// Injected through the constructor, NOT via mock.module: bun:test applies
// module mocks process-wide, so mocking "../platform/platform.js" here broke
// 237 tests in unrelated files.

const fake = {
  /** What isWakeLockHeld() reports. null = platform cannot tell. */
  osHeld: null as boolean | null,
  /** Whether acquireWakeLock() succeeds. */
  acquireSucceeds: true,
  /** Number of acquireWakeLock() calls. */
  acquires: 0,
};

const fakePlatform: WakeLockPlatform = {
  acquireWakeLock: () => {
    fake.acquires++;
    // A real acquire makes the OS report held — that is the whole point.
    if (fake.acquireSucceeds && fake.osHeld !== null) fake.osHeld = true;
    return fake.acquireSucceeds;
  },
  isWakeLockHeld: () => fake.osHeld,
};

function resetFake(): void {
  fake.osHeld = null;
  fake.acquireSucceeds = true;
  fake.acquires = 0;
}

// -- Logger capture ----------------------------------------------------------

let warnings: string[] = [];
let errors: string[] = [];

function fakeLog(): Logger {
  return {
    info: () => {},
    debug: () => {},
    warn: (m: string) => { warnings.push(m); },
    error: (m: string) => { errors.push(m); },
  } as unknown as Logger;
}

/** Manager wired to the scripted platform. */
function mgr(policy: "always" | "never" = "always"): WakeLockManager {
  return new WakeLockManager(policy, fakeLog(), fakePlatform);
}

describe("WakeLockManager", () => {
  beforeEach(() => {
    resetFake();
    warnings = [];
    errors = [];
  });
  afterEach(() => { resetFake(); });

  test("acquire() re-acquires when the OS says the lock is gone", () => {
    const w = mgr();

    fake.osHeld = false;
    w.acquire();
    expect(fake.acquires).toBe(1);
    expect(w.isHeld()).toBe(true);

    // The OS drops it — a Termux service restart, say. Nothing tells us.
    fake.osHeld = false;
    w.acquire();
    // The latching version returned early here and never acquired again.
    expect(fake.acquires).toBe(2);
  });

  test("acquire() is a no-op when the OS confirms a lock is already held", () => {
    const w = mgr();
    fake.osHeld = true;
    w.acquire();
    w.acquire();
    expect(fake.acquires).toBe(0);
    expect(w.isHeld()).toBe(true);
  });

  test("isHeld() reports the OS state, not a cached intention", () => {
    const w = mgr();
    fake.osHeld = false;
    w.acquire();
    expect(w.isHeld()).toBe(true);

    // This is what `operad status` prints. It said "held" for over a day while
    // dumpsys listed no Termux lock at all.
    fake.osHeld = false;
    expect(w.isHeld()).toBe(false);
  });

  test("verify() re-acquires a dropped lock and says so", () => {
    const w = mgr();
    fake.osHeld = false;
    w.acquire();
    const acquiresAfterFirst = fake.acquires;

    fake.osHeld = false; // dropped again
    expect(w.verify()).toBe(true);
    expect(fake.acquires).toBe(acquiresAfterFirst + 1);
    expect(warnings.some((m) => m.includes("dropped"))).toBe(true);
  });

  test("verify() is silent while the lock is genuinely held", () => {
    const w = mgr();
    fake.osHeld = true;
    w.acquire();
    expect(w.verify()).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  test("verify() does not re-acquire when the platform cannot tell", () => {
    // null must mean "unknown", never "gone" — otherwise a platform without a
    // check would re-acquire on every health sweep forever.
    const w = mgr();
    fake.osHeld = null;
    w.acquire();
    const before = fake.acquires;
    expect(w.verify()).toBe(false);
    expect(fake.acquires).toBe(before);
    expect(warnings).toHaveLength(0);
  });

  test("verify() does nothing before anything was ever acquired", () => {
    const w = mgr();
    fake.osHeld = false;
    // Never acquired — "not yet tried" is not a loss to report.
    expect(w.verify()).toBe(false);
    expect(fake.acquires).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  test("policy 'never' opts out of verification entirely", () => {
    const w = mgr("never");
    fake.osHeld = false;
    expect(w.verify()).toBe(false);
    expect(fake.acquires).toBe(0);
  });

  test("a failed acquire is not recorded as held", () => {
    const w = mgr();
    fake.osHeld = false;
    fake.acquireSucceeds = false;
    w.acquire();
    expect(w.isHeld()).toBe(false);
    expect(errors.some((m) => m.includes("Failed to acquire"))).toBe(true);
  });
});
