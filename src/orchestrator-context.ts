import type { TmxConfig, Switchboard } from "./types.js";
import type { StateManager } from "./state.js";
import type { MemoryDb } from "./memory-db.js";
import type { AgentConfig } from "./agents.js";
import type { SdkBridge } from "./sdk-bridge.js";
import type { Logger } from "./log.js";
import type { ToolExecutor } from "./tools.js";
import type { ToolEngine } from "./tool-engine.js";
import type { ScheduleInput } from "./schedule.js";

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
   * Getter for the tool engine — resolved lazily because ToolEngine is
   * constructed after the context object is built.
   */
  getToolEngine: () => ToolEngine | null;
  /**
   * Upsert a persistent agent schedule via ScheduleEngine.
   * Returns the schedule row ID, or -1 if ScheduleEngine is not yet initialized.
   */
  upsertSchedule: (input: ScheduleInput) => number;
  /**
   * Returns the epoch timestamp (seconds) of the last observed user activity.
   * Used by PersistenceEngine.maybeConsolidate() to compute idle time without
   * holding a direct reference to Daemon's private lastUserActivityEpoch field.
   */
  getLastActivityEpoch: () => number;
  /**
   * Records that a user interaction occurred right now.
   * Called by AgentEngine.handleAgentChat() so idle detection stays accurate
   * without exposing Daemon's private lastUserActivityEpoch field.
   */
  updateLastActivityEpoch: () => void;
  /**
   * Returns whether the named agent is enabled (agent.enabled flag AND
   * switchboard master/per-agent overrides).
   * Provided as a callback so AgentEngine avoids coupling to ServerEngine.
   */
  isAgentEnabled: (agentName: string) => boolean;
  /**
   * Resolve a session's working directory path from config or dynamic registry.
   * Returns null if the session has no associated path.
   * Exposed here so ServerEngine.handleWsMessage() can look up session paths
   * for SDK attach/prompt operations without coupling to Daemon internals.
   */
  resolveSessionPath: (sessionName: string) => string | null;
}
