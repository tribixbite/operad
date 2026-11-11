/**
 * conversation-pin.test.ts — deciding when to record which conversation a
 * running agy / Codex session is on (see ConversationPinner).
 *
 * The monitoring poll runs every few seconds; the locators read another
 * tool's index, so the pinner throttles lookups, and it only claims a
 * conversation written after the agent was first seen in the pane.
 */

import { describe, test, expect } from "bun:test";
import { ConversationPinner, PIN_SINCE_SLACK_MS } from "../conversation-pin.js";

/** A runtime whose locator returns `answer` and records what it was asked. */
function fakeRuntime(answer: string | null) {
  const calls: Array<{ path: string; since: number }> = [];
  return {
    calls,
    runtime: {
      latestConversationId: (path: string, since: number) => {
        calls.push({ path, since });
        return answer;
      },
    },
  };
}

describe("ConversationPinner", () => {
  test("records the located conversation when it differs from the current pin", () => {
    let now = 1_000_000;
    const pin = new ConversationPinner(() => now, 60_000);
    const { runtime, calls } = fakeRuntime("conv-1");
    expect(pin.observe("s", runtime, "/p", undefined)).toBe("conv-1");
    // Only conversations written since (first seen − slack) are this run's.
    expect(calls[0]).toEqual({ path: "/p", since: 1_000_000 - PIN_SINCE_SLACK_MS });
  });

  test("an unchanged pin is not re-recorded", () => {
    const pin = new ConversationPinner(() => 0, 0);
    const { runtime } = fakeRuntime("conv-1");
    expect(pin.observe("s", runtime, "/p", "conv-1")).toBeNull();
  });

  test("lookups are throttled per session", () => {
    let now = 0;
    const pin = new ConversationPinner(() => now, 60_000);
    const { runtime, calls } = fakeRuntime(null);
    pin.observe("s", runtime, "/p", undefined);
    now = 30_000;
    pin.observe("s", runtime, "/p", undefined);
    expect(calls.length).toBe(1);
    now = 60_000;
    pin.observe("s", runtime, "/p", undefined);
    expect(calls.length).toBe(2);
  });

  test("the since-time stays anchored to when the agent was first seen", () => {
    let now = 10_000;
    const pin = new ConversationPinner(() => now, 0);
    const { runtime, calls } = fakeRuntime(null);
    pin.observe("s", runtime, "/p", undefined);
    now = 500_000;
    pin.observe("s", runtime, "/p", undefined);
    expect(calls[1].since).toBe(10_000 - PIN_SINCE_SLACK_MS);
  });

  test("when the agent stops, the next run is a new anchor", () => {
    let now = 10_000;
    const pin = new ConversationPinner(() => now, 0);
    const { runtime, calls } = fakeRuntime(null);
    pin.observe("s", runtime, "/p", undefined);
    now = 20_000;
    pin.observe("s", null, "/p", undefined); // pane is back at a shell
    now = 90_000;
    pin.observe("s", runtime, "/p", undefined);
    expect(calls.map((c) => c.since)).toEqual([10_000 - PIN_SINCE_SLACK_MS, 90_000 - PIN_SINCE_SLACK_MS]);
  });

  test("runtimes without a locator, or sessions without a path, are skipped", () => {
    const pin = new ConversationPinner(() => 0, 0);
    expect(pin.observe("s", {}, "/p", undefined)).toBeNull();
    const { runtime, calls } = fakeRuntime("x");
    expect(pin.observe("s", runtime, undefined, undefined)).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("forget drops a session's state", () => {
    let now = 0;
    const pin = new ConversationPinner(() => now, 60_000);
    const { runtime, calls } = fakeRuntime(null);
    pin.observe("s", runtime, "/p", undefined);
    pin.forget("s");
    now = 1;
    pin.observe("s", runtime, "/p", undefined);
    expect(calls.length).toBe(2);
    expect(calls[1].since).toBe(1 - PIN_SINCE_SLACK_MS);
  });
});
