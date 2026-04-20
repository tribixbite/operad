/**
 * ipc-fuzz.test.ts — Fuzz/property tests for the IpcServer newline-delimited JSON parser.
 *
 * Verifies that malformed, partial, binary, or oversized input does not crash or
 * wedge the daemon. Each test spins up a shared IpcServer on a tmp Unix socket with a
 * stub handler, then sends raw bytes and asserts correctness or graceful failure.
 *
 * Design notes:
 * - Tests collect responses by counting newlines, NOT by calling conn.end() before
 *   receiving. On Bun, conn.end() immediately triggers the 'close' event before the
 *   server's async handler has had a chance to write a response.
 * - Buffer limit: IpcServer enforces a 1 MB cap. Sending 1 MB + 1 byte without a
 *   newline causes the server to call conn.destroy() — verified at ~12ms in practice.
 * - We use 1 MB + 1 byte (not 2 MB) to avoid TCP send-buffer delays that can prevent
 *   the 'close' event from arriving within a reasonable test timeout.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as net from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcServer } from "../ipc.js";
import type { IpcCommand, IpcResponse } from "../types.js";
import type { Logger } from "../log.js";

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `ipc-fuzz-${Date.now()}`);
const SOCK_PATH = join(TEST_DIR, "fuzz.sock");

/** How many commands the stub handler has been called with in this test */
let dispatchCount = 0;
/** Last command seen by the stub handler */
let lastCmd: IpcCommand | null = null;

/** Stub IPC handler — counts dispatches and echoes the command back */
async function stubHandler(cmd: IpcCommand): Promise<IpcResponse> {
  dispatchCount++;
  lastCmd = cmd;
  return { ok: true, data: { echo: cmd } };
}

/**
 * Minimal silent logger stub. IpcServer only uses these four methods
 * (debug/info/warn/error) — no disk I/O needed for tests.
 */
const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  setVerbose: () => {},
} as unknown as Logger;

let server: IpcServer;

beforeAll(async () => {
  mkdirSync(TEST_DIR, { recursive: true });
  server = new IpcServer(SOCK_PATH, stubHandler, silentLog);
  await server.start();
});

afterAll(() => {
  server.stop();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset dispatch counter/lastCmd before each scenario that tracks call count */
function resetCounter() {
  dispatchCount = 0;
  lastCmd = null;
}

/**
 * Open a raw socket to SOCK_PATH, write `payload`, then wait until `expectedLines`
 * newline-delimited response lines arrive OR `timeoutMs` elapses. Returns raw response
 * string without closing the socket on the client side (avoids Bun's early-close quirk).
 */
function sendAndCollect(
  payload: Buffer | string,
  expectedLines: number,
  timeoutMs = 3000
): Promise<string> {
  return new Promise((resolve) => {
    const conn = net.createConnection(SOCK_PATH);
    let received = "";
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(received);
    };

    const timer = setTimeout(finish, timeoutMs);

    conn.on("connect", () => {
      conn.write(payload);
    });

    conn.on("data", (chunk) => {
      received += chunk.toString();
      // Count complete lines — resolve early if we have enough
      const lines = received.split("\n").filter(Boolean);
      if (lines.length >= expectedLines) finish();
    });

    conn.on("close", finish);
    conn.on("error", finish);
  });
}

/** Parse all newline-delimited JSON responses from a raw string */
function parseResponses(raw: string): IpcResponse[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as IpcResponse;
      } catch {
        return { ok: false, error: `unparseable: ${line}` } as IpcResponse;
      }
    });
}

/**
 * Probe whether the server is still accepting new connections.
 * Returns true if a new connection succeeds within 1 second.
 */
function serverIsAlive(timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(SOCK_PATH);
    probe.on("connect", () => { probe.destroy(); resolve(true); });
    probe.on("error", () => resolve(false));
    setTimeout(() => { probe.destroy(); resolve(false); }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Fuzz scenarios
// ---------------------------------------------------------------------------

describe("IpcServer fuzz: newline-delimited JSON parser", () => {

  // 1. Valid single command — baseline
  test("valid single command is dispatched and returns ok", async () => {
    resetCounter();
    const raw = await sendAndCollect('{"cmd":"status"}\n', 1);
    const responses = parseResponses(raw);
    expect(responses).toHaveLength(1);
    expect(responses[0].ok).toBe(true);
    expect(dispatchCount).toBe(1);
  });

  // 2. Multiple concatenated messages in one write
  test("two concatenated messages → 2 dispatches, 2 responses", async () => {
    resetCounter();
    const raw = await sendAndCollect('{"cmd":"status"}\n{"cmd":"status"}\n', 2);
    const responses = parseResponses(raw);
    expect(responses).toHaveLength(2);
    for (const r of responses) expect(r.ok).toBe(true);
    expect(dispatchCount).toBe(2);
  });

  // 3. Partial JSON flushed in two writes → 1 dispatch total
  test("partial JSON flushed in two writes becomes one dispatch", async () => {
    resetCounter();
    const raw = await new Promise<string>((resolve) => {
      const conn = net.createConnection(SOCK_PATH);
      let received = "";
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        conn.destroy();
        resolve(received);
      };
      const timer = setTimeout(finish, 3000);

      conn.on("connect", () => {
        // First half — no newline, server must buffer
        conn.write('{"cmd":"sta');
        // Flush second half after a brief pause; together they form valid JSON
        setTimeout(() => conn.write('tus"}\n'), 50);
      });

      conn.on("data", (chunk) => {
        received += chunk.toString();
        const lines = received.split("\n").filter(Boolean);
        if (lines.length >= 1) finish();
      });
      conn.on("close", finish);
      conn.on("error", finish);
    });

    const responses = parseResponses(raw);
    expect(responses).toHaveLength(1);
    expect(responses[0].ok).toBe(true);
    expect(dispatchCount).toBe(1);
  });

  // 4. Invalid JSON → error response, connection remains usable
  test("invalid JSON returns error response without crashing", async () => {
    resetCounter();
    const raw = await sendAndCollect("{not json}\n", 1);
    const responses = parseResponses(raw);
    expect(responses).toHaveLength(1);
    expect(responses[0].ok).toBe(false);
    expect(responses[0].error).toMatch(/json/i);
    // Server must still be alive after handling the bad input
    expect(await serverIsAlive()).toBe(true);
  });

  // 5. Empty lines → silently ignored; only the valid command triggers a response
  test("empty lines are ignored, valid command after blanks is dispatched", async () => {
    resetCounter();
    const raw = await sendAndCollect('\n\n\n{"cmd":"status"}\n', 1);
    const responses = parseResponses(raw);
    // Empty lines produce no responses; only the valid command does
    expect(responses).toHaveLength(1);
    expect(responses[0].ok).toBe(true);
    expect(dispatchCount).toBe(1);
  });

  // 6. Binary garbage ending with \n → JSON parse error, server survives
  test("binary garbage does not crash the server", async () => {
    resetCounter();
    // Ends with 0x0a (\n) so the server sees it as a complete (garbage) line
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x0a]);
    const raw = await sendAndCollect(garbage, 1);
    const responses = parseResponses(raw);
    // Server should return a JSON parse error (not crash)
    expect(responses).toHaveLength(1);
    expect(responses[0].ok).toBe(false);
    // The daemon must still be accepting connections
    expect(await serverIsAlive()).toBe(true);
  });

  // 7. Payload just above the 1 MB cap without a trailing newline
  //    → server must call conn.destroy() (connection dropped), daemon unaffected.
  test("1 MB + 1 byte payload without newline triggers buffer cap and drops connection", async () => {
    resetCounter();
    // 1 byte over the MAX_IPC_BUFFER_SIZE = 1 * 1024 * 1024 limit
    const oversized = Buffer.alloc(1 * 1024 * 1024 + 1, "x");

    const connectionDropped = await new Promise<boolean>((resolve) => {
      const conn = net.createConnection(SOCK_PATH);
      let closed = false;

      conn.on("connect", () => conn.write(oversized));
      conn.on("close", () => { if (!closed) { closed = true; resolve(true); } });
      conn.on("error", () => { if (!closed) { closed = true; resolve(true); } });
      // 5 s safety valve — if neither fires, cap isn't working
      setTimeout(() => { if (!closed) { closed = true; conn.destroy(); resolve(false); } }, 5000);
    });

    expect(connectionDropped).toBe(true);

    // Server must still accept new connections after dropping the bad one
    expect(await serverIsAlive()).toBe(true);
  });

  // 8. Valid command followed by garbage on the next line
  //    Note: concurrent async dispatch means response order is not guaranteed —
  //    the JSON parse error (synchronous) may arrive before the handler response.
  test("valid command followed by garbage line: one ok, one error, one dispatch", async () => {
    resetCounter();
    const raw = await sendAndCollect('{"cmd":"status"}\nGARBAGE\n', 2);
    const responses = parseResponses(raw);
    expect(responses).toHaveLength(2);
    // Exactly one success and one JSON parse error (order not guaranteed)
    const okCount = responses.filter((r) => r.ok).length;
    const errCount = responses.filter((r) => !r.ok).length;
    expect(okCount).toBe(1);
    expect(errCount).toBe(1);
    const errResp = responses.find((r) => !r.ok)!;
    expect(errResp.error).toMatch(/json/i);
    // Only the valid command should have hit the handler
    expect(dispatchCount).toBe(1);
  });

  // 9. Unicode + control chars in a valid JSON string → no crash
  test("unicode and control chars in payload do not crash the parser", async () => {
    resetCounter();
    // \u0000 (null byte) and ANSI escape sequence embedded in a JSON string value
    const payload = '{"cmd":"status","arg":"\\u0000\\u001b[31m"}\n';
    const raw = await sendAndCollect(payload, 1);
    const responses = parseResponses(raw);
    expect(responses).toHaveLength(1);
    expect(responses[0].ok).toBe(true);
    expect(dispatchCount).toBe(1);
  });

  // 10. Burst of 20 rapid commands in one write — all dispatched and responded to
  test("20 rapid valid commands all dispatched and responded to", async () => {
    resetCounter();
    const count = 20;
    const burst = Array.from({ length: count }, () => '{"cmd":"status"}').join("\n") + "\n";
    const raw = await sendAndCollect(burst, count, 5000);
    const responses = parseResponses(raw);
    expect(responses).toHaveLength(count);
    for (const r of responses) expect(r.ok).toBe(true);
    expect(dispatchCount).toBe(count);
  });
});
