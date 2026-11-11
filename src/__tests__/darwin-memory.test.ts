/**
 * darwin-memory.test.ts — parseVmStatAvailableKb (pure; runs on every OS).
 *
 * `available_kb: 0` is not "unknown", it is "no memory left": MemoryMonitor
 * classifies it as emergency, SIGSTOPs idle sessions, and never recovers
 * because the reading never improves. parseMeminfo already returns null for
 * missing fields; the macOS vm_stat path must do the same.
 */

import { describe, test, expect } from "bun:test";
import { parseVmStatAvailableKb } from "../platform/darwin.js";

const SAMPLE = [
  "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
  "Pages free:                               10000.",
  "Pages active:                            200000.",
  "Pages inactive:                           20000.",
  "Pages speculative:                         3000.",
  "Pages throttled:                              0.",
  "Pages wired down:                         90000.",
  "Pages purgeable:                           1000.",
].join("\n");

describe("parseVmStatAvailableKb", () => {
  test("sums free + inactive + speculative + purgeable pages × page size", () => {
    // (10000 + 20000 + 3000 + 1000) pages × 16 KiB
    expect(parseVmStatAvailableKb(SAMPLE)).toBe(34_000 * 16);
  });

  test("vm_stat failure (no output) is unknown → null, not 0", () => {
    expect(parseVmStatAvailableKb(null)).toBeNull();
    expect(parseVmStatAvailableKb("")).toBeNull();
  });

  test("output without a 'Pages free' line is unknown → null", () => {
    expect(parseVmStatAvailableKb("vm_stat: unexpected error\n")).toBeNull();
  });

  test("a genuinely zero free count with other fields present is a real reading", () => {
    const zeroFree = SAMPLE.replace("Pages free:                               10000.", "Pages free: 0.");
    expect(parseVmStatAvailableKb(zeroFree)).toBe(24_000 * 16);
  });
});
