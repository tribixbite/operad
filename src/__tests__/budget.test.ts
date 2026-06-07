/**
 * budget.test.ts — Unit tests for src/budget.ts
 *
 * Tests BudgetTracker caching, the ProcessCount return shape,
 * canStartSession(), and setBudget() without touching the real platform.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { BudgetTracker, CACHE_TTL } from "../budget.js";
import { Logger } from "../log.js";

// ---------------------------------------------------------------------------
// Minimal logger that writes to a temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;
let log: Logger;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-budget-test-"));
  log = new Logger(tmpDir, false);
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Build a BudgetTracker with a controllable count source */
function makeTracker(countFn: () => number, budget = 32): BudgetTracker {
  return new BudgetTracker(budget, log, countFn);
}

// ---------------------------------------------------------------------------
// ProcessCount shape
// ---------------------------------------------------------------------------

describe("BudgetTracker — ProcessCount shape", () => {
  test("check() returns an object with phantom_procs property", () => {
    const tracker = makeTracker(() => 5);
    const result = tracker.check();
    expect(result).toHaveProperty("phantom_procs");
    expect(typeof result.phantom_procs).toBe("number");
  });

  test("phantom_procs reflects the count returned by countFn", () => {
    const tracker = makeTracker(() => 17);
    expect(tracker.check().phantom_procs).toBe(17);
  });

  test("phantom_procs=0 when countFn returns 0", () => {
    const tracker = makeTracker(() => 0);
    expect(tracker.check().phantom_procs).toBe(0);
  });

  test("phantom_procs can be large (no artificial cap)", () => {
    const tracker = makeTracker(() => 10_000);
    expect(tracker.check().phantom_procs).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------

describe("BudgetTracker — cache TTL", () => {
  test("CACHE_TTL is exported and is 30 000 ms", () => {
    expect(typeof CACHE_TTL).toBe("number");
    expect(CACHE_TTL).toBe(30_000);
  });

  test("countFn called exactly once on first check()", () => {
    let calls = 0;
    const tracker = makeTracker(() => { calls++; return 3; });
    tracker.check();
    expect(calls).toBe(1);
  });

  test("second rapid check() within TTL uses cached value — countFn NOT called again", () => {
    let calls = 0;
    const tracker = makeTracker(() => { calls++; return 7; });
    tracker.check();
    tracker.check();
    expect(calls).toBe(1); // cache hit
  });

  test("cached value is returned on second rapid call", () => {
    let value = 10;
    const tracker = makeTracker(() => value);
    const first = tracker.check();
    value = 999; // change what countFn would return
    const second = tracker.check();
    // Second call is cached — should still return the original 10
    expect(second.phantom_procs).toBe(first.phantom_procs);
    expect(second.phantom_procs).toBe(10);
  });

  test("countFn called again after cache expires (manual time travel via cacheTime hack)", () => {
    let calls = 0;
    const tracker = makeTracker(() => { calls++; return 5; }) as any;
    tracker.check(); // first call — fills cache
    expect(calls).toBe(1);

    // Expire the cache artificially
    tracker.cacheTime = Date.now() - CACHE_TTL - 1;

    tracker.check(); // should re-invoke countFn
    expect(calls).toBe(2);
  });

  test("after cache expiry, updated count from countFn is returned", () => {
    let value = 1;
    const tracker = makeTracker(() => value) as any;
    expect(tracker.check().phantom_procs).toBe(1);

    // Expire the cache
    tracker.cacheTime = Date.now() - CACHE_TTL - 1;
    value = 42;

    expect(tracker.check().phantom_procs).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// canStartSession — always true
// ---------------------------------------------------------------------------

describe("BudgetTracker — canStartSession", () => {
  test("returns true regardless of process count", () => {
    for (const count of [0, 1, 31, 32, 33, 100, 10_000]) {
      const tracker = makeTracker(() => count);
      expect(tracker.canStartSession()).toBe(true);
    }
  });

  test("returns true without calling countFn", () => {
    let calls = 0;
    const tracker = makeTracker(() => { calls++; return 0; });
    tracker.canStartSession();
    // canStartSession() should not trigger a countFn call
    expect(calls).toBe(0);
  });

  test("returns true before any check() call", () => {
    const tracker = makeTracker(() => 99);
    expect(tracker.canStartSession()).toBe(true);
  });

  test("returns true after check() call with high count", () => {
    const tracker = makeTracker(() => 10_000);
    tracker.check();
    expect(tracker.canStartSession()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setBudget — no-op
// ---------------------------------------------------------------------------

describe("BudgetTracker — setBudget no-op", () => {
  test("setBudget does not throw for any numeric input", () => {
    const tracker = makeTracker(() => 0);
    expect(() => tracker.setBudget(0)).not.toThrow();
    expect(() => tracker.setBudget(32)).not.toThrow();
    expect(() => tracker.setBudget(-1)).not.toThrow();
    expect(() => tracker.setBudget(999)).not.toThrow();
  });

  test("setBudget does not affect canStartSession return value", () => {
    const tracker = makeTracker(() => 0);
    tracker.setBudget(1);
    expect(tracker.canStartSession()).toBe(true);
    tracker.setBudget(0);
    expect(tracker.canStartSession()).toBe(true);
  });

  test("setBudget does not invalidate the cache", () => {
    let calls = 0;
    const tracker = makeTracker(() => { calls++; return 3; });
    tracker.check(); // fills cache (calls=1)
    tracker.setBudget(64); // should not flush cache
    tracker.check(); // should still be cached (calls stays 1)
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Constructor: budget parameter is accepted but not stored as observable state
// ---------------------------------------------------------------------------

describe("BudgetTracker — constructor variations", () => {
  test("constructs with budget=0 without error", () => {
    expect(() => new BudgetTracker(0, log, () => 0)).not.toThrow();
  });

  test("constructs with very large budget without error", () => {
    expect(() => new BudgetTracker(Number.MAX_SAFE_INTEGER, log, () => 0)).not.toThrow();
  });

  test("initial cached count is 0 before first check()", () => {
    // The tracker starts at cachedCount=0; since cacheTime=0, countFn fires on first check
    let calls = 0;
    const tracker = makeTracker(() => { calls++; return 77; });
    const result = tracker.check();
    expect(calls).toBe(1);
    expect(result.phantom_procs).toBe(77);
  });
});
