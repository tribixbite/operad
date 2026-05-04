/**
 * codex.ts — OpenAI Codex CLI adapter.
 *
 * Codex (https://developers.openai.com/codex/cli) is OpenAI's
 * project-directory-scoped TUI agent. The shape is similar to OpenCode:
 * `codex` in the project cwd resumes whatever conversation the tool
 * stored in `.codex/`. There's no UUID-keyed resume flag exposed by
 * the public CLI.
 *
 * Auth is handled by Codex itself on first run (browser flow + OpenAI
 * account) — operad doesn't need to do anything special there. Once
 * authed, the binary just works in any project directory.
 */

import type { SessionRuntime } from "./runtime.js";
import type { SessionConfig } from "../types.js";

/**
 * Readiness patterns for Codex's TUI.
 *
 * TODO: tighten once we've observed Codex panes. Generic prompts kept
 * as fallbacks so the first-cut behaviour matches Claude's robustness.
 */
const CODEX_READY_PATTERNS: readonly RegExp[] = [
  /codex\s*[>›]/i,     // Codex's branded prompt (if any)
  /›\s*$/,
  />\s*$/,
  /\$\s*$/,
];

export const codexRuntime: SessionRuntime = {
  id: "codex",
  label: "Codex",
  readyPatterns: CODEX_READY_PATTERNS,
  // Codex first run pauses on the OAuth browser flow; subsequent runs
  // are fast. 90 s covers both cases.
  readyTimeoutMs: 90_000,

  /**
   * Same shape as OpenCode: cwd-scoped resume, no flag needed. If the
   * user hasn't authed yet, Codex prints a URL into the pane and waits
   * for browser confirmation — operad doesn't need to do anything; the
   * readiness watcher will time out gracefully and the user resumes
   * once they finish the auth flow on their phone/desktop.
   */
  startupCommand(_config: SessionConfig): string {
    return "codex";
  },
};
