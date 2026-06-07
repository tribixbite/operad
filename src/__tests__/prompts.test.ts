/**
 * prompts.test.ts — Unit tests for searchPrompts, starPrompt, unstarPrompt,
 * and getPromptProjects.
 *
 * Fixtures are written to a per-test temp dir via the _baseDir option so the
 * real ~/.claude/history.jsonl and ~/.local/share/tmx/prompts.json are never
 * touched.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import {
  searchPrompts,
  starPrompt,
  unstarPrompt,
  getPromptProjects,
  type PromptEntry,
  type PromptSearchResult,
} from "../prompts.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-prompts-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write lines to ~/.claude/history.jsonl inside tmpDir */
function writeHistory(lines: object[]): void {
  const claudeDir = join(tmpDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const content = lines.map(l => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(claudeDir, "history.jsonl"), content);
}

/** Build a minimal valid prompt line */
function mkLine(opts: {
  display: string;
  timestamp?: string;
  project?: string;
  sessionId?: string;
}): object {
  return {
    display: opts.display,
    timestamp: opts.timestamp ?? new Date(1_700_000_000_000).toISOString(),
    project: opts.project ?? "proj-a",
    sessionId: opts.sessionId,
  };
}

// ---------------------------------------------------------------------------
// Empty / missing file
// ---------------------------------------------------------------------------

describe("searchPrompts with missing history.jsonl", () => {
  test("returns empty result set when no history file exists", () => {
    const result = searchPrompts({ _baseDir: tmpDir });
    expect(result.prompts).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe("searchPrompts with empty history file", () => {
  test("returns empty result set for an empty file", () => {
    writeHistory([]);
    const result = searchPrompts({ _baseDir: tmpDir });
    expect(result.prompts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe("searchPrompts result shape", () => {
  test("each PromptEntry has the required fields", () => {
    writeHistory([
      mkLine({ display: "help me refactor this", project: "proj-a", sessionId: "sess-1" }),
    ]);
    const result = searchPrompts({ _baseDir: tmpDir });
    expect(result.prompts).toHaveLength(1);

    const entry: PromptEntry = result.prompts[0];
    expect(typeof entry.id).toBe("string");
    expect(entry.id).toHaveLength(16); // sha256 hex sliced to 16 chars
    expect(typeof entry.display).toBe("string");
    expect(entry.display).toBe("help me refactor this");
    expect(typeof entry.timestamp).toBe("number");
    expect(entry.project).toBe("proj-a");
    expect(entry.sessionId).toBe("sess-1");
    expect(typeof entry.starred).toBe("boolean");
    expect(entry.starred).toBe(false);

    // Pagination metadata
    expect(result.total).toBe(1);
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Ordering: most recent first
// ---------------------------------------------------------------------------

describe("searchPrompts ordering", () => {
  test("entries are sorted most-recent first", () => {
    const now = 1_700_000_000_000;
    writeHistory([
      mkLine({ display: "oldest",  timestamp: new Date(now - 200_000).toISOString() }),
      mkLine({ display: "newest",  timestamp: new Date(now).toISOString() }),
      mkLine({ display: "middle",  timestamp: new Date(now - 100_000).toISOString() }),
    ]);
    const result = searchPrompts({ _baseDir: tmpDir });
    expect(result.prompts[0].display).toBe("newest");
    expect(result.prompts[1].display).toBe("middle");
    expect(result.prompts[2].display).toBe("oldest");
  });
});

// ---------------------------------------------------------------------------
// Deduplication (same display text, different timestamps)
// ---------------------------------------------------------------------------

describe("searchPrompts deduplication", () => {
  test("duplicate display strings are collapsed to the most-recent entry", () => {
    const now = 1_700_000_000_000;
    writeHistory([
      mkLine({ display: "Do the thing", timestamp: new Date(now - 5000).toISOString() }),
      mkLine({ display: "Do the thing", timestamp: new Date(now).toISOString() }),          // newer
      mkLine({ display: "Different prompt", timestamp: new Date(now - 1000).toISOString() }),
    ]);
    const result = searchPrompts({ _baseDir: tmpDir });
    // Deduplication on lowercased display: only one "do the thing"
    const doTheThing = result.prompts.filter(p => p.display.toLowerCase() === "do the thing");
    expect(doTheThing).toHaveLength(1);
    // The kept entry is the most recent one (timestamp == now)
    expect(doTheThing[0].timestamp).toBe(now);
    expect(result.total).toBe(2);
  });

  test("case-insensitive dedup: 'Fix Bug' and 'fix bug' collapse to one", () => {
    const now = 1_700_000_000_000;
    writeHistory([
      mkLine({ display: "Fix Bug",  timestamp: new Date(now - 1000).toISOString() }),
      mkLine({ display: "fix bug",  timestamp: new Date(now).toISOString() }),
    ]);
    const result = searchPrompts({ _baseDir: tmpDir });
    expect(result.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Text search (q parameter)
// ---------------------------------------------------------------------------

describe("searchPrompts q filter", () => {
  test("q returns only entries whose display includes the substring", () => {
    writeHistory([
      mkLine({ display: "refactor the auth module" }),
      mkLine({ display: "add tests for payments" }),
      mkLine({ display: "refactor payment gateway" }),
    ]);
    const result = searchPrompts({ q: "refactor", _baseDir: tmpDir });
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts.every(p => p.display.includes("refactor"))).toBe(true);
  });

  test("q search is case-insensitive", () => {
    writeHistory([
      mkLine({ display: "Implement OAuth2 Login" }),
      mkLine({ display: "fix oauth token refresh" }),
    ]);
    const result = searchPrompts({ q: "oauth", _baseDir: tmpDir });
    expect(result.prompts).toHaveLength(2);
  });

  test("q with no match returns empty result", () => {
    writeHistory([mkLine({ display: "something completely unrelated" })]);
    const result = searchPrompts({ q: "zzznomatch", _baseDir: tmpDir });
    expect(result.prompts).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("empty q string returns all entries", () => {
    writeHistory([mkLine({ display: "a" }), mkLine({ display: "b" })]);
    const result = searchPrompts({ q: "", _baseDir: tmpDir });
    expect(result.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Project filter
// ---------------------------------------------------------------------------

describe("searchPrompts project filter", () => {
  test("project= returns only entries from that project", () => {
    writeHistory([
      mkLine({ display: "fix bug", project: "proj-a" }),
      mkLine({ display: "write docs", project: "proj-b" }),
      mkLine({ display: "add tests", project: "proj-a" }),
    ]);
    const result = searchPrompts({ project: "proj-a", _baseDir: tmpDir });
    expect(result.total).toBe(2);
    expect(result.prompts.every(p => p.project === "proj-a")).toBe(true);
  });

  test("project filter with no match returns empty", () => {
    writeHistory([mkLine({ display: "x", project: "proj-a" })]);
    const result = searchPrompts({ project: "nonexistent-proj", _baseDir: tmpDir });
    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pagination (limit + offset)
// ---------------------------------------------------------------------------

describe("searchPrompts pagination", () => {
  beforeEach(() => {
    const now = 1_700_000_000_000;
    writeHistory(
      Array.from({ length: 7 }, (_, i) =>
        mkLine({
          display: `prompt-${i}`,
          timestamp: new Date(now + i * 1000).toISOString(),
        }),
      ),
    );
  });

  test("limit restricts number of results", () => {
    const result = searchPrompts({ limit: 3, _baseDir: tmpDir });
    expect(result.prompts).toHaveLength(3);
    expect(result.total).toBe(7);
    expect(result.limit).toBe(3);
  });

  test("offset skips earlier pages", () => {
    const first = searchPrompts({ limit: 3, offset: 0, _baseDir: tmpDir });
    const second = searchPrompts({ limit: 3, offset: 3, _baseDir: tmpDir });
    // No overlap
    const firstIds = new Set(first.prompts.map(p => p.id));
    expect(second.prompts.every(p => !firstIds.has(p.id))).toBe(true);
  });

  test("offset beyond total returns empty prompts but correct total", () => {
    const result = searchPrompts({ offset: 100, _baseDir: tmpDir });
    expect(result.prompts).toHaveLength(0);
    expect(result.total).toBe(7);
    expect(result.offset).toBe(100);
  });

  test("default limit is 50", () => {
    const result = searchPrompts({ _baseDir: tmpDir });
    expect(result.limit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Malformed JSONL lines are skipped
// ---------------------------------------------------------------------------

describe("searchPrompts malformed-line resilience", () => {
  test("non-JSON lines are skipped without throwing", () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "history.jsonl"),
      [
        "not json at all",
        "{bad",
        JSON.stringify(mkLine({ display: "valid prompt" })),
        "",
        "another garbage line",
        JSON.stringify(mkLine({ display: "another valid" })),
      ].join("\n") + "\n",
    );

    let result: PromptSearchResult;
    expect(() => { result = searchPrompts({ _baseDir: tmpDir }); }).not.toThrow();
    // Only the two valid lines come through
    expect(result!.total).toBe(2);
  });

  test("lines missing display field are skipped", () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "history.jsonl"),
      [
        JSON.stringify({ timestamp: new Date().toISOString(), project: "p" }), // no display
        JSON.stringify(mkLine({ display: "keeps this one" })),
        JSON.stringify({ display: "  ", timestamp: new Date().toISOString(), project: "p" }), // whitespace-only display
      ].join("\n") + "\n",
    );
    const result = searchPrompts({ _baseDir: tmpDir });
    // Only the one with a non-empty display survives
    expect(result.total).toBe(1);
    expect(result.prompts[0].display).toBe("keeps this one");
  });

  test("completely empty file returns empty without throwing", () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "history.jsonl"), "");

    let result: PromptSearchResult;
    expect(() => { result = searchPrompts({ _baseDir: tmpDir }); }).not.toThrow();
    expect(result!.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Starring / unstarring
// ---------------------------------------------------------------------------

describe("starPrompt / unstarPrompt round-trip", () => {
  test("starred=false before star; starred=true after", () => {
    writeHistory([mkLine({ display: "implement caching" })]);

    const before = searchPrompts({ _baseDir: tmpDir });
    const id = before.prompts[0].id;
    expect(before.prompts[0].starred).toBe(false);

    starPrompt(id, tmpDir);

    const after = searchPrompts({ _baseDir: tmpDir });
    expect(after.prompts[0].starred).toBe(true);
  });

  test("unstar removes star; second unstar is a no-op returning false", () => {
    writeHistory([mkLine({ display: "run benchmark" })]);

    const result = searchPrompts({ _baseDir: tmpDir });
    const id = result.prompts[0].id;

    starPrompt(id, tmpDir);
    const wasDeleted = unstarPrompt(id, tmpDir);
    expect(wasDeleted).toBe(true);

    const afterUnstar = searchPrompts({ _baseDir: tmpDir });
    expect(afterUnstar.prompts[0].starred).toBe(false);

    // Second unstar is a no-op
    const deletedAgain = unstarPrompt(id, tmpDir);
    expect(deletedAgain).toBe(false);
  });

  test("starred=true filter returns only starred entries", () => {
    const now = 1_700_000_000_000;
    writeHistory([
      mkLine({ display: "will be starred",    timestamp: new Date(now).toISOString() }),
      mkLine({ display: "will not be starred", timestamp: new Date(now - 1000).toISOString() }),
    ]);

    const all = searchPrompts({ _baseDir: tmpDir });
    const toStar = all.prompts.find(p => p.display === "will be starred")!;
    starPrompt(toStar.id, tmpDir);

    const starredOnly = searchPrompts({ starred: true, _baseDir: tmpDir });
    expect(starredOnly.total).toBe(1);
    expect(starredOnly.prompts[0].display).toBe("will be starred");
  });

  test("starring persists across separate searchPrompts calls", () => {
    writeHistory([mkLine({ display: "persistent star test" })]);

    const first = searchPrompts({ _baseDir: tmpDir });
    const id = first.prompts[0].id;
    starPrompt(id, tmpDir);

    // Simulate a fresh call (same tmpDir, different JS call)
    const second = searchPrompts({ _baseDir: tmpDir });
    expect(second.prompts[0].starred).toBe(true);
  });

  test("starPrompt returns true", () => {
    expect(starPrompt("any-id-string", tmpDir)).toBe(true);
  });

  test("multiple stars on the same id are idempotent", () => {
    writeHistory([mkLine({ display: "stable star" })]);
    const result = searchPrompts({ _baseDir: tmpDir });
    const id = result.prompts[0].id;

    starPrompt(id, tmpDir);
    starPrompt(id, tmpDir);
    starPrompt(id, tmpDir);

    const after = searchPrompts({ starred: true, _baseDir: tmpDir });
    expect(after.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getPromptProjects
// ---------------------------------------------------------------------------

describe("getPromptProjects", () => {
  test("returns sorted unique project names", () => {
    writeHistory([
      mkLine({ display: "a", project: "zebra" }),
      mkLine({ display: "b", project: "apple" }),
      mkLine({ display: "c", project: "zebra" }),
      mkLine({ display: "d", project: "mango" }),
    ]);
    const projects = getPromptProjects(tmpDir);
    expect(projects).toEqual(["apple", "mango", "zebra"]); // sorted, deduped
  });

  test("returns empty array when no history file", () => {
    const projects = getPromptProjects(tmpDir);
    expect(projects).toEqual([]);
  });

  test("entries with no project field are excluded from the list", () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "history.jsonl"),
      [
        JSON.stringify({ display: "a prompt", timestamp: new Date().toISOString() }), // no project
        JSON.stringify(mkLine({ display: "b prompt", project: "named-proj" })),
      ].join("\n") + "\n",
    );
    const projects = getPromptProjects(tmpDir);
    expect(projects).toEqual(["named-proj"]);
  });
});

// ---------------------------------------------------------------------------
// Prompt ID determinism
// ---------------------------------------------------------------------------

describe("prompt ID determinism", () => {
  test("same display+timestamp always produces the same ID", () => {
    const line = mkLine({ display: "deterministic prompt", timestamp: "2024-01-01T00:00:00.000Z" });
    writeHistory([line]);

    const first = searchPrompts({ _baseDir: tmpDir });
    const id1 = first.prompts[0].id;

    // Reset cache bypass (different tmpDir would do it; here same tmpDir, same file, same stat)
    const second = searchPrompts({ _baseDir: tmpDir });
    expect(second.prompts[0].id).toBe(id1);
  });
});

// ---------------------------------------------------------------------------
// q + project combined filter
// ---------------------------------------------------------------------------

describe("searchPrompts combined filters", () => {
  test("q and project together are ANDed", () => {
    writeHistory([
      mkLine({ display: "refactor auth", project: "proj-a" }),
      mkLine({ display: "refactor payments", project: "proj-b" }),
      mkLine({ display: "add tests", project: "proj-a" }),
    ]);
    const result = searchPrompts({ q: "refactor", project: "proj-a", _baseDir: tmpDir });
    expect(result.total).toBe(1);
    expect(result.prompts[0].display).toBe("refactor auth");
  });
});
