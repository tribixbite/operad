/**
 * dashboard-room-refs.test.ts — WebSocket room subscriptions are shared by
 * every component on the page, so they are reference-counted.
 *
 * The dashboard's ws layer kept a plain set of rooms: when two components
 * joined the same room (the conversation drawer for a session, and the
 * agent-permission watcher for an agent that happens to share its name),
 * the first to leave unsubscribed the other too. Only the last holder may
 * send `unsubscribe`, and only the first sends `subscribe`.
 */

import { describe, test, expect } from "bun:test";
import { RoomRefs } from "../../dashboard/src/lib/room-refs.js";

describe("RoomRefs", () => {
  test("only the first join subscribes and only the last leave unsubscribes", () => {
    const r = new RoomRefs();
    expect(r.join("a")).toBe(true);
    expect(r.join("a")).toBe(false);
    expect(r.leave("a")).toBe(false);
    expect([...r.rooms()]).toEqual(["a"]);
    expect(r.leave("a")).toBe(true);
    expect([...r.rooms()]).toEqual([]);
  });

  test("leaving a room never joined is a no-op", () => {
    const r = new RoomRefs();
    expect(r.leave("ghost")).toBe(false);
    expect([...r.rooms()]).toEqual([]);
  });
});
