/**
 * monitoring-engine.test.ts — In-process tests for the unit-testable surface
 * of MonitoringEngine: SSE push gating (pushSseState), memory-pressure
 * auto-suspend decision branches that do NOT reach real tmux/notify side
 * effects (autoSuspendOnPressure with no eligible candidates), and timer
 * teardown (stopTimers).
 *
 * The IO-heavy paths — memoryPollAndShed (/proc reads), the actual suspend of
 * an idle session (real tmux SIGSTOP), battery polling (termux-api), and the
 * conversation-binding JSONL scan — are left to integration/e2e: they spawn
 * real processes and read the live filesystem. We drive only the branches
 * whose observable effect is a ctx callback or a decision with no spawn.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MonitoringEngine } from "../monitoring-engine.js";
import { MemoryMonitor } from "../memory.js";
import { ActivityDetector } from "../activity.js";
import { BatteryMonitor } from "../battery.js";
import { makeFakeContext, silentLog, type FakeContext } from "./helpers/fake-context.js";
import type { AndroidEngine } from "../android-engine.js";

let fc: FakeContext;
let eng: MonitoringEngine;

/** Record of android-engine calls made by the engine under test. */
let androidCalls: string[];

/** A duck-typed AndroidEngine that records autoStopFlaggedApps() without ADB. */
function fakeAndroidEngine(): AndroidEngine {
  return {
    autoStopFlaggedApps: () => { androidCalls.push("autoStopFlaggedApps"); },
  } as unknown as AndroidEngine;
}

function buildEngine(): MonitoringEngine {
  const log = silentLog();
  return new MonitoringEngine(
    fc.ctx,
    new MemoryMonitor(log),
    new ActivityDetector(log),
    new BatteryMonitor(log),
    fakeAndroidEngine(),
  );
}

beforeEach(() => { androidCalls = []; });
afterEach(() => {
  try { eng?.stopTimers(); } catch { /* ignore */ }
  fc.cleanup();
});

describe("MonitoringEngine — pushSseState", () => {
  test("no-op when there is no dashboard", async () => {
    fc = await makeFakeContext({ dashboard: null });
    eng = buildEngine();
    expect(() => eng.pushSseState()).not.toThrow();
  });

  test("no-op when the dashboard has zero SSE clients", async () => {
    const pushed: unknown[] = [];
    fc = await makeFakeContext({
      dashboard: { sseClientCount: 0, pushEvent: (t: string, d: unknown) => pushed.push([t, d]) },
    });
    eng = buildEngine();
    eng.pushSseState();
    expect(pushed).toHaveLength(0);
  });

  test("pushes a 'state' event when clients are connected and cmdStatus is ok", async () => {
    const pushed: [string, unknown][] = [];
    fc = await makeFakeContext({
      dashboard: { sseClientCount: 2, pushEvent: (t: string, d: unknown) => pushed.push([t, d]) },
      cmdResponses: { cmdStatus: { ok: true, data: { sessions: {} } } },
    });
    eng = buildEngine();
    eng.pushSseState();
    expect(pushed).toHaveLength(1);
    expect(pushed[0][0]).toBe("state");
    expect(fc.calls.cmdStatus).toHaveLength(1);
  });

  test("does not push when cmdStatus reports an error", async () => {
    const pushed: unknown[] = [];
    fc = await makeFakeContext({
      dashboard: { sseClientCount: 1, pushEvent: (t: string, d: unknown) => pushed.push([t, d]) },
      cmdResponses: { cmdStatus: { ok: false, error: "boom" } },
    });
    eng = buildEngine();
    eng.pushSseState();
    expect(pushed).toHaveLength(0);
  });
});

describe("MonitoringEngine — autoSuspendOnPressure", () => {
  beforeEach(async () => {
    fc = await makeFakeContext({
      extraToml: `[[session]]
name = "idle-svc"
type = "service"
command = "sleep"
path = "/work/idle-svc"
`,
    });
    eng = buildEngine();
  });

  test("warning pressure is a pure no-op (no android force-stop, no suspend)", () => {
    eng.autoSuspendOnPressure("warning");
    expect(androidCalls).toHaveLength(0);
  });

  test("normal pressure with no auto-suspended sessions does nothing", () => {
    // No session is auto_suspended in a fresh state → resume loop is empty.
    expect(() => eng.autoSuspendOnPressure("normal")).not.toThrow();
    expect(androidCalls).toHaveLength(0);
  });

  test("critical pressure force-stops android apps but suspends nothing when no idle candidates", () => {
    // Fresh sessions are 'pending'/activity=null → not eligible (need running+idle),
    // so the suspend block (real tmux) is never reached.
    eng.autoSuspendOnPressure("critical");
    expect(androidCalls).toEqual(["autoStopFlaggedApps"]);
    // Nothing was marked suspended
    const sessions = fc.state.getState().sessions;
    expect(Object.values(sessions).some((s) => s.suspended)).toBe(false);
  });

  test("emergency pressure also force-stops android apps with no eligible sessions", () => {
    eng.autoSuspendOnPressure("emergency");
    expect(androidCalls).toEqual(["autoStopFlaggedApps"]);
  });

  test("an auto-suspend flag on a vanished session is cleared, not retried forever", () => {
    // Regression: the flag used to be cleared ONLY when SIGCONT succeeded.
    // Once the session's processes were gone, resumeSession returned false,
    // the flag stayed set, and every subsequent poll retried the doomed
    // signal — 5453 warnings at a 5 s cadence over 70 days in a live log.
    //
    // "idle-svc" has no tmux session here, so getSessionPanePids returns []
    // and there is nothing to resume.
    fc.state.setSuspended("idle-svc", true, true);
    expect(fc.state.getSession("idle-svc")?.auto_suspended).toBe(true);

    eng.autoSuspendOnPressure("normal");

    const after = fc.state.getSession("idle-svc");
    expect(after?.auto_suspended).toBe(false);
    expect(after?.suspended).toBe(false);

    // Idempotent: a second poll must not re-flag or throw.
    eng.autoSuspendOnPressure("normal");
    expect(fc.state.getSession("idle-svc")?.auto_suspended).toBe(false);
  });
});

describe("MonitoringEngine — stopTimers", () => {
  test("is safe to call when no timers were ever started", async () => {
    fc = await makeFakeContext();
    eng = buildEngine();
    expect(() => eng.stopTimers()).not.toThrow();
    // Idempotent
    expect(() => eng.stopTimers()).not.toThrow();
  });
});
