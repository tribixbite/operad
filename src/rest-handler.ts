/**
 * rest-handler.ts — REST API handler for the operad daemon dashboard.
 *
 * Extracted from ServerEngine (server-engine.ts) as part of the
 * transport-layer split. Owns handleDashboardApi() main dispatch; delegates
 * domain-specific work to route modules under src/routes/.
 *
 * Domain route modules:
 *   - CustomizationRoutes  (src/routes/customization-routes.ts)
 *   - McpRoutes            (src/routes/mcp-routes.ts)
 *   - ScriptsRoutes        (src/routes/scripts-routes.ts)
 *   - AdbRoutes            (src/routes/adb-routes.ts)
 *
 * WS dispatch lives in ws-handler.ts.
 * IPC routing lives in ipc-handler.ts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { AgentEngine } from "./agent-engine.js";
import type { ToolEngine } from "./tool-engine.js";
import type { Switchboard, SessionConfig } from "./types.js";
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
import { CustomizationRoutes } from "./routes/customization-routes.js";
import { McpRoutes } from "./routes/mcp-routes.js";
import { ScriptsRoutes } from "./routes/scripts-routes.js";
import { AdbRoutes } from "./routes/adb-routes.js";

/** Portable bash shebang — matches the one in daemon.ts */
const BASH_SHEBANG = process.env.PREFIX
  ? `#!${process.env.PREFIX}/bin/bash`
  : `#!/usr/bin/env bash`;

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
 * RestHandler — handles all REST API requests from DashboardServer.
 *
 * Accepts a shared OrchestratorContext so all state mutations are
 * reflected across the system without coupling to Daemon internals.
 *
 * AgentEngine and ToolEngine are injected via constructor so REST routes
 * can delegate to them without reaching back into Daemon.
 */
export class RestHandler {
  /** Domain-specific route handlers — extracted from RestHandler private helpers */
  private readonly customizationRoutes: CustomizationRoutes;
  private readonly mcpRoutes: McpRoutes;
  private readonly scriptsRoutes: ScriptsRoutes;
  private readonly adbRoutes: AdbRoutes;

  constructor(
    private readonly ctx: OrchestratorContext,
    private readonly agentEngine: AgentEngine,
    private readonly toolEngine: ToolEngine,
  ) {
    this.customizationRoutes = new CustomizationRoutes(ctx);
    this.mcpRoutes = new McpRoutes(ctx);
    this.scriptsRoutes = new ScriptsRoutes(ctx);
    this.adbRoutes = new AdbRoutes(ctx);
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
    // Resolve lazy deps once per request — getters may return null if not yet
    // initialised; every usage site guards with an explicit null check.
    const memoryDb = this.ctx.getMemoryDb();
    const sdkBridge = this.ctx.getSdkBridge();

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
              join(prefix, "lib/node_modules/claude-chrome-android/dist/cli.js"),
            ];
            const bridgeScript = bridgeCandidates.find(p => existsSync(p));
            if (!bridgeScript) {
              return {
                status: 404,
                data: {
                  error: "claude-chrome-android (CFC bridge) not installed",
                  fix: "bun add -g claude-chrome-android",
                  searched: bridgeCandidates,
                },
              };
            }
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
            const prefix2a = process.env.PREFIX ?? "/usr";
            const bridgeCandidates2 = [
              join(home2, ".bun/install/global/node_modules/claude-chrome-android/dist/cli.js"),
              join(home2, ".npm/lib/node_modules/claude-chrome-android/dist/cli.js"),
              join(prefix2a, "lib/node_modules/claude-chrome-android/dist/cli.js"),
            ];
            const bridgeScript2 = bridgeCandidates2.find(p => existsSync(p));
            if (!bridgeScript2) {
              return {
                status: 404,
                data: {
                  error: "claude-chrome-android (CFC bridge) not installed",
                  fix: "bun add -g claude-chrome-android",
                  searched: bridgeCandidates2,
                },
              };
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
          return this.scriptsRoutes.cmdListScripts(name);
        }
        case "run-script": {
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          try {
            const parsed = JSON.parse(body) as { command?: string; script?: string; source?: string };
            return this.scriptsRoutes.cmdRunScript(name, parsed);
          } catch {
            return { status: 400, data: { error: "Invalid JSON body" } };
          }
        }
        case "save-script": {
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          try {
            const parsed = JSON.parse(body) as { name: string; command: string };
            return this.scriptsRoutes.cmdSaveScript(name, parsed);
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
            return { status: 200, data: this.adbRoutes.getAdbDevices() };
          }
          if (name === "connect") {
            if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
            return this.adbRoutes.adbWirelessConnect();
          }
          if (name === "disconnect") {
            if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
            const serial = segments[2] ? decodeURIComponent(segments[2]) : undefined;
            if (serial) return this.adbRoutes.adbDisconnectDevice(serial);
            return this.adbRoutes.adbDisconnectAll();
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
          // Special sub-route: /api/customization/all-projects — aggregated view
          if (name === "all-projects") {
            resp = this.customizationRoutes.cmdAllProjectsCustomization();
          } else {
            resp = this.customizationRoutes.cmdCustomization(name);
          }
          break;
        case "customization-file": {
          if (method === "GET") {
            const filePath = segments.slice(1).map(s => decodeURIComponent(s)).join("/");
            if (!filePath) return { status: 400, data: { error: "File path required" } };
            resp = this.customizationRoutes.cmdReadCustomizationFile(filePath);
          } else if (method === "POST") {
            try {
              const parsed = JSON.parse(body) as { path: string; content: string };
              if (!parsed.path || typeof parsed.content !== "string") {
                return { status: 400, data: { error: "path and content required" } };
              }
              resp = this.customizationRoutes.cmdWriteCustomizationFile(parsed.path, parsed.content);
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
            const config = this.mcpRoutes.readClaudeJson();
            const settingsData = existsSync(this.mcpRoutes.settingsJsonPath)
              ? JSON.parse(readFileSync(this.mcpRoutes.settingsJsonPath, "utf-8")) : {};
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
            return this.mcpRoutes.cmdMcpToggle(name);
          }
          if (method === "POST" && !name) {
            try {
              const parsed = JSON.parse(body) as { name: string; command: string; args?: string[]; env?: Record<string, string> };
              if (!parsed.name || !parsed.command) return { status: 400, data: { error: "name and command required" } };
              return this.mcpRoutes.cmdMcpAdd(parsed.name, parsed);
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
          }
          if (method === "PUT" && name) {
            try {
              const parsed = JSON.parse(body) as { command?: string; args?: string[]; env?: Record<string, string> };
              return this.mcpRoutes.cmdMcpUpdate(name, parsed);
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
          }
          if (method === "DELETE" && name) {
            return this.mcpRoutes.cmdMcpDelete(name);
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
            if (!sdkBridge) return { status: 503, data: { error: "SDK bridge not initialized" } };
            if (!arg) return { status: 400, data: { error: "Session name required" } };
            try {
              const parsed = body ? JSON.parse(body) as { sessionId?: string; cwd?: string } : {};
              const sessionPath = parsed.cwd ?? this.ctx.resolveSessionPath(arg);
              if (!sessionPath) return { status: 400, data: { error: `No path for session: ${arg}` } };
              const result = await sdkBridge.attach(arg, parsed.sessionId, sessionPath);
              return { status: 200, data: result };
            } catch (err) {
              return { status: 500, data: { error: `Attach failed: ${err}` } };
            }
          }

          if (subCmd === "detach") {
            if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
            if (sdkBridge?.isAttached) await sdkBridge.detach();
            return { status: 200, data: { ok: true } };
          }

          if (subCmd === "prompt") {
            if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
            if (!sdkBridge?.isAttached) return { status: 400, data: { error: "No active SDK session" } };
            try {
              const parsed = JSON.parse(body) as { prompt: string; effort?: string; thinking?: unknown };
              if (!parsed.prompt) return { status: 400, data: { error: "prompt required" } };
              sdkBridge.send(parsed.prompt, {
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
                attached: sdkBridge?.isAttached ?? false,
                activeSession: sdkBridge?.activeSessionName ?? null,
                busy: sdkBridge?.isBusy ?? false,
              },
            };
          }

          if (subCmd === "sessions") {
            if (arg && segments[3] === "messages") {
              if (!sdkBridge) return { status: 503, data: { error: "SDK bridge not initialized" } };
              try {
                const msgs = await sdkBridge.getMessages(arg);
                return { status: 200, data: msgs };
              } catch (err) {
                return { status: 500, data: { error: `Failed to get messages: ${err}` } };
              }
            }
            if (!sdkBridge) return { status: 503, data: { error: "SDK bridge not initialized" } };
            try {
              const dir = queryParams.get("dir") ?? undefined;
              const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 50;
              const sessions = await sdkBridge.listAllSessions(dir, limit);
              return { status: 200, data: sessions };
            } catch (err) {
              return { status: 500, data: { error: `Failed to list sessions: ${err}` } };
            }
          }

          if (subCmd === "interrupt") {
            if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
            if (sdkBridge?.isAttached) await sdkBridge.interrupt();
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
            if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            // /api/agents/runs/<id> — fetch one run with full prompt/response/thinking text.
            const detailId = segments[2] ? Number(decodeURIComponent(segments[2])) : NaN;
            if (Number.isFinite(detailId)) {
              const run = memoryDb.getAgentRun(detailId);
              if (!run) return { status: 404, data: { error: `Run not found: ${detailId}` } };
              return { status: 200, data: run };
            }
            const agentFilter = queryParams.get("agent") ?? undefined;
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 50;
            return { status: 200, data: memoryDb.getAgentRuns(limit, agentFilter) };
          }

          if (subCmd === "costs") {
            if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            return { status: 200, data: memoryDb.getAgentCostSummary() };
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
            if (sdkBridge?.isAttached) {
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
            if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const category = queryParams.get("category") ?? undefined;
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 20;
            return { status: 200, data: memoryDb.getAgentLearnings(subCmd, limit, category) };
          }

          if (subCmd && arg === "personality" && method === "GET") {
            if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const traitName = segments[3] ? decodeURIComponent(segments[3]) : undefined;
            if (traitName === "history") {
              const trait = queryParams.get("trait") ?? "";
              return { status: 200, data: memoryDb.getPersonalityHistory(subCmd, trait) };
            }
            if (traitName === "drift") {
              return { status: 200, data: memoryDb.getPersonalityDrift(subCmd) };
            }
            return { status: 200, data: memoryDb.getPersonalitySnapshot(subCmd) };
          }

          if (subCmd && arg === "strategy-history" && method === "GET") {
            if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 20;
            return { status: 200, data: memoryDb.getStrategyHistory(subCmd, limit) };
          }

          if (subCmd && arg === "export" && method === "GET") {
            if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const agent = this.ctx.agentConfigs.find((a) => a.name === subCmd);
            if (!agent) return { status: 404, data: { error: `Agent not found: ${subCmd}` } };
            const template = queryParams.get("template") === "1";
            const bundle = exportAgentState(memoryDb, agent, { template });
            return { status: 200, data: bundle };
          }

          if (subCmd && arg === "import" && method === "POST") {
            if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const agent = this.ctx.agentConfigs.find((a) => a.name === subCmd);
            if (!agent) return { status: 404, data: { error: `Agent not found: ${subCmd}` } };
            try {
              const parsed = (typeof body === "string" ? JSON.parse(body) : body) as {
                bundle: AgentStateBundle;
                options?: Partial<ImportOptions>;
              };
              const result = importAgentState(memoryDb, parsed.bundle, parsed.options);
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
            if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const agent = this.ctx.agentConfigs.find((a) => a.name === subCmd);
            if (!agent) return { status: 404, data: { error: `Agent not found: ${subCmd}` } };
            const snapshotDir = join(homedir(), ".local", "share", "operad", "snapshots");
            const snapshotPath = saveSnapshot(memoryDb, agent, snapshotDir);
            const pruned = pruneSnapshots(snapshotDir, subCmd);
            return { status: 201, data: { path: snapshotPath, pruned } };
          }

          return { status: 400, data: { error: `Unknown agents endpoint: ${subCmd ?? "(root)"}` } };
        }

        case "agent-chat": {
          const agentName = name ? decodeURIComponent(name) : undefined;
          if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };

          if (agentName && method === "GET") {
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 50;
            return { status: 200, data: memoryDb.getConversationHistory(agentName, limit) };
          }
          if (agentName && method === "DELETE") {
            const cleared = memoryDb.clearConversation(agentName);
            return { status: 200, data: { ok: true, cleared } };
          }
          return { status: 400, data: { error: "Use WS agent_chat for sending messages" } };
        }

        case "agent-messages": {
          if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };

          if (!name && method === "GET") {
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 50;
            return { status: 200, data: memoryDb.getRecentAgentMessages(limit) };
          }

          if (name && segments[1] && method === "GET") {
            const agent1 = decodeURIComponent(name);
            const agent2 = decodeURIComponent(segments[1]);
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 50;
            return { status: 200, data: memoryDb.getConversation(agent1, agent2, limit) };
          }

          if (!name && method === "POST") {
            try {
              const parsed = JSON.parse(body) as { from: string; to: string; content: string; type?: string };
              if (!parsed.from || !parsed.to || !parsed.content) {
                return { status: 400, data: { error: "from, to, and content required" } };
              }
              const msgId = memoryDb.sendAgentMessage(parsed.from, parsed.to, parsed.content, {
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
            return { status: 200, data: memoryDb.getAgentConversationPairs() };
          }

          return { status: 400, data: { error: "Unknown agent-messages endpoint" } };
        }

        case "cognitive": {
          const subCmd = name;
          const arg = segments[2] ? decodeURIComponent(segments[2]) : undefined;

          if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };

          if (subCmd === "state" && method === "GET") {
            const state = this.ctx.state.getState();
            const ctx = buildOodaContext(state, memoryDb, this.ctx.config.orchestrator);
            return { status: 200, data: ctx };
          }

          if (subCmd === "trigger" && method === "POST") {
            if (sdkBridge?.isAttached) {
              return { status: 409, data: { error: "SDK session active" } };
            }
            this.agentEngine.runOodaCycle().catch((err) => {
              this.ctx.log.error(`Manual OODA trigger failed: ${err}`);
            });
            return { status: 202, data: { ok: true, message: "OODA cycle triggered" } };
          }

          if (subCmd === "goals") {
            if (method === "GET") {
              return { status: 200, data: memoryDb.getGoalTree() };
            }
            if (method === "POST") {
              try {
                const parsed = JSON.parse(body) as { title: string; description?: string; priority?: number; parentId?: number };
                if (!parsed.title) return { status: 400, data: { error: "title required" } };
                const id = memoryDb.createGoal(parsed.title, {
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
              const updated = memoryDb.updateGoal(Number(arg), parsed);
              return { status: updated ? 200 : 404, data: { ok: updated } };
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
          }

          if (subCmd === "decisions" && method === "GET") {
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 20;
            const agentFilter = queryParams.get("agent") ?? undefined;
            return { status: 200, data: memoryDb.getRecentDecisions(limit, agentFilter) };
          }

          if (subCmd === "strategy" && arg && method === "GET") {
            const strategy = memoryDb.getActiveStrategy(arg);
            if (!strategy) return { status: 404, data: { error: "No strategy found" } };
            return { status: 200, data: strategy };
          }

          if (subCmd === "messages" && method === "GET") {
            const agentFilter = queryParams.get("agent") ?? "master-controller";
            return { status: 200, data: memoryDb.getUnreadMessages(agentFilter) };
          }

          if (subCmd === "metrics" && method === "GET") {
            return { status: 200, data: memoryDb.getDecisionMetrics() };
          }

          return { status: 400, data: { error: `Unknown cognitive endpoint: ${subCmd ?? "(root)"}` } };
        }

        case "profile": {
          const subCmd = name;
          const arg = segments[2] ? decodeURIComponent(segments[2]) : undefined;

          if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };

          if (!subCmd && method === "GET") {
            const category = queryParams.get("category") ?? undefined;
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 100;
            return { status: 200, data: memoryDb.getProfile(category, limit) };
          }

          if (subCmd === "note" && method === "POST") {
            try {
              const parsed = JSON.parse(body) as { content: string; tags?: string[]; weight?: number };
              if (!parsed.content) return { status: 400, data: { error: "content required" } };
              const id = memoryDb.addProfileEntry("note", parsed.content, {
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
              const id = memoryDb.addProfileEntry("trait", parsed.content, {
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
                const id = memoryDb.addProfileEntry("chat_export", chunk, {
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
            const traits = memoryDb.getProfile("trait", 20);
            const notes = memoryDb.getProfile("note", 20);
            const styles = memoryDb.getProfile("style", 10);
            const chatCount = memoryDb.getProfile("chat_export").length;

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
                const updated = memoryDb.updateProfileEntry(profileId, parsed);
                return { status: updated ? 200 : 404, data: { ok: updated } };
              } catch {
                return { status: 400, data: { error: "Invalid JSON body" } };
              }
            }
            if (method === "DELETE") {
              const deleted = memoryDb.deleteProfileEntry(profileId);
              return { status: deleted ? 200 : 404, data: { ok: deleted } };
            }
          }

          return { status: 400, data: { error: `Unknown profile endpoint: ${subCmd ?? "(root)"}` } };
        }

        case "memories": {
          if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
          const projectPath = name ? decodeURIComponent(name) : undefined;

          if (method === "GET" && projectPath) {
            if (segments[2] === "search") {
              const q = queryParams.get("q") ?? "";
              const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 10;
              const results = memoryDb.searchMemories(projectPath, q, limit);
              return { status: 200, data: results };
            }
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 20;
            const memories = memoryDb.getTopMemories(projectPath, limit);
            return { status: 200, data: memories };
          }

          if (method === "POST" && projectPath) {
            try {
              const parsed = JSON.parse(body) as { category: string; content: string; sessionId?: string };
              if (!parsed.content) return { status: 400, data: { error: "content required" } };
              const id = memoryDb.createMemory(
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
            const deleted = memoryDb.deleteMemory(memId);
            return { status: deleted ? 200 : 404, data: { ok: deleted } };
          }

          if (method === "POST" && !projectPath) {
            if (segments[1] === "decay") {
              let decayed = 0;
              const projects = new Set<string>();
              for (const mem of memoryDb.getTopMemories("", 1000)) {
                projects.add(mem.project_path);
              }
              for (const p of projects) {
                decayed += memoryDb.decayMemories(p);
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
              if (arg === "history" && memoryDb) {
                const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 50;
                const executions = memoryDb.getToolExecutions(undefined, limit)
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

          if (method === "GET" && name === "stats" && memoryDb) {
            return { status: 200, data: memoryDb.getToolStats() };
          }

          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "trust": {
          if (!memoryDb) return { status: 503, data: { error: "Database not ready" } };
          if (method === "GET" && name) {
            const { score, recommended } = memoryDb.getRecommendedAutonomy(name);
            const history = memoryDb.getTrustHistory(name, 20);
            return { status: 200, data: { agent: name, score, recommended, history } };
          }
          if (method === "GET") {
            const agents = this.ctx.agentConfigs.map((a) => {
              const { score, recommended } = memoryDb!.getRecommendedAutonomy(a.name);
              return { agent: a.name, score, recommended, current: a.autonomy_level ?? "observe" };
            });
            return { status: 200, data: agents };
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "leases": {
          if (!memoryDb) return { status: 503, data: { error: "Database not ready" } };
          if (method === "GET" && name) {
            const leases = memoryDb.getActiveLeases(name);
            return { status: 200, data: leases };
          }
          if (method === "DELETE" && name) {
            const goalId = queryParams.has("goal_id") ? Number(queryParams.get("goal_id")) : undefined;
            const revoked = memoryDb.revokeLeases(name, goalId);
            return { status: 200, data: { revoked } };
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "consolidation": {
          if (!memoryDb) return { status: 503, data: { error: "Database not ready" } };

          if (method === "GET") {
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 10;
            const history = getConsolidationHistory(memoryDb, limit);
            const lastRun = getLastConsolidationTime(memoryDb);
            return { status: 200, data: { last_run_at: lastRun, history } };
          }

          if (method === "POST") {
            const agentNames = this.ctx.agentConfigs.filter((a) => a.enabled).map((a) => a.name);
            const result = runConsolidation(memoryDb, agentNames, this.ctx.log);
            return { status: 200, data: result };
          }

          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "specializations": {
          if (!memoryDb) return { status: 503, data: { error: "Database not ready" } };

          if (method === "GET") {
            try {
              const specs = memoryDb.getSpecializations(name || undefined);
              return { status: 200, data: specs };
            } catch (err) {
              this.ctx.log.warn("getSpecializations failed", { err: String(err) });
              return { status: 200, data: [] };
            }
          }

          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "roundtables": {
          if (!memoryDb) return { status: 503, data: { error: "Database not ready" } };

          if (method === "GET") {
            const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 20;
            try {
              const dbHandle = memoryDb.requireDb();
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
            if (!sdkBridge) return { status: 503, data: { error: "SDK bridge not initialized" } };
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
          if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
          if (method === "GET") {
            return { status: 200, data: computeQuotaStatus(memoryDb, this.ctx.config.orchestrator) };
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "tokens-daily": {
          if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
          if (method === "GET") {
            const days = queryParams.has("days") ? Number(queryParams.get("days")) : 14;
            return { status: 200, data: memoryDb.getDailyTokens(days) };
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "tokens-window": {
          if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
          if (method === "GET") {
            const hours = this.ctx.config.orchestrator.quota_window_hours;
            return { status: 200, data: memoryDb.getWindowTokens(hours) };
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "costs": {
          if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };

          if (method === "GET") {
            if (name === "daily") {
              const days = queryParams.has("days") ? Number(queryParams.get("days")) : 30;
              return { status: 200, data: memoryDb.getDailyCosts(days) };
            }
            if (name === "per-session") {
              const limit = queryParams.has("limit") ? Number(queryParams.get("limit")) : 20;
              return { status: 200, data: memoryDb.getPerSessionCosts(limit) };
            }
            if (name) {
              const costs = memoryDb.getSessionCosts(name);
              return { status: 200, data: costs };
            }
            const fromEpoch = queryParams.has("from") ? Number(queryParams.get("from")) : undefined;
            const toEpoch = queryParams.has("to") ? Number(queryParams.get("to")) : undefined;
            return { status: 200, data: memoryDb.getAggregateCosts(fromEpoch, toEpoch) };
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

}
