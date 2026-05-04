/**
 * state-transitions.test.ts — Pin down the legal/illegal transition table.
 *
 * StateManager.transition(name, to) consults VALID_TRANSITIONS in types.ts and
 * silently rejects illegal moves (logs a warning, returns false). The table
 * is load-bearing for the daemon's lifecycle: bad rules let degraded sessions
 * skip restart accounting, or let stopped sessions silently transition to
 * running without tmux. These tests freeze the contract so refactors don't
 * accidentally widen it.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

import { StateManager } from "../state.js";
import { VALID_TRANSITIONS } from "../types.js";
import type { SessionStatus, SessionConfig } from "../types.js";
import type { Logger } from "../log.js";

function silentLog(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

function makeSession(name: string): SessionConfig {
  return {
    name,
    type: "service",
    command: "true",
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
  } as SessionConfig;
}

const ALL_STATUSES: SessionStatus[] = [
  "pending", "waiting", "starting", "running", "degraded", "failed", "stopping", "stopped",
];

let tmpDir: string;
let state: StateManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-state-test-"));
  state = new StateManager(join(tmpDir, "state.json"), silentLog());
  state.initFromConfig([makeSession("svc")]);
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe("transition table — legal moves accepted", () => {
  for (const [from, allowed] of Object.entries(VALID_TRANSITIONS) as [SessionStatus, SessionStatus[]][]) {
    for (const to of allowed) {
      test(`${from} → ${to}`, () => {
        state.forceStatus("svc", from);
        const ok = state.transition("svc", to);
        expect(ok).toBe(true);
        expect(state.getSession("svc")?.status).toBe(to);
      });
    }
  }
});

describe("transition table — illegal moves rejected", () => {
  for (const from of ALL_STATUSES) {
    const allowed = new Set(VALID_TRANSITIONS[from]);
    for (const to of ALL_STATUSES) {
      if (allowed.has(to)) continue;
      // Self-transitions aren't in the allowed list either; tested below.
      if (from === to) continue;
      test(`${from} → ${to} blocked`, () => {
        state.forceStatus("svc", from);
        const ok = state.transition("svc", to);
        expect(ok).toBe(false);
        // State unchanged when the transition is rejected.
        expect(state.getSession("svc")?.status).toBe(from);
      });
    }
  }
});

describe("transition side effects", () => {
  test("entering 'running' resets consecutive_failures and clears last_error", () => {
    state.forceStatus("svc", "starting");
    // Fake some failure history.
    const s = state.getSession("svc")!;
    s.consecutive_failures = 5;
    s.last_error = "previous timeout";

    state.transition("svc", "running");
    const after = state.getSession("svc")!;
    expect(after.consecutive_failures).toBe(0);
    expect(after.last_error).toBeNull();
    expect(after.uptime_start).not.toBeNull();
  });

  test("degraded → starting bumps restart_count (auto-restart accounting)", () => {
    state.forceStatus("svc", "degraded");
    const before = state.getSession("svc")!.restart_count;
    state.transition("svc", "starting");
    const after = state.getSession("svc")!.restart_count;
    expect(after).toBe(before + 1);
  });

  test("stopped → starting (manual restart) does NOT bump restart_count", () => {
    state.forceStatus("svc", "stopped");
    const before = state.getSession("svc")!.restart_count;
    state.transition("svc", "starting");
    expect(state.getSession("svc")!.restart_count).toBe(before);
  });

  test("transitioning unknown session returns false without crashing", () => {
    expect(state.transition("ghost", "running")).toBe(false);
  });
});

describe("forceStatus — bypasses the validator", () => {
  // forceStatus exists for adoption paths: when the daemon discovers a tmux
  // session that's already alive, it must mark it 'running' without
  // round-tripping through pending → starting → running. These tests make
  // sure forceStatus stays distinct from transition() so future refactors
  // don't collapse the two and reintroduce the strict-transition gate on
  // adoption.
  test("can jump from pending → running directly", () => {
    state.forceStatus("svc", "running");
    expect(state.getSession("svc")?.status).toBe("running");
  });

  test("can jump from running → pending directly", () => {
    state.forceStatus("svc", "running");
    state.forceStatus("svc", "pending");
    expect(state.getSession("svc")?.status).toBe("pending");
  });
});
