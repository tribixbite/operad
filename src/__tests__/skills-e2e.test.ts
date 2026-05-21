/**
 * skills-e2e.test.ts — Phase E.3 end-to-end integration test.
 *
 * Builds a real fixture skill repo on disk (init + commit + tag), wires
 * a minimal SkillManager + git+url provider against a temp HOME, and
 * runs the full install / list / info / uninstall round-trip without
 * mocking the inner layers.
 *
 * Differences from skills.test.ts (unit-level):
 *   • Real disk for cache + ~/.claude.json + ~/.claude/settings.json
 *   • Real git clone (small local file:// URL — no network)
 *   • Real ToolExecutor.registerTomlTools / unregister
 *   • Real WorkflowEngine.upsert / delete
 *   • Real ConsumerTracker gate check
 *   • Real lease-cascade pre-flight
 *
 * The test is hermetic: temp dirs created in beforeAll, torn down in
 * afterAll. HOME is rewritten via env override (skills writers read
 * paths from `homedir()` which honours `$HOME`).
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import {
  execSync,
} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock node:os homedir BEFORE any other import. bun's homedir() ignores
// late $HOME overrides (it caches at process start), so the only way to
// route the skills writers + store at our temp HOME is to interpose
// node:os.homedir(). The mock returns the temp HOME path after
// beforeAll sets it; in the bootstrap phase before beforeAll runs,
// we just defer to the real impl.
let tmpHome: string;
mock.module("node:os", () => {
  const real = require("node:os") as typeof import("node:os");
  return {
    ...real,
    homedir: () => tmpHome ?? real.homedir(),
  };
});

import { SkillManager } from "../skills/index.js";
import { gitUrlProvider } from "../skills/providers/git-url.js";
import { ConsumerTracker } from "../skills/consumer-tracker.js";
import type { Provider, ProviderModule } from "../skills/types.js";
import { ToolExecutor } from "../tools.js";
import { WorkflowEngine } from "../workflow.js";

// -- Fixtures --------------------------------------------------------------

let originalHome: string | undefined;
let fixtureRepo: string;
let memSql: Database;
let memDb: any;
let toolExecutor: ToolExecutor;
let workflowEngine: WorkflowEngine;
let mgr: SkillManager;

function setupDb(): Database {
  const sql = new Database(":memory:");
  // Replicate the SCHEMA_STATEMENTS subset the SkillManager hits.
  sql.exec(`
    CREATE TABLE skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      provider TEXT NOT NULL, locator TEXT NOT NULL, version TEXT NOT NULL,
      fetched_url TEXT NOT NULL, fetched_commit_sha TEXT,
      fetched_archive_sha256 TEXT NOT NULL, fetched_at INTEGER NOT NULL,
      trust_tier TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      tombstoned INTEGER NOT NULL DEFAULT 0, manifest_json TEXT NOT NULL,
      installed_at INTEGER NOT NULL,
      UNIQUE(provider, locator, version)
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL, tool_name TEXT NOT NULL,
      goal_id INTEGER, max_executions INTEGER, executions_used INTEGER DEFAULT 0,
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
    CREATE TABLE tool_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT,
      tool_name TEXT, params_json TEXT, success INTEGER,
      result_summary TEXT, duration_ms INTEGER, error_message TEXT,
      autonomy_level TEXT, created_at INTEGER NOT NULL
    );
  `);
  return sql;
}

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "operad-skills-e2e-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;

  // Build a fixture skill repo: tools + workflow + SKILL.md.
  fixtureRepo = mkdtempSync(join(tmpdir(), "operad-skills-e2e-repo-"));
  mkdirSync(join(fixtureRepo, ".operad"), { recursive: true });
  mkdirSync(join(fixtureRepo, "skills", "demo-skill"), { recursive: true });
  writeFileSync(
    join(fixtureRepo, ".operad", "operad.toml"),
    `[skill]
name = "e2e-fixture"
description = "End-to-end fixture skill for operad E.3"

[[tool]]
name = "e2e_echo"
description = "echo helper"
command = "echo {{msg}}"
  [[tool.params]]
  name = "msg"
  type = "string"
  required = true

[[workflow]]
name = "e2e-workflow"
  [[workflow.task]]
  id = "say"
  command = "echo hello from e2e"
`,
  );
  writeFileSync(
    join(fixtureRepo, "skills", "demo-skill", "SKILL.md"),
    `---\nname: demo-skill\ndescription: "E2E demo"\n---\nDemo SKILL.md body.\n`,
  );

  // git init + commit + tag.
  execSync(`git init -q && git add . && \
    git -c user.name=t -c user.email=t@t.co commit -q -m init && \
    git tag v0.1.0`, { cwd: fixtureRepo, stdio: "ignore" });

  // Wire daemon-side dependencies.
  memSql = setupDb();
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
  // Build a MemoryDb-shaped facade. The skills module only calls
  // .requireDb() plus methods we added in A1/A2; everything else is
  // stubbed.
  const MemoryDbCtor = (require("../memory-db.js") as any).MemoryDb;
  memDb = Object.create(MemoryDbCtor.prototype);
  memDb.requireDb = () => memSql;

  toolExecutor = new ToolExecutor(memDb, log);
  workflowEngine = new WorkflowEngine(memDb, log);
  const tracker = new ConsumerTracker(null);

  mgr = new SkillManager(memDb, log, {
    providers: { "git+url": gitUrlProvider } as Record<Provider, ProviderModule>,
    toolExecutor,
    workflowEngine,
    hasActiveConsumers: () => tracker.list(),
  });
});

afterAll(() => {
  if (originalHome != null) process.env.HOME = originalHome;
  else delete process.env.HOME;
  try { memSql.close(); } catch { /* ignore */ }
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(fixtureRepo, { recursive: true, force: true }); } catch { /* ignore */ }
});

// -- Test --------------------------------------------------------------------

describe("Phase E.3 end-to-end install/use/uninstall (git+url + real disk)", () => {
  test("install → list → tool registered → workflow registered → uninstall → cleaned up", async () => {
    // Pre-flight sanity.
    expect(toolExecutor.hasTool("e2e_echo")).toBe(false);
    expect(workflowEngine.get("e2e-workflow")).toBeNull();

    // ─ Install ─────────────────────────────────────────────────────
    const result = await mgr.install("git+url", fixtureRepo, "v0.1.0");
    expect(result.skill.name).toBe("e2e-fixture");
    expect(result.skill.trust_tier).toBe("escape");
    expect(result.skill.source.fetched_commit_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.skill.source.fetched_archive_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.skill.tools).toHaveLength(1);
    expect(result.skill.workflows).toHaveLength(1);
    expect(result.skill.skill_mds).toHaveLength(1);

    // ─ Tool registered in ToolExecutor ─────────────────────────────
    expect(toolExecutor.hasTool("e2e_echo")).toBe(true);
    const toolDef = toolExecutor.getTool("e2e_echo");
    expect(toolDef?.source).toBe("toml");

    // ─ Autonomy cap row written (escape tier → cap=suggest) ───────
    const capRow = memDb.getToolAutonomyCap("e2e_echo");
    expect(capRow).not.toBeNull();
    expect(capRow.max_bucket).toBe("suggest");
    expect(capRow.current_bucket).toBe("observe");

    // ─ Workflow registered in WorkflowEngine ───────────────────────
    const wf = workflowEngine.get("e2e-workflow");
    expect(wf).not.toBeNull();
    expect(wf?.spec.nodes).toHaveLength(1);

    // ─ list() and get() round-trip ─────────────────────────────────
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.get(result.skill.id)?.name).toBe("e2e-fixture");

    // ─ SKILL.md entry written to ~/.claude/settings.json ───────────
    const settingsPath = join(tmpHome, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(Array.isArray(settings.skills)).toBe(true);
    expect((settings.skills as string[]).some((p) => p.endsWith("demo-skill"))).toBe(true);

    // ─ Conflict rejection: re-install same id is no-op via UPSERT ──
    //   But a SECOND skill with the SAME tool name MUST be rejected.
    const conflictRepo = mkdtempSync(join(tmpdir(), "operad-skills-conflict-"));
    mkdirSync(join(conflictRepo, ".operad"), { recursive: true });
    writeFileSync(
      join(conflictRepo, ".operad", "operad.toml"),
      `[skill]\nname = "conflict-fixture"\n\n[[tool]]\nname = "e2e_echo"\ndescription = "different impl"\ncommand = "true"\n`,
    );
    execSync(`git init -q && git add . && \
      git -c user.name=t -c user.email=t@t.co commit -q -m init && \
      git tag v0.1.0`, { cwd: conflictRepo, stdio: "ignore" });
    await expect(mgr.install("git+url", conflictRepo, "v0.1.0"))
      .rejects.toThrow(/TOOL_NAME_CONFLICT/);
    rmSync(conflictRepo, { recursive: true, force: true });

    // ─ Lease cascade pre-flight: create an active lease, expect refuse ─
    const now = Math.floor(Date.now() / 1000);
    memSql.prepare(
      `INSERT INTO tool_leases (agent_name, tool_name, status, created_at)
       VALUES (?, ?, 'active', ?)`,
    ).run("agent-x", "e2e_echo", now);
    expect(() => mgr.uninstall(result.skill.id)).toThrow(/TOOL_HAS_ACTIVE_CONSUMERS/);

    // ─ Force-revoke clears the cascade and uninstalls ──────────────
    mgr.uninstall(result.skill.id, { force_revoke: true });

    // ─ Cleanup verified ────────────────────────────────────────────
    expect(toolExecutor.hasTool("e2e_echo")).toBe(false);
    expect(workflowEngine.get("e2e-workflow")).toBeNull();
    expect(memDb.getToolAutonomyCap("e2e_echo")).toBeNull();
    // Lease should now be revoked.
    const leaseStatus = memSql.prepare(
      `SELECT status FROM tool_leases WHERE tool_name = 'e2e_echo'`,
    ).get() as any;
    expect(leaseStatus.status).toBe("revoked");

    // ─ Uninstall event with cascade detail recorded ────────────────
    const ev = memSql.prepare(
      `SELECT detail FROM skill_events WHERE event_type = 'uninstall'`,
    ).get() as any;
    expect(ev).toBeDefined();
    const parsed = JSON.parse(ev.detail);
    expect(parsed.force_revoke_cascade?.leases?.length).toBeGreaterThanOrEqual(1);
  }, 30_000); // 30s — git clone of a tiny local repo is fast but be safe.

  test("INSTALL_BLOCKED_BY_ACTIVE_CONSUMER fires when a pin is held", async () => {
    // Re-install for this test.
    await mgr.install("git+url", fixtureRepo, "v0.1.0");

    const tracker2 = new ConsumerTracker(null);
    const release = tracker2.acquire("agent_cycle", "ooda-1");

    // Build a fresh mgr that uses tracker2 so we can hold a pin.
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
    const mgr2 = new SkillManager(memDb, log, {
      providers: { "git+url": gitUrlProvider } as Record<Provider, ProviderModule>,
      toolExecutor,
      workflowEngine,
      hasActiveConsumers: () => tracker2.list(),
    });

    await expect(mgr2.install("git+url", fixtureRepo, "v0.1.0"))
      .rejects.toThrow(/INSTALL_BLOCKED_BY_ACTIVE_CONSUMER/);

    release();
    // Cleanup the row we just installed.
    const installed = mgr.list();
    for (const s of installed) mgr.uninstall(s.id, { force_revoke: true });
  }, 30_000);
});
