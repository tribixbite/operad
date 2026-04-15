/**
 * consolidation.test.ts — Unit tests for shouldConsolidate()
 *
 * Tests the idle-condition gate that controls when memory consolidation
 * ("REM sleep") is allowed to run. The function checks:
 * - idle time >= 1800s (30 min)
 * - charging and battery >= 30%
 * - SDK not busy
 * - minimum 12h since last consolidation
 */

import { describe, test, expect } from "bun:test";
import { shouldConsolidate } from "../consolidation.js";
import type { IdleConditions } from "../consolidation.js";

/** Helper: build a fully-passing IdleConditions object */
function passing(): IdleConditions {
  return {
    idleSeconds: 2000,
    batteryPct: 80,
    charging: true,
    sdkBusy: false,
  };
}

/** Helper: epoch N hours ago (in seconds) */
function hoursAgo(h: number): number {
  return Math.floor(Date.now() / 1000) - h * 3600;
}

describe("shouldConsolidate", () => {
  test("all conditions met (null epoch) returns true", () => {
    expect(shouldConsolidate(passing(), null)).toBe(true);
  });

  test("insufficient idle time (< 1800s) returns false", () => {
    const cond = passing();
    cond.idleSeconds = 1799;
    expect(shouldConsolidate(cond, null)).toBe(false);
  });

  test("not charging returns false", () => {
    const cond = passing();
    cond.charging = false;
    expect(shouldConsolidate(cond, null)).toBe(false);
  });

  test("low battery (< 30%) returns false", () => {
    const cond = passing();
    cond.batteryPct = 29;
    expect(shouldConsolidate(cond, null)).toBe(false);
  });

  test("SDK busy returns false", () => {
    const cond = passing();
    cond.sdkBusy = true;
    expect(shouldConsolidate(cond, null)).toBe(false);
  });

  test("too recent consolidation (< 12h ago) returns false", () => {
    const recentEpoch = hoursAgo(6); // 6 hours ago — too recent
    expect(shouldConsolidate(passing(), recentEpoch)).toBe(false);
  });

  test("old enough consolidation (> 12h ago) returns true", () => {
    const oldEpoch = hoursAgo(24); // 24 hours ago — old enough
    expect(shouldConsolidate(passing(), oldEpoch)).toBe(true);
  });

  test("exact edge: idleSeconds = 1800 returns true (>= check)", () => {
    const cond = passing();
    cond.idleSeconds = 1800;
    expect(shouldConsolidate(cond, null)).toBe(true);
  });

  test("exact edge: batteryPct = 30 returns false (< check, not <=)", () => {
    // Source uses `conditions.batteryPct < MIN_BATTERY_PCT` which means
    // batteryPct = 30 is NOT less than 30, so it should pass the battery check.
    // But let's verify by reading the source: `conditions.batteryPct < MIN_BATTERY_PCT`
    // 30 < 30 = false, so the check passes — consolidation allowed.
    const cond = passing();
    cond.batteryPct = 30;
    expect(shouldConsolidate(cond, null)).toBe(true);
  });
});
