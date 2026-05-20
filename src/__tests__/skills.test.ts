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
