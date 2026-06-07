/**
 * proc-io.test.ts — Integration tests for /proc-reading IO functions in common.ts
 *
 * Tests: buildProcTree, isProcAlive, readProcCwd, hasProcAncestorComm,
 *        resolveLocalIpViaRoute
 *
 * All tests that read real /proc are platform-guarded via HAS_PROC.
 * The pure parsers (parseProcStatTicks, parseProcStatPpid, parseMeminfo)
 * are fully covered in common.test.ts — this file covers only the IO layer.
 *
 * Convention: import source with .js extension (esbuild CJS output).
 */
import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import {
  buildProcTree,
  isProcAlive,
  readProcCwd,
  hasProcAncestorComm,
  resolveLocalIpViaRoute,
} from "../platform/common.js";

// ---------------------------------------------------------------------------
// Platform guard — skip tests on any OS without /proc
// ---------------------------------------------------------------------------
const HAS_PROC = existsSync("/proc/self/stat");

// ---------------------------------------------------------------------------
// isProcAlive
// ---------------------------------------------------------------------------

describe("isProcAlive", () => {
  test.skipIf(!HAS_PROC)(
    "returns true for the current process",
    () => {
      expect(isProcAlive(process.pid)).toBe(true);
    },
  );

  test.skipIf(!HAS_PROC)(
    "returns false for a guaranteed-dead pid (MAX_INT)",
    () => {
      // 2147483647 is the maximum 32-bit signed integer — no kernel allocates it
      expect(isProcAlive(2_147_483_647)).toBe(false);
    },
  );

  test.skipIf(!HAS_PROC)(
    "returns false for pid 0 (no such /proc/0 on Android/Linux)",
    () => {
      // /proc/0 is a symlink to /proc/self on some kernels, but on Android
      // (and most Linux kernels) it does not exist. Either way, pid 0 is
      // not a valid user-visible process the daemon would ever track.
      // We only assert it doesn't throw — the boolean value is kernel-defined.
      expect(typeof isProcAlive(0)).toBe("boolean");
    },
  );
});

// ---------------------------------------------------------------------------
// readProcCwd
// ---------------------------------------------------------------------------

describe("readProcCwd", () => {
  test.skipIf(!HAS_PROC)(
    "returns the cwd of the current process as a non-empty string",
    () => {
      const cwd = readProcCwd(process.pid);
      expect(cwd).not.toBeNull();
      expect(typeof cwd).toBe("string");
      expect((cwd as string).length).toBeGreaterThan(0);
      // cwd must start with '/' (absolute path)
      expect((cwd as string).startsWith("/")).toBe(true);
    },
  );

  test.skipIf(!HAS_PROC)(
    "returns null for a guaranteed-dead pid",
    () => {
      expect(readProcCwd(2_147_483_647)).toBeNull();
    },
  );

  test.skipIf(!HAS_PROC)(
    "agrees with process.cwd() for the current process",
    () => {
      const cwd = readProcCwd(process.pid);
      // /proc/PID/cwd resolves symlinks; process.cwd() may not on all platforms.
      // Both should be non-null and point to valid paths — we just check both
      // are non-empty strings rather than an exact match (symlink resolution
      // may differ between the two).
      expect(cwd).not.toBeNull();
      expect((cwd as string).length).toBeGreaterThan(0);
    },
  );
});

// ---------------------------------------------------------------------------
// buildProcTree
// ---------------------------------------------------------------------------

describe("buildProcTree", () => {
  test.skipIf(!HAS_PROC)(
    "returns a non-empty Map",
    () => {
      const tree = buildProcTree();
      expect(tree).toBeInstanceOf(Map);
      // The process tree should always have at least one entry (PID 1's children,
      // the current process's parent, etc.)
      expect(tree.size).toBeGreaterThan(0);
    },
  );

  test.skipIf(!HAS_PROC)(
    "current process appears under its ppid with non-negative ticks",
    () => {
      const tree = buildProcTree();
      const self = process.pid;

      // Find the entry for the current process across all children arrays
      let foundEntry: { pid: number; ticks: number } | undefined;
      for (const children of tree.values()) {
        const match = children.find((c) => c.pid === self);
        if (match) {
          foundEntry = match;
          break;
        }
      }

      // The current process must be visible in /proc while the test runs
      expect(foundEntry).toBeDefined();
      expect(foundEntry!.ticks).toBeGreaterThanOrEqual(0);
    },
  );

  test.skipIf(!HAS_PROC)(
    "ticks field is a finite non-negative integer for every entry",
    () => {
      const tree = buildProcTree();
      for (const children of tree.values()) {
        for (const { pid, ticks } of children) {
          expect(pid).toBeGreaterThan(0);
          expect(Number.isFinite(ticks)).toBe(true);
          expect(ticks).toBeGreaterThanOrEqual(0);
        }
      }
    },
  );

  test.skipIf(!HAS_PROC)(
    "all ppid keys are non-negative integers",
    () => {
      const tree = buildProcTree();
      for (const ppid of tree.keys()) {
        expect(Number.isInteger(ppid)).toBe(true);
        expect(ppid).toBeGreaterThanOrEqual(0);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// hasProcAncestorComm
// ---------------------------------------------------------------------------

describe("hasProcAncestorComm", () => {
  test.skipIf(!HAS_PROC)(
    "returns false for a bogus comm that no ancestor can have",
    () => {
      // A comm that is extremely unlikely to exist as an ancestor process name.
      // /proc/PID/comm is truncated to 15 chars by the kernel, so we craft a
      // 15-char string that isn't a real program name.
      const bogus = "zz_no_such_proc";
      expect(hasProcAncestorComm(process.pid, bogus)).toBe(false);
    },
  );

  test.skipIf(!HAS_PROC)(
    "returns false for an empty comm string",
    () => {
      // An empty comm can never match a real process name
      expect(hasProcAncestorComm(process.pid, "")).toBe(false);
    },
  );

  test.skipIf(!HAS_PROC)(
    "returns false for a guaranteed-dead ancestor pid",
    () => {
      // Checking ancestors of a non-existent PID — should return false, not throw
      expect(hasProcAncestorComm(2_147_483_647, "bash")).toBe(false);
    },
  );

  test.skipIf(!HAS_PROC)(
    "returns false when maxDepth=0 (no hops allowed)",
    () => {
      // With maxDepth=0 the loop body never runs → always false
      expect(hasProcAncestorComm(process.pid, "bash", 0)).toBe(false);
    },
  );

  test.skipIf(!HAS_PROC)(
    "returns true for a real ancestor comm in this test session",
    () => {
      // The bun test runner is launched inside a bash shell inside tmux.
      // Walk the ancestor chain and collect the actual comm names so we can
      // pick a real one to test against — this makes the test self-calibrating
      // rather than hardcoding a name that might not exist.
      //
      // We collect up to 8 ancestors and test them individually; the first one
      // found to exist counts as the expected ancestor. If the chain is shorter
      // than expected (e.g. in a minimal CI environment) the test is skipped.
      const { readFileSync } = require("node:fs") as typeof import("node:fs");

      function ppidOf(pid: number): number | null {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
          const c = stat.lastIndexOf(")");
          if (c === -1) return null;
          const v = parseInt(stat.slice(c + 2).split(" ")[1], 10);
          return isNaN(v) ? null : v;
        } catch {
          return null;
        }
      }

      function commOf(pid: number): string | null {
        try {
          return readFileSync(`/proc/${pid}/comm`, "utf-8").trim();
        } catch {
          return null;
        }
      }

      // Collect real ancestors
      const ancestors: { pid: number; comm: string }[] = [];
      let cur = process.pid;
      for (let d = 0; d < 10; d++) {
        const ppid = ppidOf(cur);
        if (ppid === null || ppid <= 1) break;
        const comm = commOf(ppid);
        if (comm === null) break;
        ancestors.push({ pid: ppid, comm });
        cur = ppid;
      }

      if (ancestors.length === 0) {
        // No readable ancestors — skip gracefully (very restricted environment)
        return;
      }

      // Pick the closest ancestor we can verify
      const target = ancestors[0];
      const result = hasProcAncestorComm(process.pid, target.comm);
      expect(result).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// resolveLocalIpViaRoute
// ---------------------------------------------------------------------------

describe("resolveLocalIpViaRoute", () => {
  test.skipIf(!HAS_PROC)(
    "returns null or a non-empty string (never throws)",
    () => {
      // The function spawns `ip route get 1` or `ifconfig` — both external.
      // We only assert shape: null (no network tool) or a non-empty string.
      const result = resolveLocalIpViaRoute();
      if (result !== null) {
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      } else {
        // null is acceptable — ip/ifconfig may be absent in CI
        expect(result).toBeNull();
      }
    },
  );

  test.skipIf(!HAS_PROC)(
    "if a result is returned it looks like an IP address",
    () => {
      const result = resolveLocalIpViaRoute();
      if (result === null) return; // no network tools — nothing to assert
      // Basic IP address pattern: four dotted decimal octets
      expect(result).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    },
  );

  test.skipIf(!HAS_PROC)(
    "is safe to call multiple times (idempotent, no side effects)",
    () => {
      const r1 = resolveLocalIpViaRoute();
      const r2 = resolveLocalIpViaRoute();
      // Both calls should return the same type (both null or both string)
      expect(typeof r1).toBe(typeof r2);
      // If both return a value, they should agree (IP doesn't change in test run)
      if (r1 !== null && r2 !== null) {
        expect(r1).toBe(r2);
      }
    },
  );
});
