/**
 * activity.test.ts — Unit tests for src/activity.ts
 *
 * Tests the pure classifyActivity() helper (no I/O) for all four
 * ActivityState values and their threshold boundaries.
 * Also tests ActivityDetector.pruneStale() and .remove() directly.
 */
import { describe, test, expect } from "bun:test";
import { classifyActivity, IDLE_THRESHOLD, ActivityDetector } from "../activity.js";
import type { ActivityState } from "../activity.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { Logger } from "../log.js";

// ---------------------------------------------------------------------------
// Pure classifier: classifyActivity()
// ---------------------------------------------------------------------------

describe("classifyActivity — first observation", () => {
  test("returns 'unknown' when prev is undefined", () => {
    const { state, newStreak } = classifyActivity(100, undefined);
    expect(state).toBe("unknown");
    expect(newStreak).toBe(0);
  });

  test("newStreak is always 0 on first observation regardless of tick value", () => {
    for (const ticks of [0, 1, 9999]) {
      const { newStreak } = classifyActivity(ticks, undefined);
      expect(newStreak).toBe(0);
    }
  });
});

describe("classifyActivity — active (tick delta > 0)", () => {
  test("any positive tick delta → 'active'", () => {
    const prev = { ticks: 100, idle_streak: 0 };
    const { state } = classifyActivity(101, prev);
    expect(state).toBe("active");
  });

  test("large tick delta → 'active'", () => {
    const prev = { ticks: 0, idle_streak: 0 };
    const { state } = classifyActivity(999_999, prev);
    expect(state).toBe("active");
  });

  test("tick delta=1 (boundary minimum positive) → 'active'", () => {
    const prev = { ticks: 50, idle_streak: 5 };
    const { state } = classifyActivity(51, prev);
    expect(state).toBe("active");
  });

  test("active resets idle_streak to 0", () => {
    const prev = { ticks: 10, idle_streak: 9 }; // was almost idle
    const { newStreak, state } = classifyActivity(20, prev);
    expect(state).toBe("active");
    expect(newStreak).toBe(0);
  });
});

describe("classifyActivity — idle streak accumulation", () => {
  test("zero delta with idle_streak=0 → 'active' (streak=1, below threshold)", () => {
    const prev = { ticks: 100, idle_streak: 0 };
    const { state, newStreak } = classifyActivity(100, prev);
    // streak 1 < IDLE_THRESHOLD → still active
    expect(state).toBe("active");
    expect(newStreak).toBe(1);
  });

  test("zero delta with idle_streak = IDLE_THRESHOLD-2 → 'active' (one below threshold)", () => {
    const prev = { ticks: 200, idle_streak: IDLE_THRESHOLD - 2 };
    const { state, newStreak } = classifyActivity(200, prev);
    expect(state).toBe("active");
    expect(newStreak).toBe(IDLE_THRESHOLD - 1);
  });

  test("zero delta with idle_streak = IDLE_THRESHOLD-1 → 'idle' (crosses threshold)", () => {
    const prev = { ticks: 500, idle_streak: IDLE_THRESHOLD - 1 };
    const { state, newStreak } = classifyActivity(500, prev);
    expect(state).toBe("idle");
    expect(newStreak).toBe(IDLE_THRESHOLD);
  });

  test("zero delta with idle_streak = IDLE_THRESHOLD → 'idle' (above threshold)", () => {
    const prev = { ticks: 999, idle_streak: IDLE_THRESHOLD };
    const { state, newStreak } = classifyActivity(999, prev);
    expect(state).toBe("idle");
    expect(newStreak).toBe(IDLE_THRESHOLD + 1);
  });

  test("zero delta with idle_streak >> threshold → 'idle'", () => {
    const prev = { ticks: 42, idle_streak: 100 };
    const { state } = classifyActivity(42, prev);
    expect(state).toBe("idle");
  });

  test("IDLE_THRESHOLD constant is 3 (regression guard for threshold value)", () => {
    // If someone changes the threshold, all boundary tests above will catch it.
    // This test locks down the constant's value explicitly.
    expect(IDLE_THRESHOLD).toBe(3);
  });
});

describe("classifyActivity — exact threshold boundary sequence", () => {
  test("state transitions on zero-delta: active(1) → active(2) → idle(3)", () => {
    const stepsWithZero: Array<{ prev: { ticks: number; idle_streak: number }; expected: ActivityState }> = [
      { prev: { ticks: 0, idle_streak: 0 }, expected: "active" }, // streak 1
      { prev: { ticks: 0, idle_streak: 1 }, expected: "active" }, // streak 2
      { prev: { ticks: 0, idle_streak: 2 }, expected: "idle"   }, // streak 3 = IDLE_THRESHOLD
    ];

    for (const { prev, expected } of stepsWithZero) {
      const { state } = classifyActivity(0, prev);
      expect(state).toBe(expected);
    }
  });

  test("recovery: idle → active on next positive tick delta", () => {
    const prev = { ticks: 100, idle_streak: IDLE_THRESHOLD };
    const { state, newStreak } = classifyActivity(101, prev); // delta = 1
    expect(state).toBe("active");
    expect(newStreak).toBe(0);
  });
});

describe("classifyActivity — negative delta", () => {
  test("negative delta treated same as zero-delta (increments idle streak)", () => {
    // Ticks shouldn't decrease in practice, but the classifier handles it gracefully.
    const prev = { ticks: 500, idle_streak: 0 };
    const { state, newStreak } = classifyActivity(499, prev); // delta = -1
    expect(newStreak).toBe(1);
    expect(state).toBe("active"); // streak 1 < threshold
  });
});

// ---------------------------------------------------------------------------
// Pure classifier: realistic polling sequence simulation
// ---------------------------------------------------------------------------

describe("classifyActivity — realistic polling sequence", () => {
  test("full lifecycle: unknown → active → active → idle → recover", () => {
    type Snap = { ticks: number; idle_streak: number } | undefined;
    let snap: Snap = undefined;

    const poll = (currentTicks: number): ActivityState => {
      const { state, newStreak } = classifyActivity(currentTicks, snap);
      if (snap === undefined) {
        snap = { ticks: currentTicks, idle_streak: 0 };
      } else {
        snap = { ticks: currentTicks, idle_streak: newStreak };
      }
      return state;
    };

    expect(poll(1000)).toBe("unknown");
    expect(poll(1010)).toBe("active");
    expect(poll(1025)).toBe("active");
    expect(poll(1040)).toBe("active");
    expect(poll(1040)).toBe("active"); // streak=1
    expect(poll(1040)).toBe("active"); // streak=2
    expect(poll(1040)).toBe("idle");   // streak=3 = IDLE_THRESHOLD
    expect(poll(2000)).toBe("active"); // recovery
    expect(poll(2000)).toBe("active"); // streak=1
    expect(poll(2000)).toBe("active"); // streak=2
    expect(poll(2000)).toBe("idle");   // streak=3
  });

  test("CPU-idle process: unknown → active × (threshold-1) → idle", () => {
    type Snap = { ticks: number; idle_streak: number } | undefined;
    let snap: Snap = undefined;

    const poll = (currentTicks: number): ActivityState => {
      const { state, newStreak } = classifyActivity(currentTicks, snap);
      if (snap === undefined) {
        snap = { ticks: currentTicks, idle_streak: 0 };
      } else {
        snap = { ticks: currentTicks, idle_streak: newStreak };
      }
      return state;
    };

    expect(poll(0)).toBe("unknown");
    for (let i = 1; i < IDLE_THRESHOLD; i++) {
      expect(poll(0)).toBe("active");
    }
    expect(poll(0)).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// ActivityDetector: state management (no /proc reads needed)
// ---------------------------------------------------------------------------

function makeLogger(): { logger: Logger; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "operad-activity-test-"));
  const logger = new Logger(tmpDir, false);
  return { logger, tmpDir };
}

function cleanup(tmpDir: string): void {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

describe("ActivityDetector — remove()", () => {
  test("remove() on unknown session name is a no-op (no throw)", () => {
    const { logger, tmpDir } = makeLogger();
    try {
      const detector = new ActivityDetector(logger);
      expect(() => detector.remove("nonexistent")).not.toThrow();
    } finally {
      cleanup(tmpDir);
    }
  });

  test("remove() is idempotent — calling twice does not throw", () => {
    const { logger, tmpDir } = makeLogger();
    try {
      const detector = new ActivityDetector(logger);
      detector.remove("session-a");
      detector.remove("session-a");
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe("ActivityDetector — pruneStale()", () => {
  test("pruneStale with empty active set and empty snapshots is a no-op", () => {
    const { logger, tmpDir } = makeLogger();
    try {
      const detector = new ActivityDetector(logger);
      expect(() => detector.pruneStale(new Set())).not.toThrow();
    } finally {
      cleanup(tmpDir);
    }
  });

  test("pruneStale with sessions that have no tracked state is a no-op", () => {
    const { logger, tmpDir } = makeLogger();
    try {
      const detector = new ActivityDetector(logger);
      expect(() => detector.pruneStale(new Set(["a", "b", "c"]))).not.toThrow();
    } finally {
      cleanup(tmpDir);
    }
  });

  test("pruneStale is idempotent and safe to call repeatedly", () => {
    const { logger, tmpDir } = makeLogger();
    try {
      const detector = new ActivityDetector(logger);
      detector.pruneStale(new Set(["foo"]));
      detector.pruneStale(new Set());
      detector.pruneStale(new Set(["bar"]));
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe("ActivityDetector — invalidateProcCache()", () => {
  test("invalidateProcCache() can be called without error before any classify", () => {
    const { logger, tmpDir } = makeLogger();
    try {
      const detector = new ActivityDetector(logger);
      expect(() => detector.invalidateProcCache()).not.toThrow();
    } finally {
      cleanup(tmpDir);
    }
  });

  test("invalidateProcCache() is safe to call multiple times in sequence", () => {
    const { logger, tmpDir } = makeLogger();
    try {
      const detector = new ActivityDetector(logger);
      detector.invalidateProcCache();
      detector.invalidateProcCache();
    } finally {
      cleanup(tmpDir);
    }
  });
});
