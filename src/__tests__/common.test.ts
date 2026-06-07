/**
 * common.test.ts — Unit tests for src/platform/common.ts pure parsers
 *
 * Tests parseProcStatTicks, parseProcStatPpid, and parseMeminfo with
 * fixture strings rather than live /proc reads. One platform-guarded
 * integration test exercises real /proc/self/stat when available.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  parseProcStatTicks,
  parseProcStatPpid,
  parseMeminfo,
} from "../platform/common.js";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal /proc/PID/stat line from parts.
 *
 * Real /proc/PID/stat layout after the last ')':
 *   [0]  state
 *   [1]  ppid
 *   [2]  pgrp
 *   [3]  session
 *   [4]  tty_nr
 *   [5]  tpgid
 *   [6]  flags
 *   [7]  minflt
 *   [8]  cminflt
 *   [9]  majflt
 *   [10] cmajflt
 *   [11] utime   ← parseProcStatTicks reads this
 *   [12] stime   ← parseProcStatTicks reads this
 *   ...  (remaining fields ignored)
 *
 * Between ppid ([1]) and utime ([11]) there are exactly 9 filler fields (indices 2-10).
 */
function makeStatLine(
  pid: number,
  comm: string,
  state: string,
  ppid: number,
  utime: number,
  stime: number,
): string {
  // 9 filler values for indices [2] through [10]
  const filler = "0 0 0 0 0 0 0 0 0";
  return `${pid} (${comm}) ${state} ${ppid} ${filler} ${utime} ${stime} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
}

// ---------------------------------------------------------------------------
// parseProcStatTicks
// ---------------------------------------------------------------------------

describe("parseProcStatTicks", () => {
  test("simple comm with no spaces returns correct utime+stime", () => {
    const line = makeStatLine(1234, "bash", "S", 1, 100, 50);
    expect(parseProcStatTicks(line)).toBe(150);
  });

  test("zero ticks returns 0", () => {
    const line = makeStatLine(1, "init", "S", 0, 0, 0);
    expect(parseProcStatTicks(line)).toBe(0);
  });

  test("comm with spaces inside parens — uses lastIndexOf", () => {
    // The comm field is "(weird )(name)" — the LAST ')' is after "name"
    const pid = 1234;
    const ppid = 7;
    const utime = 300;
    const stime = 200;
    // 9 filler fields for indices [2]-[10]
    const filler = "0 0 0 0 0 0 0 0 0";
    const line = `${pid} (weird )(name) S ${ppid} ${filler} ${utime} ${stime} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
    expect(parseProcStatTicks(line)).toBe(500);
  });

  test("comm with nested parens — lastIndexOf anchors correctly", () => {
    // comm = "(a(b)c)" — LAST ')' is the outer closing paren
    // 9 filler fields for indices [2]-[10], then utime=42, stime=8
    const filler = "0 0 0 0 0 0 0 0 0";
    const line = `99 (a(b)c) R 1 ${filler} 42 8 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
    // utime=42, stime=8 → sum=50
    expect(parseProcStatTicks(line)).toBe(50);
  });

  test("line with no closing paren returns null", () => {
    expect(parseProcStatTicks("1234 bash S 1 0 0")).toBeNull();
  });

  test("truncated line (not enough fields) returns null", () => {
    // Only provides pid+comm, no fields after
    expect(parseProcStatTicks("1234 (bash) S")).toBeNull();
  });

  test("non-numeric utime/stime returns null", () => {
    // 9 filler fields (indices [2]-[10]), then "NaN bad" at positions [11] and [12]
    const line = "1234 (bash) S 1 0 0 0 0 0 0 0 0 0 NaN bad 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0";
    expect(parseProcStatTicks(line)).toBeNull();
  });

  test("empty string returns null", () => {
    expect(parseProcStatTicks("")).toBeNull();
  });

  test("large tick values are summed correctly", () => {
    // Ticks can be large on long-running processes
    const line = makeStatLine(99, "longrunner", "S", 2, 999999, 888888);
    expect(parseProcStatTicks(line)).toBe(1_888_887);
  });
});

// ---------------------------------------------------------------------------
// parseProcStatPpid
// ---------------------------------------------------------------------------

describe("parseProcStatPpid", () => {
  test("simple comm extracts correct ppid", () => {
    const line = makeStatLine(1234, "bash", "S", 42, 0, 0);
    expect(parseProcStatPpid(line)).toBe(42);
  });

  test("ppid=1 (init child) is returned correctly", () => {
    const line = makeStatLine(2, "kthread", "S", 1, 0, 0);
    expect(parseProcStatPpid(line)).toBe(1);
  });

  test("ppid=0 (init itself) is returned correctly", () => {
    const line = makeStatLine(1, "init", "S", 0, 0, 0);
    expect(parseProcStatPpid(line)).toBe(0);
  });

  test("comm with embedded spaces — lastIndexOf gives correct ppid", () => {
    // comm = "weird )(name" — LAST ')' is after "name"
    const pid = 5678;
    const ppid = 99;
    const utime = 10;
    const stime = 5;
    // 9 filler fields for indices [2]-[10]
    const filler = "0 0 0 0 0 0 0 0 0";
    const line = `${pid} (weird )(name) S ${ppid} ${filler} ${utime} ${stime} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
    expect(parseProcStatPpid(line)).toBe(99);
  });

  test("comm with nested parens extracts ppid correctly", () => {
    // Same line as the ticks test: ppid field is index [1] after last ')'
    const filler = "0 0 0 0 0 0 0 0 0";
    const line = `99 (a(b)c) R 1 ${filler} 42 8 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
    expect(parseProcStatPpid(line)).toBe(1);
  });

  test("line with no closing paren returns null", () => {
    expect(parseProcStatPpid("1234 bash S 1 2 3")).toBeNull();
  });

  test("truncated line after paren returns null (ppid field missing)", () => {
    // Nothing after the last ')'
    expect(parseProcStatPpid("1234 (bash)")).toBeNull();
  });

  test("non-numeric ppid returns null", () => {
    expect(parseProcStatPpid("1234 (bash) S not_a_number 0 0")).toBeNull();
  });

  test("empty string returns null", () => {
    expect(parseProcStatPpid("")).toBeNull();
  });

  test("comm that is just parens: '()'", () => {
    // Edge: the name itself is empty. Still parseable.
    const line = makeStatLine(10, "", "R", 5, 0, 0);
    expect(parseProcStatPpid(line)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// parseMeminfo
// ---------------------------------------------------------------------------

/** Minimal /proc/meminfo fixture with the four fields we care about */
const FULL_MEMINFO = `MemTotal:       16384000 kB
MemFree:         8192000 kB
MemAvailable:   12288000 kB
Buffers:          512000 kB
Cached:          2048000 kB
SwapCached:           0 kB
Active:          4096000 kB
Inactive:        2048000 kB
SwapTotal:       4194304 kB
SwapFree:        4194304 kB
Dirty:               128 kB
Writeback:             0 kB
`;

describe("parseMeminfo", () => {
  test("parses all four expected fields correctly", () => {
    const result = parseMeminfo(FULL_MEMINFO);
    expect(result.total_kb).toBe(16_384_000);
    expect(result.available_kb).toBe(12_288_000);
    expect(result.swap_total_kb).toBe(4_194_304);
    expect(result.swap_free_kb).toBe(4_194_304);
  });

  test("missing MemAvailable defaults to 0", () => {
    const content = `MemTotal:       8388608 kB\nSwapTotal:      1048576 kB\nSwapFree:       1048576 kB\n`;
    const result = parseMeminfo(content);
    expect(result.total_kb).toBe(8_388_608);
    expect(result.available_kb).toBe(0);
  });

  test("missing SwapTotal defaults to 0", () => {
    const content = `MemTotal:       4194304 kB\nMemAvailable:   2097152 kB\n`;
    const result = parseMeminfo(content);
    expect(result.swap_total_kb).toBe(0);
    expect(result.swap_free_kb).toBe(0);
  });

  test("completely empty content returns all zeros", () => {
    const result = parseMeminfo("");
    expect(result.total_kb).toBe(0);
    expect(result.available_kb).toBe(0);
    expect(result.swap_total_kb).toBe(0);
    expect(result.swap_free_kb).toBe(0);
  });

  test("non-matching lines are silently ignored", () => {
    const content = `# This is a comment\nSomeGarbage: xyz\nMemTotal:       2097152 kB\nnotakbfield: 9999 MB\n`;
    const result = parseMeminfo(content);
    expect(result.total_kb).toBe(2_097_152);
    // Garbage lines don't affect other fields
    expect(result.available_kb).toBe(0);
  });

  test("fields without ' kB' suffix are not matched", () => {
    // Some /proc/meminfo fields have no unit (HugePages_Total, etc.)
    const content = `HugePages_Total:       0\nMemTotal:       1048576 kB\n`;
    const result = parseMeminfo(content);
    expect(result.total_kb).toBe(1_048_576);
  });

  test("duplicate field: last occurrence wins", () => {
    // Map.set overwrites — if MemTotal appears twice, second wins
    const content = `MemTotal:       1000 kB\nMemTotal:       2000 kB\n`;
    const result = parseMeminfo(content);
    expect(result.total_kb).toBe(2000);
  });

  test("returns a fresh object (no shared mutation between calls)", () => {
    const r1 = parseMeminfo(FULL_MEMINFO);
    const r2 = parseMeminfo(FULL_MEMINFO);
    expect(r1).not.toBe(r2); // different object references
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// Integration: real /proc/self/stat (platform-guarded)
// ---------------------------------------------------------------------------

const hasProcSelf =
  process.platform === "linux" && existsSync("/proc/self/stat");

describe("real /proc/self/stat (integration — linux only)", () => {
  test.skipIf(!hasProcSelf)("parseProcStatTicks returns a non-negative number", () => {
    const content = readFileSync("/proc/self/stat", "utf-8");
    const ticks = parseProcStatTicks(content);
    expect(ticks).not.toBeNull();
    expect(ticks!).toBeGreaterThanOrEqual(0);
  });

  test.skipIf(!hasProcSelf)("parseProcStatPpid returns a positive integer", () => {
    const content = readFileSync("/proc/self/stat", "utf-8");
    const ppid = parseProcStatPpid(content);
    expect(ppid).not.toBeNull();
    // ppid of any process we can read should be ≥ 1
    expect(ppid!).toBeGreaterThanOrEqual(1);
  });

  test.skipIf(!hasProcSelf)(
    "both parsers agree on the same stat line content",
    () => {
      // Read once — ticks and ppid come from the same file contents
      const content = readFileSync("/proc/self/stat", "utf-8");
      const ticks = parseProcStatTicks(content);
      const ppid = parseProcStatPpid(content);
      expect(ticks).not.toBeNull();
      expect(ppid).not.toBeNull();
    },
  );
});

const hasProcMeminfo =
  process.platform === "linux" && existsSync("/proc/meminfo");

describe("real /proc/meminfo (integration — linux only)", () => {
  test.skipIf(!hasProcMeminfo)("parseMeminfo returns positive MemTotal", () => {
    const content = readFileSync("/proc/meminfo", "utf-8");
    const info = parseMeminfo(content);
    expect(info.total_kb).toBeGreaterThan(0);
  });

  test.skipIf(!hasProcMeminfo)("parseMeminfo available_kb ≤ total_kb", () => {
    const content = readFileSync("/proc/meminfo", "utf-8");
    const info = parseMeminfo(content);
    expect(info.available_kb).toBeLessThanOrEqual(info.total_kb);
  });
});
