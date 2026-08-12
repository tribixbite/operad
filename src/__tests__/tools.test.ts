/**
 * tools.test.ts — Unit tests for tools.ts (ToolExecutor + built-in tools)
 *
 * Covers:
 *  - ToolExecutor registry: register, unregister, lookup, duplicate handling
 *  - Generation transactions: begin/commit/abort/prune, generation isolation
 *  - TOML tool parsing and registration
 *  - isAutoApproved: every level × category boundary
 *  - validateParams (via execute): missing required, wrong types
 *  - getAvailableTools: category filter, source filter
 *  - formatToolsForPrompt: empty set, category grouping, source tags
 *  - isAllowedPath / isProtectedFile (exercised via file-read / file-write)
 *  - Built-in tool behaviours: file-read, file-list, file-write, system-status,
 *    session-output, session-send — all against temp directories.
 *  - ToolProvider lifecycle: initialize, shutdown, error resilience
 *  - TOML tool: placeholder substitution, missing name/command skipped
 *  - execute(): unknown tool, validation failure, audit log entry
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ToolExecutor, isAllowedPath, isProtectedFile } from "../tools.js";
import type {
  ToolDef,
  ToolContext,
  ToolCategory,
  ToolSource,
  TomlToolConfig,
  ToolProvider,
} from "../tools.js";
import type { AutonomyLevel } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal in-memory MemoryDb shim — only the methods tools.ts calls */
function makeDb(): any {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE tool_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT, tool_name TEXT, tool_category TEXT,
      params_json TEXT, result_success INTEGER, result_summary TEXT,
      side_effects TEXT, duration_ms INTEGER, approval TEXT, error TEXT,
      executed_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT, category TEXT, content TEXT,
      relevance_score REAL DEFAULT 0.5,
      created_at INTEGER DEFAULT (unixepoch())
    );
  `);

  return {
    _sql: sql,
    logToolExecution(entry: any): number {
      const r = sql.prepare(`
        INSERT INTO tool_executions
          (agent_name, tool_name, tool_category, params_json, result_success,
           result_summary, side_effects, duration_ms, approval, error)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(
        entry.agent_name, entry.tool_name, entry.tool_category,
        entry.params_json, entry.result_success ? 1 : 0,
        entry.result_summary ?? null,
        entry.side_effects ? JSON.stringify(entry.side_effects) : null,
        entry.duration_ms ?? null, entry.approval ?? "auto", entry.error ?? null,
      );
      return (r as any).lastInsertRowid ?? 0;
    },
    searchMemories(project: string, query: string, limit: number): any[] {
      return sql.prepare(
        `SELECT id, category, content, relevance_score FROM memories
         WHERE project_path = ? OR ? = '*' LIMIT ?`,
      ).all(project, project, limit);
    },
    createMemory(project: string, category: string, content: string): number {
      const r = sql.prepare(
        `INSERT INTO memories (project_path, category, content) VALUES (?,?,?)`,
      ).run(project, category, content);
      return (r as any).lastInsertRowid;
    },
    updateGoal(_id: number, _opts: any): void { /* stub — not tested here */ },
    close() { sql.close(); },
    getToolExecutions(agent?: string, limit = 50): any[] {
      if (agent) {
        return sql.prepare(
          `SELECT * FROM tool_executions WHERE agent_name = ? ORDER BY id DESC LIMIT ?`,
        ).all(agent, limit);
      }
      return sql.prepare(`SELECT * FROM tool_executions ORDER BY id DESC LIMIT ?`).all(limit);
    },
  };
}

/** Minimal logger shim */
const silentLog: any = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

/** Resolve home the same way the source's isAllowedPath does — $HOME first,
 *  os.homedir() as a fallback. Needed because os.homedir() caches its first
 *  result process-wide, so a sibling test file that relocates HOME can leave
 *  homedir() pointing at a deleted temp dir; reading $HOME at call time keeps
 *  the test's path construction aligned with the source's allow-check. */
function resolveHome(): string {
  return process.env.HOME || homedir();
}

/** Build a minimal ToolContext for tests that need one */
function makeCtx(db: any, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentName: "test-agent",
    cwd: resolveHome(),
    db,
    log: silentLog,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A minimal valid ToolDef factory */
function makeTool(name: string, category: ToolCategory = "observe"): ToolDef {
  return {
    name,
    description: `Test tool ${name}`,
    category,
    params: [],
    timeout_ms: 5_000,
    parallelizable: true,
    execute: async () => ({
      success: true, data: null, summary: "ok", sideEffects: [], duration_ms: 1,
    }),
  };
}

// ---------------------------------------------------------------------------
// Temp directory lifecycle
// ---------------------------------------------------------------------------

let tmp: string;
let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  // Fixtures MUST live under $HOME so isAllowedPath() accepts them. On this
  // Termux host os.tmpdir() happens to resolve under $HOME, but on CI it's
  // /tmp (Linux) or %TEMP% (Windows) — outside the home-based allow-list — so
  // using tmpdir() here made the file-read/write/list tests pass only locally.
  tmp = mkdtempSync(join(resolveHome(), ".operad-tools-test-"));
  db = makeDb();
});

afterEach(() => {
  try { db.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Registry: register / unregister / lookup
// ---------------------------------------------------------------------------

describe("ToolExecutor registry", () => {
  test("newly created executor has builtin tools registered", () => {
    const ex = new ToolExecutor(db, silentLog);
    const all = ex.getAllTools();
    expect(all.length).toBeGreaterThan(0);
    // Spot-check a few builtins
    expect(ex.hasTool("file-read")).toBe(true);
    expect(ex.hasTool("file-list")).toBe(true);
    expect(ex.hasTool("file-write")).toBe(true);
    expect(ex.hasTool("system-status")).toBe(true);
    expect(ex.hasTool("session-output")).toBe(true);
    expect(ex.hasTool("session-send")).toBe(true);
    expect(ex.hasTool("grep-search")).toBe(true);
    expect(ex.hasTool("memory-search")).toBe(true);
    expect(ex.hasTool("memory-create")).toBe(true);
    expect(ex.hasTool("git-status")).toBe(true);
    expect(ex.hasTool("git-log")).toBe(true);
  });

  test("getTool returns undefined for unknown tool", () => {
    const ex = new ToolExecutor(db, silentLog);
    expect(ex.getTool("definitely-does-not-exist")).toBeUndefined();
  });

  test("hasTool returns false for unknown tool", () => {
    const ex = new ToolExecutor(db, silentLog);
    expect(ex.hasTool("no-such-tool")).toBe(false);
  });

  test("register then getTool round-trips", () => {
    const ex = new ToolExecutor(db, silentLog);
    ex.register(makeTool("my-custom-tool", "analyze"));
    const got = ex.getTool("my-custom-tool");
    expect(got).toBeDefined();
    expect(got!.category).toBe("analyze");
  });

  test("register sets source=builtin when source is omitted", () => {
    const ex = new ToolExecutor(db, silentLog);
    const def = makeTool("sourceless");
    delete (def as any).source;
    ex.register(def);
    expect(ex.getTool("sourceless")!.source).toBe("builtin");
  });

  test("unregister removes an existing tool and returns true", () => {
    const ex = new ToolExecutor(db, silentLog);
    ex.register(makeTool("removable"));
    expect(ex.hasTool("removable")).toBe(true);
    expect(ex.unregister("removable")).toBe(true);
    expect(ex.hasTool("removable")).toBe(false);
  });

  test("unregister returns false for a nonexistent tool (idempotent)", () => {
    const ex = new ToolExecutor(db, silentLog);
    expect(ex.unregister("ghost-tool")).toBe(false);
  });

  test("duplicate register overwrites and emits a warning (but does not throw)", () => {
    const warnings: string[] = [];
    const log = { ...silentLog, warn: (m: string) => warnings.push(m) };
    const ex = new ToolExecutor(db, log);
    ex.register(makeTool("dupe-tool", "observe"));
    ex.register(makeTool("dupe-tool", "analyze")); // second registration
    // No throw; latest wins
    expect(ex.getTool("dupe-tool")!.category).toBe("analyze");
    expect(warnings.some((w) => w.includes("dupe-tool"))).toBe(true);
  });

  test("getAllTools returns all registered tools as an array", () => {
    const ex = new ToolExecutor(db, silentLog);
    const builtinCount = ex.getAllTools().length;
    ex.register(makeTool("extra-1", "mutate"));
    ex.register(makeTool("extra-2", "communicate"));
    expect(ex.getAllTools().length).toBe(builtinCount + 2);
  });

  test("getToolsBySource filters correctly", () => {
    const ex = new ToolExecutor(db, silentLog);
    const def: ToolDef = { ...makeTool("toml-t"), source: "toml" };
    ex.register(def);
    const tomlTools = ex.getToolsBySource("toml");
    expect(tomlTools.every((t) => t.source === "toml")).toBe(true);
    expect(tomlTools.some((t) => t.name === "toml-t")).toBe(true);
    // Built-ins are not included
    expect(ex.getToolsBySource("builtin").every((t) => t.source === "builtin")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generation transactions
// ---------------------------------------------------------------------------

describe("generation transactions", () => {
  test("initial generation is 0", () => {
    const ex = new ToolExecutor(db, silentLog);
    expect(ex.getCurrentGeneration()).toBe(0);
    expect(ex.listGenerations()).toContain(0);
  });

  test("beginGenerationTransaction increments generation", () => {
    const ex = new ToolExecutor(db, silentLog);
    const g1 = ex.beginGenerationTransaction();
    expect(g1).toBe(1);
    const g2 = ex.beginGenerationTransaction();
    expect(g2).toBe(2);
  });

  test("commitGeneration advances live pointer", () => {
    const ex = new ToolExecutor(db, silentLog);
    const g = ex.beginGenerationTransaction();
    ex.commitGeneration(g);
    expect(ex.getCurrentGeneration()).toBe(g);
  });

  test("committed generation inherits all tools from live at begin time", () => {
    const ex = new ToolExecutor(db, silentLog);
    ex.register(makeTool("pre-existing"));
    const g = ex.beginGenerationTransaction();
    // New generation clones live; pre-existing tool should be visible
    expect(ex.hasTool("pre-existing", g)).toBe(true);
    ex.commitGeneration(g);
  });

  test("tool registered in pending gen is isolated from live until commit", () => {
    const ex = new ToolExecutor(db, silentLog);
    const g = ex.beginGenerationTransaction();
    ex.register(makeTool("pending-only"), g);
    // Not visible in live gen before commit
    expect(ex.hasTool("pending-only")).toBe(false);
    // Visible in pending gen
    expect(ex.hasTool("pending-only", g)).toBe(true);
    ex.commitGeneration(g);
    // Now visible in live
    expect(ex.hasTool("pending-only")).toBe(true);
  });

  test("abortGeneration discards the pending map", () => {
    const ex = new ToolExecutor(db, silentLog);
    const g = ex.beginGenerationTransaction();
    ex.register(makeTool("doomed"), g);
    ex.abortGeneration(g);
    // Generation should be gone
    expect(ex.listGenerations()).not.toContain(g);
    // Tool never surfaces
    expect(ex.hasTool("doomed")).toBe(false);
  });

  test("abortGeneration is idempotent on an already-aborted gen", () => {
    const ex = new ToolExecutor(db, silentLog);
    const g = ex.beginGenerationTransaction();
    ex.abortGeneration(g);
    // No throw on second call
    expect(() => ex.abortGeneration(g)).not.toThrow();
  });

  test("commitGeneration throws for unknown generation", () => {
    const ex = new ToolExecutor(db, silentLog);
    expect(() => ex.commitGeneration(999)).toThrow(/not pending/);
  });

  test("pruneGeneration deletes an old generation map", () => {
    const ex = new ToolExecutor(db, silentLog);
    const g = ex.beginGenerationTransaction();
    ex.commitGeneration(g);
    // Gen 0 is no longer live — prune it
    expect(ex.pruneGeneration(0)).toBe(true);
    expect(ex.listGenerations()).not.toContain(0);
  });

  test("pruneGeneration refuses to delete the live generation", () => {
    const ex = new ToolExecutor(db, silentLog);
    const live = ex.getCurrentGeneration();
    expect(ex.pruneGeneration(live)).toBe(false);
    expect(ex.listGenerations()).toContain(live);
  });

  test("pruneGeneration returns false for pending (in-flight) generation", () => {
    const ex = new ToolExecutor(db, silentLog);
    const g = ex.beginGenerationTransaction();
    // Must not prune pending gen
    expect(ex.pruneGeneration(g)).toBe(false);
    ex.abortGeneration(g);
  });

  test("old generation keeps its own tool snapshot after live advances", () => {
    const ex = new ToolExecutor(db, silentLog);
    // gen 0 = live at this point with builtins
    const g1 = ex.beginGenerationTransaction();
    ex.register(makeTool("gen1-only"), g1);
    ex.commitGeneration(g1); // live = g1

    // g1 has gen1-only; gen 0 does not
    expect(ex.hasTool("gen1-only", g1)).toBe(true);
    expect(ex.hasTool("gen1-only", 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TOML tool registration
// ---------------------------------------------------------------------------

describe("registerTomlTools", () => {
  test("registers a valid TOML tool with correct metadata", () => {
    const ex = new ToolExecutor(db, silentLog);
    const config: TomlToolConfig[] = [{
      name: "toml-echo",
      description: "Echo something",
      command: "echo hello",
      category: "observe",
      timeout_ms: 10_000,
    }];
    ex.registerTomlTools(config);
    const t = ex.getTool("toml-echo");
    expect(t).toBeDefined();
    expect(t!.source).toBe("toml");
    expect(t!.sourceId).toBe("toml:toml-echo");
    expect(t!.category).toBe("observe");
    expect(t!.timeout_ms).toBe(10_000);
  });

  test("TOML tool defaults category to analyze when omitted", () => {
    const ex = new ToolExecutor(db, silentLog);
    ex.registerTomlTools([{ name: "no-cat", description: "d", command: "echo" }]);
    expect(ex.getTool("no-cat")!.category).toBe("analyze");
  });

  test("TOML tool with missing name is silently skipped", () => {
    const warnings: string[] = [];
    const log = { ...silentLog, warn: (m: string) => warnings.push(m) };
    const ex = new ToolExecutor(db, log);
    const before = ex.getAllTools().length;
    ex.registerTomlTools([{ name: "", description: "d", command: "echo" }]);
    expect(ex.getAllTools().length).toBe(before); // nothing added
    expect(warnings.some((w) => w.includes("missing name or command"))).toBe(true);
  });

  test("TOML tool with missing command is silently skipped", () => {
    const warnings: string[] = [];
    const log = { ...silentLog, warn: (m: string) => warnings.push(m) };
    const ex = new ToolExecutor(db, log);
    const before = ex.getAllTools().length;
    ex.registerTomlTools([{ name: "bad-tool", description: "d", command: "" }]);
    expect(ex.getAllTools().length).toBe(before);
    expect(warnings.some((w) => w.includes("missing name or command"))).toBe(true);
  });

  test("TOML tool substitutes {{param}} placeholders in command", async () => {
    const ex = new ToolExecutor(db, silentLog);
    ex.registerTomlTools([{
      name: "greet",
      description: "Greet user",
      command: "echo Hello {{name}}",
      params: [{ name: "name", type: "string", required: true, description: "Name" }],
    }]);
    const ctx = makeCtx(db);
    const result = await ex.getTool("greet")!.execute({ name: "World" }, ctx);
    expect(result.success).toBe(true);
    expect(result.summary).toContain("World");
  });

  test("TOML tool params are parsed correctly", () => {
    const ex = new ToolExecutor(db, silentLog);
    ex.registerTomlTools([{
      name: "paramtest",
      description: "d",
      command: "echo {{x}}",
      params: [
        { name: "x", type: "number", required: true, description: "A number" },
        { name: "y", required: false, description: "Optional" },
      ],
    }]);
    const t = ex.getTool("paramtest")!;
    expect(t.params[0].type).toBe("number");
    expect(t.params[0].required).toBe(true);
    expect(t.params[1].required).toBe(false);
    expect(t.params[1].type).toBe("string"); // default type
  });

  test("multiple TOML tools registered in one call", () => {
    const ex = new ToolExecutor(db, silentLog);
    ex.registerTomlTools([
      { name: "t1", description: "d1", command: "echo 1" },
      { name: "t2", description: "d2", command: "echo 2" },
    ]);
    expect(ex.hasTool("t1")).toBe(true);
    expect(ex.hasTool("t2")).toBe(true);
  });

  test("TOML tools can be registered into a pending generation", () => {
    const ex = new ToolExecutor(db, silentLog);
    const g = ex.beginGenerationTransaction();
    ex.registerTomlTools([{ name: "pending-toml", description: "d", command: "echo" }], g);
    expect(ex.hasTool("pending-toml")).toBe(false);
    expect(ex.hasTool("pending-toml", g)).toBe(true);
    ex.abortGeneration(g);
  });
});

// ---------------------------------------------------------------------------
// isAutoApproved: category × autonomy level boundaries
// ---------------------------------------------------------------------------

describe("isAutoApproved — autonomy level gating", () => {
  // Category privilege order: observe(0) < analyze(1) < mutate(2) < communicate(3) < orchestrate(4)

  const cats: ToolCategory[] = ["observe", "analyze", "mutate", "communicate", "orchestrate"];

  test("observe level: only observe category is auto-approved", () => {
    const ex = new ToolExecutor(db, silentLog);
    expect(ex.isAutoApproved("any", "observe", "observe")).toBe(true);
    expect(ex.isAutoApproved("any", "analyze", "observe")).toBe(false);
    expect(ex.isAutoApproved("any", "mutate", "observe")).toBe(false);
    expect(ex.isAutoApproved("any", "communicate", "observe")).toBe(false);
    expect(ex.isAutoApproved("any", "orchestrate", "observe")).toBe(false);
  });

  test("suggest level: observe + analyze auto-approved", () => {
    const ex = new ToolExecutor(db, silentLog);
    expect(ex.isAutoApproved("any", "observe", "suggest")).toBe(true);
    expect(ex.isAutoApproved("any", "analyze", "suggest")).toBe(true);
    expect(ex.isAutoApproved("any", "mutate", "suggest")).toBe(false);
    expect(ex.isAutoApproved("any", "communicate", "suggest")).toBe(false);
    expect(ex.isAutoApproved("any", "orchestrate", "suggest")).toBe(false);
  });

  test("supervised level: observe + analyze auto-approved (same as suggest)", () => {
    const ex = new ToolExecutor(db, silentLog);
    expect(ex.isAutoApproved("any", "observe", "supervised")).toBe(true);
    expect(ex.isAutoApproved("any", "analyze", "supervised")).toBe(true);
    expect(ex.isAutoApproved("any", "mutate", "supervised")).toBe(false);
    expect(ex.isAutoApproved("any", "communicate", "supervised")).toBe(false);
    expect(ex.isAutoApproved("any", "orchestrate", "supervised")).toBe(false);
  });

  test("trusted level: observe + analyze + mutate auto-approved", () => {
    const ex = new ToolExecutor(db, silentLog);
    expect(ex.isAutoApproved("any", "observe", "trusted")).toBe(true);
    expect(ex.isAutoApproved("any", "analyze", "trusted")).toBe(true);
    expect(ex.isAutoApproved("any", "mutate", "trusted")).toBe(true);
    expect(ex.isAutoApproved("any", "communicate", "trusted")).toBe(false);
    expect(ex.isAutoApproved("any", "orchestrate", "trusted")).toBe(false);
  });

  test("autonomous level: all categories auto-approved", () => {
    const ex = new ToolExecutor(db, silentLog);
    for (const cat of cats) {
      expect(ex.isAutoApproved("any", cat, "autonomous")).toBe(true);
    }
  });

  test("unknown/default autonomy level falls back to observe-only approval", () => {
    const ex = new ToolExecutor(db, silentLog);
    // Simulate unknown level via type cast
    const unknown = "nonexistent-level" as AutonomyLevel;
    expect(ex.isAutoApproved("any", "observe", unknown)).toBe(true);
    expect(ex.isAutoApproved("any", "analyze", unknown)).toBe(false);
  });

  test("protected tool is never auto-approved regardless of autonomy level", () => {
    const ex = new ToolExecutor(db, silentLog);
    const checkpoints = { protected_files: [], protected_git: [], protected_tools: ["file-write"] };
    // Even at autonomous level, protected tool requires approval
    expect(ex.isAutoApproved("file-write", "mutate", "autonomous", checkpoints)).toBe(false);
    // Without protection, autonomous approves everything
    expect(ex.isAutoApproved("file-write", "mutate", "autonomous")).toBe(true);
  });

  test("non-listed tool is unaffected by protected_tools list", () => {
    const ex = new ToolExecutor(db, silentLog);
    const checkpoints = { protected_files: [], protected_git: [], protected_tools: ["dangerous-tool"] };
    // file-read is not protected, trusted level approves observe
    expect(ex.isAutoApproved("file-read", "observe", "trusted", checkpoints)).toBe(true);
  });

  test("omitting autonomyLevel defaults to observe-only approval", () => {
    const ex = new ToolExecutor(db, silentLog);
    expect(ex.isAutoApproved("any", "observe")).toBe(true);
    expect(ex.isAutoApproved("any", "analyze")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAvailableTools: filtering
// ---------------------------------------------------------------------------

describe("getAvailableTools", () => {
  test("no filters returns all tools", () => {
    const ex = new ToolExecutor(db, silentLog);
    expect(ex.getAvailableTools()).toEqual(ex.getAllTools());
  });

  test("category filter restricts to matching categories only", () => {
    const ex = new ToolExecutor(db, silentLog);
    const observed = ex.getAvailableTools(["observe"]);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((t) => t.category === "observe")).toBe(true);
  });

  test("multiple category filter is a union, not intersection", () => {
    const ex = new ToolExecutor(db, silentLog);
    const multi = ex.getAvailableTools(["observe", "analyze"]);
    expect(multi.every((t) => t.category === "observe" || t.category === "analyze")).toBe(true);
  });

  test("empty category filter returns all tools", () => {
    const ex = new ToolExecutor(db, silentLog);
    expect(ex.getAvailableTools([])).toHaveLength(ex.getAllTools().length);
  });

  test("source filter restricts to matching sources only", () => {
    const ex = new ToolExecutor(db, silentLog);
    const tomlDef: ToolDef = { ...makeTool("src-filter-test"), source: "toml" };
    ex.register(tomlDef);
    const tomlOnly = ex.getAvailableTools(undefined, ["toml"]);
    expect(tomlOnly.every((t) => t.source === "toml")).toBe(true);
    expect(tomlOnly.some((t) => t.name === "src-filter-test")).toBe(true);
    // Builtins should not appear
    expect(tomlOnly.some((t) => t.name === "file-read")).toBe(false);
  });

  test("combined category + source filter applies both predicates", () => {
    const ex = new ToolExecutor(db, silentLog);
    ex.register({ ...makeTool("skill-observe", "observe"), source: "skill" });
    ex.register({ ...makeTool("skill-mutate", "mutate"), source: "skill" });
    const result = ex.getAvailableTools(["observe"], ["skill"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("skill-observe");
  });
});

// ---------------------------------------------------------------------------
// validateParams (exercised through execute)
// ---------------------------------------------------------------------------

describe("parameter validation via execute()", () => {
  test("missing required param → failure result with Validation error", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    // file-read requires "path"
    const result = await ex.execute("file-read", {}, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/Validation error|Missing required/i);
  });

  test("wrong type for required param → failure result", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    // file-list expects path:string; pass a number
    const result = await ex.execute("file-list", { path: 42 }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/Validation error|must be a string/i);
  });

  test("wrong type for optional number param → failure result", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    // git-log: count is optional number; pass a string
    const result = await ex.execute("git-log", { path: resolveHome(), count: "five" }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/Validation error|must be a number/i);
  });

  test("unknown tool name → failure result with 'Unknown tool'", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("not-a-real-tool", {}, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toContain("Unknown tool");
  });

  test("all required params present and typed correctly → passes validation", async () => {
    const ex = new ToolExecutor(db, silentLog);
    // Register a custom tool with strict param requirements
    ex.register({
      name: "typed-tool",
      description: "d",
      category: "observe",
      params: [
        { name: "s", type: "string", required: true, description: "a string" },
        { name: "n", type: "number", required: true, description: "a number" },
        { name: "b", type: "boolean", required: true, description: "a bool" },
      ],
      timeout_ms: 1_000,
      parallelizable: true,
      execute: async () => ({
        success: true, data: null, summary: "passed", sideEffects: [], duration_ms: 0,
      }),
    });
    const ctx = makeCtx(db);
    const result = await ex.execute("typed-tool", { s: "hello", n: 3, b: true }, ctx);
    expect(result.success).toBe(true);
    expect(result.summary).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// execute(): audit logging
// ---------------------------------------------------------------------------

describe("execute() audit logging", () => {
  test("successful execution is logged to tool_executions", async () => {
    const ex = new ToolExecutor(db, silentLog);
    ex.register(makeTool("audit-me", "observe"));
    const ctx = makeCtx(db);
    await ex.execute("audit-me", {}, ctx);
    const logs = db.getToolExecutions("test-agent");
    expect(logs.length).toBeGreaterThan(0);
    const entry = logs.find((l: any) => l.tool_name === "audit-me");
    expect(entry).toBeDefined();
    expect(entry.result_success).toBe(1);
  });

  test("failed execution (unknown tool) does NOT log to audit trail", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const before = db.getToolExecutions().length;
    await ex.execute("nonexistent", {}, ctx);
    // Unknown tool returns early before the audit log call
    expect(db.getToolExecutions().length).toBe(before);
  });

  test("validation failure does NOT log to audit trail", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const before = db.getToolExecutions().length;
    await ex.execute("file-read", {}, ctx); // missing required param
    expect(db.getToolExecutions().length).toBe(before);
  });

  test("agent name is correctly recorded in audit log", async () => {
    const ex = new ToolExecutor(db, silentLog);
    ex.register(makeTool("audit-agent-check", "analyze"));
    const ctx = makeCtx(db, { agentName: "special-agent" });
    await ex.execute("audit-agent-check", {}, ctx);
    const logs = db.getToolExecutions("special-agent");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].agent_name).toBe("special-agent");
  });
});

// ---------------------------------------------------------------------------
// Built-in tool: file-read
// ---------------------------------------------------------------------------

describe("built-in file-read", () => {
  test("reads a file in the home dir successfully", async () => {
    // Write a small fixture inside the tmp dir (tmp is under homedir on Termux)
    const fixture = join(tmp, "hello.txt");
    writeFileSync(fixture, "line1\nline2\nline3\n");
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-read", { path: fixture }, ctx);
    expect(result.success).toBe(true);
    expect(result.summary).toContain("line1");
    expect(result.summary).toContain("line3");
  });

  test("returns failure for nonexistent file", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-read", { path: join(tmp, "nonexistent.txt") }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/not found/i);
  });

  test("line range '1-2' returns only first two lines", async () => {
    const fixture = join(tmp, "multiline.txt");
    writeFileSync(fixture, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-read", { path: fixture, lines: "1-2" }, ctx);
    expect(result.success).toBe(true);
    expect(result.summary).toContain("line1");
    expect(result.summary).toContain("line2");
    expect(result.summary).not.toContain("line3");
  });

  test("line range 'last-2' returns only last two lines", async () => {
    const fixture = join(tmp, "last-test.txt");
    writeFileSync(fixture, ["a", "b", "c", "d", "e"].join("\n"));
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-read", { path: fixture, lines: "last-2" }, ctx);
    expect(result.success).toBe(true);
    expect(result.summary).toContain("d");
    expect(result.summary).toContain("e");
    expect(result.summary).not.toContain("a");
  });

  test("rejects path outside allowed directories", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    // /proc/1/status is outside homedir and not in any allowed prefix
    const result = await ex.execute("file-read", { path: "/proc/1/status" }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/not allowed/i);
  });

  test("rejects ~/.ssh path (sensitive)", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-read", { path: join(resolveHome(), ".ssh", "id_rsa") }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/not allowed/i);
  });
});

// ---------------------------------------------------------------------------
// Built-in tool: file-list
// ---------------------------------------------------------------------------

describe("built-in file-list", () => {
  test("lists files in an allowed directory", async () => {
    writeFileSync(join(tmp, "foo.ts"), "");
    writeFileSync(join(tmp, "bar.ts"), "");
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-list", { path: tmp }, ctx);
    expect(result.success).toBe(true);
    expect(result.summary).toContain("foo.ts");
    expect(result.summary).toContain("bar.ts");
  });

  test("returns failure for nonexistent directory", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-list", { path: join(tmp, "ghost-dir") }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/not found/i);
  });

  test("skips hidden dirs and node_modules at depth > 0", async () => {
    mkdirSync(join(tmp, ".hidden-dir"), { recursive: true });
    mkdirSync(join(tmp, "node_modules"), { recursive: true });
    writeFileSync(join(tmp, ".hidden-dir", "secret.txt"), "");
    writeFileSync(join(tmp, "node_modules", "pkg.js"), "");
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-list", { path: tmp }, ctx);
    expect(result.success).toBe(true);
    expect(result.summary).not.toContain("secret.txt");
    expect(result.summary).not.toContain("pkg.js");
  });

  test("depth 2 recurses into subdirectories", async () => {
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(join(tmp, "sub", "deep.ts"), "");
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-list", { path: tmp, depth: 2 }, ctx);
    expect(result.success).toBe(true);
    expect(result.summary).toContain("deep.ts");
  });

  test("rejects disallowed path", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-list", { path: "/etc" }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/not allowed/i);
  });
});

// ---------------------------------------------------------------------------
// Built-in tool: file-write
// ---------------------------------------------------------------------------

describe("built-in file-write", () => {
  test("writes a new file and reports byte count", async () => {
    const filePath = join(tmp, "new-file.txt");
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-write", { path: filePath, content: "hello world" }, ctx);
    expect(result.success).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("hello world");
    expect(result.sideEffects.some((s) => s.includes("wrote:"))).toBe(true);
  });

  test("creates a .bak backup when overwriting existing file", async () => {
    const filePath = join(tmp, "overwrite-me.txt");
    writeFileSync(filePath, "original content");
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    await ex.execute("file-write", { path: filePath, content: "new content" }, ctx);
    expect(existsSync(`${filePath}.bak`)).toBe(true);
    expect(readFileSync(`${filePath}.bak`, "utf-8")).toBe("original content");
    expect(readFileSync(filePath, "utf-8")).toBe("new content");
  });

  test("creates intermediate directories if missing", async () => {
    const filePath = join(tmp, "deep", "nested", "file.txt");
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-write", { path: filePath, content: "data" }, ctx);
    expect(result.success).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("data");
    expect(result.sideEffects.some((s) => s.includes("created directory"))).toBe(true);
  });

  test("rejects write to disallowed path", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-write", { path: "/etc/test.txt", content: "x" }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/not allowed/i);
  });

  test("rejects write to .env (protected file)", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-write", { path: join(tmp, ".env"), content: "SECRET=x" }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/protected/i);
  });

  test("rejects write to .pem file (protected extension)", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-write", { path: join(tmp, "cert.pem"), content: "x" }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/protected/i);
  });

  test("rejects write to credentials.json (protected name)", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("file-write", {
      path: join(tmp, "credentials.json"), content: "{}" },
    ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/protected/i);
  });
});

// ---------------------------------------------------------------------------
// Built-in tool: system-status
// ---------------------------------------------------------------------------

describe("built-in system-status", () => {
  test("succeeds when no optional ctx providers are wired", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db); // no getSessionStates, getSystemMemory, getBattery
    const result = await ex.execute("system-status", {}, ctx);
    expect(result.success).toBe(true);
  });

  test("reflects session states from ctx.getSessionStates", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db, {
      getSessionStates: () => ({
        "my-session": { status: "running", activity: "coding", rss_mb: 120 },
      }),
    });
    const result = await ex.execute("system-status", {}, ctx);
    expect(result.success).toBe(true);
    expect(result.summary).toContain("my-session");
    expect(result.summary).toContain("running");
  });

  test("includes memory pressure from ctx.getSystemMemory", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db, {
      getSystemMemory: () => ({ available_mb: 512, pressure: "low" }),
    });
    const result = await ex.execute("system-status", {}, ctx);
    expect(result.summary).toContain("512");
    expect(result.summary).toContain("low");
  });

  test("includes battery info from ctx.getBattery", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db, {
      getBattery: () => ({ pct: 75, charging: true }),
    });
    const result = await ex.execute("system-status", {}, ctx);
    expect(result.summary).toContain("75%");
    expect(result.summary).toContain("charging");
  });
});

// ---------------------------------------------------------------------------
// Built-in tool: session-output
// ---------------------------------------------------------------------------

describe("built-in session-output", () => {
  test("returns failure when captureSessionOutput not wired", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db); // no captureSessionOutput
    const result = await ex.execute("session-output", { name: "my-sess" }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toContain("not available");
  });

  test("returns session output when captureSessionOutput is wired", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db, {
      captureSessionOutput: (_name, _lines) => "line1\nline2\nline3",
    });
    const result = await ex.execute("session-output", { name: "my-sess", lines: 3 }, ctx);
    expect(result.success).toBe(true);
    expect(result.summary).toContain("line1");
  });

  test("returns failure when session is not found (null output)", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db, {
      captureSessionOutput: () => null,
    });
    const result = await ex.execute("session-output", { name: "ghost" }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toContain("ghost");
  });

  test("caps lines at 200", async () => {
    const ex = new ToolExecutor(db, silentLog);
    let capturedLines = 0;
    const ctx = makeCtx(db, {
      captureSessionOutput: (_name, lines) => { capturedLines = lines; return "ok"; },
    });
    await ex.execute("session-output", { name: "s", lines: 999 }, ctx);
    expect(capturedLines).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Built-in tool: session-send
// ---------------------------------------------------------------------------

describe("built-in session-send", () => {
  test("returns failure when sendToSession is not wired", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db);
    const result = await ex.execute("session-send", { name: "s", text: "hello" }, ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toContain("not available");
  });

  test("succeeds when sendToSession is wired and records side effect", async () => {
    const sent: Array<[string, string]> = [];
    const ex = new ToolExecutor(db, silentLog);
    const ctx = makeCtx(db, {
      sendToSession: (name, text) => { sent.push([name, text]); },
    });
    const result = await ex.execute("session-send", { name: "my-sess", text: "do something" }, ctx);
    expect(result.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(["my-sess", "do something"]);
    expect(result.sideEffects.some((s) => s.includes("my-sess"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ToolProvider lifecycle
// ---------------------------------------------------------------------------

describe("ToolProvider lifecycle", () => {
  test("registerProvider calls initialize and registers tools", async () => {
    const ex = new ToolExecutor(db, silentLog);
    let initialized = false;

    const provider: ToolProvider = {
      name: "test-provider",
      source: "plugin",
      async initialize(executor) {
        initialized = true;
        executor.register({ ...makeTool("provider-tool"), source: "plugin" });
      },
    };

    await ex.registerProvider(provider);
    expect(initialized).toBe(true);
    expect(ex.hasTool("provider-tool")).toBe(true);
  });

  test("registerProvider swallows provider initialize errors gracefully", async () => {
    const warnings: string[] = [];
    const log = { ...silentLog, warn: (m: string) => warnings.push(m) };
    const ex = new ToolExecutor(db, log);

    const badProvider: ToolProvider = {
      name: "broken-provider",
      source: "plugin",
      async initialize() {
        throw new Error("init failed");
      },
    };

    // Should not throw
    await expect(ex.registerProvider(badProvider)).resolves.toBeUndefined();
    expect(warnings.some((w) => w.includes("broken-provider"))).toBe(true);
  });

  test("shutdownProviders calls shutdown on all registered providers", async () => {
    const ex = new ToolExecutor(db, silentLog);
    const shutdowns: string[] = [];

    const p1: ToolProvider = {
      name: "p1", source: "plugin",
      async initialize(exec) { exec.register({ ...makeTool("p1-tool"), source: "plugin" }); },
      async shutdown() { shutdowns.push("p1"); },
    };
    const p2: ToolProvider = {
      name: "p2", source: "mcp",
      async initialize(exec) { exec.register({ ...makeTool("p2-tool"), source: "mcp" }); },
      async shutdown() { shutdowns.push("p2"); },
    };

    await ex.registerProvider(p1);
    await ex.registerProvider(p2);
    await ex.shutdownProviders();

    expect(shutdowns).toContain("p1");
    expect(shutdowns).toContain("p2");
  });

  test("shutdownProviders is safe when no providers registered", async () => {
    const ex = new ToolExecutor(db, silentLog);
    await expect(ex.shutdownProviders()).resolves.toBeUndefined();
  });

  test("shutdownProviders swallows provider shutdown errors", async () => {
    const warnings: string[] = [];
    const log = { ...silentLog, warn: (m: string) => warnings.push(m) };
    const ex = new ToolExecutor(db, log);

    const badShutdown: ToolProvider = {
      name: "bad-shutdown", source: "plugin",
      async initialize(exec) { exec.register({ ...makeTool("bs-tool"), source: "plugin" }); },
      async shutdown() { throw new Error("shutdown failed"); },
    };
    await ex.registerProvider(badShutdown);
    await expect(ex.shutdownProviders()).resolves.toBeUndefined();
    expect(warnings.some((w) => w.includes("bad-shutdown"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatToolsForPrompt
// ---------------------------------------------------------------------------

describe("formatToolsForPrompt", () => {
  test("returns no-tools message when no tools match filters", () => {
    const ex = new ToolExecutor(db, silentLog);
    // Unregister everything and filter by a source with no matches
    const result = ex.formatToolsForPrompt(undefined, ["mcp"]);
    // No MCP tools registered by default
    expect(result).toBe("_No tools available._");
  });

  test("includes tool names and descriptions in output", () => {
    const ex = new ToolExecutor(db, silentLog);
    const output = ex.formatToolsForPrompt(["observe"]);
    expect(output).toContain("file-read");
    expect(output).toContain("file-list");
  });

  test("marks categories >= communicate as requiring approval", () => {
    const ex = new ToolExecutor(db, silentLog);
    const output = ex.formatToolsForPrompt(["communicate", "orchestrate"]);
    expect(output).toContain("requires approval");
  });

  test("observe/analyze categories do NOT carry requires-approval label", () => {
    const ex = new ToolExecutor(db, silentLog);
    const output = ex.formatToolsForPrompt(["observe", "analyze"]);
    expect(output).not.toContain("requires approval");
  });

  test("non-builtin source shown with [source] tag", () => {
    const ex = new ToolExecutor(db, silentLog);
    ex.register({ ...makeTool("toml-tagged", "observe"), source: "toml" });
    const output = ex.formatToolsForPrompt(["observe"]);
    expect(output).toContain("[toml]");
  });

  test("builtin source has no [builtin] tag", () => {
    const ex = new ToolExecutor(db, silentLog);
    const output = ex.formatToolsForPrompt(["observe"]);
    expect(output).not.toContain("[builtin]");
  });
});

// ---------------------------------------------------------------------------
// execute() generation pinning
// ---------------------------------------------------------------------------

describe("execute() with generation pinning", () => {
  test("executes tool from pinned (older) generation even after live advances", async () => {
    const ex = new ToolExecutor(db, silentLog);
    // Gen 0 = live — register a tool in it
    ex.register(makeTool("gen0-tool", "observe"));

    // Advance to gen 1
    const g1 = ex.beginGenerationTransaction();
    ex.register(makeTool("gen1-only", "observe"), g1);
    ex.commitGeneration(g1); // live = g1; gen 0 still present

    const ctx = makeCtx(db);
    // Tool exists in gen 0
    const r0 = await ex.execute("gen0-tool", {}, ctx, 0);
    expect(r0.success).toBe(true);

    // gen1-only does NOT exist in gen 0
    const r1 = await ex.execute("gen1-only", {}, ctx, 0);
    expect(r1.success).toBe(false);
    expect(r1.summary).toContain("Unknown tool");
  });
});

// -- file access policy -----------------------------------------------------
//
// file-read is category `observe` and file-write `mutate`; both are reachable
// by an agent. The old rule was "anything under $HOME minus four dot-dirs",
// which left every credential file and both code-executing config files
// readable/writable.

describe("isAllowedPath — credential and config denial", () => {
  // Must resolve home the same way isAllowedPath does. `process.env.HOME || ""`
  // yielded "" on Windows (which uses USERPROFILE), so every join produced a
  // relative path and the "allowed" cases failed there.
  const HOME = process.env.HOME || homedir();

  test("ordinary project files are still allowed", () => {
    expect(isAllowedPath(join(HOME, "git", "proj", "src", "a.ts"))).toBe(true);
    expect(isAllowedPath(join(HOME, "notes.md"))).toBe(true);
  });

  test("Claude Code state and settings are denied", () => {
    // settings.json carries `hooks`, which run shell commands.
    expect(isAllowedPath(join(HOME, ".claude.json"))).toBe(false);
    expect(isAllowedPath(join(HOME, ".claude", "settings.json"))).toBe(false);
    expect(isAllowedPath(join(HOME, ".claude", ".credentials.json"))).toBe(false);
  });

  test("operad's own config is denied — it defines [[tool]] shell commands", () => {
    expect(isAllowedPath(join(HOME, ".config", "operad", "operad.toml"))).toBe(false);
  });

  test("credential files are denied", () => {
    for (const f of [".npmrc", ".netrc", ".git-credentials"]) {
      expect(isAllowedPath(join(HOME, f))).toBe(false);
    }
  });

  test("shell startup files are denied (persistence)", () => {
    for (const f of [".bashrc", ".zshrc", ".profile", ".bash_profile"]) {
      expect(isAllowedPath(join(HOME, f))).toBe(false);
    }
  });

  test("credential directories are denied, including new ones", () => {
    for (const d of [".ssh", ".gnupg", ".aws", ".kube", ".docker"]) {
      expect(isAllowedPath(join(HOME, d, "anything"))).toBe(false);
    }
    expect(isAllowedPath(join(HOME, ".config", "gh", "hosts.yml"))).toBe(false);
  });

  test("system credential files are denied", () => {
    expect(isAllowedPath("/etc/shadow")).toBe(false);
    expect(isAllowedPath("/etc/passwd")).toBe(false);
  });

  test("a sibling directory sharing a prefix is not treated as inside", () => {
    // The old startsWith had no separator boundary: /home/user matched
    // /home/userbackup.
    expect(isAllowedPath("/definitely/not/home/x")).toBe(false);
  });

  test("traversal out of an allowed root is denied", () => {
    expect(isAllowedPath(join(HOME, "git", "..", "..", "etc", "shadow"))).toBe(false);
  });

  test("skill/plan markdown under ~/.claude stays readable", () => {
    expect(isAllowedPath(join(HOME, ".claude", "skills", "x.md"))).toBe(true);
  });
});

describe("isProtectedFile — write denial", () => {
  test("every .env variant is protected, not just the listed three", () => {
    for (const n of [".env", ".env.local", ".env.staging", ".env.whatever"]) {
      expect(isProtectedFile("/p/" + n)).toBe(true);
    }
  });

  test("key material is protected by extension", () => {
    for (const n of ["a.pem", "a.key", "a.p12", "a.pfx", "a.jks"]) {
      expect(isProtectedFile("/p/" + n)).toBe(true);
    }
  });

  test("private key filenames are protected", () => {
    expect(isProtectedFile("/p/id_rsa")).toBe(true);
    expect(isProtectedFile("/p/id_ed25519")).toBe(true);
  });

  test("case variants are protected on case-insensitive filesystems", () => {
    expect(isProtectedFile("/p/.ENV")).toBe(true);
    expect(isProtectedFile("/p/SECRETS.JSON")).toBe(true);
    expect(isProtectedFile("/p/A.PEM")).toBe(true);
  });

  test("ordinary source files are not protected", () => {
    expect(isProtectedFile("/p/index.ts")).toBe(false);
    expect(isProtectedFile("/p/README.md")).toBe(false);
  });
});

// -- execution no longer blocks the event loop ------------------------------
//
// Every shelling tool used execSync, which blocks the daemon's loop for the
// whole call — up to 30s for a TOML tool. HTTP, SSE, WebSocket pings, health
// checks, IPC and the memory poll all stalled behind one tool invocation.

describe("ToolExecutor — event loop and cancellation", () => {
  function makeExecutor() {
    const sql = new Database(":memory:");
    sql.exec(`CREATE TABLE tool_executions (id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT, tool_name TEXT, params_json TEXT, success INTEGER,
      result_summary TEXT, duration_ms INTEGER, error_message TEXT,
      autonomy_level TEXT, created_at INTEGER NOT NULL);`);
    const db = {
      requireDb: () => sql,
      getToolAutonomyCap: () => null,
      logToolExecution: () => {},
    } as any;
    const log = { info() {}, warn() {}, error() {}, debug() {} } as any;
    return { te: new ToolExecutor(db, log), sql };
  }

  test("a slow shell tool does not stall the event loop", async () => {
    const { te, sql } = makeExecutor();
    te.registerTomlTools([{
      name: "slowtool", description: "d", category: "analyze",
      command: "sleep 1", timeout_ms: 8000,
    }]);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const r = await te.execute("slowtool", {}, { agentName: "a", autonomyLevel: "autonomous" } as any);
    clearInterval(timer);
    expect(r.success).toBe(true);
    // The distinction that matters is zero vs non-zero: execSync yielded no
    // ticks at all. A loaded CI box can deliver far fewer than the ~20 a quiet
    // machine sees, so assert only that the loop ran — a tighter bound here
    // buys nothing and flakes under load.
    expect(ticks).toBeGreaterThan(0);
    sql.close();
  });

  // ctx.signal.aborted threw outright when a caller omitted the signal.
  test("a context without a signal does not crash", async () => {
    const { te, sql } = makeExecutor();
    te.registerTomlTools([{
      name: "quick", description: "d", category: "analyze", command: "echo hi",
    }]);
    const r = await te.execute("quick", {}, { agentName: "a", autonomyLevel: "autonomous" } as any);
    expect(r.success).toBe(true);
    sql.close();
  });

  // The merge previously discarded the caller's signal unless it had ALREADY
  // aborted, so a caller could never cancel a running tool.
  test("a caller's abort reaches a running tool", async () => {
    const { te, sql } = makeExecutor();
    te.register({
      name: "waits", description: "d", category: "analyze", params: [],
      timeout_ms: 10_000, parallelizable: true,
      execute: async (_input: unknown, ctx: any) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) return resolve();
          ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 5000);
        });
        return {
          success: true, data: null,
          summary: ctx.signal?.aborted ? "aborted" : "completed",
          sideEffects: [], duration_ms: 0,
        };
      },
    } as any);
    const ac = new AbortController();
    const p = te.execute("waits", {}, {
      agentName: "a", autonomyLevel: "autonomous", signal: ac.signal,
    } as any);
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(String(r.summary)).toBe("aborted");
    sql.close();
  }, 15_000);
});
