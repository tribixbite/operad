/**
 * http-body-limits.test.ts — the 413 / 408 body-read failures must reach the
 * client as JSON, not as a connection reset.
 *
 * handleApi used to call `req.destroy()` the moment the body crossed 1 MB (or
 * the read timed out) and only then `writeHead(413/408)`. Destroying the
 * request destroys the shared socket, so the response was written into a dead
 * socket and the client saw ECONNRESET / an empty reply instead of the
 * `{ error }` body the API documents. These tests speak raw HTTP at a real
 * in-process server on an ephemeral port so the transport itself is covered.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardServer } from "../http.js";

const TOKEN = "test-token-body-limits-0123456789";
/** Short read timeout so the 408 path runs in well under the test timeout. */
const BODY_TIMEOUT_MS = 300;

let server: DashboardServer;
let port = 0;
let staticDir: string;
let apiCalls = 0;

const silentLog = () =>
  ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) as any;

/**
 * Open a socket, write `head`, then stream `bodyBytes` of filler in 64 KB
 * chunks (stopping quietly if the server closes first). Resolves with
 * everything the server sent back, or the socket error code.
 */
function sendRequest(
  head: string,
  bodyBytes: number,
  timeoutMs = 5000,
): Promise<{ reply: string; error: string | null }> {
  return new Promise((resolve) => {
    let reply = "";
    let error: string | null = null;
    let settled = false;
    const sock = net.createConnection({ host: "127.0.0.1", port });
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* closed */ }
      resolve({ reply, error });
    };
    sock.on("data", (d) => { reply += d.toString(); });
    sock.on("error", (err: NodeJS.ErrnoException) => { error = err.code ?? String(err); finish(); });
    sock.on("close", finish);
    setTimeout(finish, timeoutMs);
    sock.on("connect", async () => {
      sock.write(head);
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      while (sent < bodyBytes && !sock.destroyed && !settled) {
        const n = Math.min(chunk.length, bodyBytes - sent);
        const ok = sock.write(chunk.subarray(0, n));
        sent += n;
        if (!ok) await new Promise<void>((r) => sock.once("drain", () => r()));
      }
    });
  });
}

beforeAll(async () => {
  staticDir = mkdtempSync(join(tmpdir(), "operad-http-body-"));
  port = 20271 + Math.floor(process.hrtime()[1] % 300);
  server = new DashboardServer(
    port,
    staticDir,
    async () => { apiCalls++; return { status: 200, data: { ok: true } }; },
    silentLog(),
    { authToken: TOKEN, bodyTimeoutMs: BODY_TIMEOUT_MS },
  );
  await server.start();
});

afterAll(async () => {
  try { await server.stop(); } catch { /* already down */ }
  rmSync(staticDir, { recursive: true, force: true });
});

describe("oversized request body", () => {
  test("answers 413 with a JSON error body instead of resetting the connection", async () => {
    const bodyBytes = 2 * 1024 * 1024;
    const before = apiCalls;
    const { reply } = await sendRequest(
      `POST /api/anything HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n`
      + `Content-Type: application/json\r\nContent-Length: ${bodyBytes}\r\n\r\n`,
      bodyBytes,
    );
    expect(reply.startsWith("HTTP/1.1 413")).toBe(true);
    expect(reply.toLowerCase()).toContain("connection: close");
    expect(reply).toContain('{"error":"Payload too large"}');
    // The handler never ran on a truncated body.
    expect(apiCalls).toBe(before);
  });

  test("a body under the limit still reaches the handler", async () => {
    const before = apiCalls;
    const { reply } = await sendRequest(
      `POST /api/anything HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n`
      + "Content-Length: 2\r\nConnection: close\r\n\r\n{}",
      0,
    );
    expect(reply.startsWith("HTTP/1.1 200")).toBe(true);
    expect(apiCalls).toBe(before + 1);
  });
});

describe("stalled request body", () => {
  test("answers 408 with a JSON error body once the read times out", async () => {
    const { reply } = await sendRequest(
      `POST /api/anything HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n`
      + "Content-Length: 100\r\n\r\n{\"partial\":",
      0,
      BODY_TIMEOUT_MS + 3000,
    );
    expect(reply.startsWith("HTTP/1.1 408")).toBe(true);
    expect(reply).toContain('{"error":"Request body timeout"}');
  });
});
