/**
 * session.ts — Tmux session lifecycle management
 *
 * Handles creating, starting, stopping, and querying tmux sessions.
 * For Claude-type sessions, polls tmux capture-pane to detect readiness
 * instead of hardcoded sleep delays.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { SessionConfig, SessionType } from "./types.js";
import type { Logger } from "./log.js";
import { parseElapsed, pickBareServicePid } from "./bare-service.js";
import type { PsRow } from "./bare-service.js";
import { detectPlatform } from "./platform/platform.js";
import { getRuntime } from "./runtimes/index.js";
import type { SessionRuntime } from "./runtimes/index.js";
import {
  buildRecorderArgv,
  buildRecorderCommand,
  exitRecordKey,
  interpretRecordedStatus,
  pruneStaleExitRecords,
  readExitRecord,
  type ExitRecord,
} from "./exit-record.js";

/** Lazy-resolved tmux binary path via platform abstraction.
 *  Module-load-time resolution would freeze a wrong path on systems where
 *  tmux is installed under a non-standard location (MSYS2 on Windows,
 *  late-PATH packages on Termux). Cached after first call. */
let _tmuxBin: string | null = null;
function TMUX_BIN(): string {
  if (_tmuxBin === null) {
    _tmuxBin = detectPlatform().resolveBinaryPath("tmux");
  }
  return _tmuxBin;
}

/**
 * Server-selection arguments prepended to every tmux invocation.
 *
 * Empty by default, so operad talks to the user's normal tmux server. When
 * `OPERAD_TMUX_SOCKET` names a socket, every call gets `-L <name>` — a
 * separate server — which lets a second operad instance, or the test suite,
 * run without touching the sessions on the real one. Read on every call
 * (not cached) so a test can set it before its first tmux call.
 */
export function tmuxServerArgs(): string[] {
  const socket = process.env.OPERAD_TMUX_SOCKET;
  return socket ? ["-L", socket] : [];
}

/** spawnSync tmux on the selected server. The single path every call goes through. */
function spawnTmux(
  args: string[],
  opts: { timeout: number; capture: boolean },
): ReturnType<typeof spawnSync> {
  return spawnSync(TMUX_BIN(), [...tmuxServerArgs(), ...args], {
    encoding: "utf-8",
    timeout: opts.timeout,
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "ignore",
    env: getCleanEnv(),
  });
}

/**
 * Where agent panes record how their shell ended (see exit-record.ts), or
 * null to start agent shells without a recorder. The daemon sets this at
 * startup from its state directory; library callers and tests that never set
 * it get plain shells and the tmux-field reading of dead panes.
 */
let exitRecordDir: string | null = null;

/** Configure (or, with null, disable) the exit-record directory. */
export function setExitRecordDir(dir: string | null): void {
  exitRecordDir = dir;
}

/**
 * The exit-record directory, created if needed, or null when recording is
 * off or the directory can't be made. The recorder only writes into a
 * directory that exists, so every path that installs it must call this:
 * without the directory a recorded pane is indistinguishable from one that
 * never had a recorder.
 */
function usableExitRecordDir(): string | null {
  if (exitRecordDir === null) return null;
  try {
    mkdirSync(exitRecordDir, { recursive: true });
    return exitRecordDir;
  } catch {
    return null;
  }
}

/** Default readiness polling timeout if a runtime adapter doesn't override (ms). */
const DEFAULT_READY_TIMEOUT = 60_000;
/** Default interval between readiness polls if a runtime adapter doesn't override (ms). */
const DEFAULT_POLL_INTERVAL = 500;
/** Delay before sending "go" after readiness detection (ms). */
const GO_SEND_DELAY = 500;

/** Cached clean env — recomputed once per process via platform abstraction */
let _cleanEnv: NodeJS.ProcessEnv | null = null;
function getCleanEnv(): NodeJS.ProcessEnv {
  if (!_cleanEnv) _cleanEnv = detectPlatform().cleanEnv();
  return _cleanEnv;
}

/**
 * Run a tmux command and return stdout, or null on failure.
 * Uses spawnSync with proper argument array to handle spaces in args.
 * Passes clean env to prevent Claude nesting detection.
 */
function tmux(...args: string[]): string | null {
  try {
    const result = spawnTmux(args, { timeout: 10_000, capture: true });
    if (result.status !== 0) return null;
    return String(result.stdout ?? "").trim();
  } catch {
    return null;
  }
}

// -- Bare (non-tmux) Claude session discovery ---------------------------------

/** A Claude Code process running outside tmux, matched to a config session */
export interface BareClaudeSession {
  pid: number;
  cwd: string;
  sessionName: string;
}

/**
 * Scan the process table for Claude Code instances running in plain Termux tabs
 * (not inside tmux). Matches each process's cwd against configured session paths.
 * Returns one entry per session — if multiple Claude PIDs share a cwd, the oldest
 * (lowest PID) wins.
 */
export function discoverBareClaudeSessions(
  configSessions: SessionConfig[],
): BareClaudeSession[] {
  // Build a lookup of resolved absolute path → session name
  const pathToName = new Map<string, string>();
  for (const s of configSessions) {
    if (s.path) {
      try {
        pathToName.set(resolve(s.path), s.name);
      } catch { /* skip unresolvable */ }
    }
  }
  if (pathToName.size === 0) return [];

  // Get all claude processes
  let psOutput: string;
  try {
    const result = spawnSync("ps", ["-eo", "pid,args"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || !result.stdout) return [];
    psOutput = result.stdout;
  } catch {
    return [];
  }

  // Parse PIDs of processes whose command is exactly "claude"
  const claudePids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    // Match lines like "12345 claude" (PID followed by bare "claude" command)
    const match = trimmed.match(/^(\d+)\s+claude$/);
    if (match) claudePids.push(parseInt(match[1], 10));
  }

  // For each claude PID: resolve cwd, check if it's in tmux, match to config
  const results: BareClaudeSession[] = [];
  // Track best (lowest PID) per session name
  const bestBySession = new Map<string, BareClaudeSession>();

  for (const pid of claudePids) {
    // Resolve working directory via platform abstraction
    const cwd = detectPlatform().readProcessCwd(pid);
    if (!cwd) continue; // Process may have exited

    // Check if any ancestor is tmux (already managed)
    if (detectPlatform().hasAncestorComm(pid, "tmux")) continue;

    // Match cwd to a configured session
    const sessionName = pathToName.get(cwd);
    if (!sessionName) continue;

    const existing = bestBySession.get(sessionName);
    if (!existing || pid < existing.pid) {
      bestBySession.set(sessionName, { pid, cwd, sessionName });
    }
  }

  for (const entry of bestBySession.values()) {
    results.push(entry);
  }
  return results;
}

/**
 * Find the PID of a running bare service by matching its command string
 * in the process table. Used to adopt services like termux-x11 that run
 * as detached processes (app_process) and outlive their spawn shell.
 *
 * @param pattern - regex to match against process args (e.g., /termux.x11|com\.termux\.x11/)
 * @param exclude - PIDs to pass over (e.g. those adopted by other sessions)
 * @returns PID of the matching process, or null if not found
 */
export function findBareServicePid(pattern: RegExp, exclude?: (pid: number) => boolean): number | null {
  try {
    const result = spawnSync("ps", ["-eo", "pid,pgid,etime,args"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || !result.stdout) return null;
    const rows: PsRow[] = [];
    for (const line of result.stdout.split("\n")) {
      // pid, pgid and etime are single tokens; args is the rest of the line.
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue; // header and blank lines
      const pid = parseInt(m[1], 10);
      if (pid <= 1) continue;
      rows.push({ pid, pgid: parseInt(m[2], 10), elapsedS: parseElapsed(m[3]), args: m[4] });
    }
    // `exclude` skips processes another session already owns, so a second
    // match is still found rather than the first one being stolen.
    return pickBareServicePid(rows, pattern, exclude);
  } catch { /* ignore */ }
  return null;
}

/**
 * Pid of the tmux server operad talks to, or null when none is running.
 * Every session's processes are forked from this server, so its cgroup is
 * theirs (see soft-restart.ts).
 */
export function tmuxServerPid(): number | null {
  const out = tmux("list-sessions", "-F", "#{pid}");
  const n = Number((out ?? "").split("\n")[0]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Check if the tmux server is alive */
export function isTmuxServerAlive(): boolean {
  const result = spawnTmux(["start-server"], { timeout: 5000, capture: false });
  // Surface ENOENT so a missing tmux binary is visible rather than silently
  // returning false and being mistaken for a simple "server not running" case.
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    process.stderr.write(`[operad] isTmuxServerAlive: tmux binary not found at ${TMUX_BIN()} (ENOENT)\n`);
  }
  return result.status === 0;
}

/** List all existing tmux session names */
export function listTmuxSessions(): string[] {
  const output = tmux("list-sessions", "-F", "#{session_name}");
  if (!output) return [];
  return output
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Check if a specific tmux session exists.
 *
 * Uses tmux's `=name` exact-match target sigil so `has-session -t foo` does
 * NOT match a longer-named session like `foo-2`. Without the `=`, tmux falls
 * back to prefix-matching session names, which would silently report `foo`
 * exists whenever any `foo-*` session is alive. Names pass `isValidName`
 * ([a-z0-9-]+) so prefixing `=` is always safe.
 */
export function sessionExists(name: string): boolean {
  const result = spawnTmux(["has-session", "-t", formatTmuxTarget(name)], { timeout: 5000, capture: false });
  return result.status === 0;
}

/**
 * Why a session's panes are no longer running anything.
 *
 *  - `alive`      — at least one pane still has a live process.
 *  - `exited`     — every pane is dead and none was killed: the shell was
 *                   exited. That is a person typing `exit`, not a failure,
 *                   and must not be answered with a restart.
 *  - `killed`     — a pane's shell died on a signal (SIGKILL from Android's
 *                   lmkd is the case that matters here) or, on tmux builds
 *                   that report it, with a non-zero status. This is exactly
 *                   what auto-restart exists for.
 *  - `missing`    — no such tmux session.
 *  - `unknown`    — tmux could not be asked (server down, timeout).
 */
export type PaneLiveness =
  | { state: "alive" }
  | { state: "exited"; status: number }
  | { state: "killed"; status?: number; signal?: number }
  | { state: "missing" }
  | { state: "unknown" };

/**
 * Inspect a session's panes to tell a deliberate exit from a crash.
 *
 * Only meaningful for sessions with `remain-on-exit on` (see
 * `applyAgentSessionOptions`): without it tmux destroys the session the
 * instant its last pane's process exits, leaving "session is gone" as the
 * only signal, which a clean exit and an OOM-killed shell produce
 * identically. Panes started under the exit recorder are judged by their
 * record; others by tmux's own status fields.
 */
export function paneLiveness(name: string): PaneLiveness {
  const output = tmux(
    "list-panes", "-s", "-t", formatTmuxTarget(name),
    "-F", PANE_LIVENESS_FORMAT,
  );
  if (output === null) {
    // Distinguish "no such session" from "tmux unreachable" so the caller
    // doesn't treat a dead tmux server as every session having been closed.
    return sessionExists(name) ? { state: "unknown" } : { state: "missing" };
  }
  const dir = exitRecordDir;
  return classifyPaneLiveness(output, dir === null ? () => null : (key) => readExitRecord(dir, key));
}

/**
 * tmux format for `paneLiveness`: `dead|status|signal|server_pid|pane_id`.
 *
 * Pipe-separated, not space-separated: `pane_dead_status` and
 * `pane_dead_signal` are EMPTY on some builds (tmux 3.5a under Termux is
 * one), and with spaces an empty middle field collapses into its neighbours
 * — a pane killed by signal 9 arrives as "1  9" and reads as "exited with
 * status 9", which is both wrong and the opposite decision. The server pid
 * and pane id locate the pane's exit record.
 */
const PANE_LIVENESS_FORMAT = "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{pid}|#{pane_id}";

/** Verdict for one dead pane. */
type PaneVerdict = { state: "exited"; status: number } | { state: "killed"; status?: number; signal?: number };

/**
 * Judge a dead pane from tmux's own fields — the reading for panes with no
 * exit record. A reported signal, or a non-zero status, is a crash.
 * Everything else is an exit: the status fields come back empty on some
 * builds, so "exited" is the honest reading of "dead, and nothing says it
 * was killed" — not a claim that a status was seen and was zero.
 */
function verdictFromTmuxFields(statusRaw: string, signalRaw: string): PaneVerdict {
  const status = Number(statusRaw);
  const signal = Number(signalRaw);
  // `pane_dead_signal` is a name on some builds ("KILL") and a number on
  // others; either way a non-empty value means it was killed.
  if (signalRaw !== "") {
    return {
      state: "killed",
      ...(Number.isFinite(signal) && signal > 0 ? { signal } : {}),
      ...(statusRaw !== "" && Number.isFinite(status) ? { status } : {}),
    };
  }
  if (statusRaw !== "" && Number.isFinite(status) && status !== 0) {
    return { state: "killed", status };
  }
  return { state: "exited", status: statusRaw !== "" && Number.isFinite(status) ? status : 0 };
}

/**
 * Classify `list-panes -F PANE_LIVENESS_FORMAT` output. Split out from the
 * tmux call (with the record lookup injected) so the decision is testable.
 *
 * Any live pane means the session is alive. Otherwise each dead pane is
 * judged by its exit record when it has one — the shell's real status, or
 * `running` if the recorder died with it, which is a kill — and by tmux's
 * fields when it has none. Any killed pane makes the session killed.
 *
 * Rows with only the first three fields (no pid/pane id) are accepted and
 * read from tmux's fields alone.
 */
export function classifyPaneLiveness(
  output: string,
  readRecord: (key: string | null) => ExitRecord | null = () => null,
): PaneLiveness {
  const rows = output.split("\n").map((l) => l.replace(/\r/g, "").trim()).filter(Boolean);
  if (rows.length === 0) return { state: "missing" };

  const verdicts: PaneVerdict[] = [];
  for (const row of rows) {
    const [dead = "", statusRaw = "", signalRaw = "", serverPid = "", paneId = ""] = row.split("|");
    if (dead.trim() !== "1") return { state: "alive" };
    const record = readRecord(exitRecordKey(serverPid, paneId));
    if (record === "running") verdicts.push({ state: "killed" });
    else if (record !== null) verdicts.push(interpretRecordedStatus(record));
    else verdicts.push(verdictFromTmuxFields(statusRaw, signalRaw));
  }

  const killed = verdicts.find((v) => v.state === "killed");
  if (killed) return killed;
  // All exited: report the last non-zero status, if any, else 0.
  const status = verdicts.reduce((acc, v) => (v.state === "exited" && v.status !== 0 ? v.status : acc), 0);
  return { state: "exited", status };
}

/** Capture the current pane content for a session */
export function capturePane(sessionName: string, _lines = 5): string {
  // Note: tmux 3.5a doesn't support -l flag for capture-pane
  // tmux's `=name` exact-match prefix only resolves for target-session
  // subcommands (has-session, kill-session, etc). target-pane subcommands
  // (capture-pane, send-keys, list-panes) need a target-window form, so we
  // append `:` — that resolves to the session's current window, then to
  // its current pane. Without the colon, tmux treats `=name` as a literal
  // pane name and errors with "can't find pane".
  const output = tmux("capture-pane", "-t", formatTmuxTarget(sessionName, true), "-p");
  return output ?? "";
}

/** Send text to a tmux session */
export function sendKeys(sessionName: string, text: string, pressEnter = true): boolean {
  // Send text and Enter as separate calls — Claude Code's TUI can miss
  // Enter when combined in a single send-keys invocation with text.
  // See capturePane() for why `=name:` (trailing colon) is required.
  const textOk = tmux("send-keys", "-t", formatTmuxTarget(sessionName, true), text) !== null;
  if (!textOk) return false;
  if (pressEnter) {
    return tmux("send-keys", "-t", formatTmuxTarget(sessionName, true), "Enter") !== null;
  }
  return true;
}

/** Size at which a bare service's log is rotated to `.1` on its next start. */
export const BARE_LOG_MAX_BYTES = 1024 * 1024;

/**
 * Log file for a bare service's stdout/stderr. The session name is reduced
 * to a safe file-name alphabet so it can never point outside `logDir`.
 */
export function bareLogPath(logDir: string, name: string): string {
  return join(logDir, `bare-${name.replace(/[^A-Za-z0-9._-]/g, "_")}.log`);
}

/**
 * Spawn a bare (non-tmux) detached process for sessions that crash inside tmux PTY.
 * Returns the child PID, or null on failure.
 */
export function spawnBareProcess(config: SessionConfig, log: Logger, logDir?: string): number | null {
  const { name, command, env: sessionEnv } = config;
  if (!command) {
    log.error(`Bare session '${name}' has no command`, { session: name });
    return null;
  }

  // Merge session env with platform-clean env (handles LD_PRELOAD on Android)
  const cleanBase = detectPlatform().cleanEnv();
  const mergedEnv = { ...cleanBase, ...sessionEnv };
  const logFd = logDir ? openBareLog(logDir, name, command, log) : null;
  try {
    const child = spawn("sh", ["-c", command], {
      cwd: config.path ?? process.env.HOME,
      env: mergedEnv,
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
      detached: true,
    });
    child.unref();
    const pid = child.pid;
    if (pid) {
      log.info(`Spawned bare session '${name}' (PID ${pid})`, { session: name });
      return pid;
    }
    log.error(`Bare session '${name}' spawn returned no PID`, { session: name });
    return null;
  } catch (err) {
    log.error(`Failed to spawn bare session '${name}': ${err}`, { session: name });
    return null;
  } finally {
    // The child holds its own copy of the descriptor.
    if (logFd !== null) closeSync(logFd);
  }
}

/**
 * Open a bare service's log for appending, rotating it to `.1` first when it
 * has grown past BARE_LOG_MAX_BYTES, and write a header line for this start.
 * Returns null (output discarded, as before) if the log cannot be opened —
 * a log problem must never stop the service from starting.
 */
function openBareLog(logDir: string, name: string, command: string, log: Logger): number | null {
  const path = bareLogPath(logDir, name);
  try {
    mkdirSync(logDir, { recursive: true });
    if (existsSync(path) && statSync(path).size > BARE_LOG_MAX_BYTES) {
      renameSync(path, `${path}.1`);
    }
    const fd = openSync(path, "a");
    writeSync(fd, `=== ${new Date().toISOString()} start ${name}: ${command}\n`);
    return fd;
  } catch (err) {
    log.warn(`Cannot open log ${path} for bare session '${name}': ${err}`, { session: name });
    return null;
  }
}

/**
 * Inject LD_PRELOAD into the tmux global environment so new sessions
 * inherit termux-exec even when the tmux server was started without it.
 * Delegates to platform — only meaningful on Android/Termux.
 */
export function ensureTmuxLdPreload(log: Logger): void {
  detectPlatform().ensureTmuxLdPreload();
}

/**
 * The shell tmux would start in a new pane: the server's `default-shell`,
 * falling back to `$SHELL`, then `sh`. Asked of the server (starting it if
 * needed) because that, not operad's environment, is what tmux runs.
 */
function tmuxDefaultShell(): string {
  const shell = tmux("start-server", ";", "show-options", "-gv", "default-shell");
  return shell || process.env.SHELL || "sh";
}

/**
 * Create a detached tmux session.
 *
 * With `recordExit`, and an exit-record directory configured, the session's
 * first pane runs its login shell under the exit recorder (exit-record.ts),
 * so how that shell ends can be told apart later; stale records from
 * previous tmux servers are pruned on the way. Otherwise the pane runs
 * tmux's default shell, as before.
 */
export function openTmuxSession(name: string, path: string | undefined, recordExit: boolean): boolean {
  const createArgs = ["new-session", "-d", "-s", name];
  if (path) createArgs.push("-c", path);

  // An unusable record dir costs exit detection for this session, not the
  // session itself.
  const dir = recordExit ? usableExitRecordDir() : null;
  if (dir !== null) {
    // `--` then argv: tmux execs it directly, no extra shell in between.
    createArgs.push("--", ...buildRecorderArgv(dir, tmuxDefaultShell()));
  }

  const result = spawnTmux(createArgs, { timeout: 10_000, capture: false });
  if (result.status !== 0) return false;

  if (dir !== null) {
    const serverPid = tmux("display-message", "-p", "-t", formatTmuxTarget(name, true), "#{pid}");
    if (serverPid) pruneStaleExitRecords(dir, serverPid);
  }
  return true;
}

/**
 * Make an agent session keep its dead panes, so an exit can be inspected
 * instead of the session vanishing (see `paneLiveness`).
 *
 * Idempotent, and applied to sessions operad adopts as well as ones it
 * creates — a session started before this existed gets it from now on.
 *
 *  - `remain-on-exit` is a WINDOW option. It is set on the current window,
 *    and an `after-new-window` hook sets it on windows opened later; without
 *    the hook, closing the original window would leave one that vanishes.
 *  - With an exit-record directory, the session's `default-command` becomes
 *    the recorder, so later windows' shells are recorded too.
 *
 * All targets use the `=name:` form: on tmux 3.5a `set-option`/`set-hook`
 * with a bare `=name` fails with "no such window"/"no such session", and
 * that failure used to be silently ignored.
 */
export function applyAgentSessionOptions(name: string): void {
  const target = formatTmuxTarget(name, true);
  tmux("set-option", "-t", target, "remain-on-exit", "on");
  tmux("set-hook", "-t", target, "after-new-window", "set-option -w remain-on-exit on");
  const dir = usableExitRecordDir();
  if (dir !== null) {
    tmux("set-option", "-t", target, "default-command", buildRecorderCommand(dir, tmuxDefaultShell()));
  }
}

/**
 * Which running tmux sessions should get the agent session options when the
 * daemon starts: configured agent-runtime sessions that are alive in tmux and
 * not bare. Boot adoption used to only mark these "running", so sessions that
 * predated exit handling never kept a dead pane and an `exit` still read as
 * a crash.
 */
export function agentSessionsToAdopt(configs: readonly SessionConfig[], alive: ReadonlySet<string>): string[] {
  return configs
    .filter((c) => !c.bare && alive.has(c.name) && getRuntime(c.type) !== null)
    .map((c) => c.name);
}

/** Create and start a new tmux session */
export function createSession(config: SessionConfig, log: Logger): boolean {
  const { name, type, path, command, env } = config;
  const runtime = getRuntime(type);

  // Build environment prefix for tmux commands
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  // Check if session already exists
  if (sessionExists(name)) {
    log.info(`Session '${name}' already exists in tmux, skipping create`, { session: name });
    // Adopt it: an agent session created by an older operad (or by hand)
    // gets the same exit handling as one created now.
    if (runtime) applyAgentSessionOptions(name);
    return true;
  }

  // Ensure tmux global env has LD_PRELOAD for termux-exec
  ensureTmuxLdPreload(log);

  // Agent sessions record how their shell ends; services keep the old
  // fire-and-forget behaviour.
  if (!openTmuxSession(name, path, runtime !== null)) {
    log.error(`Failed to create tmux session '${name}'`, { session: name });
    return false;
  }

  log.info(`Created tmux session '${name}'`, { session: name, type, path });

  // Ensure tmux propagates session name as terminal tab title (global option)
  tmux("set-option", "-g", "set-titles", "on");
  tmux("set-option", "-g", "set-titles-string", "#S");

  // Keep the pane (and so how its shell ended) around after its shell
  // exits, for agent sessions only. Without this, tmux tears the session
  // down the moment the shell ends and operad sees only "the session is
  // gone", which a person typing `exit` and Android's low-memory killer
  // produce identically. Restarting both meant reopening sessions the user
  // had just closed; restarting neither would give up the OOM resilience
  // that is the point of the supervisor. Session-scoped, so a user's own
  // tmux sessions are untouched.
  if (runtime) applyAgentSessionOptions(name);

  // Start the appropriate process inside the session.
  //
  // Coding-agent runtimes (claude/opencode/codex/agy) dispatch through the
  // SessionRuntime registry — each adapter knows how to assemble its own
  // startup command (resume flags, auth flags, etc). daemon/service stay
  // verbatim because they're the catch-all for arbitrary commands with
  // no readiness contract.
  if (runtime) {
    const cmd = runtime.startupCommand(config);
    if (cmd !== null) {
      sendKeys(name, cmd, true);
    }
  } else if (type === "daemon" || type === "service") {
    if (command) {
      const fullCmd = envPrefix ? `${envPrefix} ${command}` : command;
      sendKeys(name, fullCmd, true);
    }
  }

  return true;
}

/**
 * Look up the runtime adapter for a session, falling back to the Claude
 * adapter so existing callers that pass a `SessionConfig` keep working
 * even if `getRuntime()` returns null (e.g. when type is "daemon").
 *
 * Returns null only when a config has an unknown type AND we need
 * runtime-only behaviour (readiness detection); the `case` branches in
 * session.ts handle that case explicitly.
 */
function runtimeOrNull(type: SessionType): SessionRuntime | null {
  return getRuntime(type);
}

/** Result of a runtime readiness check. */
export type ReadinessResult = "ready" | "timeout" | "disappeared";

/**
 * Wait for an agent session to become ready for input by polling tmux's
 * pane capture against the runtime's `readyPatterns`. Each adapter can
 * override the polling timeout / interval; missing overrides fall back
 * to operad's defaults (60 s / 500 ms).
 *
 * Returns "ready" on first matched pattern, "disappeared" if the tmux
 * session was killed mid-wait, or "timeout" if the deadline elapsed.
 */
export async function waitForRuntimeReady(
  name: string,
  runtime: SessionRuntime,
  log: Logger,
): Promise<ReadinessResult> {
  const start = Date.now();
  const timeoutMs = runtime.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT;
  const pollMs = runtime.readyPollIntervalMs ?? DEFAULT_POLL_INTERVAL;

  while (Date.now() - start < timeoutMs) {
    if (!sessionExists(name)) {
      log.warn(`Session '${name}' disappeared while waiting for ${runtime.label} readiness`, { session: name });
      return "disappeared";
    }

    const pane = capturePane(name, 10);
    for (const pattern of runtime.readyPatterns) {
      if (pattern.test(pane)) {
        const elapsed = Date.now() - start;
        log.debug(`Session '${name}' (${runtime.label}) ready in ${elapsed}ms`, { session: name, elapsed });
        return "ready";
      }
    }

    await sleep(pollMs);
  }

  log.warn(`Session '${name}' (${runtime.label}) readiness timeout after ${timeoutMs}ms`, { session: name });
  return "timeout";
}

/**
 * Backwards-compatible alias for callers that still expect the
 * Claude-specific name. New code should call `waitForRuntimeReady`
 * directly with an explicit adapter so non-Claude sessions get the
 * right patterns/timeouts.
 *
 * Looks up the runtime via the registry and falls back to a no-op
 * "ready" if the session type isn't a known agent (daemon/service).
 */
export async function waitForClaudeReady(
  name: string,
  log: Logger,
  type: SessionType = "claude",
): Promise<ReadinessResult> {
  const runtime = runtimeOrNull(type);
  if (!runtime) {
    // Non-agent type — no readiness contract, treat as ready immediately.
    return "ready";
  }
  return waitForRuntimeReady(name, runtime, log);
}

/**
 * Send "go" to an agent session after waiting for readiness. The
 * runtime is inferred from the SessionType so OpenCode and Codex use
 * their adapter's patterns instead of Claude's.
 */
export async function sendGoToSession(
  name: string,
  log: Logger,
  type: SessionType = "claude",
): Promise<ReadinessResult> {
  const runtime = runtimeOrNull(type);
  // Non-agent sessions don't accept a "go" — bail with "ready" so callers
  // don't treat it as an error.
  if (!runtime) return "ready";

  const result = await waitForRuntimeReady(name, runtime, log);
  if (result !== "ready") {
    log.warn(`Skipping 'go' for '${name}' — ${result}`, { session: name });
    return result;
  }

  // Brief delay to ensure the prompt is fully rendered
  await sleep(GO_SEND_DELAY);

  if (sendKeys(name, "go", true)) {
    log.info(`Sent 'go' to '${name}'`, { session: name });
    return "ready";
  }
  return "timeout";
}

/** Gracefully stop a tmux session */
export async function stopSession(name: string, log: Logger, timeoutMs = 10_000): Promise<boolean> {
  if (!sessionExists(name)) {
    log.debug(`Session '${name}' not running, nothing to stop`, { session: name });
    return true;
  }

  // Try sending Ctrl-C first for a graceful exit
  tmux("send-keys", "-t", formatTmuxTarget(name, true), "C-c");
  await sleep(1000);

  // Send "exit" command
  sendKeys(name, "exit", true);
  await sleep(1000);

  // If still alive, kill it
  if (sessionExists(name)) {
    log.info(`Force-killing session '${name}'`, { session: name });
    tmux("kill-session", "-t", formatTmuxTarget(name));
    await sleep(500);
  }

  const stopped = !sessionExists(name);
  if (stopped) {
    log.info(`Session '${name}' stopped`, { session: name });
  } else {
    log.error(`Failed to stop session '${name}'`, { session: name });
  }
  return stopped;
}

/** Kill a tmux session immediately */
export function killSession(name: string): boolean {
  return tmux("kill-session", "-t", formatTmuxTarget(name)) !== null;
}

/** Get the number of attached clients for a session */
export function getAttachedClients(name: string): number {
  const output = tmux("list-clients", "-t", formatTmuxTarget(name));
  if (!output) return 0;
  return output.split("\n").filter(Boolean).length;
}

/**
 * Bring terminal app to foreground via platform abstraction.
 * Android: am start Termux. Desktop: no-op.
 */
export function bringTermuxToForeground(log: Logger): void {
  detectPlatform().bringTerminalToForeground();
}

/**
 * Create a terminal tab for a tmux session via platform abstraction.
 * Android: Termux tab via TermuxService intent with switch-client fallback.
 * Desktop: no-op (returns false — tmux sessions suffice).
 *
 * Before delegating, checks if a tmux client already exists on this session
 * (shared logic across all platforms).
 */
export function createTermuxTab(sessionName: string, log: Logger): boolean {
  // Ensure tmux propagates session name as outer terminal title
  tmux("set-option", "-g", "set-titles", "on");
  tmux("set-option", "-g", "set-titles-string", "#S");

  // If there's already a client on this session, nothing to do
  const targetClients = tmux("list-clients", "-t", formatTmuxTarget(sessionName), "-F", "#{client_tty}");
  if (targetClients && targetClients.trim().length > 0) {
    log.info(`Session '${sessionName}' already has a tab`, { session: sessionName });
    const clientTty = targetClients.trim().split("\n")[0];
    try { writeFileSync(clientTty, `\x1b]0;${sessionName}\x07`); } catch { /* ignore */ }
    return true;
  }

  // Delegate to platform for native terminal tab creation
  if (detectPlatform().createTerminalTab(sessionName)) {
    log.info(`Created terminal tab for '${sessionName}'`, { session: sessionName });
    return true;
  }

  // Fallback: switch an existing tmux client to this session
  const allClients = tmux("list-clients", "-F", "#{client_name}:#{client_tty}");
  if (allClients && allClients.trim().length > 0) {
    const firstClient = allClients.trim().split("\n")[0];
    const colonIdx = firstClient.indexOf(":");
    const clientName = firstClient.substring(0, colonIdx);
    const clientTty = firstClient.substring(colonIdx + 1);

    const switched = tmux("switch-client", "-c", clientName, "-t", formatTmuxTarget(sessionName));
    if (switched !== null) {
      log.info(`Switched client '${clientName}' to session '${sessionName}'`, { session: sessionName });
      tmux("refresh-client", "-c", clientName);
    }
    try { writeFileSync(clientTty, `\x1b]0;${sessionName}\x07`); } catch { /* ignore */ }
  } else {
    log.warn(`No tmux clients found — open terminal and run: tmux attach -t ${sessionName}`, { session: sessionName });
  }

  return true;
}

/**
 * Get all pane PIDs for a tmux session.
 * Returns an array of PIDs (one per pane). These are the shell processes
 * running inside each tmux pane — their process groups contain the actual work.
 */
export function getSessionPanePids(sessionName: string): number[] {
  // `-s` makes this session-scoped rather than window-scoped.
  //
  // Without it, list-panes resolves to the session's CURRENT window only, so a
  // session with more than one tmux window (routine once the user opens a
  // second) exposed only part of its process tree. Two consequences, both
  // observed: suspend/resume SIGSTOPped one window's tree while reporting the
  // whole session paused, and — if the current window changed between suspend
  // and resume — resume SIGCONTed a *different* tree, leaving the original
  // processes stopped with no code path able to reach them again.
  //
  // With `-s` the target is a session, so the exact-match sigil is the bare
  // `=name` form (no trailing colon).
  const output = tmux("list-panes", "-s", "-t", formatTmuxTarget(sessionName), "-F", "#{pane_pid}");
  if (!output) return [];
  return output
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n));
}

/**
 * Run a script in a new terminal tab via platform abstraction.
 * Android: Termux tab via TermuxService intent.
 * Desktop: no-op (returns false).
 */
export function runScriptInTab(scriptPath: string, cwd: string, tabName: string, log: Logger): boolean {
  const result = detectPlatform().runScriptInTab(scriptPath, cwd, tabName);
  if (result) {
    log.info(`Launched '${tabName}' in new terminal tab`, { session: tabName });
    bringTermuxToForeground(log);
  }
  return result;
}

/**
 * Find all descendant PIDs of a root process by walking /proc.
 * Catches detached children (setsid, double-fork) that process group
 * signals would miss. Returns the full tree including the root PID.
 */
export function findProcessTree(rootPid: number): number[] {
  // Build pid→ppid map from /proc
  const ppidMap = new Map<number, number>();
  try {
    const result = spawnSync("ps", ["-e", "-o", "pid=,ppid="], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.stdout) {
      for (const line of result.stdout.trim().split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          ppidMap.set(parseInt(parts[0], 10), parseInt(parts[1], 10));
        }
      }
    }
  } catch {
    return [rootPid]; // Fallback: just the root
  }

  // BFS to find all descendants
  const tree: number[] = [rootPid];
  const stack = [rootPid];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    for (const [pid, ppid] of ppidMap) {
      if (ppid === parent && pid !== rootPid) {
        tree.push(pid);
        stack.push(pid);
      }
    }
  }
  return tree;
}

/**
 * Send a signal to an entire session's process tree.
 * For each pane PID: walks the full descendant tree via /proc and signals
 * every process individually. This catches detached children (MCP servers,
 * LSP, background tasks) that process group signals miss.
 */
function signalSessionTree(sessionName: string, signal: "SIGSTOP" | "SIGCONT", log: Logger): boolean {
  const panePids = getSessionPanePids(sessionName);
  if (panePids.length === 0) {
    log.warn(`Cannot signal '${sessionName}' — no pane PIDs found`, { session: sessionName });
    return false;
  }

  let signaled = 0;
  const allPids = new Set<number>();

  for (const panePid of panePids) {
    const tree = findProcessTree(panePid);
    for (const pid of tree) allPids.add(pid);
  }

  for (const pid of allPids) {
    try {
      process.kill(pid, signal);
      signaled++;
    } catch {
      // ESRCH (already dead) or EPERM — skip silently
    }
  }

  if (signaled > 0) {
    log.info(`${signal} '${sessionName}' (${signaled}/${allPids.size} processes)`, { session: sessionName });
  }
  return signaled > 0;
}

/**
 * Suspend a session by sending SIGSTOP to all processes in the tree.
 * Walks /proc to find detached children (MCP servers, LSP, background tasks)
 * that process group signals would miss.
 * SIGSTOP'd processes use zero CPU and their pages become cold for zRAM.
 * Returns true if at least one process was signaled.
 */
export function suspendSession(sessionName: string, log: Logger): boolean {
  return signalSessionTree(sessionName, "SIGSTOP", log);
}

/**
 * Resume a suspended session by sending SIGCONT to all processes in the tree.
 * Returns true if at least one process was signaled.
 */
export function resumeSession(sessionName: string, log: Logger): boolean {
  return signalSessionTree(sessionName, "SIGCONT", log);
}

/** Promise-based sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -- Pure helpers (exported for unit tests) ------------------------------------

/**
 * Build a tmux target string with the exact-match `=` sigil.
 *
 * tmux has two distinct target namespaces:
 *
 *   target-session subcommands (has-session, kill-session, list-clients,
 *   switch-client): `=name` is valid and matches exactly.
 *
 *   target-pane subcommands (capture-pane, send-keys, list-panes,
 *   select-window): `=name` is treated as a literal pane name and errors
 *   with "can't find pane". These need a target-window form: `=name:` —
 *   the trailing colon resolves to the session's current window then its
 *   current pane.
 *
 * @param name     - raw session name (alphanumeric + hyphens)
 * @param forPane  - true when the target will be used in a pane/window
 *                   subcommand; appends the trailing colon.
 */
export function formatTmuxTarget(name: string, forPane = false): string {
  return forPane ? `=${name}:` : `=${name}`;
}
