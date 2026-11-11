/**
 * skills-rollback.test.ts — install rollback must undo only what THIS
 * install created.
 *
 * Real git fixtures (local paths, no network), a real SkillManager,
 * ToolExecutor and WorkflowEngine over in-memory SQLite. HOME is never
 * mutated: ~/.claude.json, ~/.claude/settings.json and the GC go through
 * their explicit test seams, and node:os.homedir() (used by the skill cache
 * root and daemon-id) is interposed with mock.module and released in
 * afterAll.
 *
 * Covers:
 *  - a workflow that fails validation part-way through registration left
 *    the earlier workflows and tool cap rows behind → a permanent
 *    WORKFLOW_NAME_CONFLICT on every retry;
 *  - an upgrade (or same-version reinstall) that fails after registration
 *    deleted the PREVIOUS version's workflows, cap rows, settings.json
 *    SKILL.md paths and cache dir;
 *  - a failed `commit:<sha>` install never removed its cache dir because the
 *    rollback rebuilt the path with the raw `commit:` version.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string | undefined;
mock.module("node:os", () => {
  const real = require("node:os") as typeof import("node:os");
  return { ...real, homedir: () => tmpHome ?? real.homedir() };
});

import { SkillManager } from "../skills/index.js";
import { _setSettingsJsonHome } from "../skills/settings-json.js";
import { _setClaudeJsonHome } from "../skills/claude-json.js";
import { _setGcHome } from "../skills/gc.js";
import { gitUrlProvider } from "../skills/providers/git-url.js";
import type { Provider, ProviderModule, FetchResult, ProviderReadResult } from "../skills/types.js";
import { ToolExecutor } from "../tools.js";
import { WorkflowEngine } from "../workflow.js";

// -- fixtures ---------------------------------------------------------------

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
  `);
  return sql;
}

/** git with a throwaway identity and no signing. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t.co", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** operad.toml body: one tool, then the given [[workflow]] blocks. */
function manifest(skillName: string, tool: string, workflows: string): string {
  return `[skill]
name = "${skillName}"

[[tool]]
name = "${tool}"
description = "echo"
command = "echo {{x}}"
  [[tool.params]]
  name = "x"
  type = "string"
  required = true
${workflows}`;
}

const wf = (name: string, cmd: string, needs?: string) => `
[[workflow]]
name = "${name}"
  [[workflow.task]]
  id = "t1"
  command = "${cmd}"${needs ? `\n  needs = ["${needs}"]` : ""}
`;

/** Commit the given operad.toml (+ a SKILL.md) and tag it. Returns the commit sha. */
function commitVersion(repo: string, toml: string, tag?: string): string {
  mkdirSync(join(repo, ".operad"), { recursive: true });
  mkdirSync(join(repo, "skills", "doc"), { recursive: true });
  writeFileSync(join(repo, ".operad", "operad.toml"), toml);
  writeFileSync(join(repo, "skills", "doc", "SKILL.md"), `---\nname: doc\ndescription: "d"\n---\nbody\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", tag ?? "c");
  if (tag) git(repo, "tag", tag);
  return git(repo, "rev-parse", "HEAD").trim();
}

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "operad-rollback-repo-"));
  git(dir, "init", "-q");
  cleanup.push(dir);
  return dir;
}

const cleanup: string[] = [];

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "operad-rollback-home-"));
  _setSettingsJsonHome(tmpHome);
  _setClaudeJsonHome(tmpHome);
  _setGcHome(tmpHome);
});

afterAll(() => {
  _setSettingsJsonHome(null);
  _setClaudeJsonHome(null);
  _setGcHome(null);
  const home = tmpHome;
  // Release the homedir() interposition before deleting the directory, so
  // later test files in this process see the real home again.
  tmpHome = undefined;
  for (const d of [home, ...cleanup]) {
    if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});

function buildEnv(provider: ProviderModule = gitUrlProvider) {
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
  const sql = setupDb();
  const { MemoryDb } = require("../memory-db.js") as { MemoryDb: any };
  const memDb = Object.create(MemoryDb.prototype);
  memDb.requireDb = () => sql;
  const te = new ToolExecutor(memDb, log);
  const we = new WorkflowEngine(memDb, log);
  const mgr = new SkillManager(memDb, log, {
    providers: { "git+url": provider } as Record<Provider, ProviderModule>,
    toolExecutor: te,
    workflowEngine: we,
    hasActiveConsumers: () => [],
  });
  const cap = (tool: string) =>
    sql.prepare(`SELECT max_bucket, current_bucket FROM tool_autonomy_caps WHERE tool_id = ?`).get(tool) as
      { max_bucket: string; current_bucket: string } | null;
  const settingsSkills = (): string[] => {
    const p = join(tmpHome!, ".claude", "settings.json");
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).skills ?? []) : [];
  };
  return { sql, te, we, mgr, cap, settingsSkills };
}

/** Make the SQLite COMMIT step throw — a failure AFTER registration. */
function failCommit(mgr: SkillManager): void {
  (mgr.store as unknown as { commitInstall: () => void }).commitInstall = () => {
    throw new Error("injected commit failure");
  };
}

// -- tests ------------------------------------------------------------------

describe("install rollback — partial registration", () => {
  test("an invalid second workflow leaves nothing behind, and a fixed retry succeeds", async () => {
    const repo = newRepo();
    // `needs = ["ghost"]` → validateSpec: edge references unknown node.
    commitVersion(repo, manifest("partial", "partial_tool", wf("p-ok", "echo ok") + wf("p-bad", "echo bad", "ghost")), "v0.1.0");
    const env = buildEnv();

    await expect(env.mgr.install("git+url", repo, "v0.1.0")).rejects.toThrow();
    expect(env.we.get("p-ok")).toBeNull();
    expect(env.cap("partial_tool")).toBeNull();
    expect(env.te.hasTool("partial_tool")).toBe(false);

    // The orphan workflow used to make every retry fail with
    // WORKFLOW_NAME_CONFLICT, even once the manifest was fixed.
    commitVersion(repo, manifest("partial", "partial_tool", wf("p-ok", "echo ok")), "v0.1.1");
    const r = await env.mgr.install("git+url", repo, "v0.1.1");
    expect(r.skill.workflows).toHaveLength(1);
    expect(env.we.get("p-ok")).not.toBeNull();
    env.sql.close();
  }, 60_000);
});

describe("install rollback — upgrade failure keeps the previous version", () => {
  test("a failed upgrade restores the old workflow, cap row and settings path", async () => {
    const repo = newRepo();
    commitVersion(repo, manifest("upg", "upg_tool", wf("upg-wf", "echo v1")), "v0.1.0");
    const env = buildEnv();
    const v1 = await env.mgr.install("git+url", repo, "v0.1.0");
    const v1Path = v1.skill.skill_mds![0].bundle_path;
    const v1Spec = env.we.get("upg-wf")!.spec;
    expect(env.cap("upg_tool")).not.toBeNull();

    commitVersion(repo, manifest("upg", "upg_tool", wf("upg-wf", "echo v2")), "v0.2.0");
    failCommit(env.mgr);
    await expect(env.mgr.install("git+url", repo, "v0.2.0")).rejects.toThrow(/injected commit failure/);

    // The live (v1) skill's state must be exactly as before the attempt.
    const wfAfter = env.we.get("upg-wf");
    expect(wfAfter).not.toBeNull();
    expect(wfAfter!.spec).toEqual(v1Spec);
    expect(env.cap("upg_tool")).not.toBeNull();
    expect(env.te.hasTool("upg_tool")).toBe(true);
    expect(env.settingsSkills()).toContain(v1Path);
    expect(existsSync(v1Path)).toBe(true);
    env.sql.close();
  }, 60_000);

  test("a failed same-version reinstall keeps the live cache dir and settings path", async () => {
    const repo = newRepo();
    commitVersion(repo, manifest("same", "same_tool", wf("same-wf", "echo s")), "v0.1.0");
    const env = buildEnv();
    const first = await env.mgr.install("git+url", repo, "v0.1.0");
    const bundle = first.skill.skill_mds![0].bundle_path;

    failCommit(env.mgr);
    await expect(env.mgr.install("git+url", repo, "v0.1.0")).rejects.toThrow(/injected commit failure/);

    expect(existsSync(bundle)).toBe(true);
    expect(env.settingsSkills()).toContain(bundle);
    expect(env.we.get("same-wf")).not.toBeNull();
    expect(env.cap("same_tool")).not.toBeNull();
    env.sql.close();
  }, 60_000);
});

describe("install rollback — commit: versions", () => {
  test("a failed commit:<sha> install removes its own cache dir", async () => {
    const repo = newRepo();
    const sha = commitVersion(repo, manifest("csha", "csha_tool", ""));
    // Fetch succeeds for real; read() then fails, triggering rollback of the
    // fetch step.
    const failingRead: ProviderModule = {
      ...gitUrlProvider,
      fetch: (l: string, v: string, p: string): Promise<FetchResult> => gitUrlProvider.fetch(l, v, p),
      read: (): Promise<ProviderReadResult> => Promise.reject(new Error("injected read failure")),
    };
    const env = buildEnv(failingRead);
    const parent = env.mgr.store.cacheParent("git+url", repo);

    await expect(env.mgr.install("git+url", repo, `commit:${sha}`)).rejects.toThrow(/injected read failure/);
    // rollback joined cacheParent with the raw "commit:<sha>" version, which
    // is not the directory name the provider used ("commit-<sha>").
    const left = existsSync(parent) ? readdirSync(parent) : [];
    expect(left).toEqual([]);
    env.sql.close();
  }, 60_000);
});

/** Make the post-commit "install" event write throw — a failure AFTER SQLite COMMIT. */
function failInstallEvent(mgr: SkillManager): void {
  const store = mgr.store as unknown as { appendEvent: (id: string, type: string, detail: unknown) => void };
  const real = store.appendEvent.bind(store);
  store.appendEvent = (id, type, detail) => {
    if (type === "install") throw new Error("injected event failure");
    real(id, type, detail);
  };
}

describe("install rollback — failure after the SQLite commit", () => {
  // The sqlite step's rollback deleted the active-version pointer outright,
  // so an upgrade failing after COMMIT left the skill with NO active version,
  // and the committed generation stayed live.
  test("a failed upgrade restores the previous active version and tool generation", async () => {
    const repo = newRepo();
    commitVersion(repo, manifest("post", "post_tool", wf("post-wf", "echo v1")), "v0.1.0");
    const env = buildEnv();
    const v1 = await env.mgr.install("git+url", repo, "v0.1.0");
    const genBefore = env.te.getCurrentGeneration();

    commitVersion(repo, manifest("post", "post_tool", wf("post-wf", "echo v2")), "v0.2.0");
    failInstallEvent(env.mgr);
    await expect(env.mgr.install("git+url", repo, "v0.2.0")).rejects.toThrow(/injected event failure/);

    const active = env.mgr.store.getActive("git+url", repo);
    expect(active?.id).toBe(v1.skill.id);
    expect(active?.source.version).toBe("v0.1.0");
    expect(env.mgr.get(v1.skill.id)).not.toBeNull();
    const rows = env.sql.prepare(`SELECT id FROM skills`).all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([v1.skill.id]);
    expect(env.te.getCurrentGeneration()).toBe(genBefore);
    expect(env.te.hasTool("post_tool")).toBe(true);
    expect(JSON.stringify(env.we.get("post-wf")!.spec)).toContain("echo v1");
    env.sql.close();
  }, 60_000);

  test("a failed same-version reinstall keeps the skill row and active pointer", async () => {
    const repo = newRepo();
    commitVersion(repo, manifest("post2", "post2_tool", ""), "v0.1.0");
    const env = buildEnv();
    const first = await env.mgr.install("git+url", repo, "v0.1.0");

    failInstallEvent(env.mgr);
    await expect(env.mgr.install("git+url", repo, "v0.1.0")).rejects.toThrow(/injected event failure/);

    expect(env.mgr.store.getActive("git+url", repo)?.id).toBe(first.skill.id);
    expect(env.mgr.get(first.skill.id)).not.toBeNull();
    env.sql.close();
  }, 60_000);

  test("a failed fresh install still leaves no row and no active pointer", async () => {
    const repo = newRepo();
    commitVersion(repo, manifest("post3", "post3_tool", ""), "v0.1.0");
    const env = buildEnv();
    const genBefore = env.te.getCurrentGeneration();
    failInstallEvent(env.mgr);
    await expect(env.mgr.install("git+url", repo, "v0.1.0")).rejects.toThrow(/injected event failure/);
    expect(env.mgr.store.getActive("git+url", repo)).toBeNull();
    expect((env.sql.prepare(`SELECT count(*) AS n FROM skills`).get() as { n: number }).n).toBe(0);
    expect(env.te.getCurrentGeneration()).toBe(genBefore);
    expect(env.te.hasTool("post3_tool")).toBe(false);
    env.sql.close();
  }, 60_000);
});

describe("install rollback — MCP entries taken over with force_take_ownership", () => {
  // The take-over overwrote the user's own ~/.claude.json entry; rollback
  // then removed it entirely instead of putting the user's entry back.
  test("the user's original entry is restored and a new entry is removed", async () => {
    const cjPath = join(tmpHome!, ".claude.json");
    const userEntry = { command: "user-own-server", args: ["--flag"] };
    writeFileSync(cjPath, JSON.stringify({ mcpServers: { user_mcp: userEntry }, unrelated: 1 }, null, 2));

    const repo = newRepo();
    commitVersion(
      repo,
      manifest("mcpskill", "mcp_tool", "") +
        `\n[mcp.user_mcp]\ncommand = "skill-server"\n\n[mcp.fresh_mcp]\ncommand = "fresh-server"\n`,
      "v0.1.0",
    );
    const env = buildEnv();
    failCommit(env.mgr);
    await expect(env.mgr.install("git+url", repo, "v0.1.0", { force_take_ownership: true }))
      .rejects.toThrow(/injected commit failure/);

    const after = JSON.parse(readFileSync(cjPath, "utf8"));
    expect(after.mcpServers.user_mcp).toEqual(userEntry);
    expect(after.mcpServers.fresh_mcp).toBeUndefined();
    expect(after.operad_managed?.user_mcp).toBeUndefined();
    expect(after.operad_managed?.fresh_mcp).toBeUndefined();
    expect(after.unrelated).toBe(1);
    env.sql.close();
  }, 60_000);
});
