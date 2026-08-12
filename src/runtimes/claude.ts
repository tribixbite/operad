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

/**
 * Patterns that indicate Claude Code's TUI is at an input prompt.
 *
 * These are matched against a whole tmux pane capture — a MULTI-LINE string.
 * The previous set was written as if it were matching a single line: `/>\s*$/`
 * and friends have no `m` flag, so `$` anchors to the end of the ENTIRE
 * capture, and Claude's TUI leaves blank lines below its footer. Three live,
 * fully-ready sessions were checked against the old set and matched none of
 * them, so every Claude start burned the full 60 s readiness timeout, and
 * `auto_go` never fired at all (`sendGoToSession` skips the send unless
 * readiness is positively detected).
 *
 * Anchored patterns now carry `m` and require the line to hold ONLY the
 * prompt, so an ordinary line of output that happens to end in `>` — closing
 * an HTML tag, say — is not mistaken for a prompt.
 */
const CLAUDE_READY_PATTERNS: readonly RegExp[] = [
  /^\s*[❯>›]\s*$/m,          // input prompt alone on its line (current TUI uses U+276F)
  /[│|]\s*[❯>]/,             // prompt inside a box-drawn input row
  /shift\+tab to cycle/i,    // permission-mode footer, drawn with the input box
  /\?\s+for\s+shortcuts/i,   // shortcuts footer on a freshly started session
  /claude\s*>/i,             // legacy branded prompt
  /^\s*\$\s*$/m,             // shell fallback when claude itself hasn't drawn
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
