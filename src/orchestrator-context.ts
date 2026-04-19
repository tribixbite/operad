import type { TmxConfig, Switchboard, IpcResponse } from "./types.js";
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
import type { DashboardServer } from "./http.js";

/**
 * Core shared state — every engine needs these.
 *
 * These are primitive references and utility callbacks that form the minimum
 * dependency surface for any subsystem engine. All fields are references —
 * mutations are visible across the system.
 *
 * NOTE: AgentConfig is sourced from ./agents.js (not ./types.js) — that is
 * where daemon.ts loads it from via loadAgents/validateAgentConfig.
 */
export interface CoreDeps {
  config: TmxConfig;
  state: StateManager;
  /**
   * Lazy getter — memoryDb is initialised in Daemon.startDashboard() after
   * the context object is built. Always call getMemoryDb() at use-time rather
   * than capturing the value at construction time.
   */
  getMemoryDb: () => MemoryDb | null;
  getSwitchboard: () => Switchboard;
  /**
   * Lazy getter — sdkBridge is initialised in Daemon.startDashboard() after
   * the context object is built. Always call getSdkBridge() at use-time rather
   * than capturing the value at construction time.
   */
  getSdkBridge: () => SdkBridge | null;
  log: Logger;
  agentConfigs: AgentConfig[];
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

  /** Broadcast a typed event to all connected WebSocket clients */
  broadcast: (type: string, payload: Record<string, unknown>) => void;
  /**
   * Broadcast a typed event to all connected WebSocket clients.
   * Spreads object fields (like broadcastSwitchboard in Daemon).
   */
  broadcastWs: (type: string, data: unknown) => void;
  /** Update switchboard state and persist */
  updateSwitchboard: (patch: Partial<Switchboard>) => Switchboard;
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
  /**
   * Resolve a fuzzy session name (prefix/substring) to the canonical name.
   * Returns null if no unique match is found.
   */
  resolveName: (input: string) => string | null;
  /** Ensure the IPC socket exists (re-creates if missing) */
  ensureSocket: () => Promise<void>;
  /** Reload agent configs from all sources and update agentConfigs array */
  reloadAgents: () => void;
}

/**
 * Lazy getters for subsystems built post-construction.
 *
 * These getters exist because the referenced subsystems (ToolExecutor,
 * ToolEngine, TelemetrySinkServer, DashboardServer, ScheduleEngine) are
 * initialized in Daemon.start() after the context object is built. Callers
 * should always handle the null case (subsystem not yet initialised).
 */
export interface LazyEngineAccess {
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
  /** TelemetrySinkServer instance, or null if not initialized */
  getTelemetrySink: () => TelemetrySinkServer | null;
  /** DashboardServer instance, or null if not initialized */
  getDashboard: () => DashboardServer | null;
  /** ScheduleEngine instance, or null if not initialized */
  getScheduleEngine: () => ScheduleEngine | null;
  /**
   * Upsert a persistent agent schedule via ScheduleEngine.
   * Returns the schedule row ID, or -1 if ScheduleEngine is not yet initialized.
   */
  upsertSchedule: (input: ScheduleInput) => number;
}

/**
 * Session lifecycle control — higher-level than per-cmd delegates.
 *
 * These callbacks drive session and daemon lifecycle transitions. They are
 * separate from the cmd* delegates because they are also called internally
 * (e.g. boot is called at daemon startup, not only in response to IPC).
 */
export interface SessionLifecycleDeps {
  /** Trigger the full boot sequence (async — fire and forget in IPC handler) */
  boot: () => Promise<void>;
  /** Initiate daemon shutdown; exits the process when complete */
  shutdown: (kill?: boolean) => Promise<void>;
  /**
   * Start a single session by name.
   * Returns true if the session started successfully.
   * Exposed here so SessionCommands can drive session lifecycle without
   * coupling to Daemon internals.
   */
  startSession: (name: string) => Promise<boolean>;
  /**
   * Stop a single session by name.
   * Returns true if the session stopped (or was already stopped).
   */
  stopSessionByName: (name: string) => Promise<boolean>;
  /**
   * Start all enabled sessions in dependency order.
   * Used by cmdStart (no-arg) and cmdRestart (no-arg).
   */
  startAllSessions: () => Promise<void>;
}

/**
 * IPC command delegates — one per IPC command case.
 *
 * Each callback wraps a Daemon cmd* method so ServerEngine can dispatch IPC
 * commands without coupling to Daemon internals. The cmd* methods remain in
 * Daemon because the REST API handler also calls them directly.
 */
export interface CmdDelegates {
  cmdStatus: (name?: string) => IpcResponse;
  cmdStart: (name?: string) => Promise<IpcResponse>;
  cmdStop: (name?: string) => Promise<IpcResponse>;
  cmdRestart: (name?: string) => Promise<IpcResponse>;
  cmdHealth: () => IpcResponse;
  cmdMemory: () => IpcResponse;
  cmdGo: (name: string) => Promise<IpcResponse>;
  cmdSend: (name: string, text: string) => IpcResponse;
  cmdTabs: (names?: string[]) => IpcResponse;
  cmdOpen: (path: string, name?: string, autoGo?: boolean, priority?: number) => Promise<IpcResponse>;
  cmdClose: (name: string) => Promise<IpcResponse>;
  cmdRecent: (count?: number) => IpcResponse;
  cmdSuspend: (name: string) => IpcResponse;
  cmdResume: (name: string) => IpcResponse;
  cmdSuspendOthers: (name: string) => IpcResponse;
  cmdSuspendAll: () => IpcResponse;
  cmdResumeAll: () => IpcResponse;
  cmdRegister: (scanPath?: string) => IpcResponse;
  cmdClone: (url: string, name?: string) => IpcResponse;
  cmdCreate: (name: string) => IpcResponse;
}

/**
 * Android-specific callbacks — only meaningful on the android platform.
 *
 * These are segregated because they pollute the otherwise platform-neutral
 * OrchestratorContext. On non-Android platforms the implementations are
 * no-ops or return empty results. Future work: move callers to check
 * platform before calling, then accept a narrower interface.
 */
export interface AndroidCallbacks {
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

/**
 * Monitoring push callbacks — used by SessionCommands after mutations.
 *
 * Exposed as callbacks so SessionCommands can trigger UI refresh after
 * lifecycle mutations without coupling directly to MonitoringEngine.
 */
export interface MonitoringCallbacks {
  /**
   * Push the current daemon state to all SSE subscribers.
   * Exposed as a callback so SessionCommands can trigger a refresh after
   * lifecycle mutations without coupling directly to MonitoringEngine.
   */
  pushSseState: () => void;
  /** Update the persistent system-bar notification (Termux only — no-op elsewhere). */
  updateStatusNotification: () => void;
}

/**
 * Full orchestrator dependency context — union of all sub-interfaces.
 *
 * Consumers still receive one `OrchestratorContext` — no code changes to
 * existing engines are needed. The sub-interface split is organisational:
 * it documents the layered contract and allows future callers to type their
 * parameters narrower (e.g. `fn(ctx: CoreDeps)`) without breaking anything.
 *
 * Sub-interface summary:
 * - {@link CoreDeps}             — primitive state + utility callbacks, needed by every engine
 * - {@link LazyEngineAccess}     — getters for subsystems built after construction
 * - {@link SessionLifecycleDeps} — high-level lifecycle control (boot/shutdown/start/stop)
 * - {@link CmdDelegates}         — one delegate per IPC command case
 * - {@link AndroidCallbacks}     — ADB/Android-specific callbacks (no-op on other platforms)
 * - {@link MonitoringCallbacks}  — SSE + notification refresh callbacks
 */
export interface OrchestratorContext extends
  CoreDeps,
  LazyEngineAccess,
  SessionLifecycleDeps,
  CmdDelegates,
  AndroidCallbacks,
  MonitoringCallbacks
{}
