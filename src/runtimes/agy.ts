/**
 * agy.ts — Antigravity CLI adapter.
 *
 * Antigravity (`agy`) is a project-directory-scoped TUI agent in the same
 * family as Claude Code: it keeps conversations per project and resumes the
 * most recent one with `--continue`, or a named one with
 * `--conversation <id>`.
 *
 * Why it needs an adapter rather than being run as a `service`: a service is
 * a command with no readiness contract, so operad cannot tell when it is at
 * a prompt, `auto_go` never fires, and — the reason this exists — a session
 * launched as one could not be restored as itself. Registry entries carry a
 * runtime id now, and without an `agy` id the only honest thing to restore
 * an Antigravity session as was Claude Code.
 */

import type { SessionRuntime } from "./runtime.js";
import type { SessionConfig } from "../types.js";

/**
 * Antigravity conversation ids are opaque — unlike Claude's, they are not
 * UUIDs — so this validator admits any plausible id while still refusing
 * anything that could break out of the command we build. The value is
 * interpolated into a string handed to `tmux send-keys`, which a shell then
 * parses, so quoting characters, whitespace and separators are all rejected
 * rather than escaped.
 */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** True when `id` is safe to pass as `--conversation <id>`. */
export function isValidAgyConversationId(id: string): boolean {
  return CONVERSATION_ID_PATTERN.test(id);
}

/**
 * Readiness patterns for Antigravity's TUI.
 *
 * Same discipline as the Claude adapter: anchored patterns carry `m` (they
 * are matched against a whole multi-line pane capture, so a bare `$` would
 * anchor to the end of the capture rather than the end of a line) and must
 * hold only the prompt, so a line of output that merely ends in `>` is not
 * mistaken for an input prompt.
 */
const AGY_READY_PATTERNS: readonly RegExp[] = [
  /^\s*[❯›>]\s*$/m,          // input prompt alone on its line
  /[│|]\s*[❯›>]/,            // prompt inside a box-drawn input row
  /antigravity\s*[>›]/i,     // branded prompt
  /\?\s+for\s+shortcuts/i,   // shortcuts footer
  /^\s*\$\s*$/m,             // shell fallback when agy hasn't drawn yet
];

export const agyRuntime: SessionRuntime = {
  id: "agy",
  label: "Antigravity",
  readyPatterns: AGY_READY_PATTERNS,
  // The launcher is a node process that resolves a managed install before
  // the TUI draws; first run after an update is the slow case.
  readyTimeoutMs: 90_000,

  /**
   * - With a usable `session_id`: `agy --conversation <id>`.
   * - Otherwise: `agy --continue`, which resumes the project's most recent
   *   conversation and starts a fresh one when there is none.
   *
   * An id that fails validation falls through to `--continue` rather than
   * being escaped and passed on: a registry file can be hand-edited, and
   * this is the last layer before the string reaches a shell.
   */
  startupCommand(config: SessionConfig): string {
    if (config.session_id && isValidAgyConversationId(config.session_id)) {
      return `agy --conversation ${config.session_id}`;
    }
    return "agy --continue";
  },
};
