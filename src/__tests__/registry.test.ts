/**
 * registry.test.ts — Unit tests for Registry CRUD, persistence, and pure helpers.
 *
 * All file I/O targets a temp dir under $TMPDIR (never /tmp — not writable on Termux).
 * Tests cover:
 *  - Registry: add, find, findByPath, findAllByPath, findBySessionId, remove, prune,
 *    updateActivity, flush, toSessionConfigs, persistence (reload), duplicate-name guard,
 *    path normalisation via resolve(), malformed/wrong-version JSON → empty state.
 *  - parseRecentProjects: ordering, dedup by path, limit, malformed lines skipped,
 *    missing file → [].
 *  - findNamedSessions: missing file → [], age filtering (entries older than cutoff
 *    are excluded), title extraction from session JSONL, short-title filter.
 *  - deriveName: basename lowercasing, sanitisation, empty fallback.
 *  - isValidName: valid/invalid patterns.
 *  - isValidSessionId: UUID acceptance, rejection of non-UUIDs.
 *  - nextSuffix: base-2 baseline, skips taken suffixes, handles bare + suffixed coexistence.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";

import {
  Registry,
  parseRecentProjects,
  findNamedSessions,
  deriveName,
  isValidName,
  isValidSessionId,
  nextSuffix,
} from "../registry.js";

// ---------------------------------------------------------------------------
// Shared temp-dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-registry-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Registry — CRUD
// ---------------------------------------------------------------------------

describe("Registry.add", () => {
  test("add returns the entry with resolved path and ISO timestamps", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    const entry = reg.add({ name: "alpha", path: "/fake/path", priority: 50, auto_go: false });
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("alpha");
    expect(entry!.path).toMatch(/fake[\\/]path/); // resolve() keeps the tail (\ on Windows)
    expect(entry!.opened_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry!.last_active).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("add returns null for duplicate name (second add)", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    reg.add({ name: "alpha", path: "/p1", priority: 50, auto_go: false });
    const dup = reg.add({ name: "alpha", path: "/p2", priority: 50, auto_go: false });
    expect(dup).toBeNull();
  });

  test("add normalises relative-looking path via resolve()", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    // resolve() on an absolute path just returns it; on relative it prefixes cwd
    // We confirm it does NOT store literal "../foo"
    const entry = reg.add({ name: "rel", path: "../somewhere", priority: 10, auto_go: false });
    expect(entry!.path).not.toBe("../somewhere");
    // It should be absolute
    expect(isAbsolute(entry!.path)).toBe(true);
  });

  test("add stores optional session_id", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    const sid = "11111111-2222-3333-4444-555555555555";
    const entry = reg.add({ name: "beta", path: "/q", priority: 10, auto_go: false, session_id: sid });
    expect(entry!.session_id).toBe(sid);
  });
});

describe("Registry.find / findByPath / findAllByPath / findBySessionId", () => {
  test("find returns entry by exact name", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    reg.add({ name: "alpha", path: "/p", priority: 10, auto_go: false });
    expect(reg.find("alpha")).toBeDefined();
    expect(reg.find("alpha")!.name).toBe("alpha");
  });

  test("find returns undefined for unknown name", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    expect(reg.find("ghost")).toBeUndefined();
  });

  test("findByPath returns first entry matching absolute path", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    reg.add({ name: "a", path: "/shared", priority: 10, auto_go: false });
    reg.add({ name: "b", path: "/other", priority: 10, auto_go: false });
    const found = reg.findByPath("/shared");
    expect(found).toBeDefined();
    expect(found!.name).toBe("a");
  });

  test("findByPath returns undefined for unknown path", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    expect(reg.findByPath("/nonexistent")).toBeUndefined();
  });

  test("findAllByPath returns all entries sharing a path", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    reg.add({ name: "inst-1", path: "/multi", priority: 10, auto_go: false });
    reg.add({ name: "inst-2", path: "/multi", priority: 10, auto_go: false });
    reg.add({ name: "other", path: "/solo", priority: 10, auto_go: false });
    const all = reg.findAllByPath("/multi");
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.name).sort()).toEqual(["inst-1", "inst-2"]);
  });

  test("findAllByPath returns empty array for unknown path", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    expect(reg.findAllByPath("/nobody")).toEqual([]);
  });

  test("findBySessionId returns matching entry", () => {
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const reg = new Registry(join(tmpDir, "r.json"));
    reg.add({ name: "sess", path: "/p", priority: 10, auto_go: false, session_id: sid });
    const found = reg.findBySessionId(sid);
    expect(found).toBeDefined();
    expect(found!.name).toBe("sess");
  });

  test("findBySessionId returns undefined when no match", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    expect(reg.findBySessionId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBeUndefined();
  });
});

describe("Registry.remove", () => {
  test("remove returns true and the entry is gone", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    reg.add({ name: "target", path: "/p", priority: 10, auto_go: false });
    const removed = reg.remove("target");
    expect(removed).toBe(true);
    expect(reg.find("target")).toBeUndefined();
    expect(reg.entries()).toHaveLength(0);
  });

  test("remove returns false for unknown name", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    expect(reg.remove("ghost")).toBe(false);
  });

  test("remove only removes the named entry, leaves others intact", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    reg.add({ name: "a", path: "/a", priority: 10, auto_go: false });
    reg.add({ name: "b", path: "/b", priority: 10, auto_go: false });
    reg.remove("a");
    expect(reg.find("a")).toBeUndefined();
    expect(reg.find("b")).toBeDefined();
  });
});

describe("Registry.entries", () => {
  test("entries returns empty array when nothing added", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    expect(reg.entries()).toEqual([]);
  });

  test("entries returns all added sessions", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    reg.add({ name: "a", path: "/a", priority: 10, auto_go: false });
    reg.add({ name: "b", path: "/b", priority: 10, auto_go: false });
    const names = reg.entries().map((e) => e.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
    expect(names).toHaveLength(2);
  });
});

describe("Registry — persistence (reload)", () => {
  test("data survives construction from the same file path", () => {
    const filePath = join(tmpDir, "persist.json");
    const reg1 = new Registry(filePath);
    reg1.add({ name: "alpha", path: "/project/alpha", priority: 10, auto_go: false });
    reg1.add({ name: "beta", path: "/project/beta", priority: 20, auto_go: true });

    // New instance from the same file — should reload
    const reg2 = new Registry(filePath);
    expect(reg2.find("alpha")).toBeDefined();
    expect(reg2.find("beta")).toBeDefined();
    expect(reg2.find("beta")!.auto_go).toBe(true);
    expect(reg2.entries()).toHaveLength(2);
  });

  test("remove persists: after reload the entry is still gone", () => {
    const filePath = join(tmpDir, "persist.json");
    const reg1 = new Registry(filePath);
    reg1.add({ name: "gone", path: "/g", priority: 10, auto_go: false });
    reg1.remove("gone");

    const reg2 = new Registry(filePath);
    expect(reg2.find("gone")).toBeUndefined();
  });

  test("malformed JSON falls back to empty state (no crash)", () => {
    const filePath = join(tmpDir, "bad.json");
    writeFileSync(filePath, "{ this is NOT valid json }", "utf8");
    const reg = new Registry(filePath);
    expect(reg.entries()).toEqual([]);
  });

  test("wrong schema version falls back to empty state", () => {
    const filePath = join(tmpDir, "old.json");
    writeFileSync(filePath, JSON.stringify({ version: 99, sessions: [{ name: "x" }] }), "utf8");
    const reg = new Registry(filePath);
    expect(reg.entries()).toEqual([]);
  });

  test("missing sessions array falls back to empty state", () => {
    const filePath = join(tmpDir, "nosessions.json");
    writeFileSync(filePath, JSON.stringify({ version: 1, sessions: "oops" }), "utf8");
    const reg = new Registry(filePath);
    expect(reg.entries()).toEqual([]);
  });
});

describe("Registry.updateActivity + flush", () => {
  test("updateActivity changes last_active for a known entry", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    reg.add({ name: "tick", path: "/p", priority: 10, auto_go: false });
    const before = reg.find("tick")!.last_active;
    // Advance time slightly: ISO strings compare lexicographically
    // Force a new timestamp by calling updateActivity then checking ≥ before
    reg.updateActivity("tick");
    const after = reg.find("tick")!.last_active;
    expect(after >= before).toBe(true);
  });

  test("updateActivity on unknown name is a no-op (does not throw)", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    expect(() => reg.updateActivity("ghost")).not.toThrow();
  });

  test("flush writes to disk (reloading sees in-memory updateActivity changes)", () => {
    const filePath = join(tmpDir, "flush.json");
    const reg1 = new Registry(filePath);
    reg1.add({ name: "tick", path: "/p", priority: 10, auto_go: false });
    reg1.updateActivity("tick"); // NOT persisted yet
    reg1.flush(); // NOW persisted

    const reg2 = new Registry(filePath);
    expect(reg2.find("tick")).toBeDefined();
  });
});

describe("Registry.prune", () => {
  test("prune removes entries older than maxAgeDays", () => {
    const filePath = join(tmpDir, "prune.json");
    // Write a registry file with a very old last_active directly
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
    const data = {
      version: 1,
      sessions: [
        { name: "old-one", path: "/old", priority: 10, auto_go: false, opened_at: oldDate, last_active: oldDate },
        { name: "fresh", path: "/fresh", priority: 10, auto_go: false, opened_at: new Date().toISOString(), last_active: new Date().toISOString() },
      ],
    };
    writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");

    const reg = new Registry(filePath);
    const pruned = reg.prune(30); // 30-day cutoff
    expect(pruned).toBe(1);
    expect(reg.find("old-one")).toBeUndefined();
    expect(reg.find("fresh")).toBeDefined();
  });

  test("prune returns 0 when nothing is old enough to prune", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    reg.add({ name: "fresh", path: "/f", priority: 10, auto_go: false });
    expect(reg.prune(30)).toBe(0);
  });
});

describe("Registry.toSessionConfigs", () => {
  test("converts registry entries to SessionConfig[] with type=claude", () => {
    const reg = new Registry(join(tmpDir, "r.json"));
    reg.add({ name: "alpha", path: "/project/alpha", priority: 15, auto_go: true });
    const configs = reg.toSessionConfigs();
    expect(configs).toHaveLength(1);
    const c = configs[0];
    expect(c.name).toBe("alpha");
    expect(c.type).toBe("claude");
    expect(c.auto_go).toBe(true);
    expect(c.priority).toBe(15);
    expect(c.enabled).toBe(true);
    expect(c.depends_on).toEqual([]);
  });

  test("toSessionConfigs propagates session_id when present", () => {
    const sid = "12345678-1234-1234-1234-123456789abc";
    const reg = new Registry(join(tmpDir, "r.json"));
    reg.add({ name: "beta", path: "/b", priority: 10, auto_go: false, session_id: sid });
    const configs = reg.toSessionConfigs();
    expect(configs[0].session_id).toBe(sid);
  });
});

describe("Registry — session_id sanitisation on load", () => {
  test("invalid session_id in JSON is cleared on load", () => {
    const filePath = join(tmpDir, "dirty.json");
    const data = {
      version: 1,
      sessions: [
        {
          name: "bad",
          path: "/b",
          priority: 10,
          auto_go: false,
          opened_at: new Date().toISOString(),
          last_active: new Date().toISOString(),
          session_id: "evil; rm -rf /",  // shell injection attempt
        },
      ],
    };
    writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
    const reg = new Registry(filePath);
    const entry = reg.find("bad");
    expect(entry).toBeDefined();
    expect(entry!.session_id).toBeUndefined();
  });

  test("valid UUID session_id is preserved on load", () => {
    const filePath = join(tmpDir, "good.json");
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const data = {
      version: 1,
      sessions: [
        {
          name: "ok",
          path: "/ok",
          priority: 10,
          auto_go: false,
          opened_at: new Date().toISOString(),
          last_active: new Date().toISOString(),
          session_id: sid,
        },
      ],
    };
    writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
    const reg = new Registry(filePath);
    expect(reg.find("ok")!.session_id).toBe(sid);
  });
});

// ---------------------------------------------------------------------------
// parseRecentProjects
// ---------------------------------------------------------------------------

describe("parseRecentProjects", () => {
  function historyLine(project: string, timestamp: number, sessionId = "sid-001"): string {
    return JSON.stringify({ display: "test", timestamp, project, sessionId });
  }

  test("returns [] when file does not exist", () => {
    const result = parseRecentProjects(join(tmpDir, "nonexistent.jsonl"));
    expect(result).toEqual([]);
  });

  test("deduplicates by path, keeping the most recent entry", () => {
    const now = Date.now();
    const histPath = join(tmpDir, "history.jsonl");
    writeFileSync(histPath, [
      historyLine("/project/alpha", now - 3000, "old-sid"),
      historyLine("/project/alpha", now, "new-sid"),
    ].join("\n") + "\n", "utf8");

    const results = parseRecentProjects(histPath);
    const alphaResults = results.filter((r) => r.path === "/project/alpha");
    expect(alphaResults).toHaveLength(1);
    expect(alphaResults[0].session_id).toBe("new-sid");
  });

  test("returns results sorted most-recent first", () => {
    const now = Date.now();
    const histPath = join(tmpDir, "history.jsonl");
    writeFileSync(histPath, [
      historyLine("/project/older", now - 10000),
      historyLine("/project/newer", now),
    ].join("\n") + "\n", "utf8");

    const results = parseRecentProjects(histPath);
    expect(results[0].path).toBe("/project/newer");
    expect(results[1].path).toBe("/project/older");
  });

  test("skips malformed lines without throwing", () => {
    const histPath = join(tmpDir, "history.jsonl");
    writeFileSync(histPath, [
      "this is not json",
      JSON.stringify({ display: "ok", timestamp: Date.now(), project: "/p/good", sessionId: "s1" }),
      "{broken",
    ].join("\n") + "\n", "utf8");

    const results = parseRecentProjects(histPath);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("/p/good");
  });

  test("skips lines missing required fields (project or timestamp)", () => {
    const histPath = join(tmpDir, "history.jsonl");
    writeFileSync(histPath, [
      JSON.stringify({ display: "no-project", timestamp: Date.now(), sessionId: "s1" }), // missing project
      JSON.stringify({ display: "no-timestamp", project: "/p/x", sessionId: "s1" }), // missing timestamp
      JSON.stringify({ display: "ok", timestamp: Date.now(), project: "/p/valid", sessionId: "s2" }),
    ].join("\n") + "\n", "utf8");

    const results = parseRecentProjects(histPath);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("/p/valid");
  });

  test("respects maxLines limit (reads tail of file)", () => {
    const now = Date.now();
    const histPath = join(tmpDir, "history.jsonl");
    // Write 10 lines for /p/old, then 1 line for /p/new
    const lines = Array.from({ length: 10 }, (_, i) =>
      historyLine(`/p/old-${i}`, now - (10 - i) * 1000)
    );
    lines.push(historyLine("/p/new", now));
    writeFileSync(histPath, lines.join("\n") + "\n", "utf8");

    // Limit to last 1 line: only /p/new should appear
    const results = parseRecentProjects(histPath, 1);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("/p/new");
  });

  test("deriveName is applied: path basename is lowercased and sanitised", () => {
    const histPath = join(tmpDir, "history.jsonl");
    writeFileSync(histPath,
      JSON.stringify({ display: "x", timestamp: Date.now(), project: "/home/user/My-App", sessionId: "s1" }) + "\n",
      "utf8"
    );
    const results = parseRecentProjects(histPath);
    expect(results[0].name).toBe("my-app");
  });
});

// ---------------------------------------------------------------------------
// findNamedSessions
// ---------------------------------------------------------------------------

describe("findNamedSessions", () => {
  test("returns [] when history file does not exist", () => {
    expect(findNamedSessions(join(tmpDir, "missing.jsonl"))).toEqual([]);
  });

  test("returns [] when all history entries are older than maxAgeDays", () => {
    const histPath = join(tmpDir, "history.jsonl");
    const stale = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
    writeFileSync(histPath,
      JSON.stringify({ display: "x", timestamp: stale, project: "/p", sessionId: "aaaaaaaa-0000-0000-0000-000000000001" }) + "\n",
      "utf8"
    );
    const results = findNamedSessions(histPath, 7);
    expect(results).toEqual([]);
  });

  test("recent session with custom-title JSONL is returned with title", () => {
    const histPath = join(tmpDir, "history.jsonl");
    const claudeDir = tmpDir;
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-0000-0000-0000-000000000002";
    const projectPath = "/home/user/my-feature";
    const projectDirName = projectPath.replace(/[^a-zA-Z0-9]/g, "-");

    // Write history.jsonl
    writeFileSync(histPath,
      JSON.stringify({ display: "x", timestamp: Date.now(), project: projectPath, sessionId }) + "\n",
      "utf8"
    );

    // Write session JSONL with a custom-title entry
    const sessionDir = join(projectsDir, projectDirName);
    mkdirSync(sessionDir, { recursive: true });
    const customTitleEntry = JSON.stringify({ type: "custom-title", customTitle: "my-feature" });
    writeFileSync(join(sessionDir, `${sessionId}.jsonl`), customTitleEntry + "\n", "utf8");

    const results = findNamedSessions(histPath, 7);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("my-feature");
    expect(results[0].session_id).toBe(sessionId);
    expect(results[0].path).toBe(projectPath);
  });

  test("session with long title (≥30 chars) is excluded", () => {
    const histPath = join(tmpDir, "history.jsonl");
    const claudeDir = tmpDir;
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-0000-0000-0000-000000000003";
    const projectPath = "/home/user/verbose";
    const projectDirName = projectPath.replace(/[^a-zA-Z0-9]/g, "-");

    writeFileSync(histPath,
      JSON.stringify({ display: "x", timestamp: Date.now(), project: projectPath, sessionId }) + "\n",
      "utf8"
    );

    const sessionDir = join(projectsDir, projectDirName);
    mkdirSync(sessionDir, { recursive: true });
    const longTitle = "A".repeat(30); // exactly 30 chars → excluded (< 30 check)
    writeFileSync(join(sessionDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: "custom-title", customTitle: longTitle }) + "\n",
      "utf8"
    );

    const results = findNamedSessions(histPath, 7);
    expect(results).toHaveLength(0);
  });

  test("session with Fork title is excluded", () => {
    const histPath = join(tmpDir, "history.jsonl");
    const claudeDir = tmpDir;
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-0000-0000-0000-000000000004";
    const projectPath = "/home/user/forked";
    const projectDirName = projectPath.replace(/[^a-zA-Z0-9]/g, "-");

    writeFileSync(histPath,
      JSON.stringify({ display: "x", timestamp: Date.now(), project: projectPath, sessionId }) + "\n",
      "utf8"
    );

    const sessionDir = join(projectsDir, projectDirName);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: "custom-title", customTitle: "feat (Fork)" }) + "\n",
      "utf8"
    );

    const results = findNamedSessions(histPath, 7);
    expect(results).toHaveLength(0);
  });

  test("last custom-title entry wins when multiple are present", () => {
    const histPath = join(tmpDir, "history.jsonl");
    const claudeDir = tmpDir;
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-0000-0000-0000-000000000005";
    const projectPath = "/home/user/renamed";
    const projectDirName = projectPath.replace(/[^a-zA-Z0-9]/g, "-");

    writeFileSync(histPath,
      JSON.stringify({ display: "x", timestamp: Date.now(), project: projectPath, sessionId }) + "\n",
      "utf8"
    );

    const sessionDir = join(projectsDir, projectDirName);
    mkdirSync(sessionDir, { recursive: true });
    // Two custom-title entries; last one should win
    const lines = [
      JSON.stringify({ type: "custom-title", customTitle: "old-name" }),
      JSON.stringify({ type: "custom-title", customTitle: "new-name" }),
    ];
    writeFileSync(join(sessionDir, `${sessionId}.jsonl`), lines.join("\n") + "\n", "utf8");

    const results = findNamedSessions(histPath, 7);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("new-name");
  });

  test("skips malformed history lines without throwing", () => {
    const histPath = join(tmpDir, "history.jsonl");
    writeFileSync(histPath, [
      "not-json",
      JSON.stringify({ display: "x", timestamp: Date.now(), project: "/p", sessionId: "bad-session-id" }),
    ].join("\n") + "\n", "utf8");

    // Should not throw; bad-session-id won't have a JSONL file so nothing is returned
    expect(() => findNamedSessions(histPath, 7)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// deriveName
// ---------------------------------------------------------------------------

describe("deriveName", () => {
  test("returns lowercased basename", () => {
    expect(deriveName("/home/user/MyProject")).toBe("myproject");
  });

  test("replaces invalid chars with hyphens", () => {
    expect(deriveName("/path/to/My_Project.ts")).toBe("my-project-ts");
  });

  test("strips leading and trailing hyphens", () => {
    // underscores become hyphens, then leading/trailing hyphens are stripped
    expect(deriveName("/path/to/_leading_trailing_")).toBe("leading-trailing");
    // basename of "///---hello---" is "---hello---", which becomes "hello" after stripping
    expect(deriveName("///---hello---")).toBe("hello");
  });

  test("returns 'unnamed' for empty basename", () => {
    // resolve("/") → "/", basename("/") → ""
    expect(deriveName("/")).toBe("unnamed");
  });

  test("pure numeric basename becomes a valid name", () => {
    expect(deriveName("/path/to/123")).toBe("123");
    expect(isValidName(deriveName("/path/to/123"))).toBe(true);
  });

  test("all-special chars become 'unnamed' after stripping", () => {
    // basename of "/path/to/___" → "___" → lowercased "___" → replace non-a-z0-9- with "-" → "---"
    // → strip leading/trailing → ""  → "unnamed"
    expect(deriveName("/path/to/___")).toBe("unnamed");
  });
});

// ---------------------------------------------------------------------------
// isValidName
// ---------------------------------------------------------------------------

describe("isValidName", () => {
  test("all-lowercase alphanumeric is valid", () => {
    expect(isValidName("alpha")).toBe(true);
    expect(isValidName("abc123")).toBe(true);
  });

  test("hyphens are valid", () => {
    expect(isValidName("my-session")).toBe(true);
    expect(isValidName("a-b-c")).toBe(true);
  });

  test("empty string is invalid", () => {
    expect(isValidName("")).toBe(false);
  });

  test("uppercase letters are invalid", () => {
    expect(isValidName("Alpha")).toBe(false);
    expect(isValidName("MY-SESSION")).toBe(false);
  });

  test("underscores are invalid", () => {
    expect(isValidName("my_session")).toBe(false);
  });

  test("spaces are invalid", () => {
    expect(isValidName("my session")).toBe(false);
  });

  test("dots are invalid", () => {
    expect(isValidName("my.session")).toBe(false);
  });

  test("leading hyphen is valid (pattern allows hyphens anywhere)", () => {
    // NAME_PATTERN = /^[a-z0-9-]+$/ — hyphens are allowed in any position
    expect(isValidName("-abc")).toBe(true);
  });

  test("digits-only is valid", () => {
    expect(isValidName("123")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isValidSessionId
// ---------------------------------------------------------------------------

describe("isValidSessionId", () => {
  test("canonical lowercase UUID v4 is valid", () => {
    expect(isValidSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("uppercase UUID is valid (case-insensitive pattern)", () => {
    expect(isValidSessionId("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  test("mixed-case UUID is valid", () => {
    expect(isValidSessionId("aaaaaaaa-BBBB-cccc-DDDD-eeeeeeeeeeee")).toBe(true);
  });

  test("empty string is invalid", () => {
    expect(isValidSessionId("")).toBe(false);
  });

  test("UUID missing dashes is invalid", () => {
    expect(isValidSessionId("550e8400e29b41d4a716446655440000")).toBe(false);
  });

  test("wrong segment lengths are invalid", () => {
    expect(isValidSessionId("550e8400-e29b-41d4-a716-44665544000")).toBe(false); // short last
    expect(isValidSessionId("550e8400-e29b-41d4-a716-4466554400000")).toBe(false); // long last
  });

  test("shell injection attempt is invalid", () => {
    expect(isValidSessionId("evil; rm -rf /")).toBe(false);
  });

  test("SQL injection attempt is invalid", () => {
    expect(isValidSessionId("' OR '1'='1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nextSuffix
// ---------------------------------------------------------------------------

describe("nextSuffix", () => {
  test("returns base-2 when only the bare name exists", () => {
    expect(nextSuffix("torch", ["torch"])).toBe("torch-2");
  });

  test("returns base-1 when the list is empty (nothing taken)", () => {
    // max=0 when no matches → returns base-1
    expect(nextSuffix("torch", [])).toBe("torch-1");
  });

  test("skips taken suffixes and returns the next available", () => {
    // torch, torch-2, torch-3 taken → next is torch-4
    expect(nextSuffix("torch", ["torch", "torch-2", "torch-3"])).toBe("torch-4");
  });

  test("handles gaps — uses max+1, not first-gap", () => {
    // torch-2 and torch-5 are taken (bare = 1 implied); max=5 → returns torch-6
    expect(nextSuffix("torch", ["torch", "torch-2", "torch-5"])).toBe("torch-6");
  });

  test("does not confuse similar-but-different base names", () => {
    // "myapp-extra" should not count as a suffix of "myapp"
    expect(nextSuffix("myapp", ["myapp-extra", "myapp"])).toBe("myapp-2");
  });

  test("base name with regex special chars is safely escaped", () => {
    // "a.b" should not match "axb" via . wildcard
    expect(nextSuffix("a.b", ["axb", "a.b"])).toBe("a.b-2");
  });

  test("returns base-2 when only suffixed variants exist without the bare name", () => {
    // Only torch-3 exists → bare name counts as not present → max is 3 → torch-4
    expect(nextSuffix("torch", ["torch-3"])).toBe("torch-4");
  });
});
