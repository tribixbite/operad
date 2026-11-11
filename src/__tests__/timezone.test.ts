/**
 * timezone.test.ts — making "local time" mean the device's time zone.
 *
 * On Termux the daemon runs under bun, which does not read Android's time
 * zone and falls back to UTC (Termux's node does read it). Every local-time
 * computation in operad — cron schedules, the daily token / cost buckets —
 * was therefore silently UTC on the phone. At startup operad now sets TZ
 * from the platform when the environment does not already say.
 */

import { describe, test, expect } from "bun:test";
import { applyLocalTimezone, isValidTimeZone } from "../timezone.js";

describe("isValidTimeZone", () => {
  test("accepts IANA zones and rejects junk", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("applyLocalTimezone", () => {
  test("an explicit TZ is never overridden (and the platform is not asked)", () => {
    const env: Record<string, string | undefined> = { TZ: "Asia/Kolkata" };
    let asked = false;
    expect(applyLocalTimezone(env, () => { asked = true; return "America/New_York"; })).toBe("Asia/Kolkata");
    expect(env.TZ).toBe("Asia/Kolkata");
    expect(asked).toBe(false);
  });

  test("with no TZ, the platform's zone is adopted", () => {
    const env: Record<string, string | undefined> = {};
    expect(applyLocalTimezone(env, () => "America/New_York")).toBe("America/New_York");
    expect(env.TZ).toBe("America/New_York");
  });

  test("an empty TZ counts as unset", () => {
    const env: Record<string, string | undefined> = { TZ: "" };
    expect(applyLocalTimezone(env, () => "Europe/Berlin")).toBe("Europe/Berlin");
  });

  test("an invalid or missing platform zone leaves TZ alone", () => {
    const env: Record<string, string | undefined> = {};
    expect(applyLocalTimezone(env, () => "Not/AZone")).toBeNull();
    expect(applyLocalTimezone(env, () => null)).toBeNull();
    expect("TZ" in env).toBe(false);
  });

  test("a platform probe that throws is not fatal", () => {
    const env: Record<string, string | undefined> = {};
    expect(applyLocalTimezone(env, () => { throw new Error("getprop missing"); })).toBeNull();
  });
});
