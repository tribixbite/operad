/**
 * sdk-bridge.test.ts — SdkBridge permission routing and run isolation.
 *
 * The SDK module is replaced through the `_setSdkModule` seam with a fake
 * whose session captures the `canUseTool` callback the bridge builds, so the
 * test can raise a permission request exactly the way the SDK would mid-run.
 * (Not mock.module — bun:test applies module mocks process-wide.)
 *
 * Covers:
 *   - a standalone run's permission_request reaches the agent's room (it went
 *     to room "unknown", which nobody subscribes to → 5-min hang then deny)
 *   - attach() is refused while a standalone run is busy, and the refused
 *     attach does not deny the run's pending permission
 *   - pending permissions are settled per run
 */

import { describe, test, expect, afterEach } from "bun:test";
import { SdkBridge, _setSdkModule } from "../sdk-bridge.js";
import type { Logger } from "../log.js";

const silentLog = (): Logger => {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
};

type CanUseTool = (tool: string, input: unknown) => Promise<{ behavior: string; message?: string }>;

/**
 * A fake V2 session. `stream()` asks for permission on "Bash" once, records
 * the decision, then yields a result message.
 */
function makeFakeSdk() {
  const decisions: Array<{ behavior: string; message?: string }> = [];
  /** Resolves once the run is parked inside canUseTool. */
  let markAsked!: () => void;
  const asked = new Promise<void>((r) => { markAsked = r; });

  const sdk = {
    unstable_v2_createSession(opts: { canUseTool: CanUseTool }) {
      return {
        sessionId: "fake-session",
        async send(_prompt: string) { /* accepted */ },
        async *stream() {
          const pending = opts.canUseTool("Bash", { command: "ls" });
          markAsked();
          decisions.push(await pending);
          yield { type: "result", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, num_turns: 1 };
        },
        close() { /* no subprocess */ },
      };
    },
    unstable_v2_resumeSession(_id: string, opts: { canUseTool: CanUseTool }) {
      return sdk.unstable_v2_createSession(opts);
    },
  };
  return { sdk, decisions, asked };
}

afterEach(() => _setSdkModule(null));

describe("SdkBridge — standalone run permissions", () => {
  test("permission_request is broadcast to the running agent's room", async () => {
    const fake = makeFakeSdk();
    _setSdkModule(fake.sdk);
    const sent: Array<{ room: string; data: any }> = [];
    const bridge = new SdkBridge(silentLog(), (room, data) => sent.push({ room, data }));

    const run = bridge.runStandaloneAgent("optimizer", { prompt: "p" }, ".", "go");
    await fake.asked;

    const req = sent.find((m) => m.data?.type === "permission_request");
    expect(req).toBeDefined();
    expect(req!.room).toBe("optimizer");
    // The payload names its room and kind: agent and session rooms are both
    // keyed by bare names, and the dashboard routes the two to different
    // views (a global watcher for agent runs, the conversation drawer for
    // attached sessions).
    expect(req!.data.room).toBe("optimizer");
    expect(req!.data.kind).toBe("agent");

    expect(bridge.resolvePermission(req!.data.id, "allow")).toBe(true);
    await run;
    expect(fake.decisions).toEqual([{ behavior: "allow" }]);
  });

  test("attach() is refused while a standalone run is busy, without denying its permission", async () => {
    const fake = makeFakeSdk();
    _setSdkModule(fake.sdk);
    const sent: Array<{ room: string; data: any }> = [];
    const bridge = new SdkBridge(silentLog(), (room, data) => sent.push({ room, data }));

    const run = bridge.runStandaloneAgent("ideator", { prompt: "p" }, ".", "go");
    await fake.asked;

    await expect(bridge.attach("some-session", undefined, ".")).rejects.toThrow(/standalone/);
    expect(bridge.isAttached).toBe(false);
    await bridge.detach(); // no-op: nothing attached

    // The run's request is still pending and answerable.
    const req = sent.find((m) => m.data?.type === "permission_request")!;
    expect(bridge.resolvePermission(req.data.id, "allow")).toBe(true);
    await run;
    expect(fake.decisions).toEqual([{ behavior: "allow" }]);
  });

  test("an attached session's request goes to its own room and detach denies only that", async () => {
    const fake = makeFakeSdk();
    _setSdkModule(fake.sdk);
    const sent: Array<{ room: string; data: any }> = [];
    const bridge = new SdkBridge(silentLog(), (room, data) => sent.push({ room, data }));

    await bridge.attach("my-session", undefined, ".");
    const sending = bridge.send("hello");
    await fake.asked;
    const req = sent.find((m) => m.data?.type === "permission_request")!;
    expect(req.room).toBe("my-session");
    expect(req.data.room).toBe("my-session");
    expect(req.data.kind).toBe("session");

    await bridge.detach();
    await sending;
    expect(fake.decisions).toEqual([{ behavior: "deny", message: "Session detached" }]);
  });
});

describe("SdkBridge — pending requests survive a late subscriber", () => {
  test("a room's outstanding requests can be replayed, and leave once answered", async () => {
    // A request is broadcast once. A dashboard opened (or reconnected) after
    // that would never see it, and the run would wait out its 5-minute
    // timeout and be denied. The server replays these on subscribe.
    const fake = makeFakeSdk();
    _setSdkModule(fake.sdk);
    const sent: Array<{ room: string; data: any }> = [];
    const bridge = new SdkBridge(silentLog(), (room, data) => sent.push({ room, data }));

    const run = bridge.runStandaloneAgent("optimizer", { prompt: "p" }, ".", "go");
    await fake.asked;

    const pending = bridge.pendingRequestsFor("optimizer");
    expect(pending.length).toBe(1);
    const live = sent.find((m) => m.data?.type === "permission_request")!.data;
    // Same request — but `timeout_ms` is what is LEFT, so a late subscriber's
    // countdown is not reset to the full five minutes.
    const { timeout_ms: replayedLeft, ...replayed } = pending[0];
    const { timeout_ms: liveTotal, ...original } = live;
    expect(replayed).toEqual(original);
    expect(replayedLeft as number).toBeLessThanOrEqual(liveTotal as number);
    expect(replayedLeft as number).toBeGreaterThan(0);
    expect(bridge.pendingRequestsFor("other-room")).toEqual([]);

    bridge.resolvePermission(pending[0].id as string, "deny");
    await run;
    expect(bridge.pendingRequestsFor("optimizer")).toEqual([]);
  });
});

describe("SdkBridge — replayed requests carry the time left", () => {
  test("timeout_ms on a replay shrinks as the request ages", async () => {
    const fake = makeFakeSdk();
    _setSdkModule(fake.sdk);
    const bridge = new SdkBridge(silentLog(), () => {}, { permissionTimeoutMs: 10_000 });
    const run = bridge.runStandaloneAgent("optimizer", { prompt: "p" }, ".", "go");
    await fake.asked;
    await new Promise((r) => setTimeout(r, 120));
    const [req] = bridge.pendingRequestsFor("optimizer");
    expect(req.timeout_ms as number).toBeLessThanOrEqual(10_000 - 100);
    bridge.resolvePermission(req.id as string, "deny");
    await run;
  });
});
