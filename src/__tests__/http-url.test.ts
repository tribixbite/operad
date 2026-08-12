/**
 * http-url.test.ts — request-URL parsing must never throw.
 *
 * `new URL(target, `http://${req.headers.host}`)` was evaluated at the top of
 * both `handleRequest` and the `upgrade` listener, outside any try block.
 * Node's HTTP parser accepts Host values that the WHATWG URL parser rejects,
 * and the process installed no `uncaughtException` handler, so
 *
 *   GET / HTTP/1.1\r\nHost:\r\n\r\n
 *
 * — one packet, no token, evaluated before the auth check — killed the daemon
 * and orphaned every managed session.
 */

import { describe, test, expect } from "bun:test";
import { safeRequestUrl } from "../http.js";

describe("safeRequestUrl", () => {
  // Each of these makes `new URL("/", `http://${host}`)` throw.
  const hostileHosts = ["", " ", "]", "a b", "%", "::1:x:", "[", "host:port", "\t"];

  for (const host of hostileHosts) {
    test(`does not throw on Host: ${JSON.stringify(host)}`, () => {
      expect(() => safeRequestUrl("/", host)).not.toThrow();
    });

    test(`still routes correctly with Host: ${JSON.stringify(host)}`, () => {
      // Routing only ever reads pathname and searchParams, so an unusable
      // authority must not cost us the path.
      const url = safeRequestUrl("/api/status?limit=5", host);
      expect(url.pathname).toBe("/api/status");
      expect(url.searchParams.get("limit")).toBe("5");
    });
  }

  test("a usable Host is honoured", () => {
    const url = safeRequestUrl("/api/status", "127.0.0.1:18970");
    expect(url.host).toBe("127.0.0.1:18970");
    expect(url.pathname).toBe("/api/status");
  });

  test("a missing Host falls back without throwing", () => {
    expect(safeRequestUrl("/api/status", undefined).pathname).toBe("/api/status");
  });

  test("a missing request target routes to /", () => {
    expect(safeRequestUrl(undefined, "127.0.0.1").pathname).toBe("/");
    expect(safeRequestUrl("", "127.0.0.1").pathname).toBe("/");
  });

  test("a malformed target with a malformed Host still yields a usable URL", () => {
    // Both inputs unusable — the last resort must not throw either.
    expect(() => safeRequestUrl("http://", "")).not.toThrow();
    expect(safeRequestUrl("http://", "").pathname).toBe("/");
  });

  test("the query token survives a hostile Host", () => {
    // The handshake reads the token off searchParams; losing it would turn a
    // malformed Host into an auth failure rather than just a routing detail.
    const url = safeRequestUrl("/?token=abc", "]");
    expect(url.searchParams.get("token")).toBe("abc");
  });

  test("an absolute-form target keeps a pathname the redirect guard can inspect", () => {
    // `GET //evil.example.com/` is what produced the open redirect; the
    // handshake refuses to emit a Location whose path starts with `//`.
    expect(safeRequestUrl("//evil.example.com/", "127.0.0.1").pathname)
      .toStartWith("/");
  });
});
