/**
 * auth.ts — dashboard access token.
 *
 * The dashboard API can start and kill processes, run scripts, install skills
 * (which clone and register executable tools), and write files that Claude Code
 * later executes as instructions. It previously had no authentication at all
 * and bound 0.0.0.0 with `Access-Control-Allow-Origin: *`, so every one of
 * those was reachable by any host on the network — and, via a browser the user
 * happened to be running, by any web page they visited.
 *
 * The model here is the one Jupyter uses, because it solves the bootstrap
 * problem without a login form:
 *
 *   1. A random token is generated once and stored 0600 on disk.
 *   2. The daemon prints `http://host:port/?token=…` at startup.
 *   3. Opening that URL exchanges the token for a `SameSite=Strict` cookie and
 *      redirects to a clean URL.
 *   4. Everything afterwards — XHR, EventSource, WebSocket — carries the
 *      cookie automatically, and `SameSite=Strict` means a cross-site page
 *      cannot make the browser send it.
 *
 * Programmatic callers can use `Authorization: Bearer <token>` instead.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Cookie name used for the browser session. */
export const AUTH_COOKIE = "operad_token";

/** Query parameter that exchanges a token for the cookie. */
export const AUTH_QUERY_PARAM = "token";

/**
 * Where the token lives. Kept out of operad.toml on purpose: configs get
 * pasted into issues and committed to dotfile repos, and a token in one is a
 * credential leak that is easy to miss.
 */
export function tokenPath(stateDir: string): string {
  return join(stateDir, "dashboard-token");
}

/** Generate a fresh 32-byte token as URL-safe hex. */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Load the token, creating it on first use.
 *
 * `OPERAD_DASHBOARD_TOKEN` overrides the file entirely, for containers and CI
 * where writing state is awkward.
 */
export function loadOrCreateToken(stateDir: string): string {
  const fromEnv = process.env.OPERAD_DASHBOARD_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const path = tokenPath(stateDir);
  if (existsSync(path)) {
    try {
      const existing = readFileSync(path, "utf-8").trim();
      if (existing) return existing;
    } catch {
      // Unreadable — fall through and regenerate.
    }
  }
  const token = generateToken();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${token}\n`, { encoding: "utf-8", mode: 0o600 });
    // writeFileSync's mode is only applied when the file is created, so an
    // existing world-readable file would keep its permissions.
    chmodSync(path, 0o600);
  } catch {
    // If we cannot persist it the token still works for this process; the URL
    // is printed at startup either way.
  }
  return token;
}

/**
 * Constant-time token comparison.
 *
 * Length is compared first and then a fixed-length digest comparison is used,
 * so neither the length nor the position of the first differing byte leaks
 * through timing.
 */
export function tokensMatch(a: string | undefined | null, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/**
 * Percent-decode a cookie value, tolerating garbage.
 *
 * A Cookie header is attacker-controlled and need not be valid
 * percent-encoding: `%`, `%zz` and a truncated `%E0%A4%A` all make
 * `decodeURIComponent` throw a URIError. That mattered because this runs
 * inside the WebSocket upgrade listener, which has no try/catch — so
 * `GET /ws` with `Cookie: operad_token=%` killed the whole daemon before any
 * auth check ran. An undecodable value is kept raw; it simply won't match a
 * valid token.
 *
 * Note this decodes EVERY cookie set for the host, including ones written by
 * unrelated apps on the same loopback address, so it must not be picky.
 */
function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parse a Cookie header into a plain object. Never throws. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeCookieValue(v);
  }
  return out;
}

/**
 * Extract a presented token from a request, in precedence order:
 * `Authorization: Bearer`, then the `token` query param, then the cookie.
 */
export function presentedToken(
  authorization: string | undefined,
  queryToken: string | null,
  cookieHeader: string | undefined,
): string | null {
  if (authorization) {
    const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (m) return m[1].trim();
  }
  if (queryToken) return queryToken;
  const cookies = parseCookies(cookieHeader);
  return cookies[AUTH_COOKIE] ?? null;
}

/** `Set-Cookie` value binding the browser session to the token. */
export function buildAuthCookie(token: string, secure: boolean): string {
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    // Strict is what makes this CSRF-resistant: a cross-site page cannot cause
    // the browser to attach this cookie to a request at all.
    "SameSite=Strict",
    "Max-Age=31536000",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
