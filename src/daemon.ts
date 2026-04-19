/**
 * daemon.ts — Main orchestrator daemon
 *
 * Owns the full lifecycle: config validation, dependency-ordered startup,
 * health monitoring, process budget tracking, wake lock management,
 * auto-restart with backoff, session adoption, and graceful shutdown.
 *
 * Runs as a long-lived foreground process, protected by a bash watchdog
 * loop to survive OOM kills.
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, appendFileSync, writeFileSync, readFileSync, chmodSync, readdirSync, statSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TmxConfig, IpcCommand, IpcResponse, SessionConfig, SessionStatus, Switchboard } from "./types.js";
import { defaultSwitchboard } from "./types.js";
import { loadConfig } from "./config.js";
import { detectPlatform } from "./platform/platform.js";
import { Logger } from "./log.js";
import { StateManager, migrateState } from "./state.js";
import { IpcServer } from "./ipc.js";
import { BudgetTracker } from "./budget.js";
import { WakeLockManager } from "./wake.js";
import { computeStartupOrder, computeShutdownOrder } from "./deps.js";
import { runHealthSweep } from "./health.js";
import { MemoryMonitor } from "./memory.js";
import { ActivityDetector } from "./activity.js";
import { BatteryMonitor } from "./battery.js";
import { Registry } from "./registry.js";
import { DashboardServer } from "./http.js";
import { TelemetrySinkServer } from "./telemetry-sink.js";
import { SdkBridge } from "./sdk-bridge.js";
import { MemoryDb } from "./memory-db.js";
import { saveMemoriesFromResponse } from "./memory-injector.js";
import { validateAgentConfig, saveUserAgent, deleteUserAgent, type AgentConfig } from "./agents.js";
import { ToolExecutor, type ToolContext, type ToolCategory } from "./tools.js";
import { ScheduleEngine } from "./schedule.js";
import {
  exportAgentState, importAgentState, serializeBundle, deserializeBundle,
  saveSnapshot, pruneSnapshots, listSnapshots,
  type AgentStateBundle, type ImportOptions,
} from "./agent-state.js";
import {
  runConsolidation,
  getLastConsolidationTime, getConsolidationHistory,
} from "./consolidation.js";
import {
  getProjectTokenUsage,
  getConversationPage,
  readTimeline,
  resolveJsonlFiles,
  resolveActiveJsonl,
  getConversationDelta,
  getDailyCostTimeline,
} from "./claude-session.js";
import {
  searchPrompts,
  starPrompt,
  unstarPrompt,
  getPromptProjects,
} from "./prompts.js";
import {
  appendNotification,
  readNotifications,
} from "./notifications.js";
import {
  getGitInfo,
  getFileTree,
  getFileContent,
} from "./git-info.js";
import {
  createSession,
  listTmuxSessions,
  sendGoToSession,
  waitForClaudeReady,
  stopSession,
  isTmuxServerAlive,
  discoverBareClaudeSessions,
  spawnBareProcess,
  findBareServicePid,
  ensureTmuxLdPreload,
  bringTermuxToForeground,
  suspendSession,
  resumeSession,
  runScriptInTab,
  capturePane,
} from "./session.js";
import { AgentEngine } from "./agent-engine.js";
import { ToolEngine } from "./tool-engine.js";
import { PersistenceEngine } from "./persistence.js";
import { WsHandler } from "./ws-handler.js";
import { IpcHandler } from "./ipc-handler.js";
import { RestHandler } from "./rest-handler.js";
import { AndroidEngine } from "./android-engine.js";
import { MonitoringEngine } from "./monitoring-engine.js";
import { SessionCommands } from "./session-commands.js";
import { resolveSessionName, resolveSessionPath as resolveSessionPathFn, resolveBootSessions } from "./session-resolver.js";
import type { OrchestratorContext } from "./orchestrator-context.js";

/** Pattern indicating Claude Code is actively processing (not waiting for input).
 * "esc to interrupt" appears in the status bar only when Claude is mid-task. */
const CLAUDE_WORKING_PATTERN = /esc to interrupt/;

/** Strip ANSI escape sequences */
/**
 * Portable bash shebang line.
 * On Termux, /usr/bin/env doesn't exist — use $PREFIX/bin/bash directly.
 * LD_PRELOAD (libtermux-exec) handles this rewriting inside tmux, but
 * scripts launched via TermuxService intents run in fresh shells without it.
 */
/** Promise-based sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Crash-safe diagnostic trace — appends a line and immediately closes the FD.
 * If the daemon gets SIGKILL'd, the last trace line shows what it was doing.
 * Uses appendFileSync so each write is atomic (no open FD left dangling).
 */
const TRACE_PATH = join(
  detectPlatform().defaultLogDir(),
  "trace.log",
);
function trace(msg: string): void {
  try {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    appendFileSync(TRACE_PATH, `${ts} ${msg}\n`);
  } catch {
    // Non-fatal — trace is best-effort
  }
}

/**
 * Send a notification via platform abstraction (non-blocking).
 * Pass an id to update an existing notification in place (prevents spam).
 */
function notify(title: string, content: string, id?: string): void {
  detectPlatform().notify(title, content, id);
}

/** Send a notification with arbitrary extra args via platform (non-blocking) */
function notifyWithArgs(args: string[]): void {
  detectPlatform().notifyWithArgs(args);
}

/** Remove a notification by ID via platform (non-blocking) */
function removeNotification(id: string): void {
  detectPlatform().removeNotification(id);
}

export class Daemon {
  private config: TmxConfig;
  private log: Logger;
  private agentEngine!: AgentEngine;
  private toolEngine!: ToolEngine;
  private persistenceEngine!: PersistenceEngine;
  private wsHandler!: WsHandler;
  private ipcHandler!: IpcHandler;
  private restHandler!: RestHandler;
  private androidEngine!: AndroidEngine;
  private monitoringEngine!: MonitoringEngine;
  private sessionCommands!: SessionCommands;
  private state: StateManager;
  private ipc: IpcServer;
  private budget: BudgetTracker;
  private wake: WakeLockManager;
  private memory: MemoryMonitor;
  private activity: ActivityDetector;
  private battery: BatteryMonitor;
  private registry: Registry;
  private dashboard: DashboardServer | null = null;
  private telemetrySink: TelemetrySinkServer | null = null;
  private sdkBridge: SdkBridge | null = null;
  private memoryDb: MemoryDb | null = null;
  private toolExecutor: ToolExecutor | null = null;
  private scheduleEngine: ScheduleEngine | null = null;
  private lastUserActivityEpoch: number = Math.floor(Date.now() / 1000);
  private agentConfigs: AgentConfig[] = [];
  /** Master switchboard — controls subsystem enable/disable */
  private switchboard: Switchboard = defaultSwitchboard();
  /** Timer for periodic OODA loop evaluation */
  private cognitiveTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private registryFlushTimer: ReturnType<typeof setInterval> | null = null;
  /** Pending auto-restart timers — tracked so shutdown() can cancel them */
  private restartTimers = new Set<ReturnType<typeof setTimeout>>();
  private autoTabsTimer: ReturnType<typeof setTimeout> | null = null;
  /** PIDs of adopted bare (non-tmux) Claude sessions, keyed by session name */
  private adoptedPids = new Map<string, number>();
  private running = false;
  /** Resolved when shutdown() completes — replaces 1s polling interval */
  private shutdownResolve: (() => void) | null = null;
  constructor(configPath?: string) {
    this.config = loadConfig(configPath);
    this.log = new Logger(this.config.orchestrator.log_dir);
    this.state = new StateManager(this.config.orchestrator.state_file, this.log);
    // Run state schema migrations on every boot — no-op if already at current version.
    // migrateState mutates the raw state object; flush() persists the updated schemaVersion.
    {
      const { notice } = migrateState(this.state.getState());
      if (notice) {
        this.log.info(`[state migration] ${notice}`);
        this.state.flush();
      }
    }
    // Restore switchboard from persisted state, fallback to defaults
    this.switchboard = { ...defaultSwitchboard(), ...this.state.getState().switchboard };
    this.budget = new BudgetTracker(this.config.orchestrator.process_budget, this.log);
    this.wake = new WakeLockManager(this.config.orchestrator.wake_lock_policy, this.log);
    // Acquire wake lock immediately — never release it. Android kills
    // background processes when wake lock is dropped.
    this.wake.acquire();
    this.memory = new MemoryMonitor(
      this.log,
      this.config.orchestrator.memory_warning_mb,
      this.config.orchestrator.memory_critical_mb,
      this.config.orchestrator.memory_emergency_mb,
    );
    this.activity = new ActivityDetector(this.log);
    this.battery = new BatteryMonitor(this.log, this.config.battery.low_threshold_pct);

    // Load dynamic session registry
    const registryPath = join(dirname(this.config.orchestrator.state_file), "registry.json");
    this.registry = new Registry(registryPath);

    // Auto-stop package list is loaded after AndroidEngine is constructed below.

    // Wire up IPC handler — delegates to ipcHandler once it's constructed below.
    // Use a late-binding lambda so this.ipcHandler is available after construction.
    this.ipc = new IpcServer(
      this.config.orchestrator.socket,
      (cmd) => this.ipcHandler.handleIpcCommand(cmd),
      this.log,
    );

    // AgentEngine injection point — extraction target for agent/OODA logic.
    // Built late in constructor so all dependencies are available.
    const ctx: OrchestratorContext = {
      config: this.config,
      state: this.state,
      memoryDb: this.memoryDb ?? null,
      getSwitchboard: () => this.switchboard,
      sdkBridge: this.sdkBridge ?? null,
      log: this.log,
      agentConfigs: this.agentConfigs ?? [],
      broadcast: (type, payload) => this.broadcastSwitchboard(type, payload),
      updateSwitchboard: (patch) => this.updateSwitchboard(patch),
      // Lazy getter — toolExecutor is null at construction time, set in start()
      getToolExecutor: () => this.toolExecutor,
      // Lazy getter — toolEngine is constructed just below this block
      getToolEngine: () => this.toolEngine,
      // Delegate for persistent schedule upsert — ScheduleEngine may not exist yet at boot
      upsertSchedule: (input) => this.scheduleEngine ? this.scheduleEngine.upsert(input) : -1,
      // Getter so PersistenceEngine can compute idle time without holding a direct ref
      getLastActivityEpoch: () => this.lastUserActivityEpoch,
      // Setter used by AgentEngine.handleAgentChat to track user activity epoch
      updateLastActivityEpoch: () => { this.lastUserActivityEpoch = Math.floor(Date.now() / 1000); },
      // Predicate used by AgentEngine; mirrors Daemon/ServerEngine isAgentEnabled logic
      isAgentEnabled: (agentName: string) => {
        const sb = this.switchboard;
        if (!sb.all) return false;
        const ac = this.agentConfigs.find((a) => a.name === agentName);
        if (!ac || !ac.enabled) return false;
        const sw = sb.agents[agentName];
        if (sw === false) return false;
        return true;
      },
      // Exposed so ServerEngine.handleWsMessage can look up session paths for
      // SDK attach/prompt operations without coupling to Daemon internals.
      resolveSessionPath: (sessionName: string) => this.resolveSessionPath(sessionName),
      // -- IPC command callbacks (for ServerEngine.handleIpcCommand) -----------
      // Shared references for non-method state accessed by IPC commands
      registry: this.registry,
      budget: this.budget,
      wake: this.wake,
      systemMemory: this.memory,
      adoptedPids: this.adoptedPids,
      // Lifecycle callbacks for stream/shutdown cases handled inline in ServerEngine
      boot: () => this.boot(),
      shutdown: (kill) => this.shutdown(kill),
      // Session lifecycle callbacks — exposed so SessionCommands can drive
      // start/stop without coupling to Daemon internals.
      startSession: (name) => this.startSession(name),
      stopSessionByName: (name) => this.stopSessionByName(name),
      startAllSessions: () => this.startAllSessions().then(() => undefined),
      // cmd* delegates — late-binding through SessionCommands (constructed just below).
      // Each lambda captures `this` so sessionCommands is resolved at call time,
      // not at ctx construction time.
      cmdStatus: (name) => this.sessionCommands.cmdStatus(name),
      cmdStart: (name) => this.sessionCommands.cmdStart(name),
      cmdStop: (name) => this.sessionCommands.cmdStop(name),
      cmdRestart: (name) => this.sessionCommands.cmdRestart(name),
      cmdHealth: () => this.sessionCommands.cmdHealth(),
      cmdMemory: () => this.sessionCommands.cmdMemory(),
      cmdGo: (name) => this.sessionCommands.cmdGo(name),
      cmdSend: (name, text) => this.sessionCommands.cmdSend(name, text),
      cmdTabs: (names) => this.sessionCommands.cmdTabs(names),
      cmdOpen: (path, name, autoGo, priority) => this.sessionCommands.cmdOpen(path, name, autoGo, priority),
      cmdClose: (name) => this.sessionCommands.cmdClose(name),
      cmdRecent: (count) => this.sessionCommands.cmdRecent(count),
      cmdSuspend: (name) => this.sessionCommands.cmdSuspend(name),
      cmdResume: (name) => this.sessionCommands.cmdResume(name),
      cmdSuspendOthers: (name) => this.sessionCommands.cmdSuspendOthers(name),
      cmdSuspendAll: () => this.sessionCommands.cmdSuspendAll(),
      cmdResumeAll: () => this.sessionCommands.cmdResumeAll(),
      cmdRegister: (scanPath) => this.sessionCommands.cmdRegister(scanPath),
      cmdClone: (url, name) => this.sessionCommands.cmdClone(url, name),
      cmdCreate: (name) => this.sessionCommands.cmdCreate(name),
      // -- REST route handler callbacks (for ServerEngine.handleDashboardApi) ---
      getTelemetrySink: () => this.telemetrySink,
      getDashboard: () => this.dashboard,
      getScheduleEngine: () => this.scheduleEngine,
      broadcastWs: (type, data) => this.broadcastSwitchboard(type, data),
      ensureSocket: () => this.ensureSocket(),
      reloadAgents: () => this.reloadAgents(),
      resolveName: (input) => this.resolveName(input),
      getAndroidApps: () => this.androidEngine.getAndroidApps(),
      forceStopApp: (pkg) => this.androidEngine.forceStopApp(pkg),
      getAutoStopList: () => this.androidEngine.getAutoStopList(),
      toggleAutoStop: (pkg) => this.androidEngine.toggleAutoStop(pkg),
      invalidateAdbSerial: () => this.androidEngine.invalidateAdbSerial(),
      pushSseState: () => this.monitoringEngine.pushSseState(),
      updateStatusNotification: () => this.monitoringEngine.updateStatusNotification(),
    };
    this.agentEngine = new AgentEngine(ctx);
    // ToolEngine reuses the same OrchestratorContext — no extra wiring needed.
    this.toolEngine = new ToolEngine(ctx);
    // PersistenceEngine owns daily snapshots and will absorb more persistence
    // concerns incrementally as daemon.ts dependencies are disentangled.
    this.persistenceEngine = new PersistenceEngine(ctx);
    // Transport handlers split by responsibility (WS / IPC / REST).
    this.wsHandler = new WsHandler(ctx, this.agentEngine);
    this.ipcHandler = new IpcHandler(ctx);
    this.restHandler = new RestHandler(ctx, this.agentEngine, this.toolEngine);
    // AndroidEngine owns ADB serial/fix/phantom budget + auto-stop list + app mgmt.
    this.androidEngine = new AndroidEngine(ctx);
    // Load auto-stop package list now that AndroidEngine exists
    this.androidEngine.loadAutoStopList();
    // MonitoringEngine owns memory/battery polling, SSE push, conversation deltas,
    // and Android status notification. Constructed after AndroidEngine so it can
    // call androidEngine.autoStopFlaggedApps() on memory pressure.
    this.monitoringEngine = new MonitoringEngine(ctx, this.memory, this.activity, this.battery, this.androidEngine);
    // SessionCommands holds all cmd* IPC/REST command handlers extracted from Daemon.
    // Constructed after MonitoringEngine since it needs it for SSE push on suspend/resume.
    this.sessionCommands = new SessionCommands(ctx);
  }

  /**
   * Pre-flight checks — ensure required directories exist and config is sane.
   * Called at the top of start() so the daemon crashes early with a clear message
   * rather than failing mysteriously later.
   */
  private preflight(): void {
    const { log_dir, state_file, socket } = this.config.orchestrator;

    // Ensure log directory exists
    if (!existsSync(log_dir)) {
      mkdirSync(log_dir, { recursive: true });
      this.log.debug(`Created log directory: ${log_dir}`);
    }

    // Ensure state file parent directory exists
    const stateDir = dirname(state_file);
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
      this.log.debug(`Created state directory: ${stateDir}`);
    }

    // Ensure socket parent directory exists
    const socketDir = dirname(socket);
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true });
      this.log.debug(`Created socket directory: ${socketDir}`);
    }

    // Validate session count vs budget
    const enabledCount = this.config.sessions.filter((s) => s.enabled).length;
    if (enabledCount === 0) {
      this.log.warn("No enabled sessions in config");
    }

    // Fail fast if tmux is unusable. Sessions silently fail otherwise — the
    // daemon keeps running, the dashboard appears healthy, but no session
    // ever boots. Better to crash with a clear install hint.
    const tmuxCheck = spawnSync("tmux", ["-V"], { timeout: 3000, stdio: "pipe" });
    if (tmuxCheck.error || tmuxCheck.status !== 0) {
      const msg = "tmux is required but not available on PATH. Install:\n" +
        "  Linux:    apt install tmux  /  pacman -S tmux\n" +
        "  macOS:    brew install tmux\n" +
        "  Termux:   pkg install tmux\n" +
        "  Windows:  install MSYS2 (https://msys2.org), then `pacman -S tmux`\n" +
        "Run 'operad doctor' for full diagnostics.";
      this.log.error(msg);
      throw new Error("tmux not available — cannot start daemon");
    }
  }

  /** Start the daemon — main entry point */
  async start(): Promise<void> {
    trace("daemon:start");
    this.preflight();

    // Kill stale termux-api processes and zombies from previous daemon instances.
    // When daemon gets SIGKILL'd by Android OOM killer, no cleanup handler fires,
    // leaving orphaned termux-api processes that pile up across restarts.
    const staleKilled = detectPlatform().killStaleNotifyProcesses();
    if (staleKilled > 0) {
      trace(`startup:cleanup killed ${staleKilled} stale processes`);
    }

    this.running = true;
    this.log.info("Daemon starting", {
      sessions: this.config.sessions.length,
      budget: this.config.orchestrator.process_budget,
      wake_policy: this.config.orchestrator.wake_lock_policy,
    });

    // Initialize state from config + registry
    this.state.resetDaemonStart();
    this.mergeRegistrySessions();
    this.state.initFromConfig(this.config.sessions);

    // Inject LD_PRELOAD into tmux global env for termux-exec
    // (bun's glibc-runner strips it; without it /usr/bin/env fails)
    ensureTmuxLdPreload(this.log);

    // Adopt existing tmux sessions
    this.adoptExistingSessions();

    // Start IPC server
    await this.ipc.start();

    // Set up signal handlers
    this.setupSignalHandlers();

    // Start health check timer
    this.startHealthTimer();

    // Start memory monitoring timer (every 5s)
    this.monitoringEngine.startMemoryTimer();

    // Start battery monitoring timer
    this.monitoringEngine.startBatteryTimer();

    // Periodically flush registry activity timestamps (every 5 min)
    // Prevents data loss if daemon is SIGKILL'd between updateActivity calls
    this.registryFlushTimer = setInterval(() => {
      this.registry.flush();
    }, 5 * 60 * 1000);

    // Start HTTP dashboard if configured
    await this.startDashboard();

    // Start telemetry sink if enabled
    await this.startTelemetrySink();

    notify("operad", "Orchestrator started");

    // Keep process alive until shutdown() resolves the promise
    await new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
    });
  }

  /** Full boot sequence: ADB fix → dependency-ordered start → cron */
  async boot(): Promise<void> {
    trace("boot:start");
    this.log.info("Boot sequence starting");
    this.wake.evaluate("boot_start");

    const bootDeadline = Date.now() + this.config.orchestrator.boot_timeout_s * 1000;

    // Step 1: ADB fix (with boot delay on first boot for wireless debugging to initialize)
    if (this.config.adb.enabled) {
      if (!this.state.getState().boot_complete && this.config.adb.boot_delay_s > 0) {
        this.log.info(`Waiting ${this.config.adb.boot_delay_s}s for wireless debugging to initialize`);
        await sleep(this.config.adb.boot_delay_s * 1000);
      }
      await this.androidEngine.fixAdb();
    }

    // Step 2: Resolve which Claude sessions to start based on recency
    this.resolveBootSessions();

    // Step 3: Start sessions in dependency order (with boot timeout)
    const timedOut = await this.startAllSessions(bootDeadline);

    // Step 4: Start cron daemon if not running
    this.startCron();

    // Step 5: Restore Termux tabs for non-headless running sessions.
    // Uses TermuxService service_execute intent to create real Termux tabs
    // that attach to tmux sessions. Brief delay to let sessions stabilize.
    this.autoTabsTimer = setTimeout(() => {
      this.autoTabsTimer = null;
      try {
        const tabResult = this.sessionCommands.cmdTabs();
        if (tabResult.ok) {
          const data = tabResult.data as { restored: number; skipped: number };
          this.log.info(`Auto-tabs: restored=${data.restored} skipped=${data.skipped}`);
        }
      } catch (err) {
        this.log.warn(`Auto-tabs failed: ${err}`);
      }
    }, 3000);

    // Step 6: Mark boot complete
    this.state.setBootComplete(true);
    this.wake.evaluate("boot_end", this.state.getState().sessions);

    const sessionCount = this.config.sessions.filter((s) => s.enabled).length;
    const runningCount = Object.values(this.state.getState().sessions)
      .filter((s) => s.status === "running").length;

    if (timedOut) {
      this.log.warn(`Boot timed out after ${this.config.orchestrator.boot_timeout_s}s: ${runningCount}/${sessionCount} sessions running`);
      notify("operad boot", `Timed out: ${runningCount}/${sessionCount} sessions`, "operad-boot");
    } else {
      this.log.info(`Boot complete: ${runningCount}/${sessionCount} sessions running`);
      notify("operad boot", `${runningCount}/${sessionCount} sessions running`, "operad-boot");
      appendNotification({ type: "daemon_start", title: "Daemon started", content: `${runningCount}/${sessionCount} sessions running` });
    }

    // Initial persistent status notification
    this.monitoringEngine.updateStatusNotification();
  }

  /**
   * Graceful shutdown — detach from sessions, release resources, exit.
   * By default, tmux sessions are LEFT RUNNING so the next daemon can adopt them.
   * Pass killSessions=true only for explicit `operad shutdown --kill`.
   */
  private shutdownInProgress = false;
  async shutdown(killSessions = false): Promise<void> {
    if (this.shutdownInProgress) return;
    this.shutdownInProgress = true;
    trace("shutdown:start");
    this.log.info("Shutdown sequence starting");

    // Stop health checks and memory/battery monitoring
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.monitoringEngine.stopTimers();
    this.androidEngine.stopRetryTimer();
    if (this.registryFlushTimer) {
      clearInterval(this.registryFlushTimer);
      this.registryFlushTimer = null;
    }
    if (this.cognitiveTimer) {
      clearInterval(this.cognitiveTimer);
      this.cognitiveTimer = null;
    }
    // Clear OODA-scheduled timer — now owned by AgentEngine
    this.agentEngine?.clearScheduledOodaTimer();
    if (this.scheduleEngine) {
      this.scheduleEngine.stop();
      this.scheduleEngine = null;
    }

    // Cancel pending auto-tabs and auto-restart timers
    if (this.autoTabsTimer) {
      clearTimeout(this.autoTabsTimer);
      this.autoTabsTimer = null;
    }
    for (const timer of this.restartTimers) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();

    if (killSessions) {
      // Only kill tmux sessions when explicitly requested (operad shutdown --kill)
      this.log.info("Killing all tmux sessions (--kill requested)");
      const shutdownOrder = computeShutdownOrder(this.config.sessions);
      for (const batch of shutdownOrder) {
        const stopPromises = batch.sessions.map(async (name) => {
          const s = this.state.getSession(name);
          if (!s || s.status === "stopped" || s.status === "pending") return;
          this.state.transition(name, "stopping");
          await stopSession(name, this.log);
          this.state.transition(name, "stopped");
        });
        await Promise.all(stopPromises);
      }
    } else {
      // Default: orphan sessions for next daemon to adopt
      this.log.info("Detaching from sessions (tmux sessions left running for adoption)");
    }

    // Flush registry with final activity timestamps
    this.registry.flush();

    // Wake lock intentionally NOT released — Android kills processes without it

    // Detach SDK bridge
    if (this.sdkBridge?.isAttached) {
      await this.sdkBridge.detach();
    }
    this.sdkBridge = null;

    // Close memory database
    if (this.memoryDb) {
      this.memoryDb.close();
      this.memoryDb = null;
    }

    // Stop telemetry sink
    if (this.telemetrySink) {
      this.telemetrySink.stop();
      this.telemetrySink = null;
    }

    // Stop dashboard server
    if (this.dashboard) {
      this.dashboard.stop();
      this.dashboard = null;
    }

    // Stop IPC server
    this.ipc.stop();

    // Remove persistent notifications
    removeNotification("operad-status");
    removeNotification("operad-boot");
    removeNotification("operad-memory");
    // Clean up failure notifications
    for (const session of this.config.sessions) {
      removeNotification(`operad-fail-${session.name}`);
    }

    // Kill any tracked termux-api notification processes to prevent
    // orphaned process pile-up after daemon exit
    detectPlatform().killTrackedNotifyProcesses();

    this.running = false;
    this.shutdownResolve?.();
    this.log.info("Shutdown complete");
    notify("operad", "Orchestrator stopped");
    appendNotification({ type: "daemon_stop", title: "Daemon stopped", content: "Graceful shutdown" });
  }

  // -- Session management -----------------------------------------------------

  /**
   * Start all enabled sessions in dependency order.
   * Returns true if boot_timeout_s was exceeded (remaining sessions skipped).
   */
  private async startAllSessions(deadline: number = Infinity): Promise<boolean> {
    const batches = computeStartupOrder(this.config.sessions);

    for (const batch of batches) {
      // Check boot timeout before each batch
      if (Date.now() >= deadline) {
        this.log.warn(`Boot timeout reached, skipping batch depth=${batch.depth}: ${batch.sessions.join(", ")}`);
        for (const name of batch.sessions) {
          const s = this.state.getSession(name);
          if (s && (s.status === "pending" || s.status === "waiting")) {
            this.state.transition(name, "failed", "Boot timeout exceeded");
          }
        }
        return true;
      }

      this.log.info(`Starting batch depth=${batch.depth}: ${batch.sessions.join(", ")}`);

      // Start all sessions in this batch in parallel
      const startPromises = batch.sessions.map((name) => this.startSession(name));
      await Promise.all(startPromises);

      // Brief pause between batches for stability
      await sleep(500);
    }

    // Retry sessions stuck in "waiting" whose dependencies are now satisfied.
    // This handles the case where a batch completes but deps within the same
    // batch weren't "running" yet when the dependent was first evaluated.
    const maxRetries = 3;
    for (let retry = 0; retry < maxRetries; retry++) {
      const waitingSessions = this.config.sessions.filter((s) => {
        const state = this.state.getSession(s.name);
        return state?.status === "waiting" && s.enabled;
      });

      if (waitingSessions.length === 0) break;
      if (Date.now() >= deadline) break;

      this.log.info(`Retrying ${waitingSessions.length} waiting sessions (attempt ${retry + 1}/${maxRetries})`);
      await sleep(1000); // Give recently-started sessions time to reach "running"

      const retryPromises = waitingSessions.map((s) => this.startSession(s.name));
      await Promise.all(retryPromises);

      // Check if any are still waiting
      const stillWaiting = waitingSessions.filter((s) => {
        const state = this.state.getSession(s.name);
        return state?.status === "waiting";
      });
      if (stillWaiting.length === 0) break;
    }

    return false;
  }

  /** Start a single session by name */
  private async startSession(name: string): Promise<boolean> {
    trace(`session:start:${name}`);
    const sessionConfig = this.config.sessions.find((s) => s.name === name);
    if (!sessionConfig) {
      this.log.error(`Unknown session '${name}'`);
      return false;
    }

    if (!sessionConfig.enabled) {
      this.log.debug(`Session '${name}' is disabled, skipping`, { session: name });
      return false;
    }

    // Skip sessions already adopted from bare Termux tabs
    if (this.adoptedPids.has(name)) {
      this.log.debug(`Session '${name}' is adopted (bare PID ${this.adoptedPids.get(name)}), skipping start`, { session: name });
      return true;
    }

    // Check dependencies
    const depsReady = sessionConfig.depends_on.every((dep) => {
      const depState = this.state.getSession(dep);
      return depState?.status === "running";
    });

    if (!depsReady) {
      this.state.forceStatus(name, "waiting");
      this.log.info(`Session '${name}' waiting on dependencies: ${sessionConfig.depends_on.join(", ")}`, {
        session: name,
      });
      return false;
    }

    // Transition to starting
    const s = this.state.getSession(name);
    if (s && s.status !== "pending" && s.status !== "waiting" && s.status !== "stopped" && s.status !== "failed") {
      // Already running or in transition
      if (s.status === "running") return true;
      this.log.debug(`Session '${name}' in status '${s.status}', skipping start`, { session: name });
      return false;
    }

    // Reset to pending first if needed (to allow valid transitions)
    if (s && s.status === "failed") {
      this.state.transition(name, "stopped");
      this.state.transition(name, "pending");
    } else if (s && s.status === "stopped") {
      this.state.transition(name, "pending");
    }

    this.state.transition(name, "waiting");
    this.state.transition(name, "starting");

    // Bare sessions: spawn as detached process, track PID directly.
    // Some bare services (e.g., termux-x11 via app_process) fork a child
    // that gets reparented to init, so the shell PID dies quickly.
    // We try to find the real process via command pattern matching.
    if (sessionConfig.bare) {
      // First check if the service is already running (e.g., started before daemon)
      const pattern = this.getBareServicePattern(sessionConfig);
      if (pattern) {
        const existingPid = findBareServicePid(pattern);
        if (existingPid) {
          this.log.info(`Bare session '${name}' already running (PID ${existingPid})`, { session: name });
          this.adoptedPids.set(name, existingPid);
          this.state.transition(name, "running");
          this.wake.evaluate("session_change", this.state.getState().sessions);
          return true;
        }
      }

      const pid = spawnBareProcess(sessionConfig, this.log);
      if (!pid) {
        this.state.transition(name, "failed", "Failed to spawn bare process");
        return false;
      }
      this.adoptedPids.set(name, pid);
      this.state.transition(name, "running");
      this.wake.evaluate("session_change", this.state.getState().sessions);

      // Schedule a deferred PID check: if the shell PID died but the service
      // process is running (reparented to init), adopt the real PID
      if (pattern) {
        setTimeout(() => {
          if (!existsSync(`/proc/${pid}`)) {
            const realPid = findBareServicePid(pattern);
            if (realPid) {
              this.log.info(`Bare session '${name}' shell exited, adopting real PID ${realPid}`, { session: name });
              this.adoptedPids.set(name, realPid);
            } else {
              this.log.warn(`Bare session '${name}' shell exited and no service process found`, { session: name });
              // Don't mark stopped yet — health sweep will catch it
            }
          }
        }, 3000);
      }
      return true;
    }

    // Create the tmux session
    const created = createSession(sessionConfig, this.log);
    if (!created) {
      this.state.transition(name, "failed", "Failed to create tmux session");
      return false;
    }

    // For Claude sessions, wait for readiness and optionally send "go"
    if (sessionConfig.type === "claude") {
      // Don't block the startup for readiness — handle in background
      this.handleClaudeStartup(name, sessionConfig).catch((err) => {
        this.log.error(`Claude startup failed for '${name}': ${(err as Error).message}`, { session: name });
        this.state.transition(name, "failed", `Startup error: ${(err as Error).message}`);
      });
    } else {
      // For non-Claude sessions, assume running after creation
      this.state.transition(name, "running");
    }

    // Update wake lock state
    this.wake.evaluate("session_change", this.state.getState().sessions);

    return true;
  }

  /** Handle Claude session startup: wait for readiness, send "go" if configured */
  private async handleClaudeStartup(name: string, config: SessionConfig): Promise<void> {
    // Give Claude Code a moment to initialize
    await sleep(2000);

    let readinessResult: "ready" | "timeout" | "disappeared" = "timeout";

    if (config.auto_go) {
      readinessResult = await sendGoToSession(name, this.log);
      if (readinessResult !== "ready") {
        this.log.warn(`Failed to send 'go' to '${name}' — ${readinessResult}`, { session: name });
      }
    } else {
      // Still poll for readiness even without auto_go, to set correct state
      readinessResult = await waitForClaudeReady(name, this.log);
    }

    const s = this.state.getSession(name);
    if (!s || s.status !== "starting") return;

    if (readinessResult === "ready" || readinessResult === "timeout") {
      // Both cases: session tmux is alive, mark running.
      // Timeout just means Claude Code hasn't shown the ? prompt yet — not degraded.
      this.state.transition(name, "running");
      if (readinessResult === "timeout") {
        this.log.info(`Session '${name}' running (readiness poll timed out, tmux alive)`, { session: name });
      }
    }
    // "disappeared" — session is gone, leave in starting (health check will handle)
  }

  /** Stop a single session by name */
  private async stopSessionByName(name: string): Promise<boolean> {
    trace(`session:stop:${name}`);
    const s = this.state.getSession(name);
    if (!s) return false;

    if (s.status === "stopped" || s.status === "pending") return true;

    // Resume first if suspended — SIGSTOP'd processes can't respond to graceful shutdown
    if (s.suspended) {
      resumeSession(name, this.log);
      this.state.setSuspended(name, false);
      // Brief delay for process to schedule and handle signals after SIGCONT
      await sleep(500);
    }

    this.state.transition(name, "stopping");

    // Kill bare (non-tmux) process if adopted
    const adoptedPid = this.adoptedPids.get(name);
    const cfg = this.config.sessions.find((c) => c.name === name);
    if (adoptedPid || cfg?.bare) {
      // Find all PIDs to kill: adopted PID + any matching service process
      const pidsToKill = new Set<number>();
      if (adoptedPid) pidsToKill.add(adoptedPid);
      const pattern = cfg ? this.getBareServicePattern(cfg) : null;
      if (pattern) {
        const realPid = findBareServicePid(pattern);
        if (realPid) pidsToKill.add(realPid);
      }

      for (const pid of pidsToKill) {
        this.log.info(`Killing bare process '${name}' (PID ${pid})`, { session: name });
        try {
          // Kill process group first (catches children like xfce4-session, dbus-launch)
          process.kill(-pid, "SIGTERM");
        } catch {
          // Process group kill may fail — fall back to direct PID kill
          try { process.kill(pid, "SIGTERM"); } catch { /* already dead — race between PID check and kill */ }
        }
      }
      await sleep(1500);
      // Force-kill any survivors
      for (const pid of pidsToKill) {
        if (existsSync(`/proc/${pid}`)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already dead — race between PID check and kill */ }
        }
      }
      this.adoptedPids.delete(name);
    }

    const stopped = await stopSession(name, this.log);
    if (stopped) {
      this.state.transition(name, "stopped");
    } else {
      // Force-set to stopped anyway
      this.state.forceStatus(name, "stopped");
    }

    // Clear stale activity snapshot so next start gets a fresh baseline
    this.activity.remove(name);

    this.wake.evaluate("session_change", this.state.getState().sessions);
    return stopped;
  }

  /** Adopt existing tmux sessions on daemon restart */
  private adoptExistingSessions(): void {
    const tmuxAlive = isTmuxServerAlive();
    const existingSessions = tmuxAlive ? new Set(listTmuxSessions()) : new Set<string>();
    const configuredNames = new Set(this.config.sessions.map((s) => s.name));

    if (tmuxAlive) {
      // Adopt tmux sessions that are alive but daemon thinks are not running
      for (const name of existingSessions) {
        if (!configuredNames.has(name)) continue;

        const s = this.state.getSession(name);
        if (s && s.status !== "running") {
          this.log.info(`Adopting existing tmux session '${name}'`, { session: name });
          this.state.forceStatus(name, "running");
          if (!s.uptime_start) {
            this.state.getSession(name)!.uptime_start = new Date().toISOString();
          }
        }
      }
    }

    // Adopt bare Claude processes (non-tmux Termux tabs)
    const bareSessions = discoverBareClaudeSessions(this.config.sessions);
    const adoptedNames = new Set<string>();
    for (const bare of bareSessions) {
      const s = this.state.getSession(bare.sessionName);
      if (s && s.status !== "running") {
        this.log.info(`Adopting bare Claude session '${bare.sessionName}' (PID ${bare.pid})`, { session: bare.sessionName });
        this.state.forceStatus(bare.sessionName, "running");
        this.adoptedPids.set(bare.sessionName, bare.pid);
        adoptedNames.add(bare.sessionName);
        if (!s.uptime_start) {
          this.state.getSession(bare.sessionName)!.uptime_start = new Date().toISOString();
        }
      } else if (s && s.status === "running" && !existingSessions.has(bare.sessionName)) {
        // Running state but no tmux session — track the bare PID for monitoring
        this.adoptedPids.set(bare.sessionName, bare.pid);
        adoptedNames.add(bare.sessionName);
      }
    }

    // Recover sessions whose state claims they're active but tmux session is gone
    // AND no bare process was found. Handles: post-reboot (state.json persists but
    // tmux is dead), OOM kills, and sessions stuck in transient states.
    // Skip bare-config sessions — they don't use tmux at all.
    for (const cfg of this.config.sessions) {
      if (cfg.bare) continue; // bare sessions are tracked via adoptedPids
      const s = this.state.getSession(cfg.name);
      if (!s) continue;
      const isActiveState = s.status === "running" || s.status === "degraded" ||
        s.status === "stopping" || s.status === "starting";
      if (isActiveState && !existingSessions.has(cfg.name) && !adoptedNames.has(cfg.name)) {
        this.log.info(`Recovering stale '${s.status}' session '${cfg.name}' → stopped`, { session: cfg.name });
        this.state.forceStatus(cfg.name, "stopped");
      }
    }
  }

  /**
   * Re-scan for newly started bare Claude sessions during health sweeps.
   * Picks up sessions the user started manually after daemon boot.
   */
  private rescanBareClaudeSessions(): void {
    const bareSessions = discoverBareClaudeSessions(this.config.sessions);
    for (const bare of bareSessions) {
      // Skip if we already track this session (tmux or adopted)
      if (this.adoptedPids.has(bare.sessionName)) {
        // Update PID if it changed (process restarted)
        if (this.adoptedPids.get(bare.sessionName) !== bare.pid) {
          this.log.info(`Adopted session '${bare.sessionName}' PID changed: ${this.adoptedPids.get(bare.sessionName)} → ${bare.pid}`, { session: bare.sessionName });
          this.adoptedPids.set(bare.sessionName, bare.pid);
        }
        continue;
      }

      const s = this.state.getSession(bare.sessionName);
      if (!s) continue;

      // Only adopt if session is stopped/failed/pending — don't steal from tmux
      if (s.status === "stopped" || s.status === "failed" || s.status === "pending") {
        this.log.info(`Late-adopting bare Claude session '${bare.sessionName}' (PID ${bare.pid})`, { session: bare.sessionName });
        this.state.forceStatus(bare.sessionName, "running");
        this.adoptedPids.set(bare.sessionName, bare.pid);
        this.state.getSession(bare.sessionName)!.uptime_start = new Date().toISOString();
      }
    }

    // Also scan for bare service processes (e.g., termux-x11 via app_process)
    for (const cfg of this.config.sessions) {
      if (!cfg.bare) continue;
      if (this.adoptedPids.has(cfg.name)) {
        // Verify existing adopted PID is still alive
        const pid = this.adoptedPids.get(cfg.name)!;
        if (!existsSync(`/proc/${pid}`)) {
          // PID died — try to find replacement
          const pattern = this.getBareServicePattern(cfg);
          const newPid = pattern ? findBareServicePid(pattern) : null;
          if (newPid) {
            this.log.info(`Bare service '${cfg.name}' PID ${pid} died, re-adopted as PID ${newPid}`, { session: cfg.name });
            this.adoptedPids.set(cfg.name, newPid);
          }
          // else: health sweep will handle marking stopped
        }
        continue;
      }

      const s = this.state.getSession(cfg.name);
      if (!s) continue;
      if (s.status !== "stopped" && s.status !== "failed" && s.status !== "pending") continue;

      const pattern = this.getBareServicePattern(cfg);
      if (!pattern) continue;
      const pid = findBareServicePid(pattern);
      if (pid) {
        this.log.info(`Late-adopting bare service '${cfg.name}' (PID ${pid})`, { session: cfg.name });
        this.state.forceStatus(cfg.name, "running");
        this.adoptedPids.set(cfg.name, pid);
        s.uptime_start = new Date().toISOString();
      }
    }
  }

  /**
   * Build a regex pattern to find a bare service process in the process table.
   * Returns null for sessions without a recognizable service command.
   */
  private getBareServicePattern(cfg: SessionConfig): RegExp | null {
    if (!cfg.command) return null;
    // termux-x11 runs as app_process with com.termux.x11.Loader
    if (cfg.command.includes("termux-x11")) return /com\.termux\.x11\.Loader/;
    // mcp-server-playwright / @playwright/mcp
    if (cfg.command.includes("playwright")) return /playwright.*mcp|mcp.*playwright/;
    // Generic: match the first non-env non-cleanup token from the command
    // e.g. "sleep 3 && DISPLAY=:1 bun foo" → match "bun foo" is too loose
    return null;
  }


  // -- Health & auto-restart --------------------------------------------------

  /** Start periodic health check timer */
  private startHealthTimer(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthSweepAndRestart(); // Prevent starvation on rapid SIGHUP reloads
    }
    const intervalMs = this.config.orchestrator.health_interval_s * 1000;
    this.healthTimer = setInterval(() => {
      this.healthSweepAndRestart();
    }, intervalMs);
  }

  /** Re-create IPC socket if it was removed (e.g. Termux crash cleans $PREFIX/tmp) */
  private async ensureSocket(): Promise<void> {
    const socketPath = this.config.orchestrator.socket;
    if (!existsSync(socketPath)) {
      this.log.warn("IPC socket missing (tmpdir cleaned?) — recreating");
      this.ipc.stop(); // clean up old server state
      // Re-create the IPC server with the same handler
      this.ipc = new IpcServer(
        socketPath,
        (cmd) => this.ipcHandler.handleIpcCommand(cmd),
        this.log,
      );
      try {
        await this.ipc.start();
        this.log.info("IPC socket re-created successfully");
      } catch (err) {
        this.log.error(`Failed to re-create IPC socket: ${err}`);
      }
    }
  }

  /** Run health sweep and handle auto-restarts for degraded sessions */
  private async healthSweepAndRestart(): Promise<void> {
    trace("health:sweep:start");

    // Self-heal: re-create IPC socket if tmpdir was cleaned
    await this.ensureSocket();

    // Prune stale activity snapshots for sessions no longer in config
    const activeNames = new Set(this.config.sessions.map((s) => s.name));
    this.activity.pruneStale(activeNames);

    // Re-scan for newly started bare Claude sessions
    this.rescanBareClaudeSessions();

    const results = runHealthSweep(this.config, this.state, this.log, this.adoptedPids);

    // Check for degraded sessions needing restart (skip suspended — they're intentionally frozen)
    for (const session of this.config.sessions) {
      const s = this.state.getSession(session.name);
      if (!s || s.status !== "degraded") continue;
      if (s.suspended) continue;

      // Check restart limit
      if (s.restart_count >= session.max_restarts) {
        this.state.transition(session.name, "failed",
          `Exceeded max restarts (${session.max_restarts})`);
        notify("operad", `Session '${session.name}' failed — max restarts exceeded`, `operad-fail-${session.name}`);
        appendNotification({ type: "session_error", title: `Session '${session.name}' failed`, content: `Exceeded max restarts (${session.max_restarts})`, session: session.name });
        continue;
      }

      // Apply backoff: wait restart_backoff_s * 2^restart_count
      const backoffMs = session.restart_backoff_s * Math.pow(2, s.restart_count) * 1000;
      this.log.info(`Auto-restarting '${session.name}' in ${backoffMs}ms (attempt ${s.restart_count + 1})`, {
        session: session.name,
      });

      // Transition to starting (increments restart_count)
      this.state.transition(session.name, "starting");

      // Schedule the actual restart (tracked for cleanup in shutdown)
      const timer = setTimeout(async () => {
        this.restartTimers.delete(timer);
        this.activity.remove(session.name); // Clear stale snapshot before restart
        await stopSession(session.name, this.log);
        const created = createSession(session, this.log);
        if (created) {
          if (session.type === "claude") {
            await this.handleClaudeStartup(session.name, session);
          } else {
            this.state.transition(session.name, "running");
          }
        } else {
          this.state.transition(session.name, "failed", "Restart failed");
        }
      }, backoffMs);
      this.restartTimers.add(timer);
    }

    trace("health:sweep:done");
  }

  // -- Session registry ---------------------------------------------------------

  /** Merge registry sessions into config (config takes precedence) */
  private mergeRegistrySessions(): void {
    // Prune stale entries (>30 days inactive)
    const pruned = this.registry.prune(30);
    if (pruned > 0) this.log.info(`Pruned ${pruned} stale registry entries`);

    const configNames = new Set(this.config.sessions.map((s) => s.name));
    const registryConfigs = this.registry.toSessionConfigs();

    for (const rc of registryConfigs) {
      if (configNames.has(rc.name)) {
        this.log.warn(`Registry session '${rc.name}' conflicts with config — skipping`, { session: rc.name });
        continue;
      }
      this.config.sessions.push(rc);
      this.log.info(`Merged registry session '${rc.name}' (${rc.path})`, { session: rc.name });
    }
  }

  /**
   * Resolve which Claude sessions to auto-start based on recency.
   * Two types of sessions are started:
   *   1. Primary instances — one per project path, most recent, uses `cc` (--continue)
   *   2. Named instances — sessions with a user-assigned title (via /rename),
   *      resumed by session_id with --resume
   *
   * Non-claude sessions (services/daemons) are untouched — they always start.
   * Called during boot() after mergeRegistrySessions() but before startAllSessions().
   */
  private resolveBootSessions(): void {
    // Delegated to session-resolver.ts (pure function, all deps passed in)
    resolveBootSessions(this.config, this.registry, this.state, this.log);
  }

  // -- Dashboard HTTP server ---------------------------------------------------

  /** Start HTTP dashboard server if port > 0 */
  private async startDashboard(): Promise<void> {
    const port = this.config.orchestrator.dashboard_port;
    if (port <= 0) {
      this.log.debug("Dashboard disabled (port=0)");
      return;
    }

    // Resolve static dir relative to the bundle location
    // In production: dist/tmx.js → dashboard should be at ../dashboard/dist/
    const scriptDir = typeof import.meta.url === "string"
      ? new URL(".", import.meta.url).pathname
      : __dirname ?? process.cwd();
    const staticDir = join(scriptDir, "..", "dashboard", "dist");

    this.dashboard = new DashboardServer(
      port,
      staticDir,
      (method, path, body) => this.restHandler.handleDashboardApi(method, path, body),
      this.log,
    );

    try {
      await this.dashboard.start();
    } catch (err) {
      this.log.warn(`Dashboard server failed to start: ${err}`);
      this.dashboard = null;
    }

    // Initialize memory database (before SDK bridge so it's available for callbacks)
    try {
      this.memoryDb = new MemoryDb(this.log);
      await this.memoryDb.init();
    } catch (err) {
      this.log.warn(`Memory database failed to initialize: ${err}`);
      this.memoryDb = null;
    }

    // Initialize tool executor (requires memoryDb)
    if (this.memoryDb) {
      this.toolExecutor = new ToolExecutor(this.memoryDb, this.log);
      // Register user-defined TOML tools
      if (this.config.tools && this.config.tools.length > 0) {
        this.toolExecutor.registerTomlTools(this.config.tools);
      }
      this.log.info(`Tool executor initialized with ${this.toolExecutor.getAllTools().length} tools`);

      // Initialize schedule engine — persistent cron/interval scheduling
      this.scheduleEngine = new ScheduleEngine(this.memoryDb, this.log, (schedule) => {
        return this.agentEngine.executeScheduledRun(schedule);
      });
      this.scheduleEngine.start();
    }

    // Initialize SDK bridge (uses WS broadcast for streaming)
    if (this.dashboard) {
      // Accumulate assistant text per session for memory extraction on result
      const assistantTextBuffer = new Map<string, string>();

      this.sdkBridge = new SdkBridge(
        this.log,
        (sessionName, data) => {
          // Broadcast to WS clients
          this.dashboard?.broadcastToRoom(sessionName, data);

          // Intercept messages for memory extraction + cost recording
          const msg = data as Record<string, unknown>;
          if (msg.type === "assistant" && msg.message) {
            // Accumulate assistant text for memory extraction when result arrives
            const content = (msg.message as any)?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block?.type === "text" && block.text) {
                  const prev = assistantTextBuffer.get(sessionName) ?? "";
                  assistantTextBuffer.set(sessionName, prev + block.text);
                }
              }
            }
          }

          if (msg.type === "result") {
            // Extract and save memories from accumulated assistant text
            const fullText = assistantTextBuffer.get(sessionName);
            if (fullText && this.memoryDb) {
              const sessionPath = this.resolveSessionPath(sessionName);
              if (sessionPath) {
                const saved = saveMemoriesFromResponse(
                  this.memoryDb, sessionPath, fullText,
                  typeof msg.session_id === "string" ? msg.session_id : undefined,
                );
                if (saved > 0) this.log.info(`Auto-saved ${saved} memories from ${sessionName}`);
              }
            }
            assistantTextBuffer.delete(sessionName);

            // Record cost from SDK result
            if (this.memoryDb && typeof msg.total_cost_usd === "number" && msg.total_cost_usd > 0) {
              try {
                this.memoryDb.recordCost(
                  sessionName,
                  typeof msg.session_id === "string" ? msg.session_id : null,
                  msg.total_cost_usd as number,
                  typeof msg.usage === "object" && msg.usage
                    ? ((msg.usage as any).input_tokens ?? 0)
                    : 0,
                  typeof msg.usage === "object" && msg.usage
                    ? ((msg.usage as any).output_tokens ?? 0)
                    : 0,
                  typeof msg.duration_ms === "number" ? msg.duration_ms : 0,
                  typeof msg.num_turns === "number" ? msg.num_turns : 0,
                  typeof msg.model_usage === "object" && msg.model_usage
                    ? Object.keys(msg.model_usage as object)[0] ?? null
                    : null,
                );
                this.log.debug(`Recorded cost $${(msg.total_cost_usd as number).toFixed(4)} for ${sessionName}`);
              } catch (err) {
                this.log.warn(`Failed to record cost: ${err}`);
              }
            }
          }
        },
      );

      // Wire WS message handler — dispatched via WsHandler
      this.dashboard.setWsMessageHandler((ws, msg, rooms) => {
        this.wsHandler.handleWsMessage(ws, msg).catch((err) => {
          ws.send(JSON.stringify({ type: "error", message: String(err) }));
        });
      });

      // Load agent definitions, populate switchboard agents map, inject into SDK bridge
      this.reloadAgents();
      // Persist switchboard so agent names survive restart
      const bootState = this.state.getState();
      bootState.switchboard = this.switchboard;
      this.state.flush();

      // Start cognitive timer — checks OODA trigger conditions every 60s
      this.cognitiveTimer = setInterval(() => {
        this.agentEngine.maybeTriggerOoda().catch((err) => {
          this.log.warn(`Cognitive timer error: ${err}`);
        });
        // Expire stale tool leases on each tick
        if (this.memoryDb) {
          const expired = this.memoryDb.expireLeases();
          if (expired > 0) this.log.debug(`Expired ${expired} tool lease(s)`);
        }
        // Daily agent snapshot (check every tick, only run once per day)
        this.persistenceEngine.maybeDailySnapshot();
        // Memory consolidation during idle periods
        this.persistenceEngine.maybeConsolidate();
      }, 60_000);

      // Verify SDK is available (non-blocking, log result)
      import("@anthropic-ai/claude-agent-sdk").then(() => {
        this.log.info("SDK available for streaming");
      }).catch(() => {
        this.log.debug("SDK not installed — streaming features disabled");
      });
    }
  }

  // -- Switchboard methods ------------------------------------------------------

  /**
   * Update switchboard state, persist to disk, and broadcast change via WS.
   * Pass partial updates — only the keys you want to change.
   */
  private updateSwitchboard(patch: Partial<Switchboard>): Switchboard {
    // Merge agents sub-map if provided
    if (patch.agents) {
      this.switchboard.agents = { ...this.switchboard.agents, ...patch.agents };
      delete patch.agents;
    }
    Object.assign(this.switchboard, patch);

    // If "all" was turned off, it acts as master kill-switch
    // (individual toggles remain as-is so turning "all" back on restores previous config)

    // Persist to state
    const state = this.state.getState();
    state.switchboard = this.switchboard;
    this.state.flush();

    // Re-gate agents — switchboard agent overrides interact with agent.enabled
    this.reloadAgents();

    // Broadcast update to all WS clients
    this.broadcastSwitchboard("switchboard_update", this.switchboard);

    return this.switchboard;
  }

  /** Broadcast a switchboard/system event to all connected WS clients */
  private broadcastSwitchboard(type: string, data: unknown): void {
    if (!this.dashboard) return;
    this.dashboard.broadcastWs({ type, ...((data && typeof data === "object") ? data : { data }) });
  }

  // -- Agent & cognitive methods ------------------------------------------------

  /** Reload agent configs from all sources and update SDK bridge.
   * Delegates to AgentEngine.reloadAgents() which mutates ctx.agentConfigs in-place. */
  private reloadAgents(): void {
    this.agentEngine.reloadAgents();
    // Keep daemon's agentConfigs field in sync — agentEngine mutates ctx.agentConfigs
    // which is the same array reference as this.agentConfigs (set via ctx.agentConfigs).
  }

  // buildAgentContext, extractAgentActions, handleStandaloneAgentRun,
  // handleAgentChat — moved to AgentEngine (src/agent-engine.ts)
  // reloadAgents, seedSpecializations — moved to AgentEngine (src/agent-engine.ts)
  // executeOodaActions, executeRoundtable — moved to AgentEngine (src/agent-engine.ts)
  // executeScheduledRun — moved to AgentEngine (src/agent-engine.ts)

  /** Start telemetry sink server if enabled in config */
  private async startTelemetrySink(): Promise<void> {
    if (!this.config.telemetry_sink.enabled) {
      this.log.debug("Telemetry sink disabled");
      return;
    }

    this.telemetrySink = new TelemetrySinkServer(
      this.config.telemetry_sink,
      this.config.orchestrator.log_dir,
      this.log,
    );

    // Wire SSE push through dashboard (if available)
    this.telemetrySink.onRecordCaptured((record) => {
      this.dashboard?.pushEvent("telemetry", record);
    });

    try {
      await this.telemetrySink.start();
    } catch (err) {
      this.log.warn(`Telemetry sink failed to start: ${err}`);
      this.telemetrySink = null;
    }
  }


  // -- Cron -------------------------------------------------------------------

  /** Start crond if not already running */
  private startCron(): void {
    try {
      const result = spawnSync("pgrep", ["-x", "crond"], { timeout: 5000, stdio: "ignore" });
      if (result.status !== 0) {
        spawnSync("crond", ["-s", "-P"], { timeout: 5000, stdio: "ignore" });
        this.log.info("Started crond");
      }
    } catch {
      this.log.warn("Failed to start crond");
    }
  }

  // -- Signal handling --------------------------------------------------------

  /** Set up process signal handlers for graceful shutdown */
  private setupSignalHandlers(): void {
    const handler = async (signal: string) => {
      trace(`signal:${signal}`);
      this.log.info(`Received ${signal}, shutting down...`);
      await this.shutdown();
      process.exit(0);
    };

    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
    process.on("SIGHUP", () => {
      // Reload config on SIGHUP
      this.log.info("Received SIGHUP, reloading config...");
      try {
        this.config = loadConfig();
        this.state.initFromConfig(this.config.sessions);
        this.budget.setBudget(this.config.orchestrator.process_budget);
        this.memory.setThresholds(
          this.config.orchestrator.memory_warning_mb,
          this.config.orchestrator.memory_critical_mb,
          this.config.orchestrator.memory_emergency_mb,
        );
        this.battery.setThreshold(this.config.battery.low_threshold_pct);
        this.log.info("Config reloaded successfully");
      } catch (err) {
        this.log.error(`Config reload failed: ${err}`);
      }
    });
  }

  // -- Helpers ----------------------------------------------------------------

  /** Resolve session path from config or registry */
  private resolveSessionPath(sessionName: string): string | null {
    return resolveSessionPathFn(this.config, this.registry, sessionName);
  }

  /** Fuzzy-match a session name (prefix match) */
  private resolveName(input: string): string | null {
    return resolveSessionName(this.config, this.registry, input);
  }
}
