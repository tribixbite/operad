/**
 * session-commands.ts — IPC/REST command handlers for session management
 *
 * Extracted from daemon.ts to reduce file size and improve separation of concerns.
 * Each cmd* method corresponds to one IPC command case (or REST endpoint) that
 * directly manipulates session lifecycle, registry, or returns session state.
 *
 * Dependencies are injected via OrchestratorContext (shared) and MonitoringEngine
 * (for SSE push + status notification after suspend/resume mutations).
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import type { IpcResponse } from "./types.js";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { MonitoringEngine } from "./monitoring-engine.js";
import {
  suspendSession,
  resumeSession,
  sendGoToSession,
  sendKeys,
  sessionExists,
  createTermuxTab,
} from "./session.js";
import {
  parseRecentProjects,
  deriveName,
  isValidName,
  nextSuffix,
} from "./registry.js";
import type { RecentProject } from "./registry.js";
import { runHealthSweep } from "./health.js";
import { computeQuotaStatus } from "./memory-db.js";
import { computeShutdownOrder } from "./deps.js";
import { resolveOpenTarget as resolveOpenTargetFn } from "./session-resolver.js";
import type { SessionConfig } from "./types.js";

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

/** Promise-based sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * All IPC/REST session command handlers, extracted from Daemon.
 *
 * Receives the shared OrchestratorContext (for config, state, registry, log, etc.)
 * and MonitoringEngine (for SSE state push + status notification after mutations).
 */
export class SessionCommands {
  constructor(
    private readonly ctx: OrchestratorContext,
    private readonly monitoringEngine: MonitoringEngine,
  ) {}

  // -- Status / info -----------------------------------------------------------

  /** Status command — return session states and daemon info */
  cmdStatus(name?: string): IpcResponse {
    const state = this.ctx.state.getState();

    if (name) {
      const resolved = this.ctx.resolveName(name);
      if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
      const s = state.sessions[resolved];
      if (!s) return { ok: false, error: `No state for session: ${resolved}` };
      return {
        ok: true,
        data: {
          session: s,
          config: this.ctx.config.sessions.find((c) => c.name === resolved),
        },
      };
    }

    const { budget, wake, memoryDb, agentConfigs } = this.ctx;
    return {
      ok: true,
      data: {
        daemon_start: state.daemon_start,
        boot_complete: state.boot_complete,
        adb_fixed: state.adb_fixed,
        procs: budget.check(),
        wake_lock: wake.isHeld(),
        memory: state.memory ?? null,
        battery: state.battery ?? null,
        quota: memoryDb
          ? computeQuotaStatus(memoryDb, this.ctx.config.orchestrator)
          : null,
        trust: memoryDb
          ? agentConfigs.map((a) => {
              const { score, recommended } = memoryDb.getRecommendedAutonomy(a.name);
              return {
                agent: a.name,
                score,
                recommended,
                current: a.autonomy_level ?? "observe",
              };
            })
          : [],
        specializations: memoryDb
          ? (() => {
              try {
                const allSpecs = memoryDb.getSpecializations();
                // Lightweight summary: top domain per agent
                const byAgent = new Map<string, { domain: string; confidence: number }>();
                for (const s of allSpecs) {
                  const existing = byAgent.get(s.agent_name);
                  if (!existing || s.confidence > existing.confidence) {
                    byAgent.set(s.agent_name, { domain: s.domain, confidence: s.confidence });
                  }
                }
                return Array.from(byAgent.entries()).map(([agent, top]) => ({
                  agent,
                  top_domain: top.domain,
                  confidence: top.confidence,
                }));
              } catch {
                /* specializations table may not exist during first run */
                return [];
              }
            })()
          : [],
        sessions: Object.values(state.sessions).map((s) => {
          const cfg = this.ctx.config.sessions.find((c) => c.name === s.name);
          return {
            ...s,
            type: cfg?.type ?? "daemon",
            path: cfg?.path ?? null,
            has_build_script: cfg?.path
              ? existsSync(join(cfg.path, "build-on-termux.sh"))
              : false,
            uptime: s.uptime_start ? formatUptime(new Date(s.uptime_start)) : null,
          };
        }),
      },
    };
  }

  // -- Lifecycle ---------------------------------------------------------------

  /** Start command — start one or all sessions (re-enables boot-disabled sessions on demand) */
  async cmdStart(name?: string): Promise<IpcResponse> {
    if (name) {
      const resolved = this.ctx.resolveName(name);
      if (!resolved) {
        // Not a loaded session — try fuzzy-matching to open it
        return this.cmdOpen(name);
      }
      // Re-enable if disabled by boot recency filtering (on-demand play)
      const sessionConfig = this.ctx.config.sessions.find((s) => s.name === resolved);
      if (sessionConfig && !sessionConfig.enabled) {
        sessionConfig.enabled = true;
        this.ctx.log.info(`Re-enabled session '${resolved}' for on-demand start`, {
          session: resolved,
        });
      }
      const success = await this.ctx.startSession(resolved);
      return {
        ok: success,
        data: success ? `Started '${resolved}'` : `Failed to start '${resolved}'`,
      };
    }
    await this.ctx.startAllSessions();
    return { ok: true, data: "All sessions started" };
  }

  /** Stop command — stop one or all sessions */
  async cmdStop(name?: string): Promise<IpcResponse> {
    if (name) {
      const resolved = this.ctx.resolveName(name);
      if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
      const success = await this.ctx.stopSessionByName(resolved);
      return {
        ok: success,
        data: success ? `Stopped '${resolved}'` : `Failed to stop '${resolved}'`,
      };
    }
    // Stop all in reverse dependency order
    const shutdownOrder = computeShutdownOrder(this.ctx.config.sessions);
    for (const batch of shutdownOrder) {
      await Promise.all(batch.sessions.map((n) => this.ctx.stopSessionByName(n)));
    }
    return { ok: true, data: "All sessions stopped" };
  }

  /** Restart command */
  async cmdRestart(name?: string): Promise<IpcResponse> {
    if (name) {
      const resolved = this.ctx.resolveName(name);
      if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
      await this.ctx.stopSessionByName(resolved);
      await sleep(500);
      const success = await this.ctx.startSession(resolved);
      return {
        ok: success,
        data: success ? `Restarted '${resolved}'` : `Failed to restart '${resolved}'`,
      };
    }
    await this.cmdStop();
    await sleep(500);
    return this.cmdStart();
  }

  /** Health command — run health sweep now */
  cmdHealth(): IpcResponse {
    const results = runHealthSweep(
      this.ctx.config,
      this.ctx.state,
      this.ctx.log,
      this.ctx.adoptedPids,
    );
    return { ok: true, data: results };
  }

  /** Memory command — return system memory + per-session RSS + pressure */
  cmdMemory(): IpcResponse {
    const sysMem = this.ctx.systemMemory.getSystemMemory();
    const sessions: Array<{ name: string; rss_mb: number | null; activity: string | null }> = [];

    for (const session of this.ctx.config.sessions) {
      const s = this.ctx.state.getSession(session.name);
      sessions.push({
        name: session.name,
        rss_mb: s?.rss_mb ?? null,
        activity: s?.activity ?? null,
      });
    }

    return { ok: true, data: { system: sysMem, sessions } };
  }

  // -- Session interaction -----------------------------------------------------

  /** Go command — send "go" to a Claude session */
  async cmdGo(name: string): Promise<IpcResponse> {
    const resolved = this.ctx.resolveName(name);
    if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
    const result = await sendGoToSession(resolved, this.ctx.log);
    const ok = result === "ready";
    return {
      ok,
      data: ok
        ? `Sent 'go' to '${resolved}'`
        : `Failed to send 'go' to '${resolved}' (${result})`,
    };
  }

  /** Send command — send arbitrary text to a session */
  cmdSend(name: string, text: string): IpcResponse {
    const resolved = this.ctx.resolveName(name);
    if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
    const sent = sendKeys(resolved, text, true);
    return {
      ok: sent,
      data: sent ? `Sent to '${resolved}'` : `Failed to send to '${resolved}'`,
    };
  }

  /** Tabs command — create Termux UI tabs for sessions */
  cmdTabs(names?: string[]): IpcResponse {
    const targetSessions = names?.length
      ? names.map((n) => this.ctx.resolveName(n)).filter((n): n is string => n !== null)
      : this.ctx.config.sessions
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

      if (createTermuxTab(name, this.ctx.log)) {
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

  // -- Dynamic session management (open/close/register/clone/create) -----------

  /**
   * Open command — register and start a new dynamic Claude session (supports multi-instance).
   * Fuzzy-matches path input against config sessions and recent history if the
   * literal path doesn't exist on disk.
   */
  async cmdOpen(
    path: string,
    name?: string,
    autoGo = false,
    priority = 50,
  ): Promise<IpcResponse> {
    let resolvedPath: string;

    if (existsSync(path)) {
      resolvedPath = resolve(path);
    } else {
      // Not a valid path — fuzzy match against session names and recent projects
      const matched = resolveOpenTargetFn(
        this.ctx.config,
        this.ctx.registry,
        path,
      );
      if (!matched) {
        return {
          ok: false,
          error: `No project matching '${path}' found in config or recent history`,
        };
      }
      resolvedPath = matched;
    }

    const baseName = name ?? deriveName(path);
    if (!isValidName(baseName)) {
      return {
        ok: false,
        error: `Invalid session name '${baseName}' — must match [a-z0-9-]+`,
      };
    }

    // Check if any session already exists for this path — create a suffixed instance if so
    const existingByPath = this.ctx.config.sessions.filter(
      (s) => s.path && resolve(s.path) === resolvedPath,
    );

    let sessionName: string;
    if (existingByPath.length === 0) {
      // First instance — check for name conflict only
      const nameConflict = this.ctx.config.sessions.find((s) => s.name === baseName);
      if (nameConflict) {
        return {
          ok: false,
          error: `Name '${baseName}' conflicts with an existing session at a different path`,
        };
      }
      sessionName = baseName;
    } else {
      // Multi-instance — find next available suffix
      const pattern = new RegExp(
        `^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-\\d+)?$`,
      );
      const existingNames = this.ctx.config.sessions
        .filter((s) => pattern.test(s.name))
        .map((s) => s.name);
      sessionName = nextSuffix(baseName, existingNames);
    }

    // Add to registry
    const entry = this.ctx.registry.add({
      name: sessionName,
      path: resolvedPath,
      priority,
      auto_go: autoGo,
    });
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
    this.ctx.config.sessions.push(sessionConfig);
    this.ctx.state.initFromConfig(this.ctx.config.sessions);

    // Start the session
    const started = await this.ctx.startSession(sessionName);
    this.ctx.log.info(`Opened session '${sessionName}' at ${entry.path}`, {
      session: sessionName,
    });

    return {
      ok: true,
      data: `Opened '${sessionName}' (${entry.path})${started ? " — started" : " — registered but not started"}`,
    };
  }

  /** Close command — stop and unregister a dynamic session */
  async cmdClose(name: string): Promise<IpcResponse> {
    const resolved = this.ctx.resolveName(name);
    if (!resolved) return { ok: false, error: `Unknown session: ${name}` };

    // Stop the session if it's running
    await this.ctx.stopSessionByName(resolved);

    // Remove from registry if dynamically opened
    const regEntry = this.ctx.registry.find(resolved);
    if (regEntry) {
      this.ctx.registry.remove(resolved);
    }

    // Remove from live session list (config sessions reappear on next boot)
    this.ctx.config.sessions = this.ctx.config.sessions.filter(
      (s) => s.name !== resolved,
    );

    // Remove session state so it vanishes from dashboard immediately
    this.ctx.state.removeSession(resolved);

    this.ctx.log.info(`Closed session '${resolved}'`, { session: resolved });
    return { ok: true, data: `Closed '${resolved}'` };
  }

  /** Recent command — parse history.jsonl for recently active projects */
  cmdRecent(count = 20): IpcResponse {
    const home = homedir();
    const historyPath = join(home, ".claude", "history.jsonl");
    const rawProjects = parseRecentProjects(historyPath, 1000);

    // Enrich with running/registered/config status
    const configNames = new Set(this.ctx.config.sessions.map((s) => s.name));
    const runningNames = new Set<string>();
    for (const s of Object.values(this.ctx.state.getState().sessions)) {
      if (s.status === "running" || s.status === "degraded" || s.status === "starting") {
        runningNames.add(s.name);
      }
    }

    const results: RecentProject[] = rawProjects.slice(0, count).map((p) => {
      // Try to match by derived name or by path
      const matchedConfig = this.ctx.config.sessions.find((s) => s.path === p.path);
      const matchedName = matchedConfig?.name ?? p.name;

      let status: RecentProject["status"] = "untracked";
      if (runningNames.has(matchedName)) {
        status = "running";
      } else if (
        this.ctx.registry.find(matchedName) ||
        this.ctx.registry.findByPath(p.path)
      ) {
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
    for (const entry of this.ctx.registry.entries()) {
      if (existingPaths.has(entry.path)) continue;
      const status: RecentProject["status"] = runningNames.has(entry.name)
        ? "running"
        : "registered";
      results.push({
        name: entry.name,
        path: entry.path,
        last_active: entry.last_active,
        session_id: entry.session_id ?? "",
        status,
      });
    }

    // Re-sort combined list by last_active descending
    results.sort(
      (a, b) => new Date(b.last_active).getTime() - new Date(a.last_active).getTime(),
    );

    return { ok: true, data: results.slice(0, count) };
  }

  /** Register projects by scanning a directory (default ~/git) */
  cmdRegister(scanPath?: string): IpcResponse {
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
          } catch {
            /* stat failed — skip entry */
            return null;
          }
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);
      entries.sort((a, b) => b.mtime - a.mtime);
    } catch (err) {
      return { ok: false, error: `Failed to scan ${dirPath}: ${err}` };
    }

    // Collect existing names for suffix dedup
    const existingNames = [
      ...this.ctx.config.sessions.map((s) => s.name),
      ...this.ctx.registry.entries().map((e) => e.name),
    ];

    const registered: string[] = [];
    let skipped = 0;
    for (const entry of entries) {
      // Skip if already in config or registry by path
      if (this.ctx.config.sessions.find((s) => s.path === entry.path)) {
        skipped++;
        continue;
      }
      if (this.ctx.registry.findByPath(entry.path)) {
        skipped++;
        continue;
      }

      let entryName = deriveName(entry.path);
      if (existingNames.includes(entryName)) {
        entryName = nextSuffix(entryName, existingNames);
      }

      const added = this.ctx.registry.add({
        name: entryName,
        path: entry.path,
        priority: 50,
        auto_go: false,
      });
      if (added) {
        registered.push(entryName);
        existingNames.push(entryName);
      } else {
        skipped++;
      }
    }

    this.ctx.log.info(
      `Register: ${registered.length} added, ${skipped} skipped from ${dirPath}`,
    );
    return { ok: true, data: { registered, skipped, total: entries.length } };
  }

  /** Clone a git repo and register it */
  cmdClone(url: string, nameOverride?: string): IpcResponse {
    const home = homedir();
    const gitDir = join(home, "git");

    // Derive target dir name from URL: strip trailing .git, take basename
    const urlBasename =
      url.replace(/\.git$/, "").split("/").pop() ?? "unnamed";
    const dirName = nameOverride ?? urlBasename.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const targetDir = join(gitDir, dirName);

    if (existsSync(targetDir)) {
      // Dir exists — just register it if not already registered
      if (this.ctx.registry.findByPath(targetDir)) {
        return {
          ok: true,
          data: { name: dirName, path: targetDir, message: "Already registered" },
        };
      }
      const existingNames = [
        ...this.ctx.config.sessions.map((s) => s.name),
        ...this.ctx.registry.entries().map((e) => e.name),
      ];
      let regName = deriveName(targetDir);
      if (existingNames.includes(regName)) regName = nextSuffix(regName, existingNames);
      this.ctx.registry.add({ name: regName, path: targetDir, priority: 50, auto_go: false });
      return {
        ok: true,
        data: { name: regName, path: targetDir, message: "Existing dir registered" },
      };
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
      ...this.ctx.config.sessions.map((s) => s.name),
      ...this.ctx.registry.entries().map((e) => e.name),
    ];
    let regName = deriveName(targetDir);
    if (existingNames.includes(regName)) regName = nextSuffix(regName, existingNames);
    this.ctx.registry.add({ name: regName, path: targetDir, priority: 50, auto_go: false });

    this.ctx.log.info(`Cloned ${url} → ${targetDir} as '${regName}'`);
    return { ok: true, data: { name: regName, path: targetDir } };
  }

  /** Create a new project directory, git init, and register it */
  cmdCreate(name: string): IpcResponse {
    if (!isValidName(name)) {
      return {
        ok: false,
        error: `Invalid name '${name}' — must match [a-z0-9-]+`,
      };
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
      ...this.ctx.config.sessions.map((s) => s.name),
      ...this.ctx.registry.entries().map((e) => e.name),
    ];
    let regName = name;
    if (existingNames.includes(regName)) regName = nextSuffix(regName, existingNames);
    this.ctx.registry.add({ name: regName, path: targetDir, priority: 50, auto_go: false });

    this.ctx.log.info(`Created project '${regName}' at ${targetDir}`);
    return { ok: true, data: { name: regName, path: targetDir } };
  }

  // -- Session suspension (SIGSTOP/SIGCONT) ------------------------------------

  /** Suspend a single session by name — freezes all processes via SIGSTOP */
  cmdSuspend(name: string): IpcResponse {
    const resolved = this.ctx.resolveName(name);
    if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
    const s = this.ctx.state.getSession(resolved);
    if (!s) return { ok: false, error: `No state for session: ${resolved}` };
    if (s.suspended) return { ok: true, data: `'${resolved}' already suspended` };
    if (s.status !== "running" && s.status !== "degraded") {
      return {
        ok: false,
        error: `Cannot suspend '${resolved}' — status is ${s.status}`,
      };
    }
    const ok = suspendSession(resolved, this.ctx.log);
    if (ok) {
      this.ctx.state.setSuspended(resolved, true);
      this.monitoringEngine.updateStatusNotification();
      this.monitoringEngine.pushSseState();
    }
    return {
      ok,
      data: ok ? `Suspended '${resolved}'` : `Failed to suspend '${resolved}'`,
    };
  }

  /** Resume a single suspended session — unfreezes processes via SIGCONT */
  cmdResume(name: string): IpcResponse {
    const resolved = this.ctx.resolveName(name);
    if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
    const s = this.ctx.state.getSession(resolved);
    if (!s) return { ok: false, error: `No state for session: ${resolved}` };
    if (!s.suspended) return { ok: true, data: `'${resolved}' not suspended` };
    const ok = resumeSession(resolved, this.ctx.log);
    if (ok) {
      this.ctx.state.setSuspended(resolved, false);
      this.monitoringEngine.updateStatusNotification();
      this.monitoringEngine.pushSseState();
    }
    return {
      ok,
      data: ok ? `Resumed '${resolved}'` : `Failed to resume '${resolved}'`,
    };
  }

  /** Suspend all sessions except the named one — "make room" for a heavy build */
  cmdSuspendOthers(name: string): IpcResponse {
    const resolved = this.ctx.resolveName(name);
    if (!resolved) return { ok: false, error: `Unknown session: ${name}` };
    const sessions = this.ctx.state.getState().sessions;
    let suspended = 0;
    for (const [sName, s] of Object.entries(sessions)) {
      if (sName === resolved) continue;
      if (s.suspended) continue;
      if (s.status !== "running" && s.status !== "degraded") continue;
      if (suspendSession(sName, this.ctx.log)) {
        this.ctx.state.setSuspended(sName, true);
        suspended++;
      }
    }
    this.monitoringEngine.updateStatusNotification();
    this.monitoringEngine.pushSseState();
    return {
      ok: true,
      data: `Suspended ${suspended} sessions (except '${resolved}')`,
    };
  }

  /** Suspend all running sessions */
  cmdSuspendAll(): IpcResponse {
    const sessions = this.ctx.state.getState().sessions;
    let suspended = 0;
    for (const [sName, s] of Object.entries(sessions)) {
      if (s.suspended) continue;
      if (s.status !== "running" && s.status !== "degraded") continue;
      if (suspendSession(sName, this.ctx.log)) {
        this.ctx.state.setSuspended(sName, true);
        suspended++;
      }
    }
    this.monitoringEngine.updateStatusNotification();
    this.monitoringEngine.pushSseState();
    return { ok: true, data: `Suspended ${suspended} sessions` };
  }

  /** Resume all suspended sessions */
  cmdResumeAll(): IpcResponse {
    const sessions = this.ctx.state.getState().sessions;
    let resumed = 0;
    for (const [sName, s] of Object.entries(sessions)) {
      if (!s.suspended) continue;
      if (resumeSession(sName, this.ctx.log)) {
        this.ctx.state.setSuspended(sName, false);
        resumed++;
      }
    }
    this.monitoringEngine.updateStatusNotification();
    this.monitoringEngine.pushSseState();
    return { ok: true, data: `Resumed ${resumed} sessions` };
  }
}
