/**
 * detect.ts — work out which agent is actually running in a pane.
 *
 * operad launches a session's agent by sending a command into a tmux pane
 * that is otherwise an ordinary shell. Nothing stops the person at the
 * keyboard from quitting that agent and starting a different one — running
 * `agy` or `codex` in a session operad opened for Claude Code is a normal
 * thing to do.
 *
 * Until the session is restarted that costs nothing, because operad only
 * supervises the pane. On a restart (or the next boot) it replays the
 * CONFIGURED runtime's startup command, so the session came back as Claude
 * Code and whatever the user had been using was gone. Recognising the
 * running tool is what lets the restore match what was there.
 *
 * Matching is on process command lines, which is the one place the answer is
 * unambiguous: pane titles lag, `pane_current_command` reports `node` for
 * anything node-based, and a TUI's own output is a moving target.
 */

import { spawnSync } from "node:child_process";
import type { SessionType } from "../types.js";

/**
 * Signatures, most specific first.
 *
 * Order matters for substring collisions: the Antigravity launcher's path
 * (`.../claude-channel/dist/antigravity-cli.js` on the author's machine)
 * contains the word "claude", so it has to be tested before anything that
 * looks for Claude Code. The Claude pattern additionally requires the
 * binary name to end a path segment, which `claude-channel` does not.
 */
const RUNTIME_SIGNATURES: ReadonlyArray<{ runtime: SessionType; pattern: RegExp }> = [
  { runtime: "agy", pattern: /(?:^|[\s/])antigravity(?:-cli)?(?:\.js)?(?:\s|$)|(?:^|[\s/])agy(?:\s|$)/ },
  { runtime: "codex", pattern: /(?:^|[\s/])codex(?:\s|$)/ },
  { runtime: "opencode", pattern: /(?:^|[\s/])opencode(?:\s|$)/ },
  { runtime: "claude", pattern: /(?:^|[\s/])claude(?:\s|$)/ },
];

/** A single `ps` snapshot: command lines plus the parent→children graph. */
export interface ProcessSnapshot {
  argsByPid: Map<number, string>;
  childrenByPid: Map<number, number[]>;
}

/** How deep below the pane's shell to look for an agent process. */
const DETECT_MAX_DEPTH = 6;

/**
 * Identify the agent a single command line belongs to, or null if it is
 * not a recognised agent (a shell, a build, the daemon itself).
 */
export function detectRuntimeFromArgs(args: string): SessionType | null {
  if (!args) return null;
  for (const { runtime, pattern } of RUNTIME_SIGNATURES) {
    if (pattern.test(args)) return runtime;
  }
  return null;
}

/**
 * Parse `ps -eo pid,ppid,args` output into a snapshot.
 *
 * Separate from the spawn so it can be tested without a process table.
 */
export function parseProcessSnapshot(output: string): ProcessSnapshot {
  const argsByPid = new Map<number, string>();
  const childrenByPid = new Map<number, number[]>();

  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue; // header row, or a line `ps` wrapped
    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    argsByPid.set(pid, match[3].trim());
    const siblings = childrenByPid.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenByPid.set(ppid, [pid]);
  }

  return { argsByPid, childrenByPid };
}

/**
 * Find the agent running under a pane's shell.
 *
 * Breadth-first from the pane PID so the agent the user launched is found
 * before anything IT spawned — an agent that shells out to another agent
 * (a subagent, a `claude -p` call inside a script) must not be mistaken for
 * the session's own runtime. The pane PID itself is skipped: operad's own
 * startup command is on the shell's command line in some shells, and would
 * answer with the runtime we are trying to re-derive.
 */
export function detectRuntimeForPane(
  panePid: number,
  snapshot: ProcessSnapshot,
): SessionType | null {
  let frontier = snapshot.childrenByPid.get(panePid) ?? [];
  const seen = new Set<number>([panePid]);

  for (let depth = 0; depth < DETECT_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const pid of frontier) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const runtime = detectRuntimeFromArgs(snapshot.argsByPid.get(pid) ?? "");
      if (runtime) return runtime;
      next.push(...(snapshot.childrenByPid.get(pid) ?? []));
    }
    frontier = next;
  }

  return null;
}

/**
 * Snapshot the whole process table in one `ps` call.
 *
 * One spawn per poll for the entire machine, rather than per session or per
 * process: operad's monitor already walks each session's tree for RSS, and
 * this keeps runtime detection from multiplying that cost. Returns an empty
 * snapshot when `ps` is unavailable, which callers read as "don't know" and
 * leave the configured runtime alone.
 */
export function snapshotProcesses(): ProcessSnapshot {
  try {
    const result = spawnSync("ps", ["-eo", "pid,ppid,args"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || !result.stdout) {
      return { argsByPid: new Map(), childrenByPid: new Map() };
    }
    return parseProcessSnapshot(result.stdout);
  } catch {
    return { argsByPid: new Map(), childrenByPid: new Map() };
  }
}
