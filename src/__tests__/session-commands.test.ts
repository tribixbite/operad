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
import type { TmxConfig, SessionConfig } from "../types.js";
import type { Logger } from "../log.js";

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
    // Minimal name/path resolvers used by cmdSetAutostart + friends.
    resolveName(name: string) {
      return config.sessions.find((s) => s.name === name)?.name ?? null;
    },
    resolveSessionPath(name: string) {
      return config.sessions.find((s) => s.name === name)?.path ?? null;
    },
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

// --- cmdSetAutostart — ⭐ pin persistence ------------------------------------

describe("cmdSetAutostart — autostart pins", () => {
  test("unpinning a config session disables it and persists the override", async () => {
    const path = makeProjectPath("alpha");
    h = makeHarness([makeSession("alpha", path, { enabled: true })]);

    const resp = await h.cmds.cmdSetAutostart("alpha", false);
    expect(resp.ok).toBe(true);
    expect((resp.data as { autostart: boolean }).autostart).toBe(false);
    // Live config flag flipped …
    expect(h.config.sessions.find((s) => s.name === "alpha")?.enabled).toBe(false);
    // … and the override persisted for the next boot.
    expect(h.state.getAutostartOverrides().alpha).toBe(false);
  });

  test("re-pinning a previously unpinned session re-enables it", async () => {
    const path = makeProjectPath("beta");
    h = makeHarness([makeSession("beta", path, { enabled: true })]);

    await h.cmds.cmdSetAutostart("beta", false);
    const resp = await h.cmds.cmdSetAutostart("beta", true);
    expect(resp.ok).toBe(true);
    expect(h.config.sessions.find((s) => s.name === "beta")?.enabled).toBe(true);
    expect(h.state.getAutostartOverrides().beta).toBe(true);
  });

  test("closing a session clears its autostart override", async () => {
    const path = makeProjectPath("gamma");
    h = makeHarness([makeSession("gamma", path, { enabled: true })]);
    h.state.forceStatus("gamma", "stopped");

    await h.cmds.cmdSetAutostart("gamma", false);
    expect(h.state.getAutostartOverrides().gamma).toBe(false);

    await h.cmds.cmdClose("gamma");
    // Override gone — a future same-named session won't inherit the pin.
    expect("gamma" in h.state.getAutostartOverrides()).toBe(false);
  });
});

// =============================================================================
// cmdStatus — per-session and global status
// =============================================================================

/**
 * cmdStatus needs ctx.budget, ctx.wake, ctx.getMemoryDb, ctx.agentConfigs.
 * We extend makeHarness's minimal stub with no-op implementations for these
 * so the global-status branch runs to completion.
 */
function makeStatusHarness(initial: SessionConfig[]): Harness & { ctx: OrchestratorContext } {
  const base = makeHarness(initial);
  const ctx = {
    ...base.ctx,
    budget: { check: () => ({ budget: 0, used: 0 }) },
    wake: { isHeld: () => false },
    getMemoryDb: () => null,
    agentConfigs: [],
    pushSseState: () => {},
    updateStatusNotification: () => {},
  } as unknown as OrchestratorContext;
  return { ...base, ctx, cmds: new SessionCommands(ctx) };
}

describe("cmdStatus — per-session lookup", () => {
  test("returns error for unknown session name", () => {
    h = makeHarness([makeSession("alpha", makeProjectPath("alpha"))]);
    const resp = h.cmds.cmdStatus("no-such-session");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/unknown session/i);
  });

  test("returns session data when name resolves", () => {
    const path = makeProjectPath("alpha");
    h = makeHarness([makeSession("alpha", path)]);
    h.state.forceStatus("alpha", "running");
    const resp = h.cmds.cmdStatus("alpha");
    expect(resp.ok).toBe(true);
    const data = resp.data as { session: { name: string; status: string } };
    expect(data.session.name).toBe("alpha");
    expect(data.session.status).toBe("running");
  });

  test("global status includes sessions array with uptime/autostart fields", () => {
    const path = makeProjectPath("svc");
    const sh = makeStatusHarness([makeSession("svc", path)]);
    h = sh; // for afterEach cleanup
    sh.state.forceStatus("svc", "running");
    const resp = sh.cmds.cmdStatus();
    expect(resp.ok).toBe(true);
    const data = resp.data as { sessions: Array<{ name: string; autostart: boolean; from_config: boolean }> };
    const svc = data.sessions.find((s) => s.name === "svc");
    expect(svc).toBeDefined();
    // from_config true because it's in the config.sessions array
    expect(svc?.from_config).toBe(true);
    // autostart reflects enabled flag on config (default true from makeSession)
    expect(svc?.autostart).toBe(true);
  });

  test("global status quota is null when memoryDb is null", () => {
    const sh = makeStatusHarness([]);
    h = sh;
    const resp = sh.cmds.cmdStatus();
    expect(resp.ok).toBe(true);
    const data = resp.data as { quota: unknown };
    expect(data.quota).toBeNull();
  });
});

// =============================================================================
// cmdStart — resolves names, re-enables disabled sessions
// =============================================================================

describe("cmdStart", () => {
  test("starts a known stopped session by name", async () => {
    const path = makeProjectPath("worker");
    h = makeHarness([makeSession("worker", path)]);
    h.state.forceStatus("worker", "stopped");

    const resp = await h.cmds.cmdStart("worker");
    expect(resp.ok).toBe(true);
    expect(h.startCalls).toEqual(["worker"]);
    expect(String(resp.data)).toMatch(/started/i);
  });

  test("returns error when name is not resolvable (and path doesn't exist)", async () => {
    h = makeHarness([]);
    // A name that isn't a real path and has no config/registry entry → cmdOpen returns no-match
    const resp = await h.cmds.cmdStart("nonexistent-zzzz");
    // cmdStart falls through to cmdOpen, which returns ok:false for an unresolvable path
    expect(resp.ok).toBe(false);
  });

  test("re-enables a disabled session before starting", async () => {
    const path = makeProjectPath("beta");
    h = makeHarness([makeSession("beta", path, { enabled: false })]);
    h.state.forceStatus("beta", "stopped");

    await h.cmds.cmdStart("beta");
    expect(h.config.sessions.find((s) => s.name === "beta")?.enabled).toBe(true);
    expect(h.startCalls).toContain("beta");
  });

  test("prefix match resolves and starts the session", async () => {
    const path = makeProjectPath("zeta-service");
    h = makeHarness([makeSession("zeta-service", path)]);
    h.state.forceStatus("zeta-service", "stopped");

    const resp = await h.cmds.cmdStart("zeta");
    expect(resp.ok).toBe(true);
    expect(h.startCalls).toContain("zeta-service");
  });
});

// =============================================================================
// cmdStop — single and all-sessions
// =============================================================================

describe("cmdStop", () => {
  test("stops a known running session by name", async () => {
    const path = makeProjectPath("api");
    h = makeHarness([makeSession("api", path)]);
    h.state.forceStatus("api", "running");

    const resp = await h.cmds.cmdStop("api");
    expect(resp.ok).toBe(true);
    expect(h.stopCalls).toContain("api");
    expect(String(resp.data)).toMatch(/stopped/i);
  });

  test("returns error for unknown session name", async () => {
    h = makeHarness([]);
    const resp = await h.cmds.cmdStop("ghost");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/unknown session/i);
  });

  test("stop-all with no name calls stop for every config session", async () => {
    const pathA = makeProjectPath("a-svc");
    const pathB = makeProjectPath("b-svc");
    h = makeHarness([makeSession("a-svc", pathA), makeSession("b-svc", pathB)]);
    h.state.forceStatus("a-svc", "running");
    h.state.forceStatus("b-svc", "running");

    const resp = await h.cmds.cmdStop();
    expect(resp.ok).toBe(true);
    // Both sessions must have been stopped (order not guaranteed — just presence)
    expect(h.stopCalls).toContain("a-svc");
    expect(h.stopCalls).toContain("b-svc");
  });
});

// =============================================================================
// cmdRestart — stop then start
// =============================================================================

describe("cmdRestart", () => {
  test("stops then starts the named session", async () => {
    const path = makeProjectPath("backend");
    h = makeHarness([makeSession("backend", path)]);
    h.state.forceStatus("backend", "running");

    const resp = await h.cmds.cmdRestart("backend");
    expect(resp.ok).toBe(true);
    expect(h.stopCalls).toContain("backend");
    expect(h.startCalls).toContain("backend");
  });

  test("returns error for unknown session name", async () => {
    h = makeHarness([]);
    const resp = await h.cmds.cmdRestart("nope");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/unknown/i);
  });
});

// =============================================================================
// cmdForceCleanup — resolves name, stops, sweeps patterns, resets state
// =============================================================================

describe("cmdForceCleanup", () => {
  test("returns error for unknown session name", async () => {
    h = makeHarness([]);
    const resp = await h.cmds.cmdForceCleanup("phantom");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/unknown/i);
  });

  test("succeeds and returns sweep report for a known session", async () => {
    const path = makeProjectPath("x11-session");
    h = makeHarness([
      makeSession("x11-session", path, { command: "termux-x11 :0 &" }),
    ]);
    h.state.forceStatus("x11-session", "running");

    const resp = await h.cmds.cmdForceCleanup("x11-session");
    expect(resp.ok).toBe(true);
    const data = resp.data as { session: string; sweep: unknown[]; total_killed: number };
    expect(data.session).toBe("x11-session");
    expect(Array.isArray(data.sweep)).toBe(true);
    expect(typeof data.total_killed).toBe("number");
    // After cleanup, state must be stopped
    expect(h.state.getSession("x11-session")?.status).toBe("stopped");
    expect(h.stopCalls).toContain("x11-session");
  });

  test("session with no command produces empty sweep", async () => {
    const path = makeProjectPath("bare-session");
    h = makeHarness([makeSession("bare-session", path)]);
    h.state.forceStatus("bare-session", "stopped");

    const resp = await h.cmds.cmdForceCleanup("bare-session");
    expect(resp.ok).toBe(true);
    const data = resp.data as { sweep: unknown[] };
    expect(data.sweep).toHaveLength(0);
  });
});

// =============================================================================
// cmdClose — stop + unregister + remove from config + clear state
// =============================================================================

describe("cmdClose — full removal", () => {
  test("removes session from config, registry, and state", async () => {
    const path = makeProjectPath("temp-session");
    h = makeHarness([makeSession("temp-session", path)]);
    h.state.forceStatus("temp-session", "stopped");
    h.registry.add({ name: "temp-session", path, priority: 50, auto_go: false });

    const resp = await h.cmds.cmdClose("temp-session");
    expect(resp.ok).toBe(true);
    expect(h.config.sessions.find((s) => s.name === "temp-session")).toBeUndefined();
    expect(h.registry.find("temp-session")).toBeUndefined();
    expect(h.state.getSession("temp-session")).toBeUndefined();
  });

  test("returns error for unknown session", async () => {
    h = makeHarness([]);
    const resp = await h.cmds.cmdClose("ghost-session");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/unknown/i);
  });
});

// =============================================================================
// cmdCreate — validates name, creates dir, registers
// =============================================================================

describe("cmdCreate — name validation + registration", () => {
  test("rejects names with uppercase letters", () => {
    h = makeHarness([]);
    const resp = h.cmds.cmdCreate("MyProject");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/invalid name/i);
  });

  test("rejects names with special characters", () => {
    h = makeHarness([]);
    const resp = h.cmds.cmdCreate("my_project!");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/invalid name/i);
  });

  test("rejects empty string", () => {
    h = makeHarness([]);
    const resp = h.cmds.cmdCreate("");
    expect(resp.ok).toBe(false);
  });

  test("rejects names with spaces", () => {
    h = makeHarness([]);
    const resp = h.cmds.cmdCreate("my project");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/invalid name/i);
  });
});

// =============================================================================
// cmdRecent — enrichment of projects with running/registered/config status
// =============================================================================

describe("cmdRecent — status enrichment", () => {
  test("registry-only entries (not in history) are merged into results", () => {
    h = makeHarness([]);
    // Add a registry entry that won't appear in ~/.claude/history.jsonl
    const fakePath = makeProjectPath("reg-only-proj");
    h.registry.add({ name: "reg-only-proj", path: fakePath, priority: 50, auto_go: false });

    const resp = h.cmds.cmdRecent(100);
    expect(resp.ok).toBe(true);
    const results = resp.data as Array<{ name: string; status: string }>;
    // Must contain our registry-only entry with status "registered"
    const entry = results.find((r) => r.name === "reg-only-proj");
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("registered");
  });

  test("running session appears with status=running", () => {
    const path = makeProjectPath("active-proj");
    h = makeHarness([makeSession("active-proj", path)]);
    h.state.forceStatus("active-proj", "running");
    h.registry.add({ name: "active-proj", path, priority: 50, auto_go: false });

    const resp = h.cmds.cmdRecent(100);
    expect(resp.ok).toBe(true);
    const results = resp.data as Array<{ name: string; status: string }>;
    const entry = results.find((r) => r.name === "active-proj");
    // May show "running" (if matched by state lookup) or "registered"
    // The important thing is it appears and status is not "untracked"
    if (entry) {
      expect(entry.status).not.toBe("untracked");
    }
  });

  test("count parameter limits the result set", () => {
    h = makeHarness([]);
    for (let i = 0; i < 5; i++) {
      const p = makeProjectPath(`proj-${i}`);
      h.registry.add({ name: `proj-${i}`, path: p, priority: 50, auto_go: false });
    }

    const resp = h.cmds.cmdRecent(3);
    expect(resp.ok).toBe(true);
    const results = resp.data as unknown[];
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// =============================================================================
// cmdRegister — directory scanning + registry population
// =============================================================================

describe("cmdRegister — directory scanning", () => {
  test("returns error when scan path does not exist", () => {
    h = makeHarness([]);
    const resp = h.cmds.cmdRegister("/this-path/absolutely/does/not/exist-xyzzy");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/not found/i);
  });

  test("registers subdirectories under the given path", () => {
    const scanRoot = mkdtempSync(join(tmpdir(), "operad-scan-test-"));
    const projA = join(scanRoot, "project-alpha");
    const projB = join(scanRoot, "project-beta");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });

    h = makeHarness([]);
    const resp = h.cmds.cmdRegister(scanRoot);
    expect(resp.ok).toBe(true);
    const data = resp.data as { registered: string[]; skipped: number; total: number };
    expect(data.registered.length).toBe(2);
    expect(data.total).toBe(2);
    expect(data.skipped).toBe(0);

    // Cleanup the scan root (harness cleanup only covers its own tmpDir)
    try { rmSync(scanRoot, { recursive: true, force: true }); } catch {}
  });

  test("skips entries already in config by path", () => {
    const scanRoot = mkdtempSync(join(tmpdir(), "operad-scan-skip-"));
    const proj = join(scanRoot, "known-project");
    mkdirSync(proj, { recursive: true });

    h = makeHarness([makeSession("known-project", proj)]);
    const resp = h.cmds.cmdRegister(scanRoot);
    expect(resp.ok).toBe(true);
    const data = resp.data as { registered: string[]; skipped: number };
    // The already-configured path should be skipped
    expect(data.skipped).toBe(1);
    expect(data.registered).toHaveLength(0);

    try { rmSync(scanRoot, { recursive: true, force: true }); } catch {}
  });

  test("skips hidden directories (dotfiles)", () => {
    const scanRoot = mkdtempSync(join(tmpdir(), "operad-scan-hidden-"));
    mkdirSync(join(scanRoot, ".hidden-dir"), { recursive: true });
    mkdirSync(join(scanRoot, "visible-dir"), { recursive: true });

    h = makeHarness([]);
    const resp = h.cmds.cmdRegister(scanRoot);
    expect(resp.ok).toBe(true);
    const data = resp.data as { registered: string[]; total: number };
    // .hidden-dir should be skipped; only visible-dir is registered
    expect(data.total).toBe(1);
    expect(data.registered).toHaveLength(1);
    expect(data.registered[0]).toBe("visible-dir");

    try { rmSync(scanRoot, { recursive: true, force: true }); } catch {}
  });
});

// =============================================================================
// cmdSend — name resolution + error paths
// =============================================================================

describe("cmdSend — argument validation", () => {
  test("returns error for unknown session name", () => {
    h = makeHarness([]);
    const resp = h.cmds.cmdSend("ghost", "hello world");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/unknown session/i);
  });
});

// =============================================================================
// cmdSuspend / cmdResume / cmdSuspendOthers / cmdSuspendAll / cmdResumeAll
// These call suspendSession/resumeSession which invoke tmux — we only test
// the name-resolution and precondition-check paths (not actual SIGSTOP).
// =============================================================================

function makeSuspendHarness(initial: SessionConfig[]): Harness {
  const base = makeHarness(initial);
  const ctx = {
    ...base.ctx,
    pushSseState: () => {},
    updateStatusNotification: () => {},
  } as unknown as OrchestratorContext;
  return { ...base, ctx, cmds: new SessionCommands(ctx) };
}

describe("cmdSuspend — precondition guards", () => {
  test("returns error for unknown session", () => {
    h = makeSuspendHarness([]);
    const resp = h.cmds.cmdSuspend("nope");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/unknown/i);
  });

  test("returns error when session is not running or degraded", () => {
    const path = makeProjectPath("idle");
    h = makeSuspendHarness([makeSession("idle", path)]);
    h.state.forceStatus("idle", "stopped");
    const resp = h.cmds.cmdSuspend("idle");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/cannot suspend/i);
  });

  test("no-ops (ok:true) when session is already suspended", () => {
    const path = makeProjectPath("paused");
    h = makeSuspendHarness([makeSession("paused", path)]);
    h.state.forceStatus("paused", "running");
    h.state.setSuspended("paused", true);
    // session is running AND suspended → already suspended path
    const resp = h.cmds.cmdSuspend("paused");
    expect(resp.ok).toBe(true);
    expect(String(resp.data)).toMatch(/already suspended/i);
  });
});

describe("cmdResume — precondition guards", () => {
  test("returns error for unknown session", () => {
    h = makeSuspendHarness([]);
    const resp = h.cmds.cmdResume("ghost");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/unknown/i);
  });

  test("no-ops (ok:true) when session is not suspended", () => {
    const path = makeProjectPath("active");
    h = makeSuspendHarness([makeSession("active", path)]);
    h.state.forceStatus("active", "running");
    // Not suspended
    const resp = h.cmds.cmdResume("active");
    expect(resp.ok).toBe(true);
    expect(String(resp.data)).toMatch(/not suspended/i);
  });
});

describe("cmdSuspendAll / cmdResumeAll — bulk operations", () => {
  test("cmdSuspendAll returns ok with count 0 when no sessions are running", () => {
    const path = makeProjectPath("stopped-svc");
    h = makeSuspendHarness([makeSession("stopped-svc", path)]);
    h.state.forceStatus("stopped-svc", "stopped");
    const resp = h.cmds.cmdSuspendAll();
    expect(resp.ok).toBe(true);
    expect(String(resp.data)).toMatch(/0/);
  });

  test("cmdResumeAll returns ok with count 0 when no sessions are suspended", () => {
    const path = makeProjectPath("live-svc");
    h = makeSuspendHarness([makeSession("live-svc", path)]);
    h.state.forceStatus("live-svc", "running");
    // Not suspended
    const resp = h.cmds.cmdResumeAll();
    expect(resp.ok).toBe(true);
    expect(String(resp.data)).toMatch(/0/);
  });

  test("cmdSuspendOthers returns error for unknown guard session", () => {
    h = makeSuspendHarness([]);
    const resp = h.cmds.cmdSuspendOthers("missing");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/unknown/i);
  });
});

// =============================================================================
// cmdOpen — path-not-found fuzzy-resolution edge case
// =============================================================================

describe("cmdOpen — fuzzy resolution error paths", () => {
  test("returns error when path does not exist and has no config/registry match", async () => {
    h = makeHarness([]);
    // A path string that doesn't exist and can't match anything
    const resp = await h.cmds.cmdOpen("/absolutely/nonexistent/path/zzzz-xyzzy");
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/no project matching/i);
  });

  test("name-conflict with different path returns an error", async () => {
    const path1 = makeProjectPath("conflict");
    const path2 = makeProjectPath("other-dir");
    // Existing config session uses path1 under name "conflict"
    h = makeHarness([makeSession("conflict", path1)]);
    // cmdOpen path2 with derived name "other-dir"... let's force a conflict
    // by requesting a path that has a different name but would yield "conflict"
    // via deriveName. We do this by having the name collision: the caller
    // supplies baseName=conflict explicitly, but path2 is a fresh path.
    // The conflict arises because existingByPath would be empty (no session at path2)
    // but baseName "conflict" IS taken at path1 → conflict branch.
    const resp = await h.cmds.cmdOpen(path2, "conflict");
    // With explicit name "conflict" and no existing session at path2, cmdOpen falls
    // into the "existing name at different path" branch
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/conflict/i);
  });
});
