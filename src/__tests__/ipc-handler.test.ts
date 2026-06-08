/**
 * ipc-handler.test.ts — In-process tests for IpcHandler dispatch.
 *
 * IpcHandler routes each IPC command to an OrchestratorContext callback.
 * We drive it with the fake context (see helpers/fake-context.ts) and assert
 * that (a) the right delegate fires with the right args, and (b) the inline
 * special cases (config/stream/shutdown/switchboard_reset/skill/tool.autonomy)
 * behave per spec. No subprocess, no live daemon.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { IpcHandler } from "../ipc-handler.js";
import { makeFakeContext, type FakeContext } from "./helpers/fake-context.js";
import type { IpcCommand } from "../types.js";

let fc: FakeContext;
let handler: IpcHandler;

beforeEach(async () => {
  fc = await makeFakeContext({ agentConfigs: [] });
  handler = new IpcHandler(fc.ctx);
});
afterEach(() => fc.cleanup());

/** Cast a loose object into IpcCommand for dispatch (the union is large). */
function cmd(o: Record<string, unknown>): IpcCommand {
  return o as unknown as IpcCommand;
}

describe("IpcHandler — cmd* delegation", () => {
  test("status delegates to cmdStatus with name", async () => {
    const resp = await handler.handleIpcCommand(cmd({ cmd: "status", name: "foo" }));
    expect(resp.ok).toBe(true);
    expect(fc.calls.cmdStatus).toEqual([["foo"]]);
  });

  test("start/stop/restart delegate to their async cmds", async () => {
    await handler.handleIpcCommand(cmd({ cmd: "start", name: "a" }));
    await handler.handleIpcCommand(cmd({ cmd: "stop", name: "b" }));
    await handler.handleIpcCommand(cmd({ cmd: "restart", name: "c" }));
    expect(fc.calls.cmdStart).toEqual([["a"]]);
    expect(fc.calls.cmdStop).toEqual([["b"]]);
    expect(fc.calls.cmdRestart).toEqual([["c"]]);
  });

  test("health/memory delegate to their sync cmds", async () => {
    await handler.handleIpcCommand(cmd({ cmd: "health" }));
    await handler.handleIpcCommand(cmd({ cmd: "memory" }));
    expect(fc.calls.cmdHealth).toHaveLength(1);
    expect(fc.calls.cmdMemory).toHaveLength(1);
  });

  test("go/send/tabs pass through their arguments", async () => {
    await handler.handleIpcCommand(cmd({ cmd: "go", name: "g" }));
    await handler.handleIpcCommand(cmd({ cmd: "send", name: "s", text: "hi" }));
    await handler.handleIpcCommand(cmd({ cmd: "tabs", names: ["x", "y"] }));
    expect(fc.calls.cmdGo).toEqual([["g"]]);
    expect(fc.calls.cmdSend).toEqual([["s", "hi"]]);
    expect(fc.calls.cmdTabs).toEqual([[["x", "y"]]]);
  });

  test("open forwards all positional options", async () => {
    await handler.handleIpcCommand(
      cmd({ cmd: "open", path: "/p", name: "n", auto_go: true, priority: 9, force_new: true }),
    );
    expect(fc.calls.cmdOpen).toEqual([["/p", "n", true, 9, true]]);
  });

  test("close/autostart/dedupe/recent delegate", async () => {
    await handler.handleIpcCommand(cmd({ cmd: "close", name: "n" }));
    await handler.handleIpcCommand(cmd({ cmd: "autostart", name: "n", enabled: false }));
    await handler.handleIpcCommand(cmd({ cmd: "dedupe", dry_run: true }));
    await handler.handleIpcCommand(cmd({ cmd: "recent", count: 5 }));
    expect(fc.calls.cmdClose).toEqual([["n"]]);
    expect(fc.calls.cmdSetAutostart).toEqual([["n", false]]);
    expect(fc.calls.cmdDedupe).toEqual([[true]]);
    expect(fc.calls.cmdRecent).toEqual([[5]]);
  });

  test("suspend family delegates", async () => {
    await handler.handleIpcCommand(cmd({ cmd: "suspend", name: "n" }));
    await handler.handleIpcCommand(cmd({ cmd: "resume", name: "n" }));
    await handler.handleIpcCommand(cmd({ cmd: "suspend-others", name: "n" }));
    await handler.handleIpcCommand(cmd({ cmd: "suspend-all" }));
    await handler.handleIpcCommand(cmd({ cmd: "resume-all" }));
    expect(fc.calls.cmdSuspend).toEqual([["n"]]);
    expect(fc.calls.cmdResume).toEqual([["n"]]);
    expect(fc.calls.cmdSuspendOthers).toEqual([["n"]]);
    expect(fc.calls.cmdSuspendAll).toHaveLength(1);
    expect(fc.calls.cmdResumeAll).toHaveLength(1);
  });

  test("register/clone/create delegate", async () => {
    await handler.handleIpcCommand(cmd({ cmd: "register", path: "/scan" }));
    await handler.handleIpcCommand(cmd({ cmd: "clone", url: "git@x", name: "c" }));
    await handler.handleIpcCommand(cmd({ cmd: "create", name: "new" }));
    expect(fc.calls.cmdRegister).toEqual([["/scan"]]);
    expect(fc.calls.cmdClone).toEqual([["git@x", "c"]]);
    expect(fc.calls.cmdCreate).toEqual([["new"]]);
  });
});

describe("IpcHandler — inline special cases", () => {
  test("config returns ctx.config directly without a delegate", async () => {
    const resp = await handler.handleIpcCommand(cmd({ cmd: "config" }));
    expect(resp.ok).toBe(true);
    expect(resp.data).toBe(fc.ctx.config);
  });

  test("stream/boot fire ctx.boot() and reply immediately", async () => {
    const resp = await handler.handleIpcCommand(cmd({ cmd: "stream" }));
    expect(resp.ok).toBe(true);
    expect(resp.data).toContain("Stream");
    // boot is fire-and-forget — give the microtask a tick
    await new Promise((r) => setTimeout(r, 5));
    expect(fc.calls.boot).toHaveLength(1);
  });

  test("boot alias also triggers boot()", async () => {
    await handler.handleIpcCommand(cmd({ cmd: "boot" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(fc.calls.boot).toHaveLength(1);
  });

  test("switchboard_reset disables autonomous features and broadcasts", async () => {
    // Pre-enable so the reset is observable
    fc.switchboard.cognitive = true;
    fc.switchboard.oodaAutoTrigger = true;
    fc.switchboard.mindMeld = true;
    const resp = await handler.handleIpcCommand(cmd({ cmd: "switchboard_reset" }));
    expect(resp.ok).toBe(true);
    expect(fc.switchboard.cognitive).toBe(false);
    expect(fc.switchboard.oodaAutoTrigger).toBe(false);
    expect(fc.switchboard.mindMeld).toBe(false);
    // master switch and sdkBridge are preserved
    expect(fc.switchboard.all).toBe(true);
    expect(fc.broadcasts.some((b) => b.type === "switchboard_update")).toBe(true);
  });

  test("unknown command returns an error response", async () => {
    const resp = await handler.handleIpcCommand(cmd({ cmd: "totally-bogus" }));
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Unknown command");
  });
});

describe("IpcHandler — skill commands", () => {
  test("returns 'not enabled' guidance when SkillManager is absent", async () => {
    const resp = await handler.handleIpcCommand(cmd({ cmd: "skill.list" }));
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("--enable-skills-preview");
  });

  test("skill.list delegates to manager.list() when present", async () => {
    const listed = [{ id: "x" }];
    fc.cleanup();
    fc = await makeFakeContext({
      skillManager: {
        list: (_p?: unknown) => listed,
      },
    });
    handler = new IpcHandler(fc.ctx);
    const resp = await handler.handleIpcCommand(cmd({ cmd: "skill.list" }));
    expect(resp.ok).toBe(true);
    expect(resp.data).toBe(listed);
  });

  test("skill.info returns not-found when manager.get() is null", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ skillManager: { get: (_id: string) => null } });
    handler = new IpcHandler(fc.ctx);
    const resp = await handler.handleIpcCommand(cmd({ cmd: "skill.info", id: "nope" }));
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("skill not found");
  });

  test("skill.install surfaces SkillError code + detail in data", async () => {
    fc.cleanup();
    fc = await makeFakeContext({
      skillManager: {
        install: async () => {
          const e = new Error("boom") as Error & { code?: string; detail?: unknown };
          e.code = "MCP_NAME_USER_OWNED";
          e.detail = { name: "x" };
          throw e;
        },
      },
    });
    handler = new IpcHandler(fc.ctx);
    const resp = await handler.handleIpcCommand(
      cmd({ cmd: "skill.install", provider: "git+url", locator: "x", version: "1" }),
    );
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe("boom");
    expect((resp.data as { code: string }).code).toBe("MCP_NAME_USER_OWNED");
  });
});

describe("IpcHandler — tool.autonomy commands", () => {
  test("returns error when memoryDb is not initialised", async () => {
    const resp = await handler.handleIpcCommand(cmd({ cmd: "tool.autonomy.list" }));
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Memory database");
  });

  test("tool.autonomy.list reads from the db when present", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: true });
    handler = new IpcHandler(fc.ctx);
    const resp = await handler.handleIpcCommand(cmd({ cmd: "tool.autonomy.list" }));
    expect(resp.ok).toBe(true);
    expect(Array.isArray(resp.data)).toBe(true);
  });
});
