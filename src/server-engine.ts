/**
 * server-engine.ts — HTTP/IPC/WS/SSE subsystem extraction scaffold.
 *
 * This module is the landing zone for handler logic currently embedded in
 * Daemon. Full extraction is incremental — this initial shell establishes the
 * injection point and hosts pure utility helpers that have no fan-out into
 * Daemon's session/agent state.
 *
 * Extraction roadmap (in priority order):
 *   1. WS message dispatch helpers (switchboard_get / switchboard_update paths)
 *   2. SSE push helpers (pushSseState / pushConversationDeltas)
 *   3. REST route builders (currently wired in http.ts setup inside Daemon.start())
 *   4. handleWsMessage() — deferred until sdkBridge + memoryDb access is
 *      cleanly expressible through OrchestratorContext
 *   5. handleIpcCommand() — deferred; depends on ~30 Daemon methods
 *
 * TODO: Move WS/SSE helpers here once OrchestratorContext exposes
 *       dashboard.pushEvent and dashboard.broadcastWs via interface.
 */

import type { OrchestratorContext } from "./orchestrator-context.js";
import type { Switchboard } from "./types.js";

/**
 * ServerEngine — subsystem for HTTP/IPC/WS/SSE request handling.
 *
 * Accepts a shared OrchestratorContext so all state mutations are
 * reflected across the system without coupling to Daemon internals.
 */
export class ServerEngine {
  constructor(private readonly ctx: OrchestratorContext) {}

  // ---------------------------------------------------------------------------
  // Pure WS payload builders
  // ---------------------------------------------------------------------------

  /**
   * Build a serialisable snapshot of the current switchboard state suitable
   * for sending to a WS client as a `switchboard_update` message.
   *
   * Pure function of ctx.switchboard — no side effects.
   */
  buildSwitchboardPayload(): Record<string, unknown> {
    const sb: Switchboard = this.ctx.switchboard;
    return { type: "switchboard_update", ...sb };
  }

  /**
   * Build a minimal agent-list payload for WS broadcast.
   * Lists agent names and their per-agent switchboard enable state.
   *
   * Pure function of ctx.agentConfigs and ctx.switchboard.
   */
  buildAgentListPayload(): Record<string, unknown> {
    const agents = this.ctx.agentConfigs.map((a) => ({
      name: a.name,
      enabled: this.isAgentEnabled(a.name),
    }));
    return { type: "agent_list", agents };
  }

  // ---------------------------------------------------------------------------
  // Pure predicate helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns true when the agent with the given name is enabled by both
   * the agent's own `enabled` flag and the switchboard master switch.
   *
   * Mirrors the Daemon.isAgentEnabled() logic so callers in this engine
   * do not need to reach back into Daemon.
   */
  isAgentEnabled(agentName: string): boolean {
    const sb = this.ctx.switchboard;
    if (!sb.all) return false;
    const sw = sb.agents[agentName];
    if (sw === false) return false;
    return true;
  }
}
