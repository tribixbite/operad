import { describe, test, expect } from "bun:test";
import { SessionController, type TmuxRunner, type HealthChecker } from "../session-controller.js";
import type { SessionConfig } from "../types.js";
import { Logger } from "../log.js";

function makeConfig(name: string, overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    name,
    command: "claude",
    cwd: "/tmp",
    enabled: true,
    depends_on: [],
    priority: 10,
    max_restarts: 3,
    ...overrides,
  } as any;
}

const okRunner: TmuxRunner = (_args) => ({ exitCode: 0, stdout: "", stderr: "" });
const failRunner: TmuxRunner = (_args) => ({ exitCode: 1, stdout: "", stderr: "tmux: error" });
const healthyChecker: HealthChecker = async () => ({ healthy: true });
const unhealthyChecker: HealthChecker = async () => ({ healthy: false, reason: "process not found" });

const log = new Logger(`${process.env.TMPDIR ?? "/tmp"}/operad-test-logs`, false);

describe("SessionController", () => {

  describe("start()", () => {
    test("happy path: pending → starting → running", async () => {
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: healthyChecker, log });
      const state = await ctrl.start("app", makeConfig("app"));
      expect(state.status).toBe("running");
    });

    test("tmux failure: pending → starting → failed", async () => {
      const ctrl = new SessionController({ tmuxRunner: failRunner, healthChecker: healthyChecker, log });
      const state = await ctrl.start("app", makeConfig("app"));
      expect(state.status).toBe("failed");
    });

    test("started but health check fails → degraded", async () => {
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: unhealthyChecker, log });
      const state = await ctrl.start("app", makeConfig("app"));
      expect(state.status).toBe("degraded");
    });
  });

  describe("stop()", () => {
    test("running → stopping → stopped", async () => {
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: healthyChecker, log });
      await ctrl.start("app", makeConfig("app"));
      const state = await ctrl.stop("app");
      expect(state.status).toBe("stopped");
    });
  });

  describe("handleHealthFailure()", () => {
    test("first failure restarts and reaches running", async () => {
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: healthyChecker, log, restartDelayMs: 0 });
      await ctrl.start("app", makeConfig("app"));
      const state = await ctrl.handleHealthFailure("app", makeConfig("app"));
      expect(state.status).toBe("running");
      // restartCount resets to 0 after a successful restart
      expect(ctrl.getState("app")?.restartCount).toBe(0);
    });

    test("restartCount resets to 0 after successful restart", async () => {
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: healthyChecker, log, restartDelayMs: 0 });
      await ctrl.start("app", makeConfig("app"));
      await ctrl.handleHealthFailure("app", makeConfig("app"));
      expect(ctrl.getState("app")?.restartCount).toBe(0);
    });

    test("exceeds max_restarts → failed", async () => {
      const config = makeConfig("app", { max_restarts: 2 });
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: unhealthyChecker, log, restartDelayMs: 0 });
      await ctrl.start("app", config);

      for (let i = 0; i < 2; i++) {
        await ctrl.handleHealthFailure("app", config);
      }
      const state = await ctrl.handleHealthFailure("app", config);
      expect(state.status).toBe("failed");
    });

    test("restart cascade stops at max_restarts", async () => {
      const config = makeConfig("app", { max_restarts: 3 });
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: unhealthyChecker, log, restartDelayMs: 0 });
      await ctrl.start("app", config);

      let state = ctrl.getState("app")!;
      let iterations = 0;
      while (state.status !== "failed" && iterations < 10) {
        state = await ctrl.handleHealthFailure("app", config);
        iterations++;
      }
      expect(state.status).toBe("failed");
      expect(iterations).toBeLessThanOrEqual(4);
    });

    test("unknown session → failed", async () => {
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: healthyChecker, log, restartDelayMs: 0 });
      const state = await ctrl.handleHealthFailure("nonexistent", makeConfig("nonexistent"));
      expect(state.status).toBe("failed");
    });
  });

  describe("state tracking", () => {
    test("getState returns undefined before first start", () => {
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: healthyChecker, log });
      expect(ctrl.getState("unknown")).toBeUndefined();
    });

    test("lastTransition updates on each transition", async () => {
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: healthyChecker, log });
      const before = Date.now();
      await ctrl.start("app", makeConfig("app"));
      const state = ctrl.getState("app")!;
      expect(state.lastTransition.getTime()).toBeGreaterThanOrEqual(before);
    });
  });
});
