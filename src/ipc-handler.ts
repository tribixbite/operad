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
}
