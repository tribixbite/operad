import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, mkdtempSync } from "node:fs";
import { resolveSessionName, resolveSessionPath } from "../session-resolver.js";
import { Registry } from "../registry.js";
import type { TmxConfig, SessionConfig } from "../types.js";

function makeSession(name: string, overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    name,
    type: "service",
    command: "sleep 3600",
    path: undefined,
    session_id: undefined,
    auto_go: false,
    priority: 10,
    depends_on: [],
    headless: false,
    env: {},
    health: undefined,
    max_restarts: 3,
    restart_backoff_s: 5,
    enabled: true,
    bare: false,
    args: undefined,
    ...overrides,
  } as SessionConfig;
}

function makeConfig(sessions: SessionConfig[]): TmxConfig {
  return { sessions } as TmxConfig;
}

let tmpDir: string;
let registry: Registry;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-resolver-test-"));
  registry = new Registry(join(tmpDir, "registry.json"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("resolveSessionName", () => {
  test("returns null when no config and no registry", () => {
    expect(resolveSessionName(makeConfig([]), registry, "foo")).toBeNull();
  });

  test("exact match against config session", () => {
    const cfg = makeConfig([makeSession("alpha"), makeSession("beta")]);
    expect(resolveSessionName(cfg, registry, "alpha")).toBe("alpha");
    expect(resolveSessionName(cfg, registry, "beta")).toBe("beta");
  });

  test("unique prefix match", () => {
    const cfg = makeConfig([makeSession("alpha"), makeSession("beta")]);
    expect(resolveSessionName(cfg, registry, "alp")).toBe("alpha");
    expect(resolveSessionName(cfg, registry, "b")).toBe("beta");
  });

  test("ambiguous prefix returns null", () => {
    const cfg = makeConfig([makeSession("alpha-1"), makeSession("alpha-2")]);
    expect(resolveSessionName(cfg, registry, "alpha")).toBeNull();
  });

  test("substring match when prefix is ambiguous", () => {
    // "server" is NOT a prefix of either, but IS a substring of only "my-server-app"
    const cfg = makeConfig([makeSession("my-server-app"), makeSession("client")]);
    expect(resolveSessionName(cfg, registry, "server")).toBe("my-server-app");
  });

  test("ambiguous substring returns null", () => {
    const cfg = makeConfig([makeSession("foo-api"), makeSession("bar-api")]);
    expect(resolveSessionName(cfg, registry, "api")).toBeNull();
  });

  test("no match returns null", () => {
    const cfg = makeConfig([makeSession("alpha"), makeSession("beta")]);
    expect(resolveSessionName(cfg, registry, "zzz")).toBeNull();
  });

  test("registry entries augment the name pool", () => {
    const cfg = makeConfig([makeSession("alpha")]);
    registry.add({ name: "dynamic", path: "/tmp/whatever", priority: 50, auto_go: false });
    expect(resolveSessionName(cfg, registry, "dyn")).toBe("dynamic");
    expect(resolveSessionName(cfg, registry, "alpha")).toBe("alpha");
  });

  test("config name takes precedence over duplicate registry name", () => {
    const cfg = makeConfig([makeSession("shared")]);
    registry.add({ name: "shared", path: "/tmp/x", priority: 50, auto_go: false });
    // Both entries collapse to one name — exact match still works
    expect(resolveSessionName(cfg, registry, "shared")).toBe("shared");
  });
});

describe("resolveSessionPath", () => {
  test("returns null when name doesn't resolve", () => {
    expect(resolveSessionPath(makeConfig([]), registry, "nope")).toBeNull();
  });

  test("returns config path for resolved config session", () => {
    const cfg = makeConfig([makeSession("app", { path: "/opt/app" })]);
    expect(resolveSessionPath(cfg, registry, "app")).toBe("/opt/app");
  });

  test("returns null when resolved session has no path", () => {
    const cfg = makeConfig([makeSession("srv")]); // no path field
    expect(resolveSessionPath(cfg, registry, "srv")).toBeNull();
  });

  test("falls through to registry for dynamically-opened sessions", () => {
    const cfg = makeConfig([]);
    registry.add({ name: "dyn", path: "/tmp/workspace", priority: 50, auto_go: false });
    // registry.add normalises path via resolve()
    const resolved = resolveSessionPath(cfg, registry, "dyn");
    expect(resolved).toContain("workspace");
  });

  test("prefix-resolves then path-lookup", () => {
    const cfg = makeConfig([makeSession("alpha", { path: "/a" }), makeSession("beta")]);
    expect(resolveSessionPath(cfg, registry, "alp")).toBe("/a");
  });
});
