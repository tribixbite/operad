import type { TmxConfig, Switchboard } from "./types.js";
import type { StateManager } from "./state.js";
import type { MemoryDb } from "./memory-db.js";
import type { AgentConfig } from "./agents.js";
import type { SdkBridge } from "./sdk-bridge.js";
import type { Logger } from "./log.js";
import type { ToolExecutor } from "./tools.js";
import type { OodaAction } from "./cognitive.js";

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
  /**
   * Getter for the tool executor — resolved lazily because ToolExecutor is
   * initialized in start() after the constructor builds the context object.
   */
  getToolExecutor: () => ToolExecutor | null;
  /**
   * Delegate for executing parsed OODA actions — remains in Daemon until
   * executeOodaActions and its deep dependencies are fully extracted.
   */
  executeOodaActions: (actions: OodaAction[]) => Promise<void>;
  /**
   * Returns the epoch timestamp (seconds) of the last observed user activity.
   * Used by PersistenceEngine.maybeConsolidate() to compute idle time without
   * holding a direct reference to Daemon's private lastUserActivityEpoch field.
   */
  getLastActivityEpoch: () => number;
}
