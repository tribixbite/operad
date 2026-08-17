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
import { join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { AgentEngine } from "./agent-engine.js";
import type { ToolEngine } from "./tool-engine.js";
import type {
  Switchboard, SessionConfig, ProjectTokenUsage, TokenRange, TokenRangeSummary,
} from "./types.js";
import { detectPlatform } from "./platform/platform.js";
import { Logger } from "./log.js";
import { buildOodaContext } from "./cognitive.js";
import {
  getProjectTokenUsage,
  summariseTokenRange,
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
  exportAgentState, importAgentState, saveSnapshot, pruneSnapshots, listSnapshots, loadSnapshot,
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
/** Largest page any `?limit=` may request. */
const MAX_QUERY_LIMIT = 1000;

/**
 * Read a `?limit=` query parameter, rejecting anything that isn't a sane
 * positive count.
 *
 * `Number(queryParams.get("limit"))` returned NaN for `?limit=notanumber`,
 * and the downstream `slice(-NaN)` degrades to `slice(0)` — the endpoint
 * returned its ENTIRE buffer rather than the requested page. `?limit=-5`
 * skipped the first five records instead of limiting. Both are silent.
 */
function parseLimit(queryParams: URLSearchParams, fallback: number): number {
  return parseCount(queryParams, "limit", fallback, MAX_QUERY_LIMIT);
}

/**
 * Read a positive integer query parameter, falling back on anything unusable.
 *
 * The same NaN hazard as `limit`: a `days=abc` reaches date arithmetic, and a
 * NaN cutoff compares as NULL in SQLite, so the endpoint quietly returns an
 * empty series instead of an error.
 */
function parseCount(
  queryParams: URLSearchParams,
  name: string,
  fallback: number,
  max: number,
): number {
  if (!queryParams.has(name)) return fallback;
  const raw = Number(queryParams.get(name));
  if (!Number.isFinite(raw)) return fallback;
  const n = Math.floor(raw);
  if (n < 1) return fallback;
  return Math.min(n, max);
}

/** Read an optional integer id/epoch parameter; undefined when unusable. */
function parseOptionalInt(queryParams: URLSearchParams, name: string): number | undefined {
  if (!queryParams.has(name)) return undefined;
  const raw = Number(queryParams.get(name));
  return Number.isFinite(raw) ? Math.floor(raw) : undefined;
}

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
   * Token usage for every non-stopped Claude project, from both the configured
   * sessions and the dynamic registry (registry entries whose path is already
   * covered by a config session are skipped).
   *
   * Shared by `/api/tokens` and `/api/token-usage` so the two cannot drift.
   * Per-file results are incrementally cached in claude-session.ts, so repeat
   * calls only read bytes appended since the previous scan.
   */
  private async collectActiveProjectUsage(): Promise<ProjectTokenUsage[]> {
    const results: ProjectTokenUsage[] = [];

    /** A session counts as live unless it has stopped or failed. */
    const isLive = (sessionName: string): boolean => {
      const state = this.ctx.state.getSession(sessionName);
      return Boolean(state) && state!.status !== "stopped" && state!.status !== "failed";
    };

    for (const cfg of this.ctx.config.sessions) {
      if (cfg.type !== "claude" || !cfg.path) continue;
      if (!isLive(cfg.name)) continue;
      try {
        results.push(await getProjectTokenUsage(cfg.name, cfg.path));
      } catch { /* best-effort: one unreadable project must not fail the request */ }
    }

    for (const entry of this.ctx.registry.entries()) {
      if (!entry.path) continue;
      if (!isLive(entry.name)) continue;
      if (results.some((r) => r.path === entry.path)) continue;
      try {
        results.push(await getProjectTokenUsage(entry.name, entry.path));
      } catch { /* best-effort */ }
    }

    return results;
  }

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
    contentType = "",
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
    // A raw `%` in a path segment makes decodeURIComponent throw a URIError.
    // This sits above the try below, so it used to fall out to the transport
    // and surface as a 500 — a malformed request from the client is a 400.
    let name: string | undefined;
    try {
      name = segments[1] ? decodeURIComponent(segments[1]) : undefined;
    } catch {
      return { status: 400, data: { error: "Malformed percent-encoding in path" } };
    }

    try {
      let resp;
      switch (command) {
        case "status":
          resp = this.ctx.cmdStatus(name);
          break;
        case "env":
          // Host facts the dashboard needs for display only. The home
          // directory is here because several panels shorten absolute paths
          // to `~/…`; they used to hardcode the Termux home, so on Linux,
          // WSL, macOS and Windows every path rendered in full.
          return {
            status: 200,
            data: {
              home: homedir(),
              platform: detectPlatform().id,
              path_sep: sep,
            },
          };
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
          const limit = parseLimit(queryParams, 100);
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
        case "autostart": {
          // POST /api/autostart/<name>  { enabled: boolean }
          // Toggle the session's ⭐ autostart pin (persisted).
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          let enabled = true;
          try {
            const parsed = (typeof body === "string" ? JSON.parse(body) : body) as { enabled?: boolean };
            enabled = parsed?.enabled !== false; // default to pin (true)
          } catch {
            return { status: 400, data: { error: "Invalid JSON body" } };
          }
          resp = await this.ctx.cmdSetAutostart(name, enabled);
          break;
        }
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
          // CFC bridge is the Termux/Android-only WebSocket relay that lets
          // Claude Code drive Chrome via CDP. On other platforms the user-
          // facing browser-control flow is the Claude for Chrome extension
          // (see doctor.ts:checkChromeForClaude). Off-Android, fail fast
          // with that pointer instead of fumbling through Termux-shaped
          // path searches and TermuxService intents.
          const onAndroid =
            !!process.env.TERMUX_VERSION || !!process.env.PREFIX?.includes("com.termux");
          if (!onAndroid) {
            return {
              status: 501,
              data: {
                error: "CFC bridge is Termux/Android-only",
                explanation:
                  "On desktop the equivalent is the Claude for Chrome extension. " +
                  "Operad's `/api/bridge/*` endpoints assume Termux paths and the TermuxService intent.",
                fix: "Install the Claude for Chrome extension from the Chrome Web Store: " +
                  "https://chromewebstore.google.com/detail/claude-for-chrome/mhlfhmbeohhnidmkdpjmaflpcnhfchck",
              },
            };
          }
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
            try { spawnSync("tmux", ["select-window", "-t", `=${name}:`], { timeout: 3000 }); } catch { /* best-effort */ }
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
          // Include which ADB device this came from. The list used to be a
          // bare array, so when the target was a different handset the UI had
          // no way to say so — it just showed someone else's processes.
          return {
            status: 200,
            data: {
              apps: this.ctx.getAndroidApps(),
              adb: this.ctx.adbTargetInfo(),
            },
          };
        case "kill":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Package name required" } };
          return this.ctx.forceStopApp(name);
        case "launch":
          // Launch an Android app by package name (or pkg/activity component).
          // Used by the per-session "Launch app" button — the dashboard
          // surfaces it when a session config declares `launch_package`.
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Package or component required" } };
          return this.ctx.launchApp(name);
        case "autostop": {
          if (!name) return { status: 200, data: this.ctx.getAutoStopList() };
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          // Validate at write time as well as at use time. The auto-stop list
          // is persisted and replayed into `adb shell` on every memory-pressure
          // event, so an unvalidated entry here is a stored command injection
          // against the device shell.
          const { AndroidEngine: AE } = await import("./android-engine.js");
          if (!AE.isValidPackageName(name)) {
            return { status: 400, data: { error: "Invalid package name" } };
          }
          return this.ctx.toggleAutoStop(name);
        }
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
        case "open": {
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Path or name required" } };
          // ?new=1 (or body.force_new=true) opts in to multi-instance creation;
          // by default cmdOpen reuses any existing session for the path.
          const forceNew = (() => {
            if (queryParams.get("new") === "1" || queryParams.get("new") === "true") return true;
            if (body) {
              try {
                const parsed = JSON.parse(body) as { force_new?: boolean; new?: boolean };
                return !!(parsed.force_new ?? parsed.new);
              } catch { /* ignore non-JSON body */ }
            }
            return false;
          })();
          resp = await this.ctx.cmdOpen(name, undefined, false, 50, forceNew);
          break;
        }
        case "close":
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          resp = await this.ctx.cmdClose(name);
          break;
        case "cleanup":
          // Force-cleanup orphan processes for a session — used when a
          // bare service crashed mid-flight (e.g. termux-x11 died but
          // BambuStudio kept consuming CPU). Goes wider than cmdStop:
          // pkill -9 -f for every keyword pattern the session's command
          // matches, so reparented orphans get reaped too.
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          if (!name) return { status: 400, data: { error: "Session name required" } };
          resp = await this.ctx.cmdForceCleanup(name);
          break;
        case "dedupe": {
          if (method !== "POST") return { status: 405, data: { error: "Method not allowed" } };
          // ?dry=1 reports what would be removed without mutating state.
          const dryRun =
            queryParams.get("dry") === "1" || queryParams.get("dry") === "true";
          resp = await this.ctx.cmdDedupe(dryRun);
          break;
        }
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
          // Special sub-routes before the generic per-project view.
          if (name === "all-projects") {
            resp = this.customizationRoutes.cmdAllProjectsCustomization();
          } else if (name === "export") {
            // GET /api/customization/export[?project=<path>]
            resp = this.customizationRoutes.cmdExportBundle(
              queryParams.get("project") ?? undefined,
            );
          } else if (name === "import") {
            // POST /api/customization/import — body is {bundle, options?}
            if (method !== "POST") {
              return { status: 405, data: { error: "Method not allowed" } };
            }
            // Import writes files Claude Code later executes as instructions
            // (and, with include_mcp, spawnable MCP commands). The dashboard
            // has no auth and sends `Access-Control-Allow-Origin: *`, so
            // accepting a CORS *simple* request would let any page the user
            // visits fire this blind. Requiring application/json forces a
            // preflight, which the wildcard ACAO does not satisfy for a
            // cross-origin caller.
            if (!/^application\/json\b/i.test(contentType)) {
              return {
                status: 415,
                data: {
                  error: "Content-Type: application/json is required for import",
                },
              };
            }
            try {
              const parsed = JSON.parse(body) as {
                bundle?: unknown;
                options?: Record<string, unknown>;
              };
              resp = this.customizationRoutes.cmdImportBundle(
                parsed.bundle ?? parsed,
                parsed.options ?? {},
              );
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
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
            return { status: 200, data: await this.collectActiveProjectUsage() };
          } catch (err) {
            return { status: 500, data: { error: `Failed to compute tokens: ${err}` } };
          }
        }
        case "token-usage": {
          // Range-scoped token summary backing the dashboard's Tokens panel.
          // Derived from the Claude Code JSONL logs rather than the `costs`
          // SQLite table, because that table is only written by the agent/SDK
          // path and is empty for anyone not using those features — which is
          // why /api/tokens-daily and /api/quota report zeroes.
          const rangeParam = (queryParams.get("range") ?? "all").toLowerCase();
          const range: TokenRange =
            rangeParam === "day" || rangeParam === "week" ? rangeParam : "all";
          try {
            const started = Date.now();
            const projects = await this.collectActiveProjectUsage();
            const summary = summariseTokenRange(projects, range);
            return {
              status: 200,
              data: {
                ...summary,
                generated_at: new Date().toISOString(),
                scan_ms: Date.now() - started,
              } satisfies TokenRangeSummary,
            };
          } catch (err) {
            return { status: 500, data: { error: `Failed to compute token usage: ${err}` } };
          }
        }
        case "conversation": {
          // Two resolution modes:
          //  - by operad session name (live sessions): resolveSessionPath.
          //  - by explicit `?path=` (history view, e.g. the Prompt Library
          //    opening a conversation for a project that has no running
          //    session). The path maps to its mangled ~/.claude/projects dir
          //    inside getConversationPage — local, read-only history.
          const pathParam = queryParams.get("path");
          const convPath = pathParam
            ? pathParam
            : name
              ? this.ctx.resolveSessionPath(name)
              : null;
          if (!convPath) {
            return {
              status: 400,
              data: { error: pathParam ? "Invalid path" : `Session '${name}' has no path` },
            };
          }
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
              const limit = parseLimit(queryParams, 50);
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
            const limit = parseLimit(queryParams, 50);
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
            const limit = parseLimit(queryParams, 20);
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
            const limit = parseLimit(queryParams, 20);
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
              // Pin the import to the agent named in the URL — the one the
              // 404 check above validated. Otherwise the bundle's own
              // meta.agent_name decided, and that check meant nothing.
              const result = importAgentState(memoryDb, parsed.bundle, {
                ...parsed.options,
                targetAgent: subCmd,
              });
              return { status: 200, data: result };
            } catch (err) {
              return { status: 400, data: { error: String(err) } };
            }
          }

          if (subCmd && arg === "restore" && method === "POST") {
            // POST /api/agents/<name>/restore  { file?: "<basename>" }
            // Loads a snapshot from disk and imports it. Snapshots were
            // write-only before this: listable, creatable, never restorable.
            if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
            const agent = this.ctx.agentConfigs.find((a) => a.name === subCmd);
            if (!agent) return { status: 404, data: { error: `Agent not found: ${subCmd}` } };
            const snapshotDir = join(homedir(), ".local", "share", "operad", "snapshots");
            let parsed: { file?: string; options?: Partial<ImportOptions> } = {};
            if (body) {
              try {
                parsed = (typeof body === "string" ? JSON.parse(body) : body) as typeof parsed;
              } catch {
                return { status: 400, data: { error: "Invalid JSON body" } };
              }
            }
            const available = listSnapshots(snapshotDir, subCmd);
            if (available.length === 0) {
              return { status: 404, data: { error: `No snapshots for agent '${subCmd}'` } };
            }
            // Default to the newest. listSnapshots returns names only, so a
            // caller-supplied file must be one of them — that rejects any
            // traversal without needing to reason about the string.
            const chosen = parsed.file ?? available[0];
            if (!available.includes(chosen)) {
              return { status: 400, data: { error: `Unknown snapshot '${chosen}' for agent '${subCmd}'` } };
            }
            try {
              const bundle = loadSnapshot(join(snapshotDir, subCmd, chosen));
              const result = importAgentState(memoryDb, bundle, {
                ...parsed.options,
                targetAgent: subCmd,
              });
              return { status: 200, data: { restored_from: chosen, ...result } };
            } catch (err) {
              return { status: 400, data: { error: `Restore failed: ${String(err)}` } };
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
            const limit = parseLimit(queryParams, 50);
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
            const limit = parseLimit(queryParams, 50);
            return { status: 200, data: memoryDb.getRecentAgentMessages(limit) };
          }

          // /api/agent-messages/pairs — distinct-conversation summary. MUST be
          // checked before the two-agent conversation branch below: "pairs" is
          // a single path segment, so the old `name && segments[1]` guard
          // misread it as agent1 and this endpoint was unreachable.
          if (name === "pairs" && method === "GET") {
            return { status: 200, data: memoryDb.getAgentConversationPairs() };
          }

          // /api/agent-messages/<agent1>/<agent2> — conversation between two
          // agents. agent2 is segments[2]; the previous code read segments[1]
          // (== agent1/`name`), so every conversation query compared an agent
          // to itself. Requiring segments[2] also stops `pairs` being shadowed.
          if (name && segments[2] && method === "GET") {
            const agent1 = decodeURIComponent(name);
            const agent2 = decodeURIComponent(segments[2]);
            const limit = parseLimit(queryParams, 50);
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
            if (sdkBridge?.isBusy) {
              // isAttached alone missed a standalone agent run in progress,
              // so the dashboard reported "triggered" for a cycle that then
              // refused itself and logged a failure the user never saw.
              return { status: 409, data: { error: "SDK bridge busy — an agent run is in progress" } };
            }
            this.agentEngine.runOodaCycle()
              .then((started) => {
                if (!started) this.ctx.log.info("Manual OODA trigger did not start — a cycle was already running");
              })
              .catch((err) => {
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
            const limit = parseLimit(queryParams, 20);
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
            const limit = parseLimit(queryParams, 100);
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
              const limit = parseLimit(queryParams, 10);
              const results = memoryDb.searchMemories(projectPath, q, limit);
              return { status: 200, data: results };
            }
            const limit = parseLimit(queryParams, 20);
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
              // Was enumerated via getTopMemories(""), whose query is
              // `WHERE project_path = ?` — an empty string matched nothing, so
              // the loop never ran and this always returned {decayed: 0}.
              let decayed = 0;
              const projects = memoryDb.getMemoryProjectPaths();
              for (const p of projects) {
                decayed += memoryDb.decayMemories(p);
              }
              return { status: 200, data: { decayed, projects: projects.length } };
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
                const limit = parseLimit(queryParams, 50);
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
          if (method === "POST" && name) {
            // Leases could be listed and revoked but never granted, so the
            // table stayed permanently empty and the mechanism was inert.
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(body) as Record<string, unknown>;
            } catch {
              return { status: 400, data: { error: "Invalid JSON body" } };
            }
            const toolName = typeof parsed.tool === "string" ? parsed.tool.trim() : "";
            if (!toolName) return { status: 400, data: { error: "'tool' is required" } };
            if (!this.ctx.agentConfigs.some((a) => a.name === name)) {
              return { status: 404, data: { error: `Unknown agent: ${name}` } };
            }

            // A lease with neither a cap nor an expiry is a permanent
            // elevation, which is what autonomy_level is for. Require at
            // least one bound so a grant cannot silently become forever.
            const maxExecutions = typeof parsed.max_executions === "number" && parsed.max_executions > 0
              ? Math.floor(parsed.max_executions)
              : undefined;
            const ttlSeconds = typeof parsed.ttl_seconds === "number" && parsed.ttl_seconds > 0
              ? Math.floor(parsed.ttl_seconds)
              : undefined;
            if (maxExecutions === undefined && ttlSeconds === undefined) {
              return {
                status: 400,
                data: { error: "A lease needs 'max_executions' or 'ttl_seconds' — an unbounded grant is what autonomy_level is for" },
              };
            }

            const id = memoryDb.createToolLease(name, toolName, {
              goalId: typeof parsed.goal_id === "number" ? Math.floor(parsed.goal_id) : undefined,
              maxExecutions,
              expiresAt: ttlSeconds !== undefined
                ? Math.floor(Date.now() / 1000) + ttlSeconds
                : undefined,
            });
            this.ctx.log.info(
              `Granted tool lease #${id}: ${name} → ${toolName}`
              + `${maxExecutions !== undefined ? ` (max ${maxExecutions})` : ""}`
              + `${ttlSeconds !== undefined ? ` (ttl ${ttlSeconds}s)` : ""}`,
            );
            return { status: 200, data: { id, agent: name, tool: toolName } };
          }
          if (method === "DELETE" && name) {
            const goalId = parseOptionalInt(queryParams, "goal_id");
            const revoked = memoryDb.revokeLeases(name, goalId);
            return { status: 200, data: { revoked } };
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "consolidation": {
          if (!memoryDb) return { status: 503, data: { error: "Database not ready" } };

          if (method === "GET") {
            const limit = parseLimit(queryParams, 10);
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
            const limit = parseLimit(queryParams, 20);
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
              // `b.agents as string[]` accepted anything: a bare string made
              // the engine iterate its characters, and numbers silently
              // matched no agent. Validate the shape here so a malformed
              // request is a 400 rather than a no-op that still looks like it
              // ran.
              const agents = Array.isArray(b.agents)
                ? b.agents.filter((a): a is string => typeof a === "string")
                : [];
              const roundtableCtx = b.context ? String(b.context) : undefined;

              if (!topic) return { status: 400, data: { error: "topic required" } };
              if (!agents.length) {
                return { status: 400, data: { error: "agents must be a non-empty array of agent names" } };
              }

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

        case "workflows": {
          // GET /api/workflows                — list all workflows
          // GET /api/workflows/<name>         — get one
          // GET /api/workflows/<name>/runs    — recent runs
          // POST /api/workflows/<name>/run    — execute a workflow now
          // POST /api/workflows               — upsert from JSON body { name, spec }
          // DELETE /api/workflows/<name>      — drop workflow + run history
          // PATCH /api/workflows/<name>       — { enabled: bool }
          const wfEng = this.ctx.getWorkflowEngine();
          if (!wfEng) return { status: 503, data: { error: "Workflow engine not initialized" } };

          // The path after "workflows" can be "/<name>" or "/<name>/run" or
          // "/<name>/runs" — `name` already holds the first segment; sniff
          // for a sub-action via the original URL path (queryParams alone
          // can't tell us /run vs /runs).
          const subAction = segments[2] ?? "";

          if (method === "GET" && !name) {
            return { status: 200, data: wfEng.getAll() };
          }
          if (method === "GET" && name && !subAction) {
            const w = wfEng.get(name);
            return w ? { status: 200, data: w } : { status: 404, data: { error: "Not found" } };
          }
          if (method === "GET" && name && subAction === "runs") {
            return { status: 200, data: wfEng.recentRuns(name) };
          }
          if (method === "POST" && name && subAction === "run") {
            try {
              const result = await wfEng.run(name, { triggered_by: "api" });
              return { status: 200, data: result };
            } catch (err) {
              return { status: 500, data: { error: String(err) } };
            }
          }
          if (method === "POST" && !name && body) {
            const b = (typeof body === "string" ? JSON.parse(body) : body) as Record<string, unknown>;
            if (!b.name || !b.spec) {
              return { status: 400, data: { error: "Missing required fields: name, spec" } };
            }
            try {
              const id = wfEng.upsert(String(b.name), b.spec as import("./workflow.js").WorkflowSpec, "api");
              return { status: 201, data: { id } };
            } catch (err) {
              return { status: 400, data: { error: String(err) } };
            }
          }
          if (method === "DELETE" && name) {
            return { status: 200, data: { deleted: wfEng.delete(name) } };
          }
          if (method === "PATCH" && name && body) {
            const b = (typeof body === "string" ? JSON.parse(body) : body) as Record<string, unknown>;
            wfEng.setEnabled(name, Boolean(b.enabled));
            return { status: 200, data: { name, enabled: Boolean(b.enabled) } };
          }

          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "skills": {
          // Skill marketplace REST surface — mirrors the IPC commands.
          // GET    /api/skills                  → list installed
          // GET    /api/skills/<id>             → full manifest
          // POST   /api/skills/install          → { provider, locator,
          //                                          version?, force_take_ownership?,
          //                                          accept_cap_downgrade? }
          // POST   /api/skills/<id>/uninstall   → { force_revoke? }
          // GET    /api/skills/events           → recent events timeline
          // GET    /api/skills/search?q=&provider= → discover installable skills
          const mgr = this.ctx.getSkillManager();
          if (!mgr) {
            return {
              status: 503,
              data: { error: "Skill marketplace not enabled. Set [skills] enabled = true in operad.toml (or pass --enable-skills-preview) and restart the daemon." },
            };
          }
          const subAction = segments[2] ?? "";

          if (method === "GET" && !name) {
            const provider = queryParams.get("provider") ?? undefined;
            return { status: 200, data: mgr.list(provider as any) };
          }
          if (method === "GET" && name === "search") {
            // GET /api/skills/search?q=&provider=&limit=&cursor=
            // Discovery across providers. ProviderModule.list() had been
            // implemented since Phase B but was exposed by nothing, so the
            // marketplace could only install a locator you already knew.
            try {
              const r = await mgr.search({
                query: queryParams.get("q") ?? undefined,
                provider: (queryParams.get("provider") ?? undefined) as any,
                limit: queryParams.has("limit")
                  ? parseInt(queryParams.get("limit") as string, 10)
                  : undefined,
                cursor: queryParams.get("cursor") ?? undefined,
              });
              return { status: 200, data: r };
            } catch (err) {
              return { status: 500, data: { error: `search failed: ${(err as Error).message}` } };
            }
          }
          if (method === "GET" && name === "events") {
            if (!memoryDb) return { status: 503, data: { error: "memoryDb not initialised" } };
            const limit = parseInt(queryParams.get("limit") ?? "50", 10);
            const rows = memoryDb.requireDb().prepare(
              `SELECT id, skill_id, event_type, detail, occurred_at
                 FROM skill_events ORDER BY occurred_at DESC LIMIT ?`,
            ).all(limit);
            return { status: 200, data: rows };
          }
          if (method === "GET" && name && !subAction) {
            const s = mgr.get(name);
            return s
              ? { status: 200, data: s }
              : { status: 404, data: { error: "skill not found" } };
          }
          if (method === "POST" && name === "install" && body) {
            const b = (typeof body === "string" ? JSON.parse(body) : body) as Record<string, unknown>;
            if (!b.provider || !b.locator) {
              return { status: 400, data: { error: "Missing required fields: provider, locator" } };
            }
            try {
              const r = await mgr.install(
                String(b.provider) as any,
                String(b.locator),
                b.version ? String(b.version) : "latest",
                {
                  force_take_ownership: Boolean(b.force_take_ownership),
                  accept_cap_downgrade: Boolean(b.accept_cap_downgrade),
                },
              );
              return { status: 201, data: r };
            } catch (err) {
              const e = err as Error & { code?: string; detail?: Record<string, unknown> };
              // 409 for gating refusals that the caller can resolve by
              // changing flags (force_revoke, force_take_ownership,
              // accept_cap_downgrade) — distinct from 400 (malformed
              // request).
              const gating = new Set([
                "INSTALL_BLOCKED_BY_ACTIVE_CONSUMER",
                "TOOL_HAS_ACTIVE_CONSUMERS",
                "TOOL_NAME_CONFLICT",
                "WORKFLOW_NAME_CONFLICT",
                "AGENT_NAME_CONFLICT",
                "MCP_NAME_USER_OWNED",
                "MCP_OWNED_BY_OTHER_DAEMON",
                "PROVIDER_TIER_DOWNGRADE",
                "AUTONOMY_CAP_VIOLATION",
              ]);
              return {
                status: gating.has(e.code ?? "") ? 409 : 400,
                data: { error: e.message, code: e.code, detail: e.detail },
              };
            }
          }
          if (method === "POST" && name && subAction === "uninstall") {
            const b = body
              ? ((typeof body === "string" ? JSON.parse(body) : body) as Record<string, unknown>)
              : {};
            try {
              mgr.uninstall(name, { force_revoke: Boolean(b.force_revoke) });
              return { status: 200, data: { id: name, ok: true } };
            } catch (err) {
              const e = err as Error & { code?: string; detail?: Record<string, unknown> };
              return {
                status: e.code === "TOOL_HAS_ACTIVE_CONSUMERS" ? 409 : 400,
                data: { error: e.message, code: e.code, detail: e.detail },
              };
            }
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "tool-autonomy": {
          // GET  /api/tool-autonomy           → all caps + buckets
          // POST /api/tool-autonomy           → { tool_id, bucket }
          if (!memoryDb) return { status: 503, data: { error: "memoryDb not initialised" } };
          if (method === "GET") {
            return { status: 200, data: memoryDb.listToolAutonomyCaps() };
          }
          if (method === "POST" && body) {
            const b = (typeof body === "string" ? JSON.parse(body) : body) as Record<string, unknown>;
            if (!b.tool_id || !b.bucket) {
              return { status: 400, data: { error: "Missing required fields: tool_id, bucket" } };
            }
            try {
              const r = memoryDb.promoteToolBucket(String(b.tool_id), String(b.bucket));
              return { status: 200, data: { tool_id: b.tool_id, ...r } };
            } catch (err) {
              const e = err as Error & { code?: string };
              return {
                status: e.code === "AUTONOMY_CAP_VIOLATION" ? 409 : 400,
                data: { error: e.message, code: e.code },
              };
            }
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "config-overrides": {
          // Surface the user-mutable JSON overlay (sdk + quota knobs)
          // that the dashboard's Settings form uses. The TOML stays the
          // structural source of truth — this endpoint never touches it.
          // GET   → current overlay (empty if none).
          // PATCH → shallow-merge body into the overlay; restart hint in
          //         the response since SDK config is read at boot.
          const { loadOverrides, patchOverrides } = await import("./config-overrides.js");
          const stateFile = this.ctx.config.orchestrator.state_file;
          if (method === "GET") {
            return { status: 200, data: loadOverrides(stateFile) };
          }
          if (method === "PATCH") {
            try {
              const parsed = (typeof body === "string" ? JSON.parse(body) : body) as Record<string, unknown>;
              const merged = patchOverrides(stateFile, parsed);
              return {
                status: 200,
                data: {
                  ok: true,
                  overrides: merged,
                  // SDK defaults are read into the bridge at daemon start.
                  // Persisting now is fine; new values apply on the next
                  // daemon restart (`tmx upgrade` or watchdog cycle).
                  applies_on: "daemon_restart",
                },
              };
            } catch (err) {
              return { status: 400, data: { error: `Invalid JSON body: ${(err as Error).message}` } };
            }
          }
          return { status: 405, data: { error: "Method not allowed" } };
        }

        case "tokens-daily": {
          if (!memoryDb) return { status: 503, data: { error: "Memory database not initialized" } };
          if (method === "GET") {
            const days = parseCount(queryParams, "days", 14, 3650);
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
              const days = parseCount(queryParams, "days", 30, 3650);
              return { status: 200, data: memoryDb.getDailyCosts(days) };
            }
            if (name === "per-session") {
              const limit = parseLimit(queryParams, 20);
              return { status: 200, data: memoryDb.getPerSessionCosts(limit) };
            }
            if (name) {
              const costs = memoryDb.getSessionCosts(name);
              return { status: 200, data: costs };
            }
            const fromEpoch = parseOptionalInt(queryParams, "from");
            const toEpoch = parseOptionalInt(queryParams, "to");
            return { status: 200, data: memoryDb.getAggregateCosts(fromEpoch, toEpoch) };
          }

          return { status: 405, data: { error: "Method not allowed" } };
        }

        default:
          return { status: 404, data: { error: `Unknown endpoint: ${command}` } };
      }

      return { status: resp.ok ? 200 : 400, data: resp.ok ? resp.data : { error: resp.error } };
    } catch (err) {
      // The full error goes to the log, not the response body. String(err)
      // on an unexpected throw carries absolute paths, SQL text and stack
      // messages; the route is token-gated, but there is no reason to hand
      // that to a client when the log already has it.
      this.ctx.log.error(`Unhandled error in ${method} ${path}: ${err instanceof Error ? err.stack : String(err)}`);
      return { status: 500, data: { error: "Internal error — see daemon log" } };
    }
  }

}
