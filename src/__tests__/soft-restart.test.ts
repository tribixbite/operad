/**
 * soft-restart.test.ts — orphaning the tmux tree's cgroup with a framework
 * soft restart (`am hang --allow-restart`).
 *
 * Background (docs/persistence.md): an lmkd kill of com.termux removes every
 * process in the app's cgroup `/apps/uid_<uid>/pid_<app pid>`. A framework
 * soft restart kills the app without that sweep, so the tree keeps running in
 * a cgroup no live app owns, and later app kills never reach it.
 *
 * Nothing here touches a real device: every adb call goes through a scripted
 * fake, and time is a fake clock.
 */

import { describe, test, expect } from "bun:test";
import {
  parseAppCgroup,
  inspectTreeCgroup,
  softRestartFramework,
  WATCHDOG_TIMEOUT_SETTING,
  FAST_WATCHDOG_TIMEOUT_MS,
  SOFT_RESTART_ARGS,
} from "../soft-restart.js";
import type { SoftRestartDeps, ShellResult } from "../soft-restart.js";

const CGROUP_V2_ONLY = "0::/apps/uid_10364/pid_4663\n";
const CGROUP_MIXED = [
  "5:freezer:/",
  "4:cpuset:/top-app",
  "1:blkio:/top",
  "0::/apps/uid_10364/pid_4663",
  "",
].join("\n");

describe("parseAppCgroup", () => {
  test("reads uid and app pid from the cgroup v2 line", () => {
    expect(parseAppCgroup(CGROUP_MIXED)).toEqual({ uid: 10364, pid: 4663, path: "/apps/uid_10364/pid_4663" });
    expect(parseAppCgroup(CGROUP_V2_ONLY)?.pid).toBe(4663);
  });

  test("accepts the older layout without the /apps prefix", () => {
    expect(parseAppCgroup("0::/uid_10364/pid_77\n")).toEqual({ uid: 10364, pid: 77, path: "/uid_10364/pid_77" });
  });

  test("returns null when the process is not in a per-app cgroup", () => {
    expect(parseAppCgroup("0::/\n")).toBeNull();
    expect(parseAppCgroup("0::/user.slice/session-1.scope\n")).toBeNull();
    expect(parseAppCgroup("")).toBeNull();
  });
});

describe("inspectTreeCgroup", () => {
  /** Fake /proc: path → contents (null = unreadable / absent). */
  const procFs = (files: Record<string, string>) => (path: string): string | null =>
    path in files ? files[path] : null;

  test("attached: the tmux server's cgroup belongs to the running com.termux", () => {
    const info = inspectTreeCgroup({
      readFile: procFs({
        "/proc/5452/cgroup": CGROUP_MIXED,
        "/proc/4663/cmdline": "com.termux\0",
      }),
      tmuxServerPid: () => 5452,
      selfPid: 9000,
    });
    expect(info.state).toBe("attached");
    expect(info.role).toBe("tmux-server");
    expect(info.pid).toBe(5452);
    expect(info.cgroup?.pid).toBe(4663);
  });

  test("orphaned: the app pid that named the cgroup is gone", () => {
    const info = inspectTreeCgroup({
      readFile: procFs({ "/proc/5452/cgroup": CGROUP_MIXED }),
      tmuxServerPid: () => 5452,
      selfPid: 9000,
    });
    expect(info.state).toBe("orphaned");
  });

  test("orphaned: the pid was reused by a process that is not com.termux", () => {
    const info = inspectTreeCgroup({
      readFile: procFs({
        "/proc/5452/cgroup": CGROUP_MIXED,
        "/proc/4663/cmdline": "/system/bin/sh\0-c\0true\0",
      }),
      tmuxServerPid: () => 5452,
      selfPid: 9000,
    });
    expect(info.state).toBe("orphaned");
  });

  test("with no tmux server, inspects the daemon itself (it forks the server)", () => {
    const info = inspectTreeCgroup({
      readFile: procFs({
        "/proc/9000/cgroup": "0::/apps/uid_10364/pid_123\n",
        "/proc/123/cmdline": "com.termux\0",
      }),
      tmuxServerPid: () => null,
      selfPid: 9000,
    });
    expect(info.role).toBe("daemon");
    expect(info.pid).toBe(9000);
    expect(info.state).toBe("attached");
  });

  test("unknown: cgroup unreadable or not a per-app cgroup", () => {
    const unreadable = inspectTreeCgroup({ readFile: procFs({}), tmuxServerPid: () => 5452, selfPid: 1 });
    expect(unreadable.state).toBe("unknown");
    const desktop = inspectTreeCgroup({
      readFile: procFs({ "/proc/5452/cgroup": "0::/user.slice\n" }),
      tmuxServerPid: () => 5452,
      selfPid: 1,
    });
    expect(desktop.state).toBe("unknown");
  });
});

/**
 * Scripted device for softRestartFramework. system_server keeps `oldPid`
 * until the hang has run for `restartAfterMs` of fake time, then reports
 * `newPid`; the framework answers `cmd activity` / `pm path` only after
 * `readyAfterMs` more.
 */
function fakeDevice(opts: {
  oldPid?: string;
  newPid?: string;
  restartAfterMs?: number | null;
  readyAfterMs?: number;
  priorSetting?: string;
  networkAfterMs?: number | null;
}) {
  const oldPid = opts.oldPid ?? "2914";
  const newPid = opts.newPid ?? "24227";
  let now = 0;
  let hangStartedAt: number | null = null;
  let hangKilled = false;
  let setting = opts.priorSetting ?? "null";
  const shellCalls: string[][] = [];
  const settingWrites: string[] = [];

  const restartedAt = (): number | null =>
    hangStartedAt === null || opts.restartAfterMs === null
      ? null
      : hangStartedAt + (opts.restartAfterMs ?? 30_000);

  const shell = (args: string[]): ShellResult => {
    shellCalls.push(args);
    const ok = (stdout: string): ShellResult => ({ status: 0, stdout, stderr: "" });
    const cmd = args.join(" ");
    if (cmd === "pidof system_server") {
      const r = restartedAt();
      return ok(r !== null && now >= r ? `${newPid}\n` : `${oldPid}\n`);
    }
    if (cmd === `settings get global ${WATCHDOG_TIMEOUT_SETTING}`) return ok(`${setting}\n`);
    if (cmd.startsWith(`settings put global ${WATCHDOG_TIMEOUT_SETTING} `)) {
      setting = args[args.length - 1];
      settingWrites.push(cmd);
      return ok("");
    }
    if (cmd === `settings delete global ${WATCHDOG_TIMEOUT_SETTING}`) {
      setting = "null";
      settingWrites.push(cmd);
      return ok("Deleted 1 rows\n");
    }
    if (cmd === "cmd activity get-current-user" || cmd === "pm path android") {
      const r = restartedAt();
      const ready = r !== null && now >= r + (opts.readyAfterMs ?? 5_000);
      if (!ready) return { status: 1, stdout: "", stderr: "Can't find service" };
      return ok(cmd.startsWith("pm") ? "package:/system/framework/framework-res.apk\n" : "0\n");
    }
    return { status: 127, stdout: "", stderr: `unscripted: ${cmd}` };
  };

  const logs: string[] = [];
  const deps: SoftRestartDeps = {
    shell,
    startHang: () => {
      hangStartedAt = now;
      return { kill: () => { hangKilled = true; } };
    },
    sleep: async (ms) => { now += ms; },
    now: () => now,
    networkUp: async () => opts.networkAfterMs !== null && now >= (opts.networkAfterMs ?? 0),
    log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) },
  };
  return {
    deps,
    shellCalls,
    settingWrites,
    logs,
    get setting() { return setting; },
    get hangKilled() { return hangKilled; },
    get hangStartedAt() { return hangStartedAt; },
  };
}

describe("softRestartFramework", () => {
  test("the command is am hang --allow-restart", () => {
    expect(SOFT_RESTART_ARGS).toEqual(["am", "hang", "--allow-restart"]);
  });

  test("restarts, waits for the framework, restores an unset watchdog setting", async () => {
    const dev = fakeDevice({ restartAfterMs: 25_000, readyAfterMs: 8_000 });
    const r = await softRestartFramework(dev.deps);
    expect(r.ok).toBe(true);
    expect(r.oldPid).toBe(2914);
    expect(r.newPid).toBe(24227);
    expect(r.networkUp).toBe(true);
    // Lowered before the hang, deleted again afterwards (it was unset).
    expect(dev.settingWrites).toEqual([
      `settings put global ${WATCHDOG_TIMEOUT_SETTING} ${FAST_WATCHDOG_TIMEOUT_MS}`,
      `settings delete global ${WATCHDOG_TIMEOUT_SETTING}`,
    ]);
    expect(dev.setting).toBe("null");
    expect(dev.hangKilled).toBe(true);
  });

  test("the watchdog setting is lowered BEFORE the hang starts", async () => {
    const dev = fakeDevice({});
    let settingAtHang = "";
    const startHang = dev.deps.startHang;
    dev.deps.startHang = () => { settingAtHang = dev.setting; return startHang(); };
    await softRestartFramework(dev.deps);
    expect(settingAtHang).toBe(String(FAST_WATCHDOG_TIMEOUT_MS));
  });

  test("restores a prior explicit watchdog value instead of deleting it", async () => {
    const dev = fakeDevice({ priorSetting: "45000" });
    await softRestartFramework(dev.deps);
    expect(dev.settingWrites.at(-1)).toBe(`settings put global ${WATCHDOG_TIMEOUT_SETTING} 45000`);
    expect(dev.setting).toBe("45000");
  });

  test("fastWatchdog: false leaves the setting alone", async () => {
    const dev = fakeDevice({ restartAfterMs: 70_000 });
    const r = await softRestartFramework(dev.deps, { fastWatchdog: false });
    expect(r.ok).toBe(true);
    expect(dev.settingWrites).toEqual([]);
  });

  test("fails without hanging when system_server's pid is unreadable", async () => {
    const dev = fakeDevice({});
    const shell = dev.deps.shell;
    dev.deps.shell = (args, t) => (args.join(" ") === "pidof system_server" ? { status: 1, stdout: "", stderr: "" } : shell(args, t));
    const r = await softRestartFramework(dev.deps);
    expect(r.ok).toBe(false);
    expect(dev.hangStartedAt).toBeNull();
    expect(dev.settingWrites).toEqual([]);
  });

  test("reports failure when system_server never restarts, and still tries to restore", async () => {
    const dev = fakeDevice({ restartAfterMs: null });
    const r = await softRestartFramework(dev.deps, { restartTimeoutMs: 60_000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/did not restart/);
    expect(r.newPid).toBeNull();
    expect(dev.settingWrites.at(-1)).toBe(`settings delete global ${WATCHDOG_TIMEOUT_SETTING}`);
    expect(dev.hangKilled).toBe(true);
  });

  test("ok but networkUp=false when the network does not come back in time", async () => {
    const dev = fakeDevice({ networkAfterMs: null });
    const r = await softRestartFramework(dev.deps, { networkTimeoutMs: 10_000 });
    expect(r.ok).toBe(true);
    expect(r.networkUp).toBe(false);
    expect(dev.logs.some((l) => l.startsWith("warn") && /network/i.test(l))).toBe(true);
  });

  test("does not restore the setting before the framework answers again", async () => {
    // The settings provider lives in system_server; a write during the
    // restart is lost. The restore must come after the readiness probes pass.
    const dev = fakeDevice({ restartAfterMs: 20_000, readyAfterMs: 12_000 });
    await softRestartFramework(dev.deps);
    const calls = dev.shellCalls.map((a) => a.join(" "));
    const restoreAt = calls.lastIndexOf(`settings delete global ${WATCHDOG_TIMEOUT_SETTING}`);
    const lastReadyProbe = calls.lastIndexOf("pm path android");
    expect(restoreAt).toBeGreaterThan(lastReadyProbe);
  });
});

// ── AndroidEngine.ensureOrphanedTree: when operad stream does it ────────────

import { AndroidEngine } from "../android-engine.js";
import type { AndroidEngineDeps, SyncRunResult } from "../android-engine.js";
import type { Platform } from "../platform/platform.js";
import type { TreeCgroupInfo, SoftRestartResult } from "../soft-restart.js";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BOOT = "11111111-2222-3333-4444-555555555555";
const ATTACHED: TreeCgroupInfo = {
  state: "attached", pid: 5452, role: "tmux-server",
  cgroup: { uid: 10364, pid: 4663, path: "/apps/uid_10364/pid_4663" }, detail: "attached",
};
const ORPHANED: TreeCgroupInfo = { ...ATTACHED, state: "orphaned", detail: "orphaned" };
const RESTARTED: SoftRestartResult = { ok: true, reason: "restarted", oldPid: 2914, newPid: 24227, elapsedMs: 40_000, networkUp: true };

function engineHarness(opts: {
  softRestart?: boolean;
  platformId?: string;
  trees?: TreeCgroupInfo[];
  result?: SoftRestartResult;
  serial?: string | null;
  statePath?: string;
  now?: number;
}) {
  const adbCalls: string[][] = [];
  const restarts: string[] = [];
  const warnings: string[] = [];
  const trees = [...(opts.trees ?? [ATTACHED, ORPHANED])];
  const serial = opts.serial === undefined ? "127.0.0.1:5555" : opts.serial;
  const run = (_cmd: string, args: string[]): SyncRunResult => {
    adbCalls.push(args);
    if (args[0] === "devices") {
      return { status: 0, stdout: `List of devices attached\n${serial ? `${serial}\tdevice\n` : ""}`, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const ctx: any = {
    config: { adb: { soft_restart: opts.softRestart ?? true, connect_script: "", connect_timeout_s: 5, retry_interval_s: 3600, phantom_fix: false } },
    log: { info() {}, warn(m: string) { warnings.push(m); }, error() {}, debug() {} },
    state: { setAdbFixed() {}, getState: () => ({}) },
  };
  const statePath = opts.statePath ?? join(mkdtempSync(join(tmpdir(), "operad-sr-")), "soft-restart.json");
  const deps: AndroidEngineDeps = {
    run,
    platform: { id: opts.platformId ?? "android", resolveLocalIp: () => null, notify() {} } as unknown as Platform,
    readLocalBootId: () => BOOT,
    adbBin: "/fake/adb",
    connect: async () => ({ status: 0, stderr: "" }),
    inspectTree: () => trees.shift() ?? ORPHANED,
    softRestart: async (s: string) => { restarts.push(s); return opts.result ?? RESTARTED; },
    softRestartStatePath: statePath,
    now: () => opts.now ?? 1_000_000_000,
  };
  return { engine: new AndroidEngine(ctx, deps), adbCalls, restarts, warnings, statePath };
}

describe("AndroidEngine.ensureOrphanedTree", () => {
  test("attached tree + soft_restart on: restarts once on the local serial and relaunches Termux", async () => {
    const h = engineHarness({});
    const r = await h.engine.ensureOrphanedTree();
    expect(r?.ok).toBe(true);
    expect(h.restarts).toEqual(["127.0.0.1:5555"]);
    const starts = h.adbCalls.filter((a) => a.includes("am") && a.includes("start"));
    expect(starts.length).toBe(1);
    expect(starts[0]).toEqual(["-s", "127.0.0.1:5555", "shell", "am", "start", "-n", "com.termux/.app.TermuxActivity"]);
    const saved = JSON.parse(readFileSync(h.statePath, "utf8"));
    expect(saved.boot_id).toBe(BOOT);
    expect(saved.ok).toBe(true);
  });

  test("already orphaned: does nothing", async () => {
    const h = engineHarness({ trees: [ORPHANED] });
    expect(await h.engine.ensureOrphanedTree()).toBeNull();
    expect(h.restarts).toEqual([]);
  });

  test("soft_restart off (the default): does nothing even when attached", async () => {
    const h = engineHarness({ softRestart: false });
    expect(await h.engine.ensureOrphanedTree()).toBeNull();
    expect(h.restarts).toEqual([]);
  });

  test("not Android: does nothing", async () => {
    const h = engineHarness({ platformId: "linux" });
    expect(await h.engine.ensureOrphanedTree()).toBeNull();
    expect(h.restarts).toEqual([]);
  });

  test("no adb device verified as this phone: skips with a warning", async () => {
    const h = engineHarness({ serial: null });
    expect(await h.engine.ensureOrphanedTree()).toBeNull();
    expect(h.restarts).toEqual([]);
    expect(h.warnings.some((w) => /adb/i.test(w))).toBe(true);
  });

  test("cooldown: a second attempt in the same boot within 30 min is skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "operad-sr-"));
    const statePath = join(dir, "soft-restart.json");
    writeFileSync(statePath, JSON.stringify({ at: 1_000_000_000 - 60_000, boot_id: BOOT, ok: false, reason: "x" }));
    const h = engineHarness({ statePath, result: RESTARTED });
    expect(await h.engine.ensureOrphanedTree()).toBeNull();
    expect(h.restarts).toEqual([]);
    expect(h.warnings.some((w) => /cooldown|recent/i.test(w))).toBe(true);
  });

  test("cooldown does not carry across a reboot (different boot_id)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "operad-sr-"));
    const statePath = join(dir, "soft-restart.json");
    writeFileSync(statePath, JSON.stringify({ at: 1_000_000_000 - 60_000, boot_id: "other-boot", ok: true, reason: "x" }));
    const h = engineHarness({ statePath });
    expect((await h.engine.ensureOrphanedTree())?.ok).toBe(true);
    expect(h.restarts.length).toBe(1);
  });

  test("failed restart: no Termux relaunch, attempt recorded, warning logged", async () => {
    const h = engineHarness({ result: { ...RESTARTED, ok: false, reason: "system_server did not restart within 180s", newPid: null } });
    const r = await h.engine.ensureOrphanedTree();
    expect(r?.ok).toBe(false);
    expect(h.adbCalls.some((a) => a.includes("start"))).toBe(false);
    expect(existsSync(h.statePath)).toBe(true);
    expect(JSON.parse(readFileSync(h.statePath, "utf8")).ok).toBe(false);
    expect(h.warnings.some((w) => /did not restart/.test(w))).toBe(true);
  });

  test("restart reported ok but the tree is still attached: warns", async () => {
    const h = engineHarness({ trees: [ATTACHED, ATTACHED] });
    await h.engine.ensureOrphanedTree();
    expect(h.warnings.some((w) => /still/i.test(w))).toBe(true);
  });
});
