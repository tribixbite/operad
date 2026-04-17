# Sprint 3: Integration Tests — Session Lifecycle

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test the session state machine (pending → running → degraded → failed) with mocked tmux and simulated health check failures. Extract session control logic into a testable `SessionController` class.

**Architecture:** First extract session start/stop/health logic from `Orchestrator` into `src/session-controller.ts` with a `tmuxRunner` injection point. Then write `src/__tests__/session-lifecycle.test.ts` covering happy path, health failures, restart cascades, dependency ordering, and stop transitions.

**Tech Stack:** TypeScript, bun:test. No new dependencies. TDD: write tests first, then extract the logic.

**Spec:** `docs/superpowers/specs/2026-04-17-operad-sprint-design.md` § Sprint 3

---

## Project Context

operad manages tmux sessions via an `Orchestrator` class in `src/daemon.ts` (6644 lines). Key methods:
- `startSession(name)` — ~line 645
- `stopSessionByName(name)` — ~line 801
- Session state transitions stored in `src/state.ts` `StateManager`
- Health checks in `src/health.ts`
- Types: `SessionState`, `SessionStatus` in `src/types.ts`
- `stopSession(name, log)` exported from `src/session.ts` ~line 82

The goal of this sprint is NOT to rewrite daemon.ts but to extract just enough session logic into a testable unit without breaking the existing daemon.

---

## Task 1: Define the SessionController interface

**Files:**
- Create: `src/session-controller.ts`

- [ ] **Step 1: Read relevant daemon.ts sections**

Read `src/daemon.ts` lines 640-870 to understand `startSession()` and `stopSessionByName()`. Read `src/types.ts` to understand `SessionState` and `SessionStatus` types.

- [ ] **Step 2: Create `src/session-controller.ts` with minimal interface**

```typescript
import type { SessionConfig, SessionStatus } from "./types.js";
import type { Logger } from "./log.js";

/** Minimal tmux operation result */
export interface TmuxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injected tmux runner — real spawnSync in production, fake in tests */
export type TmuxRunner = (args: string[]) => TmuxResult;

/** Minimal health check result */
export interface HealthResult {
  healthy: boolean;
  reason?: string;
}

/** Injected health checker — real checks in production, fake in tests */
export type HealthChecker = (sessionName: string, config: SessionConfig) => Promise<HealthResult>;

export interface SessionControllerOptions {
  tmuxRunner: TmuxRunner;
  healthChecker: HealthChecker;
  log: Logger;
  maxRestarts?: number;
  restartDelayMs?: number;
}

/** Per-session runtime state tracked by controller */
export interface SessionRuntimeState {
  name: string;
  status: SessionStatus;
  restartCount: number;
  lastTransition: Date;
  pid?: number;
}

/**
 * Pure session lifecycle controller — no daemon coupling.
 * Accepts injected tmuxRunner and healthChecker for testability.
 */
export class SessionController {
  private states = new Map<string, SessionRuntimeState>();
  private opts: Required<SessionControllerOptions>;

  constructor(opts: SessionControllerOptions) {
    this.opts = {
      maxRestarts: opts.maxRestarts ?? 5,
      restartDelayMs: opts.restartDelayMs ?? 3000,
      ...opts,
    };
  }

  getState(name: string): SessionRuntimeState | undefined {
    return this.states.get(name);
  }

  /** Transition a session to a new status, recording timestamp */
  private transition(name: string, to: SessionStatus, extra: Partial<SessionRuntimeState> = {}): SessionRuntimeState {
    const existing = this.states.get(name) ?? {
      name,
      status: "pending" as SessionStatus,
      restartCount: 0,
      lastTransition: new Date(),
    };
    const next: SessionRuntimeState = { ...existing, status: to, lastTransition: new Date(), ...extra };
    this.states.set(name, next);
    return next;
  }

  /** Start a session — transitions pending → starting → running/failed */
  async start(name: string, config: SessionConfig): Promise<SessionRuntimeState> {
    this.transition(name, "starting");

    // Create tmux window
    const result = this.opts.tmuxRunner([
      "new-window", "-t", config.tmux_session ?? "operad", "-n", name,
      "-d", "--", config.command,
    ]);

    if (result.exitCode !== 0) {
      this.opts.log.error(`Failed to start session '${name}'`, { stderr: result.stderr });
      return this.transition(name, "failed");
    }

    // Wait briefly then health check
    const health = await this.opts.healthChecker(name, config);
    if (health.healthy) {
      return this.transition(name, "running");
    }

    // Not healthy immediately — mark degraded, caller decides on restart
    this.opts.log.warn(`Session '${name}' started but unhealthy: ${health.reason}`);
    return this.transition(name, "degraded");
  }

  /** Stop a session — transitions to stopped */
  async stop(name: string): Promise<SessionRuntimeState> {
    this.transition(name, "stopping");
    this.opts.tmuxRunner(["kill-window", "-t", name]);
    return this.transition(name, "stopped");
  }

  /** Handle a health check failure — increment restarts or mark failed */
  async handleHealthFailure(name: string, config: SessionConfig): Promise<SessionRuntimeState> {
    const state = this.states.get(name);
    if (!state) return this.transition(name, "failed");

    const maxRestarts = config.max_restarts ?? this.opts.maxRestarts;
    if (state.restartCount >= maxRestarts) {
      this.opts.log.error(`Session '${name}' exceeded max restarts (${maxRestarts})`);
      return this.transition(name, "failed", { restartCount: state.restartCount });
    }

    this.opts.log.warn(`Session '${name}' degraded — restarting (${state.restartCount + 1}/${maxRestarts})`);
    this.transition(name, "degraded", { restartCount: state.restartCount + 1 });

    // Stop and restart
    await this.stop(name);
    return this.start(name, config);
  }
}
```

- [ ] **Step 3: Typecheck**

```bash
cd ~/git/operad && bun run typecheck
```
Expected: no errors.

---

## Task 2: Write session lifecycle tests

**Files:**
- Create: `src/__tests__/session-lifecycle.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, test, expect, mock } from "bun:test";
import { SessionController, type TmuxRunner, type HealthChecker } from "../session-controller.js";
import type { SessionConfig } from "../types.js";
import { Logger } from "../log.js";

/** Build a minimal SessionConfig stub */
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

/** TmuxRunner that always succeeds */
const okRunner: TmuxRunner = (_args) => ({ exitCode: 0, stdout: "", stderr: "" });

/** TmuxRunner that always fails */
const failRunner: TmuxRunner = (_args) => ({ exitCode: 1, stdout: "", stderr: "tmux: error" });

/** HealthChecker that always passes */
const healthyChecker: HealthChecker = async () => ({ healthy: true });

/** HealthChecker that always fails */
const unhealthyChecker: HealthChecker = async () => ({ healthy: false, reason: "process not found" });

// Logger writes to a temp dir — discarded after tests
const log = new Logger("/tmp/operad-test-logs", false);

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
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: healthyChecker, log });
      await ctrl.start("app", makeConfig("app"));
      // Simulate degraded state
      const state = await ctrl.handleHealthFailure("app", makeConfig("app"));
      expect(state.status).toBe("running");
      expect(ctrl.getState("app")?.restartCount).toBe(1);
    });

    test("exceeds max_restarts → failed", async () => {
      const config = makeConfig("app", { max_restarts: 2 });
      // Runner succeeds for start but health always fails
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: unhealthyChecker, log });
      await ctrl.start("app", config); // → degraded

      // Force restart count to max
      for (let i = 0; i < 2; i++) {
        await ctrl.handleHealthFailure("app", config);
      }
      const state = await ctrl.handleHealthFailure("app", config);
      expect(state.status).toBe("failed");
    });

    test("restart cascade stops at max_restarts", async () => {
      const config = makeConfig("app", { max_restarts: 3 });
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: unhealthyChecker, log });
      await ctrl.start("app", config);

      let state = ctrl.getState("app")!;
      let iterations = 0;
      while (state.status !== "failed" && iterations < 10) {
        state = await ctrl.handleHealthFailure("app", config);
        iterations++;
      }
      expect(state.status).toBe("failed");
      expect(iterations).toBeLessThanOrEqual(4); // max 3 restarts + 1 final failure
    });

    test("unknown session → failed", async () => {
      const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: healthyChecker, log });
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
```

- [ ] **Step 2: Run tests**

```bash
cd ~/git/operad && bun test src/__tests__/session-lifecycle.test.ts
```
Expected: all tests pass. If `createLogger` signature is wrong, read `src/log.ts` and adjust the import.

- [ ] **Step 3: Run full test suite**

```bash
cd ~/git/operad && bun test
```
Expected: all tests pass.

- [ ] **Step 4: Typecheck**

```bash
cd ~/git/operad && bun run typecheck
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd ~/git/operad
git add src/session-controller.ts src/__tests__/session-lifecycle.test.ts
git commit -m "feat(tests): session lifecycle integration tests + SessionController extraction

SessionController accepts injected TmuxRunner + HealthChecker — testable without
daemon. Tests cover: happy path, tmux failure, health failure, restart cascade,
max_restarts exceeded, stop transition, state tracking.

— claude-sonnet-4-6"
```

---

## Task 3: Wire SessionController into daemon.ts

The spec requires `Orchestrator` to use `SessionController` rather than duplicating the logic. This task does the minimal wiring — it does NOT remove all duplicate logic (full extraction happens in Sprints 6-10), but it establishes the pattern.

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Read `startSession()` in daemon.ts (~line 645)**

Read `src/daemon.ts` lines 645-800 to understand current session start logic.

- [ ] **Step 2: Import SessionController in daemon.ts**

Add at the top of `src/daemon.ts`:
```typescript
import { SessionController, type TmuxRunner } from "./session-controller.js";
```

- [ ] **Step 3: Add SessionController instance to Orchestrator**

In the `Orchestrator` class, add a property:
```typescript
private sessionController: SessionController;
```

In the constructor, after `this.log` is initialized:
```typescript
const tmuxRunner: TmuxRunner = (args) => {
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
this.sessionController = new SessionController({
  tmuxRunner,
  healthChecker: async (name, config) => {
    // Delegate to existing health check logic (full migration in Sprint 6)
    return { healthy: true };
  },
  log: this.log,
});
```

Note: The `healthChecker` is a stub (`healthy: true`) — full wiring happens in Sprint 6. The goal here is just to establish that `sessionController` exists and is constructed.

- [ ] **Step 4: Typecheck**

```bash
cd ~/git/operad && bun run typecheck
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd ~/git/operad
git add src/daemon.ts
git commit -m "refactor(daemon): wire SessionController instance into Orchestrator

Establishes injection point for testable session lifecycle management.
Full delegation (replacing existing methods) deferred to Sprint 6.

— claude-sonnet-4-6"
```

---

## Task 4: Verify build still works

- [ ] **Step 1: Full build**

```bash
cd ~/git/operad && bun run build
```
Expected: `dist/tmx.js` produced, no errors.

- [ ] **Step 2: Smoke test**

```bash
node dist/tmx.js --version
```
Expected: prints version.

- [ ] **Step 3: All tests**

```bash
cd ~/git/operad && bun test
```
Expected: all tests pass (now more than 29 — added session-lifecycle tests).
