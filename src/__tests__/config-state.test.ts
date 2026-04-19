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
