/**
 * platform-detect.test.ts — Tests for platform.ts detectPlatform() factory
 *
 * Tests: detectPlatform() singleton, Platform interface shape, platform id
 * matching the current runtime environment, and resetPlatform() for test isolation.
 *
 * CRITICAL: We NEVER mutate process.platform or process.env.TERMUX_VERSION.
 * Detection logic that branches on those globals is tested by asserting the
 * returned platform id matches what the current environment dictates.
 *
 * Convention: import source with .js extension (esbuild CJS output).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { detectPlatform, resetPlatform } from "../platform/platform.js";
import type { Platform, PlatformId } from "../platform/platform.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the expected platform id using the same logic as detectPlatform()
 * (without actually calling detectPlatform, so the test is self-contained).
 */
function expectedPlatformId(): PlatformId {
  if (process.env.TERMUX_VERSION) return "android";
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "windows";
  return "linux";
}

// ---------------------------------------------------------------------------
// detectPlatform — singleton behavior
// ---------------------------------------------------------------------------

describe("detectPlatform — singleton", () => {
  beforeEach(() => {
    // Reset so each test starts with a fresh singleton
    resetPlatform();
  });

  test("returns an object (not null/undefined)", () => {
    const p = detectPlatform();
    expect(p).not.toBeNull();
    expect(typeof p).toBe("object");
  });

  test("returns the same object on repeated calls (singleton)", () => {
    const p1 = detectPlatform();
    const p2 = detectPlatform();
    // Strict reference equality — no re-instantiation on second call
    expect(p1).toBe(p2);
  });

  test("after resetPlatform(), returns a fresh instance (still same id)", () => {
    const p1 = detectPlatform();
    resetPlatform();
    const p2 = detectPlatform();
    // New instance after reset
    expect(p1).not.toBe(p2);
    // But same platform id (environment hasn't changed)
    expect(p2.id).toBe(p1.id);
  });
});

// ---------------------------------------------------------------------------
// detectPlatform — platform id matches current environment
// ---------------------------------------------------------------------------

describe("detectPlatform — platform id", () => {
  beforeEach(() => {
    resetPlatform();
  });

  test("id matches the current environment's detection logic", () => {
    const p = detectPlatform();
    expect(p.id).toBe(expectedPlatformId());
  });

  test("id is one of the valid PlatformId values", () => {
    const validIds: PlatformId[] = ["android", "linux", "darwin", "windows"];
    const p = detectPlatform();
    expect(validIds).toContain(p.id);
  });

  test("id is a non-empty string", () => {
    const p = detectPlatform();
    expect(typeof p.id).toBe("string");
    expect(p.id.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Platform interface — shape verification
// IMPORTANT: The interface has 30+ methods. We spot-check the required
// contract by verifying method presence and callability rather than
// exhaustively invoking side-effectful methods.
// ---------------------------------------------------------------------------

describe("Platform interface shape", () => {
  let platform: Platform;

  beforeEach(() => {
    resetPlatform();
    platform = detectPlatform();
  });

  // -- Mandatory fields -------------------------------------------------------

  test("has readonly id of type string", () => {
    expect(typeof platform.id).toBe("string");
  });

  test("has readonly hasAdb of type boolean", () => {
    expect(typeof platform.hasAdb).toBe("boolean");
  });

  // -- Memory/Process methods -------------------------------------------------

  test("getSystemMemory is a function", () => {
    expect(typeof platform.getSystemMemory).toBe("function");
  });

  test("readProcessCpuTicks is a function", () => {
    expect(typeof platform.readProcessCpuTicks).toBe("function");
  });

  test("buildProcessTree is a function", () => {
    expect(typeof platform.buildProcessTree).toBe("function");
  });

  test("isProcessAlive is a function", () => {
    expect(typeof platform.isProcessAlive).toBe("function");
  });

  test("readProcessCwd is a function", () => {
    expect(typeof platform.readProcessCwd).toBe("function");
  });

  test("hasAncestorComm is a function", () => {
    expect(typeof platform.hasAncestorComm).toBe("function");
  });

  // -- Notification methods ---------------------------------------------------

  test("notify is a function", () => {
    expect(typeof platform.notify).toBe("function");
  });

  test("notifyWithArgs is a function", () => {
    expect(typeof platform.notifyWithArgs).toBe("function");
  });

  test("removeNotification is a function", () => {
    expect(typeof platform.removeNotification).toBe("function");
  });

  test("killTrackedNotifyProcesses is a function", () => {
    expect(typeof platform.killTrackedNotifyProcesses).toBe("function");
  });

  test("killStaleNotifyProcesses is a function", () => {
    expect(typeof platform.killStaleNotifyProcesses).toBe("function");
  });

  // -- Battery/radio methods --------------------------------------------------

  test("getBatteryStatus is a function", () => {
    expect(typeof platform.getBatteryStatus).toBe("function");
  });

  test("disableRadios is a function", () => {
    expect(typeof platform.disableRadios).toBe("function");
  });

  test("enableRadios is a function", () => {
    expect(typeof platform.enableRadios).toBe("function");
  });

  test("sendBatteryAlert is a function", () => {
    expect(typeof platform.sendBatteryAlert).toBe("function");
  });

  // -- Wake lock --------------------------------------------------------------

  test("acquireWakeLock is a function", () => {
    expect(typeof platform.acquireWakeLock).toBe("function");
  });

  // -- Session env methods ----------------------------------------------------

  test("cleanEnv is a function", () => {
    expect(typeof platform.cleanEnv).toBe("function");
  });

  test("amEnv is a function", () => {
    expect(typeof platform.amEnv).toBe("function");
  });

  test("ensureTmuxLdPreload is a function", () => {
    expect(typeof platform.ensureTmuxLdPreload).toBe("function");
  });

  // -- Terminal tab methods ---------------------------------------------------

  test("createTerminalTab is a function", () => {
    expect(typeof platform.createTerminalTab).toBe("function");
  });

  test("bringTerminalToForeground is a function", () => {
    expect(typeof platform.bringTerminalToForeground).toBe("function");
  });

  test("runScriptInTab is a function", () => {
    expect(typeof platform.runScriptInTab).toBe("function");
  });

  // -- ADB methods -----------------------------------------------------------

  test("resolveAdbPath is a function", () => {
    expect(typeof platform.resolveAdbPath).toBe("function");
  });

  test("applyPhantomFix is a function", () => {
    expect(typeof platform.applyPhantomFix).toBe("function");
  });

  test("resolveLocalIp is a function", () => {
    expect(typeof platform.resolveLocalIp).toBe("function");
  });

  // -- Budget method ----------------------------------------------------------

  test("countPhantomProcesses is a function", () => {
    expect(typeof platform.countPhantomProcesses).toBe("function");
  });

  // -- Path methods -----------------------------------------------------------

  test("configPaths is a function", () => {
    expect(typeof platform.configPaths).toBe("function");
  });

  test("defaultSocketPath is a function", () => {
    expect(typeof platform.defaultSocketPath).toBe("function");
  });

  test("defaultStatePath is a function", () => {
    expect(typeof platform.defaultStatePath).toBe("function");
  });

  test("defaultLogDir is a function", () => {
    expect(typeof platform.defaultLogDir).toBe("function");
  });

  test("resolveBinaryPath is a function", () => {
    expect(typeof platform.resolveBinaryPath).toBe("function");
  });

  test("resolveRuntimePath is a function", () => {
    expect(typeof platform.resolveRuntimePath).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Platform behavioral contracts — safe calls that must not throw
// These call methods with safe/no-op inputs and verify the return types.
// ---------------------------------------------------------------------------

describe("Platform behavioral contracts", () => {
  let platform: Platform;

  beforeEach(() => {
    resetPlatform();
    platform = detectPlatform();
  });

  test("isProcessAlive(process.pid) returns true", () => {
    // Every platform's isProcessAlive must work for the current process
    // (Android/Linux use /proc; others use OS APIs)
    const alive = platform.isProcessAlive(process.pid);
    expect(alive).toBe(true);
  });

  test("isProcessAlive(2147483647) returns false", () => {
    // No process has PID 2^31-1 in practice
    expect(platform.isProcessAlive(2_147_483_647)).toBe(false);
  });

  test("readProcessCpuTicks(process.pid) returns a non-negative number or null", () => {
    const ticks = platform.readProcessCpuTicks(process.pid);
    if (ticks !== null) {
      expect(typeof ticks).toBe("number");
      expect(ticks).toBeGreaterThanOrEqual(0);
    } else {
      // null is acceptable on platforms without /proc
      expect(ticks).toBeNull();
    }
  });

  test("buildProcessTree() returns a Map", () => {
    const tree = platform.buildProcessTree();
    expect(tree).toBeInstanceOf(Map);
  });

  test("readProcessCwd(process.pid) returns a string or null", () => {
    const cwd = platform.readProcessCwd(process.pid);
    if (cwd !== null) {
      expect(typeof cwd).toBe("string");
      expect(cwd.length).toBeGreaterThan(0);
    }
    // null is acceptable on platforms without /proc symlinks
  });

  test("hasAncestorComm with bogus comm returns false, not throw", () => {
    const result = platform.hasAncestorComm(process.pid, "zz_no_such_process_comm");
    expect(result).toBe(false);
  });

  test("configPaths() returns a non-empty array of strings", () => {
    const paths = platform.configPaths();
    expect(Array.isArray(paths)).toBe(true);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(typeof p).toBe("string");
      expect(p.startsWith("/")).toBe(true); // all config paths are absolute
    }
  });

  test("defaultSocketPath() returns an absolute path string", () => {
    const sock = platform.defaultSocketPath();
    expect(typeof sock).toBe("string");
    expect(sock.startsWith("/")).toBe(true);
    expect(sock.length).toBeGreaterThan(1);
  });

  test("defaultStatePath() returns an absolute path string", () => {
    const state = platform.defaultStatePath();
    expect(typeof state).toBe("string");
    expect(state.startsWith("/")).toBe(true);
  });

  test("defaultLogDir() returns an absolute path string", () => {
    const logDir = platform.defaultLogDir();
    expect(typeof logDir).toBe("string");
    expect(logDir.startsWith("/")).toBe(true);
  });

  test("resolveBinaryPath('ls') returns a non-empty string", () => {
    // 'ls' exists on all platforms we support
    const resolved = platform.resolveBinaryPath("ls");
    expect(typeof resolved).toBe("string");
    expect(resolved.length).toBeGreaterThan(0);
  });

  test("resolveRuntimePath() returns a non-empty string", () => {
    const rt = platform.resolveRuntimePath();
    expect(typeof rt).toBe("string");
    expect(rt.length).toBeGreaterThan(0);
  });

  test("cleanEnv() returns an object and does not contain CLAUDECODE", () => {
    // Even if CLAUDECODE is not set, the result should be an object
    const env = platform.cleanEnv();
    expect(typeof env).toBe("object");
    expect(env).not.toBeNull();
    // Must not expose Claude nesting detection vars
    expect("CLAUDECODE" in env).toBe(false);
  });

  test("amEnv() returns an object (not null)", () => {
    const env = platform.amEnv();
    expect(typeof env).toBe("object");
    expect(env).not.toBeNull();
  });

  test("countPhantomProcesses() returns a non-negative integer", () => {
    const count = platform.countPhantomProcesses();
    expect(typeof count).toBe("number");
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("resolveLocalIp() returns null or a string", () => {
    const ip = platform.resolveLocalIp();
    if (ip !== null) {
      expect(typeof ip).toBe("string");
      expect(ip.length).toBeGreaterThan(0);
    }
    // null is fine — no network tools / CI environment
  });

  test("killStaleNotifyProcesses() returns a non-negative integer", () => {
    const killed = platform.killStaleNotifyProcesses();
    expect(typeof killed).toBe("number");
    expect(killed).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Android-specific: hasAdb=true on this device (TERMUX_VERSION is set)
// ---------------------------------------------------------------------------

describe("AndroidPlatform specifics (Android/Termux only)", () => {
  const isAndroid = !!process.env.TERMUX_VERSION;

  beforeEach(() => {
    resetPlatform();
  });

  test.skipIf(!isAndroid)("hasAdb is true on Android/Termux", () => {
    const p = detectPlatform();
    expect(p.hasAdb).toBe(true);
  });

  test.skipIf(!isAndroid)("id is 'android'", () => {
    const p = detectPlatform();
    expect(p.id).toBe("android");
  });

  test.skipIf(!isAndroid)(
    "defaultSocketPath() uses $PREFIX/tmp (not /tmp which is absent on Termux)",
    () => {
      const p = detectPlatform();
      const sock = p.defaultSocketPath();
      // On Termux, /tmp doesn't exist; socket must live under $PREFIX/tmp
      expect(sock).not.toContain("/tmp/operad");
      // Must be under the Termux prefix
      const prefix = process.env.PREFIX ?? "/data/data/com.termux/files/usr";
      expect(sock.startsWith(prefix)).toBe(true);
    },
  );

  test.skipIf(!isAndroid)(
    "resolveBinaryPath('tmux') returns an absolute path under $PREFIX/bin",
    () => {
      const p = detectPlatform();
      const resolved = p.resolveBinaryPath("tmux");
      // If tmux is installed, we get the $PREFIX/bin/tmux path
      const prefix = process.env.PREFIX ?? "/data/data/com.termux/files/usr";
      if (resolved !== "tmux") {
        expect(resolved.startsWith(prefix + "/bin/")).toBe(true);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Non-Android: hasAdb=false (test only when NOT on Android/Termux)
// ---------------------------------------------------------------------------

describe("Non-Android platform specifics", () => {
  const isNonAndroid = !process.env.TERMUX_VERSION;

  beforeEach(() => {
    resetPlatform();
  });

  test.skipIf(!isNonAndroid)("hasAdb is false on non-Android platforms", () => {
    const p = detectPlatform();
    expect(p.hasAdb).toBe(false);
  });

  test.skipIf(!isNonAndroid)("id is 'linux' or 'darwin' or 'windows'", () => {
    const p = detectPlatform();
    const nonAndroid: PlatformId[] = ["linux", "darwin", "windows"];
    expect(nonAndroid).toContain(p.id);
  });
});
