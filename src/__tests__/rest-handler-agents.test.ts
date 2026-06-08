/**
 * rest-handler-agents.test.ts — In-process tests for RestHandler routes:
 *   agents, agent-chat, agent-messages, cognitive, profile
 *
 * Mirrors the style of rest-handler-core.test.ts. Uses the fake context
 * harness (helpers/fake-context.ts) for all context wiring and drives routes
 * via handleDashboardApi without any real process spawning or SDK calls.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RestHandler } from "../rest-handler.js";
import { ToolEngine } from "../tool-engine.js";
import {
  makeFakeContext,
  fakeAgentEngine,
  makeAgent,
  type FakeContext,
} from "./helpers/fake-context.js";

let fc: FakeContext;
let h: RestHandler;

function build(): RestHandler {
  return new RestHandler(fc.ctx, fakeAgentEngine(), new ToolEngine(fc.ctx));
}

beforeEach(async () => {
  fc = await makeFakeContext({
    withDb: true,
    agentConfigs: [
      makeAgent("optimizer"),
      makeAgent("ideator", { enabled: false }),
    ],
  });
  h = build();
});
afterEach(() => fc.cleanup());

// ---------------------------------------------------------------------------
// agents — GET list, GET individual, POST create, PUT update, DELETE, toggle, run
// ---------------------------------------------------------------------------

describe("RestHandler — agents list & CRUD", () => {
  test("GET /api/agents returns the agentConfigs array", async () => {
    const res = await h.handleDashboardApi("GET", "/api/agents", "");
    expect(res.status).toBe(200);
    const data = res.data as { name: string }[];
    const names = data.map((a) => a.name);
    expect(names).toContain("optimizer");
    expect(names).toContain("ideator");
  });

  test("GET /api/agents/<name> returns the matching agent", async () => {
    const res = await h.handleDashboardApi("GET", "/api/agents/optimizer", "");
    expect(res.status).toBe(200);
    expect((res.data as { name: string }).name).toBe("optimizer");
  });

  test("GET /api/agents/unknown → 404", async () => {
    const res = await h.handleDashboardApi("GET", "/api/agents/unknown-agent", "");
    expect(res.status).toBe(404);
    expect((res.data as { error: string }).error).toContain("Agent not found");
  });

  test("POST /api/agents with invalid JSON → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/agents", "not-json{");
    expect(res.status).toBe(400);
  });

  test("POST /api/agents with missing required fields → 400 validation error", async () => {
    // name/description/prompt are all required by validateAgentConfig
    const res = await h.handleDashboardApi("POST", "/api/agents", JSON.stringify({ name: "x" }));
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toBeTruthy();
  });

  test("DELETE /api/agents/<builtin-name> → 403 when source is builtin", async () => {
    // Build a handler whose context has a builtin agent
    fc.cleanup();
    fc = await makeFakeContext({
      withDb: true,
      agentConfigs: [makeAgent("master-controller", { source: "builtin" } as any)],
    });
    h = build();
    const res = await h.handleDashboardApi("DELETE", "/api/agents/master-controller", "");
    expect(res.status).toBe(403);
    expect((res.data as { error: string }).error).toContain("Cannot delete built-in agent");
  });

  test("DELETE /api/agents/unknown → 404", async () => {
    const res = await h.handleDashboardApi("DELETE", "/api/agents/no-such-agent", "");
    expect(res.status).toBe(404);
  });

  test("PUT /api/agents/unknown → 404", async () => {
    const res = await h.handleDashboardApi("PUT", "/api/agents/no-such-agent", JSON.stringify({ description: "x" }));
    expect(res.status).toBe(404);
  });

  test("PUT /api/agents/<name> with invalid JSON → 400", async () => {
    const res = await h.handleDashboardApi("PUT", "/api/agents/optimizer", "bad{json");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// agents/runs — db-backed run history
// ---------------------------------------------------------------------------

describe("RestHandler — agents/runs", () => {
  test("GET /api/agents/runs → 503 when db is absent", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: false });
    h = build();
    const res = await h.handleDashboardApi("GET", "/api/agents/runs", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/agents/runs returns empty list initially", async () => {
    const res = await h.handleDashboardApi("GET", "/api/agents/runs", "");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  test("GET /api/agents/runs after seeding returns the run", async () => {
    const runId = fc.db!.startAgentRun("optimizer", "test-session", "standalone", "Hello");
    fc.db!.completeAgentRun(runId, "completed", { costUsd: 0.01, inputTokens: 100, outputTokens: 50 });
    const res = await h.handleDashboardApi("GET", "/api/agents/runs", "");
    expect(res.status).toBe(200);
    const runs = res.data as { id: number }[];
    expect(runs.some((r) => r.id === runId)).toBe(true);
  });

  test("GET /api/agents/runs/<id> returns individual run detail", async () => {
    const runId = fc.db!.startAgentRun("optimizer", "s", "manual");
    const res = await h.handleDashboardApi("GET", `/api/agents/runs/${runId}`, "");
    expect(res.status).toBe(200);
    expect((res.data as { id: number }).id).toBe(runId);
  });

  test("GET /api/agents/runs/<unknown-id> → 404", async () => {
    const res = await h.handleDashboardApi("GET", "/api/agents/runs/99999", "");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// agents/costs
// ---------------------------------------------------------------------------

describe("RestHandler — agents/costs", () => {
  test("GET /api/agents/costs → 503 when db absent", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: false });
    h = build();
    const res = await h.handleDashboardApi("GET", "/api/agents/costs", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/agents/costs returns array (empty or populated)", async () => {
    const res = await h.handleDashboardApi("GET", "/api/agents/costs", "");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// agents/<name>/run — standalone agent kick-off (ACK only, no real SDK call)
// ---------------------------------------------------------------------------

describe("RestHandler — agents run endpoint", () => {
  test("POST /api/agents/optimizer/run → 202 ACK", async () => {
    const res = await h.handleDashboardApi("POST", "/api/agents/optimizer/run", "");
    expect(res.status).toBe(202);
    expect((res.data as { ok: boolean }).ok).toBe(true);
  });

  test("POST /api/agents/optimizer/run with SDK active → 409", async () => {
    // Re-build with an attached SDK bridge
    fc.cleanup();
    fc = await makeFakeContext({
      withDb: true,
      agentConfigs: [makeAgent("optimizer")],
      sdkBridge: { isAttached: true },
    });
    h = build();
    const res = await h.handleDashboardApi("POST", "/api/agents/optimizer/run", "");
    expect(res.status).toBe(409);
  });

  test("POST /api/agents/unknown/run → 202 ACK (run route does not gate on agent existence)", async () => {
    // The /run route fires handleStandaloneAgentRun unconditionally (no prior agent-lookup guard).
    // The fake agent engine records the call and returns {} — so the route returns 202.
    const res = await h.handleDashboardApi("POST", "/api/agents/no-such/run", "");
    expect(res.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// agents/<name>/toggle
// ---------------------------------------------------------------------------

describe("RestHandler — agents toggle endpoint", () => {
  test("POST /api/agents/optimizer/toggle → 200 with enabled flag", async () => {
    const res = await h.handleDashboardApi("POST", "/api/agents/optimizer/toggle", "");
    expect(res.status).toBe(200);
    expect(typeof (res.data as { enabled: boolean }).enabled).toBe("boolean");
  });

  test("POST /api/agents/unknown/toggle → 404", async () => {
    const res = await h.handleDashboardApi("POST", "/api/agents/no-such/toggle", "");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// agents/<name>/learnings — db-backed
// ---------------------------------------------------------------------------

describe("RestHandler — agents/learnings", () => {
  test("GET /api/agents/optimizer/learnings → 503 without db", async () => {
    fc.cleanup();
    fc = await makeFakeContext({
      withDb: false,
      agentConfigs: [makeAgent("optimizer")],
    });
    h = build();
    const res = await h.handleDashboardApi("GET", "/api/agents/optimizer/learnings", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/agents/optimizer/learnings returns array after seeding", async () => {
    fc.db!.addLearning("optimizer", "insight", "Always check types before runtime");
    const res = await h.handleDashboardApi("GET", "/api/agents/optimizer/learnings", "");
    expect(res.status).toBe(200);
    const items = res.data as { content: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].content).toBe("Always check types before runtime");
  });
});

// ---------------------------------------------------------------------------
// agents/<name>/personality — db-backed
// ---------------------------------------------------------------------------

describe("RestHandler — agents/personality", () => {
  test("GET /api/agents/optimizer/personality → 503 without db", async () => {
    fc.cleanup();
    fc = await makeFakeContext({
      withDb: false,
      agentConfigs: [makeAgent("optimizer")],
    });
    h = build();
    const res = await h.handleDashboardApi("GET", "/api/agents/optimizer/personality", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/agents/optimizer/personality returns snapshot", async () => {
    fc.db!.setPersonalityTrait("optimizer", "thoroughness", 0.8, "evidence A");
    const res = await h.handleDashboardApi("GET", "/api/agents/optimizer/personality", "");
    expect(res.status).toBe(200);
    const snapshot = res.data as Array<{ trait_name: string }>;
    expect(snapshot.some((t) => t.trait_name === "thoroughness")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// agent-chat — conversation history and clear
// ---------------------------------------------------------------------------

describe("RestHandler — agent-chat", () => {
  test("GET /api/agent-chat/optimizer → 503 without db", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: false });
    h = build();
    const res = await h.handleDashboardApi("GET", "/api/agent-chat/optimizer", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/agent-chat/optimizer returns empty list initially", async () => {
    const res = await h.handleDashboardApi("GET", "/api/agent-chat/optimizer", "");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect((res.data as unknown[]).length).toBe(0);
  });

  test("GET /api/agent-chat/optimizer returns seeded conversation history", async () => {
    fc.db!.appendConversation("optimizer", "user", "Hello optimizer");
    fc.db!.appendConversation("optimizer", "assistant", "Hello user");
    const res = await h.handleDashboardApi("GET", "/api/agent-chat/optimizer", "");
    expect(res.status).toBe(200);
    const history = res.data as { role: string; content: string }[];
    expect(history.length).toBe(2);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("assistant");
  });

  test("DELETE /api/agent-chat/optimizer clears the conversation", async () => {
    fc.db!.appendConversation("optimizer", "user", "Hi");
    const delRes = await h.handleDashboardApi("DELETE", "/api/agent-chat/optimizer", "");
    expect(delRes.status).toBe(200);
    expect((delRes.data as { cleared: number }).cleared).toBeGreaterThan(0);
    // Verify it's gone
    const getRes = await h.handleDashboardApi("GET", "/api/agent-chat/optimizer", "");
    expect((getRes.data as unknown[]).length).toBe(0);
  });

  test("POST /api/agent-chat/optimizer → 400 (use WS for chat)", async () => {
    const res = await h.handleDashboardApi("POST", "/api/agent-chat/optimizer", JSON.stringify({ text: "hi" }));
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("WS");
  });
});

// ---------------------------------------------------------------------------
// agent-messages — inter-agent messages
// ---------------------------------------------------------------------------

describe("RestHandler — agent-messages", () => {
  test("GET /api/agent-messages → 503 without db", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: false });
    h = build();
    const res = await h.handleDashboardApi("GET", "/api/agent-messages", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/agent-messages returns recent messages (empty initially)", async () => {
    const res = await h.handleDashboardApi("GET", "/api/agent-messages", "");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  test("POST /api/agent-messages → 503 without db", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: false });
    h = build();
    const res = await h.handleDashboardApi("POST", "/api/agent-messages", JSON.stringify({
      from: "optimizer", to: "ideator", content: "Hello",
    }));
    expect(res.status).toBe(503);
  });

  test("POST /api/agent-messages with missing fields → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/agent-messages", JSON.stringify({
      from: "optimizer", to: "ideator",
      // content missing
    }));
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("content");
  });

  test("POST /api/agent-messages creates message and broadcasts it", async () => {
    const res = await h.handleDashboardApi("POST", "/api/agent-messages", JSON.stringify({
      from: "optimizer",
      to: "ideator",
      content: "Coordinate please",
      type: "request",
    }));
    expect(res.status).toBe(200);
    expect((res.data as { ok: boolean }).ok).toBe(true);
    expect(typeof (res.data as { id: number }).id).toBe("number");
    // Verify the WS broadcast was triggered
    expect(fc.broadcasts.some((b) => b.type === "agent_message")).toBe(true);
  });

  test("POST /api/agent-messages then GET returns the message", async () => {
    fc.db!.sendAgentMessage("optimizer", "ideator", "Test content");
    const res = await h.handleDashboardApi("GET", "/api/agent-messages", "");
    expect(res.status).toBe(200);
    const msgs = res.data as { content: string }[];
    expect(msgs.some((m) => m.content === "Test content")).toBe(true);
  });

  test("GET /api/agent-messages/pairs returns the distinct-conversation summary", async () => {
    // Regression guard: `pairs` is a single path segment, so the route must be
    // matched BEFORE the two-agent conversation branch (the old `name &&
    // segments[1]` guard shadowed it and this endpoint returned an empty
    // pairs↔pairs conversation). It must now reach getAgentConversationPairs().
    fc.db!.sendAgentMessage("optimizer", "ideator", "Msg A");
    fc.db!.sendAgentMessage("ideator", "optimizer", "Msg B");
    const res = await h.handleDashboardApi("GET", "/api/agent-messages/pairs", "");
    expect(res.status).toBe(200);
    const pairs = res.data as { agent1: string; agent2: string; message_count: number }[];
    expect(Array.isArray(pairs)).toBe(true);
    expect(pairs.length).toBeGreaterThan(0);
    // The optimizer↔ideator pair must appear with both messages counted
    const pair = pairs.find(
      (p) =>
        (p.agent1 === "optimizer" && p.agent2 === "ideator") ||
        (p.agent1 === "ideator" && p.agent2 === "optimizer"),
    );
    expect(pair).toBeDefined();
    expect(pair!.message_count).toBeGreaterThanOrEqual(2);
  });

  test("GET /api/agent-messages/<a>/<b> returns the a↔b conversation (not a↔a)", async () => {
    // Regression guard: agent2 must come from segments[2], not segments[1].
    // The old code passed segments[1] (== agent1) as agent2, so every query
    // compared an agent to itself and returned nothing.
    fc.db!.sendAgentMessage("optimizer", "ideator", "Cross msg");
    fc.db!.sendAgentMessage("optimizer", "optimizer", "Self msg");
    const res = await h.handleDashboardApi(
      "GET",
      "/api/agent-messages/optimizer/ideator",
      "",
    );
    expect(res.status).toBe(200);
    const conv = res.data as { content: string }[];
    expect(conv.some((m) => m.content === "Cross msg")).toBe(true);
    // The self-message must NOT bleed into the optimizer↔ideator conversation
    expect(conv.some((m) => m.content === "Self msg")).toBe(false);
  });

  test("POST /api/agent-messages with invalid JSON → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/agent-messages", "bad{json");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// cognitive — goals, decisions, strategy, messages, metrics
// ---------------------------------------------------------------------------

describe("RestHandler — cognitive (no db)", () => {
  test("GET /api/cognitive/goals → 503 without db", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: false });
    h = build();
    const res = await h.handleDashboardApi("GET", "/api/cognitive/goals", "");
    expect(res.status).toBe(503);
  });

  test("GET /api/cognitive/decisions → 503 without db", async () => {
    // Rebuild without db — each test in this describe must rebuild independently
    // because the module-level `h` gets reset to withDb:true in beforeEach.
    fc.cleanup();
    fc = await makeFakeContext({ withDb: false });
    h = build();
    const res = await h.handleDashboardApi("GET", "/api/cognitive/decisions", "");
    expect(res.status).toBe(503);
  });
});

describe("RestHandler — cognitive goals", () => {
  test("GET /api/cognitive/goals returns goal tree (empty initially)", async () => {
    const res = await h.handleDashboardApi("GET", "/api/cognitive/goals", "");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  test("POST /api/cognitive/goals creates a goal and returns id", async () => {
    const res = await h.handleDashboardApi(
      "POST",
      "/api/cognitive/goals",
      JSON.stringify({ title: "Optimize performance", priority: 3 }),
    );
    expect(res.status).toBe(201);
    expect(typeof (res.data as { id: number }).id).toBe("number");
  });

  test("POST /api/cognitive/goals without title → 400", async () => {
    const res = await h.handleDashboardApi(
      "POST",
      "/api/cognitive/goals",
      JSON.stringify({ description: "no title" }),
    );
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("title");
  });

  test("POST /api/cognitive/goals with invalid JSON → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/cognitive/goals", "{invalid");
    expect(res.status).toBe(400);
  });

  test("GET /api/cognitive/goals returns seeded goal", async () => {
    const id = fc.db!.createGoal("Scale to 10 sessions", { priority: 5 });
    const res = await h.handleDashboardApi("GET", "/api/cognitive/goals", "");
    expect(res.status).toBe(200);
    const goals = res.data as { id: number; title: string }[];
    expect(goals.some((g) => g.id === id && g.title === "Scale to 10 sessions")).toBe(true);
  });
});

describe("RestHandler — cognitive decisions", () => {
  test("GET /api/cognitive/decisions returns empty initially", async () => {
    const res = await h.handleDashboardApi("GET", "/api/cognitive/decisions", "");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  test("GET /api/cognitive/decisions returns seeded decision", async () => {
    fc.db!.recordDecision("optimizer", "restart session", "It was stalled");
    const res = await h.handleDashboardApi("GET", "/api/cognitive/decisions", "");
    const decisions = res.data as { action: string }[];
    expect(decisions.some((d) => d.action === "restart session")).toBe(true);
  });

  test("GET /api/cognitive/metrics returns per-agent metrics", async () => {
    fc.db!.recordDecision("optimizer", "tuned config", "improve velocity");
    const res = await h.handleDashboardApi("GET", "/api/cognitive/metrics", "");
    expect(res.status).toBe(200);
    const metrics = res.data as { agent_name: string }[];
    expect(metrics.some((m) => m.agent_name === "optimizer")).toBe(true);
  });
});

describe("RestHandler — cognitive strategy", () => {
  test("GET /api/cognitive/strategy/optimizer → 404 when none set", async () => {
    const res = await h.handleDashboardApi("GET", "/api/cognitive/strategy/optimizer", "");
    expect(res.status).toBe(404);
  });

  test("GET /api/cognitive/strategy/optimizer returns strategy after evolve", async () => {
    fc.db!.evolveStrategy("optimizer", "Focus on token efficiency", "Initial strategy");
    const res = await h.handleDashboardApi("GET", "/api/cognitive/strategy/optimizer", "");
    expect(res.status).toBe(200);
    expect((res.data as { strategy_text: string }).strategy_text).toBe("Focus on token efficiency");
  });
});

describe("RestHandler — cognitive messages & trigger", () => {
  test("GET /api/cognitive/messages returns unread messages", async () => {
    fc.db!.sendAgentMessage("optimizer", "master-controller", "Check status");
    const res = await h.handleDashboardApi("GET", "/api/cognitive/messages", "");
    expect(res.status).toBe(200);
    const msgs = res.data as { content: string }[];
    expect(msgs.some((m) => m.content === "Check status")).toBe(true);
  });

  test("POST /api/cognitive/trigger → 202 ACK (no SDK active)", async () => {
    const res = await h.handleDashboardApi("POST", "/api/cognitive/trigger", "");
    expect(res.status).toBe(202);
  });

  test("POST /api/cognitive/trigger with SDK active → 409", async () => {
    fc.cleanup();
    fc = await makeFakeContext({
      withDb: true,
      sdkBridge: { isAttached: true },
    });
    h = build();
    const res = await h.handleDashboardApi("POST", "/api/cognitive/trigger", "");
    expect(res.status).toBe(409);
  });

  test("GET /api/cognitive/unknown → 400 unknown cognitive endpoint", async () => {
    const res = await h.handleDashboardApi("GET", "/api/cognitive/not-a-command", "");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// profile — user mind-meld entries
// ---------------------------------------------------------------------------

describe("RestHandler — profile (no db)", () => {
  test("GET /api/profile → 503 without db", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: false });
    h = build();
    const res = await h.handleDashboardApi("GET", "/api/profile", "");
    expect(res.status).toBe(503);
  });
});

describe("RestHandler — profile GET", () => {
  test("GET /api/profile returns empty initially", async () => {
    const res = await h.handleDashboardApi("GET", "/api/profile", "");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  test("GET /api/profile returns seeded entries", async () => {
    fc.db!.addProfileEntry("note", "Prefers concise explanations");
    const res = await h.handleDashboardApi("GET", "/api/profile", "");
    const items = res.data as { content: string }[];
    expect(items.some((i) => i.content === "Prefers concise explanations")).toBe(true);
  });

  test("GET /api/profile?category=trait returns only traits", async () => {
    fc.db!.addProfileEntry("note", "Some note");
    fc.db!.addProfileEntry("trait", "Curious learner");
    const res = await h.handleDashboardApi("GET", "/api/profile?category=trait", "");
    const items = res.data as { category: string }[];
    expect(items.every((i) => i.category === "trait")).toBe(true);
  });
});

describe("RestHandler — profile POST (note and trait)", () => {
  test("POST /api/profile/note without content → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/profile/note", JSON.stringify({ weight: 1 }));
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("content");
  });

  test("POST /api/profile/note creates entry and returns id", async () => {
    const res = await h.handleDashboardApi(
      "POST",
      "/api/profile/note",
      JSON.stringify({ content: "Likes structured output" }),
    );
    expect(res.status).toBe(201);
    expect(typeof (res.data as { id: number | null }).id).toBe("number");
  });

  test("POST /api/profile/trait creates entry with default weight 3.0", async () => {
    const res = await h.handleDashboardApi(
      "POST",
      "/api/profile/trait",
      JSON.stringify({ content: "Analytical" }),
    );
    expect(res.status).toBe(201);
    const id = (res.data as { id: number | null }).id as number;
    // Verify weight stored correctly via GET
    const getRes = await h.handleDashboardApi("GET", "/api/profile?category=trait", "");
    const items = getRes.data as { id: number; weight: number }[];
    const entry = items.find((i) => i.id === id);
    expect(entry?.weight).toBe(3);
  });

  test("POST /api/profile/note with invalid JSON → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/profile/note", "bad{json");
    expect(res.status).toBe(400);
  });

  test("POST /api/profile/trait without content → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/profile/trait", JSON.stringify({ weight: 2 }));
    expect(res.status).toBe(400);
  });
});

describe("RestHandler — profile DELETE", () => {
  test("DELETE /api/profile/<id> removes entry → 200", async () => {
    const id = fc.db!.addProfileEntry("note", "Temporary note") as number;
    const res = await h.handleDashboardApi("DELETE", `/api/profile/${id}`, "");
    expect(res.status).toBe(200);
    expect((res.data as { ok: boolean }).ok).toBe(true);
  });

  test("DELETE /api/profile/<nonexistent> → 404", async () => {
    const res = await h.handleDashboardApi("DELETE", "/api/profile/99999", "");
    expect(res.status).toBe(404);
  });
});

describe("RestHandler — profile/preview", () => {
  test("GET /api/profile/preview returns structured preview", async () => {
    fc.db!.addProfileEntry("trait", "Detail-oriented");
    fc.db!.addProfileEntry("note", "Enjoys debugging");
    const res = await h.handleDashboardApi("GET", "/api/profile/preview", "");
    expect(res.status).toBe(200);
    const data = res.data as { preview: string; counts: Record<string, number> };
    expect(typeof data.preview).toBe("string");
    expect(data.preview.length).toBeGreaterThan(0);
    expect(data.counts.traits).toBeGreaterThanOrEqual(1);
    expect(data.counts.notes).toBeGreaterThanOrEqual(1);
  });
});

describe("RestHandler — profile/chat-export", () => {
  test("POST /api/profile/chat-export chunks and saves content", async () => {
    const res = await h.handleDashboardApi(
      "POST",
      "/api/profile/chat-export",
      JSON.stringify({ content: "A".repeat(100) }),
    );
    expect(res.status).toBe(201);
    const data = res.data as { ok: boolean; chunks: number; saved: number };
    expect(data.ok).toBe(true);
    expect(data.chunks).toBeGreaterThan(0);
  });

  test("POST /api/profile/chat-export without content → 400", async () => {
    const res = await h.handleDashboardApi(
      "POST",
      "/api/profile/chat-export",
      JSON.stringify({ source: "upload" }),
    );
    expect(res.status).toBe(400);
  });
});
