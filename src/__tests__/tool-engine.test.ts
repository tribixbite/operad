/**
 * tool-engine.test.ts — In-process tests for ToolEngine.buildToolContext.
 *
 * ToolEngine produces a ToolContext with live accessors over daemon state.
 * We assert the accessors read the StateManager snapshot correctly and that
 * cwd resolution falls back to $HOME when no session has a path.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { homedir } from "node:os";
import { ToolEngine } from "../tool-engine.js";
import { makeFakeContext, type FakeContext } from "./helpers/fake-context.js";

let fc: FakeContext;
afterEach(() => fc.cleanup());

describe("ToolEngine — buildToolContext", () => {
  beforeEach(async () => {
    fc = await makeFakeContext({
      withDb: true,
      extraToml: `[[session]]
name = "withpath"
type = "claude"
path = "/work/withpath"
`,
    });
  });

  test("sets agentName and resolves cwd from the first session path", () => {
    const eng = new ToolEngine(fc.ctx);
    const tctx = eng.buildToolContext("optimizer");
    expect(tctx.agentName).toBe("optimizer");
    expect(tctx.cwd).toBe("/work/withpath");
    expect(tctx.db).toBe(fc.db!);
  });

  test("getSessionStates maps StateManager session snapshots", () => {
    // Drive a session into a known state, then read it back via the accessor
    fc.state.forceStatus("withpath", "running");
    const eng = new ToolEngine(fc.ctx);
    const tctx = eng.buildToolContext("a");
    expect(tctx.getSessionStates).toBeDefined();
    const states = tctx.getSessionStates!();
    expect(states.withpath).toBeDefined();
    expect(states.withpath.status).toBe("running");
    expect("activity" in states.withpath).toBe(true);
    expect("rss_mb" in states.withpath).toBe(true);
  });

  test("getSystemMemory returns null when no snapshot present", () => {
    const eng = new ToolEngine(fc.ctx);
    const tctx = eng.buildToolContext("a");
    expect(tctx.getSystemMemory!()).toBeNull();
  });

  test("getBattery returns null when no battery snapshot present", () => {
    const eng = new ToolEngine(fc.ctx);
    const tctx = eng.buildToolContext("a");
    expect(tctx.getBattery!()).toBeNull();
  });

  test("provides a non-aborted signal and live send/capture hooks", () => {
    const eng = new ToolEngine(fc.ctx);
    const tctx = eng.buildToolContext("a");
    expect(tctx.signal.aborted).toBe(false);
    expect(typeof tctx.captureSessionOutput).toBe("function");
    expect(typeof tctx.sendToSession).toBe("function");
  });
});

describe("ToolEngine — cwd fallback", () => {
  test("falls back to $HOME when no session has a path", async () => {
    fc = await makeFakeContext({ withDb: true });
    // remove any session paths that may exist
    for (const s of fc.ctx.config.sessions) s.path = undefined;
    const eng = new ToolEngine(fc.ctx);
    const tctx = eng.buildToolContext("a");
    expect(tctx.cwd).toBe(homedir());
  });
});
