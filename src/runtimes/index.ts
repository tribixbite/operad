/**
 * runtimes/index.ts — registry of session runtime adapters.
 *
 * `getRuntime(type)` is the only entry point — it returns either the
 * matching adapter or null. Lifecycle code in session.ts uses null to
 * mean "this isn't an interactive coding agent; treat it as a daemon
 * or service" (the existing daemon/service branches keep handling
 * those types directly with their config.command).
 *
 * To add a runtime:
 *   1. Add the id to `SessionType` in `types.ts`.
 *   2. Add a TOML alias in `config.ts` if needed.
 *   3. Implement the adapter under `src/runtimes/<id>.ts`.
 *   4. Register it in the map below.
 *   5. (Optional) extend doctor/install-tmux to detect the binary.
 */

import type { SessionRuntime } from "./runtime.js";
import type { SessionType } from "../types.js";
import { claudeRuntime } from "./claude.js";
import { opencodeRuntime } from "./opencode.js";
import { codexRuntime } from "./codex.js";

const REGISTRY: Partial<Record<SessionType, SessionRuntime>> = {
  claude: claudeRuntime,
  opencode: opencodeRuntime,
  codex: codexRuntime,
};

/** Resolve a runtime adapter by SessionType. Returns null for non-agent types. */
export function getRuntime(type: SessionType): SessionRuntime | null {
  return REGISTRY[type] ?? null;
}

/** All registered runtime ids — useful for doctor probes and dashboards. */
export function listRuntimes(): SessionRuntime[] {
  return Object.values(REGISTRY).filter((r): r is SessionRuntime => r !== undefined);
}

export type { SessionRuntime } from "./runtime.js";
