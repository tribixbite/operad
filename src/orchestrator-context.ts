import type { TmxConfig, Switchboard } from "./types.js";
import type { StateManager } from "./state.js";
import type { MemoryDb } from "./memory-db.js";
import type { AgentConfig } from "./agents.js";
import type { SdkBridge } from "./sdk-bridge.js";
import type { Logger } from "./log.js";

/**
 * Shared dependency container passed to extracted subsystem engines.
 * All fields are references — mutations are visible across the system.
 * Keep this flat: it's a data bag, not a service locator.
 *
 * NOTE: AgentConfig is sourced from ./agents.js (not ./types.js) — that is
 * where daemon.ts loads it from via loadAgents/validateAgentConfig.
 */
export interface OrchestratorContext {
  config: TmxConfig;
  state: StateManager;
  memoryDb: MemoryDb | null;
  switchboard: Switchboard;
  sdkBridge: SdkBridge | null;
  log: Logger;
  agentConfigs: AgentConfig[];
  /** Broadcast a typed event to all connected WebSocket clients */
  broadcast: (type: string, payload: Record<string, unknown>) => void;
  /** Update switchboard state and persist */
  updateSwitchboard: (patch: Partial<Switchboard>) => Switchboard;
}
