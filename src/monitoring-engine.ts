/**
 * monitoring-engine.ts — Periodic monitoring subsystem
 *
 * Owns memory polling, battery polling, SSE state push, conversation deltas,
 * and Android status notification updates. Extracted from daemon.ts to reduce
 * its size and improve cohesion.
 *
 * Lifecycle:
 *   - startMemoryTimer() — every 5s memory poll + shed cycle
 *   - startBatteryTimer() — configurable interval battery poll
 *   - stopTimers() — called by Daemon.shutdown() to cancel intervals
 */

import { detectPlatform } from "./platform/platform.js";
import {
  suspendSession,
  resumeSession,
  capturePane,
  getAttachedClients,
  getSessionPanePids,
  findProcessTree,
} from "./session.js";
import {
  appendNotification,
} from "./notifications.js";
import {
  getConversationDelta,
  bindProjectConversations,
  type BindableSession,
} from "./claude-session.js";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { MemoryMonitor } from "./memory.js";
import type { ActivityDetector } from "./activity.js";
import type { BatteryMonitor } from "./battery.js";
import type { AndroidEngine } from "./android-engine.js";
import { loadOrCreateToken } from "./auth.js";
import { dirname } from "node:path";

/** Pattern indicating Claude Code is actively processing (not waiting for input) */
const CLAUDE_WORKING_PATTERN = /esc to interrupt/;

/** Strip ANSI escape sequences */
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

export class MonitoringEngine {
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  private batteryTimer: ReturnType<typeof setInterval> | null = null;
  /** Summary notification content from last cycle — skip re-emit if unchanged */
  private _prevSummaryContent = "";
  /** Last known conversation UUID per session — for delta detection */
  private lastConversationUuids = new Map<string, string>();

  constructor(
    private ctx: OrchestratorContext,
    private memory: MemoryMonitor,
    private activity: ActivityDetector,
    private battery: BatteryMonitor,
    private androidEngine: AndroidEngine,
  ) {}

  // -- Memory monitoring -------------------------------------------------------

  /** Start periodic memory monitoring timer (every 5s — fast enough to catch burst OOM) */
  startMemoryTimer(): void {
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    this.memoryTimer = setInterval(() => {
      this.memoryPollAndShed();
    }, 5_000);
    // Run an initial poll immediately
    this.memoryPollAndShed();
  }

  /** Poll system memory and update per-session RSS/activity */
  memoryPollAndShed(): void {
    // Invalidate caches at start of each poll cycle so we get fresh data
    this.memory.invalidatePsCache();
    this.activity.invalidateProcCache();

    // System memory
    const sysMem = this.memory.getSystemMemory();
    this.ctx.state.updateSystemMemory(sysMem);

    // Per-session RSS and activity classification
    for (const session of this.ctx.config.sessions) {
      const s = this.ctx.state.getSession(session.name);
      if (!s || (s.status !== "running" && s.status !== "degraded")) {
        if (s) this.ctx.state.updateSessionMetrics(session.name, null, null);
        continue;
      }

      // Get PID: prefer adopted bare PID, fall back to tmux pane PID
      const adoptedPid = this.ctx.adoptedPids.get(session.name);
      let pid: number | null = null;
      if (adoptedPid !== undefined) {
        // Verify adopted PID is still alive.
        //
        // This used to test existsSync("/proc/<pid>") directly. /proc does not
        // exist on macOS or Windows, so the answer there was ALWAYS false:
        // every adopted session was declared exited on the first 5s poll,
        // dropped from adoptedPids and forced to "stopped", then re-adopted by
        // the next health sweep and killed again — permanent flapping that
        // made bare sessions unusable off Linux. The platform layer has a
        // working implementation for each OS.
        if (detectPlatform().isProcessAlive(adoptedPid)) {
          pid = adoptedPid;
        } else {
          // Bare process died — remove from adopted, mark stopped
          this.ctx.log.info(`Adopted session '${session.name}' PID ${adoptedPid} exited`, { session: session.name });
          this.ctx.adoptedPids.delete(session.name);
          this.ctx.state.forceStatus(session.name, "stopped");
          this.ctx.state.updateSessionMetrics(session.name, null, "stopped");
          continue;
        }
      } else {
        pid = this.memory.getSessionPid(session.name);
      }
      if (pid === null) {
        this.ctx.state.updateSessionMetrics(session.name, null, "stopped");
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

      this.ctx.state.updateSessionMetrics(session.name, rss_mb, activityState, lastOutput, claudeStatus);
    }

    // Auto-suspend/resume based on memory pressure
    this.autoSuspendOnPressure(sysMem?.pressure ?? "normal");

    // Bind each session to its own conversation when 2+ share a path
    this.bindClaudeConversations();

    // Push conversation deltas for claude sessions (live streaming)
    this.pushConversationDeltas();

    // Push SSE update with combined state+memory
    this.pushSseState();

    // Update persistent status notification in system bar
    this.updateStatusNotification();
  }

  /**
   * Is `pid` anywhere in this session's process tree?
   *
   * Used to keep the daemon from SIGSTOPping itself. Returns false when the
   * tree cannot be determined — the caller then falls back to its other
   * guards rather than refusing to shed at all.
   */
  private treeContainsPid(sessionName: string, pid: number): boolean {
    try {
      const rootPid = this.memory.getSessionPid(sessionName);
      if (rootPid == null) return false;
      if (rootPid === pid) return true;
      return findProcessTree(rootPid).includes(pid);
    } catch {
      return false;
    }
  }

  /**
   * Auto-suspend idle sessions when memory pressure is critical/emergency.
   * Auto-resume previously auto-suspended sessions when pressure returns to normal.
   * This is the key mechanism that prevents OOM death spirals during heavy builds.
   */
  autoSuspendOnPressure(pressure: string): void {
    if (pressure === "critical" || pressure === "emergency") {
      // Force-stop flagged Android apps on memory pressure
      this.androidEngine.autoStopFlaggedApps();

      // Sort running, non-suspended sessions by RSS descending (biggest first)
      const candidates: Array<{ name: string; rss: number }> = [];
      const sessions = this.ctx.state.getState().sessions;
      const selfPid = process.pid;
      for (const [name, s] of Object.entries(sessions)) {
        if (s.suspended) continue;
        if (s.status !== "running" && s.status !== "degraded") continue;
        // Only auto-suspend idle sessions — don't freeze active builds
        if (s.activity !== "idle") continue;

        // "Idle" means three consecutive zero-CPU polls (~15s), which is
        // exactly what a Claude session sitting at its prompt looks like while
        // the user reads or types. Freezing one makes the terminal hang with
        // no explanation. If a tmux client is attached, somebody is looking at
        // it — leave it alone.
        try {
          if (getAttachedClients(name) > 0) {
            this.ctx.log.debug(`Not suspending '${name}' — a tmux client is attached`, { session: name });
            continue;
          }
        } catch { /* tmux unavailable — fall through to the self-PID guard */ }

        // Never suspend a tree containing the daemon itself. signalSessionTree
        // SIGSTOPs every descendant of the pane PID, and the daemon IS a
        // descendant when it was launched in the foreground inside a managed
        // pane, or during the window in which `operad stream` is still its
        // parent. Stopping ourselves mid-loop is unrecoverable: nothing is
        // left running that could ever SIGCONT anything.
        if (this.treeContainsPid(name, selfPid)) {
          this.ctx.log.warn(
            `Not suspending '${name}' — the operad daemon (PID ${selfPid}) is inside its process tree`,
            { session: name },
          );
          continue;
        }

        candidates.push({ name, rss: s.rss_mb ?? 0 });
      }
      candidates.sort((a, b) => b.rss - a.rss);

      if (candidates.length > 0) {
        // Emergency: suspend ALL idle sessions immediately (lmkd kills come in bursts)
        // Critical: suspend one per cycle to avoid over-freezing
        const limit = pressure === "emergency" ? candidates.length : 1;
        const targets = candidates.slice(0, limit);
        const names = targets.map((t) => t.name);
        this.ctx.log.warn(
          `Memory ${pressure}: auto-suspending ${names.join(", ")}`,
        );
        for (const target of targets) {
          if (suspendSession(target.name, this.ctx.log)) {
            this.ctx.state.setSuspended(target.name, true, true); // auto=true
          }
        }
        detectPlatform().notify("operad", `Paused ${names.join(", ")} — memory ${pressure}`, "operad-autosuspend");
        appendNotification({ type: "memory_pressure", title: `Memory ${pressure}`, content: `Auto-suspended: ${names.join(", ")}` });
        // Nudge Edge renderers to GC via CFC bridge CDP (non-blocking, best-effort)
        fetch("http://127.0.0.1:18963/memory-pressure", {
          method: "POST", signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      }
    } else if (pressure === "normal") {
      // Auto-resume sessions that were auto-suspended (not manually suspended)
      const sessions = this.ctx.state.getState().sessions;
      for (const [name, s] of Object.entries(sessions)) {
        if (!s.auto_suspended) continue;

        // Clearing the flag ONLY on a successful SIGCONT leaves it stuck
        // forever once the session's processes are gone: `resumeSession`
        // returns false, `auto_suspended` stays true, and this loop retries
        // a doomed signal on every poll. One dead session produced 5453
        // "Cannot signal … — no pane PIDs found" warnings at a 5 s cadence
        // over 70 days.
        //
        // No pane PIDs means there is nothing suspended to resume, so the
        // flag is meaningless and must be dropped. A failure WITH live PIDs
        // is a different story — that could be a transient EPERM, so leave
        // the flag set and try again next poll.
        const panePids = getSessionPanePids(name);
        if (panePids.length === 0) {
          this.ctx.log.info(
            `Clearing stale auto-suspend on '${name}' — no processes left to resume`,
            { session: name },
          );
          this.ctx.state.setSuspended(name, false);
          continue;
        }

        this.ctx.log.info(`Memory normal: auto-resuming '${name}'`, { session: name });
        if (resumeSession(name, this.ctx.log)) {
          this.ctx.state.setSuspended(name, false);
        }
      }
    }
    // Warning pressure: no action — just monitoring
  }

  /** Push current state snapshot to all SSE clients */
  pushSseState(): void {
    const dashboard = this.ctx.getDashboard();
    if (!dashboard || dashboard.sseClientCount === 0) return;

    const statusResp = this.ctx.cmdStatus();
    if (statusResp.ok) {
      dashboard.pushEvent("state", statusResp.data);
    }
  }

  /**
   * Bind each running claude session to the specific conversation JSONL it
   * owns, so two operad sessions sharing one project path open distinct
   * conversations in the viewer.
   *
   * Only paths with **2+ running claude sessions** are bound — a lone
   * session needs no disambiguation (the viewer falls back to its
   * config.session_id or the project's most-recent conversation, which
   * also auto-follows a new `cc`). Single sessions get any stale binding
   * cleared so they don't pin to an old conversation.
   *
   * Steady-state cost is near-zero: bindings are sticky, so once placed the
   * pure pass reads no JSONL heads on subsequent polls.
   */
  bindClaudeConversations(): void {
    // Group running claude sessions by project path.
    const byPath = new Map<string, BindableSession[]>();
    const existingByPath = new Map<string, Record<string, string>>();
    for (const cfg of this.ctx.config.sessions) {
      if (cfg.type !== "claude" || !cfg.path) continue;
      const s = this.ctx.state.getSession(cfg.name);
      if (!s || s.status !== "running") continue;
      const list = byPath.get(cfg.path) ?? [];
      list.push({
        name: cfg.name,
        startedAtMs: s.uptime_start ? Date.parse(s.uptime_start) : 0,
        resumeId: cfg.session_id ?? null,
      });
      byPath.set(cfg.path, list);
      if (s.bound_jsonl_id) {
        const ex = existingByPath.get(cfg.path) ?? {};
        ex[cfg.name] = s.bound_jsonl_id;
        existingByPath.set(cfg.path, ex);
      }
    }

    for (const [path, sessions] of byPath) {
      if (sessions.length < 2) {
        // Lone session — clear any stale binding so the viewer follows the
        // most-recent conversation (or its resume id).
        const only = sessions[0];
        if (only) {
          const cur = this.ctx.state.getSession(only.name);
          if (cur?.bound_jsonl_id) this.ctx.state.setBoundJsonl(only.name, null);
        }
        continue;
      }
      try {
        const bindings = bindProjectConversations(
          path, sessions, existingByPath.get(path) ?? {},
        );
        for (const s of sessions) {
          // Apply each session's binding (or leave null until its `cc`
          // creates a conversation we can place).
          this.ctx.state.setBoundJsonl(s.name, bindings[s.name] ?? null);
        }
      } catch {
        // Non-fatal — leave existing bindings in place.
      }
    }
  }

  /** Push conversation deltas for claude sessions via SSE (live streaming) */
  pushConversationDeltas(): void {
    const dashboard = this.ctx.getDashboard();
    if (!dashboard || dashboard.sseClientCount === 0) return;

    for (const cfg of this.ctx.config.sessions) {
      if (cfg.type !== "claude" || !cfg.path) continue;
      const s = this.ctx.state.getSession(cfg.name);
      if (!s || s.status !== "running") continue;

      try {
        const lastUuid = this.lastConversationUuids.get(cfg.name) ?? null;
        const delta = getConversationDelta(cfg.path, lastUuid, 10);
        if (!delta || delta.entries.length === 0) continue;

        // Track the newest UUID for next iteration
        const newestUuid = delta.entries[delta.entries.length - 1].uuid;
        this.lastConversationUuids.set(cfg.name, newestUuid);

        // Push via SSE
        dashboard.pushEvent("conversation", {
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
   * The dashboard access token, resolved the same way the daemon resolves it.
   * Memoised: loadOrCreateToken reads (and on first use writes) a file, and
   * the notification is rebuilt on every 5s poll.
   */
  private cachedToken: string | null = null;
  private dashboardToken(): string {
    if (this.cachedToken) return this.cachedToken;
    try {
      this.cachedToken = loadOrCreateToken(dirname(this.ctx.config.orchestrator.state_file));
    } catch {
      this.cachedToken = "";
    }
    return this.cachedToken;
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
  updateStatusNotification(): void {
    const sessions = this.ctx.state.getState().sessions;
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

    const port = this.ctx.config.orchestrator.dashboard_port;
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
    // The URL must carry the token. Tapping this opened a bare
    // http://127.0.0.1:<port>, which since 0.5.0 loads the SPA and then 401s
    // on every request — the notification's own Dashboard button could not
    // reach the dashboard. Visiting ?token=… performs the handshake and
    // redirects to a clean URL, so the token is not left in the address bar.
    const dashUrl = `http://127.0.0.1:${port}/?token=${this.dashboardToken()}`;
    const dashboardAction = `LD_PRELOAD=${ldPreload} ${amBin} start -a android.intent.action.VIEW -n ${edgeComponent} -f 0x14000000 -d ${JSON.stringify(dashUrl)}`;

    detectPlatform().notifyWithArgs([
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

  // -- Battery monitoring ------------------------------------------------------

  /** Start periodic battery monitoring timer */
  startBatteryTimer(): void {
    if (!this.ctx.config.battery.enabled) {
      this.ctx.log.debug("Battery monitoring disabled");
      return;
    }
    if (this.batteryTimer) clearInterval(this.batteryTimer);
    const intervalMs = this.ctx.config.battery.poll_interval_s * 1000;
    this.batteryTimer = setInterval(() => {
      this.batteryPoll();
    }, intervalMs);
    // Delay initial poll by 5s so it doesn't block IPC server startup.
    // termux-battery-status is synchronous (~5-8s) and blocks the event loop.
    setTimeout(() => this.batteryPoll(), 5000);
  }

  /** Poll battery status, take action if critically low */
  batteryPoll(): void {
    const prevActive = this.battery.actionsActive;
    const status = this.battery.checkAndAct();
    if (!status) return;

    const dashboard = this.ctx.getDashboard();

    // Log battery_low notification when actions first trigger
    if (this.battery.actionsActive && !prevActive) {
      appendNotification({ type: "battery_low", title: "Battery critically low", content: `${status.percentage}%, not charging — radios disabled` });
      if (dashboard && dashboard.sseClientCount > 0) {
        dashboard.pushEvent("notification", { type: "battery_low", title: "Battery critically low", content: `${status.percentage}%` });
      }
    }

    // Update state for dashboard/status display
    this.ctx.state.updateBattery({
      percentage: status.percentage,
      charging: status.charging,
      temperature: status.temperature,
      radios_disabled: this.battery.actionsActive,
    });
  }

  // -- Lifecycle ---------------------------------------------------------------

  /** Cancel all monitoring timers — call from Daemon.shutdown() */
  stopTimers(): void {
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer);
      this.memoryTimer = null;
    }
    if (this.batteryTimer) {
      clearInterval(this.batteryTimer);
      this.batteryTimer = null;
    }
  }
}
