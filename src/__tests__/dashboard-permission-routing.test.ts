/**
 * dashboard-permission-routing.test.ts — which dashboard view answers an SDK
 * permission request, and how outstanding agent requests are queued.
 *
 * Two views take these requests: the conversation drawer (an attached
 * session) and a global watcher (standalone agent runs: OODA, scheduled,
 * manual). Both kinds of room are bare names that can collide, so requests
 * carry `kind` and `room`, and each view takes only its own. The watcher
 * may receive one request twice — live, then again as a replay when the
 * socket reconnects and re-subscribes — so its queue de-duplicates by id.
 *
 * The logic lives in a plain TS module in the dashboard so it is testable
 * here without a Svelte runtime.
 */

import { describe, test, expect } from "bun:test";
import {
  isAgentPermissionRequest,
  isSessionPermissionFor,
  agentRoomsToWatch,
  PermissionQueue,
} from "../../dashboard/src/lib/permission-routing.js";

const req = (over: Record<string, unknown> = {}) => ({
  type: "permission_request" as const, id: "perm_1", tool: "Bash", input: {}, timeout_ms: 300_000, ...over,
});

describe("routing", () => {
  test("an agent run's request goes to the watcher, not the drawer", () => {
    const r = req({ kind: "agent", room: "optimizer" });
    expect(isAgentPermissionRequest(r)).toBe(true);
    expect(isSessionPermissionFor(r, "optimizer")).toBe(false);
  });

  test("a session's request goes to that session's drawer only", () => {
    const r = req({ kind: "session", room: "my-session" });
    expect(isAgentPermissionRequest(r)).toBe(false);
    expect(isSessionPermissionFor(r, "my-session")).toBe(true);
    expect(isSessionPermissionFor(r, "other")).toBe(false);
  });

  test("a request from an older daemon (no kind/room) stays with the drawer", () => {
    const r = req();
    expect(isAgentPermissionRequest(r)).toBe(false);
    expect(isSessionPermissionFor(r, "my-session")).toBe(true);
  });

  test("only enabled agents' rooms are watched", () => {
    expect(agentRoomsToWatch([
      { name: "optimizer", enabled: true },
      { name: "ideator", enabled: false },
      { name: "master-controller", enabled: true },
    ])).toEqual(["optimizer", "master-controller"]);
  });
});

describe("PermissionQueue", () => {
  test("shows requests one at a time, oldest first", () => {
    const q = new PermissionQueue();
    q.add(req({ id: "a", kind: "agent", room: "x" }));
    q.add(req({ id: "b", kind: "agent", room: "y" }));
    expect(q.current?.id).toBe("a");
    q.remove("a");
    expect(q.current?.id).toBe("b");
    q.remove("b");
    expect(q.current).toBeNull();
  });

  test("a replayed request already queued is not shown twice", () => {
    const q = new PermissionQueue();
    q.add(req({ id: "a", kind: "agent", room: "x" }));
    q.add(req({ id: "a", kind: "agent", room: "x" }));
    expect(q.size).toBe(1);
  });

  test("a request answered here is not re-queued by a late replay", () => {
    // Answered, then the socket reconnects before the server has settled
    // it: the replay must not pop the same prompt up again.
    const q = new PermissionQueue();
    q.add(req({ id: "a", kind: "agent", room: "x" }));
    q.remove("a");
    q.add(req({ id: "a", kind: "agent", room: "x" }));
    expect(q.current).toBeNull();
  });
});
