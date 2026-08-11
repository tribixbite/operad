/**
 * fake-context.ts — In-process test harness for the daemon's DI surface.
 *
 * The transport handlers (RestHandler, IpcHandler, WsHandler), the route
 * modules under src/routes/, and the subsystem engines (ToolEngine,
 * PersistenceEngine, AgentEngine, MonitoringEngine) are all driven through
 * a single `OrchestratorContext` dependency object. In production that
 * object is assembled by Daemon; here we build a fully-typed fake so the
 * handlers can be exercised in-process WITHOUT spawning a real daemon.
 *
 * Why in-process matters: the e2e suite boots `dist/tmx.js` as a subprocess,
 * which gives genuine integration confidence but is INVISIBLE to
 * `bun test --coverage` (the coverage instrumenter only sees the test
 * process, not the child). Driving the handlers in-process both exercises
 * the routing/dispatch logic AND moves the coverage needle on the ~1900-line
 * rest-handler.ts and its siblings.
 *
 * Design:
 *   - Real, cheap building blocks where construction is trivial and the
 *     behaviour matters: TmxConfig (via loadConfig on a temp TOML),
 *     StateManager, Registry, and an optional in-temp-dir MemoryDb.
 *   - Duck-typed minimal fakes for the heavyweight IO subsystems
 *     (SdkBridge, TelemetrySink, ScheduleEngine, ...) — null by default,
 *     overridable per test.
 *   - Every cmd and lifecycle callback records its invocation into `calls` and
 *     returns a canned response, so tests can assert "the route delegated to
 *     cmdStart('foo')" without a live state machine.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../../config.js";
import { StateManager } from "../../state.js";
import { Registry } from "../../registry.js";
import { MemoryDb } from "../../memory-db.js";
import { BudgetTracker } from "../../budget.js";
import { WakeLockManager } from "../../wake.js";
import { MemoryMonitor } from "../../memory.js";
import { ConsumerTracker } from "../../skills/consumer-tracker.js";
import { defaultSwitchboard } from "../../types.js";
import { _setUserAgentsHome } from "../../agents.js";
import type { Logger } from "../../log.js";
import type { OrchestratorContext } from "../../orchestrator-context.js";
import type { TmxConfig, Switchboard, IpcResponse, SessionConfig } from "../../types.js";
import type { AgentConfig } from "../../agents.js";
import type { AgentEngine } from "../../agent-engine.js";

// ---------------------------------------------------------------------------
// Small shared fixtures
// ---------------------------------------------------------------------------

/** A Logger that discards everything — keeps test output clean. */
export function silentLog(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

/** A Logger that captures lines, for tests asserting on log output. */
export function capturingLog(): { log: Logger; lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  const mk = (level: string) => (msg: unknown) => lines.push({ level, msg: String(msg) });
  return {
    lines,
    log: { debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error") } as unknown as Logger,
  };
}

/** Build a fully-defaulted SessionConfig with sensible test defaults. */
export function makeSession(name: string, overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    name,
    type: "claude",
    path: `/tmp/${name}`,
    command: undefined,
    auto_go: false,
    cleanup_patterns: [],
    priority: 50,
    depends_on: [],
    headless: false,
    env: {},
    health: undefined,
    max_restarts: 3,
    restart_backoff_s: 5,
    enabled: true,
    bare: false,
    ...overrides,
  };
}

/**
 * A do-nothing AgentEngine fake whose method invocations are recorded into
 * `calls` (keyed by a short name). Use when a handler needs an AgentEngine
 * reference but the test isn't exercising agent logic itself.
 */
export function fakeAgentEngine(
  calls: Record<string, unknown[][]> = {},
): AgentEngine {
  const rec = (k: string) => (...a: unknown[]) => { (calls[k] ??= []).push(a); };
  return {
    handleStandaloneAgentRun: async (...a: unknown[]) => { rec("run")(...a); return {}; },
    handleAgentChat: async (...a: unknown[]) => { rec("chat")(...a); },
    handleStandaloneAgentRun_label: undefined,
    runOodaCycle: async () => { rec("ooda")(); },
    executeRoundtable: async (...a: unknown[]) => { rec("roundtable")(...a); return {}; },
    buildAgentContext: (...a: unknown[]) => { rec("ctx")(...a); return ""; },
    reloadAgents: () => { rec("reload")(); },
  } as unknown as AgentEngine;
}

/** Build a fully-defaulted AgentConfig. */
export function makeAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: `${name} test agent`,
    prompt: `You are ${name}.`,
    enabled: true,
    ...overrides,
  } as AgentConfig;
}

// ---------------------------------------------------------------------------
// Config — real TmxConfig from a temp TOML so defaults never drift
// ---------------------------------------------------------------------------

/**
 * Produce a real, fully-defaulted TmxConfig by writing a minimal TOML into
 * `dir` and running the production loader. Socket/state/log paths are pinned
 * inside `dir` so nothing touches the real per-user locations.
 */
export function makeConfig(dir: string, extraToml = ""): TmxConfig {
  const tomlPath = join(dir, "operad-test.toml");
  // TOML double-quoted strings treat "\" as an escape introducer, so a raw
  // Windows path (C:\Users\…) would be mangled/rejected by the parser. Forward
  // slashes are valid path separators on Windows too, so normalise before
  // interpolating — keeps the generated config valid on every platform.
  const p = dir.replace(/\\/g, "/");
  writeFileSync(
    tomlPath,
    `[operad]
socket = "${p}/operad.sock"
state_file = "${p}/state.json"
log_dir = "${p}/logs"
dashboard_port = 0
${extraToml}
`,
    "utf8",
  );
  return loadConfig(tomlPath);
}

// ---------------------------------------------------------------------------
// The fake context
// ---------------------------------------------------------------------------

export interface FakeContextOpts {
  /** Provide a pre-built config; otherwise a defaulted one is created. */
  config?: TmxConfig;
  /** Extra TOML appended to the generated config (e.g. [[session]] blocks). */
  extraToml?: string;
  /** Create a real MemoryDb in the temp dir (default false → getMemoryDb null). */
  withDb?: boolean;
  /** Seed the switchboard (merged over defaultSwitchboard()). */
  switchboard?: Partial<Switchboard>;
  /** Agent configs visible to the context. */
  agentConfigs?: AgentConfig[];
  /** Canned response per cmd* delegate, keyed by method name. */
  cmdResponses?: Partial<Record<string, IpcResponse>>;
  /** Lazy-getter fakes (default null / no-op). */
  sdkBridge?: unknown;
  telemetrySink?: unknown;
  scheduleEngine?: unknown;
  toolExecutor?: unknown;
  toolEngine?: unknown;
  workflowEngine?: unknown;
  skillManager?: unknown;
  dashboard?: unknown;
  /** Final field-level overrides applied last (escape hatch). */
  overrides?: Partial<OrchestratorContext>;
  /** Logger (default silent). */
  log?: Logger;
}

export interface FakeContext {
  ctx: OrchestratorContext;
  /** method name → list of argument arrays, in call order. */
  calls: Record<string, unknown[][]>;
  /** ws/broadcast events: { type, payload }. */
  broadcasts: { type: string; payload: unknown }[];
  switchboard: Switchboard;
  state: StateManager;
  registry: Registry;
  db: MemoryDb | null;
  dir: string;
  /** Remove the temp dir and close the db. */
  cleanup: () => void;
}

/**
 * Build a complete OrchestratorContext fake. Returns the ctx plus the live
 * recording structures (`calls`, `broadcasts`) and the real building blocks
 * (`state`, `registry`, `db`) so tests can both drive and inspect.
 *
 * Callers MUST invoke `cleanup()` in afterEach.
 */
export async function makeFakeContext(opts: FakeContextOpts = {}): Promise<FakeContext> {
  const dir = mkdtempSync(join(tmpdir(), "operad-ctx-"));
  const log = opts.log ?? silentLog();

  // Redirect ~/.claude/agents writes/reads into the temp dir for the lifetime
  // of this context, so handler routes that call saveUserAgent/deleteUserAgent
  // (agents toggle/update/delete) never pollute the real home. Reset in
  // cleanup(). homedir() can't be redirected via $HOME on bun — this seam is
  // the reliable route (see testing-gotchas).
  _setUserAgentsHome(dir);

  const config = opts.config ?? makeConfig(dir, opts.extraToml ?? "");
  if (opts.agentConfigs) config.agents = opts.agentConfigs;

  const state = new StateManager(join(dir, "state.json"), log);
  state.initFromConfig(config.sessions);
  const registry = new Registry(join(dir, "registry.json"));

  let db: MemoryDb | null = null;
  if (opts.withDb) {
    db = new MemoryDb(log, join(dir, "db"));
    await db.init();
  }

  const switchboard: Switchboard = { ...defaultSwitchboard(), ...(opts.switchboard ?? {}) };
  const agentConfigs = opts.agentConfigs ?? [];

  // Recorders ---------------------------------------------------------------
  const calls: Record<string, unknown[][]> = {};
  const broadcasts: { type: string; payload: unknown }[] = [];
  const record = (name: string, args: unknown[]): void => {
    (calls[name] ??= []).push(args);
  };

  /** Canned IpcResponse for a cmd* delegate (override via opts.cmdResponses). */
  const cannedResp = (name: string): IpcResponse =>
    opts.cmdResponses?.[name] ?? { ok: true, data: { delegated: name } };

  /** A recording sync cmd delegate. */
  const syncCmd = (name: string) => (...args: unknown[]): IpcResponse => {
    record(name, args);
    return cannedResp(name);
  };
  /** A recording async cmd delegate. */
  const asyncCmd = (name: string) => async (...args: unknown[]): Promise<IpcResponse> => {
    record(name, args);
    return cannedResp(name);
  };

  // Heavy IO subsystems — cheap real instances (no IO until methods called).
  const budget = new BudgetTracker(32, log, () => 0);
  const wake = new WakeLockManager("never", log);
  const systemMemory = new MemoryMonitor(log);
  const consumerTracker = new ConsumerTracker(log);

  let lastActivityEpoch = Math.floor(Date.now() / 1000);

  const ctx: OrchestratorContext = {
    // -- CoreDeps --
    config,
    state,
    getMemoryDb: () => db,
    getSwitchboard: () => switchboard,
    getSdkBridge: () => (opts.sdkBridge ?? null) as never,
    log,
    agentConfigs,
    registry,
    budget,
    wake,
    systemMemory,
    adoptedPids: new Map<string, number>(),
    broadcast: (type, payload) => {
      record("broadcast", [type, payload]);
      broadcasts.push({ type, payload });
    },
    broadcastWs: (type, data) => {
      record("broadcastWs", [type, data]);
      broadcasts.push({ type, payload: data });
    },
    updateSwitchboard: (patch) => {
      record("updateSwitchboard", [patch]);
      Object.assign(switchboard, patch);
      return switchboard;
    },
    getLastActivityEpoch: () => lastActivityEpoch,
    updateLastActivityEpoch: () => {
      record("updateLastActivityEpoch", []);
      lastActivityEpoch = Math.floor(Date.now() / 1000);
    },
    isAgentEnabled: (agentName) => {
      if (!switchboard.all) return false;
      const a = agentConfigs.find((x) => x.name === agentName);
      if (!a || !a.enabled) return false;
      return switchboard.agents[agentName] !== false;
    },
    resolveSessionPath: (sessionName) => {
      const cfg = config.sessions.find((s) => s.name === sessionName);
      if (cfg?.path) return cfg.path;
      const reg = registry.entries().find((e) => e.name === sessionName);
      return reg?.path ?? null;
    },
    resolveName: (input) => {
      const names = config.sessions.map((s) => s.name);
      for (const e of registry.entries()) if (!names.includes(e.name)) names.push(e.name);
      if (names.includes(input)) return input;
      const pre = names.filter((n) => n.startsWith(input));
      if (pre.length === 1) return pre[0];
      const sub = names.filter((n) => n.includes(input));
      if (sub.length === 1) return sub[0];
      return null;
    },
    ensureSocket: async () => { record("ensureSocket", []); },
    reloadAgents: () => { record("reloadAgents", []); },

    // -- LazyEngineAccess --
    getToolExecutor: () => (opts.toolExecutor ?? null) as never,
    getToolEngine: () => (opts.toolEngine ?? null) as never,
    getTelemetrySink: () => (opts.telemetrySink ?? null) as never,
    getDashboard: () => (opts.dashboard ?? null) as never,
    getScheduleEngine: () => (opts.scheduleEngine ?? null) as never,
    getWorkflowEngine: () => (opts.workflowEngine ?? null) as never,
    getSkillManager: () => (opts.skillManager ?? null) as never,
    getConsumerTracker: () => consumerTracker,
    upsertSchedule: (input) => { record("upsertSchedule", [input]); return 1; },

    // -- SessionLifecycleDeps --
    boot: async () => { record("boot", []); },
    shutdown: async (kill) => { record("shutdown", [kill]); },
    startSession: async (name) => { record("startSession", [name]); return true; },
    stopSessionByName: async (name) => { record("stopSessionByName", [name]); return true; },
    startAllSessions: async () => { record("startAllSessions", []); },

    // -- CmdDelegates --
    cmdStatus: syncCmd("cmdStatus"),
    cmdStart: asyncCmd("cmdStart"),
    cmdStop: asyncCmd("cmdStop"),
    cmdRestart: asyncCmd("cmdRestart"),
    cmdHealth: syncCmd("cmdHealth"),
    cmdMemory: syncCmd("cmdMemory"),
    cmdGo: asyncCmd("cmdGo"),
    cmdSend: syncCmd("cmdSend"),
    cmdTabs: syncCmd("cmdTabs"),
    cmdOpen: asyncCmd("cmdOpen"),
    cmdClose: asyncCmd("cmdClose"),
    cmdSetAutostart: asyncCmd("cmdSetAutostart"),
    cmdDedupe: asyncCmd("cmdDedupe"),
    cmdForceCleanup: asyncCmd("cmdForceCleanup"),
    cmdRecent: syncCmd("cmdRecent"),
    cmdSuspend: syncCmd("cmdSuspend"),
    cmdResume: syncCmd("cmdResume"),
    cmdSuspendOthers: syncCmd("cmdSuspendOthers"),
    cmdSuspendAll: syncCmd("cmdSuspendAll"),
    cmdResumeAll: syncCmd("cmdResumeAll"),
    cmdRegister: syncCmd("cmdRegister"),
    cmdClone: syncCmd("cmdClone"),
    cmdCreate: syncCmd("cmdCreate"),

    // -- AndroidCallbacks --
    getAndroidApps: () => { record("getAndroidApps", []); return []; },
    forceStopApp: (pkg) => { record("forceStopApp", [pkg]); return { status: 200, data: { ok: true } }; },
    launchApp: (target) => { record("launchApp", [target]); return { status: 200, data: { ok: true } }; },
    getAutoStopList: () => { record("getAutoStopList", []); return { packages: [] }; },
    toggleAutoStop: (pkg) => { record("toggleAutoStop", [pkg]); return { status: 200, data: { ok: true } }; },
    invalidateAdbSerial: () => { record("invalidateAdbSerial", []); },

    // -- MonitoringCallbacks --
    pushSseState: () => { record("pushSseState", []); },
    updateStatusNotification: () => { record("updateStatusNotification", []); },

    ...(opts.overrides ?? {}),
  };

  return {
    ctx,
    calls,
    broadcasts,
    switchboard,
    state,
    registry,
    db,
    dir,
    cleanup: () => {
      try { _setUserAgentsHome(null); } catch { /* ignore */ }
      try { db?.close(); } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
