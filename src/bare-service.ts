/**
 * bare-service.ts — find the process that belongs to a bare service.
 *
 * Bare services (`bare = true`) run outside tmux, so after a daemon restart
 * — or once their wrapper has exec'd away — operad finds their process by
 * command line and "adopts" it. Getting that wrong is not cosmetic: on the
 * author's device `x2d` adopted the `termux-x11` service's X server, because
 * x2d's launch command starts that server when it is down and so contains
 * "termux-x11", and the X11 test ran first. Two services then claimed one
 * process and x2d's health check fought the X server.
 *
 * So, in order:
 *  1. the session's own health `process_pattern`, when it has one — the user
 *     already told operad what its process looks like, and the health check
 *     matches on the same pattern;
 *  2. heuristics from the command, MOST specific first: a command that names
 *     its own entry point (`run_gui.sh`) is about that, whatever helpers it
 *     also starts;
 *  3. otherwise no pattern — a generic guess would adopt strangers.
 *
 * The heuristics identify a process by the PROGRAM it runs — its executable,
 * or the script/class/package an interpreter was started on — anchored at
 * the start of the cmdline. Matching the names anywhere adopted bystanders:
 * `operad start x2d` once took a shell whose awk script mentioned
 * "bambu-studio" for the running service, and the restart that followed
 * killed that shell's process group.
 */

/** Optional directory prefix of an executable path in a cmdline. */
const DIR = String.raw`(?:\S*/)?`;
/** End of a cmdline token. */
const END = String.raw`(?=\s|$)`;
/** A POSIX shell executable, as the first cmdline token. */
const SHELL = String.raw`^${DIR}(?:ba|da|z|k|mk)?sh\s+`;
/** A JS launcher, as the first cmdline token. */
const JS_LAUNCHER = String.raw`^${DIR}(?:node|bun|bun-termux|npx|bunx)\s+(?:-\S+\s+)*`;

/** x2d: BambuStudio itself, or a shell running run_gui.sh (which execs it). */
const X2D_PROCESS = new RegExp(
  String.raw`^${DIR}(?:bambu-studio|[Bb]ambu[Ss]tudio)${END}|${SHELL}${DIR}run_gui\.sh${END}`,
);
/** termux-x11's X server: app_process running the Loader class. */
const TERMUX_X11_PROCESS = new RegExp(String.raw`^${DIR}app_process\S*\s(?:.*\s)?com\.termux\.x11\.Loader${END}`);
/** The Playwright MCP server, run from node/bun/npx/bunx by package or path. */
const PLAYWRIGHT_MCP_PROCESS = new RegExp(
  String.raw`${JS_LAUNCHER}\S*(?:@playwright/mcp|mcp-server-playwright)\S*${END}`,
);

import type { SessionStatus } from "./types.js";

/** Escape a string for use as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pattern for a bare service's process.
 *
 * @param command        the service's launch command.
 * @param healthPattern  its health `process_pattern`, if configured. Treated
 *                       as a regular expression, as `pgrep -f` treats it in
 *                       the health check; matched literally if it is not one.
 */
export function bareServicePattern(command: string | undefined, healthPattern?: string): RegExp | null {
  if (healthPattern) {
    try {
      return new RegExp(healthPattern);
    } catch {
      return new RegExp(escapeRegExp(healthPattern));
    }
  }
  if (!command) return null;
  // x2d → run_gui.sh, which execs BambuStudio. Match either the wrapper or
  // BS itself so force-cleanup can take down the whole tree even when the
  // wrapper has exec'd away. Tested BEFORE termux-x11: this command starts
  // the X server too, but it is not the X server.
  if (command.includes("run_gui.sh") || command.includes("/x2d")) return X2D_PROCESS;
  // mcp-server-playwright / @playwright/mcp
  if (command.includes("playwright")) return PLAYWRIGHT_MCP_PROCESS;
  // termux-x11 runs as app_process with com.termux.x11.Loader
  if (command.includes("termux-x11")) return TERMUX_X11_PROCESS;
  // Anything else: matching e.g. the first token of "sleep 3 && bun foo"
  // would be far too loose.
  return null;
}

/**
 * True when `pid` is already adopted by a session other than `name`. One
 * process belongs to one service; a second claimant has matched someone
 * else's process.
 */
export function pidHeldByOther(pid: number, name: string, adopted: ReadonlyMap<string, number>): boolean {
  for (const [other, held] of adopted) {
    if (other !== name && held === pid) return true;
  }
  return false;
}

/** What a starting daemon should do with a bare service's persisted state. */
export type BareBootDecision =
  /** Its process is alive: track this PID; the "running" state is true. */
  | { kind: "adopt"; pid: number }
  /** State says active but nothing is running: reset to stopped so boot starts it. */
  | { kind: "stale" }
  /** Not active (stopped by the user, failed, not yet started): not boot's business. */
  | { kind: "leave" };

/**
 * Reconcile a bare service's persisted status with reality at daemon start.
 *
 * A bare service has no tmux session to check, and a fresh daemon starts
 * with no adopted PIDs, so "running" in state.json says nothing about
 * whether its process survived the restart. Left alone, startSession
 * returns early on "running" and the service stays down until the health
 * check notices. A stopped service is never adopted here, even if a
 * matching process exists: the user stopped it.
 *
 * @param status   the session's persisted status.
 * @param livePid  the service's own process (see bareServicePattern), or null.
 */
export function bareServiceBootDecision(status: SessionStatus | undefined, livePid: number | null): BareBootDecision {
  const active = status === "running" || status === "degraded" || status === "starting" || status === "stopping";
  if (!active) return { kind: "leave" };
  return livePid !== null ? { kind: "adopt", pid: livePid } : { kind: "stale" };
}

/** One process from `ps -eo pid,pgid,etime,args`. */
export interface PsRow {
  pid: number;
  pgid: number;
  /** Seconds since the process started; null when ps gave nothing readable. */
  elapsedS: number | null;
  args: string;
}

/**
 * Seconds from a ps `etime` value: `mm:ss`, `hh:mm:ss` or `dd-hh:mm:ss`.
 * (`etimes` would give seconds directly, but macOS ps has no such field.)
 */
export function parseElapsed(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s);
}

/**
 * The process that IS a bare service, among everything matching its pattern.
 *
 * A match is not enough: a shell script's subshells (`( … ) &` loops,
 * `$(…)`) keep the script's cmdline, and on the author's device boot
 * adopted x2d's short-lived watchdog subshell instead of the service. So:
 *  1. process-group leaders first — operad spawns bare services detached,
 *     so the service leads its own group, and its subshells never do;
 *  2. then the longest-running, since a service outlives its helpers.
 * A non-leader still wins when no leader matches (a service run under a
 * shell that did not exec it) — but only while its group leader is alive.
 * A member of a group whose leader is gone is a remnant of a stopped
 * service: a restart once took such a subshell for "already running",
 * adopted it, and was left stopped when it exited.
 *
 * @param exclude  skips PIDs another session already owns.
 */
export function pickBareServicePid(
  rows: readonly PsRow[],
  pattern: RegExp,
  exclude?: (pid: number) => boolean,
): number | null {
  const liveGroups = new Set(rows.filter((r) => r.pid === r.pgid).map((r) => r.pgid));
  let best: PsRow | null = null;
  for (const r of rows) {
    if (!pattern.test(r.args) || exclude?.(r.pid)) continue;
    if (!liveGroups.has(r.pgid)) continue; // orphaned remnant
    if (best === null || outranks(r, best)) best = r;
  }
  return best?.pid ?? null;
}

/** True when `a` is a better candidate than `b` (see pickBareServicePid). */
function outranks(a: PsRow, b: PsRow): boolean {
  const aLeader = a.pid === a.pgid;
  const bLeader = b.pid === b.pgid;
  if (aLeader !== bLeader) return aLeader;
  return (a.elapsedS ?? -1) > (b.elapsedS ?? -1);
}
