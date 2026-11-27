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
import { ConversationPinner } from "../conversation-pin.js";
import { parseProcessSnapshot } from "../runtimes/detect.js";
import { detectPlatform } from "../platform/platform.js";

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

// ---------------------------------------------------------------------------
// Status notification rate limit — at most one post per interval, with the
// newest state posted when the window lapses.
// ---------------------------------------------------------------------------

describe("MonitoringEngine — status notification rate limit", () => {
  const INTERVAL_MS = 60;
  // The rate limit reads this clock; it stands still during a burst so the
  // result does not depend on how fast the runner is. A Windows runner took
  // longer than the whole window per update, so every change looked spaced
  // out and was posted. The trailing post still waits on a real timer.
  let fakeNow = 1_000_000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let posts: string[][];
  let restore: () => void;

  beforeEach(async () => {
    fc = await makeFakeContext({
      extraToml: `[[session]]
name = "svc"
type = "service"
command = "sleep"
path = "/work/svc"
`,
    });
    const log = silentLog();
    eng = new MonitoringEngine(
      fc.ctx, new MemoryMonitor(log), new ActivityDetector(log), new BatteryMonitor(log), fakeAndroidEngine(),
      { statusMinIntervalMs: INTERVAL_MS, now: () => fakeNow },
    );
    // Record posts instead of spawning termux-notification.
    posts = [];
    const platform = detectPlatform();
    const original = platform.notifyWithArgs;
    platform.notifyWithArgs = (args: string[]) => { posts.push(args); };
    restore = () => { platform.notifyWithArgs = original; };
    const s = fc.state.getSession("svc")!;
    s.status = "running";
  });
  afterEach(() => restore());

  /** Set the session's activity and ask for a notification update. */
  const show = (activity: "active" | "idle") => {
    fc.state.updateSessionMetrics("svc", null, activity);
    eng.updateStatusNotification();
  };
  /** The --content value of a recorded post. */
  const contentOf = (args: string[]) => args[args.indexOf("--content") + 1];

  test("posts at once, holds changes inside the window, then posts the newest", async () => {
    show("active");
    expect(posts).toHaveLength(1);
    expect(contentOf(posts[0])).toContain("▶ svc");
    show("idle");
    show("active");
    show("idle");
    expect(posts).toHaveLength(1); // still inside the window
    fakeNow += INTERVAL_MS * 2;
    await sleep(INTERVAL_MS * 2);
    expect(posts).toHaveLength(2); // one trailing post, not three
    expect(contentOf(posts[1])).toContain("◇ svc");
  });

  test("a held update the state reverted from is dropped", async () => {
    show("active");
    show("idle"); // held
    show("active"); // back to what is already posted
    fakeNow += INTERVAL_MS * 2;
    await sleep(INTERVAL_MS * 2);
    expect(posts).toHaveLength(1);
  });

  test("an unchanged state is never re-posted, even after the window", async () => {
    show("active");
    fakeNow += INTERVAL_MS * 2;
    await sleep(INTERVAL_MS * 2);
    show("active");
    expect(posts).toHaveLength(1);
  });

  test("stopTimers cancels a held update", async () => {
    show("active");
    show("idle");
    eng.stopTimers();
    fakeNow += INTERVAL_MS * 2;
    await sleep(INTERVAL_MS * 2);
    expect(posts).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// Conversation pinning — a running agy/Codex session's conversation id is
// recorded so a restart resumes that exact conversation.
// ---------------------------------------------------------------------------

describe("MonitoringEngine — conversation pinning", () => {
  /** A pane (pid 200) running `args` under its shell. */
  const paneRunning = (args: string) =>
    parseProcessSnapshot(["  PID  PPID ARGS", "  200   100 -bash", `  300   200 ${args}`].join("\n"));

  function engineWith(locate: (path: string, since: number) => string | null): MonitoringEngine {
    const log = silentLog();
    return new MonitoringEngine(
      fc.ctx, new MemoryMonitor(log), new ActivityDetector(log), new BatteryMonitor(log), fakeAndroidEngine(),
      {
        pinner: new ConversationPinner(() => 1_000_000, 0),
        runtimeFor: () => ({ latestConversationId: locate }),
      },
    );
  }

  test("records the conversation in the registry and the live config", async () => {
    fc = await makeFakeContext();
    fc.ctx.registry.add({ name: "ag", path: "/p", priority: 10, auto_go: false, type: "agy" });
    const session = { ...fc.ctx.config.sessions[0], name: "ag", path: "/p", type: "agy" as const };
    eng = engineWith(() => "conv-9");
    eng.reconcileSessionRuntime(session, 200, paneRunning("agy --continue"));
    expect(fc.ctx.registry.find("ag")?.session_id).toBe("conv-9");
    expect(session.session_id).toBe("conv-9");
  });

  test("a TOML-declared session is not pinned", async () => {
    fc = await makeFakeContext();
    const session = { ...fc.ctx.config.sessions[0], name: "toml-only", path: "/p", type: "agy" as const };
    eng = engineWith(() => "conv-9");
    eng.reconcileSessionRuntime(session, 200, paneRunning("agy --continue"));
    expect(session.session_id).toBeUndefined();
  });

  test("while a different tool runs, nothing is pinned to the session", async () => {
    fc = await makeFakeContext();
    fc.ctx.registry.add({ name: "ag", path: "/p", priority: 10, auto_go: false, type: "agy" });
    const session = { ...fc.ctx.config.sessions[0], name: "ag", path: "/p", type: "agy" as const };
    eng = engineWith(() => "conv-9");
    // One poll of codex is not yet an adopted switch, and a codex
    // conversation must never be recorded against an agy session.
    eng.reconcileSessionRuntime(session, 200, paneRunning("codex"));
    expect(fc.ctx.registry.find("ag")?.session_id).toBeUndefined();
  });
});
