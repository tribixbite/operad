/**
 * claude.ts — Claude Code adapter.
 *
 * Wraps the original Claude-specific lifecycle bits that used to live
 * inline in `session.ts`. Behaviour is preserved exactly: `cc` for a
 * fresh session, `claude --resume <UUID> --dangerously-skip-permissions`
 * when the registry has a session_id. The UUID guard is repeated here
 * (in addition to the registry-load guard) because adapter code is the
 * last layer before we shell out via `tmux send-keys`.
 */

import type { SessionRuntime } from "./runtime.js";
import type { SessionConfig } from "../types.js";
import { isValidSessionId } from "../registry.js";

/** Patterns that indicate Claude Code's TUI is at an input prompt. */
const CLAUDE_READY_PATTERNS: readonly RegExp[] = [
  />\s*$/,           // generic prompt indicator
  /\$\s*$/,          // shell prompt (fallback when claude itself hasn't drawn)
  /claude\s*>/i,     // claude's own prompt
  /\?\s*$/,          // question prompt ("What would you like to do?")
];

export const claudeRuntime: SessionRuntime = {
  id: "claude",
  label: "Claude Code",
  readyPatterns: CLAUDE_READY_PATTERNS,

  /**
   * - With a valid UUID `session_id`: `claude --resume <id> --dangerously-skip-permissions`
   * - Otherwise: the user's `cc` shell alias (which expands to whatever
   *   resume flag the user prefers — typically `claude --continue`).
   *
   * Invalid session_ids fall through to the `cc` path; the registry
   * already filters non-UUIDs on load but this is the last line of
   * defence before the value reaches `send-keys`.
   */
  startupCommand(config: SessionConfig): string {
    if (config.session_id && isValidSessionId(config.session_id)) {
      return `claude --resume ${config.session_id} --dangerously-skip-permissions`;
    }
    return "cc";
  },
};
