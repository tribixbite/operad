/**
 * auth.test.ts — dashboard access token.
 *
 * The API can start and kill processes, run scripts and install skills, and it
 * previously had no authentication while bound to 0.0.0.0 with a wildcard CORS
 * origin. These tests pin the pieces that make the replacement safe: constant
 * -time comparison, cookie parsing that cannot be tricked, the precedence order
 * between header/query/cookie, and the SameSite attribute that makes the cookie
 * CSRF-resistant.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_COOKIE,
  buildAuthCookie,
  generateToken,
  loadOrCreateToken,
  parseCookies,
  presentedToken,
  tokenPath,
  tokensMatch,
} from "../auth.js";

describe("generateToken", () => {
  test("produces 64 hex characters (32 bytes)", () => {
    const t = generateToken();
    expect(t).toMatch(/^[a-f0-9]{64}$/);
  });

  test("is different every call", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(seen.size).toBe(50);
  });
});

describe("tokensMatch", () => {
  const good = "a".repeat(64);

  test("matches an identical token", () => {
    expect(tokensMatch(good, good)).toBe(true);
  });

  test("rejects a different token of the same length", () => {
    expect(tokensMatch("b".repeat(64), good)).toBe(false);
  });

  test("rejects a differing-length token without throwing", () => {
    // timingSafeEqual throws on length mismatch; the guard must catch that.
    expect(tokensMatch("short", good)).toBe(false);
    expect(tokensMatch("a".repeat(65), good)).toBe(false);
  });

  test("rejects empty, null and undefined", () => {
    expect(tokensMatch("", good)).toBe(false);
    expect(tokensMatch(null, good)).toBe(false);
    expect(tokensMatch(undefined, good)).toBe(false);
  });

  test("rejects when the expected token is empty (unconfigured)", () => {
    expect(tokensMatch(good, "")).toBe(false);
  });

  test("a prefix of the real token does not match", () => {
    expect(tokensMatch(good.slice(0, 32), good)).toBe(false);
  });
});

describe("parseCookies", () => {
  test("parses a single cookie", () => {
    expect(parseCookies("a=1")).toEqual({ a: "1" });
  });

  test("parses multiple cookies with spaces", () => {
    expect(parseCookies("a=1; b=2;c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  test("URL-decodes values", () => {
    expect(parseCookies("p=%2Ffoo%20bar")).toEqual({ p: "/foo bar" });
  });

  test("keeps '=' inside a value", () => {
    expect(parseCookies("t=abc=def")).toEqual({ t: "abc=def" });
  });

  test("ignores malformed segments and empty headers", () => {
    expect(parseCookies("novalue; a=1")).toEqual({ a: "1" });
    expect(parseCookies("")).toEqual({});
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("presentedToken — precedence", () => {
  test("Authorization: Bearer wins over query and cookie", () => {
    const got = presentedToken("Bearer HEADER", "QUERY", `${AUTH_COOKIE}=COOKIE`);
    expect(got).toBe("HEADER");
  });

  test("query wins over cookie when no header", () => {
    expect(presentedToken(undefined, "QUERY", `${AUTH_COOKIE}=COOKIE`)).toBe("QUERY");
  });

  test("falls back to the cookie", () => {
    expect(presentedToken(undefined, null, `${AUTH_COOKIE}=COOKIE`)).toBe("COOKIE");
  });

  test("returns null when nothing is presented", () => {
    expect(presentedToken(undefined, null, undefined)).toBeNull();
  });

  test("bearer parsing is case-insensitive and tolerates extra whitespace", () => {
    expect(presentedToken("bearer   TOK  ", null, undefined)).toBe("TOK");
    expect(presentedToken("BEARER TOK", null, undefined)).toBe("TOK");
  });

  test("a non-Bearer Authorization scheme falls through rather than matching", () => {
    // Basic auth must not be mistaken for a token.
    expect(presentedToken("Basic dXNlcjpwYXNz", null, undefined)).toBeNull();
  });

  test("an unrelated cookie is not treated as the token", () => {
    expect(presentedToken(undefined, null, "other=value")).toBeNull();
  });
});

describe("buildAuthCookie", () => {
  test("is HttpOnly and SameSite=Strict", () => {
    const c = buildAuthCookie("tok", false);
    expect(c).toContain("HttpOnly");
    // Strict is what stops a cross-site page from causing the browser to
    // attach this cookie — the CSRF defence for every state-changing route.
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
  });

  test("omits Secure over plain http and adds it when asked", () => {
    expect(buildAuthCookie("tok", false)).not.toContain("Secure");
    expect(buildAuthCookie("tok", true)).toContain("Secure");
  });

  test("URL-encodes the value", () => {
    expect(buildAuthCookie("a b", false)).toContain(`${AUTH_COOKIE}=a%20b`);
  });
});

describe("loadOrCreateToken", () => {
  let dir: string;
  const savedEnv = process.env.OPERAD_DASHBOARD_TOKEN;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "operad-auth-"));
    delete process.env.OPERAD_DASHBOARD_TOKEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.OPERAD_DASHBOARD_TOKEN;
    else process.env.OPERAD_DASHBOARD_TOKEN = savedEnv;
  });

  test("creates a token file on first use", () => {
    const t = loadOrCreateToken(dir);
    expect(t).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(tokenPath(dir), "utf-8").trim()).toBe(t);
  });

  test("the token file is owner-only (0600)", () => {
    loadOrCreateToken(dir);
    const mode = statSync(tokenPath(dir)).mode & 0o777;
    // Windows does not implement POSIX modes; skip the assertion there.
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  test("is stable across calls", () => {
    expect(loadOrCreateToken(dir)).toBe(loadOrCreateToken(dir));
  });

  test("regenerates when the stored file is empty", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tokenPath(dir), "   \n");
    expect(loadOrCreateToken(dir)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("OPERAD_DASHBOARD_TOKEN overrides the file and writes nothing", () => {
    process.env.OPERAD_DASHBOARD_TOKEN = "from-env";
    expect(loadOrCreateToken(dir)).toBe("from-env");
  });

  test("a token with surrounding whitespace on disk is trimmed", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tokenPath(dir), "  padded-token  \n");
    expect(loadOrCreateToken(dir)).toBe("padded-token");
  });
});
