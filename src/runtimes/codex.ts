/**
 * codex.ts — OpenAI Codex CLI adapter.
 *
 * Codex (https://developers.openai.com/codex/cli) is OpenAI's
 * project-directory-scoped TUI agent. It resumes with `codex resume <id>`
 * or `codex resume --last` (the most recent session for the cwd).
 *
 * This adapter used to start plain `codex`, believing it resumed by cwd. It
 * does not — it starts a new session — so every restart left the previous
 * conversation behind. Sessions are located from Codex's rollout files (see
 * conversations.ts) so a restart can name the exact one.
 *
 * Auth is handled by Codex itself on first run (browser flow + OpenAI
 * account) — operad doesn't need to do anything special there. Once
 * authed, the binary just works in any project directory.
 */

import { isSafeConversationId, type SessionRuntime } from "./runtime.js";
import type { SessionConfig } from "../types.js";
import { latestCodexSession } from "./conversations.js";

/**
 * Readiness patterns for Codex's TUI, taken from a live codex 0.160.0 pane:
 *
 *   › Ask Codex to do anything
 *     GPT-6.1-Sol medium · ~/git/project
 *     ? for shortcuts                       ⚠ 1 warning · f2 to view
 *
 * The input row carries placeholder text, so the old prompt-alone pattern
 * never matched and readiness always ran to its timeout. Anchors carry `m`
 * because they are matched against a whole multi-line capture.
 */
const CODEX_READY_PATTERNS: readonly RegExp[] = [
  /^\s*›\s+Ask Codex/m,      // input row with its placeholder
  /\?\s+for\s+shortcuts/i,    // footer drawn under the input row
  /codex\s*[>›]/i,           // branded prompt (older builds)
  /^\s*[›❯>]\s*$/m,          // prompt alone on its line, once text is typed/cleared
];

export const codexRuntime: SessionRuntime = {
  id: "codex",
  label: "Codex",
  readyPatterns: CODEX_READY_PATTERNS,
  // Codex first run pauses on the OAuth browser flow; subsequent runs
  // are fast. 90 s covers both cases.
  readyTimeoutMs: 90_000,

  /**
   * - With a usable `session_id`: `codex resume <id>`.
   * - Otherwise: `codex resume --last` — filtered to the cwd, and it starts
   *   a fresh session when the project has none (observed with 0.160.0).
   *
   * If the user hasn't authed yet, Codex prints a URL into the pane and
   * waits for browser confirmation; the readiness watcher times out
   * gracefully and the user resumes once the auth flow is done.
   */
  startupCommand(config: SessionConfig): string {
    if (config.session_id && isSafeConversationId(config.session_id)) {
      return `codex resume ${config.session_id}`;
    }
    return "codex resume --last";
  },

  latestConversationId: (projectPath, sinceMs) => latestCodexSession(projectPath, sinceMs),
};
