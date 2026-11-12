/**
 * user-exit.test.ts — retiring a session whose shell the user exited.
 *
 * Found end-to-end against a real daemon: with `unhealthy_threshold = 1` the
 * health sweep had already moved the session to `degraded` by the time the
 * exit was handled, and `degraded → stopped` is not a legal transition. The
 * transition was rejected (logged, ignored), the session stayed `degraded`,
 * and the restart loop that runs right after restarted it — four
 * milliseconds after logging "not restarting". The earlier tests only ever
 * retired sessions from `running`, where `running → stopped` is legal.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../state.js";
import { retireUserExits, type UserExitDeps } from "../user-exit.js";
import type { HealthResult, SessionConfig, SessionStatus } from "../types.js";

const silentLog = { info() {}, warn() {}, error() {}, debug() {} } as never;

let dir: string;
let state: StateManager;
let calls: string[];

const session = (over: Partial<SessionConfig> = {}): SessionConfig => ({
  name: "probe", type: "claude", path: "/work/probe", ...over,
}) as SessionConfig;

const exited = (name = "probe"): HealthResult =>
  ({ session: name, healthy: false, message: "tmux pane exited", user_exited: true, duration_ms: 1 }) as HealthResult;

function deps(): UserExitDeps {
  return {
    state,
    log: silentLog,
    cancelRestart: (n) => calls.push(`cancel:${n}`),
    stopSession: (n) => calls.push(`stop:${n}`),
    forgetActivity: (n) => calls.push(`forget:${n}`),
    notify: (n) => calls.push(`notify:${n}`),
  };
}

/** Put the session into `status` through legal transitions. */
function drive(name: string, path: SessionStatus[]): void {
  for (const to of path) expect(state.transition(name, to)).toBe(true);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "operad-user-exit-"));
  state = new StateManager(join(dir, "state.json"), silentLog);
  state.initFromConfig([session()]);
  calls = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("retireUserExits", () => {
  test("a DEGRADED session the user exited ends up stopped, not restartable", () => {
    drive("probe", ["starting", "running", "degraded"]);
    retireUserExits([exited()], [session()], true, deps());
    expect(state.getSession("probe")?.status).toBe("stopped");
    expect(calls).toContain("cancel:probe");
    expect(calls).toContain("stop:probe");
  });

  test("a running session is retired too", () => {
    drive("probe", ["starting", "running"]);
    retireUserExits([exited()], [session()], true, deps());
    expect(state.getSession("probe")?.status).toBe("stopped");
  });

  test("retiring unstars it and records the close", () => {
    drive("probe", ["starting", "running", "degraded"]);
    retireUserExits([exited()], [session()], true, deps());
    expect(state.getAutostartOverrides().probe).toBe(false);
    expect(Object.keys(state.getManualCloses())).toEqual([resolve("/work/probe")]);
  });

  test("an already-stopped session is left alone (no repeat notification)", () => {
    drive("probe", ["starting", "running", "stopped"]);
    retireUserExits([exited()], [session()], true, deps());
    expect(calls).toEqual([]);
  });

  test("respect_manual_exit = false disables it", () => {
    drive("probe", ["starting", "running", "degraded"]);
    retireUserExits([exited()], [session()], false, deps());
    expect(state.getSession("probe")?.status).toBe("degraded");
    expect(calls).toEqual([]);
  });

  test("services and crashes are not retired", () => {
    drive("probe", ["starting", "running", "degraded"]);
    retireUserExits([exited()], [session({ type: "service" })], true, deps());
    retireUserExits([{ ...exited(), user_exited: false }], [session()], true, deps());
    expect(state.getSession("probe")?.status).toBe("degraded");
  });
});
