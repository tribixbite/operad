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
import { resolveJsonlFiles } from "../claude-session.js";

/**
 * True when a Claude conversation JSONL with `sessionId` actually exists
 * on disk for `projectPath`. `claude --resume <id>` aborts with "No
 * conversation found with session ID …" when the id is stale (resumed on
 * a different machine, history pruned, or a registry entry that outlived
 * its conversation), leaving the tmux pane at a dead error instead of a
 * usable agent. Checking first lets us fall back to a fresh `cc`.
 */
function conversationExists(projectPath: string | undefined, sessionId: string): boolean {
  if (!projectPath) return false;
  try {
    return resolveJsonlFiles(projectPath).some((f) => f.id === sessionId);
  } catch {
    // If the history dir can't be read, don't block startup — fall back
    // to `cc` rather than risk a bad --resume.
    return false;
  }
}

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
    if (
      config.session_id &&
      isValidSessionId(config.session_id) &&
      conversationExists(config.path, config.session_id)
    ) {
      return `claude --resume ${config.session_id} --dangerously-skip-permissions`;
    }
    // No session_id, malformed id, or the conversation no longer exists →
    // start a fresh session via the user's `cc` alias instead of failing
    // on a dead --resume.
    return "cc";
  },
};
