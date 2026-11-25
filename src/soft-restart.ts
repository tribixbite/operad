/**
 * soft-restart.ts — move the tmux tree out of reach of com.termux kills by
 * soft-restarting the Android framework.
 *
 * Why (measured, see docs/persistence.md): an lmkd kill of com.termux makes
 * ActivityManager kill every process in the app's cgroup
 * `/apps/uid_<uid>/pid_<app pid>`, which includes the tmux server and every
 * agent in it. A framework soft restart (system_server dies, zygote restarts,
 * the kernel keeps running) kills the app process WITHOUT that sweep. The
 * tree keeps running in a cgroup that no live app owns, and later kills of
 * the relaunched app only sweep the new app's cgroup. It lasts until a full
 * reboot (or a force-stop, which kills by uid).
 *
 * How: `am hang --allow-restart` blocks the ActivityManager until
 * system_server's Watchdog kills it. The watchdog timeout comes from
 * Settings.Global `system_server_watchdog_timeout_ms` (default 60 s); user
 * builds clamp it to just above ZygoteConnectionConstants.WRAPPED_PID_TIMEOUT
 * (20 s), so lowering it to 20001 ms before the hang roughly halves the
 * time the phone is frozen. The setting is restored afterwards.
 *
 * Cost: every app on the device restarts, the phone is unresponsive for
 * roughly 30–90 s, and Wi-Fi drops briefly. adb over loopback keeps working
 * because adbd is not part of the framework.
 */

/** Settings.Global key the Watchdog observes for its timeout. */
export const WATCHDOG_TIMEOUT_SETTING = "system_server_watchdog_timeout_ms";

/**
 * Lowest value a user build accepts: Watchdog.updateWatchdogTimeout() raises
 * anything <= WRAPPED_PID_TIMEOUT_MILLIS (20000) to 20001.
 */
export const FAST_WATCHDOG_TIMEOUT_MS = 20_001;

/** The adb shell argv that triggers the soft restart. */
export const SOFT_RESTART_ARGS: readonly string[] = ["am", "hang", "--allow-restart"];

/** The per-app cgroup a process is in. */
export interface AppCgroup {
  uid: number;
  /** Pid of the app process the cgroup was created for. */
  pid: number;
  /** The cgroup v2 path, e.g. `/apps/uid_10364/pid_4663`. */
  path: string;
}

/**
 * Parse `/proc/<pid>/cgroup` and return the per-app cgroup from its v2
 * (`0::`) line, or null when the process is not in one (desktop Linux, or a
 * process started outside any app).
 */
export function parseAppCgroup(text: string): AppCgroup | null {
  for (const line of text.split("\n")) {
    if (!line.startsWith("0::")) continue;
    const path = line.slice(3).trim();
    const m = /(?:^|\/)uid_(\d+)\/pid_(\d+)$/.exec(path);
    if (m) return { uid: Number(m[1]), pid: Number(m[2]), path };
  }
  return null;
}

/**
 * - `attached`: the cgroup belongs to the running app — an lmkd kill of it
 *   takes the tree.
 * - `orphaned`: the app process that named the cgroup is gone — the tree is
 *   out of reach of app kills.
 * - `unknown`: not a per-app cgroup, or unreadable.
 */
export type TreeCgroupState = "attached" | "orphaned" | "unknown";

export interface TreeCgroupInfo {
  state: TreeCgroupState;
  /** The process inspected. */
  pid: number;
  /**
   * Which process that is. The tmux server when one is running (every
   * session is forked from it, so its cgroup is theirs); otherwise the daemon,
   * whose cgroup a tmux server it starts will inherit.
   */
  role: "tmux-server" | "daemon";
  cgroup: AppCgroup | null;
  /** One-line human explanation. */
  detail: string;
}

export interface InspectDeps {
  /** Read a /proc file; null if it is absent or unreadable. */
  readFile: (path: string) => string | null;
  /** Pid of the tmux server operad uses, or null if none is running. */
  tmuxServerPid: () => number | null;
  /** The daemon's own pid. */
  selfPid: number;
  /** App package whose cgroup counts as attached (default com.termux). */
  appPackage?: string;
}

/** Decide whether the tree operad's sessions live in is attached to the app. */
export function inspectTreeCgroup(deps: InspectDeps): TreeCgroupInfo {
  const appPackage = deps.appPackage ?? "com.termux";
  const serverPid = deps.tmuxServerPid();
  const role: TreeCgroupInfo["role"] = serverPid !== null ? "tmux-server" : "daemon";
  const pid = serverPid ?? deps.selfPid;
  const who = role === "tmux-server" ? `tmux server (pid ${pid})` : `daemon (pid ${pid})`;

  const text = deps.readFile(`/proc/${pid}/cgroup`);
  if (text === null) {
    return { state: "unknown", pid, role, cgroup: null, detail: `${who}: /proc/${pid}/cgroup unreadable` };
  }
  const cgroup = parseAppCgroup(text);
  if (!cgroup) {
    return { state: "unknown", pid, role, cgroup: null, detail: `${who} is not in a per-app cgroup` };
  }

  // The cgroup is named after the app pid it was made for. If that pid now
  // runs something else (or nothing), the app it belonged to is gone.
  const cmdline = deps.readFile(`/proc/${cgroup.pid}/cmdline`);
  const argv0 = cmdline?.split("\0")[0] ?? "";
  if (argv0 === appPackage) {
    return {
      state: "attached",
      pid, role, cgroup,
      detail: `${who} is in ${cgroup.path}, the cgroup of the running ${appPackage} — a low-memory kill of the app takes every session`,
    };
  }
  return {
    state: "orphaned",
    pid, role, cgroup,
    detail: `${who} is in ${cgroup.path}; app pid ${cgroup.pid} is gone, so app kills do not reach it`,
  };
}

/** Result of one adb shell command. */
export interface ShellResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface SoftRestartDeps {
  /** Run `adb -s <serial> shell <args…>` synchronously. */
  shell: (args: string[], timeoutMs: number) => ShellResult;
  /**
   * Start `adb -s <serial> shell am hang --allow-restart` WITHOUT waiting:
   * it only returns when system_server dies.
   */
  startHang: () => { kill: () => void };
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Whether the device has a working network route (no DNS involved). */
  networkUp: () => Promise<boolean>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface SoftRestartOptions {
  /** Lower the watchdog timeout first to shorten the freeze (default true). */
  fastWatchdog?: boolean;
  /** Max wait for system_server to come back with a new pid (default 180 s). */
  restartTimeoutMs?: number;
  /** Max wait for ActivityManager + PackageManager to answer (default 120 s). */
  readyTimeoutMs?: number;
  /** Max wait for the network afterwards (default 60 s). */
  networkTimeoutMs?: number;
  /** Poll interval (default 1 s). */
  pollMs?: number;
}

export interface SoftRestartResult {
  ok: boolean;
  reason: string;
  oldPid: number | null;
  newPid: number | null;
  /** Hang start to framework ready, in ms (0 if the hang never started). */
  elapsedMs: number;
  networkUp: boolean;
}

/** First pid in `pidof` output, or null. */
function parsePid(out: string): number | null {
  const n = Number(out.trim().split(/\s+/)[0]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Soft-restart the framework and wait until it is usable again.
 *
 * Sequence: read system_server's pid → (optionally) lower the watchdog
 * timeout → start the hang → wait for a NEW system_server pid → wait for
 * ActivityManager and PackageManager to answer → restore the watchdog
 * setting (only now: the settings provider lives in system_server) → wait
 * for the network.
 */
export async function softRestartFramework(
  deps: SoftRestartDeps,
  opts: SoftRestartOptions = {},
): Promise<SoftRestartResult> {
  const fastWatchdog = opts.fastWatchdog ?? true;
  const restartTimeoutMs = opts.restartTimeoutMs ?? 180_000;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
  const networkTimeoutMs = opts.networkTimeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 1_000;

  const pidofServer = (): number | null => {
    const r = deps.shell(["pidof", "system_server"], 5_000);
    return r.status === 0 ? parsePid(r.stdout) : null;
  };

  const oldPid = pidofServer();
  if (oldPid === null) {
    return { ok: false, reason: "system_server pid unreadable over adb", oldPid: null, newPid: null, elapsedMs: 0, networkUp: false };
  }

  // Remember the current watchdog value so it can be put back exactly.
  // `settings get` prints "null" for an unset key.
  let prior: string | null = null;
  let lowered = false;
  if (fastWatchdog) {
    const got = deps.shell(["settings", "get", "global", WATCHDOG_TIMEOUT_SETTING], 5_000);
    const value = got.stdout.trim();
    prior = got.status === 0 && value !== "" && value !== "null" ? value : null;
    const put = deps.shell(["settings", "put", "global", WATCHDOG_TIMEOUT_SETTING, String(FAST_WATCHDOG_TIMEOUT_MS)], 5_000);
    lowered = put.status === 0;
    if (!lowered) deps.log.warn(`Could not lower the watchdog timeout (${put.stderr.trim() || `exit ${put.status}`}); using the default`);
  }

  const restore = (): void => {
    if (!lowered) return;
    const r = prior === null
      ? deps.shell(["settings", "delete", "global", WATCHDOG_TIMEOUT_SETTING], 5_000)
      : deps.shell(["settings", "put", "global", WATCHDOG_TIMEOUT_SETTING, prior], 5_000);
    if (r.status !== 0) {
      deps.log.warn(`Could not restore ${WATCHDOG_TIMEOUT_SETTING} (${r.stderr.trim() || `exit ${r.status}`}); ` +
        `run: adb shell settings ${prior === null ? "delete" : "put"} global ${WATCHDOG_TIMEOUT_SETTING}${prior === null ? "" : ` ${prior}`}`);
    }
  };

  deps.log.info(`Soft-restarting the framework (system_server pid ${oldPid}) to orphan the session cgroup`);
  const started = deps.now();
  const hang = deps.startHang();

  // 1. Wait for system_server to come back under a new pid.
  let newPid: number | null = null;
  while (deps.now() - started < restartTimeoutMs) {
    await deps.sleep(pollMs);
    const pid = pidofServer();
    if (pid !== null && pid !== oldPid) { newPid = pid; break; }
  }
  hang.kill();
  if (newPid === null) {
    restore();
    return {
      ok: false,
      reason: `system_server did not restart within ${Math.round(restartTimeoutMs / 1000)}s`,
      oldPid, newPid: null, elapsedMs: deps.now() - started, networkUp: false,
    };
  }

  // 2. Wait for the framework services to answer.
  const readyStart = deps.now();
  let ready = false;
  while (deps.now() - readyStart < readyTimeoutMs) {
    const am = deps.shell(["cmd", "activity", "get-current-user"], 5_000);
    const pm = am.status === 0 ? deps.shell(["pm", "path", "android"], 5_000) : null;
    if (pm && pm.status === 0 && pm.stdout.includes("package:")) { ready = true; break; }
    await deps.sleep(pollMs);
  }
  const elapsedMs = deps.now() - started;
  restore();
  if (!ready) {
    return {
      ok: false,
      reason: `framework restarted (pid ${newPid}) but did not answer within ${Math.round(readyTimeoutMs / 1000)}s`,
      oldPid, newPid, elapsedMs, networkUp: false,
    };
  }
  deps.log.info(`Framework back after ${Math.round(elapsedMs / 1000)}s (system_server pid ${oldPid} → ${newPid})`);

  // 3. Wi-Fi reconnects after the restart; agents need it.
  const netStart = deps.now();
  let networkUp = false;
  while (deps.now() - netStart < networkTimeoutMs) {
    if (await deps.networkUp()) { networkUp = true; break; }
    await deps.sleep(pollMs);
  }
  if (!networkUp) {
    deps.log.warn(`Network not back ${Math.round(networkTimeoutMs / 1000)}s after the soft restart; starting agents anyway`);
  }

  return { ok: true, reason: "restarted", oldPid, newPid, elapsedMs, networkUp };
}
