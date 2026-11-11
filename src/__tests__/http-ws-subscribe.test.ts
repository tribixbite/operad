/**
 * http-ws-subscribe.test.ts — what a WebSocket client receives when it
 * subscribes to a room.
 *
 * Permission requests from an agent run are broadcast once, to the run's
 * room. A dashboard that subscribes after that — opened mid-run, or
 * reconnected after a network blip — must still be sent them, or the run
 * waits out its timeout and is denied with nobody having been asked. The
 * server asks an `onSubscribe` hook for anything outstanding in the room
 * and sends it right after the `subscribed` acknowledgement.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { DashboardServer } from "../http.js";

const TOKEN = "test-token-ws-subscribe-0123456789";

let server: DashboardServer;
let port = 0;
let staticDir: string;

const silentLog = () =>
  ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) as any;

/** Pending payloads the hook reports, by room. */
const pendingByRoom: Record<string, Array<Record<string, unknown>>> = {
  optimizer: [{ type: "permission_request", id: "perm_1", room: "optimizer", kind: "agent" }],
};

beforeAll(async () => {
  staticDir = mkdtempSync(join(tmpdir(), "operad-ws-sub-"));
  port = 20651 + Math.floor(process.hrtime()[1] % 300);
  server = new DashboardServer(
    port,
    staticDir,
    async () => ({ status: 200, data: {} }),
    silentLog(),
    { authToken: TOKEN, onSubscribe: (room: string) => pendingByRoom[room] ?? [] },
  );
  await server.start();
});

afterAll(async () => {
  try { await server.stop(); } catch { /* already down */ }
  rmSync(staticDir, { recursive: true, force: true });
});

/** Connect, subscribe to `room`, and collect messages for a short while. */
function subscribeAndCollect(room: string, ms = 400): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const got: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", sessionName: room })));
    ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
    setTimeout(() => { ws.close(); resolve(got); }, ms);
  });
}

describe("WS subscribe", () => {
  test("a late subscriber is sent the room's outstanding permission requests", async () => {
    // `connected` is the server's greeting on every new socket.
    const got = await subscribeAndCollect("optimizer");
    expect(got.map((m) => m.type)).toEqual(["connected", "subscribed", "permission_request"]);
    expect(got[2]).toEqual(pendingByRoom.optimizer[0]);
  });

  test("a room with nothing outstanding only gets the acknowledgement", async () => {
    const got = await subscribeAndCollect("quiet-room");
    expect(got.map((m) => m.type)).toEqual(["connected", "subscribed"]);
  });
});
