/**
 * ws-handler.test.ts — In-process tests for WsHandler dispatch + payload builders.
 *
 * WsHandler owns the WebSocket message switch and two pure payload builders.
 * We drive it with the fake context plus a tiny in-memory WebSocket stub that
 * records `.send()` calls, and a fake SdkBridge / AgentEngine where needed.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WsHandler } from "../ws-handler.js";
import { makeFakeContext, makeAgent, type FakeContext } from "./helpers/fake-context.js";
import type { AgentEngine } from "../agent-engine.js";
import type { WsClientMessage } from "../http.js";

/** Minimal WebSocket stub — records every JSON payload sent. */
function fakeWs(): { ws: import("ws").WebSocket; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const ws = {
    send: (data: string) => { sent.push(JSON.parse(data)); },
  } as unknown as import("ws").WebSocket;
  return { ws, sent };
}

function msg(o: Record<string, unknown>): WsClientMessage {
  return o as unknown as WsClientMessage;
}

let fc: FakeContext;
/** A do-nothing AgentEngine whose calls we can observe. */
function fakeAgentEngine(calls: Record<string, unknown[][]>): AgentEngine {
  return {
    handleStandaloneAgentRun: async (...a: unknown[]) => { (calls.run ??= []).push(a); return {}; },
    handleAgentChat: async (...a: unknown[]) => { (calls.chat ??= []).push(a); },
  } as unknown as AgentEngine;
}

beforeEach(async () => {
  fc = await makeFakeContext({
    agentConfigs: [makeAgent("alpha"), makeAgent("beta", { enabled: false })],
  });
});
afterEach(() => fc.cleanup());

describe("WsHandler — pure payload builders", () => {
  test("buildSwitchboardPayload reflects current switchboard", () => {
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const payload = h.buildSwitchboardPayload();
    expect(payload.type).toBe("switchboard_update");
    expect(payload.all).toBe(true);
    expect(payload.memoryInjection).toBe(true);
  });

  test("buildAgentListPayload lists agents with enabled state", () => {
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const payload = h.buildAgentListPayload() as { agents: { name: string; enabled: boolean }[] };
    const byName = Object.fromEntries(payload.agents.map((a) => [a.name, a.enabled]));
    expect(byName.alpha).toBe(true);
    expect(byName.beta).toBe(false); // agent.enabled = false
  });

  test("isAgentEnabled honours the master switch", () => {
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    expect(h.isAgentEnabled("alpha")).toBe(true);
    fc.switchboard.all = false;
    expect(h.isAgentEnabled("alpha")).toBe(false);
  });

  test("isAgentEnabled honours per-agent override", () => {
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    fc.switchboard.agents.alpha = false;
    expect(h.isAgentEnabled("alpha")).toBe(false);
  });
});

describe("WsHandler — switchboard messages", () => {
  test("switchboard_get sends the current payload", async () => {
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const { ws, sent } = fakeWs();
    await h.handleWsMessage(ws, msg({ type: "switchboard_get" }));
    expect(sent[0].type).toBe("switchboard_update");
  });

  test("switchboard_update applies the patch and strips the type field", async () => {
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const { ws, sent } = fakeWs();
    await h.handleWsMessage(ws, msg({ type: "switchboard_update", cognitive: true }));
    expect(fc.switchboard.cognitive).toBe(true);
    // echoes the fresh payload back
    expect(sent[0].type).toBe("switchboard_update");
    expect(fc.calls.updateSwitchboard).toHaveLength(1);
    // the patch passed to updateSwitchboard must NOT carry a `type` key
    const patch = fc.calls.updateSwitchboard[0][0] as Record<string, unknown>;
    expect("type" in patch).toBe(false);
  });
});

describe("WsHandler — agent messages", () => {
  test("agent_run requires both agentName and prompt", async () => {
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const { ws } = fakeWs();
    await expect(h.handleWsMessage(ws, msg({ type: "agent_run", agentName: "alpha" }))).rejects.toThrow(
      /required/,
    );
  });

  test("agent_run dispatches to the engine and acks", async () => {
    const calls: Record<string, unknown[][]> = {};
    const h = new WsHandler(fc.ctx, fakeAgentEngine(calls));
    const { ws, sent } = fakeWs();
    await h.handleWsMessage(ws, msg({ type: "agent_run", agentName: "alpha", prompt: "hi" }));
    expect(sent[0].type).toBe("agent_run_started");
    // fire-and-forget — allow the promise to settle
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.run).toEqual([["alpha", "hi"]]);
  });

  test("agent_chat with missing fields sends an error rather than throwing", async () => {
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const { ws, sent } = fakeWs();
    await h.handleWsMessage(ws, msg({ type: "agent_chat", agentName: "" }));
    expect(sent[0].type).toBe("error");
  });

  test("agent_chat_history returns [] when no db", async () => {
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const { ws, sent } = fakeWs();
    await h.handleWsMessage(ws, msg({ type: "agent_chat_history", agentName: "alpha" }));
    expect(sent[0].type).toBe("agent_chat_history");
    expect(sent[0].messages).toEqual([]);
  });

  test("agent_chat_history reads from db when present", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: true, agentConfigs: [makeAgent("alpha")] });
    fc.db!.appendConversation("alpha", "user", "hello");
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const { ws, sent } = fakeWs();
    await h.handleWsMessage(ws, msg({ type: "agent_chat_history", agentName: "alpha" }));
    expect((sent[0].messages as unknown[]).length).toBeGreaterThan(0);
  });

  test("agent_chat_clear returns the cleared count", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: true, agentConfigs: [makeAgent("alpha")] });
    fc.db!.appendConversation("alpha", "user", "hello");
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const { ws, sent } = fakeWs();
    await h.handleWsMessage(ws, msg({ type: "agent_chat_clear", agentName: "alpha" }));
    expect(sent[0].type).toBe("agent_chat_cleared");
    expect(sent[0].cleared as number).toBeGreaterThanOrEqual(1);
  });
});

describe("WsHandler — SDK bridge messages", () => {
  test("attach throws when bridge not initialised", async () => {
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const { ws } = fakeWs();
    await expect(h.handleWsMessage(ws, msg({ type: "attach", sessionName: "x" }))).rejects.toThrow(
      /not initialized/,
    );
  });

  test("attach throws when switchboard disables the bridge", async () => {
    fc.cleanup();
    fc = await makeFakeContext({
      switchboard: { sdkBridge: false },
      sdkBridge: { attach: async () => ({ ok: true }) },
    });
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const { ws } = fakeWs();
    await expect(h.handleWsMessage(ws, msg({ type: "attach", sessionName: "x" }))).rejects.toThrow(
      /disabled by switchboard/,
    );
  });

  test("attach resolves session path and sends attach_result", async () => {
    fc.cleanup();
    fc = await makeFakeContext({
      extraToml: `[[session]]
name = "proj"
type = "claude"
path = "/work/proj"
`,
      sdkBridge: {
        attach: async (_n: string, _id: string | undefined, path: string) => ({ ok: true, path }),
      },
    });
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const { ws, sent } = fakeWs();
    await h.handleWsMessage(ws, msg({ type: "attach", sessionName: "proj" }));
    expect(sent[0].type).toBe("attach_result");
    expect(sent[0].path).toBe("/work/proj");
  });

  test("permission_response normalises behaviour and replies", async () => {
    fc.cleanup();
    fc = await makeFakeContext({
      sdkBridge: { resolvePermission: (_id: string, _b: string) => true },
    });
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const { ws, sent } = fakeWs();
    await h.handleWsMessage(ws, msg({ type: "permission_response", id: "p1", behavior: "allow" }));
    expect(sent[0].type).toBe("permission_resolved");
    expect(sent[0].resolved).toBe(true);
  });

  test("unknown message type is silently ignored", async () => {
    const h = new WsHandler(fc.ctx, fakeAgentEngine({}));
    const { ws, sent } = fakeWs();
    await h.handleWsMessage(ws, msg({ type: "ping" }));
    expect(sent).toHaveLength(0);
  });
});
