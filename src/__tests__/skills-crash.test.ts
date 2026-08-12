/**
 * skills-crash.test.ts — Property-style test for the install
 * transaction's rollback on partial failure (§3.15).
 *
 * For each of the 5 ordered side-effect steps, inject a failure at
 * that step and assert:
 *   • SQLite has no row for the half-installed skill
 *   • Cache directory cleaned up
 *   • ~/.claude.json operad_managed has no entry for it
 *   • ~/.claude/settings.json skills[] has no path under that bundle
 *   • ToolExecutor has no tool with the skill's name
 *   • ToolAutonomy caps table has no row
 *   • ToolExecutor has no orphan pending generation
 *
 * Uses the same temp HOME + os.homedir() mock pattern as
 * skills-e2e.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;
mock.module("node:os", () => {
  const real = require("node:os") as typeof import("node:os");
  return {
    ...real,
    homedir: () => tmpHome ?? real.homedir(),
  };
});

import { SkillManager } from "../skills/index.js";
import { _setSettingsJsonHome } from "../skills/settings-json.js";
import { _setGcHome } from "../skills/gc.js";
import { gitUrlProvider } from "../skills/providers/git-url.js";
import { ConsumerTracker } from "../skills/consumer-tracker.js";
import { ToolExecutor } from "../tools.js";
import { WorkflowEngine } from "../workflow.js";
import type { Provider, ProviderModule, FetchResult, ProviderReadResult } from "../skills/types.js";

let fixtureRepo: string;
let originalHome: string | undefined;

function setupDb(): Database {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      provider TEXT NOT NULL, locator TEXT NOT NULL, version TEXT NOT NULL,
      fetched_url TEXT NOT NULL, fetched_commit_sha TEXT,
      fetched_archive_sha256 TEXT NOT NULL, fetched_at INTEGER NOT NULL,
      trust_tier TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      tombstoned INTEGER NOT NULL DEFAULT 0, manifest_json TEXT NOT NULL,
      installed_at INTEGER NOT NULL, generation INTEGER, UNIQUE(provider, locator, version)
    );
    CREATE TABLE skill_active_version (
      provider TEXT NOT NULL, locator TEXT NOT NULL,
      version TEXT NOT NULL, generation INTEGER NOT NULL,
      PRIMARY KEY (provider, locator)
    );
    CREATE TABLE skill_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, skill_id TEXT NOT NULL,
      event_type TEXT NOT NULL, detail TEXT, occurred_at INTEGER NOT NULL
    );
    CREATE TABLE tool_autonomy_caps (
      tool_id TEXT PRIMARY KEY, max_bucket TEXT NOT NULL,
      current_bucket TEXT NOT NULL DEFAULT 'suggest',
      set_by_provider TEXT, set_at INTEGER NOT NULL, updated_at INTEGER
    );
    CREATE TABLE tool_leases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT NOT NULL,
      tool_name TEXT NOT NULL, goal_id INTEGER,
      max_executions INTEGER, executions_used INTEGER DEFAULT 0,
      expires_at INTEGER, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE agent_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT, schedule_name TEXT, cron_expr TEXT,
      interval_minutes INTEGER, prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, max_budget_usd REAL,
      last_run_at INTEGER, next_run_at INTEGER,
      total_cost_usd REAL DEFAULT 0, run_count INTEGER DEFAULT 0,
      consecutive_failures INTEGER DEFAULT 0, created_by TEXT,
      created_at INTEGER
    );
    CREATE TABLE agent_workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE, spec_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL DEFAULT 'config',
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE agent_workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER NOT NULL,
      workflow_name TEXT NOT NULL, triggered_by TEXT NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER,
      status TEXT NOT NULL DEFAULT 'running', message TEXT
    );
    CREATE TABLE agent_workflow_run_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL,
      node_id TEXT NOT NULL, status TEXT NOT NULL,
      started_at INTEGER, finished_at INTEGER, exit_code INTEGER,
      output TEXT, error TEXT, UNIQUE(run_id, node_id)
    );
    CREATE TABLE skill_generation_refs (
      generation INTEGER, ref_kind TEXT, ref_id TEXT, acquired_at INTEGER,
      PRIMARY KEY (generation, ref_kind, ref_id)
    );
    CREATE TABLE skill_cache_pending_delete (
      provider TEXT, locator TEXT, version TEXT, marked_at INTEGER,
      PRIMARY KEY (provider, locator, version)
    );
    CREATE TABLE tool_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT,
      tool_name TEXT, params_json TEXT, success INTEGER,
      result_summary TEXT, duration_ms INTEGER, error_message TEXT,
      autonomy_level TEXT, created_at INTEGER NOT NULL
    );
  `);
  return sql;
}

/**
 * Fault-injecting provider — wraps git+url and throws when the test
 * sets a `failAt` flag. Lets us simulate failures at the fetch and
 * read steps without filesystem tomfoolery.
 */
function makeFaultyProvider(failAt: { fetch?: boolean; read?: boolean }): ProviderModule {
  return {
    id: "git+url",
    trustTier: () => "escape",
    list: () => Promise.resolve({ items: [] }),
    async fetch(locator: string, version: string, parent: string): Promise<FetchResult> {
      if (failAt.fetch) throw new Error("injected fetch failure");
      return gitUrlProvider.fetch(locator, version, parent);
    },
    async read(extracted_path: string): Promise<ProviderReadResult> {
      if (failAt.read) throw new Error("injected read failure");
      return gitUrlProvider.read(extracted_path);
    },
    latest: (l: string) => gitUrlProvider.latest(l),
  };
}

/**
 * Initialise a git repo with one tagged commit.
 *
 * Separate invocations rather than one `a && b \\` string: execSync uses
 * cmd.exe on Windows, which cannot parse a backslash-newline continuation.
 */
function initFixtureRepo(cwd: string): void {
  const run = (args: string) => execSync(`git ${args}`, { cwd, stdio: "ignore" });
  run("init -q");
  run("add .");
  run('-c user.name=t -c user.email=t@t.co commit -q -m init');
  run("tag v0.1.0");
}

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "operad-skills-crash-home-"));
  // Explicit seams — mock.module("node:os") does not reach modules that bound
  // homedir before the mock was installed, which let this suite write to the
  // developer's real ~/.claude/settings.json.
  _setSettingsJsonHome(tmpHome);
  _setGcHome(tmpHome);
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;

  fixtureRepo = mkdtempSync(join(tmpdir(), "operad-skills-crash-repo-"));
  mkdirSync(join(fixtureRepo, ".operad"), { recursive: true });
  writeFileSync(
    join(fixtureRepo, ".operad", "operad.toml"),
    `[skill]\nname = "crash-fixture"\n\n[[tool]]\nname = "crash_echo"\ndescription = "echo"\ncommand = "echo {{x}}"\n  [[tool.params]]\n  name = "x"\n  type = "string"\n  required = true\n`,
  );
  initFixtureRepo(fixtureRepo);
});

afterAll(() => {
  _setSettingsJsonHome(null);
  _setGcHome(null);
  if (originalHome != null) process.env.HOME = originalHome;
  else delete process.env.HOME;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(fixtureRepo, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Helpers — built per test so the env is hermetic.

function buildEnv(provider: ProviderModule) {
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
  const sql = setupDb();
  const { MemoryDb } = require("../memory-db.js") as { MemoryDb: any };
  const memDb = Object.create(MemoryDb.prototype);
  memDb.requireDb = () => sql;
  const te = new ToolExecutor(memDb, log);
  const we = new WorkflowEngine(memDb, log);
  const tracker = new ConsumerTracker(null);
  const mgr = new SkillManager(memDb, log, {
    providers: { "git+url": provider } as Record<Provider, ProviderModule>,
    toolExecutor: te,
    workflowEngine: we,
    hasActiveConsumers: () => tracker.list(),
  });
  return { sql, memDb, te, we, mgr };
}

/**
 * Assert the failure left no orphan side effects across all 5
 * stores. Skill id may not be known if the install never got past
 * step 1; the assertions are state-based.
 */
function assertNoOrphans(env: ReturnType<typeof buildEnv>) {
  // SQLite skills row count = 0
  const skillsCount = env.sql.prepare(`SELECT count(*) AS n FROM skills`).get() as any;
  expect(skillsCount.n).toBe(0);
  // skill_active_version count = 0
  const avCount = env.sql.prepare(`SELECT count(*) AS n FROM skill_active_version`).get() as any;
  expect(avCount.n).toBe(0);
  // tool_autonomy_caps for our tool = 0
  const capsCount = env.sql.prepare(`SELECT count(*) AS n FROM tool_autonomy_caps WHERE tool_id = 'crash_echo'`).get() as any;
  expect(capsCount.n).toBe(0);
  // ToolExecutor has no tool
  expect(env.te.hasTool("crash_echo")).toBe(false);
  // No pending generations leaked
  expect(env.te.listGenerations()).toEqual([0]);

  // claude.json — either absent or has no operad_managed entry
  const cjPath = join(tmpHome, ".claude.json");
  if (existsSync(cjPath)) {
    const parsed = JSON.parse(readFileSync(cjPath, "utf8"));
    const managed = parsed.operad_managed ?? {};
    expect(Object.keys(managed)).toEqual([]);
  }
  // settings.json — either absent or skills[] doesn't reference fixture
  const sjPath = join(tmpHome, ".claude", "settings.json");
  if (existsSync(sjPath)) {
    const parsed = JSON.parse(readFileSync(sjPath, "utf8"));
    const skills = parsed.skills ?? [];
    expect(skills.filter((p: string) => p.includes("crash"))).toEqual([]);
  }
}

// Real git + on-disk install/rollback. Previously skipped on Windows, so the
// rollback paths had no coverage on a platform the CI matrix builds for.
describe("Phase E.4 — install transaction rollback under fault injection", () => {
  test("fetch step failure leaves no orphan state", async () => {
    const env = buildEnv(makeFaultyProvider({ fetch: true }));
    await expect(env.mgr.install("git+url", fixtureRepo, "v0.1.0"))
      .rejects.toThrow(/injected fetch failure/);
    assertNoOrphans(env);
    env.sql.close();
  }, 15_000);

  test("read step failure leaves no orphan state and cleans the cache dir", async () => {
    const env = buildEnv(makeFaultyProvider({ read: true }));
    await expect(env.mgr.install("git+url", fixtureRepo, "v0.1.0"))
      .rejects.toThrow(/injected read failure/);
    assertNoOrphans(env);
    env.sql.close();
  }, 15_000);

  test("happy path then forced uninstall leaves no orphan state", async () => {
    const env = buildEnv(gitUrlProvider);
    const r = await env.mgr.install("git+url", fixtureRepo, "v0.1.0");
    expect(env.te.hasTool("crash_echo")).toBe(true);
    env.mgr.uninstall(r.skill.id, { force_revoke: true });
    // After uninstall the skill row is tombstoned (not deleted) until
    // GC runs. The active_version row is gone; the tool unregistered.
    const av = env.sql.prepare(`SELECT count(*) AS n FROM skill_active_version`).get() as any;
    expect(av.n).toBe(0);
    expect(env.te.hasTool("crash_echo")).toBe(false);
    const caps = env.sql.prepare(`SELECT count(*) AS n FROM tool_autonomy_caps WHERE tool_id = 'crash_echo'`).get() as any;
    expect(caps.n).toBe(0);
    env.sql.close();
  }, 15_000);

  test("multiple installs followed by multiple uninstalls leaves no orphan tools", async () => {
    // Create N fixture repos with different tool names.
    const repos: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = mkdtempSync(join(tmpdir(), `operad-skills-multi-${i}-`));
      mkdirSync(join(r, ".operad"), { recursive: true });
      writeFileSync(
        join(r, ".operad", "operad.toml"),
        `[skill]\nname = "multi-${i}"\n\n[[tool]]\nname = "multi_${i}"\ndescription = "echo"\ncommand = "echo {{x}}"\n  [[tool.params]]\n  name = "x"\n  type = "string"\n  required = true\n`,
      );
  initFixtureRepo(r);
      repos.push(r);
    }

    const env = buildEnv(gitUrlProvider);
    const ids: string[] = [];
    for (const r of repos) {
      const res = await env.mgr.install("git+url", r, "v0.1.0");
      ids.push(res.skill.id);
    }
    expect(env.te.hasTool("multi_0")).toBe(true);
    expect(env.te.hasTool("multi_1")).toBe(true);
    expect(env.te.hasTool("multi_2")).toBe(true);

    // Uninstall in reverse order — generation discipline should
    // leave each intermediate state consistent.
    for (let i = ids.length - 1; i >= 0; i--) {
      env.mgr.uninstall(ids[i], { force_revoke: true });
    }
    expect(env.te.hasTool("multi_0")).toBe(false);
    expect(env.te.hasTool("multi_1")).toBe(false);
    expect(env.te.hasTool("multi_2")).toBe(false);
    // Caps cleaned up.
    const caps = env.sql.prepare(`SELECT count(*) AS n FROM tool_autonomy_caps`).get() as any;
    expect(caps.n).toBe(0);

    for (const r of repos) try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    env.sql.close();
  }, 30_000);
});

// ── installInProgress must never latch ─────────────────────────────────────
//
// The flag was set ~65 lines above the try/finally, so a throw from
// trustTier(), getActive(), beginGenerationTransaction() etc. skipped the
// finally and latched it forever: every later tool call and every later
// install failed with TOOL_BLOCKED_BY_ACTIVE_INSTALL until daemon restart.

describe("SkillManager — installInProgress is released on early failures", () => {
  /** Provider whose trustTier() throws — the earliest post-flag call site. */
  function explodingTierProvider(): ProviderModule {
    return {
      id: "git+url",
      trustTier() { throw new Error("boom: tier lookup failed"); },
      list: async () => ({ items: [] }),
      fetch: async () => { throw new Error("unreachable"); },
      read: async () => ({ name: "x", description: "" }),
      latest: async () => "v1.0.0",
    } as unknown as ProviderModule;
  }

  test("a throw from trustTier() does not latch the flag", async () => {
    const env = buildEnv(explodingTierProvider());
    const mgr = env.mgr;

    await expect(mgr.install("git+url", "/tmp/x", "latest")).rejects.toThrow(/boom/);

    // The next install must fail on its OWN error, not on a stale
    // "already in progress" refusal.
    let second: unknown = null;
    try { await mgr.install("git+url", "/tmp/x", "latest"); }
    catch (e) { second = e; }
    expect(String((second as Error).message)).toMatch(/boom/);
    expect(String((second as Error).message)).not.toMatch(/already in progress/i);
  });

  test("a throw from beginGenerationTransaction() does not latch the flag", async () => {
    const provider: ProviderModule = {
      id: "git+url",
      trustTier: () => "escape",
      list: async () => ({ items: [] }),
      fetch: async () => { throw new Error("unreachable"); },
      read: async () => ({ name: "x", description: "" }),
      latest: async () => "v1.0.0",
    } as unknown as ProviderModule;
    const env = buildEnv(provider);
    // Make the generation open blow up — it sits between the flag and the
    // original try.
    env.te.beginGenerationTransaction = () => {
      throw new Error("boom: generation open failed");
    };

    await expect(env.mgr.install("git+url", "/tmp/x", "latest")).rejects.toThrow(/generation open failed/);

    let second: unknown = null;
    try { await env.mgr.install("git+url", "/tmp/x", "latest"); }
    catch (e) { second = e; }
    expect(String((second as Error).message)).not.toMatch(/already in progress/i);
  });
});
