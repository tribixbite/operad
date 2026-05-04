/**
 * runtime.ts — adapter interface for coding-agent CLIs supervised by operad.
 *
 * Operad started life as a Claude Code orchestrator, but the lifecycle
 * (tmux create → wait for ready prompt → send "go") generalises across
 * project-scoped TUIs like OpenCode and Codex. The bits that differ —
 * the binary name, how to resume, what an idle prompt looks like — live
 * here behind one interface so the lifecycle code in `session.ts` can
 * stay runtime-agnostic.
 *
 * The interface is deliberately minimal: anything Claude-specific (UUID
 * resume, JSONL prompt history, --dangerously-skip-permissions) goes in
 * the Claude adapter. Nothing in the interface assumes Anthropic.
 *
 * Stateless tools that don't fit this model (Gemini CLI's one-shot
 * `gemini "<prompt>"`) deliberately have no adapter — they'd need a
 * different subsystem, not a session-type extension.
 */

import type { SessionConfig, SessionType } from "../types.js";

/** A single runtime — Claude, OpenCode, Codex, etc. */
export interface SessionRuntime {
  /**
   * Stable identifier matching `SessionType`. Used as the registry key
   * AND in TOML (`type = "<id>"`).
   */
  readonly id: SessionType;

  /**
   * Human-readable label for log lines and dashboard surfaces.
   * Distinct from `id` so we can rename the brand without breaking
   * existing TOML.
   */
  readonly label: string;

  /**
   * Build the shell command to start the agent inside its tmux pane.
   * Returns the *exact* string we'll pass to `tmux send-keys`. The
   * adapter is responsible for any per-config branching (e.g. Claude's
   * `--resume <UUID>` when session_id is set).
   *
   * Returning `null` means "skip startup" (the session is meant to be
   * adopted from an already-running process).
   */
  startupCommand(config: SessionConfig): string | null;

  /**
   * Patterns matched against the most recent tmux pane capture to decide
   * the agent is idle and ready for input. Order matters — the first
   * match wins. Keep them tight; loose patterns match shell prompts and
   * fire before the agent has actually drawn its UI.
   */
  readonly readyPatterns: readonly RegExp[];

  /**
   * Override the default readiness timeout (60 s) for slow-starting
   * runtimes. `undefined` = use the operad default.
   */
  readonly readyTimeoutMs?: number;

  /**
   * Override the default poll interval (500 ms) for runtimes that
   * spam the pane during startup and need a slower poll to avoid
   * matching transient text.
   */
  readonly readyPollIntervalMs?: number;
}
