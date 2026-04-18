/**
 * server-engine.ts — HTTP/IPC/WS/SSE subsystem extraction scaffold.
 *
 * This module is the landing zone for handler logic currently embedded in
 * Daemon. Full extraction is incremental — this initial shell establishes the
 * injection point and hosts pure utility helpers that have no fan-out into
 * Daemon's session/agent state.
 *
 * Extraction roadmap (in priority order):
 *   1. WS message dispatch helpers (switchboard_get / switchboard_update paths) ✓
 *   2. handleWsMessage() — extracted (Sprint 13 Task 5) ✓
 *   3. SSE push helpers (pushSseState / pushConversationDeltas)
 *   4. REST route handlers — extracted (Sprint 13 Task 7) ✓
 *   5. handleIpcCommand() — extracted (Sprint 13 Task 6) ✓
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { AgentEngine } from "./agent-engine.js";
import type { ToolEngine } from "./tool-engine.js";
import type { WsClientMessage } from "./http.js";
import type { IpcCommand, IpcResponse, Switchboard, SessionConfig } from "./types.js";
import { buildMemoryPrompt } from "./memory-injector.js";
import { detectPlatform } from "./platform/platform.js";
import { Logger } from "./log.js";
import { buildOodaContext } from "./cognitive.js";
import {
  getProjectTokenUsage,
  getConversationPage,
  readTimeline,
  resolveActiveJsonl,
  getDailyCostTimeline,
} from "./claude-session.js";
import {
  searchPrompts,
  starPrompt,
  unstarPrompt,
  getPromptProjects,
} from "./prompts.js";
import { readNotifications } from "./notifications.js";
import { getGitInfo, getFileTree, getFileContent } from "./git-info.js";
import {
  sendKeys,
  createTermuxTab,
  bringTermuxToForeground,
  runScriptInTab,
} from "./session.js";
import {
  loadAgents, validateAgentConfig, saveUserAgent, deleteUserAgent, type AgentConfig,
} from "./agents.js";
import {
  exportAgentState, importAgentState, saveSnapshot, pruneSnapshots, listSnapshots,
  type AgentStateBundle, type ImportOptions,
} from "./agent-state.js";
import {
  runConsolidation,
  getLastConsolidationTime, getConsolidationHistory,
} from "./consolidation.js";
import { computeQuotaStatus } from "./memory-db.js";

/** Portable bash shebang — matches the one in daemon.ts */
const BASH_SHEBANG = process.env.PREFIX
  ? `#!${process.env.PREFIX}/bin/bash`
  : `#!/usr/bin/env bash`;

/** Resolve ADB binary path via platform abstraction */
const ADB_BIN = detectPlatform().resolveAdbPath() ?? "adb";

/** Chunk text into ~maxChars segments splitting on paragraph/newline boundaries */
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

/**
 * ServerEngine — subsystem for HTTP/IPC/WS/SSE request handling.
 *
 * Accepts a shared OrchestratorContext so all state mutations are
 * reflected across the system without coupling to Daemon internals.
 *
 * AgentEngine and ToolEngine are injected via constructor so WS message
 * dispatch can delegate to them without reaching back into Daemon.
 */
export class ServerEngine {
  constructor(
    private readonly ctx: OrchestratorContext,
    private readonly agentEngine: AgentEngine,
    private readonly toolEngine: ToolEngine,
  ) {}

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
    const sb: Switchboard = this.ctx.getSwitchboard();
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
    const sb = this.ctx.getSwitchboard();
    if (!sb.all) return false;
    // Agent's own enabled flag must be set
    const agentConf = this.ctx.agentConfigs.find((a) => a.name === agentName);
    if (!agentConf || !agentConf.enabled) return false;
    // Per-agent switchboard override (default: follow agent.enabled)
    const sw = sb.agents[agentName];
    if (sw === false) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // WS message dispatch
  // ---------------------------------------------------------------------------

  /**
   * Handle incoming WebSocket messages for SDK streaming, permission resolution,
   * agent operations, and switchboard control.
   *
   * Moved from Daemon (Sprint 13 Task 5). Delegates to:
   *   - ctx.sdkBridge     for attach / prompt / permission_response / abort / detach
   *   - agentEngine       for agent_run / agent_chat / agent_chat_history / agent_chat_clear
   *   - ctx.switchboard   for switchboard_get / switchboard_update
   *
   * Unhandled types (subscribe / unsubscribe / ping) are handled upstream by
   * DashboardServer and silently ignored here.
   */
  async handleWsMessage(
    ws: import("ws").WebSocket,
    msg: WsClientMessage,
  ): Promise<void> {
    switch (msg.type) {
      case "attach": {
        if (!this.ctx.sdkBridge) throw new Error("SDK bridge not initialized");
        if (!this.ctx.getSwitchboard().all || !this.ctx.getSwitchboard().sdkBridge)
          throw new Error("SDK bridge disabled by switchboard");
        const sessionName = msg.sessionName;
        if (!sessionName) throw new Error("sessionName required");
        // Resolve session path from config or registry via context callback
        const sessionPath = this.ctx.resolveSessionPath(sessionName);
        if (!sessionPath) throw new Error(`No path for session: ${sessionName}`);
        const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
        const result = await this.ctx.sdkBridge.attach(sessionName, sessionId, sessionPath);
        ws.send(JSON.stringify({ type: "attach_result", ...result }));
        break;
      }

      case "prompt": {
        if (!this.ctx.sdkBridge?.isAttached) throw new Error("No active SDK session");
        const prompt = typeof msg.prompt === "string" ? msg.prompt : "";
        if (!prompt) throw new Error("prompt required");
        // Inject memories if available and switchboard allows it
        let fullPrompt = prompt;
        if (
          this.ctx.getSwitchboard().all &&
          this.ctx.getSwitchboard().memoryInjection &&
          this.ctx.memoryDb &&
          this.ctx.sdkBridge.activeSessionName
        ) {
          const sessionPath = this.ctx.resolveSessionPath(this.ctx.sdkBridge.activeSessionName);
          if (sessionPath) {
            const { prompt: memPrompt } = await buildMemoryPrompt(
              this.ctx.memoryDb,
              sessionPath,
              10,
              prompt,
            );
            if (memPrompt) fullPrompt = memPrompt + "\n\n" + prompt;
          }
        }
        // Send prompt (non-blocking — messages stream via WS broadcast)
        this.ctx.sdkBridge.send(fullPrompt, {
          effort: typeof msg.effort === "string" ? (msg.effort as any) : undefined,
          thinking: msg.thinking as any,
        }).catch((err) => {
          ws.send(JSON.stringify({ type: "error", message: String(err) }));
        });
        break;
      }

      case "permission_response": {
        if (!this.ctx.sdkBridge) throw new Error("SDK bridge not initialized");
        const id = typeof msg.id === "string" ? msg.id : "";
        const behavior = msg.behavior === "allow" ? "allow" : "deny";
        const resolved = this.ctx.sdkBridge.resolvePermission(id, behavior);
        ws.send(JSON.stringify({ type: "permission_resolved", id, resolved }));
        break;
      }

      case "abort": {
        if (this.ctx.sdkBridge?.isAttached) {
          await this.ctx.sdkBridge.interrupt();
        }
        break;
      }

      case "detach": {
        if (this.ctx.sdkBridge?.isAttached) {
          await this.ctx.sdkBridge.detach();
        }
        break;
      }

      case "agent_run": {
        // Trigger standalone agent run via WS
        const agentName = typeof msg.agentName === "string" ? msg.agentName : "";
        const agentPrompt = typeof msg.prompt === "string" ? msg.prompt : "";
        if (!agentName || !agentPrompt) throw new Error("agentName and prompt required");
        this.agentEngine.handleStandaloneAgentRun(agentName, agentPrompt).catch((err) => {
          ws.send(JSON.stringify({ type: "error", message: String(err) }));
        });
        ws.send(JSON.stringify({ type: "agent_run_started", agentName }));
        break;
      }

      case "switchboard_get": {
        // Return current switchboard state to requesting client
        ws.send(JSON.stringify(this.buildSwitchboardPayload()));
        break;
      }

      case "switchboard_update": {
        // Apply partial switchboard update from WS client
        const patch = msg as unknown as Partial<Switchboard>;
        delete (patch as any).type; // strip the WS message type field
        this.ctx.updateSwitchboard(patch);
        ws.send(JSON.stringify(this.buildSwitchboardPayload()));
        break;
      }

      case "agent_chat": {
        // Persistent conversation with a specific agent
        const agentName = typeof msg.agentName === "string" ? msg.agentName : "";
        const chatPrompt = typeof msg.prompt === "string" ? msg.prompt : "";
        if (!agentName || !chatPrompt) {
          ws.send(JSON.stringify({ type: "error", message: "agentName and prompt required" }));
          break;
        }
        this.agentEngine.handleAgentChat(agentName, chatPrompt, ws).catch((err) => {
          try {
            ws.send(
              JSON.stringify({ type: "agent_chat_error", agentName, message: String(err) }),
            );
          } catch { /* ws may have closed during the run */ }
        });
        break;
      }

      case "agent_chat_history": {
        const agentName = typeof msg.agentName === "string" ? msg.agentName : "";
        const history = this.ctx.memoryDb?.getConversationHistory(agentName, 50) ?? [];
        ws.send(JSON.stringify({ type: "agent_chat_history", agentName, messages: history }));
        break;
      }

      case "agent_chat_clear": {
        const agentName = typeof msg.agentName === "string" ? msg.agentName : "";
        const cleared = this.ctx.memoryDb?.clearConversation(agentName) ?? 0;
        ws.send(JSON.stringify({ type: "agent_chat_cleared", agentName, cleared }));
        break;
      }

      default:
        // subscribe / unsubscribe / ping handled by DashboardServer directly
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // IPC command dispatch (extracted from Daemon — Sprint 13 Task 6)
  // ---------------------------------------------------------------------------

  /**
   * Handle an IPC command from the CLI.
   *
   * Extracted from Daemon. The dispatch switch lives here; each case delegates
   * to a cmd* callback on OrchestratorContext so the state-machine logic stays
   * authoritative in Daemon (where the REST API also calls the same methods).
   *
   * Special cases handled inline:
   *   - "config"   — pure ctx.config read, no Daemon method needed
   *   - "stream"   — fire-and-forget ctx.boot()
   *   - "shutdown" — deferred ctx.shutdown() + process.exit
   */
  async handleIpcCommand(cmd: IpcCommand): Promise<IpcResponse> {
    switch (cmd.cmd) {
      case "status":
        return this.ctx.cmdStatus(cmd.name);

      case "start":
        return this.ctx.cmdStart(cmd.name);

      case "stop":
        return this.ctx.cmdStop(cmd.name);

      case "restart":
        return this.ctx.cmdRestart(cmd.name);

      case "health":
        return this.ctx.cmdHealth();

      case "stream":
      case "boot": // backwards compat alias
        // Run boot async and respond immediately
        this.ctx.boot().catch((err) => this.ctx.log.error(`Boot failed: ${err}`));
        return { ok: true, data: "Stream sequence started" };

      case "shutdown":
        // Respond before shutting down — give the IPC reply time to flush
        setTimeout(() => this.ctx.shutdown(cmd.kill).then(() => process.exit(0)), 100);
        return { ok: true, data: "Shutdown initiated" };

      case "go":
        return this.ctx.cmdGo(cmd.name);

      case "send":
        return this.ctx.cmdSend(cmd.name, cmd.text);

      case "tabs":
        return this.ctx.cmdTabs(cmd.names);

      case "config":
        return { ok: true, data: this.ctx.config };

      case "memory":
        return this.ctx.cmdMemory();

      case "open":
        return this.ctx.cmdOpen(cmd.path, cmd.name, cmd.auto_go, cmd.priority);

      case "close":
        return this.ctx.cmdClose(cmd.name);

      case "recent":
        return this.ctx.cmdRecent(cmd.count);

      case "suspend":
        return this.ctx.cmdSuspend(cmd.name);

      case "resume":
        return this.ctx.cmdResume(cmd.name);

      case "suspend-others":
        return this.ctx.cmdSuspendOthers(cmd.name);

      case "suspend-all":
        return this.ctx.cmdSuspendAll();

      case "resume-all":
        return this.ctx.cmdResumeAll();

      case "register":
        return this.ctx.cmdRegister(cmd.path);

      case "clone":
        return this.ctx.cmdClone(cmd.url, cmd.name);

      case "create":
        return this.ctx.cmdCreate(cmd.name);

      default:
        return { ok: false, error: `Unknown command: ${(cmd as { cmd: string }).cmd}` };
    }
  }

  // ---------------------------------------------------------------------------
  // REST API handler (extracted from Daemon.handleDashboardApi — Sprint 13 Task 7)
  // ---------------------------------------------------------------------------

  /**
   * Handle a REST API request from DashboardServer.
   *
   * Extracted verbatim from Daemon.handleDashboardApi(). All `this.*` references
   * are translated:
   *   - daemon cmd+/resolve+ methods   → this.ctx.cmd+() / this.ctx.resolve+()
   *   - this.agentEngine               → this.agentEngine
   *   - this.telemetrySink             → this.ctx.getTelemetrySink()
   *   - this.scheduleEngine            → this.ctx.getScheduleEngine()
   *   - this.toolExecutor              → this.ctx.getToolExecutor()
   *   - this.memoryDb/config/state/etc → this.ctx.*
   *   - this.broadcastSwitchboard()    → this.ctx.broadcastWs()
   *   - android/adb methods            → this.ctx.get/forceStop/toggleAutoStop/etc
   *   - MCP/customization/script cmds  → private helpers on this (moved from daemon)
   */
  async handleDashboardApi(
    method: string,
    path: string,
    body: string,
  ): Promise<{ status: number; data: unknown }> {
    // Separate query string from path: /api/command/name?key=val
    const [pathPart, queryPart] = path.split("?", 2);
    const queryParams = new URLSearchParams(queryPart ?? "");

    // Extract path segments: /api/command/name
    const segments = pathPart.replace(/^\/api\//, "").split("/");
    const command = segments[0];
    const name = segments[1] ? decodeURIComponent(segments[1]) : undefined;

    try {
      let resp;
      switch (command) {
        case "status":
          resp = this.ctx.cmdStatus(name);
          break;
        case "memory":
          resp = this.ctx.cmdMemory();
          break;
        case "health":
          resp = this.ctx.cmdHealth();
          break;
        case "telemetry": {
          const ts = this.ctx.getTelemetrySink();
          if (!ts) {
            return { status: 200, data: { records: [], stats: { total: 0, per_hour: 0, by_sdk: {}, started_at: "" } } };
          }
          const sdkFilter = queryParams.get("sdk") as import("./types.js").TelemetrySdk | null;
          const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 100;
          return {
            status: 200,
            data: {
              records: ts.getRecent(limit, sdkFilter ?? undefined),
              stats: ts.getStats(),
            },
          };
        }
        case "start":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          resp = await this.ctx.cmdStart(name);
          break;
        case "stop":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          resp = await this.ctx.cmdStop(name);
          break;
        case "restart":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          resp = await this.ctx.cmdRestart(name);
          break;
        case "go": {
          // Dashboard "go" sends keys immediately — no 60s readiness wait.
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          const resolved = this.ctx.resolveName(name);
          if (!resolved) return { status: 400, data: { error: `Unknown session: ${name}` } };
          const sent = sendKeys(resolved, "go", true);
          return { status: sent ? 200 : 500, data: sent ? { ok: true } : { error: `Failed to send 'go' to '${resolved}'` } };
        }
        case "send":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          try {
            const parsed = JSON.parse(body) as { text: string };
            resp = this.ctx.cmdSend(name, parsed.text ?? "");
          } catch {
            return { status: 400, data: { error: "Invalid JSON body" } };
          }
          break;
        case "bridge": {
          // POST /api/bridge/termux-service — launch bridge via TermuxService intent
          if (method === "POST" && name === "termux-service") {
            try {
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 2000);
              const hResp = await fetch("http://127.0.0.1:18963/health", { signal: ctrl.signal });
              clearTimeout(t);
              if (hResp.ok) {
                return { status: 200, data: { status: "already_running" } };
              }
            } catch { /* bridge is down — proceed */ }

            const prefix = process.env.PREFIX ?? "/usr";
            const home = homedir();
            const scriptPath = join(prefix, "tmp", "tmx-bridge-start.sh");

            const bridgeCandidates = [
              join(home, ".bun/install/global/node_modules/claude-chrome-android/dist/cli.js"),
              join(home, ".npm/lib/node_modules/claude-chrome-android/dist/cli.js"),
              join(home, "git/termux-tools/bridge/dist/cli.js"),
            ];
            const bridgeScript = bridgeCandidates.find(p => existsSync(p)) ?? bridgeCandidates[0];
            const bunPath = existsSync(join(home, ".bun/bin/bun")) ? join(home, ".bun/bin/bun") : "bun";
            const bridgeDir = dirname(bridgeScript);

            writeFileSync(scriptPath, [
              BASH_SHEBANG,
              `# CFC Bridge startup script (generated by operad daemon)`,
              `cd "${bridgeDir}"`,
              `exec "${bunPath}" "${bridgeScript}" 2>&1 | tee -a "${prefix}/tmp/bridge.log"`,
            ].join("\n") + "\n");
            // chmodSync equivalent — spawn chmod
            spawnSync("chmod", ["0755", scriptPath], { timeout: 3000 });

            const amBin = detectPlatform().resolveBinaryPath("am");
            const svcResult = spawnSync(amBin, [
              "startservice",
              "-n", "com.termux/.app.TermuxService",
              "-a", "com.termux.service_execute",
              "-d", `file://${scriptPath}`,
              "--ei", "com.termux.execute.session_action", "0",
              "--es", "com.termux.execute.shell_name", "cfc-bridge",
            ], { timeout: 5000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", env: detectPlatform().amEnv() });

            if (svcResult.status === 0) {
              this.ctx.log.info("Bridge started via TermuxService intent", { script: bridgeScript });
              return { status: 200, data: { status: "starting", method: "termux_service" } };
            }
            this.ctx.log.warn("TermuxService bridge start failed", { stderr: svcResult.stderr?.slice(0, 200) });
            return { status: 500, data: { error: "TermuxService intent failed", stderr: svcResult.stderr?.slice(0, 200) } };
          }

          // POST /api/bridge/memory-pressure — trigger CDP Memory.simulatePressureNotification
          if (method === "POST" && name === "memory-pressure") {
            try {
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 3000);
              const bridgeResp2 = await fetch("http://127.0.0.1:18963/memory-pressure", {
                method: "POST", signal: ctrl.signal,
              });
              clearTimeout(t);
              const data = await bridgeResp2.json();
              return { status: 200, data };
            } catch {
              return { status: 502, data: { error: "Bridge not reachable" } };
            }
          }

          if (method === "POST" && name !== "termux-service") {
            // POST /api/bridge/start — spawn bridge process (detached)
            try {
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 2000);
              const hResp2 = await fetch("http://127.0.0.1:18963/health", { signal: ctrl.signal });
              clearTimeout(t);
              if (hResp2.ok) {
                return { status: 200, data: { status: "already_running" } };
              }
            } catch { /* bridge is down — proceed to start */ }

            const home2 = homedir();
            const bridgeCandidates2 = [
              join(home2, ".bun/install/global/node_modules/claude-chrome-android/dist/cli.js"),
              join(home2, ".npm/lib/node_modules/claude-chrome-android/dist/cli.js"),
              join(home2, "git/termux-tools/bridge/dist/cli.js"),
            ];
            const bridgeScript2 = bridgeCandidates2.find(p => existsSync(p));
            if (!bridgeScript2) {
              return { status: 500, data: { error: "Bridge script not found" } };
            }

            let runtime = "";
            const bunPath2 = join(home2, ".bun/bin/bun");
            if (existsSync(bunPath2)) runtime = bunPath2;
            else {
              try {
                const which = spawnSync("which", ["bun"], { encoding: "utf-8", timeout: 3000 });
                if (which.stdout?.trim()) runtime = which.stdout.trim();
              } catch { /* fall through */ }
            }
            if (!runtime) {
              try {
                const which = spawnSync("which", ["node"], { encoding: "utf-8", timeout: 3000 });
                if (which.stdout?.trim()) runtime = which.stdout.trim();
              } catch { /* fall through */ }
            }
            if (!runtime) {
              return { status: 500, data: { error: "No runtime (bun/node) found" } };
            }

            const prefix2 = process.env.PREFIX ?? "/usr";
            const logPath = join(prefix2, "tmp/bridge.log");
            const logFd = openSync(logPath, "a");
            try {
              const child = spawn(runtime, [bridgeScript2], {
                detached: true,
                stdio: ["ignore", logFd, logFd],
              });
              child.unref();
              this.ctx.log.info("Bridge spawned via HTTP API", { pid: child.pid, script: bridgeScript2 });
              return { status: 200, data: { status: "starting", pid: child.pid } };
            } finally {
              closeSync(logFd);
            }
          }

          // GET /api/bridge — proxy to CFC bridge health endpoint
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const bridgeResp3 = await fetch("http://127.0.0.1:18963/health", {
              signal: controller.signal,
            });
            clearTimeout(timeout);
            const bridgeData = await bridgeResp3.json();
            return { status: 200, data: bridgeData };
          } catch {
            return { status: 200, data: { status: "offline", error: "Bridge not reachable" } };
          }
        }
        case "logs": {
          const sessionFilter = name ?? undefined;
          const log = new Logger(this.ctx.config.orchestrator.log_dir);
          const entries = log.readTail(100, sessionFilter);
          return { status: 200, data: entries };
        }
        case "tab": {
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          const tabCfg = this.ctx.config.sessions.find((s: SessionConfig) => s.name === name);
          if (tabCfg?.bare) {
            return { status: 400, data: { error: `'${name}' is a bare (headless) session — no tmux tab` } };
          }
          if (createTermuxTab(name, this.ctx.log)) {
            try { spawnSync("tmux", ["select-window", "-t", name], { timeout: 3000 }); } catch { /* best-effort */ }
            bringTermuxToForeground(this.ctx.log);
            return { status: 200, data: { ok: true, session: name } };
          }
          return { status: 500, data: { error: `Failed to open tab for '${name}'` } };
        }
        case "run-build": {
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          const buildCfg = this.ctx.config.sessions.find((s: SessionConfig) => s.name === name);
          if (!buildCfg?.path) return { status: 400, data: { error: `Session '${name}' has no path` } };
          const buildScript = join(buildCfg.path, "build-on-termux.sh");
          if (!existsSync(buildScript)) {
            return { status: 404, data: { error: `No build-on-termux.sh in ${buildCfg.path}` } };
          }
          if (runScriptInTab(buildScript, buildCfg.path, name, this.ctx.log)) {
            return { status: 200, data: { ok: true, session: name } };
          }
          return { status: 500, data: { error: `Failed to launch build for '${name}'` } };
        }
        case "scripts": {
          if (!name) return { status: 400, data: { error: "Session name required" } };
          return this.cmdListScripts(name);
        }
        case "run-script": {
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          try {
            const parsed = JSON.parse(body) as { command?: string; script?: string; source?: string };
            return this.cmdRunScript(name, parsed);
          } catch {
            return { status: 400, data: { error: "Invalid JSON body" } };
          }
        }
        case "save-script": {
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          try {
            const parsed = JSON.parse(body) as { name: string; command: string };
            return this.cmdSaveScript(name, parsed);
          } catch {
            return { status: 400, data: { error: "Invalid JSON body" } };
          }
        }
        case "processes":
          return { status: 200, data: this.ctx.getAndroidApps() };
        case "kill":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Package name required" } };
          return this.ctx.forceStopApp(name);
        case "autostop":
          if (!name) return { status: 200, data: this.ctx.getAutoStopList() };
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          return this.ctx.toggleAutoStop(name);
        case "adb":
          if (!name) {
            return { status: 200, data: this.getAdbDevices() };
          }
          if (name === "connect") {
            if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
            return this.adbWirelessConnect();
          }
          if (name === "disconnect") {
            if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
            const serial = segments[2] ? decodeURIComponent(segments[2]) : undefined;
            if (serial) return this.adbDisconnectDevice(serial);
            return this.adbDisconnectAll();
          }
          return { status: 400, data: { error: `Unknown ADB action: ${name}` } };
        case "recent":
          resp = this.ctx.cmdRecent(20);
          break;
        case "open":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Path or name required" } };
          resp = await this.ctx.cmdOpen(name);
          break;
        case "close":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          resp = await this.ctx.cmdClose(name);
          break;
        case "fix-socket":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          await this.ctx.ensureSocket();
          resp = { ok: true };
          break;
        case "suspend":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          resp = this.ctx.cmdSuspend(name);
          break;
        case "resume":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          resp = this.ctx.cmdResume(name);
          break;
        case "suspend-others":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          resp = this.ctx.cmdSuspendOthers(name);
          break;
        case "suspend-all":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          resp = this.ctx.cmdSuspendAll();
          break;
        case "resume-all":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          resp = this.ctx.cmdResumeAll();
          break;
        case "register": {
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          let scanPath: string | undefined;
          if (body) {
            try { scanPath = (JSON.parse(body) as { path?: string }).path; } catch { /* use default */ }
          }
          resp = this.ctx.cmdRegister(scanPath);
          break;
        }
        case "clone": {
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!body) return { status: 400, data: { error: "JSON body with url required" } };
          try {
            const parsed = JSON.parse(body) as { url: string; name?: string };
            if (!parsed.url) return { status: 400, data: { error: "url is required" } };
            resp = this.ctx.cmdClone(parsed.url, parsed.name);
          } catch {
            return { status: 400, data: { error: "Invalid JSON body" } };
          }
          break;
        }
        case "create": {
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Project name required" } };
          resp = this.ctx.cmdCreate(name);
          break;
        }
        case "customization":
          resp = this.cmdCustomization(name);
          break;
        case "customization-file": {
          if (method === "GET") {
            const filePath = segments.slice(1).map(s => decodeURIComponent(s)).join("/");
            if (!filePath) return { status: 400, data: { error: "File path required" } };
            resp = this.cmdReadCustomizationFile(filePath);
          } else if (method === "POST") {
            try {
              const parsed = JSON.parse(body) as { path: string; content: string };
              if (!parsed.path || typeof parsed.content !== "string") {
                return { status: 400, data: { error: "path and content required" } };
              }
              resp = this.cmdWriteCustomizationFile(parsed.path, parsed.content);
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
          } else {
            return { status: 405, data: { error: "Method not allowed" } };
          }
          break;
        }
        case "tokens": {
          if (name) {
            const sessionPath = this.ctx.resolveSessionPath(name);
            if (!sessionPath) return { status: 400, data: { error: `Session '${name}' has no path` } };
            try {
              const usage = await getProjectTokenUsage(name, sessionPath);
              return { status: 200, data: usage };
            } catch (err) {
              return { status: 500, data: { error: `Failed to compute tokens: ${err}` } };
            }
          }
          try {
            const results = [];
            for (const cfg of this.ctx.config.sessions) {
              if (cfg.type !== "claude" || !cfg.path) continue;
              const state = this.ctx.state.getSession(cfg.name);
              if (!state || state.status === "stopped" || state.status === "failed") continue;
              try {
                results.push(await getProjectTokenUsage(cfg.name, cfg.path));
              } catch { /* best-effort */ }
            }
            for (const entry of this.ctx.registry.entries()) {
              if (!entry.path) continue;
              const state = this.ctx.state.getSession(entry.name);
              if (!state || state.status === "stopped" || state.status === "failed") continue;
              if (results.some(r => r.path === entry.path)) continue;
              try {
                results.push(await getProjectTokenUsage(entry.name, entry.path));
              } catch { /* best-effort */ }
            }
            return { status: 200, data: results };
          } catch (err) {
            return { status: 500, data: { error: `Failed to compute tokens: ${err}` } };
          }
        }
        case "conversation": {
          if (!name) return { status: 400, data: { error: "Session name required" } };
          const convPath = this.ctx.resolveSessionPath(name);
          if (!convPath) return { status: 400, data: { error: `Session '${name}' has no path` } };
          const beforeUuid = queryParams.get("before") ?? undefined;
          const convLimit = parseInt(queryParams.get("limit") ?? "20", 10);
          const sessionIdParam = queryParams.get("session_id") ?? undefined;
          try {
            const page = getConversationPage(convPath, sessionIdParam, convLimit, beforeUuid);
            return { status: 200, data: page };
          } catch (err) {
            return { status: 500, data: { error: `Failed to read conversation: ${err}` } };
          }
        }
        case "timeline": {
          if (!name) return { status: 400, data: { error: "Session name required" } };
          const tlPath = this.ctx.resolveSessionPath(name);
          const tracePath = join(this.ctx.config.orchestrator.log_dir, "trace.log");
          let jsonlPath: string | undefined;
          if (tlPath) {
            const active = resolveActiveJsonl(tlPath);
            if (active) jsonlPath = active.path;
          }
          const since = queryParams.get("since") ?? undefined;
          const tlLimit = parseInt(queryParams.get("limit") ?? "100", 10);
          try {
            const events = readTimeline(name, tracePath, jsonlPath, since, tlLimit);
            return { status: 200, data: events };
          } catch (err) {
            return { status: 500, data: { error: `Failed to read timeline: ${err}` } };
          }
        }
        case "mcp": {
          if (method === "GET" && !name) {
            const config = this.readClaudeJson();
            const settingsData = existsSync(this.settingsJsonPath)
              ? JSON.parse(readFileSync(this.settingsJsonPath, "utf-8")) : {};
            const disabled: string[] = settingsData.disabledMcpServers ?? [];
            const servers = Object.entries(config.mcpServers ?? {}).map(([n, cfg]: [string, any]) => ({
              name: n,
              command: cfg.command ?? "",
              args: cfg.args ?? [],
              env: cfg.env ?? {},
              enabled: !disabled.includes(n),
              source: "claude-json" as const,
            }));
            return { status: 200, data: { servers } };
          }
          const mcpAction = segments[2] ? decodeURIComponent(segments[2]) : undefined;
          if (mcpAction === "toggle" && name) {
            if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
            return this.cmdMcpToggle(name);
          }
          if (method === "POST" && !name) {
            try {
              const parsed = JSON.parse(body) as { name: string; command: string; args?: string[]; env?: Record<string, string> };
              if (!parsed.name || !parsed.command) return { status: 400, data: { error: "name and command required" } };
              return this.cmdMcpAdd(parsed.name, parsed);
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
          }
          if (method === "PUT" && name) {
            try {
              const parsed = JSON.parse(body) as { command?: string; args?: string[]; env?: Record<string, string> };
              return this.cmdMcpUpdate(name, parsed);
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
          }
          if (method === "DELETE" && name) {
            return this.cmdMcpDelete(name);
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }
        case "prompts": {
          const promptAction = segments[2] ? decodeURIComponent(segments[2]) : undefined;
          if (name === "projects" && method === "GET") {
            return { status: 200, data: getPromptProjects() };
          }
          if (promptAction === "star" && name) {
            if (method === "POST") {
              starPrompt(name);
              return { status: 200, data: { ok: true } };
            } else if (method === "DELETE") {
              unstarPrompt(name);
              return { status: 200, data: { ok: true } };
            }
            return { status: 405, data: { error: "Method not allowed" } };
          }
          const result = searchPrompts({
            q: queryParams.get("q") ?? undefined,
            starred: queryParams.get("starred") === "true",
            project: queryParams.get("project") ?? undefined,
            limit: parseInt(queryParams.get("limit") ?? "50", 10),
            offset: parseInt(queryParams.get("offset") ?? "0", 10),
          });
          return { status: 200, data: result };
        }
        case "cost-timeline": {
          const days = parseInt(queryParams.get("days") ?? "14", 10);
          try {
            const allSessions: Array<{ name: string; path: string }> = [];
            for (const cfg of this.ctx.config.sessions) {
              if (cfg.type !== "claude" || !cfg.path) continue;
              allSessions.push({ name: cfg.name, path: cfg.path });
            }
            for (const entry of this.ctx.registry.entries()) {
              if (!entry.path) continue;
              if (allSessions.some(s => s.path === entry.path)) continue;
              allSessions.push({ name: entry.name, path: entry.path });
            }
            const timeline = await getDailyCostTimeline(allSessions, days);
            return { status: 200, data: timeline };
          } catch (err) {
            return { status: 500, data: { error: `Failed to compute cost timeline: ${err}` } };
          }
        }
        case "notifications": {
          const nLimit = parseInt(queryParams.get("limit") ?? "50", 10);
          const nSince = queryParams.get("since") ?? undefined;
          try {
            const records = readNotifications({ limit: nLimit, since: nSince });
            return { status: 200, data: records };
          } catch (err) {
            return { status: 500, data: { error: `Failed to read notifications: ${err}` } };
          }
        }
        case "git": {
          if (!name) return { status: 400, data: { error: "Session name required" } };
          const gitPath = this.ctx.resolveSessionPath(name);
          if (!gitPath) return { status: 400, data: { error: `Session '${name}' has no path` } };
          try {
            const info = getGitInfo(gitPath);
            return { status: 200, data: info };
          } catch (err) {
            return { status: 500, data: { error: `Failed to read git info: ${err}` } };
          }
        }
        case "files": {
          if (!name) return { status: 400, data: { error: "Session name required" } };
          const filesPath = this.ctx.resolveSessionPath(name);
          if (!filesPath) return { status: 400, data: { error: `Session '${name}' has no path` } };
          const subdir = queryParams.get("path") ?? undefined;
          try {
            const tree = getFileTree(filesPath, subdir);
            return { status: 200, data: tree };
          } catch (err) {
            return { status: 500, data: { error: `Failed to read files: ${err}` } };
          }
        }
        case "file-content": {
          if (!name) return { status: 400, data: { error: "Session name required" } };
          const fcPath = this.ctx.resolveSessionPath(name);
          if (!fcPath) return { status: 400, data: { error: `Session '${name}' has no path` } };
          const filePath = queryParams.get("path");
          if (!filePath) return { status: 400, data: { error: "path query parameter required" } };
          try {
            const content = getFileContent(fcPath, filePath);
            return { status: 200, data: content };
          } catch (err) {
            return { status: 500, data: { error: `Failed to read file: ${err}` } };
          }
        }
        case "branch": {
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          try {
            const parsed = JSON.parse(body) as { session_id: string };
            if (!parsed.session_id) return { status: 400, data: { error: "session_id required" } };
            const branchName = `${name}-branch-${Date.now().toString(36)}`;
            const sessionPath = this.ctx.resolveSessionPath(name);
            if (!sessionPath) return { status: 400, data: { error: `Session '${name}' has no path` } };
            const openResp = await this.ctx.cmdOpen(sessionPath, branchName);
            return { status: openResp.ok ? 200 : 400, data: openResp.ok ? { ok: true, name: branchName } : { error: openResp.error } };
          } catch {
            return { status: 400, data: { error: "Invalid JSON body" } };
          }
        }
        case "sdk": {
          const subCmd = name;
          const arg = segments[2] ? decodeURIComponent(segments[2]) : undefined;

          if (subCmd === "attach") {
            if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
            if (!this.ctx.sdkBridge) return { status: 503, data: { error: "SDK bridge not initialized" } };
            if (!arg) return { status: 400, data: { error: "Session name required" } };
            try {
              const parsed = body ? JSON.parse(body) as { sessionId?: string; cwd?: string } : {};
              const sessionPath = parsed.cwd ?? this.ctx.resolveSessionPath(arg);
              if (!sessionPath) return { status: 400, data: { error: `No path for session: ${arg}` } };
              const result = await this.ctx.sdkBridge.attach(arg, parsed.sessionId, sessionPath);
              return { status: 200, data: result };
            } catch (err) {
              return { status: 500, data: { error: `Attach failed: ${err}` } };
            }
          }

          if (subCmd === "detach") {
            if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
            if (this.ctx.sdkBridge?.isAttached) await this.ctx.sdkBridge.detach();
            return { status: 200, data: { ok: true } };
          }

          if (subCmd === "prompt") {
            if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
            if (!this.ctx.sdkBridge?.isAttached) return { status: 400, data: { error: "No active SDK session" } };
            try {
              const parsed = JSON.parse(body) as { prompt: string; effort?: string; thinking?: unknown };
              if (!parsed.prompt) return { status: 400, data: { error: "prompt required" } };
              this.ctx.sdkBridge.send(parsed.prompt, {
                effort: parsed.effort as any,
                thinking: parsed.thinking as any,
              }).catch((err) => this.ctx.log.error(`SDK prompt error: ${err}`));
              return { status: 202, data: { ok: true, message: "Prompt accepted" } };
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
          }

          if (subCmd === "status") {
            return {
              status: 200,
              data: {
                attached: this.ctx.sdkBridge?.isAttached ?? false,
                activeSession: this.ctx.sdkBridge?.activeSessionName ?? null,
                busy: this.ctx.sdkBridge?.isBusy ?? false,
              },
            };
          }

          if (subCmd === "sessions") {
            if (arg && segments[3] === "messages") {
              if (!this.ctx.sdkBridge) return { status: 503, data: { error: "SDK bridge not initialized" } };
              try {
                const msgs = await this.ctx.sdkBridge.getMessages(arg);
                return { status: 200, data: msgs };
              } catch (err) {
                return { status: 500, data: { error: `Failed to get messages: ${err}` } };
              }
            }
            if (!this.ctx.sdkBridge) return { status: 503, data: { error: "SDK bridge not initialized" } };
            try {
              const dir = queryParams.get("dir") ?? undefined;
              const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 50;
              const sessions = await this.ctx.sdkBridge.listAllSessions(dir, limit);
              return { status: 200, data: sessions };
            } catch (err) {
              return { status: 500, data: { error: `Failed to list sessions: ${err}` } };
            }
          }

          if (subCmd === "interrupt") {
            if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
            if (this.ctx.sdkBridge?.isAttached) await this.ctx.sdkBridge.interrupt();
            return { status: 200, data: { ok: true } };
          }

          return { status: 400, data: { error: `Unknown SDK endpoint: ${subCmd}` } };
        }

        case "switchboard": {
          if (method === "GET") {
            return { status: 200, data: this.ctx.getSwitchboard() };
          }
          if (method === "PUT") {
            try {
              const patch = JSON.parse(body) as Partial<Switchboard>;
              const updated = this.ctx.updateSwitchboard(patch);
              return { status: 200, data: updated };
            } catch (err) {
              return { status: 400, data: { error: String(err) } };
            }
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "agents": {
          const subCmd = name;
          const arg = segments[2] ? decodeURIComponent(segments[2]) : undefined;

          if (subCmd === "runs") {
            if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const agentFilter = queryParams.get("agent") ?? undefined;
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 50;
            return { status: 200, data: this.ctx.memoryDb.getAgentRuns(limit, agentFilter) };
          }

          if (subCmd === "costs") {
            if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            return { status: 200, data: this.ctx.memoryDb.getAgentCostSummary() };
          }

          if (!subCmd && method === "GET") {
            return { status: 200, data: this.ctx.agentConfigs };
          }

          if (!subCmd && method === "POST") {
            try {
              const parsed = JSON.parse(body) as Partial<AgentConfig>;
              const errors = validateAgentConfig(parsed);
              if (errors.length > 0) {
                return { status: 400, data: { error: errors.join("; ") } };
              }
              const agentConf: AgentConfig = {
                name: parsed.name!,
                description: parsed.description!,
                prompt: parsed.prompt!,
                tools: parsed.tools,
                disallowed_tools: parsed.disallowed_tools,
                model: parsed.model,
                max_turns: parsed.max_turns,
                background: parsed.background,
                memory: parsed.memory,
                effort: parsed.effort,
                permission_mode: parsed.permission_mode,
                max_budget_usd: parsed.max_budget_usd,
                enabled: parsed.enabled ?? true,
                source: "user",
              };
              saveUserAgent(agentConf);
              this.ctx.reloadAgents();
              return { status: 201, data: { ok: true, name: agentConf.name } };
            } catch (err) {
              return { status: 400, data: { error: String(err) } };
            }
          }

          if (subCmd && !arg && method === "GET") {
            const agent = this.ctx.agentConfigs.find((a) => a.name === subCmd);
            if (!agent) return { status: 404, data: { error: `Agent not found: ${subCmd}` } };
            return { status: 200, data: agent };
          }

          if (subCmd && method === "PUT") {
            try {
              const parsed = JSON.parse(body) as Partial<AgentConfig>;
              const existing = this.ctx.agentConfigs.find((a) => a.name === subCmd);
              if (!existing) return { status: 404, data: { error: `Agent not found: ${subCmd}` } };
              const updated = { ...existing, ...parsed, name: subCmd };
              const errors = validateAgentConfig(updated);
              if (errors.length > 0) {
                return { status: 400, data: { error: errors.join("; ") } };
              }
              saveUserAgent(updated as AgentConfig);
              this.ctx.reloadAgents();
              return { status: 200, data: { ok: true } };
            } catch (err) {
              return { status: 400, data: { error: String(err) } };
            }
          }

          if (subCmd && !arg && method === "DELETE") {
            const agent = this.ctx.agentConfigs.find((a) => a.name === subCmd);
            if (!agent) return { status: 404, data: { error: `Agent not found: ${subCmd}` } };
            if (agent.source === "builtin") {
              return { status: 403, data: { error: "Cannot delete built-in agent" } };
            }
            deleteUserAgent(subCmd);
            this.ctx.reloadAgents();
            return { status: 200, data: { ok: true } };
          }

          if (subCmd && arg === "toggle" && method === "POST") {
            const agent = this.ctx.agentConfigs.find((a) => a.name === subCmd);
            if (!agent) return { status: 404, data: { error: `Agent not found: ${subCmd}` } };
            const toggled = { ...agent, enabled: !agent.enabled };
            saveUserAgent(toggled);
            this.ctx.reloadAgents();
            return { status: 200, data: { ok: true, enabled: toggled.enabled } };
          }

          if (subCmd && arg === "run" && method === "POST") {
            if (this.ctx.sdkBridge?.isAttached) {
              return { status: 409, data: { error: "SDK session active — cannot run standalone agent" } };
            }
            try {
              const parsed = body ? JSON.parse(body) as { prompt?: string } : {};
              const prompt = parsed.prompt ?? "Analyze the current system state and take appropriate action.";
              this.agentEngine.handleStandaloneAgentRun(subCmd, prompt).catch((err) => {
                this.ctx.log.error(`Standalone agent run failed: ${err}`);
              });
              return { status: 202, data: { ok: true, message: `Agent ${subCmd} run started` } };
            } catch (err) {
              return { status: 400, data: { error: String(err) } };
            }
          }

          if (subCmd && arg === "learnings" && method === "GET") {
            if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const category = queryParams.get("category") ?? undefined;
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 20;
            return { status: 200, data: this.ctx.memoryDb.getAgentLearnings(subCmd, limit, category) };
          }

          if (subCmd && arg === "personality" && method === "GET") {
            if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const traitName = segments[3] ? decodeURIComponent(segments[3]) : undefined;
            if (traitName === "history") {
              const trait = queryParams.get("trait") ?? "";
              return { status: 200, data: this.ctx.memoryDb.getPersonalityHistory(subCmd, trait) };
            }
            if (traitName === "drift") {
              return { status: 200, data: this.ctx.memoryDb.getPersonalityDrift(subCmd) };
            }
            return { status: 200, data: this.ctx.memoryDb.getPersonalitySnapshot(subCmd) };
          }

          if (subCmd && arg === "strategy-history" && method === "GET") {
            if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 20;
            return { status: 200, data: this.ctx.memoryDb.getStrategyHistory(subCmd, limit) };
          }

          if (subCmd && arg === "export" && method === "GET") {
            if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const agent = this.ctx.agentConfigs.find((a) => a.name === subCmd);
            if (!agent) return { status: 404, data: { error: `Agent not found: ${subCmd}` } };
            const template = queryParams.get("template") === "1";
            const bundle = exportAgentState(this.ctx.memoryDb, agent, { template });
            return { status: 200, data: bundle };
          }

          if (subCmd && arg === "import" && method === "POST") {
            if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const agent = this.ctx.agentConfigs.find((a) => a.name === subCmd);
            if (!agent) return { status: 404, data: { error: `Agent not found: ${subCmd}` } };
            try {
              const parsed = (typeof body === "string" ? JSON.parse(body) : body) as {
                bundle: AgentStateBundle;
                options?: Partial<ImportOptions>;
              };
              const result = importAgentState(this.ctx.memoryDb, parsed.bundle, parsed.options);
              return { status: 200, data: result };
            } catch (err) {
              return { status: 400, data: { error: String(err) } };
            }
          }

          if (subCmd && arg === "snapshots" && method === "GET") {
            const snapshotDir = join(homedir(), ".local", "share", "operad", "snapshots");
            return { status: 200, data: listSnapshots(snapshotDir, subCmd) };
          }

          if (subCmd && arg === "snapshot" && method === "POST") {
            if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const agent = this.ctx.agentConfigs.find((a) => a.name === subCmd);
            if (!agent) return { status: 404, data: { error: `Agent not found: ${subCmd}` } };
            const snapshotDir = join(homedir(), ".local", "share", "operad", "snapshots");
            const snapshotPath = saveSnapshot(this.ctx.memoryDb, agent, snapshotDir);
            const pruned = pruneSnapshots(snapshotDir, subCmd);
            return { status: 201, data: { path: snapshotPath, pruned } };
          }

          return { status: 400, data: { error: `Unknown agents endpoint: ${subCmd ?? "(root)"}` } };
        }

        case "agent-chat": {
          const agentName = name ? decodeURIComponent(name) : undefined;
          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };

          if (agentName && method === "GET") {
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 50;
            return { status: 200, data: this.ctx.memoryDb.getConversationHistory(agentName, limit) };
          }
          if (agentName && method === "DELETE") {
            const cleared = this.ctx.memoryDb.clearConversation(agentName);
            return { status: 200, data: { ok: true, cleared } };
          }
          return { status: 400, data: { error: "Use WS agent_chat for sending messages" } };
        }

        case "agent-messages": {
          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };

          if (!name && method === "GET") {
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 50;
            return { status: 200, data: this.ctx.memoryDb.getRecentAgentMessages(limit) };
          }

          if (name && segments[1] && method === "GET") {
            const agent1 = decodeURIComponent(name);
            const agent2 = decodeURIComponent(segments[1]);
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 50;
            return { status: 200, data: this.ctx.memoryDb.getConversation(agent1, agent2, limit) };
          }

          if (!name && method === "POST") {
            try {
              const parsed = JSON.parse(body) as { from: string; to: string; content: string; type?: string };
              if (!parsed.from || !parsed.to || !parsed.content) {
                return { status: 400, data: { error: "from, to, and content required" } };
              }
              const msgId = this.ctx.memoryDb.sendAgentMessage(parsed.from, parsed.to, parsed.content, {
                messageType: parsed.type,
              });
              this.ctx.broadcastWs("agent_message", {
                id: msgId, from_agent: parsed.from, to_agent: parsed.to,
                message_type: parsed.type ?? "info", content: parsed.content,
                created_at: Math.floor(Date.now() / 1000),
              });
              return { status: 200, data: { ok: true, id: msgId } };
            } catch (err) {
              return { status: 400, data: { error: String(err) } };
            }
          }

          if (name === "pairs" && method === "GET") {
            return { status: 200, data: this.ctx.memoryDb.getAgentConversationPairs() };
          }

          return { status: 400, data: { error: "Unknown agent-messages endpoint" } };
        }

        case "cognitive": {
          const subCmd = name;
          const arg = segments[2] ? decodeURIComponent(segments[2]) : undefined;

          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };

          if (subCmd === "state" && method === "GET") {
            const state = this.ctx.state.getState();
            const ctx = buildOodaContext(state, this.ctx.memoryDb, this.ctx.config.orchestrator);
            return { status: 200, data: ctx };
          }

          if (subCmd === "trigger" && method === "POST") {
            if (this.ctx.sdkBridge?.isAttached) {
              return { status: 409, data: { error: "SDK session active" } };
            }
            this.agentEngine.runOodaCycle().catch((err) => {
              this.ctx.log.error(`Manual OODA trigger failed: ${err}`);
            });
            return { status: 202, data: { ok: true, message: "OODA cycle triggered" } };
          }

          if (subCmd === "goals") {
            if (method === "GET") {
              return { status: 200, data: this.ctx.memoryDb.getGoalTree() };
            }
            if (method === "POST") {
              try {
                const parsed = JSON.parse(body) as { title: string; description?: string; priority?: number; parentId?: number };
                if (!parsed.title) return { status: 400, data: { error: "title required" } };
                const id = this.ctx.memoryDb.createGoal(parsed.title, {
                  description: parsed.description,
                  parentId: parsed.parentId,
                  priority: parsed.priority,
                });
                return { status: 201, data: { id } };
              } catch {
                return { status: 400, data: { error: "Invalid JSON body" } };
              }
            }
          }

          if (subCmd === "goals" && arg && method === "PUT") {
            try {
              const parsed = JSON.parse(body) as { status?: string; actualOutcome?: string; successScore?: number };
              const updated = this.ctx.memoryDb.updateGoal(Number(arg), parsed);
              return { status: updated ? 200 : 404, data: { ok: updated } };
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
          }

          if (subCmd === "decisions" && method === "GET") {
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 20;
            const agentFilter = queryParams.get("agent") ?? undefined;
            return { status: 200, data: this.ctx.memoryDb.getRecentDecisions(limit, agentFilter) };
          }

          if (subCmd === "strategy" && arg && method === "GET") {
            const strategy = this.ctx.memoryDb.getActiveStrategy(arg);
            if (!strategy) return { status: 404, data: { error: "No strategy found" } };
            return { status: 200, data: strategy };
          }

          if (subCmd === "messages" && method === "GET") {
            const agentFilter = queryParams.get("agent") ?? "master-controller";
            return { status: 200, data: this.ctx.memoryDb.getUnreadMessages(agentFilter) };
          }

          if (subCmd === "metrics" && method === "GET") {
            return { status: 200, data: this.ctx.memoryDb.getDecisionMetrics() };
          }

          return { status: 400, data: { error: `Unknown cognitive endpoint: ${subCmd ?? "(root)"}` } };
        }

        case "profile": {
          const subCmd = name;
          const arg = segments[2] ? decodeURIComponent(segments[2]) : undefined;

          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };

          if (!subCmd && method === "GET") {
            const category = queryParams.get("category") ?? undefined;
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 100;
            return { status: 200, data: this.ctx.memoryDb.getProfile(category, limit) };
          }

          if (subCmd === "note" && method === "POST") {
            try {
              const parsed = JSON.parse(body) as { content: string; tags?: string[]; weight?: number };
              if (!parsed.content) return { status: 400, data: { error: "content required" } };
              const id = this.ctx.memoryDb.addProfileEntry("note", parsed.content, {
                weight: parsed.weight,
                tags: parsed.tags,
                source: "manual",
              });
              return { status: 201, data: { id, duplicate: id === null } };
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
          }

          if (subCmd === "trait" && method === "POST") {
            try {
              const parsed = JSON.parse(body) as { content: string; weight?: number };
              if (!parsed.content) return { status: 400, data: { error: "content required" } };
              const id = this.ctx.memoryDb.addProfileEntry("trait", parsed.content, {
                weight: parsed.weight ?? 3.0,
                source: "manual",
              });
              return { status: 201, data: { id, duplicate: id === null } };
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
          }

          if (subCmd === "chat-export" && method === "POST") {
            try {
              const parsed = JSON.parse(body) as { content: string; source?: string };
              if (!parsed.content) return { status: 400, data: { error: "content required" } };
              const chunks = chunkText(parsed.content, 2000);
              let saved = 0;
              for (const chunk of chunks) {
                const id = this.ctx.memoryDb.addProfileEntry("chat_export", chunk, {
                  weight: 0.5,
                  source: parsed.source ?? "upload",
                });
                if (id !== null) saved++;
              }
              return { status: 201, data: { ok: true, chunks: chunks.length, saved } };
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
          }

          if (subCmd === "preview" && method === "GET") {
            const traits = this.ctx.memoryDb.getProfile("trait", 20);
            const notes = this.ctx.memoryDb.getProfile("note", 20);
            const styles = this.ctx.memoryDb.getProfile("style", 10);
            const chatCount = this.ctx.memoryDb.getProfile("chat_export").length;

            let preview = "## User Profile\n\n";
            if (traits.length > 0) {
              preview += "**Traits:**\n";
              for (const t of traits) preview += `- ${t.content} (weight: ${t.weight})\n`;
            }
            if (notes.length > 0) {
              preview += "\n**Notes/Ideas:**\n";
              for (const n of notes) preview += `- ${n.content}\n`;
            }
            if (styles.length > 0) {
              preview += "\n**Communication Style:**\n";
              for (const s of styles) preview += `- ${s.content}\n`;
            }
            if (chatCount > 0) {
              preview += `\n_${chatCount} chat export segments available._\n`;
            }
            return { status: 200, data: { preview, counts: { traits: traits.length, notes: notes.length, styles: styles.length, chat_exports: chatCount } } };
          }

          const profileId = subCmd ? Number(subCmd) : NaN;
          if (!isNaN(profileId)) {
            if (method === "PUT") {
              try {
                const parsed = JSON.parse(body) as { content?: string; weight?: number; tags?: string[] };
                const updated = this.ctx.memoryDb.updateProfileEntry(profileId, parsed);
                return { status: updated ? 200 : 404, data: { ok: updated } };
              } catch {
                return { status: 400, data: { error: "Invalid JSON body" } };
              }
            }
            if (method === "DELETE") {
              const deleted = this.ctx.memoryDb.deleteProfileEntry(profileId);
              return { status: deleted ? 200 : 404, data: { ok: deleted } };
            }
          }

          return { status: 400, data: { error: `Unknown profile endpoint: ${subCmd ?? "(root)"}` } };
        }

        case "memories": {
          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
          const projectPath = name ? decodeURIComponent(name) : undefined;

          if (method === "GET" && projectPath) {
            if (segments[2] === "search") {
              const q = queryParams.get("q") ?? "";
              const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 10;
              const results = this.ctx.memoryDb.searchMemories(projectPath, q, limit);
              return { status: 200, data: results };
            }
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 20;
            const memories = this.ctx.memoryDb.getTopMemories(projectPath, limit);
            return { status: 200, data: memories };
          }

          if (method === "POST" && projectPath) {
            try {
              const parsed = JSON.parse(body) as { category: string; content: string; sessionId?: string };
              if (!parsed.content) return { status: 400, data: { error: "content required" } };
              const id = this.ctx.memoryDb.createMemory(
                projectPath,
                (parsed.category ?? "discovery") as any,
                parsed.content,
                parsed.sessionId,
              );
              return { status: 201, data: { id, duplicate: id === null } };
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
          }

          if (method === "DELETE" && projectPath) {
            const memId = segments[2] ? Number(segments[2]) : undefined;
            if (!memId) return { status: 400, data: { error: "Memory ID required" } };
            const deleted = this.ctx.memoryDb.deleteMemory(memId);
            return { status: deleted ? 200 : 404, data: { ok: deleted } };
          }

          if (method === "POST" && !projectPath) {
            if (segments[1] === "decay") {
              let decayed = 0;
              const projects = new Set<string>();
              for (const mem of this.ctx.memoryDb.getTopMemories("", 1000)) {
                projects.add(mem.project_path);
              }
              for (const p of projects) {
                decayed += this.ctx.memoryDb.decayMemories(p);
              }
              return { status: 200, data: { decayed } };
            }
          }

          return { status: 400, data: { error: "Invalid memories request" } };
        }

        case "tools": {
          const toolExec = this.ctx.getToolExecutor();
          if (!toolExec) return { status: 503, data: { error: "Tool executor not initialized" } };

          if (method === "GET") {
            if (name) {
              const tool = toolExec.getTool(name);
              if (!tool) return { status: 404, data: { error: `Tool "${name}" not found` } };
              const arg = segments[2] ? decodeURIComponent(segments[2]) : undefined;
              if (arg === "history" && this.ctx.memoryDb) {
                const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 50;
                const executions = this.ctx.memoryDb.getToolExecutions(undefined, limit)
                  .filter((e) => e.tool_name === name);
                return { status: 200, data: executions };
              }
              return {
                status: 200,
                data: {
                  name: tool.name, description: tool.description, category: tool.category,
                  params: tool.params, timeout_ms: tool.timeout_ms, parallelizable: tool.parallelizable,
                  source: tool.source ?? "builtin", sourceId: tool.sourceId,
                },
              };
            }
            const sourceFilter = queryParams.get("source") as import("./tools.js").ToolSource | null;
            const catFilter = queryParams.get("category") as import("./tools.js").ToolCategory | null;
            let tools = toolExec.getAllTools();
            if (sourceFilter) tools = tools.filter((t) => t.source === sourceFilter);
            if (catFilter) tools = tools.filter((t) => t.category === catFilter);
            return {
              status: 200,
              data: tools.map((t) => ({
                name: t.name, description: t.description, category: t.category,
                source: t.source ?? "builtin", sourceId: t.sourceId,
                paramCount: t.params.length,
              })),
            };
          }

          if (method === "GET" && name === "stats" && this.ctx.memoryDb) {
            return { status: 200, data: this.ctx.memoryDb.getToolStats() };
          }

          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "trust": {
          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Database not ready" } };
          if (method === "GET" && name) {
            const { score, recommended } = this.ctx.memoryDb.getRecommendedAutonomy(name);
            const history = this.ctx.memoryDb.getTrustHistory(name, 20);
            return { status: 200, data: { agent: name, score, recommended, history } };
          }
          if (method === "GET") {
            const agents = this.ctx.agentConfigs.map((a) => {
              const { score, recommended } = this.ctx.memoryDb!.getRecommendedAutonomy(a.name);
              return { agent: a.name, score, recommended, current: a.autonomy_level ?? "observe" };
            });
            return { status: 200, data: agents };
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "leases": {
          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Database not ready" } };
          if (method === "GET" && name) {
            const leases = this.ctx.memoryDb.getActiveLeases(name);
            return { status: 200, data: leases };
          }
          if (method === "DELETE" && name) {
            const goalId = queryParams.has("goal_id") ? Number(queryParams.get("goal_id")) : undefined;
            const revoked = this.ctx.memoryDb.revokeLeases(name, goalId);
            return { status: 200, data: { revoked } };
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "consolidation": {
          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Database not ready" } };

          if (method === "GET") {
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 10;
            const history = getConsolidationHistory(this.ctx.memoryDb, limit);
            const lastRun = getLastConsolidationTime(this.ctx.memoryDb);
            return { status: 200, data: { last_run_at: lastRun, history } };
          }

          if (method === "POST") {
            const agentNames = this.ctx.agentConfigs.filter((a) => a.enabled).map((a) => a.name);
            const result = runConsolidation(this.ctx.memoryDb, agentNames, this.ctx.log);
            return { status: 200, data: result };
          }

          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "specializations": {
          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Database not ready" } };

          if (method === "GET") {
            try {
              const specs = this.ctx.memoryDb.getSpecializations(name || undefined);
              return { status: 200, data: specs };
            } catch (err) {
              this.ctx.log.warn("getSpecializations failed", { err: String(err) });
              return { status: 200, data: [] };
            }
          }

          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "roundtables": {
          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Database not ready" } };

          if (method === "GET") {
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 20;
            try {
              const dbHandle = this.ctx.memoryDb.requireDb();
              const messages = dbHandle.prepare(
                `SELECT * FROM agent_messages WHERE message_type LIKE 'roundtable_%'
                 ORDER BY created_at DESC LIMIT ?`,
              ).all(limit);
              return { status: 200, data: messages };
            } catch (err) {
              this.ctx.log.warn("roundtables query failed", { err: String(err) });
              return { status: 200, data: [] };
            }
          }

          if (method === "POST" && body) {
            if (!this.ctx.sdkBridge) return { status: 503, data: { error: "SDK bridge not initialized" } };
            try {
              const b = (typeof body === "string" ? JSON.parse(body) : body) as Record<string, unknown>;
              const topic = String(b.topic ?? "");
              const agents = (b.agents as string[]) ?? [];
              const roundtableCtx = b.context ? String(b.context) : undefined;

              if (!topic) return { status: 400, data: { error: "topic required" } };
              if (!agents.length) return { status: 400, data: { error: "agents array required" } };

              const result = await this.agentEngine.executeRoundtable(topic, agents, roundtableCtx);
              return { status: 200, data: result };
            } catch (err) {
              return { status: 500, data: { error: String(err) } };
            }
          }

          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "schedules": {
          const schedEng = this.ctx.getScheduleEngine();
          if (!schedEng) return { status: 503, data: { error: "Schedule engine not initialized" } };

          if (method === "GET") {
            const agentFilter = name || (queryParams.get("agent") ?? undefined);
            const schedules = schedEng.getAll(agentFilter);
            return { status: 200, data: schedules };
          }

          if (method === "POST" && body) {
            const b = (typeof body === "string" ? JSON.parse(body) : body) as Record<string, unknown>;
            if (!b.agent_name || !b.schedule_name || !b.prompt) {
              return { status: 400, data: { error: "Missing required fields: agent_name, schedule_name, prompt" } };
            }
            const id = schedEng.upsert({
              agentName: String(b.agent_name),
              scheduleName: String(b.schedule_name),
              cronExpr: b.cron_expr ? String(b.cron_expr) : undefined,
              intervalMinutes: b.interval_minutes ? Number(b.interval_minutes) : undefined,
              prompt: String(b.prompt),
              maxBudgetUsd: b.max_budget_usd ? Number(b.max_budget_usd) : undefined,
              createdBy: "api",
            });
            return { status: 201, data: { id } };
          }

          if (method === "DELETE" && name) {
            const agentName = queryParams.get("agent") ?? "master-controller";
            const deleted = schedEng.delete(agentName, name);
            return { status: 200, data: { deleted } };
          }

          if (method === "PATCH" && name) {
            const b = (typeof body === "string" ? JSON.parse(body) : body) as Record<string, unknown>;
            const id = parseInt(name, 10);
            if (isNaN(id)) return { status: 400, data: { error: "Invalid schedule ID" } };
            schedEng.setEnabled(id, Boolean(b.enabled));
            return { status: 200, data: { id, enabled: Boolean(b.enabled) } };
          }

          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "quota": {
          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
          if (method === "GET") {
            return { status: 200, data: computeQuotaStatus(this.ctx.memoryDb, this.ctx.config.orchestrator) };
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "tokens-daily": {
          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
          if (method === "GET") {
            const days = queryParams.has("days") ? Number(queryParams.get("days")) : 14;
            return { status: 200, data: this.ctx.memoryDb.getDailyTokens(days) };
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "tokens-window": {
          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
          if (method === "GET") {
            const hours = this.ctx.config.orchestrator.quota_window_hours;
            return { status: 200, data: this.ctx.memoryDb.getWindowTokens(hours) };
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "costs": {
          if (!this.ctx.memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };

          if (method === "GET") {
            if (name === "daily") {
              const days = queryParams.has("days") ? Number(queryParams.get("days")) : 30;
              return { status: 200, data: this.ctx.memoryDb.getDailyCosts(days) };
            }
            if (name === "per-session") {
              const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 20;
              return { status: 200, data: this.ctx.memoryDb.getPerSessionCosts(limit) };
            }
            if (name) {
              const costs = this.ctx.memoryDb.getSessionCosts(name);
              return { status: 200, data: costs };
            }
            const fromEpoch = queryParams.has("from") ? Number(queryParams.get("from")) : undefined;
            const toEpoch = queryParams.has("to") ? Number(queryParams.get("to")) : undefined;
            return { status: 200, data: this.ctx.memoryDb.getAggregateCosts(fromEpoch, toEpoch) };
          }

          return { status: 405, data: { error: "Method not allowed" } };
        }

        default:
          return { status: 404, data: { error: `Unknown endpoint: ${command}` } };
      }

      return { status: resp.ok ? 200 : 400, data: resp.ok ? resp.data : { error: resp.error } };
    } catch (err) {
      return { status: 500, data: { error: String(err) } };
    }
  }

  // ---------------------------------------------------------------------------
  // Helper methods moved from Daemon (customization, MCP CRUD, scripts, ADB)
  // ---------------------------------------------------------------------------

  /** Sensitive env var key patterns — values are redacted in API responses */
  private static readonly SENSITIVE_ENV_KEYS = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;

  /** Read a JSON file, returning null on any error */
  private readJsonFile(path: string): unknown {
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }

  /** Validate that a file path is safe to read/write (under ~/.claude/ or a known project) */
  private isAllowedCustomizationPath(filePath: string): boolean {
    const home = homedir();
    const claudeDir = join(home, ".claude");
    const resolved = resolve(filePath);

    if (resolved.startsWith(claudeDir + "/")) return true;

    const knownPaths = this.ctx.config.sessions
      .map((s: SessionConfig) => s.path)
      .filter(Boolean) as string[];
    for (const entry of this.ctx.registry.entries()) {
      if (entry.path) knownPaths.push(entry.path);
    }
    for (const p of knownPaths) {
      const projectDir = resolve(p);
      if (resolved === join(projectDir, "CLAUDE.md")) return true;
      if (resolved.startsWith(join(projectDir, ".claude") + "/")) return true;
    }
    return false;
  }

  /** Redact sensitive env values */
  private redactEnv(env: Record<string, string>): Record<string, string> {
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      redacted[k] = ServerEngine.SENSITIVE_ENV_KEYS.test(k) ? "***" : v;
    }
    return redacted;
  }

  /** Build full customization response */
  private cmdCustomization(projectPath?: string): { ok: boolean; data?: unknown; error?: string } {
    try {
      const home = homedir();
      const claudeDir = join(home, ".claude");

      const claudeJson = this.readJsonFile(join(home, ".claude.json")) as Record<string, unknown> | null;
      const settingsJson = this.readJsonFile(join(claudeDir, "settings.json")) as Record<string, unknown> | null;
      const installedPluginsJson = this.readJsonFile(join(claudeDir, "plugins", "installed_plugins.json")) as Record<string, unknown> | null;
      const blocklistJson = this.readJsonFile(join(claudeDir, "plugins", "blocklist.json")) as Record<string, unknown> | null;
      const installCountsJson = this.readJsonFile(join(claudeDir, "plugins", "install-counts-cache.json")) as Record<string, unknown> | null;
      const marketplacesJson = this.readJsonFile(join(claudeDir, "plugins", "known_marketplaces.json")) as Record<string, unknown> | null;

      const mcpServers: Array<{
        name: string; scope: string; source: string; command: string;
        args: string[]; env?: Record<string, string>; disabled: boolean;
      }> = [];

      const cjMcps = (claudeJson?.mcpServers ?? {}) as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
      for (const [n, cfg] of Object.entries(cjMcps)) {
        mcpServers.push({
          name: n, scope: "user", source: "claude-json",
          command: cfg.command ?? "", args: cfg.args ?? [],
          env: cfg.env ? this.redactEnv(cfg.env) : undefined,
          disabled: false,
        });
      }

      const sjMcps = ((settingsJson?.mcpServers ?? {}) as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>);
      for (const [n, cfg] of Object.entries(sjMcps)) {
        const existing = mcpServers.find(m => m.name === n);
        if (existing) {
          existing.source = "settings-json";
          existing.command = cfg.command ?? existing.command;
          existing.args = cfg.args ?? existing.args;
          if (cfg.env) existing.env = this.redactEnv(cfg.env);
        } else {
          mcpServers.push({
            name: n, scope: "user", source: "settings-json",
            command: cfg.command ?? "", args: cfg.args ?? [],
            env: cfg.env ? this.redactEnv(cfg.env) : undefined,
            disabled: false,
          });
        }
      }

      if (projectPath && claudeJson?.projects) {
        const projects = claudeJson.projects as Record<string, { disabledMcpServers?: string[]; mcpServers?: Record<string, unknown> }>;
        const projCfg = projects[projectPath];
        if (projCfg?.disabledMcpServers) {
          for (const disabledName of projCfg.disabledMcpServers) {
            const srv = mcpServers.find(m => m.name === disabledName);
            if (srv) srv.disabled = true;
          }
        }
        if (projCfg?.mcpServers) {
          for (const [n, cfg] of Object.entries(projCfg.mcpServers as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>)) {
            mcpServers.push({
              name: n, scope: "project", source: "claude-json",
              command: cfg.command ?? "", args: cfg.args ?? [],
              env: cfg.env ? this.redactEnv(cfg.env) : undefined,
              disabled: false,
            });
          }
        }
      }

      const enabledPlugins = (settingsJson?.enabledPlugins ?? {}) as Record<string, boolean>;
      const blocklist = ((blocklistJson?.plugins ?? []) as Array<{ plugin: string; reason?: string }>);
      const blockMap = new Map(blocklist.map(b => [b.plugin, b.reason ?? "blocked"]));
      const installCounts = ((installCountsJson?.counts ?? []) as Array<{ plugin: string; unique_installs: number }>);
      const countMap = new Map(installCounts.map(c => [c.plugin, c.unique_installs]));

      const plugins: Array<{
        id: string; name: string; description: string; author: string; scope: string;
        enabled: boolean; blocked: boolean; blockReason?: string; version: string;
        installedAt: string; installPath: string; type: string; installs?: number;
      }> = [];

      const installedMap = ((installedPluginsJson?.plugins ?? {}) as Record<string, Array<{
        scope?: string; installPath?: string; version?: string; installedAt?: string;
      }>>);

      for (const [pluginId, entries] of Object.entries(installedMap)) {
        const entry = entries[0];
        if (!entry) continue;
        let pluginName = pluginId.split("@")[0];
        let pluginDesc = "";
        let pluginAuthor = "";
        let pluginType: "native" | "external" = "native";

        if (entry.installPath) {
          const pjPath = join(entry.installPath, ".claude-plugin", "plugin.json");
          const pj = this.readJsonFile(pjPath) as { name?: string; description?: string; author?: { name?: string } } | null;
          if (pj) {
            pluginName = pj.name ?? pluginName;
            pluginDesc = pj.description ?? "";
            pluginAuthor = pj.author?.name ?? "";
          }
          if (existsSync(join(entry.installPath, ".mcp.json"))) {
            pluginType = "external";
          }
        }

        plugins.push({
          id: pluginId, name: pluginName, description: pluginDesc,
          author: pluginAuthor, scope: entry.scope ?? "user",
          enabled: enabledPlugins[pluginId] ?? false,
          blocked: blockMap.has(pluginId),
          blockReason: blockMap.get(pluginId),
          version: entry.version ?? "", installedAt: entry.installedAt ?? "",
          installPath: entry.installPath ?? "", type: pluginType,
          installs: countMap.get(pluginId),
        });
      }

      const skills: Array<{ name: string; path: string; scope: string; source?: string }> = [];
      const userSkillsDir = join(claudeDir, "skills");
      if (existsSync(userSkillsDir)) {
        try {
          for (const f of readdirSync(userSkillsDir)) {
            if (!f.endsWith(".md")) continue;
            skills.push({ name: f.replace(/\.md$/, ""), path: join(userSkillsDir, f), scope: "user" });
          }
        } catch { /* skip */ }
      }
      if (projectPath) {
        const projSkillsDir = join(projectPath, ".claude", "skills");
        if (existsSync(projSkillsDir)) {
          try {
            for (const f of readdirSync(projSkillsDir)) {
              if (!f.endsWith(".md")) continue;
              skills.push({ name: f.replace(/\.md$/, ""), path: join(projSkillsDir, f), scope: "project" });
            }
          } catch { /* skip */ }
        }
      }

      const plans: Array<{ name: string; path: string; scope: string }> = [];
      const userPlansDir = join(claudeDir, "plans");
      if (existsSync(userPlansDir)) {
        try {
          for (const f of readdirSync(userPlansDir)) {
            if (!f.endsWith(".md")) continue;
            plans.push({ name: f.replace(/\.md$/, ""), path: join(userPlansDir, f), scope: "user" });
          }
        } catch { /* skip */ }
      }
      if (projectPath) {
        const projPlansDir = join(projectPath, ".claude", "plans");
        if (existsSync(projPlansDir)) {
          try {
            for (const f of readdirSync(projPlansDir)) {
              if (!f.endsWith(".md")) continue;
              plans.push({ name: f.replace(/\.md$/, ""), path: join(projPlansDir, f), scope: "project" });
            }
          } catch { /* skip */ }
        }
      }

      const claudeMds: Array<{ label: string; path: string; scope: string }> = [];
      const globalMd = join(claudeDir, "CLAUDE.md");
      if (existsSync(globalMd)) {
        claudeMds.push({ label: "Global (User)", path: globalMd, scope: "user" });
      }
      const projectsDir = join(claudeDir, "projects");
      if (existsSync(projectsDir)) {
        try {
          const mangledProject = projectPath
            ? "-" + projectPath.replace(/[/.]/g, "-").replace(/^-+/, "")
            : null;
          for (const d of readdirSync(projectsDir)) {
            if (mangledProject && d !== mangledProject) continue;
            const memDir = join(projectsDir, d, "memory");
            if (!existsSync(memDir)) continue;
            const gitIdx = d.lastIndexOf("-git-");
            const projName = gitIdx >= 0
              ? d.slice(gitIdx + 5)
              : d.split("-").filter(Boolean).pop() ?? d;
            try {
              for (const f of readdirSync(memDir)) {
                if (!f.endsWith(".md")) continue;
                claudeMds.push({ label: `${projName}: ${f.replace(/\.md$/, "")}`, path: join(memDir, f), scope: "memory" });
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
      if (projectPath) {
        const projMd = join(projectPath, "CLAUDE.md");
        if (existsSync(projMd)) {
          claudeMds.push({ label: `Project: ${projectPath.split("/").pop() ?? projectPath}`, path: projMd, scope: "project" });
        }
      }

      const hooks: Array<{ event: string; matcher: string; type: string; command: string; timeout?: number }> = [];
      const hooksConfig = (settingsJson?.hooks ?? {}) as Record<string, Array<{
        matcher?: string;
        hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
      }>>;
      for (const [event, matchers] of Object.entries(hooksConfig)) {
        if (!Array.isArray(matchers)) continue;
        for (const m of matchers) {
          if (!m.hooks || !Array.isArray(m.hooks)) continue;
          for (const h of m.hooks) {
            hooks.push({ event, matcher: m.matcher ?? "*", type: h.type ?? "command", command: h.command ?? "", timeout: h.timeout });
          }
        }
      }

      const marketplaceSources: Array<{ name: string; repo: string; lastUpdated: string }> = [];
      const marketplacePlugins: Array<{
        id: string; name: string; description: string; author: string;
        marketplace: string; type: string; installed: boolean; enabled: boolean; installs: number;
      }> = [];
      const installedIds = new Set(Object.keys(installedMap));

      if (marketplacesJson) {
        for (const [mktName, mktCfg] of Object.entries(marketplacesJson as Record<string, {
          source?: { repo?: string }; installLocation?: string; lastUpdated?: string;
        }>)) {
          marketplaceSources.push({ name: mktName, repo: mktCfg.source?.repo ?? "", lastUpdated: mktCfg.lastUpdated ?? "" });
          const mktDir = mktCfg.installLocation;
          if (!mktDir || !existsSync(mktDir)) continue;
          for (const [subDir, pluginType] of [["plugins", "native"], ["external_plugins", "external"]] as [string, string][]) {
            const dir = join(mktDir, subDir);
            if (!existsSync(dir)) continue;
            try {
              for (const n of readdirSync(dir)) {
                const pj = this.readJsonFile(join(dir, n, ".claude-plugin", "plugin.json")) as { name?: string; description?: string; author?: { name?: string } } | null;
                if (!pj) continue;
                const pluginId = `${n}@${mktName}`;
                marketplacePlugins.push({
                  id: pluginId, name: pj.name ?? n,
                  description: pj.description ?? "", author: pj.author?.name ?? "",
                  marketplace: mktName, type: pluginType,
                  installed: installedIds.has(pluginId),
                  enabled: enabledPlugins[pluginId] ?? false,
                  installs: countMap.get(pluginId) ?? 0,
                });
              }
            } catch { /* skip */ }
          }
        }
      }
      marketplacePlugins.sort((a, b) => b.installs - a.installs);

      return {
        ok: true,
        data: {
          mcpServers, plugins, skills, plans, claudeMds, hooks,
          marketplace: { sources: marketplaceSources, available: marketplacePlugins },
          projectPath: projectPath ?? undefined,
        },
      };
    } catch (err) {
      return { ok: false, error: `Failed to read customization data: ${err}` };
    }
  }

  /** Read a customization file's content (skills, CLAUDE.md) */
  private cmdReadCustomizationFile(filePath: string): { ok: boolean; data?: unknown; error?: string } {
    if (!filePath || !this.isAllowedCustomizationPath(filePath)) {
      return { ok: false, error: "Path not allowed" };
    }
    try {
      const content = readFileSync(filePath, "utf-8");
      return { ok: true, data: { content } };
    } catch (err) {
      return { ok: false, error: `Failed to read file: ${err}` };
    }
  }

  /** Write a customization file's content (only .md files) */
  private cmdWriteCustomizationFile(filePath: string, content: string): { ok: boolean; data?: unknown; error?: string } {
    if (!filePath || !this.isAllowedCustomizationPath(filePath)) {
      return { ok: false, error: "Path not allowed" };
    }
    if (!filePath.endsWith(".md")) {
      return { ok: false, error: "Only .md files can be edited" };
    }
    try {
      writeFileSync(filePath, content, "utf-8");
      return { ok: true, data: { written: filePath } };
    } catch (err) {
      return { ok: false, error: `Failed to write file: ${err}` };
    }
  }

  // -- MCP CRUD ---------------------------------------------------------------

  /** Atomic JSON file write: write .tmp then rename */
  private writeJsonFileAtomic(filePath: string, data: unknown): void {
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmp, filePath);
  }

  /** Path to ~/.claude.json */
  private get claudeJsonPath(): string {
    return join(homedir(), ".claude.json");
  }

  /** Path to settings.json (Claude Code settings) */
  private get settingsJsonPath(): string {
    return join(homedir(), ".claude", "settings.json");
  }

  /** Read ~/.claude.json, returning parsed object or empty default */
  private readClaudeJson(): Record<string, unknown> {
    try {
      if (existsSync(this.claudeJsonPath)) {
        return JSON.parse(readFileSync(this.claudeJsonPath, "utf-8")) as Record<string, unknown>;
      }
    } catch { /* fall through */ }
    return {};
  }

  /** Add a new MCP server to ~/.claude.json */
  private cmdMcpAdd(
    serverName: string,
    config: { command: string; args?: string[]; env?: Record<string, string> },
  ): { status: number; data: unknown } {
    try {
      const data = this.readClaudeJson();
      if (!data.mcpServers) data.mcpServers = {};
      const servers = data.mcpServers as Record<string, unknown>;
      if (servers[serverName]) {
        return { status: 409, data: { error: `MCP server '${serverName}' already exists` } };
      }
      servers[serverName] = {
        command: config.command,
        args: config.args ?? [],
        ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
      };
      this.writeJsonFileAtomic(this.claudeJsonPath, data);
      return { status: 200, data: { ok: true, servers: Object.keys(servers) } };
    } catch (err) {
      return { status: 500, data: { error: `Failed to add MCP server: ${err}` } };
    }
  }

  /** Update an existing MCP server in ~/.claude.json */
  private cmdMcpUpdate(
    serverName: string,
    config: { command?: string; args?: string[]; env?: Record<string, string> },
  ): { status: number; data: unknown } {
    try {
      const data = this.readClaudeJson();
      const servers = (data.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
      if (!servers[serverName]) {
        return { status: 404, data: { error: `MCP server '${serverName}' not found` } };
      }
      if (config.command !== undefined) servers[serverName].command = config.command;
      if (config.args !== undefined) servers[serverName].args = config.args;
      if (config.env !== undefined) {
        if (Object.keys(config.env).length > 0) {
          servers[serverName].env = config.env;
        } else {
          delete servers[serverName].env;
        }
      }
      this.writeJsonFileAtomic(this.claudeJsonPath, data);
      return { status: 200, data: { ok: true } };
    } catch (err) {
      return { status: 500, data: { error: `Failed to update MCP server: ${err}` } };
    }
  }

  /** Delete an MCP server from ~/.claude.json */
  private cmdMcpDelete(serverName: string): { status: number; data: unknown } {
    try {
      const data = this.readClaudeJson();
      const servers = (data.mcpServers ?? {}) as Record<string, unknown>;
      if (!servers[serverName]) {
        return { status: 404, data: { error: `MCP server '${serverName}' not found` } };
      }
      delete servers[serverName];
      this.writeJsonFileAtomic(this.claudeJsonPath, data);
      return { status: 200, data: { ok: true, servers: Object.keys(servers) } };
    } catch (err) {
      return { status: 500, data: { error: `Failed to delete MCP server: ${err}` } };
    }
  }

  /** Toggle MCP server enable/disable in settings.json */
  private cmdMcpToggle(serverName: string): { status: number; data: unknown } {
    try {
      let settings: Record<string, unknown> = {};
      if (existsSync(this.settingsJsonPath)) {
        try {
          settings = JSON.parse(readFileSync(this.settingsJsonPath, "utf-8")) as Record<string, unknown>;
        } catch { /* use empty */ }
      }
      const disabled = (settings.disabledMcpServers ?? []) as string[];
      const idx = disabled.indexOf(serverName);
      if (idx >= 0) {
        disabled.splice(idx, 1);
      } else {
        disabled.push(serverName);
      }
      settings.disabledMcpServers = disabled;
      this.writeJsonFileAtomic(this.settingsJsonPath, settings);
      return { status: 200, data: { ok: true, disabled: idx < 0 } };
    } catch (err) {
      return { status: 500, data: { error: `Failed to toggle MCP server: ${err}` } };
    }
  }

  // -- Script runner ----------------------------------------------------------

  /** List available scripts for a session project */
  private cmdListScripts(sessionName: string): { status: number; data: unknown } {
    const sessionPath = this.ctx.resolveSessionPath(sessionName);
    if (!sessionPath) return { status: 400, data: { error: `Session '${sessionName}' has no path` } };

    interface ScriptEntryOut {
      name: string;
      path: string;
      source: "root" | "scripts" | "package.json" | "saved";
      command?: string;
    }
    const scripts: ScriptEntryOut[] = [];

    try {
      const entries = readdirSync(sessionPath);
      for (const f of entries) {
        if (f.endsWith(".sh")) {
          const full = join(sessionPath, f);
          try {
            if (statSync(full).isFile()) {
              scripts.push({ name: f, path: full, source: "root" });
            }
          } catch { /* stat failed — skip */ }
        }
      }
    } catch { /* dir unreadable — skip */ }

    try {
      const scriptsDir = join(sessionPath, "scripts");
      const entries = readdirSync(scriptsDir);
      for (const f of entries) {
        if (f.endsWith(".sh")) {
          scripts.push({ name: f, path: join(scriptsDir, f), source: "scripts" });
        }
      }
    } catch { /* no scripts/ dir — skip */ }

    try {
      const pkgPath = join(sessionPath, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
      if (pkg.scripts) {
        for (const [scriptName, cmd] of Object.entries(pkg.scripts)) {
          scripts.push({ name: scriptName, path: "", source: "package.json", command: cmd });
        }
      }
    } catch { /* no package.json or parse error — skip */ }

    try {
      const savedDir = join(sessionPath, ".tmx-scripts");
      const entries = readdirSync(savedDir);
      for (const f of entries) {
        if (f.endsWith(".sh")) {
          scripts.push({ name: f, path: join(savedDir, f), source: "saved" });
        }
      }
    } catch { /* no saved scripts — skip */ }

    return { status: 200, data: { scripts } };
  }

  /** Run a script or ad-hoc command in a session's Termux tab */
  private cmdRunScript(
    sessionName: string,
    opts: { command?: string; script?: string; source?: string },
  ): { status: number; data: unknown } {
    const resolved = this.ctx.resolveName(sessionName);
    if (!resolved) return { status: 400, data: { error: `Unknown session: ${sessionName}` } };
    const sessionPath = this.ctx.resolveSessionPath(sessionName);
    if (!sessionPath) return { status: 400, data: { error: `Session '${sessionName}' has no path` } };

    const prefix = process.env.PREFIX ?? "/usr";

    if (opts.command) {
      const tempScript = join(prefix, "tmp", `tmx-cmd-${resolved}.sh`);
      writeFileSync(tempScript, `${BASH_SHEBANG}\n${opts.command}\n`, { mode: 0o755 });
      if (runScriptInTab(tempScript, sessionPath, resolved, this.ctx.log)) {
        return { status: 200, data: { ok: true } };
      }
      return { status: 500, data: { error: "Failed to launch command" } };
    }

    if (opts.script && opts.source) {
      let scriptPath: string;
      switch (opts.source) {
        case "root":
          scriptPath = join(sessionPath, opts.script);
          break;
        case "scripts":
          scriptPath = join(sessionPath, "scripts", opts.script);
          break;
        case "package.json": {
          const tempScript = join(prefix, "tmp", `tmx-npm-${resolved}.sh`);
          writeFileSync(
            tempScript,
            `${BASH_SHEBANG}\ncd "${sessionPath}" || exit 1\nbun run ${opts.script}\n`,
            { mode: 0o755 },
          );
          if (runScriptInTab(tempScript, sessionPath, resolved, this.ctx.log)) {
            return { status: 200, data: { ok: true } };
          }
          return { status: 500, data: { error: "Failed to launch npm script" } };
        }
        case "saved":
          scriptPath = join(sessionPath, ".tmx-scripts", opts.script);
          break;
        default:
          return { status: 400, data: { error: `Unknown script source: ${opts.source}` } };
      }

      if (!existsSync(scriptPath)) {
        return { status: 404, data: { error: `Script not found: ${scriptPath}` } };
      }
      if (runScriptInTab(scriptPath, sessionPath, resolved, this.ctx.log)) {
        return { status: 200, data: { ok: true } };
      }
      return { status: 500, data: { error: `Failed to launch script: ${opts.script}` } };
    }

    return { status: 400, data: { error: "Provide either 'command' or 'script' + 'source'" } };
  }

  /** Save an ad-hoc command as a reusable .sh script in .tmx-scripts/ */
  private cmdSaveScript(
    sessionName: string,
    opts: { name: string; command: string },
  ): { status: number; data: unknown } {
    const sessionPath = this.ctx.resolveSessionPath(sessionName);
    if (!sessionPath) return { status: 400, data: { error: `Session '${sessionName}' has no path` } };

    if (!/^[a-zA-Z0-9_-]+$/.test(opts.name)) {
      return { status: 400, data: { error: "Script name must be alphanumeric (a-z, 0-9, -, _)" } };
    }
    if (!opts.command?.trim()) {
      return { status: 400, data: { error: "Command cannot be empty" } };
    }

    const savedDir = join(sessionPath, ".tmx-scripts");
    mkdirSync(savedDir, { recursive: true });
    const fileName = opts.name.endsWith(".sh") ? opts.name : `${opts.name}.sh`;
    const filePath = join(savedDir, fileName);

    writeFileSync(filePath, `${BASH_SHEBANG}\n${opts.command}\n`, { mode: 0o755 });
    this.ctx.log.info(`Saved script '${fileName}' for session '${sessionName}'`);
    return { status: 200, data: { name: fileName, path: filePath, source: "saved" as const } };
  }

  // -- ADB device management (moved from Daemon) ------------------------------

  /** List connected ADB devices */
  private getAdbDevices(): { devices: { serial: string; state: string }[] } {
    try {
      const result = spawnSync(ADB_BIN, ["devices"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0 || !result.stdout) return { devices: [] };
      const devices = result.stdout
        .split("\n")
        .slice(1)
        .filter((l) => l.includes("\t"))
        .map((l) => {
          const [serial, state] = l.split("\t");
          return { serial: serial.trim(), state: state.trim() };
        });
      return { devices };
    } catch (err) {
      this.ctx.log.warn("getAdbDevices failed", { err: String(err) });
      return { devices: [] };
    }
  }

  /** Initiate ADB wireless connection using the adbc script */
  private adbWirelessConnect(): { status: number; data: unknown } {
    const script = this.ctx.config.adb.connect_script;
    if (!script) {
      return { status: 400, data: { error: "adb.connect_script not configured" } };
    }
    try {
      const result = spawnSync("bash", [script], {
        encoding: "utf-8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: process.env.PATH },
      });
      const output = (result.stdout ?? "") + (result.stderr ?? "");
      if (output.includes("connected") || output.includes("Reconnected")) {
        this.ctx.invalidateAdbSerial();
        return { status: 200, data: { ok: true, message: output.trim().split("\n").pop() } };
      }
      return { status: 500, data: { ok: false, message: output.trim().split("\n").pop() || "Connection failed" } };
    } catch (err) {
      return { status: 500, data: { ok: false, message: (err as Error).message } };
    }
  }

  /** Disconnect all ADB devices */
  private adbDisconnectAll(): { status: number; data: unknown } {
    try {
      spawnSync(ADB_BIN, ["disconnect", "-a"], { timeout: 5000, stdio: "ignore" });
      this.ctx.invalidateAdbSerial();
      return { status: 200, data: { ok: true } };
    } catch (err) {
      return { status: 500, data: { ok: false, message: (err as Error).message } };
    }
  }

  /** Disconnect a specific ADB device by serial */
  private adbDisconnectDevice(serial: string): { status: number; data: unknown } {
    try {
      const result = spawnSync(ADB_BIN, ["disconnect", serial], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.ctx.invalidateAdbSerial();
      const output = (result.stdout ?? "").trim();
      return { status: 200, data: { ok: true, serial, message: output } };
    } catch (err) {
      return { status: 500, data: { ok: false, message: (err as Error).message } };
    }
  }
}
