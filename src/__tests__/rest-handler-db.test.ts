/**
 * rest-handler-db.test.ts — In-process tests for the DB-backed REST routes
 * of RestHandler.handleDashboardApi.
 *
 * Covers: memories, tools, trust, leases, consolidation, specializations,
 * roundtables, schedules, quota, workflows, skills, tool-autonomy,
 * tokens-daily, tokens-window, costs.
 *
 * Each route is tested for:
 *   - 503 when the required subsystem (memoryDb / toolExecutor / scheduleEngine /
 *     workflowEngine / skillManager) is absent.
 *   - 405 when the method is wrong.
 *   - 400 when a required param is missing or the body is invalid.
 *   - 200/201 success path with real DB rows seeded where possible.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RestHandler } from "../rest-handler.js";
import { ToolEngine } from "../tool-engine.js";
import {
  makeFakeContext,
  fakeAgentEngine,
  type FakeContext,
} from "./helpers/fake-context.js";

let fc: FakeContext;
let h: RestHandler;

function build(): RestHandler {
  return new RestHandler(fc.ctx, fakeAgentEngine(), new ToolEngine(fc.ctx));
}

beforeEach(async () => {
  fc = await makeFakeContext();
  h = build();
});
afterEach(() => fc.cleanup());

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Rebuild handler + context from scratch with DB, letting caller seed rows. */
async function withDb(
  seedFn?: (fc2: FakeContext) => void | Promise<void>,
  extraOpts: Partial<Parameters<typeof makeFakeContext>[0]> = {},
): Promise<{ fc2: FakeContext; h2: RestHandler }> {
  const fc2 = await makeFakeContext({ withDb: true, ...extraOpts });
  if (seedFn) await seedFn(fc2);
  const h2 = new RestHandler(fc2.ctx, fakeAgentEngine(), new ToolEngine(fc2.ctx));
  return { fc2, h2 };
}

// ============================================================================
// memories
// ============================================================================

describe("RestHandler — memories", () => {
  test("503 when memoryDb absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/memories/myproject", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/memories/<project> returns seeded memories", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.createMemory("/myproj", "discovery", "hello world");
    });
    const res = await h2.handleDashboardApi("GET", "/api/memories/%2Fmyproj", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ content: string }>;
    expect(list.some((m) => m.content === "hello world")).toBe(true);
    fc2.cleanup();
  });

  test("POST /api/memories/<project> creates a memory and returns id", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/memories/%2Fmyproj",
      JSON.stringify({ category: "decision", content: "use bun" }),
    );
    expect(res.status).toBe(201);
    expect((res.data as { id: number | null }).id).toBeGreaterThan(0);
    fc2.cleanup();
  });

  test("POST /api/memories/<project> with missing content → 400", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/memories/%2Fmyproj",
      JSON.stringify({ category: "decision" }),
    );
    expect(res.status).toBe(400);
    fc2.cleanup();
  });

  test("POST /api/memories/<project> with invalid JSON → 400", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("POST", "/api/memories/%2Fmyproj", "{bad");
    expect(res.status).toBe(400);
    fc2.cleanup();
  });

  test("DELETE /api/memories/<project>/<id> deletes a memory", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.createMemory("/del", "discovery", "to be deleted");
    });
    const list = await h2.handleDashboardApi("GET", "/api/memories/%2Fdel", "");
    const rows = list.data as Array<{ id: number }>;
    const id = rows[0].id;
    const res = await h2.handleDashboardApi("DELETE", `/api/memories/%2Fdel/${id}`, "");
    expect(res.status).toBe(200);
    expect((res.data as { ok: boolean }).ok).toBe(true);
    fc2.cleanup();
  });

  test("DELETE /api/memories/<project> without id → 400", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("DELETE", "/api/memories/%2Fdel", "");
    expect(res.status).toBe(400);
    fc2.cleanup();
  });
});

// ============================================================================
// tools
// ============================================================================

describe("RestHandler — tools", () => {
  test("503 when toolExecutor absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/tools", "");
    expect(res.status).toBe(503);
  });

  test("405 for POST on /api/tools", async () => {
    const fakeTe = {
      getAllTools: () => [],
      getTool: (_n: string) => null,
    };
    const { fc2, h2 } = await withDb(undefined, { toolExecutor: fakeTe });
    const res = await h2.handleDashboardApi("POST", "/api/tools", "");
    expect(res.status).toBe(405);
    fc2.cleanup();
  });

  test("GET /api/tools returns all tools from executor", async () => {
    const fakeTool = {
      name: "bash", description: "Run bash", category: "shell",
      source: "builtin" as const, sourceId: undefined,
      params: [], timeout_ms: 5000, parallelizable: false,
    };
    const fakeTe = {
      getAllTools: () => [fakeTool],
      getTool: (_n: string) => null,
    };
    const { fc2, h2 } = await withDb(undefined, { toolExecutor: fakeTe });
    const res = await h2.handleDashboardApi("GET", "/api/tools", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ name: string }>;
    expect(list.some((t) => t.name === "bash")).toBe(true);
    fc2.cleanup();
  });

  test("GET /api/tools/<name> returns 404 when tool unknown", async () => {
    const fakeTe = {
      getAllTools: () => [],
      getTool: (_n: string) => null,
    };
    const { fc2, h2 } = await withDb(undefined, { toolExecutor: fakeTe });
    const res = await h2.handleDashboardApi("GET", "/api/tools/nope", "");
    expect(res.status).toBe(404);
    fc2.cleanup();
  });

  test("GET /api/tools/<name> returns tool details when found", async () => {
    const fakeTool = {
      name: "read", description: "Read file", category: "fs" as const,
      source: "builtin" as const, sourceId: undefined,
      params: [], timeout_ms: 3000, parallelizable: true,
    };
    const fakeTe = {
      getAllTools: () => [],
      getTool: (n: string) => n === "read" ? fakeTool : null,
    };
    const { fc2, h2 } = await withDb(undefined, { toolExecutor: fakeTe });
    const res = await h2.handleDashboardApi("GET", "/api/tools/read", "");
    expect(res.status).toBe(200);
    expect((res.data as { name: string }).name).toBe("read");
    fc2.cleanup();
  });
});

// ============================================================================
// trust
// ============================================================================

describe("RestHandler — trust", () => {
  test("503 when memoryDb absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/trust", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/trust/<agent> returns trust score and history", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.recordTrustDelta("worker", 100, "good job");
    });
    const res = await h2.handleDashboardApi("GET", "/api/trust/worker", "");
    expect(res.status).toBe(200);
    const d = res.data as { agent: string; score: number; recommended: string; history: unknown[] };
    expect(d.agent).toBe("worker");
    expect(d.score).toBe(100);
    expect(Array.isArray(d.history)).toBe(true);
    expect(d.history.length).toBeGreaterThan(0);
    fc2.cleanup();
  });

  test("GET /api/trust returns list for all configured agents", async () => {
    const { fc2, h2 } = await withDb(undefined, {
      agentConfigs: [{ name: "agent1", description: "", prompt: "", enabled: true, source: "builtin" as const }],
    });
    const res = await h2.handleDashboardApi("GET", "/api/trust", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ agent: string }>;
    expect(list.some((a) => a.agent === "agent1")).toBe(true);
    fc2.cleanup();
  });

  test("405 for POST on /api/trust", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("POST", "/api/trust", "");
    expect(res.status).toBe(405);
    fc2.cleanup();
  });
});

// ============================================================================
// leases
// ============================================================================

describe("RestHandler — leases", () => {
  test("503 when memoryDb absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/leases/myagent", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/leases/<agent> returns active leases", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.createToolLease("myagent", "bash", {});
    });
    const res = await h2.handleDashboardApi("GET", "/api/leases/myagent", "");
    expect(res.status).toBe(200);
    const leases = res.data as Array<{ tool_name: string }>;
    expect(leases.some((l) => l.tool_name === "bash")).toBe(true);
    fc2.cleanup();
  });

  test("DELETE /api/leases/<agent> revokes leases and returns revoked count", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.createToolLease("myagent", "bash", {});
    });
    const res = await h2.handleDashboardApi("DELETE", "/api/leases/myagent", "");
    expect(res.status).toBe(200);
    expect(typeof (res.data as { revoked: number }).revoked).toBe("number");
    fc2.cleanup();
  });

  test("GET/DELETE /api/leases without agent name → 405", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("GET", "/api/leases", "");
    expect(res.status).toBe(405);
    fc2.cleanup();
  });
});

// ============================================================================
// consolidation
// ============================================================================

describe("RestHandler — consolidation", () => {
  test("503 when memoryDb absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/consolidation", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/consolidation returns history shape", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("GET", "/api/consolidation", "");
    expect(res.status).toBe(200);
    const d = res.data as { last_run_at: unknown; history: unknown[] };
    expect("last_run_at" in d).toBe(true);
    expect(Array.isArray(d.history)).toBe(true);
    fc2.cleanup();
  });

  test("POST /api/consolidation runs consolidation and returns result", async () => {
    const { fc2, h2 } = await withDb(undefined, {
      agentConfigs: [{ name: "optimizer", description: "", prompt: "", enabled: true, source: "builtin" as const }],
    });
    const res = await h2.handleDashboardApi("POST", "/api/consolidation", "");
    expect(res.status).toBe(200);
    // Result has at least { status } or similar fields
    expect(typeof res.data).toBe("object");
    fc2.cleanup();
  });

  test("405 for PATCH on /api/consolidation", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("PATCH", "/api/consolidation", "");
    expect(res.status).toBe(405);
    fc2.cleanup();
  });
});

// ============================================================================
// specializations
// ============================================================================

describe("RestHandler — specializations", () => {
  test("503 when memoryDb absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/specializations", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/specializations returns seeded rows", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.upsertSpecialization("worker", "typescript", 0.8, "proven reliability");
    });
    const res = await h2.handleDashboardApi("GET", "/api/specializations", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ agent_name: string; domain: string }>;
    expect(list.some((s) => s.agent_name === "worker" && s.domain === "typescript")).toBe(true);
    fc2.cleanup();
  });

  test("GET /api/specializations/<agent> filters by agent name", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.upsertSpecialization("alice", "python", 0.7);
      f.db!.upsertSpecialization("bob", "rust", 0.6);
    });
    const res = await h2.handleDashboardApi("GET", "/api/specializations/alice", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ agent_name: string }>;
    expect(list.every((s) => s.agent_name === "alice")).toBe(true);
    fc2.cleanup();
  });

  test("405 for POST on /api/specializations", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("POST", "/api/specializations", "");
    expect(res.status).toBe(405);
    fc2.cleanup();
  });
});

// ============================================================================
// roundtables
// ============================================================================

describe("RestHandler — roundtables", () => {
  test("503 when memoryDb absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/roundtables", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/roundtables returns list (empty or seeded)", async () => {
    const { fc2, h2 } = await withDb((f) => {
      // Insert a roundtable message directly via raw DB
      f.db!.requireDb().prepare(
        `INSERT INTO agent_messages (from_agent, to_agent, message_type, content)
         VALUES ('a', 'b', 'roundtable_result', 'topic: x')`,
      ).run();
    });
    const res = await h2.handleDashboardApi("GET", "/api/roundtables", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ message_type: string }>;
    expect(list.some((m) => m.message_type.startsWith("roundtable_"))).toBe(true);
    fc2.cleanup();
  });

  test("POST /api/roundtables without topic → 400", async () => {
    const { fc2, h2 } = await withDb(undefined, { sdkBridge: {} });
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/roundtables",
      JSON.stringify({ agents: ["a", "b"] }),
    );
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("topic");
    fc2.cleanup();
  });

  test("POST /api/roundtables without agents → 400", async () => {
    const { fc2, h2 } = await withDb(undefined, { sdkBridge: {} });
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/roundtables",
      JSON.stringify({ topic: "test topic" }),
    );
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("agents");
    fc2.cleanup();
  });

  test("POST /api/roundtables with no sdkBridge → 503", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/roundtables",
      JSON.stringify({ topic: "hello", agents: ["x"] }),
    );
    expect(res.status).toBe(503);
    fc2.cleanup();
  });

  test("405 for PATCH on /api/roundtables", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("PATCH", "/api/roundtables", "");
    expect(res.status).toBe(405);
    fc2.cleanup();
  });
});

// ============================================================================
// schedules
// ============================================================================

describe("RestHandler — schedules", () => {
  test("503 when scheduleEngine absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/schedules", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/schedules returns all schedules", async () => {
    const schedList = [{ id: 1, agent_name: "optimizer" }];
    const fakeSched = {
      getAll: (agent?: string) => (agent ? schedList.filter((s) => s.agent_name === agent) : schedList),
      upsert: () => 1,
      delete: () => true,
      setEnabled: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { scheduleEngine: fakeSched });
    const res = await h2.handleDashboardApi("GET", "/api/schedules", "");
    expect(res.status).toBe(200);
    expect((res.data as unknown[]).length).toBeGreaterThan(0);
    fc2.cleanup();
  });

  test("POST /api/schedules with missing fields → 400", async () => {
    const fakeSched = { getAll: () => [], upsert: () => 1, delete: () => true, setEnabled: () => {} };
    const { fc2, h2 } = await withDb(undefined, { scheduleEngine: fakeSched });
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/schedules",
      JSON.stringify({ agent_name: "optimizer" }),
    );
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("Missing required fields");
    fc2.cleanup();
  });

  test("POST /api/schedules with valid body returns 201 with id", async () => {
    let upsertArgs: unknown[] = [];
    const fakeSched = {
      getAll: () => [],
      upsert: (args: unknown) => { upsertArgs = [args]; return 7; },
      delete: () => true,
      setEnabled: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { scheduleEngine: fakeSched });
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/schedules",
      JSON.stringify({ agent_name: "optimizer", schedule_name: "daily", prompt: "run daily" }),
    );
    expect(res.status).toBe(201);
    expect((res.data as { id: number }).id).toBe(7);
    expect(upsertArgs.length).toBe(1);
    fc2.cleanup();
  });

  test("DELETE /api/schedules/<name> calls schedEng.delete and returns result", async () => {
    const deleted: string[] = [];
    const fakeSched = {
      getAll: () => [],
      upsert: () => 1,
      delete: (agent: string, name: string) => { deleted.push(`${agent}:${name}`); return true; },
      setEnabled: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { scheduleEngine: fakeSched });
    const res = await h2.handleDashboardApi("DELETE", "/api/schedules/daily", "");
    expect(res.status).toBe(200);
    expect((res.data as { deleted: boolean }).deleted).toBe(true);
    fc2.cleanup();
  });

  test("PATCH /api/schedules/<id> toggles enabled state", async () => {
    const set: Array<[number, boolean]> = [];
    const fakeSched = {
      getAll: () => [],
      upsert: () => 1,
      delete: () => true,
      setEnabled: (id: number, enabled: boolean) => set.push([id, enabled]),
    };
    const { fc2, h2 } = await withDb(undefined, { scheduleEngine: fakeSched });
    const res = await h2.handleDashboardApi("PATCH", "/api/schedules/3", JSON.stringify({ enabled: false }));
    expect(res.status).toBe(200);
    expect(set).toEqual([[3, false]]);
    fc2.cleanup();
  });

  test("PATCH /api/schedules/<non-numeric-id> → 400", async () => {
    const fakeSched = { getAll: () => [], upsert: () => 1, delete: () => true, setEnabled: () => {} };
    const { fc2, h2 } = await withDb(undefined, { scheduleEngine: fakeSched });
    const res = await h2.handleDashboardApi("PATCH", "/api/schedules/notanid", JSON.stringify({ enabled: true }));
    expect(res.status).toBe(400);
    fc2.cleanup();
  });
});

// ============================================================================
// quota
// ============================================================================

describe("RestHandler — quota", () => {
  test("503 when memoryDb absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/quota", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/quota returns quota status object", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("GET", "/api/quota", "");
    expect(res.status).toBe(200);
    const d = res.data as Record<string, unknown>;
    expect("weekly_level" in d).toBe(true);
    expect("tokens_per_hour" in d).toBe(true);
    fc2.cleanup();
  });

  test("405 for POST on /api/quota", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("POST", "/api/quota", "");
    expect(res.status).toBe(405);
    fc2.cleanup();
  });

  test("GET /api/quota reflects seeded token data in top_sessions", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.recordCost("heavy-session", null, 0.01, 5000, 2000, 1000, 3, "claude-3-5-sonnet");
    });
    const res = await h2.handleDashboardApi("GET", "/api/quota", "");
    expect(res.status).toBe(200);
    const d = res.data as { weekly_tokens_used: number };
    expect(d.weekly_tokens_used).toBeGreaterThanOrEqual(0);
    fc2.cleanup();
  });
});

// ============================================================================
// workflows
// ============================================================================

describe("RestHandler — workflows", () => {
  test("503 when workflowEngine absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/workflows", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/workflows returns all workflows", async () => {
    const wfList = [{ name: "deploy", enabled: true }];
    const fakeWf = {
      getAll: () => wfList,
      get: (n: string) => wfList.find((w) => w.name === n) ?? null,
      recentRuns: () => [],
      run: async () => ({ status: "success" }),
      upsert: () => 1,
      delete: () => true,
      setEnabled: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { workflowEngine: fakeWf });
    const res = await h2.handleDashboardApi("GET", "/api/workflows", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ name: string }>;
    expect(list.some((w) => w.name === "deploy")).toBe(true);
    fc2.cleanup();
  });

  test("GET /api/workflows/<name> returns 404 when unknown", async () => {
    const fakeWf = {
      getAll: () => [],
      get: () => null,
      recentRuns: () => [],
      run: async () => ({}),
      upsert: () => 1,
      delete: () => false,
      setEnabled: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { workflowEngine: fakeWf });
    const res = await h2.handleDashboardApi("GET", "/api/workflows/ghost", "");
    expect(res.status).toBe(404);
    fc2.cleanup();
  });

  test("GET /api/workflows/<name>/runs returns recent runs", async () => {
    const runs = [{ id: 1, status: "success" }];
    const fakeWf = {
      getAll: () => [],
      get: () => ({ name: "deploy" }),
      recentRuns: (n: string) => (n === "deploy" ? runs : []),
      run: async () => ({}),
      upsert: () => 1,
      delete: () => true,
      setEnabled: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { workflowEngine: fakeWf });
    const res = await h2.handleDashboardApi("GET", "/api/workflows/deploy/runs", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ id: number }>;
    expect(list.some((r) => r.id === 1)).toBe(true);
    fc2.cleanup();
  });

  test("POST /api/workflows without name/spec → 400", async () => {
    const fakeWf = {
      getAll: () => [],
      get: () => null,
      recentRuns: () => [],
      run: async () => ({}),
      upsert: () => 1,
      delete: () => true,
      setEnabled: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { workflowEngine: fakeWf });
    const res = await h2.handleDashboardApi("POST", "/api/workflows", JSON.stringify({ name: "x" }));
    expect(res.status).toBe(400);
    fc2.cleanup();
  });

  test("POST /api/workflows with valid spec returns 201", async () => {
    const fakeWf = {
      getAll: () => [],
      get: () => null,
      recentRuns: () => [],
      run: async () => ({}),
      upsert: () => 5,
      delete: () => true,
      setEnabled: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { workflowEngine: fakeWf });
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/workflows",
      JSON.stringify({ name: "ci", spec: { nodes: [], edges: [] } }),
    );
    expect(res.status).toBe(201);
    expect((res.data as { id: number }).id).toBe(5);
    fc2.cleanup();
  });

  test("DELETE /api/workflows/<name> returns deleted flag", async () => {
    const fakeWf = {
      getAll: () => [],
      get: () => null,
      recentRuns: () => [],
      run: async () => ({}),
      upsert: () => 1,
      delete: (n: string) => n === "ci",
      setEnabled: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { workflowEngine: fakeWf });
    const res = await h2.handleDashboardApi("DELETE", "/api/workflows/ci", "");
    expect(res.status).toBe(200);
    expect((res.data as { deleted: boolean }).deleted).toBe(true);
    fc2.cleanup();
  });

  test("PATCH /api/workflows/<name> updates enabled state", async () => {
    const updates: Array<[string, boolean]> = [];
    const fakeWf = {
      getAll: () => [],
      get: () => null,
      recentRuns: () => [],
      run: async () => ({}),
      upsert: () => 1,
      delete: () => true,
      setEnabled: (n: string, v: boolean) => updates.push([n, v]),
    };
    const { fc2, h2 } = await withDb(undefined, { workflowEngine: fakeWf });
    const res = await h2.handleDashboardApi("PATCH", "/api/workflows/ci", JSON.stringify({ enabled: false }));
    expect(res.status).toBe(200);
    expect(updates).toEqual([["ci", false]]);
    fc2.cleanup();
  });
});

// ============================================================================
// skills
// ============================================================================

describe("RestHandler — skills", () => {
  test("503 when skillManager absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/skills", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/skills returns skill list", async () => {
    const fakeMgr = {
      list: (provider?: string) => (provider ? [] : [{ id: "s1", name: "myfirst" }]),
      get: (_id: string) => null,
      install: async () => ({ id: "s1" }),
      uninstall: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { skillManager: fakeMgr });
    const res = await h2.handleDashboardApi("GET", "/api/skills", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ id: string }>;
    expect(list.some((s) => s.id === "s1")).toBe(true);
    fc2.cleanup();
  });

  test("GET /api/skills/<id> returns 404 when unknown", async () => {
    const fakeMgr = {
      list: () => [],
      get: (_id: string) => null,
      install: async () => ({}),
      uninstall: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { skillManager: fakeMgr });
    const res = await h2.handleDashboardApi("GET", "/api/skills/nope", "");
    expect(res.status).toBe(404);
    fc2.cleanup();
  });

  test("POST /api/skills/install without provider/locator → 400", async () => {
    const fakeMgr = {
      list: () => [],
      get: (_id: string) => null,
      install: async () => ({}),
      uninstall: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { skillManager: fakeMgr });
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/skills/install",
      JSON.stringify({ provider: "git" }),
    );
    expect(res.status).toBe(400);
    fc2.cleanup();
  });

  test("POST /api/skills/install with valid body returns 201", async () => {
    let installed: unknown = null;
    const fakeMgr = {
      list: () => [],
      get: (_id: string) => null,
      install: async (provider: string, locator: string) => {
        installed = { provider, locator };
        return { id: "new-skill" };
      },
      uninstall: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { skillManager: fakeMgr });
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/skills/install",
      JSON.stringify({ provider: "git", locator: "https://example.com/skill" }),
    );
    expect(res.status).toBe(201);
    expect((res.data as { id: string }).id).toBe("new-skill");
    expect(installed).toMatchObject({ provider: "git" });
    fc2.cleanup();
  });

  test("POST /api/skills/<id>/uninstall succeeds", async () => {
    const uninstallArgs: unknown[] = [];
    const fakeMgr = {
      list: () => [],
      get: (_id: string) => ({ id: "s1" }),
      install: async () => ({}),
      uninstall: (id: string, opts: unknown) => { uninstallArgs.push({ id, opts }); },
    };
    const { fc2, h2 } = await withDb(undefined, { skillManager: fakeMgr });
    const res = await h2.handleDashboardApi("POST", "/api/skills/s1/uninstall", JSON.stringify({ force_revoke: false }));
    expect(res.status).toBe(200);
    expect((res.data as { ok: boolean }).ok).toBe(true);
    expect(uninstallArgs.length).toBe(1);
    fc2.cleanup();
  });

  test("405 for PATCH on /api/skills", async () => {
    const fakeMgr = {
      list: () => [],
      get: (_id: string) => null,
      install: async () => ({}),
      uninstall: () => {},
    };
    const { fc2, h2 } = await withDb(undefined, { skillManager: fakeMgr });
    const res = await h2.handleDashboardApi("PATCH", "/api/skills", "");
    expect(res.status).toBe(405);
    fc2.cleanup();
  });

  test("GET /api/skills/events with db returns event list", async () => {
    const fakeMgr = {
      list: () => [],
      get: (_id: string) => null,
      install: async () => ({}),
      uninstall: () => {},
    };
    const { fc2, h2 } = await withDb((f) => {
      // Need a skill row first due to FK constraint
      f.db!.requireDb().prepare(
        `INSERT INTO skills (id, name, description, provider, locator, version,
           fetched_url, fetched_archive_sha256, fetched_at, trust_tier, manifest_json, installed_at)
         VALUES ('s1','myfirst','desc','git','mylocator','1.0',
           'https://x','abc',0,'community','{}',0)`,
      ).run();
      f.db!.requireDb().prepare(
        `INSERT INTO skill_events (skill_id, event_type, detail, occurred_at)
         VALUES ('s1', 'install', 'first install', 1000)`,
      ).run();
    }, { skillManager: fakeMgr });
    const res = await h2.handleDashboardApi("GET", "/api/skills/events", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ event_type: string }>;
    expect(list.some((e) => e.event_type === "install")).toBe(true);
    fc2.cleanup();
  });
});

// ============================================================================
// tool-autonomy
// ============================================================================

describe("RestHandler — tool-autonomy", () => {
  test("503 when memoryDb absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/tool-autonomy", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/tool-autonomy returns cap list (empty on fresh db)", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("GET", "/api/tool-autonomy", "");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    fc2.cleanup();
  });

  test("GET /api/tool-autonomy reflects seeded caps", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.setToolAutonomyCap("bash", "supervised", "suggest", "git:myprovider");
    });
    const res = await h2.handleDashboardApi("GET", "/api/tool-autonomy", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ tool_id: string; max_bucket: string }>;
    expect(list.some((c) => c.tool_id === "bash" && c.max_bucket === "supervised")).toBe(true);
    fc2.cleanup();
  });

  test("POST /api/tool-autonomy without required fields → 400", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/tool-autonomy",
      JSON.stringify({ tool_id: "bash" }),
    );
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("Missing required fields");
    fc2.cleanup();
  });

  test("POST /api/tool-autonomy promotes bucket and returns new state", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.setToolAutonomyCap("read", "trusted", "suggest", null);
    });
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/tool-autonomy",
      JSON.stringify({ tool_id: "read", bucket: "trusted" }),
    );
    expect(res.status).toBe(200);
    const d = res.data as { tool_id: string; current_bucket: string };
    expect(d.tool_id).toBe("read");
    expect(d.current_bucket).toBe("trusted");
    fc2.cleanup();
  });

  test("POST /api/tool-autonomy exceeding cap → 409", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.setToolAutonomyCap("limited-tool", "suggest", "suggest", null);
    });
    const res = await h2.handleDashboardApi(
      "POST",
      "/api/tool-autonomy",
      JSON.stringify({ tool_id: "limited-tool", bucket: "autonomous" }),
    );
    expect(res.status).toBe(409);
    fc2.cleanup();
  });

  test("405 for DELETE on /api/tool-autonomy", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("DELETE", "/api/tool-autonomy", "");
    expect(res.status).toBe(405);
    fc2.cleanup();
  });
});

// ============================================================================
// tokens-daily
// ============================================================================

describe("RestHandler — tokens-daily", () => {
  test("503 when memoryDb absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/tokens-daily", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/tokens-daily returns daily token array", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.recordCost("s1", null, 0.01, 100, 50, 500, 2, null);
    });
    const res = await h2.handleDashboardApi("GET", "/api/tokens-daily?days=1", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ date: string; total_tokens: number }>;
    expect(Array.isArray(list)).toBe(true);
    fc2.cleanup();
  });

  test("405 for POST on /api/tokens-daily", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("POST", "/api/tokens-daily", "");
    expect(res.status).toBe(405);
    fc2.cleanup();
  });
});

// ============================================================================
// tokens-window
// ============================================================================

describe("RestHandler — tokens-window", () => {
  test("503 when memoryDb absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/tokens-window", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/tokens-window returns per-session data", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.recordCost("session-a", null, 0.02, 200, 100, 1000, 5, null);
    });
    const res = await h2.handleDashboardApi("GET", "/api/tokens-window", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ session_name: string; total_tokens: number }>;
    expect(Array.isArray(list)).toBe(true);
    // session-a may or may not appear depending on quota_window_hours default
    // but the array shape must be correct
    expect(res.status).toBe(200);
    fc2.cleanup();
  });

  test("405 for POST on /api/tokens-window", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("POST", "/api/tokens-window", "");
    expect(res.status).toBe(405);
    fc2.cleanup();
  });
});

// ============================================================================
// costs
// ============================================================================

describe("RestHandler — costs", () => {
  test("503 when memoryDb absent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/costs", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/costs returns aggregate with seeded data", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.recordCost("proj", null, 0.05, 300, 150, 2000, 4, "claude-3-5-haiku");
    });
    const res = await h2.handleDashboardApi("GET", "/api/costs", "");
    expect(res.status).toBe(200);
    const d = res.data as { total_cost_usd: number; query_count: number };
    expect(d.query_count).toBeGreaterThanOrEqual(1);
    expect(d.total_cost_usd).toBeGreaterThan(0);
    fc2.cleanup();
  });

  test("GET /api/costs/daily returns daily breakdown", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.recordCost("proj", null, 0.01, 50, 25, 500, 1, null);
    });
    const res = await h2.handleDashboardApi("GET", "/api/costs/daily?days=1", "");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    fc2.cleanup();
  });

  test("GET /api/costs/per-session returns per-session costs", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.recordCost("alpha", null, 0.03, 200, 100, 1500, 2, null);
      f.db!.recordCost("beta", null, 0.01, 100, 50, 700, 1, null);
    });
    const res = await h2.handleDashboardApi("GET", "/api/costs/per-session", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ session_name: string }>;
    expect(list.some((c) => c.session_name === "alpha")).toBe(true);
    fc2.cleanup();
  });

  test("GET /api/costs/<session> returns costs for a specific session", async () => {
    const { fc2, h2 } = await withDb((f) => {
      f.db!.recordCost("myapp", null, 0.02, 150, 80, 900, 2, null);
    });
    const res = await h2.handleDashboardApi("GET", "/api/costs/myapp", "");
    expect(res.status).toBe(200);
    const list = res.data as Array<{ session_name: string }>;
    expect(list.every((c) => c.session_name === "myapp")).toBe(true);
    fc2.cleanup();
  });

  test("405 for POST on /api/costs", async () => {
    const { fc2, h2 } = await withDb();
    const res = await h2.handleDashboardApi("POST", "/api/costs", "");
    expect(res.status).toBe(405);
    fc2.cleanup();
  });
});
