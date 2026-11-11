/**
 * opencode.ts — OpenCode adapter.
 *
 * OpenCode (https://opencode.ai) is a project-directory-scoped TUI agent.
 * It resumes with `--continue` (the project's last session) or
 * `--session <id>` (a specific one) — read from the flag table of the
 * installed 0.5.7 binary.
 *
 * This adapter used to claim plain `opencode` resumed by cwd and ignored
 * `session_id`. It does not: plain `opencode` starts a new session, so every
 * restart left the previous conversation behind.
 *
 * TODO: add a `latestConversationId` locator once OpenCode's session store
 * can be observed — the binary installed on the development device is a
 * glibc build that won't run under bionic, so its on-disk format has not
 * been inspected, and guessing it would be worse than `--continue`.
 */

import { isSafeConversationId, type SessionRuntime } from "./runtime.js";
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
   * - With a usable `session_id`: `opencode --session <id>`.
   * - Otherwise: `opencode --continue`, the project's last session.
   *
   * An id that fails validation falls through to `--continue` rather than
   * being escaped and passed on (see `isSafeConversationId`).
   */
  startupCommand(config: SessionConfig): string {
    if (config.session_id && isSafeConversationId(config.session_id)) {
      return `opencode --session ${config.session_id}`;
    }
    return "opencode --continue";
  },
};
