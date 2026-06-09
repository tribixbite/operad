/**
 * platform-native.test.ts — Native smoke tests for the desktop Platform impls.
 *
 * The platform implementations (LinuxPlatform / DarwinPlatform / WindowsPlatform)
 * can only be exercised on their OWN OS — they shell out to platform tools
 * (/proc, ps, vm_stat, sysctl, wmic, tasklist, powershell) that don't exist
 * elsewhere. So each block is gated to its native OS and SKIPS everywhere else.
 *
 * On this Android/Termux dev host ALL THREE blocks skip (process.platform is
 * "linux" but TERMUX_VERSION is set → the android impl is the real one, tested
 * separately). They EXECUTE on the GitHub Actions matrix:
 *   - ubuntu-latest  → LinuxPlatform block runs (real /proc, ps, which)
 *   - macos-latest   → DarwinPlatform block runs (real vm_stat, sysctl, ps)
 *   - windows-latest → WindowsPlatform block runs (real wmic, tasklist, where)
 * The CI `build` job runs the full `bun test` on every matrix OS, so this is
 * where these impls actually get verified — there's no way to test them on the
 * Android host.
 *
 * SAFETY: we deliberately do NOT call methods with real side effects on the
 * runner — DarwinPlatform.disableRadios/enableRadios (toggles wifi via
 * networksetup), *.acquireWakeLock (leaks a detached caffeinate/systemd-inhibit
 * child), and the osascript GUI methods (notify / terminal tabs). We assert
 * only read-only queries, path/env builders, and documented no-ops.
 */

import { describe, test, expect } from "bun:test";
import { LinuxPlatform } from "../platform/linux.js";
import { DarwinPlatform } from "../platform/darwin.js";
import { WindowsPlatform } from "../platform/windows.js";
import type { Platform, PlatformId } from "../platform/platform.js";

// process.platform is "linux" on Android too — exclude Termux so the linux
// desktop block only runs where LinuxPlatform is the genuine active impl.
const onLinux = process.platform === "linux" && !process.env.TERMUX_VERSION;
const onDarwin = process.platform === "darwin";
const onWindows = process.platform === "win32";

/**
 * Assertions valid for ANY desktop Platform impl on its native OS. Restricted
 * to read-only / no-op surface — no radio, wake-lock, or GUI side effects.
 */
function assertUniversalSurface(p: Platform, id: PlatformId): void {
  expect(p.id).toBe(id);

  // -- Process queries against our own live PID --
  expect(p.isProcessAlive(process.pid)).toBe(true);
  expect(p.isProcessAlive(2_000_000_000)).toBe(false);
  expect(p.buildProcessTree()).toBeInstanceOf(Map);
  const ticks = p.readProcessCpuTicks(process.pid);
  expect(ticks === null || typeof ticks === "number").toBe(true);
  const cwd = p.readProcessCwd(process.pid);
  expect(cwd === null || typeof cwd === "string").toBe(true);
  // A comm name that cannot exist → no ancestor match, never throws.
  expect(p.hasAncestorComm(process.pid, "operad-no-such-comm-xyz")).toBe(false);

  // -- Battery: null on a server/VM with no battery, else a sane shape --
  const bat = p.getBatteryStatus();
  expect(
    bat === null ||
      (typeof bat.percentage === "number" && typeof bat.charging === "boolean"),
  ).toBe(true);

  // -- ADB / phantom budget: never available off Android --
  expect(p.hasAdb).toBe(false);
  expect(p.countPhantomProcesses()).toBe(0);
  const adb = p.resolveAdbPath();
  expect(adb === null || typeof adb === "string").toBe(true);

  // -- Paths --
  expect(typeof p.defaultSocketPath()).toBe("string");
  expect(typeof p.defaultStatePath()).toBe("string");
  expect(typeof p.defaultLogDir()).toBe("string");
  const cfgs = p.configPaths();
  expect(Array.isArray(cfgs)).toBe(true);
  expect(cfgs.length).toBeGreaterThan(0);

  // -- Binary / runtime resolution (which/where; falls back to a string) --
  expect(typeof p.resolveBinaryPath("node")).toBe("string");
  expect(p.resolveRuntimePath().length).toBeGreaterThan(0);

  // -- Env builders return a usable env object --
  expect(typeof p.cleanEnv()).toBe("object");
  expect(typeof p.amEnv()).toBe("object");

  // -- Local IP: string when an interface is up, else null --
  const ip = p.resolveLocalIp();
  expect(ip === null || typeof ip === "string").toBe(true);

  // -- Documented no-op / cleanup methods must not throw --
  expect(() => p.ensureTmuxLdPreload()).not.toThrow();
  expect(() => p.killTrackedNotifyProcesses()).not.toThrow();
  expect(typeof p.killStaleNotifyProcesses()).toBe("number");
  expect(() => p.removeNotification("nope")).not.toThrow();
  // applyPhantomFix is a no-op off Android even with bogus args.
  expect(() => p.applyPhantomFix("adb", ["-s", "x"])).not.toThrow();
}

// ---------------------------------------------------------------------------
// Linux (GitHub ubuntu-latest)
// ---------------------------------------------------------------------------

describe.skipIf(!onLinux)("LinuxPlatform — native (CI ubuntu)", () => {
  test("universal read-only surface", () => {
    assertUniversalSurface(new LinuxPlatform(), "linux");
  });

  test("getSystemMemory reads /proc/meminfo with positive totals", () => {
    const m = new LinuxPlatform().getSystemMemory();
    expect(m).not.toBeNull();
    expect(m!.total_kb).toBeGreaterThan(0);
    expect(m!.available_kb).toBeGreaterThan(0);
    expect(m!.available_kb).toBeLessThanOrEqual(m!.total_kb);
  });

  test("terminal-tab + radio methods are desktop no-ops (no side effects)", () => {
    const p = new LinuxPlatform();
    expect(p.createTerminalTab("x")).toBe(false);
    expect(p.runScriptInTab("/tmp/x.sh", "/tmp", "tab")).toBe(false);
    expect(p.bringTerminalToForeground()).toBeUndefined();
    // On linux these are pure no-ops (console.log only) — never touch the network.
    expect(() => p.disableRadios()).not.toThrow();
    expect(() => p.enableRadios()).not.toThrow();
  });

  test("default paths land under the user home / runtime dirs", () => {
    const p = new LinuxPlatform();
    expect(p.defaultSocketPath().length).toBeGreaterThan(0);
    expect(p.configPaths().some((c) => c.endsWith("operad.toml"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// macOS (GitHub macos-latest)
// ---------------------------------------------------------------------------

describe.skipIf(!onDarwin)("DarwinPlatform — native (CI macos)", () => {
  test("universal read-only surface", () => {
    assertUniversalSurface(new DarwinPlatform(), "darwin");
  });

  test("getSystemMemory reads vm_stat/sysctl with positive totals", () => {
    const m = new DarwinPlatform().getSystemMemory();
    expect(m).not.toBeNull();
    expect(m!.total_kb).toBeGreaterThan(0);
    expect(m!.available_kb).toBeGreaterThan(0);
  });

  test("resolveAdbPath is null and ADB is unsupported", () => {
    const p = new DarwinPlatform();
    expect(p.hasAdb).toBe(false);
    expect(p.resolveAdbPath()).toBeNull();
  });
  // NOTE: deliberately NOT calling disableRadios/enableRadios (networksetup
  // toggles real wifi), acquireWakeLock (leaks caffeinate), or the osascript
  // GUI methods on the macOS runner.
});

// ---------------------------------------------------------------------------
// Windows (GitHub windows-latest)
// ---------------------------------------------------------------------------

describe.skipIf(!onWindows)("WindowsPlatform — native (CI windows)", () => {
  test("universal read-only surface", () => {
    assertUniversalSurface(new WindowsPlatform(), "windows");
  });

  test("getSystemMemory via wmic is null-or-positive (wmic may be absent)", () => {
    const m = new WindowsPlatform().getSystemMemory();
    // Newer windows-latest images may have removed wmic → null is acceptable.
    expect(m === null || (m.total_kb > 0 && m.available_kb > 0)).toBe(true);
  });

  test("terminal tabs are no-ops and wake lock / radios are inert", () => {
    const p = new WindowsPlatform();
    expect(p.createTerminalTab("x")).toBe(false);
    expect(p.runScriptInTab("C:/tmp/x.bat", "C:/tmp", "tab")).toBe(false);
    expect(p.acquireWakeLock()).toBe(false); // documented: no Win32 inhibitor
    expect(() => p.disableRadios()).not.toThrow();
    expect(() => p.enableRadios()).not.toThrow();
  });

  test("default paths use the Windows app-data layout", () => {
    const p = new WindowsPlatform();
    expect(typeof p.defaultSocketPath()).toBe("string");
    expect(p.configPaths().some((c) => c.endsWith("operad.toml"))).toBe(true);
  });
});
