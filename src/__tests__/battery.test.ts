/**
 * battery.test.ts — battery JSON parsing + low-battery action decisions.
 *
 * Two pure helpers under test:
 *
 *   parseTermuxBatteryStatus(raw)  [src/platform/android.ts]
 *     The REAL parser used by AndroidPlatform.getBatteryStatus(). Its charging
 *     logic is plugged-aware: a device is "charging" when status is
 *     CHARGING/FULL, OR it is plugged in (plugged !== "UNPLUGGED") and not
 *     actively DISCHARGING — so radios aren't disabled while on AC reporting
 *     NOT_CHARGING. Malformed/missing fields fall back to safe defaults.
 *
 *   batteryActionDecision(status, threshold, actionsApplied)  [src/battery.ts]
 *     Pure trigger/clear/none decision with a +5% hysteresis margin.
 */

import { describe, test, expect } from "bun:test";

import { batteryActionDecision } from "../battery.js";
import type { BatteryStatus } from "../battery.js";
import { parseTermuxBatteryStatus } from "../platform/android.js";

function makeStatus(overrides: Partial<BatteryStatus> = {}): BatteryStatus {
  return { percentage: 50, charging: false, temperature: 25, health: "GOOD", ...overrides };
}

// ---------------------------------------------------------------------------
// parseTermuxBatteryStatus — charging logic (plugged-aware)
// ---------------------------------------------------------------------------

describe("parseTermuxBatteryStatus — charging state", () => {
  test("full shape: DISCHARGING + UNPLUGGED → not charging, fields mapped", () => {
    const r = parseTermuxBatteryStatus(JSON.stringify({
      percentage: 73, status: "DISCHARGING", plugged: "UNPLUGGED", temperature: 31.5, health: "GOOD",
    }));
    expect(r).not.toBeNull();
    expect(r!.percentage).toBe(73);
    expect(r!.charging).toBe(false);
    expect(r!.temperature).toBe(31.5);
    expect(r!.health).toBe("GOOD");
  });

  test("status CHARGING → charging=true", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 50, status: "CHARGING", plugged: "PLUGGED_AC" }))!.charging).toBe(true);
  });

  test("status FULL → charging=true", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 100, status: "FULL", plugged: "PLUGGED_AC" }))!.charging).toBe(true);
  });

  test("DISCHARGING + UNPLUGGED → charging=false", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 80, status: "DISCHARGING", plugged: "UNPLUGGED" }))!.charging).toBe(false);
  });

  test("NOT_CHARGING + UNPLUGGED → charging=false (unplugged dominates)", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 15, status: "NOT_CHARGING", plugged: "UNPLUGGED" }))!.charging).toBe(false);
  });

  test("NOT_CHARGING + PLUGGED_AC → charging=true (plugged nuance: don't disable radios on AC)", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 95, status: "NOT_CHARGING", plugged: "PLUGGED_AC" }))!.charging).toBe(true);
  });

  test("DISCHARGING while PLUGGED_AC → charging=false (active discharge dominates)", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 40, status: "DISCHARGING", plugged: "PLUGGED_AC" }))!.charging).toBe(false);
  });

  test("missing plugged field is treated as 'not unplugged' (matches original inline parse)", () => {
    // No plugged key → the plugged clause is true, so a non-DISCHARGING status reads as charging.
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 50, status: "NOT_CHARGING" }))!.charging).toBe(true);
  });

  test("percentage 0 and 100 pass through", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 0, status: "DISCHARGING", plugged: "UNPLUGGED" }))!.percentage).toBe(0);
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 100, status: "FULL", plugged: "PLUGGED_AC" }))!.percentage).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// parseTermuxBatteryStatus — clamping + safe defaults
// ---------------------------------------------------------------------------

describe("parseTermuxBatteryStatus — percentage clamping", () => {
  test("> 100 is clamped to 100", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 150, status: "CHARGING", plugged: "PLUGGED_AC" }))!.percentage).toBe(100);
  });
  test("< 0 is clamped to 0", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: -5, status: "DISCHARGING", plugged: "UNPLUGGED" }))!.percentage).toBe(0);
  });
});

describe("parseTermuxBatteryStatus — missing/wrong-typed fields → safe defaults", () => {
  test("missing percentage → 0", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ status: "DISCHARGING", plugged: "UNPLUGGED" }))!.percentage).toBe(0);
  });
  test("missing temperature → 0", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 40, status: "DISCHARGING", plugged: "UNPLUGGED" }))!.temperature).toBe(0);
  });
  test("missing health → 'UNKNOWN'", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 40, status: "DISCHARGING", plugged: "UNPLUGGED" }))!.health).toBe("UNKNOWN");
  });
  test("percentage as string → treated as missing → 0", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: "85", status: "CHARGING", plugged: "PLUGGED_AC" }))!.percentage).toBe(0);
  });
  test("temperature as string → 0", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 50, status: "DISCHARGING", plugged: "UNPLUGGED", temperature: "31" }))!.temperature).toBe(0);
  });
  test("health as number → 'UNKNOWN'", () => {
    expect(parseTermuxBatteryStatus(JSON.stringify({ percentage: 50, status: "DISCHARGING", plugged: "UNPLUGGED", health: 99 }))!.health).toBe("UNKNOWN");
  });
  test("empty object → defaults; charging=true (no UNPLUGGED signal → conservative, won't disable radios)", () => {
    const r = parseTermuxBatteryStatus(JSON.stringify({}));
    expect(r).not.toBeNull();
    expect(r!.percentage).toBe(0);
    expect(r!.temperature).toBe(0);
    expect(r!.health).toBe("UNKNOWN");
    expect(r!.charging).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseTermuxBatteryStatus — malformed / non-object → null
// ---------------------------------------------------------------------------

describe("parseTermuxBatteryStatus — malformed input returns null", () => {
  test("empty string → null", () => { expect(parseTermuxBatteryStatus("")).toBeNull(); });
  test("plain number → null", () => { expect(parseTermuxBatteryStatus("42")).toBeNull(); });
  test("JSON array → null (top-level must be an object)", () => { expect(parseTermuxBatteryStatus("[1,2,3]")).toBeNull(); });
  test("JSON null literal → null", () => { expect(parseTermuxBatteryStatus("null")).toBeNull(); });
  test("truncated JSON → null", () => { expect(parseTermuxBatteryStatus('{"percentage": 50')).toBeNull(); });
  test("non-JSON error text → null", () => { expect(parseTermuxBatteryStatus("error: termux-api not available")).toBeNull(); });
  test("JSON string literal → null", () => { expect(parseTermuxBatteryStatus('"hello"')).toBeNull(); });
  test("JSON boolean → null", () => { expect(parseTermuxBatteryStatus("true")).toBeNull(); });
});

// ---------------------------------------------------------------------------
// batteryActionDecision — trigger
// ---------------------------------------------------------------------------

describe("batteryActionDecision — trigger (at/below threshold, not charging, none applied)", () => {
  test("exactly at threshold → trigger (<= boundary)", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 10, charging: false }), 10, false)).toBe("trigger");
  });
  test("one below threshold → trigger", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 9, charging: false }), 10, false)).toBe("trigger");
  });
  test("zero percent → trigger", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 0, charging: false }), 10, false)).toBe("trigger");
  });
  test("custom high threshold (50%), battery at 30% → trigger", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 30, charging: false }), 50, false)).toBe("trigger");
  });
  test("threshold=0, percentage=0 → trigger", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 0, charging: false }), 0, false)).toBe("trigger");
  });
});

describe("batteryActionDecision — no trigger", () => {
  test("already applied → none", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 5, charging: false }), 10, true)).toBe("none");
  });
  test("below threshold but charging → none", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 8, charging: true }), 10, false)).toBe("none");
  });
  test("exactly at threshold while charging → none", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 10, charging: true }), 10, false)).toBe("none");
  });
  test("one above threshold, not charging → none", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 11, charging: false }), 10, false)).toBe("none");
  });
  test("threshold=0, percentage=1 → none (1 is not <= 0)", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 1, charging: false }), 0, false)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// batteryActionDecision — clear (hysteresis: charging + strictly above thr+5)
// ---------------------------------------------------------------------------

describe("batteryActionDecision — clear", () => {
  test("applied, charging, one above threshold+5 → clear", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 16, charging: true }), 10, true)).toBe("clear");
  });
  test("applied, charging, far above hysteresis → clear", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 80, charging: true }), 10, true)).toBe("clear");
  });
  test("applied, charging, exactly at threshold+5 → none (strict >)", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 15, charging: true }), 10, true)).toBe("none");
  });
  test("applied, charging, one below threshold+5 → none", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 14, charging: true }), 10, true)).toBe("none");
  });
  test("applied, NOT charging, far above hysteresis → none (must be charging)", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 80, charging: false }), 10, true)).toBe("none");
  });
  test("custom threshold 20%: applied, charging, 26% → clear; 25% → none", () => {
    expect(batteryActionDecision(makeStatus({ percentage: 26, charging: true }), 20, true)).toBe("clear");
    expect(batteryActionDecision(makeStatus({ percentage: 25, charging: true }), 20, true)).toBe("none");
  });
});
