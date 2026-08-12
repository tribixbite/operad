/**
 * opencode.ts — OpenCode adapter.
 *
 * OpenCode (https://opencode.ai) is a project-directory-scoped TUI agent.
 * Unlike Claude Code it has no UUID-based session resumption: re-entering
 * the project directory and running `opencode` resumes whatever
 * conversation lives in that project's `.opencode/` artifacts.
 *
 * The `session_id` field on `SessionConfig` is therefore ignored here —
 * resumption is implicit by cwd, which tmux already inherits via
 * `new-session -c <path>` in session.ts.
 */

import type { SessionRuntime } from "./runtime.js";
import type { SessionConfig } from "../types.js";

/**
 * Readiness patterns for OpenCode's TUI. We match a generic `>` prompt
 * suffix plus OpenCode's branded prompt; the more specific patterns go
 * first so a transient shell `$` doesn't false-positive before the TUI
 * paints.
 *
 * TODO: tighten these once we've observed actual OpenCode pane captures.
 * Generic `>` and `$` are kept as safety nets matching Claude's pattern
 * set so first-cut behaviour is at least no-worse.
 */
const OPENCODE_READY_PATTERNS: readonly RegExp[] = [
  // Anchors carry `m` and require a prompt-only line: these match a whole
  // multi-line pane capture, where a bare `$` anchors to the end of the entire
  // string and so never fires once a TUI draws a footer below its input row.
  /opencode\s*[>›]/i,     // OpenCode's branded prompt
  /^\s*[›❯>]\s*$/m,       // angle/generic prompt alone on its line
  /^\s*\$\s*$/m,          // shell fallback
];

export const opencodeRuntime: SessionRuntime = {
  id: "opencode",
  label: "OpenCode",
  readyPatterns: OPENCODE_READY_PATTERNS,
  // OpenCode startup spawns a Bun runtime + workspace scan; first run can
  // exceed Claude's 60 s budget. 90 s gives headroom without unbounded wait.
  readyTimeoutMs: 90_000,

  /**
   * OpenCode resumes by cwd — the launcher needs no resume flag, just
   * the binary name. tmux already starts the pane with the project
   * directory as cwd via `new-session -c`.
   *
   * We intentionally ignore `config.session_id` here: OpenCode has no
   * UUID-keyed resume API. If users want to "fork" a project they
   * should `tmx open <path> --new` to create a parallel suffixed
   * session, and OpenCode will treat both panes as independent.
   */
  startupCommand(_config: SessionConfig): string {
    return "opencode";
  },
};
