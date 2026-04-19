/**
 * session.ts — Tmux session lifecycle management
 *
 * Handles creating, starting, stopping, and querying tmux sessions.
 * For Claude-type sessions, polls tmux capture-pane to detect readiness
 * instead of hardcoded sleep delays.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionConfig, SessionType } from "./types.js";
import type { Logger } from "./log.js";
import { detectPlatform } from "./platform/platform.js";

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

/** Timeout for Claude Code readiness polling (ms) */
const CLAUDE_READY_TIMEOUT = 60_000;
/** Interval between readiness polls (ms) */
const CLAUDE_POLL_INTERVAL = 500;
/** Patterns that indicate Claude Code is ready for input */
const CLAUDE_READY_PATTERNS = [
  />\s*$/,           // prompt indicator
  /\$\s*$/,          // shell prompt (fallback)
  /claude\s*>/i,     // claude prompt
  /\?\s*$/,          // question mark prompt (e.g., "What would you like to do?")
];
/** Delay before sending "go" after readiness detection (ms) */
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
    const result = spawnSync(TMUX_BIN(),args, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: getCleanEnv(),
    });
    if (result.status !== 0) return null;
    return (result.stdout ?? "").trim();
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
 * @returns PID of the matching process, or null if not found
 */
export function findBareServicePid(pattern: RegExp): number | null {
  try {
    const result = spawnSync("ps", ["-eo", "pid,args"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || !result.stdout) return null;
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx < 0) continue;
      const pid = parseInt(trimmed.slice(0, spaceIdx), 10);
      const args = trimmed.slice(spaceIdx + 1);
      if (isNaN(pid) || pid <= 1) continue;
      if (pattern.test(args)) return pid;
    }
  } catch { /* ignore */ }
  return null;
}

/** Check if the tmux server is alive */
export function isTmuxServerAlive(): boolean {
  const result = spawnSync(TMUX_BIN(),["start-server"], {
    timeout: 5000,
    stdio: "ignore",
    env: getCleanEnv(),
  });
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

/** Check if a specific tmux session exists */
export function sessionExists(name: string): boolean {
  const result = spawnSync(TMUX_BIN(),["has-session", "-t", name], {
    timeout: 5000,
    stdio: "ignore",
    env: getCleanEnv(),
  });
  return result.status === 0;
}

/** Capture the current pane content for a session */
export function capturePane(sessionName: string, _lines = 5): string {
  // Note: tmux 3.5a doesn't support -l flag for capture-pane
  const output = tmux("capture-pane", "-t", sessionName, "-p");
  return output ?? "";
}

/** Send text to a tmux session */
export function sendKeys(sessionName: string, text: string, pressEnter = true): boolean {
  // Send text and Enter as separate calls — Claude Code's TUI can miss
  // Enter when combined in a single send-keys invocation with text.
  const textOk = tmux("send-keys", "-t", sessionName, text) !== null;
  if (!textOk) return false;
  if (pressEnter) {
    return tmux("send-keys", "-t", sessionName, "Enter") !== null;
  }
  return true;
}

/**
 * Spawn a bare (non-tmux) detached process for sessions that crash inside tmux PTY.
 * Returns the child PID, or null on failure.
 */
export function spawnBareProcess(config: SessionConfig, log: Logger): number | null {
  const { name, command, env: sessionEnv } = config;
  if (!command) {
    log.error(`Bare session '${name}' has no command`, { session: name });
    return null;
  }

  // Merge session env with platform-clean env (handles LD_PRELOAD on Android)
  const cleanBase = detectPlatform().cleanEnv();
  const mergedEnv = { ...cleanBase, ...sessionEnv };
  try {
    const child = spawn("sh", ["-c", command], {
      cwd: config.path ?? process.env.HOME,
      env: mergedEnv,
      stdio: "ignore",
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

/** Create and start a new tmux session */
export function createSession(config: SessionConfig, log: Logger): boolean {
  const { name, type, path, command, env } = config;

  // Build environment prefix for tmux commands
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  // Check if session already exists
  if (sessionExists(name)) {
    log.info(`Session '${name}' already exists in tmux, skipping create`, { session: name });
    return true;
  }

  // Ensure tmux global env has LD_PRELOAD for termux-exec
  ensureTmuxLdPreload(log);

  // Create detached session with optional working directory
  const createArgs = ["new-session", "-d", "-s", name];
  if (path) {
    createArgs.push("-c", path);
  }

  const result = spawnSync(TMUX_BIN(),createArgs, {
    timeout: 10_000,
    stdio: "ignore",
    env: getCleanEnv(),
  });

  if (result.status !== 0) {
    log.error(`Failed to create tmux session '${name}'`, { session: name });
    return false;
  }

  log.info(`Created tmux session '${name}'`, { session: name, type, path });

  // Ensure tmux propagates session name as terminal tab title (global option)
  tmux("set-option", "-g", "set-titles", "on");
  tmux("set-option", "-g", "set-titles-string", "#S");

  // Start the appropriate process inside the session
  switch (type) {
    case "claude":
      if (config.session_id) {
        // Multi-instance: resume a specific Claude session by ID
        sendKeys(name, `claude --resume ${config.session_id} --dangerously-skip-permissions`, true);
      } else {
        // Default: --continue resumes the last conversation in the project directory
        sendKeys(name, "cc", true);
      }
      break;

    case "daemon":
      if (command) {
        const fullCmd = envPrefix ? `${envPrefix} ${command}` : command;
        sendKeys(name, fullCmd, true);
      }
      break;

    case "service":
      if (command) {
        const fullCmd = envPrefix ? `${envPrefix} ${command}` : command;
        sendKeys(name, fullCmd, true);
      }
      break;
  }

  return true;
}

/** Result of Claude readiness check */
export type ReadinessResult = "ready" | "timeout" | "disappeared";

/**
 * Wait for a Claude-type session to become ready for input.
 * Polls tmux capture-pane looking for a prompt indicator.
 * Returns "ready" if a prompt was detected, "timeout" if the deadline passed,
 * or "disappeared" if the tmux session was killed.
 */
export async function waitForClaudeReady(name: string, log: Logger): Promise<ReadinessResult> {
  const start = Date.now();

  while (Date.now() - start < CLAUDE_READY_TIMEOUT) {
    if (!sessionExists(name)) {
      log.warn(`Session '${name}' disappeared while waiting for readiness`, { session: name });
      return "disappeared";
    }

    const pane = capturePane(name, 10);
    // Check for any ready pattern
    for (const pattern of CLAUDE_READY_PATTERNS) {
      if (pattern.test(pane)) {
        const elapsed = Date.now() - start;
        log.debug(`Session '${name}' ready in ${elapsed}ms`, { session: name, elapsed });
        return "ready";
      }
    }

    await sleep(CLAUDE_POLL_INTERVAL);
  }

  log.warn(`Session '${name}' readiness timeout after ${CLAUDE_READY_TIMEOUT}ms`, { session: name });
  return "timeout";
}

/**
 * Send "go" to a Claude session after waiting for readiness.
 * Returns the readiness result: "ready" if go was sent successfully,
 * "timeout" or "disappeared" if the session wasn't ready.
 */
export async function sendGoToSession(name: string, log: Logger): Promise<ReadinessResult> {
  const result = await waitForClaudeReady(name, log);
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
  tmux("send-keys", "-t", name, "C-c");
  await sleep(1000);

  // Send "exit" command
  sendKeys(name, "exit", true);
  await sleep(1000);

  // If still alive, kill it
  if (sessionExists(name)) {
    log.info(`Force-killing session '${name}'`, { session: name });
    tmux("kill-session", "-t", name);
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
  return tmux("kill-session", "-t", name) !== null;
}

/** Get the number of attached clients for a session */
export function getAttachedClients(name: string): number {
  const output = tmux("list-clients", "-t", name);
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
  const targetClients = tmux("list-clients", "-t", sessionName, "-F", "#{client_tty}");
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

    const switched = tmux("switch-client", "-c", clientName, "-t", sessionName);
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
  const output = tmux("list-panes", "-t", sessionName, "-F", "#{pane_pid}");
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
function findProcessTree(rootPid: number): number[] {
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
