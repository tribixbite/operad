/**
 * memory.test.ts — Unit tests for pressure classification and memory math
 *
 * Tests the pure helpers extracted from memory.ts:
 *   - classifyPressure(): all four pressure bands at exact boundary values
 *   - computeUsedPct(): basic math, zero-denominator guard, rounding
 *
 * The MemoryMonitor class itself reads /proc and spawns ps, so its
 * integration behaviour is left to platform-guarded smoke tests at the
 * bottom — those are skipped automatically when /proc/meminfo isn't
 * readable (CI on macOS / Windows).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync } from "node:fs";

import {
  classifyPressure,
  computeUsedPct,
  MemoryMonitor,
} from "../memory.js";
import type { PressureThresholds, MemoryPressure } from "../memory.js";
import type { Logger } from "../log.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: PressureThresholds = {
  warningMb: 2000,
  criticalMb: 1200,
  emergencyMb: 800,
};

function silentLog(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-memory-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

// ---------------------------------------------------------------------------
// classifyPressure — boundary values
//
// Thresholds:  emergency=800  critical=1200  warning=2000
// Bands:
//   [0, 800)    → emergency
//   [800, 1200) → critical
//   [1200, 2000)→ warning
//   [2000, ∞)   → normal
// Boundary rule: strict less-than, so value == threshold → higher (safer) band
// ---------------------------------------------------------------------------

describe("classifyPressure — normal band", () => {
  test("exactly at warningMb → normal (boundary: equal is the safer band)", () => {
    expect(classifyPressure(2000, DEFAULT_THRESHOLDS)).toBe("normal");
  });

  test("one above warningMb → normal", () => {
    expect(classifyPressure(2001, DEFAULT_THRESHOLDS)).toBe("normal");
  });

  test("large value → normal", () => {
    expect(classifyPressure(8192, DEFAULT_THRESHOLDS)).toBe("normal");
  });
});

describe("classifyPressure — warning band", () => {
  test("one below warningMb → warning", () => {
    expect(classifyPressure(1999, DEFAULT_THRESHOLDS)).toBe("warning");
  });

  test("midpoint of warning band → warning", () => {
    expect(classifyPressure(1600, DEFAULT_THRESHOLDS)).toBe("warning");
  });

  test("exactly at criticalMb → warning (boundary: equal is the safer band)", () => {
    expect(classifyPressure(1200, DEFAULT_THRESHOLDS)).toBe("warning");
  });
});

describe("classifyPressure — critical band", () => {
  test("one below criticalMb → critical", () => {
    expect(classifyPressure(1199, DEFAULT_THRESHOLDS)).toBe("critical");
  });

  test("midpoint of critical band → critical", () => {
    expect(classifyPressure(1000, DEFAULT_THRESHOLDS)).toBe("critical");
  });

  test("exactly at emergencyMb → critical (boundary: equal is the safer band)", () => {
    expect(classifyPressure(800, DEFAULT_THRESHOLDS)).toBe("critical");
  });
});

describe("classifyPressure — emergency band", () => {
  test("one below emergencyMb → emergency", () => {
    expect(classifyPressure(799, DEFAULT_THRESHOLDS)).toBe("emergency");
  });

  test("midpoint of emergency band → emergency", () => {
    expect(classifyPressure(400, DEFAULT_THRESHOLDS)).toBe("emergency");
  });

  test("zero → emergency", () => {
    expect(classifyPressure(0, DEFAULT_THRESHOLDS)).toBe("emergency");
  });

  test("negative value → emergency (shouldn't happen, but must not crash)", () => {
    expect(classifyPressure(-1, DEFAULT_THRESHOLDS)).toBe("emergency");
  });
});

describe("classifyPressure — custom thresholds", () => {
  test("tight thresholds: emergency=100 critical=200 warning=400", () => {
    const t: PressureThresholds = { warningMb: 400, criticalMb: 200, emergencyMb: 100 };
    expect(classifyPressure(500, t)).toBe("normal");
    expect(classifyPressure(400, t)).toBe("normal");   // exact boundary → normal
    expect(classifyPressure(399, t)).toBe("warning");
    expect(classifyPressure(200, t)).toBe("warning");  // exact boundary → warning
    expect(classifyPressure(199, t)).toBe("critical");
    expect(classifyPressure(100, t)).toBe("critical"); // exact boundary → critical
    expect(classifyPressure(99,  t)).toBe("emergency");
  });

  test("all thresholds equal → anything below is emergency, equal is critical, above is warning or normal", () => {
    // warningMb = criticalMb = emergencyMb = 500
    // availableMb < 500 → emergency (checked first)
    // availableMb == 500 → the emergency check fails (not <500), critical check fails (not <500),
    //                      warning check fails (not <500) → normal
    const t: PressureThresholds = { warningMb: 500, criticalMb: 500, emergencyMb: 500 };
    expect(classifyPressure(499, t)).toBe("emergency");
    expect(classifyPressure(500, t)).toBe("normal");
    expect(classifyPressure(501, t)).toBe("normal");
  });

  test("threshold ordering inverted (misconfiguration): still consistent with the comparison chain", () => {
    // emergency(300) > critical(200) > warning(100) — inverted, emergency fires first
    const t: PressureThresholds = { warningMb: 100, criticalMb: 200, emergencyMb: 300 };
    // 250 < 300 (emergency threshold) → emergency
    expect(classifyPressure(250, t)).toBe("emergency");
    // 299 < 300 → emergency
    expect(classifyPressure(299, t)).toBe("emergency");
    // 300 is NOT < 300 → falls through to critical; 300 < 200? no → falls through to warning; 300 < 100? no → normal
    expect(classifyPressure(300, t)).toBe("normal");
  });
});

// ---------------------------------------------------------------------------
// computeUsedPct — math and edge cases
// ---------------------------------------------------------------------------

describe("computeUsedPct", () => {
  test("50% used", () => {
    expect(computeUsedPct(4096, 2048)).toBe(50);
  });

  test("0% used (all available)", () => {
    expect(computeUsedPct(4096, 4096)).toBe(0);
  });

  test("100% used (nothing available)", () => {
    expect(computeUsedPct(4096, 0)).toBe(100);
  });

  test("zero total → returns 0 (no division by zero)", () => {
    expect(computeUsedPct(0, 0)).toBe(0);
    expect(computeUsedPct(0, 512)).toBe(0);
  });

  test("negative total → returns 0 (guard)", () => {
    expect(computeUsedPct(-100, 0)).toBe(0);
  });

  test("rounds to nearest integer", () => {
    // (8192 - 2730) / 8192 = 0.66674... → rounds to 67
    expect(computeUsedPct(8192, 2730)).toBe(67);
  });

  test("small values (1 MB total, 0 MB available → 100%)", () => {
    expect(computeUsedPct(1, 0)).toBe(100);
  });

  test("typical Android device: 6 GB total, 1.5 GB available → 75%", () => {
    expect(computeUsedPct(6144, 1536)).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// MemoryMonitor.setThresholds — verify threshold reload affects pressure
// classification via getSystemMemory (integration-level, platform-guarded)
// ---------------------------------------------------------------------------

const PROC_MEMINFO_READABLE = existsSync("/proc/meminfo");

describe("MemoryMonitor — integration (platform-guarded)", () => {
  test.skipIf(!PROC_MEMINFO_READABLE)(
    "getSystemMemory() returns a structurally valid snapshot",
    () => {
      const mon = new MemoryMonitor(silentLog());
      const mem = mon.getSystemMemory();

      expect(mem.total_mb).toBeGreaterThan(0);
      expect(mem.available_mb).toBeGreaterThanOrEqual(0);
      expect(mem.available_mb).toBeLessThanOrEqual(mem.total_mb);
      expect(mem.swap_total_mb).toBeGreaterThanOrEqual(0);
      expect(mem.swap_free_mb).toBeGreaterThanOrEqual(0);
      expect(mem.used_pct).toBeGreaterThanOrEqual(0);
      expect(mem.used_pct).toBeLessThanOrEqual(100);
      const validPressure: MemoryPressure[] = ["normal", "warning", "critical", "emergency"];
      expect(validPressure).toContain(mem.pressure);
    },
  );

  test.skipIf(!PROC_MEMINFO_READABLE)(
    "setThresholds(max, max, max) forces emergency on any real system",
    () => {
      // Set all thresholds to 1 TB so any real machine is below emergency
      const mon = new MemoryMonitor(silentLog(), 1024 * 1024, 1024 * 1024, 1024 * 1024);
      const mem = mon.getSystemMemory();
      expect(mem.pressure).toBe("emergency");
    },
  );

  test.skipIf(!PROC_MEMINFO_READABLE)(
    "setThresholds(0, 0, 0) forces normal on any real system",
    () => {
      // All thresholds at zero so nothing is below threshold
      const mon = new MemoryMonitor(silentLog(), 0, 0, 0);
      const mem = mon.getSystemMemory();
      expect(mem.pressure).toBe("normal");
    },
  );

  test.skipIf(!PROC_MEMINFO_READABLE)(
    "setThresholds() reload changes pressure classification on next call",
    () => {
      const mon = new MemoryMonitor(silentLog());
      const first = mon.getSystemMemory();

      // Now reload to thresholds so extreme they force opposite pressure
      if (first.pressure === "normal") {
        // Force emergency
        mon.setThresholds(first.available_mb + 1, first.available_mb + 2, first.available_mb + 3);
        const second = mon.getSystemMemory();
        expect(second.pressure).toBe("emergency");
      } else {
        // Force normal
        mon.setThresholds(0, 0, 0);
        const second = mon.getSystemMemory();
        expect(second.pressure).toBe("normal");
      }
    },
  );
});
