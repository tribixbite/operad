import type { TmxConfig, Switchboard } from "./types.js";
import type { StateManager } from "./state.js";
import type { MemoryDb } from "./memory-db.js";
import type { AgentConfig } from "./agents.js";
import type { SdkBridge } from "./sdk-bridge.js";
import type { Logger } from "./log.js";
import type { ToolExecutor } from "./tools.js";
import type { ToolEngine } from "./tool-engine.js";
import type { ScheduleInput, ScheduleEngine } from "./schedule.js";
import type { BudgetTracker } from "./budget.js";
import type { WakeLockManager } from "./wake.js";
import type { MemoryMonitor } from "./memory.js";
import type { Registry } from "./registry.js";
import type { TelemetrySinkServer } from "./telemetry-sink.js";

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
  getSwitchboard: () => Switchboard;
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

  // -- IPC command callbacks (for ServerEngine.handleIpcCommand) ---------------
  //
  // Each callback wraps a Daemon cmd* method so ServerEngine can dispatch IPC
  // commands without coupling to Daemon internals. The cmd* methods remain in
  // Daemon because the REST API handler also calls them directly.

  /** Dynamic session registry — shared reference, mutations are visible system-wide */
  registry: Registry;
  /** Android phantom process budget tracker */
  budget: BudgetTracker;
  /** Wake lock manager */
  wake: WakeLockManager;
  /** System memory monitor */
  systemMemory: MemoryMonitor;
  /** Map of session name → adopted PID for sessions found on daemon start */
  adoptedPids: Map<string, number>;

  /** Trigger the full boot sequence (async — fire and forget in IPC handler) */
  boot: () => Promise<void>;
  /** Initiate daemon shutdown; exits the process when complete */
  shutdown: (kill?: boolean) => Promise<void>;

  // cmd* delegates — one per IPC command case
  cmdStatus: (name?: string) => import("./types.js").IpcResponse;
  cmdStart: (name?: string) => Promise<import("./types.js").IpcResponse>;
  cmdStop: (name?: string) => Promise<import("./types.js").IpcResponse>;
  cmdRestart: (name?: string) => Promise<import("./types.js").IpcResponse>;
  cmdHealth: () => import("./types.js").IpcResponse;
  cmdMemory: () => import("./types.js").IpcResponse;
  cmdGo: (name: string) => Promise<import("./types.js").IpcResponse>;
  cmdSend: (name: string, text: string) => import("./types.js").IpcResponse;
  cmdTabs: (names?: string[]) => import("./types.js").IpcResponse;
  cmdOpen: (path: string, name?: string, autoGo?: boolean, priority?: number) => Promise<import("./types.js").IpcResponse>;
  cmdClose: (name: string) => Promise<import("./types.js").IpcResponse>;
  cmdRecent: (count?: number) => import("./types.js").IpcResponse;
  cmdSuspend: (name: string) => import("./types.js").IpcResponse;
  cmdResume: (name: string) => import("./types.js").IpcResponse;
  cmdSuspendOthers: (name: string) => import("./types.js").IpcResponse;
  cmdSuspendAll: () => import("./types.js").IpcResponse;
  cmdResumeAll: () => import("./types.js").IpcResponse;
  cmdRegister: (scanPath?: string) => import("./types.js").IpcResponse;
  cmdClone: (url: string, name?: string) => import("./types.js").IpcResponse;
  cmdCreate: (name: string) => import("./types.js").IpcResponse;

  // -- Additional callbacks for REST route handlers (ServerEngine.handleDashboardApi) -

  /** TelemetrySinkServer instance, or null if not initialized */
  getTelemetrySink: () => TelemetrySinkServer | null;
  /** ScheduleEngine instance, or null if not initialized */
  getScheduleEngine: () => ScheduleEngine | null;
  /**
   * Broadcast a typed event to all connected WebSocket clients.
   * Spreads object fields (like broadcastSwitchboard in Daemon).
   */
  broadcastWs: (type: string, data: unknown) => void;
  /** Ensure the IPC socket exists (re-creates if missing) */
  ensureSocket: () => Promise<void>;
  /** Reload agent configs from all sources and update agentConfigs array */
  reloadAgents: () => void;
  /**
   * Resolve a fuzzy session name (prefix/substring) to the canonical name.
   * Returns null if no unique match is found.
   */
  resolveName: (input: string) => string | null;
  /** List Android apps with their RSS (via ADB) */
  getAndroidApps: () => { pkg: string; label: string; rss_mb: number; system: boolean; autostop: boolean }[];
  /** Force-stop an Android app by package name via ADB */
  forceStopApp: (pkg: string) => { status: number; data: unknown };
  /** Get the current auto-stop package list */
  getAutoStopList: () => { packages: string[] };
  /** Toggle auto-stop for a package, persisting to disk */
  toggleAutoStop: (pkg: string) => { status: number; data: unknown };
  /** Invalidate the cached ADB serial (call after connect/disconnect) */
  invalidateAdbSerial: () => void;
}
