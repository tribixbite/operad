/**
 * exit-record.ts — record how an agent session's shell ended.
 *
 * operad must tell two events apart that look identical from tmux on
 * Termux: a person typing `exit` (the session is finished; reopening it is
 * the bug users reported) and Android's low-memory killer SIGKILLing the
 * shell (exactly what auto-restart exists for). tmux 3.5a there leaves
 * `#{pane_dead_status}` and `#{pane_dead_signal}` empty for both.
 *
 * So agent shells run under a small POSIX-sh wrapper that waits for the
 * shell and writes its exit status to a record file. `sh` reports a child
 * killed by signal N as status 128+N, which is how SIGKILL becomes visible.
 * The wrapper is tiny (one `sh` process, ~1 MB RSS), so the low-memory
 * killer takes the shell or the agent long before it; if it is ever killed
 * too, its record is left saying `running`, which is read as a kill — the
 * safe side.
 *
 * Records are keyed by tmux server pid + pane id, both taken from the
 * `$TMUX` / `$TMUX_PANE` variables tmux exports into every pane. Pane ids
 * are unique for a server's lifetime, and the server pid separates one
 * server's `%0` from the next one's, so a stale record can never be read as
 * a new pane's. Records from servers that are gone are pruned when operad
 * next creates a session.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { shellQuote } from "./shell-quote.js";

/** The exit-record directory for a daemon: `exits/` beside its state file. */
export function exitRecordDirFor(stateFile: string): string {
  return join(dirname(stateFile), "exits");
}

/**
 * `$0` of the wrapper script. Shows in `ps`, `#{pane_start_command}` and the
 * session's `default-command`, which is how operad recognises sessions that
 * carry a recorder (and so whose missing record means a kill).
 */
export const EXIT_RECORDER_MARKER = "operad-exit-recorder";

/**
 * The wrapper. Arguments: $1 = record directory, $2… = the shell argv.
 *
 * Before the shell starts it writes `running` to the record; when the shell
 * ends it overwrites that with the status. So per pane: no record means the
 * pane never had a recorder (a session adopted from before this existed),
 * `running` on a dead pane means the wrapper was killed along with it, and
 * a number is how the shell ended.
 *
 * `${TMUX#*,}` then `${t%%,*}` extract the server pid from
 * `$TMUX` = "socket_path,server_pid,session_index" with no external tools,
 * so it works on any POSIX sh. Records are only written inside tmux and
 * into a directory that exists, so a stray invocation never creates files.
 * The wrapper always exits 0: the status it reports is the record, and a
 * non-zero wrapper status would only confuse tmux's own fields.
 */
const RECORDER_SCRIPT = [
  'd=$1; shift',
  't=${TMUX#*,}; t=${t%%,*}; p=${TMUX_PANE#%}; f=',
  '[ -n "$TMUX" ] && [ -n "$p" ] && [ -d "$d" ] && f="$d/$t-$p" && printf \'running\\n\' > "$f"',
  '"$@"; s=$?',
  '[ -n "$f" ] && printf \'%s\\n\' "$s" > "$f"',
  'exit 0',
].join("\n");

/**
 * argv that runs `shell` as a login shell under the recorder. Login, because
 * that is how tmux starts `default-shell` when it has no command, and
 * profiles (PATH, LD_PRELOAD on Termux) depend on it.
 */
export function buildRecorderArgv(recordDir: string, shell: string): string[] {
  return ["sh", "-c", RECORDER_SCRIPT, EXIT_RECORDER_MARKER, recordDir, shell, "-l"];
}

/**
 * The same argv as one shell command string, for tmux's `default-command`
 * (which tmux hands to `default-shell -c`). Every word is single-quoted, so
 * record paths with spaces or quotes survive intact.
 */
export function buildRecorderCommand(recordDir: string, shell: string): string {
  return buildRecorderArgv(recordDir, shell).map(shellQuote).join(" ");
}

/**
 * Record file name for a pane: `<server_pid>-<pane_number>`. Returns null
 * unless both parts are plain numbers, so a value read from tmux can never
 * be turned into a path outside the record directory.
 */
export function exitRecordKey(serverPid: string, paneId: string): string | null {
  const pane = paneId.startsWith("%") ? paneId.slice(1) : paneId;
  if (!/^\d+$/.test(serverPid) || !/^\d+$/.test(pane)) return null;
  return `${serverPid}-${pane}`;
}

/** What a pane's record says: the shell's status, or that it is still running. */
export type ExitRecord = number | "running";

/** Marker the wrapper writes while the shell is running. */
const RUNNING = "running";

/**
 * Read a pane's record: its shell's exit status, `"running"`, or null when
 * there is no record (or it is unreadable — never guessed at).
 */
export function readExitRecord(recordDir: string, key: string | null): ExitRecord | null {
  if (key === null) return null;
  try {
    const raw = readFileSync(join(recordDir, key), "utf-8").trim();
    if (raw === RUNNING) return RUNNING;
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

/** Signal number shells use for Ctrl-C. A status of 128+SIGINT is a person, not a crash. */
const SIGINT = 2;

/**
 * Turn a recorded shell status into a verdict.
 *
 * Above 128 is "killed by signal status-128" — except SIGINT: bash's `exit`
 * with no argument returns the last command's status, so exiting right after
 * Ctrl-C-ing something reports 130, and that is the user leaving. Any other
 * status, zero or not, is the shell having exited on its own (`exit 3` is
 * still an exit).
 *
 * Residual ambiguity, documented rather than hidden: `exit` immediately
 * after a foreground command was itself SIGKILLed reports 137 and reads as
 * a kill, so that session is restarted. That errs toward keeping a session,
 * which is the side the supervisor exists for.
 */
export function interpretRecordedStatus(
  status: number,
): { state: "exited"; status: number } | { state: "killed"; status: number; signal: number } {
  if (status > 128 && status - 128 !== SIGINT) {
    return { state: "killed", status, signal: status - 128 };
  }
  return { state: "exited", status };
}

/** Matches a record file name and captures its server pid. */
const RECORD_NAME = /^(\d+)-\d+$/;

/**
 * Delete records left by tmux servers other than `currentServerPid`. Their
 * panes are gone with the server, and pruning keeps the directory at one
 * small file per agent pane of the live server. Other files are left alone.
 */
export function pruneStaleExitRecords(recordDir: string, currentServerPid: string): void {
  if (!existsSync(recordDir)) return;
  let names: string[];
  try {
    names = readdirSync(recordDir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = RECORD_NAME.exec(name);
    if (!m || m[1] === currentServerPid) continue;
    try { unlinkSync(join(recordDir, name)); } catch { /* raced with another prune */ }
  }
}
