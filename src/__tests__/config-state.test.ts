import { describe, test, expect } from "bun:test";
import { validateConfig, type ConfigError } from "../config.js";
import { migrateState } from "../state.js";
import type { TmxConfig, SessionConfig } from "../types.js";

function sessionWith(overrides: Partial<SessionConfig>): SessionConfig {
  return {
    name: "x",
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

describe("validateConfig", () => {
  test("empty config is valid (no sessions required)", () => {
    const cfg = { sessions: [] } as unknown as TmxConfig;
    expect(validateConfig(cfg)).toEqual([]);
  });

  test("session with all required fields is valid", () => {
    const cfg = { sessions: [sessionWith({ name: "app", command: "echo hi" })] } as unknown as TmxConfig;
    expect(validateConfig(cfg)).toEqual([]);
  });

  test("session with missing name is flagged", () => {
    const cfg = { sessions: [sessionWith({ name: "" })] } as unknown as TmxConfig;
    const errors = validateConfig(cfg);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e: ConfigError) => e.field === "session.name")).toBe(true);
  });

  test("service session missing command is flagged", () => {
    const cfg = { sessions: [sessionWith({ name: "srv", command: undefined, type: "service" })] } as unknown as TmxConfig;
    const errors = validateConfig(cfg);
    const commandErr = errors.find((e: ConfigError) => e.field.endsWith(".command"));
    expect(commandErr).toBeDefined();
    expect(commandErr?.message).toContain("command");
    expect(commandErr?.fix).toBeDefined();
  });

  test("claude session missing command is NOT flagged (uses type default)", () => {
    const cfg = { sessions: [sessionWith({ name: "cc", type: "claude", command: undefined })] } as unknown as TmxConfig;
    expect(validateConfig(cfg)).toEqual([]);
  });

  test("multiple invalid sessions produce multiple errors", () => {
    const cfg = {
      sessions: [
        sessionWith({ name: "", command: undefined, type: "service" }),
        sessionWith({ name: "ok", command: "echo" }),
        sessionWith({ name: "noCmd", command: undefined, type: "service" }),
      ]
    } as unknown as TmxConfig;
    const errors = validateConfig(cfg);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  test("error objects have field, message, and fix strings", () => {
    const cfg = { sessions: [sessionWith({ name: "" })] } as unknown as TmxConfig;
    const errors = validateConfig(cfg);
    for (const err of errors) {
      expect(typeof err.field).toBe("string");
      expect(typeof err.message).toBe("string");
      expect(typeof err.fix).toBe("string");
      expect(err.fix.length).toBeGreaterThan(0);
    }
  });

  /*
   * Multi-runtime: opencode and codex SessionTypes should be accepted by
   * validateConfig the same way claude is — they're agent runtimes that
   * use SessionRuntime adapters for startup, so the validator (which
   * only flags missing names + service-type missing-command) shouldn't
   * fire on them.
   */
  test("opencode session with path is valid", () => {
    const cfg = { sessions: [sessionWith({ name: "spike", type: "opencode", command: undefined, path: "/tmp/p" })] } as unknown as TmxConfig;
    expect(validateConfig(cfg)).toEqual([]);
  });

  test("codex session with path is valid", () => {
    const cfg = { sessions: [sessionWith({ name: "research", type: "codex", command: undefined, path: "/tmp/p" })] } as unknown as TmxConfig;
    expect(validateConfig(cfg)).toEqual([]);
  });
});

/*
 * Parser-level tests: validateConfigFile loads + parses a TOML file from
 * disk and returns *string* errors from both parse-time enforcement and
 * post-parse validateConfig. This is where the SessionType union and
 * the agent-runtime path-required rule actually fire.
 */
import { validateConfigFile } from "../config.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function withTomlFile(toml: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "operad-config-test-"));
  const path = join(dir, "operad.toml");
  writeFileSync(path, toml, "utf8");
  try { fn(path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("validateConfigFile — agent runtime types parse cleanly", () => {
  test("opencode session with path parses without errors", () => {
    withTomlFile(
      `
      [orchestrator]
      [[session]]
      name = "spike"
      type = "opencode"
      path = "/tmp/spike"
      `,
      (p) => expect(validateConfigFile(p)).toEqual([]),
    );
  });

  test("codex session with path parses without errors", () => {
    withTomlFile(
      `
      [orchestrator]
      [[session]]
      name = "research"
      type = "codex"
      path = "/tmp/research"
      `,
      (p) => expect(validateConfigFile(p)).toEqual([]),
    );
  });

  test("opencode without path is rejected (path required for agent runtimes)", () => {
    withTomlFile(
      `
      [orchestrator]
      [[session]]
      name = "spike"
      type = "opencode"
      `,
      (p) => {
        const errors = validateConfigFile(p);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => /path/i.test(e))).toBe(true);
      },
    );
  });

  test("codex without path is rejected", () => {
    withTomlFile(
      `
      [orchestrator]
      [[session]]
      name = "research"
      type = "codex"
      `,
      (p) => {
        const errors = validateConfigFile(p);
        expect(errors.some((e) => /path/i.test(e))).toBe(true);
      },
    );
  });

  test("unknown SessionType is rejected at parse time", () => {
    withTomlFile(
      `
      [orchestrator]
      [[session]]
      name = "ghost"
      type = "windsurf"
      path = "/tmp/g"
      `,
      (p) => {
        const errors = validateConfigFile(p);
        expect(errors.length).toBeGreaterThan(0);
        // Don't pin exact message — just confirm the type field is flagged.
        expect(errors.some((e) => /type/i.test(e))).toBe(true);
      },
    );
  });
});

describe("migrateState", () => {
  test("fresh state with no schemaVersion gets v0.4.0 notice", () => {
    const state: any = {};
    const { state: migrated, notice } = migrateState(state);
    expect(migrated.schemaVersion).toBe(2);
    expect(notice).toBeTruthy();
    expect(notice).toContain("v0.4.0");
    expect(notice).toContain("switchboard reset");
  });

  test("state already at v2 gets no notice (no-op)", () => {
    const state: any = { schemaVersion: 2, switchboard: { cognitive: true } };
    const { state: migrated, notice } = migrateState(state);
    expect(migrated.schemaVersion).toBe(2);
    expect(notice).toBeNull();
    // Existing settings preserved
    expect(migrated.switchboard.cognitive).toBe(true);
  });

  test("state at v1 gets bumped + notice (preserves other fields)", () => {
    const state: any = { schemaVersion: 1, switchboard: { cognitive: true } };
    const { state: migrated, notice } = migrateState(state);
    expect(migrated.schemaVersion).toBe(2);
    expect(notice).toBeTruthy();
    expect(migrated.switchboard.cognitive).toBe(true); // preserved
  });

  test("migration mutates input object (in-place)", () => {
    const state: any = { schemaVersion: 1 };
    const { state: returned } = migrateState(state);
    expect(returned).toBe(state); // same reference
    expect(state.schemaVersion).toBe(2);
  });

  test("running migration twice is idempotent after first application", () => {
    const state: any = {};
    const first = migrateState(state);
    expect(first.notice).toBeTruthy();
    const second = migrateState(state);
    expect(second.notice).toBeNull(); // already migrated
  });
});
