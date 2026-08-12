/**
 * http-crash.test.ts — the daemon must survive hostile pre-auth packets.
 *
 * Two one-packet, no-token kills were reachable before any authentication
 * check ran, and neither call site sat inside a try block:
 *
 *   1. `GET / HTTP/1.1\r\nHost:\r\n\r\n` — an empty Host makes `new URL()`
 *      throw TypeError in `handleRequest`.
 *   2. `GET /ws` with `Cookie: operad_token=%` — `decodeURIComponent` throws
 *      URIError inside the `upgrade` listener.
 *
 * With no `uncaughtException` handler installed, either killed the process,
 * orphaning every managed session. These tests speak raw HTTP at a real
 * server so they exercise the transport, not just the helpers — a unit test
 * of `safeRequestUrl` alone would not have caught the upgrade path.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardServer } from "../http.js";

const TOKEN = "test-token-abcdef0123456789";
let server: DashboardServer;
let port = 0;
let staticDir: string;

/** A logger that stays quiet but still satisfies the interface. */
const silentLog = () =>
  ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  }) as any;

/** Speak one raw HTTP request and resolve with the reply (or "" if closed). */
function rawRequest(payload: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(payload);
    });
    let out = "";
    const done = () => { try { sock.destroy(); } catch { /* closed */ } resolve(out); };
    sock.on("data", (d) => { out += d.toString(); });
    sock.on("close", done);
    sock.on("error", done);
    setTimeout(done, timeoutMs);
  });
}

/** Is the server still answering a well-formed request? */
async function stillAlive(): Promise<boolean> {
  const reply = await rawRequest(
    `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`,
  );
  return reply.startsWith("HTTP/1.1");
}

beforeAll(async () => {
  staticDir = mkdtempSync(join(tmpdir(), "operad-http-crash-"));
  // Port 0 would be ideal but DashboardServer takes an explicit port; pick a
  // high one unlikely to collide with the real daemon on 18970.
  port = 19871 + Math.floor(process.hrtime()[1] % 300);
  server = new DashboardServer(
    port,
    staticDir,
    async () => ({ status: 200, data: { ok: true } }),
    silentLog(),
    { authToken: TOKEN },
  );
  await server.start();
});

afterAll(async () => {
  try { await server.stop(); } catch { /* already down */ }
  rmSync(staticDir, { recursive: true, force: true });
});

describe("malformed Host header does not kill the daemon", () => {
  const hostileHosts = ["", " ", "]", "a b", "%", "["];

  for (const host of hostileHosts) {
    test(`survives Host: ${JSON.stringify(host)}`, async () => {
      await rawRequest(`GET / HTTP/1.1\r\nHost:${host}\r\nConnection: close\r\n\r\n`);
      expect(await stillAlive()).toBe(true);
    });
  }

  test("survives a Host header omitted entirely (HTTP/1.0)", async () => {
    await rawRequest("GET / HTTP/1.0\r\n\r\n");
    expect(await stillAlive()).toBe(true);
  });
});

describe("malformed cookie on the WebSocket upgrade does not kill the daemon", () => {
  const hostileCookies = ["operad_token=%", "operad_token=%zz", "operad_token=%E0%A4%A", "other=%; operad_token=x"];

  for (const cookie of hostileCookies) {
    test(`survives Cookie: ${JSON.stringify(cookie)}`, async () => {
      await rawRequest(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\n"
        + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
        + `Cookie: ${cookie}\r\n\r\n`,
      );
      expect(await stillAlive()).toBe(true);
    });
  }

  test("survives a malformed Host AND cookie on the upgrade path together", async () => {
    await rawRequest(
      "GET /ws HTTP/1.1\r\nHost:\r\n"
      + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
      + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
      + "Cookie: operad_token=%\r\n\r\n",
    );
    expect(await stillAlive()).toBe(true);
  });
});

describe("the token handshake cannot be turned into an open redirect", () => {
  test("a protocol-relative path redirects to the root, not off-host", async () => {
    // `//evil.example.com/` as an absolute-form target made `url.pathname`
    // start with `//`, and `Location: //evil.example.com/` is a
    // protocol-relative URL the browser follows off-origin.
    const reply = await rawRequest(
      `GET //evil.example.com/?token=${TOKEN} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    );
    expect(reply).toContain("302");
    expect(reply.toLowerCase()).not.toContain("location: //evil.example.com");
    expect(reply.toLowerCase()).toContain("location: /");
  });

  test("an ordinary path still round-trips through the handshake", async () => {
    const reply = await rawRequest(
      `GET /memory?token=${TOKEN} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    );
    expect(reply).toContain("302");
    expect(reply.toLowerCase()).toContain("location: /memory");
    expect(reply.toLowerCase()).toContain("set-cookie: operad_token=");
  });
});

describe("auth is still enforced after the crash hardening", () => {
  test("no token is still 401", async () => {
    const reply = await rawRequest(
      "GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
    expect(reply).toContain("401");
  });

  test("a hostile Host does not become an auth bypass", async () => {
    const reply = await rawRequest(
      "GET /api/status HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n",
    );
    expect(reply).toContain("401");
  });

  test("an undecodable cookie does not become an auth bypass", async () => {
    const reply = await rawRequest(
      "GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: operad_token=%\r\nConnection: close\r\n\r\n",
    );
    expect(reply).toContain("401");
  });
});
