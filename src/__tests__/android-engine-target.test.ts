/**
 * android-engine-target.test.ts — which device does each adb/am command hit?
 *
 * Every synchronous child process AndroidEngine starts goes through the
 * injected `run` dep, so these tests drive the engine against a scripted fake
 * adb and record each invocation. Nothing here touches a real adb, a real
 * `am`, or the user's device.
 *
 * Covered:
 *   - an `emulator-*` serial is NOT assumed to be this device; boot_id decides
 *   - applyPhantomFix resolves + verifies the serial ONCE and addresses every
 *     command to it with `-s`, even if the serial cache drops mid-run
 *   - launchApp refuses to send `adb monkey` to a non-local target
 *   - launchApp's local `am start` uses the resolved binary + amEnv()
 *   - fixAdb with an empty connect_script skips the connect step instead of
 *     running `timeout 45 ""` (exit 127) forever
 */

import { describe, test, expect, afterEach } from "bun:test";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { AndroidEngine } from "../android-engine.js";
import type { AndroidEngineDeps, SyncRunResult } from "../android-engine.js";
import type { Platform } from "../platform/platform.js";

const LOCAL_BOOT = "11111111-2222-3333-4444-555555555555";
const OTHER_BOOT = "99999999-8888-7777-6666-555555555555";
const ADB = "/fake/adb";
const AM = "/fake/prefix/bin/am";
const AM_PRELOAD = "/fake/prefix/lib/libtermux-exec-ld-preload.so";

/** One recorded child-process invocation. */
interface Call {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

/** Scripted device: what `adb devices` lists and what boot_id each serial reports. */
interface FakeDevice {
  /** Raw `adb devices` output. Mutable so a test can drop the device mid-run. */
  devices: string;
  /** serial → boot_id reported over `adb -s <serial> shell cat .../boot_id`. */
  bootIds: Record<string, string>;
  /** Hook run on every `adb shell` command (after boot_id probes). */
  onShell?: (args: string[]) => void;
}

function ok(stdout = ""): SyncRunResult {
  return { status: 0, stdout, stderr: "" };
}

function makeFakeRun(dev: FakeDevice, calls: Call[]) {
  return (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding): SyncRunResult => {
    calls.push({ command, args, env: options.env });
    if (command !== ADB) return ok("Starting: Intent { cmp=x }");
    if (args[0] === "devices") return ok(dev.devices);
    if (args[0] === "disconnect") return ok();
    const shellAt = args.indexOf("shell");
    const shell = args.slice(shellAt + 1);
    if (shell[0] === "cat" && shell[1] === "/proc/sys/kernel/random/boot_id") {
      const serial = args[0] === "-s" ? args[1] : "";
      const id = dev.bootIds[serial];
      return id ? ok(`${id}\r\n`) : { status: 1, stdout: "", stderr: "no device" };
    }
    if (shell[0] === "getprop") return ok("Fake Model\r\n");
    dev.onShell?.(args);
    if (shell[0] === "pidof") return ok("4242");
    return ok();
  };
}

function makePlatform(notes: string[]): Platform {
  return {
    resolveLocalIp: () => null,
    notify: (title: string, body: string) => { notes.push(`${title}: ${body}`); },
    resolveBinaryPath: (name: string) => `/fake/prefix/bin/${name}`,
    amEnv: () => ({ PATH: "/fake/prefix/bin", LD_PRELOAD: AM_PRELOAD }),
  } as unknown as Platform;
}

interface Harness {
  engine: AndroidEngine;
  calls: Call[];
  notes: string[];
  warnings: string[];
  adbFixed: boolean[];
}

function makeEngine(dev: FakeDevice, opts: { connectScript?: string; phantomFix?: boolean } = {}): Harness {
  const calls: Call[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  const adbFixed: boolean[] = [];
  const ctx: any = {
    config: {
      adb: {
        connect_script: opts.connectScript ?? "",
        connect_timeout_s: 5,
        retry_interval_s: 3600,
        phantom_fix: opts.phantomFix ?? true,
      },
    },
    log: { info() {}, warn(m: string) { warnings.push(m); }, error() {}, debug() {} },
    state: {
      setAdbFixed(v: boolean) { adbFixed.push(v); },
      getState: () => ({ adb_fixed: adbFixed[adbFixed.length - 1] ?? false }),
    },
  };
  const deps: AndroidEngineDeps = {
    run: makeFakeRun(dev, calls),
    platform: makePlatform(notes),
    readLocalBootId: () => LOCAL_BOOT,
    adbBin: ADB,
  };
  return { engine: new AndroidEngine(ctx, deps), calls, notes, warnings, adbFixed };
}

/** adb invocations that ran a device shell command other than identity probes. */
function shellCommands(calls: Call[]): Call[] {
  return calls.filter((c) =>
    c.command === ADB && c.args.includes("shell") &&
    !c.args.includes("/proc/sys/kernel/random/boot_id") && !c.args.includes("getprop"));
}

const engines: AndroidEngine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.stopRetryTimer();
});

// ---------------------------------------------------------------------------

describe("isLocalAdbDevice — emulator serials", () => {
  test("emulator-5554 with a different boot_id is NOT this device", () => {
    const h = makeEngine({
      devices: "List of devices attached\nemulator-5554\tdevice\n",
      bootIds: { "emulator-5554": OTHER_BOOT },
    });
    expect(h.engine.isLocalAdbDevice()).toBe(false);
  });

  test("emulator-5554 reporting our own boot_id IS this device (operad inside the emulator)", () => {
    const h = makeEngine({
      devices: "List of devices attached\nemulator-5554\tdevice\n",
      bootIds: { "emulator-5554": LOCAL_BOOT },
    });
    expect(h.engine.isLocalAdbDevice()).toBe(true);
  });

  test("loopback serial is still trusted without a boot_id probe", () => {
    const h = makeEngine({
      devices: "List of devices attached\n127.0.0.1:5555\tdevice\n",
      bootIds: {},
    });
    expect(h.engine.isLocalAdbDevice()).toBe(true);
  });
});

describe("applyPhantomFix — one verified serial for the whole run", () => {
  test("every shell command carries -s <verified serial> even when the device drops mid-run", () => {
    const dev: FakeDevice = {
      devices: "List of devices attached\n127.0.0.1:5555\tdevice\n",
      bootIds: {},
    };
    const h = makeEngine(dev);
    // After the first protection command the cached serial expires and adb
    // no longer lists any device — re-resolution would yield null.
    dev.onShell = () => {
      h.engine.invalidateAdbSerial();
      dev.devices = "List of devices attached\n";
    };
    h.engine.applyPhantomFix();
    const cmds = shellCommands(h.calls);
    expect(cmds.length).toBeGreaterThan(10);
    for (const c of cmds) {
      expect(c.args.slice(0, 3)).toEqual(["-s", "127.0.0.1:5555", "shell"]);
    }
  });

  test("refuses to run anything when no device is online", () => {
    const h = makeEngine({ devices: "List of devices attached\n", bootIds: {} });
    h.engine.applyPhantomFix();
    expect(shellCommands(h.calls)).toEqual([]);
  });

  test("refuses to run anything on an external device", () => {
    const h = makeEngine({
      devices: "List of devices attached\n192.168.1.50:5555\tdevice\n",
      bootIds: { "192.168.1.50:5555": OTHER_BOOT },
    });
    h.engine.applyPhantomFix();
    expect(shellCommands(h.calls)).toEqual([]);
  });
});

describe("launchApp — device targeting", () => {
  test("never sends adb monkey to a device that is not this one", () => {
    const h = makeEngine({
      devices: "List of devices attached\n192.168.1.50:5555\tdevice\n",
      bootIds: { "192.168.1.50:5555": OTHER_BOOT },
    });
    h.engine.launchApp("com.example.app");
    const monkey = h.calls.filter((c) => c.command === ADB && c.args.includes("monkey"));
    expect(monkey).toEqual([]);
  });

  test("adb monkey on the verified local device is addressed with -s", () => {
    const h = makeEngine({
      devices: "List of devices attached\n127.0.0.1:5555\tdevice\n",
      bootIds: {},
    });
    const res = h.engine.launchApp("com.example.app");
    expect(res.status).toBe(200);
    const monkey = h.calls.filter((c) => c.command === ADB && c.args.includes("monkey"));
    expect(monkey.length).toBe(1);
    expect(monkey[0].args.slice(0, 3)).toEqual(["-s", "127.0.0.1:5555", "shell"]);
  });

  test("component launch runs the resolved am binary with amEnv() (LD_PRELOAD)", () => {
    const h = makeEngine({ devices: "List of devices attached\n", bootIds: {} });
    const res = h.engine.launchApp("com.example.app/.MainActivity");
    expect(res.status).toBe(200);
    const am = h.calls.filter((c) => c.command !== ADB);
    expect(am.length).toBe(1);
    expect(am[0].command).toBe(AM);
    expect(am[0].env?.LD_PRELOAD).toBe(AM_PRELOAD);
  });

  test("package fallback (no adb) runs the resolved am binary with amEnv()", () => {
    const h = makeEngine({ devices: "List of devices attached\n", bootIds: {} });
    const res = h.engine.launchApp("com.example.app");
    expect(res.status).toBe(200);
    const am = h.calls.filter((c) => c.command !== ADB);
    expect(am.length).toBe(1);
    expect(am[0].command).toBe(AM);
    expect(am[0].args).toEqual(["start", "-n", "com.example.app/.MainActivity"]);
    expect(am[0].env?.LD_PRELOAD).toBe(AM_PRELOAD);
  });
});

describe("fixAdb — empty connect_script", () => {
  test("skips the connect step and still applies the phantom fix to an online local device", async () => {
    const h = makeEngine({
      devices: "List of devices attached\n127.0.0.1:5555\tdevice\n",
      bootIds: {},
    });
    engines.push(h.engine);
    const ok = await h.engine.fixAdb();
    expect(ok).toBe(true);
    expect(h.adbFixed).toEqual([true]);
    expect(h.notes).toEqual([]);
    expect(shellCommands(h.calls).length).toBeGreaterThan(10);
  });

  test("with no device online it reports failure (and retries) without running a connect script", async () => {
    const h = makeEngine({ devices: "List of devices attached\n", bootIds: {} });
    engines.push(h.engine);
    const ok = await h.engine.fixAdb();
    expect(ok).toBe(false);
    expect(h.adbFixed).toEqual([false]);
    // The failure must name the real cause, not a phantom script failure.
    expect(h.warnings.join("\n")).toMatch(/no ADB device/i);
  });
});
