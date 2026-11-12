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
 */

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
  if (command.includes("run_gui.sh") || command.includes("/x2d")) {
    return /run_gui\.sh|[Bb]ambu[Ss]tudio|bambu-studio/;
  }
  // mcp-server-playwright / @playwright/mcp
  if (command.includes("playwright")) return /playwright.*mcp|mcp.*playwright/;
  // termux-x11 runs as app_process with com.termux.x11.Loader
  if (command.includes("termux-x11")) return /com\.termux\.x11\.Loader/;
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
