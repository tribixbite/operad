/**
 * ipc-handler.ts — IPC command router for the operad daemon.
 *
 * Extracted from ServerEngine (server-engine.ts) as part of the
 * transport-layer split. Routes IPC commands from the CLI to the
 * appropriate OrchestratorContext callback.
 *
 * Each case delegates to a cmd* callback on OrchestratorContext so the
 * state-machine logic stays authoritative in Daemon (where the REST API
 * also calls the same methods).
 *
 * Special cases handled inline:
 *   - "config"   — pure ctx.config read, no Daemon method needed
 *   - "stream"   — fire-and-forget ctx.boot()
 *   - "shutdown" — deferred ctx.shutdown() + process.exit
 */

import type { OrchestratorContext } from "./orchestrator-context.js";
import type { IpcCommand, IpcResponse } from "./types.js";

/**
 * IpcHandler — routes IPC commands from the CLI to OrchestratorContext callbacks.
 */
export class IpcHandler {
  constructor(private readonly ctx: OrchestratorContext) {}

  /**
   * Handle an IPC command from the CLI.
   *
   * Extracted from ServerEngine. The dispatch switch lives here; each case
   * delegates to a cmd* callback on OrchestratorContext so the state-machine
   * logic stays authoritative in Daemon (where the REST API also calls the
   * same methods).
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
        return this.ctx.cmdOpen(cmd.path, cmd.name, cmd.auto_go, cmd.priority, cmd.force_new);

      case "close":
        return this.ctx.cmdClose(cmd.name);

      case "autostart":
        return this.ctx.cmdSetAutostart(cmd.name, cmd.enabled);

      case "dedupe":
        return this.ctx.cmdDedupe(cmd.dry_run);

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

      case "skill.install":
      case "skill.uninstall":
      case "skill.list":
      case "skill.info":
      case "skill.events":
      case "skill.search":
        return this.handleSkillCommand(cmd);

      case "tool.autonomy.list":
      case "tool.autonomy.set":
        return this.handleToolAutonomyCommand(cmd);

      case "switchboard_reset": {
        // Reset autonomous features (cognitive/OODA/mindMeld) to opt-in defaults.
        // Keeps master switch, sdkBridge, memoryInjection, and per-agent overrides.
        const updated = this.ctx.updateSwitchboard({
          cognitive: false,
          oodaAutoTrigger: false,
          mindMeld: false,
        });
        this.ctx.broadcastWs("switchboard_update", updated);
        return { ok: true, data: "Switchboard autonomous features reset to opt-in defaults." };
      }

      default:
        return { ok: false, error: `Unknown command: ${(cmd as { cmd: string }).cmd}` };
    }
  }

  /**
   * Skill marketplace IPC handler. Returns 503 if the SkillManager
   * isn't initialized (preview flag off).
   */
  private async handleSkillCommand(
    cmd: Extract<IpcCommand, { cmd: `skill.${string}` }>,
  ): Promise<IpcResponse> {
    const mgr = this.ctx.getSkillManager();
    if (!mgr) {
      return {
        ok: false,
        error: "Skill marketplace not enabled. Set [skills] enabled = true in operad.toml (or pass --enable-skills-preview) and restart the daemon.",
      };
    }
    try {
      if (cmd.cmd === "skill.install") {
        const result = await mgr.install(
          cmd.provider as import("./skills/types.js").Provider,
          cmd.locator,
          cmd.version,
          {
            force_take_ownership: cmd.force_take_ownership,
            accept_cap_downgrade: cmd.accept_cap_downgrade,
          },
        );
        return { ok: true, data: result };
      }
      if (cmd.cmd === "skill.uninstall") {
        mgr.uninstall(cmd.id, { force_revoke: cmd.force_revoke });
        return { ok: true, data: { id: cmd.id } };
      }
      if (cmd.cmd === "skill.list") {
        return {
          ok: true,
          data: mgr.list(cmd.provider as import("./skills/types.js").Provider | undefined),
        };
      }
      if (cmd.cmd === "skill.search") {
        const r = await mgr.search({
          query: cmd.query,
          provider: cmd.provider as import("./skills/types.js").Provider | undefined,
          limit: cmd.limit,
          cursor: cmd.cursor,
        });
        return { ok: true, data: r };
      }
      if (cmd.cmd === "skill.info") {
        const s = mgr.get(cmd.id);
        return s
          ? { ok: true, data: s }
          : { ok: false, error: `skill not found: ${cmd.id}` };
      }
      if (cmd.cmd === "skill.events") {
        const db = this.ctx.getMemoryDb();
        if (!db) return { ok: false, error: "memoryDb not initialised" };
        const limit = Math.max(1, Math.min(500, cmd.limit ?? 30));
        const rows = db.requireDb().prepare(
          `SELECT id, skill_id, event_type, detail, occurred_at
             FROM skill_events ORDER BY occurred_at DESC LIMIT ?`,
        ).all(limit);
        return { ok: true, data: rows };
      }
      return { ok: false, error: `unhandled skill command: ${(cmd as { cmd: string }).cmd}` };
    } catch (err) {
      const e = err as Error & { code?: string; detail?: Record<string, unknown> };
      return {
        ok: false,
        error: e.message,
        data: e.code ? { code: e.code, detail: e.detail } : undefined,
      };
    }
  }

  /**
   * Per-tool autonomy promotion (Phase A1). Direct DB access — the
   * autonomy table is small and frequently read so we don't proxy
   * through SkillManager. The promotion path enforces
   * AUTONOMY_CAP_VIOLATION inside MemoryDb.promoteToolBucket.
   */
  private handleToolAutonomyCommand(
    cmd: Extract<IpcCommand, { cmd: `tool.autonomy.${string}` }>,
  ): IpcResponse {
    const db = this.ctx.getMemoryDb();
    if (!db) {
      return { ok: false, error: "Memory database not initialized" };
    }
    try {
      if (cmd.cmd === "tool.autonomy.list") {
        return { ok: true, data: db.listToolAutonomyCaps() };
      }
      if (cmd.cmd === "tool.autonomy.set") {
        const result = db.promoteToolBucket(cmd.tool_id, cmd.bucket);
        return { ok: true, data: { tool_id: cmd.tool_id, ...result } };
      }
      return { ok: false, error: `unhandled tool.autonomy command` };
    } catch (err) {
      const e = err as Error & { code?: string };
      return {
        ok: false,
        error: e.message,
        data: e.code ? { code: e.code } : undefined,
      };
    }
  }
}
