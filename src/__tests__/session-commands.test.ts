/**
 * session-commands.test.ts — Verifies cmdOpen reuse semantics and cmdDedupe.
 *
 * The shipping behaviour these tests pin down:
 *   - cmdOpen reuses the existing config entry for a path by default,
 *     starting an already-stopped one or no-op on a running one — no silent
 *     `foo-2` suffixed copy.
 *   - cmdOpen with `forceNew: true` (CLI `--new`, REST `?new=1`) explicitly
 *     creates the suffixed copy.
 *   - cmdOpen with an explicit unused name honours that name as-is (the
 *     branch-spawn flow in `/api/branch`).
 *   - cmdDedupe picks one winner per path (live tmux > running state >
 *     canonical un-suffixed name > most-recently-active) and only removes
 *     entries with no live tmux. dry_run never mutates state.
 *
 * SessionCommands' constructor only takes an OrchestratorContext, but
 * cmdOpen/cmdDedupe touch a tiny subset of it. We build a minimal stub
 * with real Registry + StateManager (they're file-backed, easy to point at
 * a temp dir) and inline mocks for log/startSession/stopSessionByName.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";

import { SessionCommands } from "../session-commands.js";
import { Registry } from "../registry.js";
import { StateManager } from "../state.js";
import type { OrchestratorContext } from "../orchestrator-context.js";
import type { TmxConfig, SessionConfig, Logger } from "../types.js";

function silentLog(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

function makeSession(name: string, path: string, overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    name,
    type: "claude",
    command: undefined,
    path,
    session_id: undefined,
    auto_go: false,
    priority: 50,
    depends_on: [],
    headless: false,
    env: {},
    health: undefined,
    max_restarts: 3,
    restart_backoff_s: 5,
    enabled: true,
    bare: false,
    ...overrides,
  } as SessionConfig;
}

interface Harness {
  cmds: SessionCommands;
  ctx: OrchestratorContext;
  config: TmxConfig;
  registry: Registry;
  state: StateManager;
  startCalls: string[];
  stopCalls: string[];
  cleanup: () => void;
}

function makeHarness(initial: SessionConfig[]): Harness {
  const tmpDir = mkdtempSync(join(tmpdir(), "operad-cmd-test-"));
  const config = { sessions: [...initial] } as TmxConfig;
  const registry = new Registry(join(tmpDir, "registry.json"));
  const state = new StateManager(join(tmpDir, "state.json"), silentLog());
  state.initFromConfig(config.sessions);
  const startCalls: string[] = [];
  const stopCalls: string[] = [];

  // Build a context stub that exposes only the surface cmdOpen/cmdDedupe touch.
  // Cast to `as unknown as OrchestratorContext` to satisfy TS without piping
  // every unused field through — these tests verify behaviour, not the DI graph.
  const ctx = {
    config,
    registry,
    state,
    log: silentLog(),
    async startSession(name: string) {
      startCalls.push(name);
      // Simulate the real start path: mark the session running so subsequent
      // cmdOpen calls see it as live.
      state.transition(name, "running");
      return true;
    },
    async stopSessionByName(name: string) {
      stopCalls.push(name);
      const cur = state.getSession(name);
      if (cur && cur.status === "running") state.transition(name, "stopping");
      state.transition(name, "stopped");
      return true;
    },
  } as unknown as OrchestratorContext;

  // Make sure tmpDir exists for any side-effect persistence under it.
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  return {
    cmds: new SessionCommands(ctx),
    ctx,
    config,
    registry,
    state,
    startCalls,
    stopCalls,
    cleanup() {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
    },
  };
}

let h: Harness;
afterEach(() => h?.cleanup());

// --- cmdOpen reuse-existing semantics ----------------------------------------

/**
 * Build a project path whose basename matches `name` so deriveName(path)
 * gives us back `name`. This matters because cmdOpen falls back to
 * `deriveName(path)` when no explicit name is supplied — without a matching
 * basename, the suffix-creation branch picks the wrong base token.
 */
function makeProjectPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "operad-cmd-test-"));
  const proj = join(root, name);
  mkdirSync(proj, { recursive: true });
  return proj;
}

describe("cmdOpen — default reuse-existing", () => {
  test("starts the existing entry instead of suffixing when path already registered", async () => {
    const path = makeProjectPath("alpha");
    h = makeHarness([makeSession("alpha", path)]);
    // sessions start in "pending"; drive to "stopped" through a legal path.
    h.state.forceStatus("alpha", "stopped");

    const resp = await h.cmds.cmdOpen(path);
    expect(resp.ok).toBe(true);
    expect(h.startCalls).toEqual(["alpha"]);
    expect(h.config.sessions.map((s) => s.name)).toEqual(["alpha"]); // no -2
  });

  test("no-ops when the existing entry is already running", async () => {
    const path = makeProjectPath("alpha");
    h = makeHarness([makeSession("alpha", path)]);
    h.state.forceStatus("alpha", "running");

    const resp = await h.cmds.cmdOpen(path);
    expect(resp.ok).toBe(true);
    expect(h.startCalls).toEqual([]); // nothing started — already running
    expect(h.config.sessions.map((s) => s.name)).toEqual(["alpha"]);
    expect(String(resp.data)).toContain("already running");
  });

  test("re-enables a disabled config session before starting it", async () => {
    const path = makeProjectPath("alpha");
    h = makeHarness([makeSession("alpha", path, { enabled: false })]);
    h.state.forceStatus("alpha", "stopped");

    const resp = await h.cmds.cmdOpen(path);
    expect(resp.ok).toBe(true);
    expect(h.config.sessions[0].enabled).toBe(true);
    expect(h.startCalls).toEqual(["alpha"]);
  });
});

// --- cmdOpen forceNew opt-in --------------------------------------------------

describe("cmdOpen — forceNew opt-in", () => {
  test("creates a -2 suffix when forceNew is true even though entry exists", async () => {
    const path = makeProjectPath("alpha");
    h = makeHarness([makeSession("alpha", path)]);
    h.state.forceStatus("alpha", "running");

    const resp = await h.cmds.cmdOpen(path, undefined, false, 50, true);
    expect(resp.ok).toBe(true);
    const names = h.config.sessions.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "alpha-2"]);
    expect(h.startCalls).toEqual(["alpha-2"]);
  });

  test("explicit unused name is honoured as-is, not suffixed", async () => {
    const path = makeProjectPath("alpha");
    h = makeHarness([makeSession("alpha", path)]);
    h.state.forceStatus("alpha", "running");

    const resp = await h.cmds.cmdOpen(path, "branch-1");
    expect(resp.ok).toBe(true);
    const names = h.config.sessions.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "branch-1"]);
    expect(h.startCalls).toEqual(["branch-1"]);
  });

  test("rejects names that fail the [a-z0-9-]+ validator", async () => {
    const path = makeProjectPath("zeta");
    h = makeHarness([]);

    const resp = await h.cmds.cmdOpen(path, "BadName!");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toContain("Invalid session name");
  });
});

// --- cmdDedupe ---------------------------------------------------------------

describe("cmdDedupe — winner selection + dry_run", () => {
  test("dry_run reports plans without mutating state", async () => {
    const path = makeProjectPath("alpha");
    h = makeHarness([makeSession("alpha", path), makeSession("alpha-old", path)]);
    h.state.forceStatus("alpha", "stopped");
    h.state.forceStatus("alpha-old", "stopped");
    h.registry.add({ name: "alpha", path, priority: 50, auto_go: false });
    h.registry.add({ name: "alpha-old", path, priority: 50, auto_go: false });

    const resp = await h.cmds.cmdDedupe(true);
    expect(resp.ok).toBe(true);
    const data = resp.data as {
      dry_run: boolean;
      groups_with_duplicates: number;
      removed_total: number;
      plans: Array<{ kept: string; removed: string[] }>;
    };
    expect(data.dry_run).toBe(true);
    expect(data.groups_with_duplicates).toBe(1);
    expect(data.removed_total).toBe(1);
    // No mutation: both names still in config + registry.
    expect(h.config.sessions.length).toBe(2);
    expect(h.registry.entries().length).toBe(2);
  });

  test("commits removal of dead duplicates and keeps canonical", async () => {
    const path = makeProjectPath("delta");
    const baseName = "delta";
    h = makeHarness([
      makeSession(baseName, path),
      makeSession(`${baseName}-2`, path),
      makeSession(`${baseName}-3`, path),
    ]);
    h.state.forceStatus(baseName, "stopped");
    h.state.forceStatus(`${baseName}-2`, "stopped");
    h.state.forceStatus(`${baseName}-3`, "stopped");
    h.registry.add({ name: baseName, path, priority: 50, auto_go: false });
    h.registry.add({ name: `${baseName}-2`, path, priority: 50, auto_go: false });
    h.registry.add({ name: `${baseName}-3`, path, priority: 50, auto_go: false });

    const resp = await h.cmds.cmdDedupe(false);
    const data = resp.data as {
      removed_total: number;
      plans: Array<{ kept: string; kept_reason: string; removed: string[] }>;
    };
    expect(data.removed_total).toBe(2);
    expect(data.plans[0].kept).toBe(baseName);
    expect(data.plans[0].kept_reason).toContain("canonical");
    expect(h.config.sessions.length).toBe(1);
    expect(h.config.sessions[0].name).toBe(baseName);
    expect(h.registry.entries().length).toBe(1);
  });

  test("running state wins over stopped when no live tmux", async () => {
    const path = makeProjectPath("epsilon");
    h = makeHarness([makeSession("project-a", path), makeSession("project-b", path)]);
    h.state.forceStatus("project-a", "stopped");
    // Mark project-b as running in state — even with no live tmux, dedupe
    // should prefer it over the stopped twin.
    h.state.forceStatus("project-b", "running");
    h.registry.add({ name: "project-a", path, priority: 50, auto_go: false });
    h.registry.add({ name: "project-b", path, priority: 50, auto_go: false });

    const resp = await h.cmds.cmdDedupe(true);
    const data = resp.data as { plans: Array<{ kept: string; kept_reason: string }> };
    expect(data.plans[0].kept).toBe("project-b");
    expect(data.plans[0].kept_reason).toContain("running");
  });

  test("returns no plans when paths are unique", async () => {
    const pathA = makeProjectPath("a-only");
    const pathB = makeProjectPath("b-only");
    h = makeHarness([makeSession("alpha", pathA), makeSession("beta", pathB)]);

    const resp = await h.cmds.cmdDedupe(true);
    const data = resp.data as { groups_with_duplicates: number; plans: unknown[] };
    expect(data.groups_with_duplicates).toBe(0);
    expect(data.plans).toEqual([]);
  });
});
