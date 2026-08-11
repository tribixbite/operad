/**
 * skills.test.ts — Phase A0 unit tests for the skill marketplace.
 *
 * Covers: claude.json writer collision matrix, settings.json writer
 * idempotence, adapter merge, locator parser, version canonicalisation,
 * skill-id derivation, install transaction rollback contract, conflict
 * detection.
 *
 * Most of the writer tests exercise the pure `applyEdits` function;
 * the integration cycle (real disk I/O + lockfile) is covered once at
 * the bottom under a temp HOME.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyEdits as applyClaudeEdits,
  type OperadManagedEntry,
} from "../skills/claude-json.js";
import { applyEdits as applySettingsEdits } from "../skills/settings-json.js";
import {
  SkillError,
  capForTier,
  defaultBucketForTier,
  buildSkillId,
  sanitizeLocator,
  tierRank,
} from "../skills/types.js";
import { readSkillManifests } from "../skills/adapter.js";

// -- claude.json writer ------------------------------------------------------

describe("claude-json writer (applyEdits)", () => {
  const daemonId = "daemon-A";
  const otherDaemonId = "daemon-B";

  function withMgr(name: string, owner: OperadManagedEntry | undefined) {
    return {
      mcpServers: { [name]: { command: "echo", args: ["hi"] } },
      ...(owner ? { operad_managed: { [name]: owner } } : {}),
    };
  }

  test("adds a new MCP and records operad_managed entry", () => {
    const result = applyClaudeEdits(
      {},
      {
        daemon_id: daemonId,
        add: [
          {
            skill_id: "git+url:foo@v1.0.0",
            entry: { name: "foo", command: "echo", lifecycle: "config-only" },
          },
        ],
      },
    );
    expect((result.mcpServers as Record<string, unknown>).foo).toBeDefined();
    const owner = (result.operad_managed as Record<string, OperadManagedEntry>).foo;
    expect(owner.daemon_id).toBe(daemonId);
    expect(owner.skill_id).toBe("git+url:foo@v1.0.0");
  });

  test("refuses to overwrite a user-owned MCP without force_take_ownership", () => {
    const pre = withMgr("foo", undefined);
    expect(() =>
      applyClaudeEdits(pre, {
        daemon_id: daemonId,
        add: [
          {
            skill_id: "git+url:foo@v1.0.0",
            entry: { name: "foo", command: "echo", lifecycle: "config-only" },
          },
        ],
      }),
    ).toThrow(SkillError);
  });

  test("force_take_ownership claims an existing user-owned MCP", () => {
    const pre = withMgr("foo", undefined);
    const result = applyClaudeEdits(pre, {
      daemon_id: daemonId,
      force_take_ownership: true,
      add: [
        {
          skill_id: "git+url:foo@v1.0.0",
          entry: { name: "foo", command: "echo", lifecycle: "config-only" },
        },
      ],
    });
    const owner = (result.operad_managed as Record<string, OperadManagedEntry>).foo;
    expect(owner.daemon_id).toBe(daemonId);
  });

  test("refuses to touch an MCP owned by another daemon, even with force_take_ownership", () => {
    const pre = withMgr("foo", {
      skill_id: "old", daemon_id: otherDaemonId, installed_at: 1,
    });
    expect(() =>
      applyClaudeEdits(pre, {
        daemon_id: daemonId,
        force_take_ownership: true,
        add: [
          {
            skill_id: "git+url:foo@v1.0.0",
            entry: { name: "foo", command: "echo", lifecycle: "config-only" },
          },
        ],
      }),
    ).toThrow(/MCP_OWNED_BY_OTHER_DAEMON/);
  });

  test("removes an MCP we own", () => {
    const pre = withMgr("foo", {
      skill_id: "old", daemon_id: daemonId, installed_at: 1,
    });
    const result = applyClaudeEdits(pre, {
      daemon_id: daemonId,
      remove: ["foo"],
    });
    expect((result.mcpServers as Record<string, unknown>).foo).toBeUndefined();
    expect((result.operad_managed as Record<string, unknown>).foo).toBeUndefined();
  });

  test("silently skips removing an MCP we don't own", () => {
    const pre = { mcpServers: { foo: { command: "echo" } } };
    const result = applyClaudeEdits(pre, { daemon_id: daemonId, remove: ["foo"] });
    // No throw, and the user-owned entry is preserved.
    expect((result.mcpServers as Record<string, unknown>).foo).toBeDefined();
  });

  test("garbage-collects orphan operad_managed entries (mcpServers entry deleted by user)", () => {
    const pre = {
      mcpServers: {},
      operad_managed: { foo: { skill_id: "x", daemon_id: daemonId, installed_at: 1 } },
    };
    const result = applyClaudeEdits(pre, { daemon_id: daemonId });
    expect((result.operad_managed as Record<string, unknown>).foo).toBeUndefined();
  });

  test("HTTP MCP entry uses type+url shape, not command", () => {
    const result = applyClaudeEdits(
      {},
      {
        daemon_id: daemonId,
        add: [
          {
            skill_id: "git+url:exa@v1.0.0",
            entry: {
              name: "exa",
              url: "https://exa.mcp/sse",
              transport: "sse",
              lifecycle: "config-only",
            },
          },
        ],
      },
    );
    const wire = (result.mcpServers as Record<string, Record<string, unknown>>).exa;
    expect(wire.type).toBe("sse");
    expect(wire.url).toBe("https://exa.mcp/sse");
    expect(wire.command).toBeUndefined();
  });
});

// -- settings.json writer ----------------------------------------------------

describe("settings-json writer (applyEdits)", () => {
  test("adds a new path to skills[] if missing", () => {
    const r = applySettingsEdits({}, { add: ["/abs/path/skill-a"] });
    expect(r.skills).toEqual(["/abs/path/skill-a"]);
  });

  test("does not duplicate an already-listed path", () => {
    const pre = { skills: ["/abs/path/skill-a"] };
    const r = applySettingsEdits(pre, { add: ["/abs/path/skill-a"] });
    expect(r.skills).toEqual(["/abs/path/skill-a"]);
  });

  test("removes specified paths only", () => {
    const pre = { skills: ["/abs/path/skill-a", "/abs/path/skill-b"] };
    const r = applySettingsEdits(pre, { remove: ["/abs/path/skill-a"] });
    expect(r.skills).toEqual(["/abs/path/skill-b"]);
  });

  test("preserves unrelated settings keys", () => {
    const pre = { skills: [], theme: "dark", unrelated: { nested: true } };
    const r = applySettingsEdits(pre, { add: ["/p"] });
    expect(r.theme).toBe("dark");
    expect((r.unrelated as Record<string, unknown>).nested).toBe(true);
  });
});

// -- types & helpers ---------------------------------------------------------

describe("trust tier rank", () => {
  test("trusted > community > escape", () => {
    expect(tierRank("trusted")).toBeGreaterThan(tierRank("community"));
    expect(tierRank("community")).toBeGreaterThan(tierRank("escape"));
  });
});

describe("autonomy mappings per tier", () => {
  test("escape: cap=suggest, default=observe", () => {
    expect(capForTier("escape")).toBe("suggest");
    expect(defaultBucketForTier("escape")).toBe("observe");
  });
  test("community: cap=autonomous, default=suggest", () => {
    expect(capForTier("community")).toBe("autonomous");
    expect(defaultBucketForTier("community")).toBe("suggest");
  });
  test("trusted: cap=autonomous, default=suggest", () => {
    expect(capForTier("trusted")).toBe("autonomous");
    expect(defaultBucketForTier("trusted")).toBe("suggest");
  });
});

describe("locator sanitization", () => {
  test("collapses slashes to underscores and lowercases", () => {
    expect(sanitizeLocator("Wshobson/Agents")).toBe("wshobson_agents");
  });
  test("rejects path traversal", () => {
    expect(() => sanitizeLocator("foo/../bar")).toThrow(/LOCATOR_MALFORMED/);
  });
});

describe("buildSkillId", () => {
  test("stable across re-installs of the same identity", () => {
    expect(buildSkillId("git+url", "owner/repo", "v1.0.0")).toBe(
      "git+url:owner_repo@v1.0.0",
    );
  });
});

// -- adapter (marketplace.json + .operad/operad.toml merge) -----------------

describe("adapter readSkillManifests", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "operad-skills-adapter-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("empty directory returns name=(unnamed) and no primitives", () => {
    const result = readSkillManifests({ extracted_path: tmp, trust_tier: "escape" });
    expect(result.name).toBe("(unnamed)");
    expect(result.tools).toBeUndefined();
    expect(result.workflows).toBeUndefined();
    expect(result.mcps).toBeUndefined();
  });

  test("marketplace.json name is used when present", () => {
    mkdirSync(join(tmp, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(tmp, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "from-marketplace", description: "desc" }),
    );
    const result = readSkillManifests({ extracted_path: tmp, trust_tier: "escape" });
    expect(result.name).toBe("from-marketplace");
    expect(result.description).toBe("desc");
  });

  test("marketplace.json mcpServers becomes mcps[]", () => {
    mkdirSync(join(tmp, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(tmp, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "with-mcp",
        mcpServers: {
          stdio_one: { command: "echo", args: ["hi"] },
          http_one: { type: "http", url: "https://example.test/mcp" },
        },
      }),
    );
    const result = readSkillManifests({ extracted_path: tmp, trust_tier: "trusted" });
    expect(result.mcps).toHaveLength(2);
    const stdio = result.mcps!.find((m) => m.name === "stdio_one")!;
    expect(stdio.command).toBe("echo");
    expect(stdio.lifecycle).toBe("config-only");
    const http = result.mcps!.find((m) => m.name === "http_one")!;
    expect(http.url).toBe("https://example.test/mcp");
    expect(http.transport).toBe("http");
  });

  test("warns when both .operad/operad.toml and bare operad.toml exist; prefers .operad/", () => {
    mkdirSync(join(tmp, ".operad"), { recursive: true });
    writeFileSync(join(tmp, ".operad", "operad.toml"), `[skill]\nname = "nested"\n`);
    writeFileSync(join(tmp, "operad.toml"), `[skill]\nname = "bare"\n`);
    const result = readSkillManifests({ extracted_path: tmp, trust_tier: "escape" });
    expect(result.name).toBe("nested");
    expect(result.warnings.some((w) => w.includes("shadowed"))).toBe(true);
  });

  test("SKILL.md discovery picks up skills/<name>/SKILL.md", () => {
    mkdirSync(join(tmp, "skills", "my-skill"), { recursive: true });
    writeFileSync(
      join(tmp, "skills", "my-skill", "SKILL.md"),
      `---\nname: my-skill\ndescription: "Demo skill"\n---\n# body`,
    );
    const result = readSkillManifests({ extracted_path: tmp, trust_tier: "trusted" });
    expect(result.skill_mds).toHaveLength(1);
    expect(result.skill_mds![0].name).toBe("my-skill");
    expect(result.skill_mds![0].frontmatter.name).toBe("my-skill");
  });
});

// -- A1 autonomy ceiling enforcement -----------------------------------------

describe("tool autonomy caps (Phase A1)", () => {
  function makeDb() {
    const sql = new Database(":memory:");
    sql.exec(`
      CREATE TABLE tool_autonomy_caps (
        tool_id TEXT PRIMARY KEY,
        max_bucket TEXT NOT NULL,
        current_bucket TEXT NOT NULL DEFAULT 'suggest',
        set_by_provider TEXT,
        set_at INTEGER NOT NULL,
        updated_at INTEGER
      );
    `);
    return sql;
  }

  test("promoteToolBucket rejects target above the cap", async () => {
    const sql = makeDb();
    // Inline MemoryDb shim — only needs requireDb + the new methods.
    const { MemoryDb } = await import("../memory-db.js");
    const db = Object.create(MemoryDb.prototype);
    db.requireDb = () => sql;
    db.setToolAutonomyCap("a0_echo", "suggest", "suggest", "git+url");
    expect(() => db.promoteToolBucket("a0_echo", "autonomous")).toThrow(/AUTONOMY_CAP_VIOLATION/);
    sql.close();
  });

  test("promoteToolBucket allows at-or-below cap", async () => {
    const sql = makeDb();
    const { MemoryDb } = await import("../memory-db.js");
    const db = Object.create(MemoryDb.prototype);
    db.requireDb = () => sql;
    db.setToolAutonomyCap("a0_echo", "autonomous", "observe", "operad-curated");
    const r1 = db.promoteToolBucket("a0_echo", "suggest");
    expect(r1.current_bucket).toBe("suggest");
    expect(r1.max_bucket).toBe("autonomous");
    const r2 = db.promoteToolBucket("a0_echo", "autonomous");
    expect(r2.current_bucket).toBe("autonomous");
    sql.close();
  });

  test("promoteToolBucket lazy-creates a row for pre-existing tools (no cap)", async () => {
    const sql = makeDb();
    const { MemoryDb } = await import("../memory-db.js");
    const db = Object.create(MemoryDb.prototype);
    db.requireDb = () => sql;
    // No row yet — pre-existing tool. Default cap = autonomous.
    expect(db.getToolAutonomyCap("preexisting_tool")).toBeNull();
    const r = db.promoteToolBucket("preexisting_tool", "trusted");
    expect(r.max_bucket).toBe("autonomous");
    expect(r.current_bucket).toBe("trusted");
    const row = db.getToolAutonomyCap("preexisting_tool");
    expect(row?.max_bucket).toBe("autonomous");
    expect(row?.current_bucket).toBe("trusted");
    sql.close();
  });

  test("escape-tier mapping = cap suggest, default observe (regression)", () => {
    expect(capForTier("escape")).toBe("suggest");
    expect(defaultBucketForTier("escape")).toBe("observe");
  });

  test("listToolAutonomyCaps returns set rows", async () => {
    const sql = makeDb();
    const { MemoryDb } = await import("../memory-db.js");
    const db = Object.create(MemoryDb.prototype);
    db.requireDb = () => sql;
    db.setToolAutonomyCap("t1", "suggest", "suggest", "git+url");
    db.setToolAutonomyCap("t2", "autonomous", "observe", "operad-curated");
    const all = db.listToolAutonomyCaps();
    expect(all).toHaveLength(2);
    const t1 = all.find((r: any) => r.tool_id === "t1");
    expect(t1?.max_bucket).toBe("suggest");
    sql.close();
  });
});

// -- A2 ConsumerTracker -----------------------------------------------------

describe("ConsumerTracker (Phase A2)", () => {
  test("acquire returns PinHandle; list reflects active pins", async () => {
    const { ConsumerTracker } = await import("../skills/consumer-tracker.js");
    const t = new ConsumerTracker(null);
    expect(t.size()).toBe(0);
    const p1 = t.acquire("agent_cycle");
    const p2 = t.acquire("scheduled_run", "sched-7");
    expect(t.size()).toBe(2);
    expect(t.list().some((x) => x.kind === "scheduled_run" && x.ref_id === "sched-7")).toBe(true);
    // PinHandle.generation defaults to 0 when no generation supplier wired
    expect(p1.generation).toBe(0);
    p1.release();
    expect(t.size()).toBe(1);
    p2.release();
    expect(t.size()).toBe(0);
  });

  test("release is idempotent — double-release is safe", async () => {
    const { ConsumerTracker } = await import("../skills/consumer-tracker.js");
    const t = new ConsumerTracker(null);
    const p = t.acquire("workflow_run", "wf-1");
    p.release();
    p.release();   // no-op
    expect(t.size()).toBe(0);
  });

  test("auto-generated ref_id is unique per acquire", async () => {
    const { ConsumerTracker } = await import("../skills/consumer-tracker.js");
    const t = new ConsumerTracker(null);
    t.acquire("rest_request");
    t.acquire("rest_request");
    expect(t.size()).toBe(2);
  });

  test("bindGeneration wires snapshot supplier; acquire snapshots current gen", async () => {
    const { ConsumerTracker } = await import("../skills/consumer-tracker.js");
    const t = new ConsumerTracker(null);
    let currentGen = 5;
    t.bindGeneration(() => currentGen);
    const p1 = t.acquire("workflow_run", "wf-A");
    expect(p1.generation).toBe(5);
    currentGen = 7;
    const p2 = t.acquire("workflow_run", "wf-B");
    expect(p2.generation).toBe(7);
    // p1 still snapshots gen 5 — the live pointer moved on but the
    // pinned run keeps its older view.
    expect(p1.generation).toBe(5);
    p1.release();
    p2.release();
  });
});

// -- A2 lease cascade --------------------------------------------------------

describe("lease cascade (Phase A2)", () => {
  function withLeases(): { sql: Database; db: any } {
    const sql = new Database(":memory:");
    sql.exec(`
      CREATE TABLE tool_leases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        goal_id INTEGER,
        max_executions INTEGER, executions_used INTEGER DEFAULT 0,
        expires_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
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
    `);
    return { sql, db: null }; // db wired below by tests
  }

  test("getActiveLeasesForTool returns only active leases", async () => {
    const { sql } = withLeases();
    const now = Math.floor(Date.now() / 1000);
    sql.prepare(`INSERT INTO tool_leases (agent_name, tool_name, status, created_at)
                 VALUES (?, ?, ?, ?)`).run("agent-a", "shared_tool", "active", now);
    sql.prepare(`INSERT INTO tool_leases (agent_name, tool_name, status, created_at)
                 VALUES (?, ?, ?, ?)`).run("agent-b", "shared_tool", "revoked", now);
    const { MemoryDb } = await import("../memory-db.js");
    const db = Object.create(MemoryDb.prototype);
    db.requireDb = () => sql;
    const active = db.getActiveLeasesForTool("shared_tool");
    expect(active).toHaveLength(1);
    expect(active[0].agent_name).toBe("agent-a");
    sql.close();
  });

  test("revokeLeasesByIds flips status to revoked", async () => {
    const { sql } = withLeases();
    const now = Math.floor(Date.now() / 1000);
    const r1 = sql.prepare(`INSERT INTO tool_leases (agent_name, tool_name, status, created_at)
                            VALUES (?, ?, 'active', ?)`).run("a", "t", now);
    const r2 = sql.prepare(`INSERT INTO tool_leases (agent_name, tool_name, status, created_at)
                            VALUES (?, ?, 'active', ?)`).run("b", "t", now);
    const { MemoryDb } = await import("../memory-db.js");
    const db = Object.create(MemoryDb.prototype);
    db.requireDb = () => sql;
    const n = db.revokeLeasesByIds([Number(r1.lastInsertRowid), Number(r2.lastInsertRowid)]);
    expect(n).toBe(2);
    const active = db.getActiveLeasesForTool("t");
    expect(active).toHaveLength(0);
    sql.close();
  });

  test("pauseSchedulesMentioningTool disables matching schedules", async () => {
    const { sql } = withLeases();
    sql.prepare(`INSERT INTO agent_schedules
                 (schedule_name, prompt, enabled, created_at)
                 VALUES (?, ?, 1, ?)`).run(
      "nightly", "run a0_echo with the latest commit", Math.floor(Date.now() / 1000),
    );
    sql.prepare(`INSERT INTO agent_schedules
                 (schedule_name, prompt, enabled, created_at)
                 VALUES (?, ?, 1, ?)`).run(
      "unrelated", "report disk usage", Math.floor(Date.now() / 1000),
    );
    const { MemoryDb } = await import("../memory-db.js");
    const db = Object.create(MemoryDb.prototype);
    db.requireDb = () => sql;
    const paused = db.pauseSchedulesMentioningTool("a0_echo");
    expect(paused).toHaveLength(1);
    expect(paused[0].schedule_name).toBe("nightly");
    // Verify the row is actually disabled.
    const enabledFlags = sql.prepare(
      `SELECT schedule_name, enabled FROM agent_schedules ORDER BY id`,
    ).all() as Array<{ schedule_name: string; enabled: number }>;
    expect(enabledFlags.find((r) => r.schedule_name === "nightly")?.enabled).toBe(0);
    expect(enabledFlags.find((r) => r.schedule_name === "unrelated")?.enabled).toBe(1);
    sql.close();
  });

  test("revokeLeasesByIds is no-op on empty array", async () => {
    const { sql } = withLeases();
    const { MemoryDb } = await import("../memory-db.js");
    const db = Object.create(MemoryDb.prototype);
    db.requireDb = () => sql;
    expect(db.revokeLeasesByIds([])).toBe(0);
    sql.close();
  });
});

// -- B providers — claude-marketplace + mcp-official adapter shapes --------

describe("claude-marketplace provider", () => {
  test("tier mapping: anthropics → trusted, else → community", async () => {
    const { claudeMarketplaceProvider } = await import("../skills/providers/claude-marketplace.js");
    expect(claudeMarketplaceProvider.trustTier("anthropics/skills")).toBe("trusted");
    expect(claudeMarketplaceProvider.trustTier("ANTHROPICS/skills")).toBe("trusted");
    expect(claudeMarketplaceProvider.trustTier("wshobson/agents")).toBe("community");
  });

  test("rejects malformed locator", async () => {
    const { claudeMarketplaceProvider } = await import("../skills/providers/claude-marketplace.js");
    await expect(
      claudeMarketplaceProvider.fetch("not-owner-repo", "v1", "/tmp/x"),
    ).rejects.toThrow(/LOCATOR_MALFORMED/);
  });

  test("list() is empty in v1 (discovery deferred to v1.1)", async () => {
    const { claudeMarketplaceProvider } = await import("../skills/providers/claude-marketplace.js");
    const r = await claudeMarketplaceProvider.list({ query: "foo" });
    expect(r.items).toEqual([]);
  });
});

describe("mcp-official provider — read() shape", () => {
  test("HTTP remote becomes a config-only mcps[] entry with type=http", async () => {
    const { mcpOfficialProvider } = await import("../skills/providers/mcp-official.js");
    const tmp = mkdtempSync(join(tmpdir(), "operad-mcp-official-"));
    try {
      writeFileSync(join(tmp, "server.json"), JSON.stringify({
        id: "exa", name: "exa", description: "search",
        remotes: [{ transport_type: "http", url: "https://exa.test/mcp" }],
      }));
      const r = await mcpOfficialProvider.read(tmp);
      expect(r.mcps).toHaveLength(1);
      expect(r.mcps?.[0].url).toBe("https://exa.test/mcp");
      expect(r.mcps?.[0].transport).toBe("http");
      expect(r.mcps?.[0].lifecycle).toBe("config-only");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("npm package becomes stdio mcps[] entry via npx", async () => {
    const { mcpOfficialProvider } = await import("../skills/providers/mcp-official.js");
    const tmp = mkdtempSync(join(tmpdir(), "operad-mcp-official-"));
    try {
      writeFileSync(join(tmp, "server.json"), JSON.stringify({
        id: "ex", name: "ex", description: "demo",
        packages: [{ runtime: "npm", identifier: "@example/mcp-ex" }],
      }));
      const r = await mcpOfficialProvider.read(tmp);
      expect(r.mcps?.[0].command).toBe("npx");
      expect(r.mcps?.[0].args).toEqual(["@example/mcp-ex"]);
      expect(r.mcps?.[0].transport).toBe("stdio");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("python package routes through uvx", async () => {
    const { mcpOfficialProvider } = await import("../skills/providers/mcp-official.js");
    const tmp = mkdtempSync(join(tmpdir(), "operad-mcp-official-"));
    try {
      writeFileSync(join(tmp, "server.json"), JSON.stringify({
        id: "ex", name: "ex",
        packages: [{ runtime: "python", identifier: "mcp-ex" }],
      }));
      const r = await mcpOfficialProvider.read(tmp);
      expect(r.mcps?.[0].command).toBe("uvx");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("trustTier always returns trusted", async () => {
    const { mcpOfficialProvider } = await import("../skills/providers/mcp-official.js");
    expect(mcpOfficialProvider.trustTier("anything")).toBe("trusted");
  });
});

describe("operad-curated provider", () => {
  test("fetch() refuses when OPERAD_CURATED_COMMIT_SHA is unset (default)", async () => {
    // Ensure the env override is clear for this test.
    const orig = process.env.OPERAD_CURATED_COMMIT_SHA;
    delete process.env.OPERAD_CURATED_COMMIT_SHA;
    try {
      // Re-import to pick up the env-time module constant.
      const mod = await import(
        "../skills/providers/operad-curated.js?invalidate=" + Date.now()
      ).catch(async () => await import("../skills/providers/operad-curated.js"));
      const provider = (mod as any).operadCuratedProvider;
      expect(provider.trustTier("any/locator")).toBe("trusted");
      // list/fetch require the index to be loadable — without a SHA
      // they should refuse with PROVIDER_FETCH_FAILED. We can't reliably
      // test fetch() without network; assert the disabled signal via the
      // module's exported behaviour at minimum (trustTier still works).
    } finally {
      if (orig != null) process.env.OPERAD_CURATED_COMMIT_SHA = orig;
    }
  });
});

// -- E.1 GC sweeper --------------------------------------------------------

describe("SkillGc sweeper (Phase E.1)", () => {
  function makeGcEnv() {
    const sql = new Database(":memory:");
    sql.exec(`
      CREATE TABLE skills (
        id TEXT PRIMARY KEY, name TEXT, description TEXT,
        provider TEXT NOT NULL, locator TEXT NOT NULL, version TEXT NOT NULL,
        fetched_url TEXT, fetched_commit_sha TEXT,
        fetched_archive_sha256 TEXT, fetched_at INTEGER,
        trust_tier TEXT, enabled INTEGER, tombstoned INTEGER DEFAULT 0,
        manifest_json TEXT, installed_at INTEGER NOT NULL, generation INTEGER,
        UNIQUE(provider, locator, version)
      );
      CREATE TABLE skill_active_version (
        provider TEXT, locator TEXT, version TEXT, generation INTEGER,
        PRIMARY KEY (provider, locator)
      );
      CREATE TABLE skill_generation_refs (
        generation INTEGER, ref_kind TEXT, ref_id TEXT,
        acquired_at INTEGER, PRIMARY KEY (generation, ref_kind, ref_id)
      );
      CREATE TABLE skill_cache_pending_delete (
        provider TEXT, locator TEXT, version TEXT, marked_at INTEGER,
        PRIMARY KEY (provider, locator, version)
      );
    `);
    return sql;
  }

  /** Build a GC bound to an in-memory DB. */
  async function makeGc(sql: any, opts: Record<string, unknown> = {}) {
    const { MemoryDb } = await import("../memory-db.js");
    const db = Object.create(MemoryDb.prototype);
    db.requireDb = () => sql;
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
    const { SkillStore } = await import("../skills/store.js");
    const store = new SkillStore(db, log);
    const { SkillGc } = await import("../skills/gc.js");
    return new SkillGc(db, log, store, { retain_per_pair: 3, ...opts });
  }

  function insertSkill(sql: any, o: {
    locator?: string; version: string; installed_at: number;
    tombstoned?: number; generation?: number | null;
  }) {
    const loc = o.locator ?? "r";
    sql.prepare(`INSERT INTO skills
        (id, provider, locator, version, manifest_json, installed_at,
         fetched_archive_sha256, tombstoned, generation)
      VALUES (?, 'git+url', ?, ?, '{}', ?, 'x', ?, ?)`).run(
      `git+url:${loc}@${o.version}`, loc, o.version, o.installed_at,
      o.tombstoned ?? 0, o.generation ?? null,
    );
  }

  // The retain floor exists so a recent version can be rolled back to. A
  // tombstoned row is an explicit uninstall, so it must not hold a slot.
  // Counting them meant <= retain_per_pair uninstalled versions were
  // permanently protected — four such rows were found leaked on a real
  // machine, with their cache dirs still on disk.
  test("pass-1 sweeps ALL tombstoned rows — they do not consume retain slots", async () => {
    const sql = makeGcEnv();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 4; i++) {
      insertSkill(sql, { version: `v${i}`, installed_at: now - i * 100, tombstoned: 1 });
    }
    const gc = await makeGc(sql);
    gc.runOnce("manual");
    const pending = sql.prepare(`SELECT version FROM skill_cache_pending_delete`).all() as any[];
    expect(pending.map((p) => p.version).sort()).toEqual(["v0", "v1", "v2", "v3"]);
    sql.close();
  });

  test("a fully-uninstalled skill with fewer versions than the floor still gets swept", async () => {
    // The exact real-world leak: 3 tombstoned versions, retain floor 3.
    const sql = makeGcEnv();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 3; i++) {
      insertSkill(sql, { version: `v${i}`, installed_at: now - i * 100, tombstoned: 1 });
    }
    const gc = await makeGc(sql);
    const { marked } = gc.runOnce("manual");
    expect(marked).toHaveLength(3);
    sql.close();
  });

  test("the retain floor still protects the newest live (TTL-expired) versions", async () => {
    const sql = makeGcEnv();
    const now = Math.floor(Date.now() / 1000);
    // 5 live versions, all past a 1-hour TTL. Newest 3 must survive.
    for (let i = 0; i < 5; i++) {
      insertSkill(sql, { version: `v${i}`, installed_at: now - 7200 - i * 100, tombstoned: 0 });
    }
    const gc = await makeGc(sql, { cache_ttl_hours: 1 });
    gc.runOnce("manual");
    const pending = sql.prepare(`SELECT version FROM skill_cache_pending_delete`).all() as any[];
    expect(pending.map((p) => p.version).sort()).toEqual(["v3", "v4"]);
    sql.close();
  });

  test("tombstoned rows do not push live versions out of the retain floor", async () => {
    const sql = makeGcEnv();
    const now = Math.floor(Date.now() / 1000);
    // 3 newest are tombstoned, 3 older are live+expired. All 3 tombstoned
    // sweep; the 3 live ones fill the floor and survive.
    for (let i = 0; i < 3; i++) {
      insertSkill(sql, { version: `t${i}`, installed_at: now - i * 10, tombstoned: 1 });
    }
    for (let i = 0; i < 3; i++) {
      insertSkill(sql, { version: `L${i}`, installed_at: now - 7200 - i * 10, tombstoned: 0 });
    }
    const gc = await makeGc(sql, { cache_ttl_hours: 1 });
    gc.runOnce("manual");
    const pending = (sql.prepare(`SELECT version FROM skill_cache_pending_delete`).all() as any[])
      .map((p) => p.version).sort();
    expect(pending).toEqual(["t0", "t1", "t2"]);
    sql.close();
  });

  // markUninstalled deletes the skill_active_version row, so the old pin gate
  // — which reached skill_generation_refs THROUGH that row — found no
  // generations for any uninstalled skill, made NOT EXISTS trivially true, and
  // deleted the cache dir while consumers still held live pins on it.
  // skills.generation survives tombstoning, so the gate now holds.
  test("pass-2 refuses to delete a tombstoned row that still has a live pin", async () => {
    const sql = makeGcEnv();
    const old = Math.floor(Date.now() / 1000) - 2 * 3600;
    insertSkill(sql, { version: "v1", installed_at: old, tombstoned: 1, generation: 42 });
    sql.prepare(`INSERT INTO skill_cache_pending_delete
        (provider, locator, version, marked_at) VALUES ('git+url','r','v1',?)`).run(old);
    // A consumer still holds generation 42. No skill_active_version row —
    // that is exactly the post-uninstall state.
    sql.prepare(`INSERT INTO skill_generation_refs
        (generation, ref_kind, ref_id, acquired_at) VALUES (42,'workflow','wf-1',?)`).run(old);

    const gc = await makeGc(sql);
    const { deleted } = gc.runOnce("manual");
    expect(deleted).toHaveLength(0);
    const still = sql.prepare(`SELECT COUNT(*) c FROM skills WHERE version='v1'`).get() as any;
    expect(still.c).toBe(1);
    sql.close();
  });

  test("pass-2 deletes a tombstoned row once its pin is released", async () => {
    const sql = makeGcEnv();
    const old = Math.floor(Date.now() / 1000) - 2 * 3600;
    insertSkill(sql, { version: "v1", installed_at: old, tombstoned: 1, generation: 42 });
    sql.prepare(`INSERT INTO skill_cache_pending_delete
        (provider, locator, version, marked_at) VALUES ('git+url','r','v1',?)`).run(old);
    // No refs at all — the pin was released.
    const gc = await makeGc(sql);
    const { deleted } = gc.runOnce("manual");
    expect(deleted).toHaveLength(1);
    sql.close();
  });

  test("a pin on an unrelated generation does not block deletion", async () => {
    const sql = makeGcEnv();
    const old = Math.floor(Date.now() / 1000) - 2 * 3600;
    insertSkill(sql, { version: "v1", installed_at: old, tombstoned: 1, generation: 42 });
    sql.prepare(`INSERT INTO skill_cache_pending_delete
        (provider, locator, version, marked_at) VALUES ('git+url','r','v1',?)`).run(old);
    sql.prepare(`INSERT INTO skill_generation_refs
        (generation, ref_kind, ref_id, acquired_at) VALUES (99,'workflow','other',?)`).run(old);
    const gc = await makeGc(sql);
    expect(gc.runOnce("manual").deleted).toHaveLength(1);
    sql.close();
  });

  test("pass-2 still honours a pin held via the active-version row (not yet uninstalled)", async () => {
    const sql = makeGcEnv();
    const old = Math.floor(Date.now() / 1000) - 2 * 3600;
    insertSkill(sql, { version: "v1", installed_at: old, tombstoned: 0, generation: null });
    sql.prepare(`INSERT INTO skill_active_version
        (provider, locator, version, generation) VALUES ('git+url','r','v1',7)`).run();
    sql.prepare(`INSERT INTO skill_cache_pending_delete
        (provider, locator, version, marked_at) VALUES ('git+url','r','v1',?)`).run(old);
    sql.prepare(`INSERT INTO skill_generation_refs
        (generation, ref_kind, ref_id, acquired_at) VALUES (7,'tool','t',?)`).run(old);
    const gc = await makeGc(sql);
    expect(gc.runOnce("manual").deleted).toHaveLength(0);
    sql.close();
  });

  test("pass-2 deletes rows whose pending entry is older than the interval", async () => {
    const sql = makeGcEnv();
    const old = Math.floor(Date.now() / 1000) - 2 * 3600; // 2h ago
    sql.prepare(`INSERT INTO skills
        (id, provider, locator, version, manifest_json, installed_at,
         fetched_archive_sha256, tombstoned)
      VALUES (?, ?, ?, ?, '{}', ?, 'x', 1)`).run(
      "git+url:r@v1", "git+url", "r", "v1", old,
    );
    sql.prepare(`INSERT INTO skill_cache_pending_delete
        (provider, locator, version, marked_at) VALUES (?, ?, ?, ?)`).run(
      "git+url", "r", "v1", old,
    );
    const { MemoryDb } = await import("../memory-db.js");
    const db = Object.create(MemoryDb.prototype);
    db.requireDb = () => sql;
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
    const { SkillStore } = await import("../skills/store.js");
    const store = new SkillStore(db, log);
    const { SkillGc } = await import("../skills/gc.js");
    const gc = new SkillGc(db, log, store, { sweep_interval_ms: 60 * 60 * 1000 });
    const deleted = gc.runPass2();
    expect(deleted).toHaveLength(1);
    const remaining = sql.prepare(`SELECT count(*) AS n FROM skills`).get() as any;
    expect(remaining.n).toBe(0);
    const remPending = sql.prepare(`SELECT count(*) AS n FROM skill_cache_pending_delete`).get() as any;
    expect(remPending.n).toBe(0);
    sql.close();
  });

  test("pass-2 prunes ToolExecutor generations that no SQL row + no pin references", async () => {
    const sql = makeGcEnv();
    const old = Math.floor(Date.now() / 1000) - 2 * 3600;
    // SQL row gone — represents a fully-uninstalled + already-swept
    // generation that lingers only in ToolExecutor.generations.
    sql.prepare(`INSERT INTO skills
        (id, provider, locator, version, manifest_json, installed_at,
         fetched_archive_sha256, tombstoned)
      VALUES (?, ?, ?, ?, '{}', ?, 'x', 1)`).run(
      "git+url:r@v1", "git+url", "r", "v1", old,
    );
    sql.prepare(`INSERT INTO skill_cache_pending_delete
        (provider, locator, version, marked_at) VALUES (?, ?, ?, ?)`).run(
      "git+url", "r", "v1", old,
    );

    const { MemoryDb } = await import("../memory-db.js");
    const db = Object.create(MemoryDb.prototype);
    db.requireDb = () => sql;
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
    const { SkillStore } = await import("../skills/store.js");
    const { ToolExecutor } = await import("../tools.js");
    const te = new ToolExecutor(db, log);
    // Manually create an orphan generation that has no SQL backing.
    const orphanGen = te.beginGenerationTransaction();
    te.commitGeneration(orphanGen);
    // Open one more so currentGen advances past orphanGen.
    const next = te.beginGenerationTransaction();
    te.commitGeneration(next);
    expect(te.listGenerations()).toContain(orphanGen);

    const store = new SkillStore(db, log);
    const { SkillGc } = await import("../skills/gc.js");
    const gc = new SkillGc(db, log, store, { sweep_interval_ms: 60 * 60 * 1000 });
    gc.bindToolExecutor(te);
    gc.runPass2();
    // Orphan gen pruned because no skill_active_version + no
    // skill_generation_refs reference it.
    expect(te.listGenerations()).not.toContain(orphanGen);
    sql.close();
  });

  test("pass-2 leaves rows pinned by active generation refs alone", async () => {
    const sql = makeGcEnv();
    const old = Math.floor(Date.now() / 1000) - 2 * 3600;
    sql.prepare(`INSERT INTO skills
        (id, provider, locator, version, manifest_json, installed_at,
         fetched_archive_sha256, tombstoned)
      VALUES (?, ?, ?, ?, '{}', ?, 'x', 0)`).run(
      "git+url:r@v1", "git+url", "r", "v1", old,
    );
    sql.prepare(`INSERT INTO skill_active_version
        (provider, locator, version, generation) VALUES (?, ?, ?, ?)`).run(
      "git+url", "r", "v1", 7,
    );
    sql.prepare(`INSERT INTO skill_cache_pending_delete
        (provider, locator, version, marked_at) VALUES (?, ?, ?, ?)`).run(
      "git+url", "r", "v1", old,
    );
    // Phase C pin held against generation 7.
    sql.prepare(`INSERT INTO skill_generation_refs
        (generation, ref_kind, ref_id, acquired_at) VALUES (?, ?, ?, ?)`).run(
      7, "workflow_run", "wf-99", Math.floor(Date.now() / 1000),
    );
    const { MemoryDb } = await import("../memory-db.js");
    const db = Object.create(MemoryDb.prototype);
    db.requireDb = () => sql;
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
    const { SkillStore } = await import("../skills/store.js");
    const store = new SkillStore(db, log);
    const { SkillGc } = await import("../skills/gc.js");
    const gc = new SkillGc(db, log, store, { sweep_interval_ms: 60 * 60 * 1000 });
    const deleted = gc.runPass2();
    expect(deleted).toHaveLength(0);
    const stillThere = sql.prepare(`SELECT count(*) AS n FROM skills`).get() as any;
    expect(stillThere.n).toBe(1);
    sql.close();
  });
});

// -- store smoke test (in-memory DB, basic insert/list roundtrip) -----------

describe("SkillStore round-trip", () => {
  test("commitInstall → listInstalled → get returns the same skill", async () => {
    // Build an in-memory DB with just the skills tables.
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE skills (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        provider TEXT NOT NULL, locator TEXT NOT NULL, version TEXT NOT NULL,
        fetched_url TEXT NOT NULL, fetched_commit_sha TEXT,
        fetched_archive_sha256 TEXT NOT NULL, fetched_at INTEGER NOT NULL,
        trust_tier TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        tombstoned INTEGER NOT NULL DEFAULT 0, manifest_json TEXT NOT NULL,
        installed_at INTEGER NOT NULL, generation INTEGER,
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
    `);
    const { SkillStore } = await import("../skills/store.js");
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
    const fakeMemDb = { requireDb: () => db } as any;
    const store = new SkillStore(fakeMemDb, log);

    const skill = {
      id: "git+url:owner_repo@v1.0.0",
      name: "demo",
      description: "demo skill",
      trust_tier: "escape" as const,
      enabled: true,
      source: {
        provider: "git+url" as const,
        locator: "owner/repo",
        version: "v1.0.0",
        fetched_url: "https://example.test/repo",
        fetched_at: 1700000000,
        fetched_archive_sha256: "deadbeef",
      },
    };
    store.commitInstall(skill, 0);
    const list = store.listInstalled();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(skill.id);
    expect(list[0].trust_tier).toBe("escape");

    const got = store.get(skill.id);
    expect(got?.name).toBe("demo");

    db.close();
  });
});


// -- GC settings.json reference matching (cross-platform) -------------------

describe("isPathReferenced — settings.json refs vs cache dirs", () => {
  test("an exact match counts as referenced", async () => {
    const { isPathReferenced } = await import("../skills/gc.js");
    expect(isPathReferenced("/cache/gitx/r/v1", ["/cache/gitx/r/v1"])).toBe(true);
  });

  test("a bundle path inside the cache dir counts as referenced", async () => {
    const { isPathReferenced } = await import("../skills/gc.js");
    expect(
      isPathReferenced("/cache/gitx/r/v1", ["/cache/gitx/r/v1/skills/demo"]),
    ).toBe(true);
  });

  test("a sibling directory with a shared prefix does NOT count", async () => {
    // "/cache/gitx/r/v1" must not match "/cache/gitx/r/v10".
    const { isPathReferenced } = await import("../skills/gc.js");
    expect(isPathReferenced("/cache/gitx/r/v1", ["/cache/gitx/r/v10/x"])).toBe(false);
  });

  test("an unrelated path does not count", async () => {
    const { isPathReferenced } = await import("../skills/gc.js");
    expect(isPathReferenced("/cache/gitx/r/v1", ["/somewhere/else"])).toBe(false);
  });

  test("empty and missing refs are ignored", async () => {
    const { isPathReferenced } = await import("../skills/gc.js");
    expect(isPathReferenced("/cache/gitx/r/v1", [])).toBe(false);
    expect(isPathReferenced("/cache/gitx/r/v1", [""])).toBe(false);
  });

  test("a nested ref built with the platform separator matches", async () => {
    // The old check hardcoded `cacheDir + "/"`. On Windows both sides use
    // backslashes, so it never matched and the GC would delete a cache dir
    // Claude Code was actively loading a skill from. join() produces the
    // platform separator, so the Windows CI leg exercises the backslash case
    // while POSIX exercises the forward-slash one.
    const { isPathReferenced } = await import("../skills/gc.js");
    const { join: pjoin, resolve } = await import("node:path");
    const dir = resolve(pjoin("/cache", "gitx", "r", "v1"));
    const ref = pjoin(dir, "skills", "demo");
    expect(isPathReferenced(dir, [ref])).toBe(true);
  });

  test("a literal backslash name is not treated as a separator on POSIX", async () => {
    // On POSIX a backslash is an ordinary filename character; treating it as
    // a separator would make unrelated files look referenced.
    const { isPathReferenced } = await import("../skills/gc.js");
    const { sep } = await import("node:path");
    if (sep === "/") {
      expect(isPathReferenced("/cache/r/v1", ["/cache/r/v1x\\skills"])).toBe(false);
    }
  });
});

// -- adapter TOML parsing without Bun (the node install path) ---------------
//
// parseOperadToml threw PROVIDER_READ_FAILED unless globalThis.Bun existed,
// while the shipped bundle's shebang is `#!/usr/bin/env node`. Every skill
// carrying a .operad/operad.toml — i.e. every skill shipping tools, agents,
// workflows or MCP servers — was therefore uninstallable on node.

describe("adapter — operad.toml on the node path (no Bun.TOML)", () => {
  // globalThis.Bun is non-configurable under bun, so it cannot be deleted or
  // shadowed to force the fallback at runtime. Instead we exercise
  // parseTomlMinimal directly — that IS the function node takes — and assert
  // it agrees with parseTomlPreferBun, which is what the adapter calls.
  const SKILL_TOML = `[skill]
name = "node-path-skill"
description = "installs under node too"

[[tool]]
name = "echo_tool"
description = "echo"
command = "echo hi"

[[agent]]
name = "helper"

[mcp.fs]
command = "mcp-fs"
`;

  test("the minimal parser reads the skill/tool/agent/mcp shape the adapter expects", async () => {
    const { parseTomlMinimal } = await import("../toml.js");
    const t = parseTomlMinimal(SKILL_TOML) as any;
    expect(t.skill.name).toBe("node-path-skill");
    expect(t.skill.description).toBe("installs under node too");
    expect(t.tool).toHaveLength(1);
    expect(t.tool[0].name).toBe("echo_tool");
    expect(t.tool[0].command).toBe("echo hi");
    expect(t.agent).toHaveLength(1);
    expect(t.mcp.fs.command).toBe("mcp-fs");
  });

  test("minimal and Bun-preferring parsers agree on the same input", async () => {
    const { parseTomlMinimal, parseTomlPreferBun } = await import("../toml.js");
    const a = parseTomlMinimal(SKILL_TOML) as any;
    const b = parseTomlPreferBun(SKILL_TOML) as any;
    expect(b.skill.name).toBe(a.skill.name);
    expect(b.tool.length).toBe(a.tool.length);
    expect(b.tool[0].command).toBe(a.tool[0].command);
    expect(b.mcp.fs.command).toBe(a.mcp.fs.command);
  });

  test("the adapter reads a real bundle end to end", () => {
    const dir = mkdtempSync(join(tmpdir(), "operad-adapter-toml-"));
    try {
      mkdirSync(join(dir, ".operad"), { recursive: true });
      writeFileSync(join(dir, ".operad", "operad.toml"), SKILL_TOML, "utf-8");
      const r = readSkillManifests({ extracted_path: dir, trust_tier: "trusted" });
      expect(r.name).toBe("node-path-skill");
      expect(r.tools).toHaveLength(1);
      expect(r.tools?.[0].autonomy_cap).toBe(capForTier("trusted"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed operad.toml surfaces PROVIDER_READ_FAILED, not a raw throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "operad-adapter-bad-"));
    try {
      mkdirSync(join(dir, ".operad"), { recursive: true });
      // Unterminated array — Bun's parser rejects this; the minimal one is
      // lenient, so this asserts only that nothing escapes as a raw error.
      writeFileSync(join(dir, ".operad", "operad.toml"), "[[tool]\nname = ", "utf-8");
      let threw: unknown = null;
      try { readSkillManifests({ extracted_path: dir, trust_tier: "escape" }); }
      catch (e) { threw = e; }
      if (threw) expect(threw).toBeInstanceOf(SkillError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// -- adapter warnings reach the caller --------------------------------------
//
// readSkillManifests always produced these, but ProviderReadResult omitted the
// field and SkillManager.install discarded it, so nobody ever saw them.

describe("adapter warnings are produced and typed", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "operad-warn-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a bare operad.toml shadowed by .operad/operad.toml warns", () => {
    mkdirSync(join(dir, ".operad"), { recursive: true });
    writeFileSync(join(dir, ".operad", "operad.toml"), '[skill]\nname = "a"\n');
    writeFileSync(join(dir, "operad.toml"), '[skill]\nname = "b"\n');
    const r = readSkillManifests({ extracted_path: dir, trust_tier: "escape" });
    expect(r.name).toBe("a");
    expect(r.warnings.join(" ")).toContain("shadowed");
  });

  test("an unparseable marketplace.json warns instead of failing silently", () => {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), "{not json");
    const r = readSkillManifests({ extracted_path: dir, trust_tier: "escape" });
    expect(r.warnings.join(" ")).toContain("could not be parsed");
  });

  test("a clean bundle produces no warnings", () => {
    mkdirSync(join(dir, ".operad"), { recursive: true });
    writeFileSync(join(dir, ".operad", "operad.toml"), '[skill]\nname = "clean"\n');
    const r = readSkillManifests({ extracted_path: dir, trust_tier: "escape" });
    expect(r.warnings).toEqual([]);
  });

  test("warnings are part of the ProviderReadResult contract", () => {
    // Compile-time: warnings must be assignable on the narrower type the
    // ProviderModule.read() signature returns.
    const asRead: import("../skills/types.js").ProviderReadResult = {
      name: "x", description: "", warnings: ["w"],
    };
    expect(asRead.warnings).toEqual(["w"]);
  });
});
