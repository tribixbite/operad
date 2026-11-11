/**
 * shell-quote.ts — POSIX `sh` quoting, shared by every module that builds a
 * shell command string (agent tools, the tmux exit recorder).
 *
 * Kept dependency-free so low-level modules like session.ts can use it
 * without pulling in tools.ts and the SQLite layer behind it.
 */

/**
 * Single-quote a value for POSIX `sh`.
 *
 * `JSON.stringify` was used for this in several places, which produces a
 * *double*-quoted word — and `sh` still performs `$(…)`, backtick and `$VAR`
 * expansion inside double quotes, so a value of `$(id)` executed. Single
 * quotes suppress every expansion; the only character needing care is the
 * quote itself, closed and reopened around an escaped literal.
 */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
