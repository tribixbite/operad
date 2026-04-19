/**
 * ws-handler.ts — WebSocket message dispatch for the operad daemon.
 *
 * Extracted from ServerEngine (server-engine.ts) as part of the
 * transport-layer split. Handles all inbound WS client messages and
 * delegates to the appropriate subsystem via OrchestratorContext.
 *
 * Responsibilities:
 *   - buildSwitchboardPayload / buildAgentListPayload — pure payload builders
 *   - isAgentEnabled — predicate mirroring Daemon logic (no Daemon reference)
 *   - handleWsMessage — switch dispatch for all WS message types
 */

import type { OrchestratorContext } from "./orchestrator-context.js";
import type { AgentEngine } from "./agent-engine.js";
import type { WsClientMessage } from "./http.js";
import type { Switchboard } from "./types.js";
import { buildMemoryPrompt } from "./memory-injector.js";

/**
 * WsHandler — handles inbound WebSocket messages and builds WS broadcast payloads.
 *
 * Delegates to:
 *   - ctx.sdkBridge     for attach / prompt / permission_response / abort / detach
 *   - agentEngine       for agent_run / agent_chat / agent_chat_history / agent_chat_clear
 *   - ctx.switchboard   for switchboard_get / switchboard_update
 *
 * Unhandled types (subscribe / unsubscribe / ping) are handled upstream by
 * DashboardServer and silently ignored here.
 */
export class WsHandler {
  constructor(
    private readonly ctx: OrchestratorContext,
    private readonly agentEngine: AgentEngine,
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
   * Mirrors the Daemon.isAgentEnabled() logic so callers in this handler
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
   * Moved from ServerEngine (Sprint 13 Task 5). Delegates to:
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
    // Resolve lazy deps once per dispatch so TypeScript can narrow them.
    const sdkBridge = this.ctx.getSdkBridge();
    const memoryDb = this.ctx.getMemoryDb();

    switch (msg.type) {
      case "attach": {
        if (!sdkBridge) throw new Error("SDK bridge not initialized");
        if (!this.ctx.getSwitchboard().all || !this.ctx.getSwitchboard().sdkBridge)
          throw new Error("SDK bridge disabled by switchboard");
        const sessionName = msg.sessionName;
        if (!sessionName) throw new Error("sessionName required");
        // Resolve session path from config or registry via context callback
        const sessionPath = this.ctx.resolveSessionPath(sessionName);
        if (!sessionPath) throw new Error(`No path for session: ${sessionName}`);
        const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
        const result = await sdkBridge.attach(sessionName, sessionId, sessionPath);
        ws.send(JSON.stringify({ type: "attach_result", ...result }));
        break;
      }

      case "prompt": {
        if (!sdkBridge?.isAttached) throw new Error("No active SDK session");
        const prompt = typeof msg.prompt === "string" ? msg.prompt : "";
        if (!prompt) throw new Error("prompt required");
        // Inject memories if available and switchboard allows it
        let fullPrompt = prompt;
        if (
          this.ctx.getSwitchboard().all &&
          this.ctx.getSwitchboard().memoryInjection &&
          memoryDb &&
          sdkBridge.activeSessionName
        ) {
          const sessionPath = this.ctx.resolveSessionPath(sdkBridge.activeSessionName);
          if (sessionPath) {
            const { prompt: memPrompt } = await buildMemoryPrompt(
              memoryDb,
              sessionPath,
              10,
              prompt,
            );
            if (memPrompt) fullPrompt = memPrompt + "\n\n" + prompt;
          }
        }
        // Send prompt (non-blocking — messages stream via WS broadcast)
        sdkBridge.send(fullPrompt, {
          effort: typeof msg.effort === "string" ? (msg.effort as any) : undefined,
          thinking: msg.thinking as any,
        }).catch((err) => {
          ws.send(JSON.stringify({ type: "error", message: String(err) }));
        });
        break;
      }

      case "permission_response": {
        if (!sdkBridge) throw new Error("SDK bridge not initialized");
        const id = typeof msg.id === "string" ? msg.id : "";
        const behavior = msg.behavior === "allow" ? "allow" : "deny";
        const resolved = sdkBridge.resolvePermission(id, behavior);
        ws.send(JSON.stringify({ type: "permission_resolved", id, resolved }));
        break;
      }

      case "abort": {
        if (sdkBridge?.isAttached) {
          await sdkBridge.interrupt();
        }
        break;
      }

      case "detach": {
        if (sdkBridge?.isAttached) {
          await sdkBridge.detach();
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
        const history = memoryDb?.getConversationHistory(agentName, 50) ?? [];
        ws.send(JSON.stringify({ type: "agent_chat_history", agentName, messages: history }));
        break;
      }

      case "agent_chat_clear": {
        const agentName = typeof msg.agentName === "string" ? msg.agentName : "";
        const cleared = memoryDb?.clearConversation(agentName) ?? 0;
        ws.send(JSON.stringify({ type: "agent_chat_cleared", agentName, cleared }));
        break;
      }

      default:
        // subscribe / unsubscribe / ping handled by DashboardServer directly
        break;
    }
  }
}
