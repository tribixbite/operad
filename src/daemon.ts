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
import { homedir } from "node:os";
import type { TmxConfig, IpcCommand, IpcResponse, SessionConfig, SessionStatus, Switchboard } from "./types.js";
import { defaultSwitchboard } from "./types.js";
import { loadConfig } from "./config.js";
import { detectPlatform } from "./platform/platform.js";
import { Logger } from "./log.js";
import { SessionController, type TmuxRunner } from "./session-controller.js";
import { StateManager } from "./state.js";
import { IpcServer } from "./ipc.js";
import { BudgetTracker } from "./budget.js";
import { WakeLockManager } from "./wake.js";
import { computeStartupOrder, computeShutdownOrder } from "./deps.js";
import { runHealthSweep } from "./health.js";
import { MemoryMonitor } from "./memory.js";
import { ActivityDetector } from "./activity.js";
import { BatteryMonitor } from "./battery.js";
import { Registry, parseRecentProjects, findNamedSessions, deriveName, isValidName, nextSuffix } from "./registry.js";
import type { RecentProject } from "./registry.js";
import { DashboardServer } from "./http.js";
import { TelemetrySinkServer } from "./telemetry-sink.js";
import { SdkBridge } from "./sdk-bridge.js";
import { MemoryDb, computeQuotaStatus } from "./memory-db.js";
import { saveMemoriesFromResponse } from "./memory-injector.js";
import { loadAgents, toSdkAgentMap, validateAgentConfig, saveUserAgent, deleteUserAgent, type AgentConfig } from "./agents.js";
import { buildOodaContext, buildOodaPrompt, parseOodaResponse } from "./cognitive.js";
import { ToolExecutor, type ToolContext, type ToolCategory } from "./tools.js";
import { ScheduleEngine, type ScheduleRecord } from "./schedule.js";
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
  sessionExists,
  listTmuxSessions,
  sendGoToSession,
  waitForClaudeReady,
  stopSession,
  sendKeys,
  createTermuxTab,
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
import { ServerEngine } from "./server-engine.js";
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
const BASH_SHEBANG = process.env.PREFIX
  ? `#!${process.env.PREFIX}/bin/bash`
  : `#!/usr/bin/env bash`;

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
/** Lines consisting entirely of box-drawing characters (U+2500–U+257F) */
const BOX_DRAWING_RE = /^[\u2500-\u257f\s]+$/;
/** Lines that are just a bare prompt character */
const BARE_PROMPT_RE = /^\s*[❯>$%#]\s*$/;
/** CC status bar / chrome lines to filter out */
const CC_CHROME_RE = /esc to interrupt|bypass permissions|shift\+tab to cycle|press enter to send|\/help for help|to cycle|tab to navigate/i;

/**
 * Clean raw tmux capture-pane output for display.
 * Strips ANSI escapes, box-drawing separator lines, bare prompts,
 * and CC status bar chrome. Returns last N meaningful content lines.
 */
function cleanPaneOutput(raw: string, maxLines = 3): string {
  const stripped = raw.replace(ANSI_RE, "");
  const lines = stripped.split("\n");
  const meaningful: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (BOX_DRAWING_RE.test(trimmed)) continue;
    if (BARE_PROMPT_RE.test(trimmed)) continue;
    if (CC_CHROME_RE.test(trimmed)) continue;
    meaningful.push(line);
  }
  return meaningful.slice(-maxLines).join("\n");
}

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

/** Resolve ADB binary path via platform abstraction */
const ADB_BIN = detectPlatform().resolveAdbPath() ?? "adb";

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

/** Chunk text into segments of approximately maxChars, splitting on paragraph/newline boundaries */
function chunkText(text: string, maxChars = 2000): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += (current ? "\n\n" : "") + para;
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

export class Daemon {
  private config: TmxConfig;
  private log: Logger;
  private sessionController!: SessionController;
  private agentEngine!: AgentEngine;
  private toolEngine!: ToolEngine;
  private persistenceEngine!: PersistenceEngine;
  private serverEngine!: ServerEngine;
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
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  private batteryTimer: ReturnType<typeof setInterval> | null = null;
  private adbRetryTimer: ReturnType<typeof setInterval> | null = null;
  private registryFlushTimer: ReturnType<typeof setInterval> | null = null;
  /** Pending auto-restart timers — tracked so shutdown() can cancel them */
  private restartTimers = new Set<ReturnType<typeof setTimeout>>();
  private autoTabsTimer: ReturnType<typeof setTimeout> | null = null;
  /** PIDs of adopted bare (non-tmux) Claude sessions, keyed by session name */
  private adoptedPids = new Map<string, number>();
  /** Summary notification content from last cycle — skip re-emit if unchanged */
  private _prevSummaryContent = "";
  /** Last known conversation UUID per session — for delta detection */
  private lastConversationUuids = new Map<string, string>();
  private adbSerial: string | null = null;
  private adbSerialExpiry = 0;
  /** Cached local IP for ADB self-identification */
  private localIp: string | null = null;
  private localIpExpiry = 0;
  private static readonly LOCAL_IP_TTL_MS = 60_000;
  private running = false;
  /** Resolved when shutdown() completes — replaces 1s polling interval */
  private shutdownResolve: (() => void) | null = null;
  /** Packages flagged for auto-stop on memory pressure */
  private autoStopPkgs = new Set<string>();
  private static readonly AUTOSTOP_PATH = join(homedir(), ".local", "share", "tmx", "autostop.json");

  constructor(configPath?: string) {
    this.config = loadConfig(configPath);
    this.log = new Logger(this.config.orchestrator.log_dir);
    const tmuxRunner: TmuxRunner = (args) => {
      const result = spawnSync("tmux", args, { encoding: "utf8" });
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    };
    this.sessionController = new SessionController({
      tmuxRunner,
      healthChecker: async () => ({ healthy: true }),
      log: this.log,
    });
    this.state = new StateManager(this.config.orchestrator.state_file, this.log);
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

    // Load auto-stop package list
    this.loadAutoStopList();

    // Wire up IPC handler — delegates to serverEngine once it's constructed below.
    // Use a late-binding lambda so this.serverEngine is available after construction.
    this.ipc = new IpcServer(
      this.config.orchestrator.socket,
      (cmd) => this.serverEngine.handleIpcCommand(cmd),
      this.log,
    );

    // AgentEngine injection point — extraction target for agent/OODA logic.
    // Built late in constructor so all dependencies are available.
    const ctx: OrchestratorContext = {
      config: this.config,
      state: this.state,
      memoryDb: this.memoryDb ?? null,
      switchboard: this.switchboard,
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
      // cmd* delegates — each wraps the corresponding Daemon private method so the
      // REST API in daemon.ts and the IPC dispatch in ServerEngine share one impl.
      cmdStatus: (name) => this.cmdStatus(name),
      cmdStart: (name) => this.cmdStart(name),
      cmdStop: (name) => this.cmdStop(name),
      cmdRestart: (name) => this.cmdRestart(name),
      cmdHealth: () => this.cmdHealth(),
      cmdMemory: () => this.cmdMemory(),
      cmdGo: (name) => this.cmdGo(name),
      cmdSend: (name, text) => this.cmdSend(name, text),
      cmdTabs: (names) => this.cmdTabs(names),
      cmdOpen: (path, name, autoGo, priority) => this.cmdOpen(path, name, autoGo, priority),
      cmdClose: (name) => this.cmdClose(name),
      cmdRecent: (count) => this.cmdRecent(count),
      cmdSuspend: (name) => this.cmdSuspend(name),
      cmdResume: (name) => this.cmdResume(name),
      cmdSuspendOthers: (name) => this.cmdSuspendOthers(name),
      cmdSuspendAll: () => this.cmdSuspendAll(),
      cmdResumeAll: () => this.cmdResumeAll(),
      cmdRegister: (scanPath) => this.cmdRegister(scanPath),
      cmdClone: (url, name) => this.cmdClone(url, name),
      cmdCreate: (name) => this.cmdCreate(name),
      // -- REST route handler callbacks (for ServerEngine.handleDashboardApi) ---
      getTelemetrySink: () => this.telemetrySink,
      getScheduleEngine: () => this.scheduleEngine,
      broadcastWs: (type, data) => this.broadcastSwitchboard(type, data),
      ensureSocket: () => this.ensureSocket(),
      reloadAgents: () => this.reloadAgents(),
      resolveName: (input) => this.resolveName(input),
      getAndroidApps: () => this.getAndroidApps(),
      forceStopApp: (pkg) => this.forceStopApp(pkg),
      getAutoStopList: () => this.getAutoStopList(),
      toggleAutoStop: (pkg) => this.toggleAutoStop(pkg),
      invalidateAdbSerial: () => { this.adbSerial = null; this.adbSerialExpiry = 0; },
    };
    this.agentEngine = new AgentEngine(ctx);
    // ToolEngine reuses the same OrchestratorContext — no extra wiring needed.
    this.toolEngine = new ToolEngine(ctx);
    // PersistenceEngine owns daily snapshots and will absorb more persistence
    // concerns incrementally as daemon.ts dependencies are disentangled.
    this.persistenceEngine = new PersistenceEngine(ctx);
    // ServerEngine is the extraction target for HTTP/IPC/WS/SSE handler logic.
    // Receives AgentEngine + ToolEngine to dispatch WS client messages.
    this.serverEngine = new ServerEngine(ctx, this.agentEngine, this.toolEngine);
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

    // Start memory monitoring timer (every 15s)
    this.startMemoryTimer();

    // Start battery monitoring timer
    this.startBatteryTimer();

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
      await this.fixAdb();
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
        const tabResult = this.cmdTabs();
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
    this.updateStatusNotification();
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

    // Stop health checks and memory monitoring
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer);
      this.memoryTimer = null;
    }
    if (this.batteryTimer) {
      clearInterval(this.batteryTimer);
      this.batteryTimer = null;
    }
    if (this.adbRetryTimer) {
      clearInterval(this.adbRetryTimer);
      this.adbRetryTimer = null;
    }
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

  // -- ADB helpers ------------------------------------------------------------

  /** ADB serial cache TTL — re-resolve every 30s to handle reconnects */
  private static readonly ADB_SERIAL_TTL_MS = 30_000;

  /** Get local IP with caching (60s TTL) */
  private getLocalIp(): string | null {
    const now = Date.now();
    if (this.localIp && now < this.localIpExpiry) return this.localIp;
    this.localIp = detectPlatform().resolveLocalIp();
    this.localIpExpiry = now + Daemon.LOCAL_IP_TTL_MS;
    if (this.localIp) this.log.debug(`Local IP resolved: ${this.localIp}`);
    return this.localIp;
  }

  /**
   * Resolve the active ADB device serial (needed when multiple devices are listed).
   * Prefers localhost/self-device connections over external phones.
   * Caches with a short TTL so reconnects with new ports are picked up.
   * Auto-disconnects stale offline/unauthorized entries to prevent confusion.
   */
  private resolveAdbSerial(): string | null {
    const now = Date.now();
    if (this.adbSerial && now < this.adbSerialExpiry) return this.adbSerial;
    try {
      const result = spawnSync(ADB_BIN, ["devices"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0 || !result.stdout) return null;

      const lines = result.stdout.split("\n").filter((l) => l.includes("\t"));
      const online: string[] = [];
      const stale: string[] = [];

      for (const line of lines) {
        const [serial, state] = line.split("\t");
        if (state?.trim() === "device") {
          online.push(serial.trim());
        } else if (state?.trim() === "offline" || state?.trim() === "unauthorized") {
          stale.push(serial.trim());
        }
      }

      // Auto-disconnect stale entries to prevent "more than one device" errors
      for (const serial of stale) {
        this.log.debug(`Disconnecting stale ADB device: ${serial}`);
        spawnSync(ADB_BIN, ["disconnect", serial], { timeout: 3000, stdio: "ignore" });
      }

      if (online.length === 0) {
        this.adbSerial = null;
        return null;
      }

      // Prefer localhost/self-device connections over external phones
      if (online.length > 1) {
        const localIp = this.getLocalIp();
        const localhost = online.find((s) =>
          s.startsWith("127.0.0.1:") ||
          s.startsWith("localhost:") ||
          (localIp && s.startsWith(`${localIp}:`))
        );
        if (localhost) {
          this.log.debug(`Multiple ADB devices, preferring localhost: ${localhost}`);
          this.adbSerial = localhost;
        } else {
          this.log.warn(`Multiple ADB devices, no localhost match — using ${online[0]}. ` +
            `Devices: ${online.join(", ")}`);
          this.adbSerial = online[0];
        }
      } else {
        this.adbSerial = online[0];
      }

      this.adbSerialExpiry = now + Daemon.ADB_SERIAL_TTL_MS;
      return this.adbSerial;
    } catch (err) {
      this.log.debug("resolveAdbSerial failed", { err: String(err) });
      return null;
    }
  }

  /** Build ADB shell args with serial selection for multi-device environments */
  private adbShellArgs(...shellArgs: string[]): string[] {
    const serial = this.resolveAdbSerial();
    const args: string[] = [];
    if (serial) args.push("-s", serial);
    args.push("shell", ...shellArgs);
    return args;
  }

  // -- ADB fix ----------------------------------------------------------------

  /** Attempt ADB connection and apply phantom process killer fix */
  private async fixAdb(): Promise<boolean> {
    trace("adb:fix:start");
    this.log.info("Attempting ADB connection for phantom process fix");

    const { connect_script, connect_timeout_s, phantom_fix } = this.config.adb;

    try {
      const result = spawnSync("timeout", [String(connect_timeout_s), connect_script], {
        encoding: "utf-8",
        timeout: (connect_timeout_s + 5) * 1000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (result.status !== 0) {
        this.log.warn("ADB connection failed", { stderr: result.stderr?.trim() });
        this.state.setAdbFixed(false);
        notify("operad boot", "ADB fix failed — processes may be killed", "operad-boot");

        // Set up retry timer
        this.startAdbRetryTimer();
        return false;
      }

      this.log.info("ADB connected");
      // Clear cached serial so it's re-resolved with the new connection
      this.adbSerial = null;
      this.adbSerialExpiry = 0;

      if (phantom_fix) {
        this.applyPhantomFix();
      }

      this.state.setAdbFixed(true);
      return true;
    } catch (err) {
      this.log.error(`ADB fix error: ${err}`);
      this.state.setAdbFixed(false);
      this.startAdbRetryTimer();
      return false;
    }
  }

  /**
   * Verify the resolved ADB device is this device (not an external phone).
   * When only one device is connected, it must be this device — skip IP matching.
   * IP matching is only needed when multiple devices are online to disambiguate.
   */
  private isLocalAdbDevice(): boolean {
    const serial = this.resolveAdbSerial();
    if (!serial) return false;

    // Localhost connections are always local
    if (serial.startsWith("127.0.0.1:") || serial.startsWith("localhost:")) return true;

    // Count online devices to decide if IP matching is needed
    try {
      const result = spawnSync(ADB_BIN, ["devices"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const onlineCount = (result.stdout ?? "")
        .split("\n")
        .filter((l) => l.includes("\tdevice")).length;

      // Single device: must be this device — no need for IP matching
      if (onlineCount === 1) return true;

      // Multiple devices: fall through to IP check
    } catch { /* fall through to IP check */ }

    // Check if serial IP matches local IP (multi-device disambiguation)
    const localIp = this.getLocalIp();
    if (localIp && serial.startsWith(`${localIp}:`)) return true;

    // Serial doesn't match any local address — might be an external device
    return false;
  }

  /**
   * Apply Android 12+ process protection fixes via ADB.
   * Mirrors ALL the protections from the old tasker/startup.sh:
   * 1. Phantom process killer disable (device_config + settings)
   * 2. Doze whitelist (deviceidle) for Termux + Edge
   * 3. Active standby bucket for Termux + Edge
   * 4. Background execution allow for Termux + Edge
   */
  private applyPhantomFix(): void {
    // Safety check: only apply settings to this device, not external phones
    if (!this.isLocalAdbDevice()) {
      const serial = this.resolveAdbSerial();
      this.log.warn(`Skipping phantom fix — ADB device '${serial}' may not be this device`);
      return;
    }

    // 1. Phantom process killer fix
    const phantomCmds = [
      ["/system/bin/device_config", "put", "activity_manager", "max_phantom_processes", "2147483647"],
      ["settings", "put", "global", "settings_enable_monitor_phantom_procs", "false"],
    ];

    // 2. Doze whitelist — prevent Android from suspending these apps
    const dozeWhitelistPkgs = ["com.termux", "com.microsoft.emmx.canary"];

    // 3. Active standby bucket — prevent throttling
    const standbyPkgs = ["com.termux", "com.microsoft.emmx.canary"];

    // 4. Background execution — allow running in background unconditionally
    const bgPkgs = ["com.termux", "com.microsoft.emmx.canary"];

    // Apply phantom process fixes
    for (const cmd of phantomCmds) {
      try {
        spawnSync(ADB_BIN, this.adbShellArgs(...cmd), { timeout: 10_000, stdio: "ignore" });
      } catch (err) {
        this.log.warn(`Phantom fix command failed: ${cmd.join(" ")}`, { error: String(err) });
      }
    }

    // Apply Doze whitelist
    for (const pkg of dozeWhitelistPkgs) {
      try {
        spawnSync(ADB_BIN, this.adbShellArgs("cmd", "deviceidle", "whitelist", `+${pkg}`), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch (err) {
        this.log.warn(`Doze whitelist failed for ${pkg}`, { error: String(err) });
      }
    }

    // Apply active standby bucket
    for (const pkg of standbyPkgs) {
      try {
        spawnSync(ADB_BIN, this.adbShellArgs("am", "set-standby-bucket", pkg, "active"), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch (err) {
        this.log.warn(`Standby bucket failed for ${pkg}`, { error: String(err) });
      }
    }

    // Allow background execution
    for (const pkg of bgPkgs) {
      try {
        spawnSync(ADB_BIN, this.adbShellArgs("cmd", "appops", "set", pkg, "RUN_ANY_IN_BACKGROUND", "allow"), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch (err) {
        this.log.warn(`Background allow failed for ${pkg}`, { error: String(err) });
      }
    }

    // 5. OOM score adjustment — make Termux less likely to be killed by LMK
    // oom_score_adj ranges from -1000 (never kill) to 1000 (kill first).
    // -200 is moderate — enough to survive pressure spikes without starving
    // foreground apps. Logcat shows Termux main process already at adj=0
    // (foreground), so this mainly protects against transient demotion.
    try {
      // Get Termux's main PID from the app process
      const pidResult = spawnSync(ADB_BIN, this.adbShellArgs(
        "sh", "-c", "pidof com.termux | head -1",
      ), { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
      const termuxPid = pidResult.stdout?.trim();
      if (termuxPid && /^\d+$/.test(termuxPid)) {
        spawnSync(ADB_BIN, this.adbShellArgs(
          "sh", "-c", `echo -200 > /proc/${termuxPid}/oom_score_adj`,
        ), { timeout: 10_000, stdio: "ignore" });
        this.log.info(`Set oom_score_adj=-200 for Termux PID ${termuxPid}`);
      }
    } catch (err) {
      this.log.debug(`oom_score_adj failed (non-critical): ${err}`);
    }

    // 6. Prevent Android from classifying Termux as idle (which triggers restrictions)
    for (const pkg of ["com.termux", "com.microsoft.emmx.canary"]) {
      try {
        spawnSync(ADB_BIN, this.adbShellArgs("cmd", "activity", "set-inactive", pkg, "false"), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch {
        // Non-critical — command may not exist on all Android versions
      }
    }

    // 7. Lower LMK trigger level to reduce aggressive kills under memory pressure
    try {
      spawnSync(ADB_BIN, this.adbShellArgs("settings", "put", "global", "low_power_trigger_level", "1"), {
        timeout: 10_000, stdio: "ignore",
      });
    } catch {
      // Non-critical
    }

    // Re-enable Samsung sensor packages
    const samsungPkgs = [
      "com.samsung.android.ssco",
      "com.samsung.android.mocca",
      "com.samsung.android.camerasdkservice",
    ];
    for (const pkg of samsungPkgs) {
      try {
        spawnSync(ADB_BIN, this.adbShellArgs("pm", "enable", pkg), { timeout: 10_000, stdio: "ignore" });
      } catch {
        // Non-critical
      }
    }

    trace("adb:fix:complete");
    this.log.info("Android process protection fixes applied (phantom + doze + standby + background + oom_adj + idle + lmk)");
  }

  /** Start a periodic ADB retry timer */
  private startAdbRetryTimer(): void {
    if (this.adbRetryTimer) return;
    const intervalMs = this.config.adb.retry_interval_s * 1000;
    this.adbRetryTimer = setInterval(async () => {
      if (this.state.getState().adb_fixed) {
        // Already fixed, stop retrying
        if (this.adbRetryTimer) {
          clearInterval(this.adbRetryTimer);
          this.adbRetryTimer = null;
        }
        return;
      }
      this.log.info("Retrying ADB connection...");
      const success = await this.fixAdb();
      if (success && this.adbRetryTimer) {
        clearInterval(this.adbRetryTimer);
        this.adbRetryTimer = null;
      }
    }, intervalMs);
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
        (cmd) => this.serverEngine.handleIpcCommand(cmd),
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

  // -- Memory monitoring -------------------------------------------------------

  /** Start periodic memory monitoring timer (every 5s — fast enough to catch burst OOM) */
  private startMemoryTimer(): void {
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    this.memoryTimer = setInterval(() => {
      this.memoryPollAndShed();
    }, 5_000);
    // Run an initial poll immediately
    this.memoryPollAndShed();
  }

  /** Poll system memory and update per-session RSS/activity */
  private memoryPollAndShed(): void {
    trace("memory:poll");
    // Invalidate caches at start of each poll cycle so we get fresh data
    this.memory.invalidatePsCache();
    this.activity.invalidateProcCache();

    // System memory
    const sysMem = this.memory.getSystemMemory();
    this.state.updateSystemMemory(sysMem);

    // Per-session RSS and activity classification
    for (const session of this.config.sessions) {
      const s = this.state.getSession(session.name);
      if (!s || (s.status !== "running" && s.status !== "degraded")) {
        if (s) this.state.updateSessionMetrics(session.name, null, null);
        continue;
      }

      // Get PID: prefer adopted bare PID, fall back to tmux pane PID
      const adoptedPid = this.adoptedPids.get(session.name);
      let pid: number | null = null;
      if (adoptedPid !== undefined) {
        // Verify adopted PID is still alive
        if (existsSync(`/proc/${adoptedPid}`)) {
          pid = adoptedPid;
        } else {
          // Bare process died — remove from adopted, mark stopped
          this.log.info(`Adopted session '${session.name}' PID ${adoptedPid} exited`, { session: session.name });
          this.adoptedPids.delete(session.name);
          this.state.forceStatus(session.name, "stopped");
          this.state.updateSessionMetrics(session.name, null, "stopped");
          continue;
        }
      } else {
        pid = this.memory.getSessionPid(session.name);
      }
      if (pid === null) {
        this.state.updateSessionMetrics(session.name, null, "stopped");
        continue;
      }

      // Get RSS for the full process tree
      const { rss_mb } = this.memory.getProcessTreeRss(pid);

      // Classify activity based on CPU ticks
      const activityState = this.activity.classifyTree(session.name, pid);

      // Capture pane output + detect Claude prompt state for non-service sessions
      let lastOutput: string | null = null;
      let claudeStatus: "working" | "waiting" | null = null;
      if (session.type !== "service" && !session.bare) {
        const pane = capturePane(session.name, 10);
        if (pane) {
          // Extract meaningful content lines (strips CC chrome, box-drawing, ANSI)
          lastOutput = cleanPaneOutput(pane, 3) || null;
          // Detect if Claude is actively working vs waiting for input.
          // "esc to interrupt" in the status bar = Claude is processing.
          if (session.type === "claude") {
            claudeStatus = CLAUDE_WORKING_PATTERN.test(pane) ? "working" : "waiting";
          }
        }
      }

      this.state.updateSessionMetrics(session.name, rss_mb, activityState, lastOutput, claudeStatus);
    }

    // Auto-suspend/resume based on memory pressure
    this.autoSuspendOnPressure(sysMem?.pressure ?? "normal");

    // Push conversation deltas for claude sessions (live streaming)
    this.pushConversationDeltas();

    // Push SSE update with combined state+memory
    this.pushSseState();

    // Update persistent status notification in system bar
    this.updateStatusNotification();
  }

  /**
   * Auto-suspend idle sessions when memory pressure is critical/emergency.
   * Auto-resume previously auto-suspended sessions when pressure returns to normal.
   * This is the key mechanism that prevents OOM death spirals during heavy builds.
   */
  private autoSuspendOnPressure(pressure: string): void {
    if (pressure === "critical" || pressure === "emergency") {
      // Force-stop flagged Android apps on memory pressure
      this.autoStopFlaggedApps();

      // Sort running, non-suspended sessions by RSS descending (biggest first)
      const candidates: Array<{ name: string; rss: number }> = [];
      const sessions = this.state.getState().sessions;
      for (const [name, s] of Object.entries(sessions)) {
        if (s.suspended) continue;
        if (s.status !== "running" && s.status !== "degraded") continue;
        // Only auto-suspend idle sessions — don't freeze active builds
        if (s.activity !== "idle") continue;
        candidates.push({ name, rss: s.rss_mb ?? 0 });
      }
      candidates.sort((a, b) => b.rss - a.rss);

      if (candidates.length > 0) {
        // Emergency: suspend ALL idle sessions immediately (lmkd kills come in bursts)
        // Critical: suspend one per cycle to avoid over-freezing
        const limit = pressure === "emergency" ? candidates.length : 1;
        const targets = candidates.slice(0, limit);
        const names = targets.map((t) => t.name);
        this.log.warn(
          `Memory ${pressure}: auto-suspending ${names.join(", ")}`,
        );
        for (const target of targets) {
          if (suspendSession(target.name, this.log)) {
            this.state.setSuspended(target.name, true, true); // auto=true
          }
        }
        notify("operad", `Paused ${names.join(", ")} — memory ${pressure}`, `operad-autosuspend`);
        appendNotification({ type: "memory_pressure", title: `Memory ${pressure}`, content: `Auto-suspended: ${names.join(", ")}` });
        // Nudge Edge renderers to GC via CFC bridge CDP (non-blocking, best-effort)
        fetch("http://127.0.0.1:18963/memory-pressure", {
          method: "POST", signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      }
    } else if (pressure === "normal") {
      // Auto-resume sessions that were auto-suspended (not manually suspended)
      const sessions = this.state.getState().sessions;
      for (const [name, s] of Object.entries(sessions)) {
        if (!s.auto_suspended) continue;
        this.log.info(`Memory normal: auto-resuming '${name}'`, { session: name });
        if (resumeSession(name, this.log)) {
          this.state.setSuspended(name, false);
        }
      }
    }
    // Warning pressure: no action — just monitoring
  }

  /** Push current state snapshot to all SSE clients */
  private pushSseState(): void {
    if (!this.dashboard || this.dashboard.sseClientCount === 0) return;

    const statusResp = this.cmdStatus();
    if (statusResp.ok) {
      this.dashboard.pushEvent("state", statusResp.data);
    }
  }

  /** Push conversation deltas for claude sessions via SSE (live streaming) */
  private pushConversationDeltas(): void {
    if (!this.dashboard || this.dashboard.sseClientCount === 0) return;

    for (const cfg of this.config.sessions) {
      if (cfg.type !== "claude" || !cfg.path) continue;
      const s = this.state.getSession(cfg.name);
      if (!s || s.status !== "running") continue;

      try {
        const lastUuid = this.lastConversationUuids.get(cfg.name) ?? null;
        const delta = getConversationDelta(cfg.path, lastUuid, 10);
        if (!delta || delta.entries.length === 0) continue;

        // Track the newest UUID for next iteration
        const newestUuid = delta.entries[delta.entries.length - 1].uuid;
        this.lastConversationUuids.set(cfg.name, newestUuid);

        // Push via SSE
        this.dashboard.pushEvent("conversation", {
          session: cfg.name,
          entries: delta.entries,
          session_id: delta.session_id,
        });
      } catch {
        // Non-fatal — skip this session's delta
      }
    }
  }

  /**
   * Update the persistent Android notification with session status.
   *
   * Single notification only — per-session notifications were removed because:
   * 1. They jump around in sort order every few seconds (Android sorts by update time)
   * 2. Button actions (curl-based) silently fail on Termux (missing LD_PRELOAD/PATH)
   * 3. 7+ notifications are noise, not actionable status
   *
   * Button actions use full binary paths + LD_PRELOAD env injection to work
   * properly on Termux where bun strips LD_PRELOAD from child processes.
   *
   * Button layout (3 max from termux-notification):
   * - Button 1: "Pause All" / "Resume All" (toggles based on current state)
   * - Button 2: "Stop All"
   * - Button 3: "Dashboard" — opens browser
   */
  private updateStatusNotification(): void {
    const sessions = this.state.getState().sessions;
    const activeNames: string[] = [];
    const idleNames: string[] = [];
    const suspendedNames: string[] = [];
    let totalRunning = 0;

    for (const [name, s] of Object.entries(sessions)) {
      if (s.status === "running" || s.status === "degraded") {
        totalRunning++;
        if (s.suspended) {
          suspendedNames.push(name);
        } else if (s.activity === "active") {
          activeNames.push(name);
        } else {
          idleNames.push(name);
        }
      }
    }

    const port = this.config.orchestrator.dashboard_port;
    const apiBase = `http://127.0.0.1:${port}/api`;

    // Resolve curl path — bun's PATH stripping means bare `curl` may not be found
    // in button action shells. Use full prefix path.
    const curlBin = detectPlatform().resolveBinaryPath("curl");

    const activeCount = activeNames.length;
    const suspendedCount = suspendedNames.length;
    const title = suspendedCount > 0
      ? `operad ▶ ${activeCount}/${totalRunning} (${suspendedCount} paused)`
      : `operad ▶ ${activeCount}/${totalRunning}`;

    // Compact content: list session names by status, truncated
    const MAX_NAMES = 6;
    const parts: string[] = [];
    if (activeNames.length > 0) {
      const shown = activeNames.sort().slice(0, MAX_NAMES);
      const extra = activeNames.length - shown.length;
      parts.push(`▶ ${shown.join(", ")}${extra > 0 ? ` +${extra}` : ""}`);
    }
    if (idleNames.length > 0) {
      const shown = idleNames.sort().slice(0, MAX_NAMES);
      const extra = idleNames.length - shown.length;
      parts.push(`◇ ${shown.join(", ")}${extra > 0 ? ` +${extra}` : ""}`);
    }
    if (suspendedNames.length > 0) {
      const shown = suspendedNames.sort().slice(0, MAX_NAMES);
      const extra = suspendedNames.length - shown.length;
      parts.push(`⏸ ${shown.join(", ")}${extra > 0 ? ` +${extra}` : ""}`);
    }
    const content = parts.length > 0 ? parts.join(" | ") : "no sessions";

    // Skip re-emit if nothing changed — prevents unnecessary termux-api spawns
    const summaryKey = `${title}|${content}`;
    if (this._prevSummaryContent === summaryKey) return;
    this._prevSummaryContent = summaryKey;

    const anySuspended = suspendedCount > 0;
    const toggleLabel = anySuspended ? "Resume All" : "Pause All";
    const toggleEndpoint = anySuspended ? "resume-all" : "suspend-all";

    // Button actions: use full binary paths for Termux compatibility.
    // LD_PRELOAD injection is needed for am to work, but button actions
    // run in a minimal shell where env may not be set. Use env command
    // to inject it explicitly.
    const ldPreload = `${process.env.PREFIX ?? "/data/data/com.termux/files/usr"}/lib/libtermux-exec-ld-preload.so`;
    const amBin = detectPlatform().resolveBinaryPath("am");

    const toggleAction = `${curlBin} -sX POST ${apiBase}/${toggleEndpoint} >/dev/null 2>&1`;
    const stopAction = `${curlBin} -sX POST ${apiBase}/stop >/dev/null 2>&1`;
    // Dashboard: use env to inject LD_PRELOAD for am command.
    // Explicit Edge Canary component avoids new-tab-per-intent behavior.
    // FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TOP (0x14000000)
    // reuses the existing Edge activity instead of stacking a new one.
    const edgeComponent = "com.microsoft.emmx.canary/com.google.android.apps.chrome.IntentDispatcher";
    const dashboardAction = `LD_PRELOAD=${ldPreload} ${amBin} start -a android.intent.action.VIEW -n ${edgeComponent} -f 0x14000000 -d http://127.0.0.1:${port}`;

    notifyWithArgs([
      "--ongoing",
      "--alert-once",
      "--id", "operad-status",
      "--priority", "low",
      "--title", title,
      "--content", content,
      "--icon", "dashboard",
      "--action", dashboardAction,
      "--button1", toggleLabel,
      "--button1-action", toggleAction,
      "--button2", "Stop All",
      "--button2-action", stopAction,
      "--button3", "Dashboard",
      "--button3-action", dashboardAction,
    ]);
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
    const home = homedir();
    const historyPath = join(home, ".claude", "history.jsonl");
    const recentProjects = parseRecentProjects(historyPath, 1000);
    const namedSessions = findNamedSessions(historyPath, 7);
    const { auto_start, visible } = this.config.boot;

    // Build path→config lookup (one entry per path for primary matching)
    const configByPath = new Map<string, SessionConfig>();
    for (const s of this.config.sessions) {
      if (s.path) configByPath.set(resolve(s.path), s);
    }

    // Track ranked claude sessions for partitioning
    const recentClaude: { config: SessionConfig; rank: number }[] = [];
    let rank = 0;

    // --- Phase 1: Primary instances (one per project, no session_id, uses cc) ---
    for (const proj of recentProjects) {
      if (rank >= visible) break;

      const resolvedPath = resolve(proj.path);
      const existing = configByPath.get(resolvedPath);

      if (existing) {
        if (existing.type === "claude" && existing.enabled) {
          // Primary instance uses cc (--continue), no session_id
          existing.session_id = undefined;
          recentClaude.push({ config: existing, rank: rank++ });
        }
      } else {
        // Untracked project — auto-register
        const name = deriveName(proj.path);
        if (!this.config.sessions.find((s) => s.name === name)) {
          this.registry.add({ name, path: resolvedPath, priority: 50, auto_go: false });
          const newConfig: SessionConfig = {
            name, type: "claude", path: resolvedPath, command: undefined,
            auto_go: false, priority: 50, depends_on: [], headless: false,
            env: {}, health: undefined, max_restarts: 3, restart_backoff_s: 5,
            enabled: true, bare: false,
          };
          this.config.sessions.push(newConfig);
          configByPath.set(resolvedPath, newConfig);
          recentClaude.push({ config: newConfig, rank: rank++ });
        }
      }
    }

    // --- Phase 2: Named sessions (user-renamed via /rename, resumed by session_id) ---
    const registeredIds = new Set<string>();
    // Check existing config/registry for already-registered named sessions
    for (const s of this.config.sessions) {
      if (s.session_id) registeredIds.add(s.session_id);
    }

    for (const named of namedSessions) {
      if (rank >= visible) break;
      if (registeredIds.has(named.session_id)) continue;

      const resolvedPath = resolve(named.path);
      // Sanitize title to valid session name
      const titleName = named.title.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
      if (!titleName || !isValidName(titleName)) continue;

      // Check name conflicts — suffix if needed
      const existingNames = this.config.sessions.map((s) => s.name);
      const sessionName = existingNames.includes(titleName)
        ? nextSuffix(titleName, existingNames.filter((n) => n === titleName || n.match(new RegExp(`^${titleName}-\\d+$`))))
        : titleName;

      this.registry.add({
        name: sessionName, path: resolvedPath, priority: 50,
        auto_go: false, session_id: named.session_id,
      });

      const newConfig: SessionConfig = {
        name: sessionName, type: "claude", path: resolvedPath, command: undefined,
        auto_go: false, priority: 50, depends_on: [], headless: false,
        env: {}, health: undefined, max_restarts: 3, restart_backoff_s: 5,
        enabled: true, bare: false, session_id: named.session_id,
      };
      this.config.sessions.push(newConfig);
      registeredIds.add(named.session_id);
      recentClaude.push({ config: newConfig, rank: rank++ });
    }

    // Partition claude sessions: auto-start vs visible-only vs hidden
    const autoStartNames = new Set<string>();
    const visibleNames = new Set<string>();

    for (const { config, rank: r } of recentClaude) {
      if (r < auto_start) {
        autoStartNames.add(config.name);
      } else if (r < visible) {
        visibleNames.add(config.name);
      }
    }

    // Disable claude sessions not in auto-start set
    for (const s of this.config.sessions) {
      if (s.type !== "claude") continue;
      if (autoStartNames.has(s.name)) continue;
      if (visibleNames.has(s.name)) {
        s.enabled = false;
        continue;
      }
      if (!autoStartNames.has(s.name)) {
        s.enabled = false;
      }
    }

    // Re-init state entries for any newly added sessions
    this.state.initFromConfig(this.config.sessions);

    this.log.info(`Boot recency: auto-start=[${[...autoStartNames].join(",")}] ` +
      `visible=[${[...visibleNames].join(",")}]`);
  }

  /**
   * Fuzzy-match a name/fragment to a project path for `operad open`.
   * Checks config sessions, registry, and recent history (in that order).
   * Supports exact, prefix, and substring matching.
   */
  private resolveOpenTarget(input: string): string | null {
    const lower = input.toLowerCase();

    // 1. Exact match against config session names
    const configExact = this.config.sessions.find((s) => s.name === lower && s.path);
    if (configExact?.path) return resolve(configExact.path);

    // 2. Exact match against registry entries
    const regExact = this.registry.find(lower);
    if (regExact) return regExact.path;

    // 3. Search recent projects from history.jsonl
    const home = homedir();
    const historyPath = join(home, ".claude", "history.jsonl");
    const recent = parseRecentProjects(historyPath, 1000);

    // Exact name match in recent
    const recentExact = recent.find((p) => p.name === lower);
    if (recentExact) return recentExact.path;

    // 4. Prefix match across all sources
    const allSources: Array<{ name: string; path: string }> = [
      ...this.config.sessions.filter((s) => s.path).map((s) => ({ name: s.name, path: s.path! })),
      ...this.registry.entries().map((e) => ({ name: e.name, path: e.path })),
      ...recent,
    ];

    const prefixMatches = allSources.filter((s) => s.name.startsWith(lower));
    if (prefixMatches.length === 1) return resolve(prefixMatches[0].path);

    // 5. Substring match
    const substringMatches = allSources.filter((s) => s.name.includes(lower));
    if (substringMatches.length === 1) return resolve(substringMatches[0].path);

    // Multiple matches — pick the first (most recent from history, or config order)
    if (prefixMatches.length > 0) return resolve(prefixMatches[0].path);
    if (substringMatches.length > 0) return resolve(substringMatches[0].path);

    return null;
  }

  /** Open command — register and start a new dynamic Claude session (supports multi-instance) */
  private async cmdOpen(path: string, name?: string, autoGo = false, priority = 50): Promise<IpcResponse> {
    let resolvedPath: string;

    if (existsSync(path)) {
      resolvedPath = resolve(path);
    } else {
      // Not a valid path — fuzzy match against session names and recent projects
      const matched = this.resolveOpenTarget(path);
      if (!matched) {
        return { ok: false, error: `No project matching '${path}' found in config or recent history` };
      }
      resolvedPath = matched;
    }
    const baseName = name ?? deriveName(path);
    if (!isValidName(baseName)) {
      return { ok: false, error: `Invalid session name '${baseName}' — must match [a-z0-9-]+` };
    }

    // Check if any session already exists for this path — if so, create a suffixed instance
    const existingByPath = this.config.sessions.filter(
      (s) => s.path && resolve(s.path) === resolvedPath,
    );

    let sessionName: string;
    if (existingByPath.length === 0) {
      // First instance — check for name conflict only
      const nameConflict = this.config.sessions.find((s) => s.name === baseName);
      if (nameConflict) {
        return { ok: false, error: `Name '${baseName}' conflicts with an existing session at a different path` };
      }
      sessionName = baseName;
    } else {
      // Multi-instance — find next available suffix
      const pattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-\\d+)?$`);
      const existingNames = this.config.sessions
        .filter((s) => pattern.test(s.name))
        .map((s) => s.name);
      sessionName = nextSuffix(baseName, existingNames);
    }

    // Add to registry
    const entry = this.registry.add({ name: sessionName, path: resolvedPath, priority, auto_go: autoGo });
    if (!entry) {
      return { ok: false, error: `Failed to register session '${sessionName}'` };
    }

    // Create SessionConfig and merge into live config
    const sessionConfig: SessionConfig = {
      name: sessionName,
      type: "claude",
      path: entry.path,
      command: undefined,
      auto_go: autoGo,
      priority,
      depends_on: [],
      headless: false,
      env: {},
      health: undefined,
      max_restarts: 3,
      restart_backoff_s: 5,
      enabled: true,
      bare: false,
    };
    this.config.sessions.push(sessionConfig);
    this.state.initFromConfig(this.config.sessions);

    // Start the session
    const started = await this.startSession(sessionName);
    this.log.info(`Opened session '${sessionName}' at ${entry.path}`, { session: sessionName });

    return {
      ok: true,
      data: `Opened '${sessionName}' (${entry.path})${started ? " — started" : " — registered but not started"}`,
    };
  }

  /** Close command — stop and unregister a dynamic session */
  private async cmdClose(name: string): Promise<IpcResponse> {
    const resolved = this.resolveName(name);
    if (!resolved) return { ok: false, error: `Unknown session: ${name}` };

    // Stop the session if it's running
    await this.stopSessionByName(resolved);

    // Remove from registry if dynamically opened
    const regEntry = this.registry.find(resolved);
    if (regEntry) {
      this.registry.remove(resolved);
    }

    // Remove from live session list (config sessions reappear on next boot)
    this.config.sessions = this.config.sessions.filter((s) => s.name !== resolved);

    // Remove session state so it vanishes from dashboard immediately
    this.state.removeSession(resolved);

    this.log.info(`Closed session '${resolved}'`, { session: resolved });
    return { ok: true, data: `Closed '${resolved}'` };
  }

  /** Recent command — parse history.jsonl for recently active projects */
  private cmdRecent(count = 20): IpcResponse {
    const home = homedir();
    const historyPath = join(home, ".claude", "history.jsonl");
    const rawProjects = parseRecentProjects(historyPath, 1000);

    // Enrich with running/registered/config status
    const configNames = new Set(this.config.sessions.map((s) => s.name));
    const runningNames = new Set<string>();
    for (const s of Object.values(this.state.getState().sessions)) {
      if (s.status === "running" || s.status === "degraded" || s.status === "starting") {
        runningNames.add(s.name);
      }
    }

    const results: RecentProject[] = rawProjects.slice(0, count).map((p) => {
      // Try to match by derived name or by path
      const matchedConfig = this.config.sessions.find((s) => s.path === p.path);
      const matchedName = matchedConfig?.name ?? p.name;

      let status: RecentProject["status"] = "untracked";
      if (runningNames.has(matchedName)) {
        status = "running";
      } else if (this.registry.find(matchedName) || this.registry.findByPath(p.path)) {
        status = "registered";
      } else if (configNames.has(matchedName) || matchedConfig) {
        status = "config";
      }

      return {
        name: matchedName,
        path: p.path,
        last_active: p.last_active,
        session_id: p.session_id,
        status,
      };
    });

    // Merge registry-only entries that don't appear in history.jsonl
    const existingPaths = new Set(results.map((r) => r.path));
    for (const entry of this.registry.entries()) {
      if (existingPaths.has(entry.path)) continue;
      const status: RecentProject["status"] = runningNames.has(entry.name) ? "running" : "registered";
      results.push({
        name: entry.name,
        path: entry.path,
        last_active: entry.last_active,
        session_id: entry.session_id ?? "",
        status,
      });
    }

    // Re-sort combined list by last_active descending
    results.sort((a, b) => new Date(b.last_active).getTime() - new Date(a.last_active).getTime());

    return { ok: true, data: results.slice(0, count) };
  }

  /** Register projects by scanning a directory (default ~/git) */
  private cmdRegister(scanPath?: string): IpcResponse {
    const home = homedir();
    const dirPath = resolve(scanPath ?? join(home, "git"));

    if (!existsSync(dirPath)) {
      return { ok: false, error: `Directory not found: ${dirPath}` };
    }

    // Read all entries, filter to directories, sort by mtime descending
    let entries: Array<{ name: string; path: string; mtime: number }>;
    try {
      const names = readdirSync(dirPath);
      entries = names
        .filter((n) => !n.startsWith(".")) // skip hidden dirs
        .map((n) => {
          const full = join(dirPath, n);
          try {
            const st = statSync(full);
            if (!st.isDirectory()) return null;
            return { name: n, path: full, mtime: st.mtimeMs };
          } catch { /* stat failed — skip entry */ return null; }
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);
      entries.sort((a, b) => b.mtime - a.mtime);
    } catch (err) {
      return { ok: false, error: `Failed to scan ${dirPath}: ${err}` };
    }

    // Collect existing names for suffix dedup
    const existingNames = [
      ...this.config.sessions.map((s) => s.name),
      ...this.registry.entries().map((e) => e.name),
    ];

    const registered: string[] = [];
    let skipped = 0;
    for (const entry of entries) {
      // Skip if already in config or registry by path
      if (this.config.sessions.find((s) => s.path === entry.path)) { skipped++; continue; }
      if (this.registry.findByPath(entry.path)) { skipped++; continue; }

      let name = deriveName(entry.path);
      if (existingNames.includes(name)) {
        name = nextSuffix(name, existingNames);
      }

      const added = this.registry.add({ name, path: entry.path, priority: 50, auto_go: false });
      if (added) {
        registered.push(name);
        existingNames.push(name);
      } else {
        skipped++;
      }
    }

    this.log.info(`Register: ${registered.length} added, ${skipped} skipped from ${dirPath}`);
    return { ok: true, data: { registered, skipped, total: entries.length } };
  }

  /** Clone a git repo and register it */
  private cmdClone(url: string, nameOverride?: string): IpcResponse {
    const home = homedir();
    const gitDir = join(home, "git");

    // Derive target dir name from URL: strip trailing .git, take basename
    const urlBasename = url.replace(/\.git$/, "").split("/").pop() ?? "unnamed";
    const dirName = nameOverride ?? urlBasename.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const targetDir = join(gitDir, dirName);

    if (existsSync(targetDir)) {
      // Dir exists — just register it if not already registered
      if (this.registry.findByPath(targetDir)) {
        return { ok: true, data: { name: dirName, path: targetDir, message: "Already registered" } };
      }
      const existingNames = [
        ...this.config.sessions.map((s) => s.name),
        ...this.registry.entries().map((e) => e.name),
      ];
      let name = deriveName(targetDir);
      if (existingNames.includes(name)) name = nextSuffix(name, existingNames);
      this.registry.add({ name, path: targetDir, priority: 50, auto_go: false });
      return { ok: true, data: { name, path: targetDir, message: "Existing dir registered" } };
    }

    // Clone the repo
    if (!existsSync(gitDir)) mkdirSync(gitDir, { recursive: true });
    const result = spawnSync("git", ["clone", url, targetDir], {
      timeout: 120_000,
      stdio: "pipe",
      env: process.env,
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim() ?? "Unknown error";
      return { ok: false, error: `git clone failed: ${stderr}` };
    }

    // Register the cloned dir
    const existingNames = [
      ...this.config.sessions.map((s) => s.name),
      ...this.registry.entries().map((e) => e.name),
    ];
    let name = deriveName(targetDir);
    if (existingNames.includes(name)) name = nextSuffix(name, existingNames);
    this.registry.add({ name, path: targetDir, priority: 50, auto_go: false });

    this.log.info(`Cloned ${url} → ${targetDir} as '${name}'`);
    return { ok: true, data: { name, path: targetDir } };
  }

  /** Create a new project directory, git init, and register it */
  private cmdCreate(name: string): IpcResponse {
    if (!isValidName(name)) {
      return { ok: false, error: `Invalid name '${name}' — must match [a-z0-9-]+` };
    }

    const home = homedir();
    const targetDir = join(home, "git", name);

    if (existsSync(targetDir)) {
      return { ok: false, error: `Directory already exists: ${targetDir}` };
    }

    mkdirSync(targetDir, { recursive: true });
    spawnSync("git", ["init"], { cwd: targetDir, timeout: 10_000, stdio: "pipe" });

    // Register the new dir
    const existingNames = [
      ...this.config.sessions.map((s) => s.name),
      ...this.registry.entries().map((e) => e.name),
    ];
    let regName = name;
    if (existingNames.includes(regName)) regName = nextSuffix(regName, existingNames);
    this.registry.add({ name: regName, path: targetDir, priority: 50, auto_go: false });

    this.log.info(`Created project '${regName}' at ${targetDir}`);
    return { ok: true, data: { name: regName, path: targetDir } };
  }

  // -- Session suspension (SIGSTOP/SIGCONT) ------------------------------------

  /** Suspend a single session by name — freezes all processes via SIGSTOP */
  private cmdSuspend(name: string): IpcResponse {
    const resolved = this.resolveName(name);
    if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
    const s = this.state.getSession(resolved);
    if (!s) return { ok: false, error: `No state for session: ${resolved}` };
    if (s.suspended) return { ok: true, data: `'${resolved}' already suspended` };
    if (s.status !== "running" && s.status !== "degraded") {
      return { ok: false, error: `Cannot suspend '${resolved}' — status is ${s.status}` };
    }
    const ok = suspendSession(resolved, this.log);
    if (ok) {
      this.state.setSuspended(resolved, true);
      this.updateStatusNotification();
      this.pushSseState();
    }
    return { ok, data: ok ? `Suspended '${resolved}'` : `Failed to suspend '${resolved}'` };
  }

  /** Resume a single suspended session — unfreezes processes via SIGCONT */
  private cmdResume(name: string): IpcResponse {
    const resolved = this.resolveName(name);
    if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
    const s = this.state.getSession(resolved);
    if (!s) return { ok: false, error: `No state for session: ${resolved}` };
    if (!s.suspended) return { ok: true, data: `'${resolved}' not suspended` };
    const ok = resumeSession(resolved, this.log);
    if (ok) {
      this.state.setSuspended(resolved, false);
      this.updateStatusNotification();
      this.pushSseState();
    }
    return { ok, data: ok ? `Resumed '${resolved}'` : `Failed to resume '${resolved}'` };
  }

  /** Suspend all sessions except the named one — "make room" for a heavy build */
  private cmdSuspendOthers(name: string): IpcResponse {
    const resolved = this.resolveName(name);
    if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
    const sessions = this.state.getState().sessions;
    let suspended = 0;
    for (const [sName, s] of Object.entries(sessions)) {
      if (sName === resolved) continue;
      if (s.suspended) continue;
      if (s.status !== "running" && s.status !== "degraded") continue;
      if (suspendSession(sName, this.log)) {
        this.state.setSuspended(sName, true);
        suspended++;
      }
    }
    this.updateStatusNotification();
    this.pushSseState();
    return { ok: true, data: `Suspended ${suspended} sessions (except '${resolved}')` };
  }

  /** Suspend all running sessions */
  private cmdSuspendAll(): IpcResponse {
    const sessions = this.state.getState().sessions;
    let suspended = 0;
    for (const [sName, s] of Object.entries(sessions)) {
      if (s.suspended) continue;
      if (s.status !== "running" && s.status !== "degraded") continue;
      if (suspendSession(sName, this.log)) {
        this.state.setSuspended(sName, true);
        suspended++;
      }
    }
    this.updateStatusNotification();
    this.pushSseState();
    return { ok: true, data: `Suspended ${suspended} sessions` };
  }

  /** Resume all suspended sessions */
  private cmdResumeAll(): IpcResponse {
    const sessions = this.state.getState().sessions;
    let resumed = 0;
    for (const [sName, s] of Object.entries(sessions)) {
      if (!s.suspended) continue;
      if (resumeSession(sName, this.log)) {
        this.state.setSuspended(sName, false);
        resumed++;
      }
    }
    this.updateStatusNotification();
    this.pushSseState();
    return { ok: true, data: `Resumed ${resumed} sessions` };
  }

  // -- Battery monitoring ------------------------------------------------------

  /** Start periodic battery monitoring timer */
  private startBatteryTimer(): void {
    if (!this.config.battery.enabled) {
      this.log.debug("Battery monitoring disabled");
      return;
    }
    if (this.batteryTimer) clearInterval(this.batteryTimer);
    const intervalMs = this.config.battery.poll_interval_s * 1000;
    this.batteryTimer = setInterval(() => {
      this.batteryPoll();
    }, intervalMs);
    // Delay initial poll by 5s so it doesn't block IPC server startup.
    // termux-battery-status is synchronous (~5-8s) and blocks the event loop.
    setTimeout(() => this.batteryPoll(), 5000);
  }

  /** Poll battery status, take action if critically low */
  private batteryPoll(): void {
    trace("battery:poll");
    const prevActive = this.battery.actionsActive;
    const status = this.battery.checkAndAct();
    if (!status) return;

    // Log battery_low notification when actions first trigger
    if (this.battery.actionsActive && !prevActive) {
      appendNotification({ type: "battery_low", title: "Battery critically low", content: `${status.percentage}%, not charging — radios disabled` });
      if (this.dashboard && this.dashboard.sseClientCount > 0) {
        this.dashboard.pushEvent("notification", { type: "battery_low", title: "Battery critically low", content: `${status.percentage}%` });
      }
    }

    // Update state for dashboard/status display
    this.state.updateBattery({
      percentage: status.percentage,
      charging: status.charging,
      temperature: status.temperature,
      radios_disabled: this.battery.actionsActive,
    });
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
      (method, path, body) => this.serverEngine.handleDashboardApi(method, path, body),
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
      this.scheduleEngine = new ScheduleEngine(this.memoryDb, this.log, async (schedule) => {
        return this.executeScheduledRun(schedule);
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

      // Wire WS message handler — dispatched via ServerEngine
      this.dashboard.setWsMessageHandler((ws, msg, rooms) => {
        this.serverEngine.handleWsMessage(ws, msg).catch((err) => {
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

  /** Reload agent configs from all sources and update SDK bridge */
  private reloadAgents(): void {
    const projectPaths = this.config.sessions
      .filter((s) => s.path)
      .map((s) => s.path!);
    this.agentConfigs = loadAgents(this.config.agents ?? [], projectPaths);

    // Ensure all known agents appear in switchboard (default: true = follow agent.enabled)
    for (const agent of this.agentConfigs) {
      if (!(agent.name in this.switchboard.agents)) {
        this.switchboard.agents[agent.name] = true;
      }
    }

    // Apply switchboard overrides: master switch + per-agent toggles
    const enabledAgents = this.agentConfigs.filter((a) => this.serverEngine.isAgentEnabled(a.name));
    if (this.sdkBridge) {
      this.sdkBridge.updateAgents(toSdkAgentMap(enabledAgents));
    }

    // Seed default specializations for builtin agents (idempotent — upsert won't overwrite)
    this.seedSpecializations();

    this.log.info(`Reloaded agents: ${enabledAgents.length} enabled`);
  }

  /** Seed default specializations for builtin agents (upsert is idempotent) */
  private seedSpecializations(): void {
    if (!this.memoryDb) return;

    const defaults: Record<string, string[]> = {
      "optimizer": ["performance", "resource-management", "token-efficiency"],
      "preference-learner": ["user-preferences", "coding-style", "communication"],
      "ideator": ["architecture", "creative-solutions", "exploration"],
      "master-controller": ["orchestration", "planning", "delegation"],
    };

    for (const [agent, domains] of Object.entries(defaults)) {
      // Only seed if agent is actually loaded
      if (!this.agentConfigs.some((a) => a.name === agent)) continue;
      for (const domain of domains) {
        try {
          // upsert with low confidence — will be reinforced by actual evidence
          this.memoryDb.upsertSpecialization(agent, domain, 0.5, "builtin default");
        } catch {
          // Table may not exist during first migration — silently skip
        }
      }
    }
  }

  // buildAgentContext, extractAgentActions, handleStandaloneAgentRun,
  // handleAgentChat — moved to AgentEngine (src/agent-engine.ts)

  // executeOodaActions — moved to AgentEngine (src/agent-engine.ts)
  // executeRoundtable — moved to AgentEngine (src/agent-engine.ts)

  /**
   * Execute a scheduled agent run. Called by ScheduleEngine when a schedule fires.
   * Returns success/failure and cost for schedule bookkeeping.
   */
  private async executeScheduledRun(schedule: ScheduleRecord): Promise<{ success: boolean; costUsd?: number }> {
    if (!this.sdkBridge || !this.memoryDb) return { success: false };
    if (this.sdkBridge.isAttached || this.sdkBridge.isBusy) {
      this.log.debug(`Scheduled run "${schedule.schedule_name}" deferred — SDK busy`);
      return { success: false };
    }

    // Quota check: don't run if exceeded
    const quota = computeQuotaStatus(this.memoryDb, this.config.orchestrator);
    if (quota.weekly_level === "exceeded") {
      this.log.warn(`Scheduled run "${schedule.schedule_name}" blocked — quota exceeded`);
      return { success: false };
    }

    const agent = this.agentConfigs.find((a) => a.name === schedule.agent_name && a.enabled);
    if (!agent) {
      this.log.warn(`Scheduled run "${schedule.schedule_name}" — agent "${schedule.agent_name}" not found/enabled`);
      return { success: false };
    }

    const sdkDef = toSdkAgentMap([agent])[schedule.agent_name];
    const cwd = this.config.sessions.find((s) => s.path)?.path ?? homedir();
    const budget = schedule.max_budget_usd ?? agent.max_budget_usd;
    const runId = this.memoryDb.startAgentRun(schedule.agent_name, `schedule:${schedule.schedule_name}`, "standalone");

    try {
      const result = await this.sdkBridge.runStandaloneAgent(
        schedule.agent_name, sdkDef, cwd, schedule.prompt, budget,
      );

      this.memoryDb.completeAgentRun(runId, "completed", {
        sessionId: result.sessionId,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        turns: result.turns,
      });

      // Parse and execute any actions from the response
      if (result.responseText) {
        const actions = parseOodaResponse(result.responseText);
        if (actions.length > 0) {
          await this.agentEngine.executeOodaActions(actions);
        }
        this.agentEngine.extractAgentActions(schedule.agent_name, result.responseText);
      }

      // Trust reward for successful scheduled run
      this.memoryDb.recordTrustDelta(schedule.agent_name, 10, `scheduled run "${schedule.schedule_name}" completed`);

      this.log.info(`Scheduled run "${schedule.schedule_name}" completed: cost=$${result.costUsd.toFixed(4)}`);
      return { success: true, costUsd: result.costUsd };
    } catch (err) {
      this.memoryDb.completeAgentRun(runId, "failed", { error: String(err) });
      this.memoryDb.recordTrustDelta(schedule.agent_name, -15, `scheduled run "${schedule.schedule_name}" failed: ${err}`);
      this.log.warn(`Scheduled run "${schedule.schedule_name}" failed: ${err}`);
      return { success: false };
    }
  }

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


  /** Load auto-stop package list from disk */
  private loadAutoStopList(): void {
    try {
      const raw = readFileSync(Daemon.AUTOSTOP_PATH, "utf-8");
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        this.autoStopPkgs = new Set(list.filter((s: unknown) => typeof s === "string"));
      }
    } catch {
      // File doesn't exist or is invalid — start empty
      this.autoStopPkgs = new Set();
    }
  }

  /** Persist auto-stop package list to disk */
  private saveAutoStopList(): void {
    try {
      writeFileSync(Daemon.AUTOSTOP_PATH, JSON.stringify([...this.autoStopPkgs], null, 2) + "\n");
    } catch (err) {
      this.log.warn("Failed to save autostop list", { error: String(err) });
    }
  }

  /** Get auto-stop list for API */
  private getAutoStopList(): { packages: string[] } {
    return { packages: [...this.autoStopPkgs] };
  }

  /** Toggle a package in the auto-stop list */
  private toggleAutoStop(pkg: string): { status: number; data: unknown } {
    if (!pkg || !pkg.includes(".")) {
      return { status: 400, data: { error: "Invalid package name" } };
    }
    if (Daemon.SYSTEM_PACKAGES.has(pkg)) {
      return { status: 403, data: { error: `Cannot auto-stop system package: ${pkg}` } };
    }
    const enabled = !this.autoStopPkgs.has(pkg);
    if (enabled) {
      this.autoStopPkgs.add(pkg);
    } else {
      this.autoStopPkgs.delete(pkg);
    }
    this.saveAutoStopList();
    this.log.info(`Auto-stop ${enabled ? "enabled" : "disabled"} for ${pkg}`);
    return { status: 200, data: { pkg, autostop: enabled } };
  }

  /** Force-stop all auto-stop flagged apps (called during memory pressure) */
  private autoStopFlaggedApps(): void {
    if (this.autoStopPkgs.size === 0) return;
    const stopped: string[] = [];
    for (const pkg of this.autoStopPkgs) {
      if (Daemon.SYSTEM_PACKAGES.has(pkg)) continue;
      try {
        const result = spawnSync(ADB_BIN, this.adbShellArgs("am", "force-stop", pkg), {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.status === 0) stopped.push(pkg);
      } catch {
        // Best-effort — skip failures
      }
    }
    if (stopped.length > 0) {
      const labels = stopped.map((p) => Daemon.APP_LABELS[p] || p);
      this.log.info(`Auto-stopped ${labels.join(", ")} on memory pressure`);
    }
  }

  // -- Android app management -------------------------------------------------

  /** Well-known system packages that should not be force-stopped */
  private static readonly SYSTEM_PACKAGES = new Set([
    "system_server", "com.android.systemui", "com.google.android.gms.persistent",
    "com.termux", "com.termux.api", "com.sec.android.app.launcher",
    "com.android.phone", "com.android.providers.media",
    "com.samsung.android.providers.media", "com.google.android.gms",
    "com.android.bluetooth", "com.google.android.ext.services",
    "com.google.android.providers.media.module", "android.process.acore",
    "com.samsung.android.scs", "com.samsung.android.sead",
    "com.samsung.android.scpm", "com.sec.android.sdhms",
  ]);

  /** Friendly display names for known packages */
  private static readonly APP_LABELS: Record<string, string> = {
    "com.microsoft.emmx.canary": "Edge Canary",
    "com.microsoft.emmx": "Edge",
    "com.android.chrome": "Chrome",
    "com.discord": "Discord",
    "com.Slack": "Slack",
    "com.google.android.gm": "Gmail",
    "com.google.android.apps.photos": "Photos",
    "com.google.android.apps.chromecast.app": "Google Home",
    "com.google.android.apps.maps": "Maps",
    "com.google.android.apps.docs": "Drive",
    "com.google.android.apps.youtube": "YouTube",
    "com.google.android.apps.messaging": "Messages",
    "com.google.android.calendar": "Calendar",
    "com.google.android.googlequicksearchbox": "Google",
    "com.google.android.gms": "Play Services",
    "com.google.android.gms.persistent": "Play Services",
    "com.ubercab.eats": "Uber Eats",
    "com.samsung.android.app.spage": "Samsung Free",
    "com.samsung.android.smartsuggestions": "Smart Suggest",
    "com.samsung.android.incallui": "Phone",
    "com.samsung.android.messaging": "Samsung Messages",
    "com.samsung.android.spay": "Samsung Pay",
    "com.sec.android.daemonapp": "Weather",
    "com.sec.android.app.sbrowser": "Samsung Internet",
    "net.slickdeals.android": "Slickdeals",
    "dev.imranr.obtainium": "Obtainium",
    "com.teslacoilsw.launcher": "Nova Launcher",
    "com.sec.android.app.launcher": "One UI Home",
    "com.android.systemui": "System UI",
    "com.android.settings": "Settings",
    "com.android.vending": "Play Store",
    "com.termux": "Termux",
    "com.termux.api": "Termux:API",
    "tribixbite.cleverkeys": "CleverKeys",
    "com.microsoft.appmanager": "Link to Windows",
    "com.google.android.apps.nbu.files": "Files by Google",
    "com.reddit.frontpage": "Reddit",
    "io.homeassistant.companion.android": "Home Assistant",
    "com.adguard.android.contentblocker": "AdGuard",
    "com.samsung.android.app.smartcapture": "Smart Select",
    "com.samsung.android.app.routines": "Routines",
    "com.samsung.android.rubin.app": "Customization",
    "com.samsung.android.app.moments": "Memories",
    "com.samsung.android.ce": "Samsung Cloud",
    "com.samsung.android.mdx": "Link to Windows",
    "com.samsung.euicc": "SIM Manager",
    "com.sec.imsservice": "IMS Service",
    "com.sec.android.app.clockpackage": "Clock",
    "com.samsung.cmh": "Connected Home",
    "com.samsung.android.kmxservice": "Knox",
    "com.samsung.android.stplatform": "SmartThings",
    "com.samsung.android.service.stplatform": "SmartThings",
    "com.google.android.gms.unstable": "Play Services",
    "com.google.android.as.oss": "Private Compute",
    "com.google.android.cellbroadcastreceiver": "Emergency Alerts",
    "com.sec.android.app.chromecustomizations": "Chrome Custom",
    "org.mopria.printplugin": "Print Service",
    "com.samsung.android.samsungpositioning": "Location",
    "com.google.android.providers.media.module": "Media Storage",
  };

  /**
   * List Android apps via `adb shell ps`, grouped by base package.
   * Merges sandboxed/privileged child processes into the parent total.
   */
  private getAndroidApps(): { pkg: string; label: string; rss_mb: number; system: boolean; autostop: boolean }[] {
    try {
      const result = spawnSync(ADB_BIN, this.adbShellArgs("ps", "-A", "-o", "PID,RSS,NAME"), {
        encoding: "utf-8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0 || !result.stdout) {
        this.log.warn("adb ps failed", {
          status: result.status,
          stderr: result.stderr?.trim().slice(0, 200),
          hasStdout: !!result.stdout,
          args: this.adbShellArgs("ps", "-A", "-o", "PID,RSS,NAME").join(" "),
        });
        return [];
      }

      // Aggregate RSS by base package name (strip :sandboxed_process*, :privileged_process*, etc.)
      const pkgMap = new Map<string, number>();
      for (const line of result.stdout.trim().split("\n")) {
        const match = line.trim().match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) continue;
        const rssKb = parseInt(match[2], 10);
        const rawName = match[3].trim();
        if (rssKb < 1024) continue; // Skip < 1MB (aggregate later)

        // Extract base package: "com.foo.bar:sandboxed_process0:..." → "com.foo.bar"
        const basePkg = rawName.split(":")[0];
        // Only include Android package names (at least 2 dots, e.g. com.foo.bar)
        const dotCount = (basePkg.match(/\./g) || []).length;
        if (dotCount < 2 && !Daemon.APP_LABELS[basePkg]) continue;
        // Skip zygote/isolated processes — they're OS-level, not user apps
        if (basePkg.endsWith("_zygote") || basePkg.startsWith("com.android.isolated")) continue;

        pkgMap.set(basePkg, (pkgMap.get(basePkg) ?? 0) + rssKb);
      }

      const apps: { pkg: string; label: string; rss_mb: number; system: boolean; autostop: boolean }[] = [];
      for (const [pkg, rssKb] of pkgMap) {
        const rssMb = Math.round(rssKb / 1024);
        if (rssMb < 50) continue; // Skip apps using < 50MB after aggregation
        const system = Daemon.SYSTEM_PACKAGES.has(pkg);
        // Derive a readable label: known name > last meaningful segment > raw package
        const label = Daemon.APP_LABELS[pkg] ?? Daemon.deriveLabel(pkg);
        apps.push({ pkg, label, rss_mb: rssMb, system, autostop: this.autoStopPkgs.has(pkg) });
      }

      apps.sort((a, b) => b.rss_mb - a.rss_mb);
      return apps;
    } catch (err) {
      this.log.warn("getAndroidApps exception", { error: String(err) });
      return [];
    }
  }

  /** Derive a human-readable label from a package name */
  private static deriveLabel(pkg: string): string {
    const parts = pkg.split(".");
    // Skip common prefixes: com, org, net, android, google, samsung, sec, app, apps
    const skip = new Set(["com", "org", "net", "android", "google", "samsung", "sec", "app", "apps", "software"]);
    const meaningful = parts.filter((p) => !skip.has(p) && p.length > 1);
    // Capitalize the last meaningful segment
    const name = meaningful.length > 0 ? meaningful[meaningful.length - 1] : parts[parts.length - 1];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  /** Force-stop an Android app via ADB */
  private forceStopApp(pkg: string): { status: number; data: unknown } {
    if (!pkg || !pkg.includes(".")) {
      return { status: 400, data: { error: "Invalid package name" } };
    }
    if (Daemon.SYSTEM_PACKAGES.has(pkg)) {
      return { status: 403, data: { error: `Cannot stop system package: ${pkg}` } };
    }

    try {
      const result = spawnSync(ADB_BIN, this.adbShellArgs("am", "force-stop", pkg), {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        return { status: 500, data: { error: result.stderr?.trim() || "force-stop failed" } };
      }
      this.log.info(`Force-stopped ${pkg} via dashboard`);
      return { status: 200, data: { ok: true, pkg } };
    } catch (err) {
      return { status: 500, data: { error: `Failed to stop ${pkg}: ${(err as Error).message}` } };
    }
  }

  // -- ADB device management --------------------------------------------------
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

  /** Status command — return session states and daemon info */
  private cmdStatus(name?: string): IpcResponse {
    const state = this.state.getState();

    if (name) {
      const resolved = this.resolveName(name);
      if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
      const s = state.sessions[resolved];
      if (!s) return { ok: false, error: `No state for session: ${resolved}` };
      return { ok: true, data: { session: s, config: this.config.sessions.find((c) => c.name === resolved) } };
    }

    return {
      ok: true,
      data: {
        daemon_start: state.daemon_start,
        boot_complete: state.boot_complete,
        adb_fixed: state.adb_fixed,
        procs: this.budget.check(),
        wake_lock: this.wake.isHeld(),
        memory: state.memory ?? null,
        battery: state.battery ?? null,
        quota: this.memoryDb ? computeQuotaStatus(this.memoryDb, this.config.orchestrator) : null,
        trust: this.memoryDb ? this.agentConfigs.map((a) => {
          const { score, recommended } = this.memoryDb!.getRecommendedAutonomy(a.name);
          return { agent: a.name, score, recommended, current: a.autonomy_level ?? "observe" };
        }) : [],
        specializations: this.memoryDb ? (() => {
          try {
            const allSpecs = this.memoryDb!.getSpecializations();
            // Lightweight summary: top domain per agent
            const byAgent = new Map<string, { domain: string; confidence: number }>();
            for (const s of allSpecs) {
              const existing = byAgent.get(s.agent_name);
              if (!existing || s.confidence > existing.confidence) {
                byAgent.set(s.agent_name, { domain: s.domain, confidence: s.confidence });
              }
            }
            return Array.from(byAgent.entries()).map(([agent, top]) => ({
              agent, top_domain: top.domain, confidence: top.confidence,
            }));
          } catch { /* specializations table may not exist during first run */ return []; }
        })() : [],
        sessions: Object.values(state.sessions).map((s) => {
          const cfg = this.config.sessions.find((c) => c.name === s.name);
          return {
            ...s,
            type: cfg?.type ?? "daemon",
            path: cfg?.path ?? null,
            has_build_script: cfg?.path ? existsSync(join(cfg.path, "build-on-termux.sh")) : false,
            uptime: s.uptime_start ? formatUptime(new Date(s.uptime_start)) : null,
          };
        }),
      },
    };
  }

  /** Start command — start one or all sessions (re-enables boot-disabled sessions on demand) */
  private async cmdStart(name?: string): Promise<IpcResponse> {
    if (name) {
      const resolved = this.resolveName(name);
      if (!resolved) {
        // Not a loaded session — try fuzzy-matching to open it
        return this.cmdOpen(name);
      }
      // Re-enable if disabled by boot recency filtering (on-demand play)
      const sessionConfig = this.config.sessions.find((s) => s.name === resolved);
      if (sessionConfig && !sessionConfig.enabled) {
        sessionConfig.enabled = true;
        this.log.info(`Re-enabled session '${resolved}' for on-demand start`, { session: resolved });
      }
      const success = await this.startSession(resolved);
      return { ok: success, data: success ? `Started '${resolved}'` : `Failed to start '${resolved}'` };
    }
    await this.startAllSessions();
    return { ok: true, data: "All sessions started" };
  }

  /** Stop command — stop one or all sessions */
  private async cmdStop(name?: string): Promise<IpcResponse> {
    if (name) {
      const resolved = this.resolveName(name);
      if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
      const success = await this.stopSessionByName(resolved);
      return { ok: success, data: success ? `Stopped '${resolved}'` : `Failed to stop '${resolved}'` };
    }
    // Stop all in reverse dependency order
    const shutdownOrder = computeShutdownOrder(this.config.sessions);
    for (const batch of shutdownOrder) {
      await Promise.all(batch.sessions.map((n) => this.stopSessionByName(n)));
    }
    return { ok: true, data: "All sessions stopped" };
  }

  /** Restart command */
  private async cmdRestart(name?: string): Promise<IpcResponse> {
    if (name) {
      const resolved = this.resolveName(name);
      if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
      await this.stopSessionByName(resolved);
      await sleep(500);
      const success = await this.startSession(resolved);
      return { ok: success, data: success ? `Restarted '${resolved}'` : `Failed to restart '${resolved}'` };
    }
    await this.cmdStop();
    await sleep(500);
    return this.cmdStart();
  }

  /** Health command — run health sweep now */
  private cmdHealth(): IpcResponse {
    const results = runHealthSweep(this.config, this.state, this.log, this.adoptedPids);
    return { ok: true, data: results };
  }

  /** Memory command — return system memory + per-session RSS + pressure */
  private cmdMemory(): IpcResponse {
    const sysMem = this.memory.getSystemMemory();
    const sessions: Array<{ name: string; rss_mb: number | null; activity: string | null }> = [];

    for (const session of this.config.sessions) {
      const s = this.state.getSession(session.name);
      sessions.push({
        name: session.name,
        rss_mb: s?.rss_mb ?? null,
        activity: s?.activity ?? null,
      });
    }

    return {
      ok: true,
      data: {
        system: sysMem,
        sessions,
      },
    };
  }

  /** Go command — send "go" to a Claude session */
  private async cmdGo(name: string): Promise<IpcResponse> {
    const resolved = this.resolveName(name);
    if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
    const result = await sendGoToSession(resolved, this.log);
    const ok = result === "ready";
    return { ok, data: ok ? `Sent 'go' to '${resolved}'` : `Failed to send 'go' to '${resolved}' (${result})` };
  }

  /** Send command — send arbitrary text to a session */
  private cmdSend(name: string, text: string): IpcResponse {
    const resolved = this.resolveName(name);
    if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
    const sent = sendKeys(resolved, text, true);
    return { ok: sent, data: sent ? `Sent to '${resolved}'` : `Failed to send to '${resolved}'` };
  }

  /** Tabs command — create Termux UI tabs for sessions */
  private cmdTabs(names?: string[]): IpcResponse {
    const targetSessions = names?.length
      ? names.map((n) => this.resolveName(n)).filter((n): n is string => n !== null)
      : this.config.sessions
          .filter((s) => !s.headless && s.enabled)
          .map((s) => s.name);

    let restored = 0;
    let skipped = 0;

    for (let i = 0; i < targetSessions.length; i++) {
      const name = targetSessions[i];
      if (!sessionExists(name)) {
        skipped++;
        continue;
      }

      if (createTermuxTab(name, this.log)) {
        restored++;
      } else {
        skipped++;
      }

      // Stagger tab creation to avoid Termux UI race conditions.
      // TermuxService processes intents async — give each tab 1.5s to initialize.
      if (i < targetSessions.length - 1) {
        spawnSync("sleep", ["1.5"], { timeout: 3000 });
      }
    }

    return { ok: true, data: { restored, skipped, total: targetSessions.length } };
  }

  // -- Helpers ----------------------------------------------------------------

  /** Resolve session path from config or registry */
  private resolveSessionPath(sessionName: string): string | null {
    const resolved = this.resolveName(sessionName);
    if (!resolved) return null;
    const cfg = this.config.sessions.find((s: SessionConfig) => s.name === resolved);
    if (cfg?.path) return cfg.path;
    // Check registry for dynamically opened sessions
    for (const entry of this.registry.entries()) {
      if (entry.name === resolved && entry.path) return entry.path;
    }
    return null;
  }

  /** Fuzzy-match a session name (prefix match) */
  private resolveName(input: string): string | null {
    const names = this.config.sessions.map((s) => s.name);
    // Also check registry entries not yet merged into config
    for (const entry of this.registry.entries()) {
      if (!names.includes(entry.name)) names.push(entry.name);
    }
    // Exact match
    if (names.includes(input)) return input;
    // Prefix match
    const matches = names.filter((n) => n.startsWith(input));
    if (matches.length === 1) return matches[0];
    // Substring match
    const substringMatches = names.filter((n) => n.includes(input));
    if (substringMatches.length === 1) return substringMatches[0];
    return null;
  }
}

/** Format uptime as a human-readable string (e.g., "2h 15m") */
function formatUptime(start: Date): string {
  const ms = Date.now() - start.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
