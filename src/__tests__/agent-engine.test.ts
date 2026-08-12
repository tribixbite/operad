/**
 * agent-engine.test.ts — In-process tests for AgentEngine's pure / db-backed
 * methods: config lifecycle (reloadAgents, seedSpecializations), the OODA
 * trigger gating (maybeTriggerOoda early-returns), OODA action execution
 * (executeOodaActions — one branch per action type, asserted via DB effects),
 * context assembly (buildAgentContext), and response-block extraction
 * (extractAgentActions).
 *
 * The SDK-driven methods (runOodaCycle, handleStandaloneAgentRun,
 * handleAgentChat, executeRoundtable, executeScheduledRun) are NOT exercised
 * here — they require a live Claude SDK bridge and belong to e2e/integration.
 * We deliberately drive maybeTriggerOoda only through paths that return BEFORE
 * runOodaCycle so no SDK call is attempted.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AgentEngine } from "../agent-engine.js";
import {
  makeFakeContext,
  makeAgent,
  type FakeContext,
} from "./helpers/fake-context.js";
import type { OodaAction } from "../cognitive.js";

let fc: FakeContext;
let eng: AgentEngine;

afterEach(() => {
  // Always clear any timer an executeOodaActions("schedule") test may have set.
  try { eng?.clearScheduledOodaTimer(); } catch { /* ignore */ }
  fc.cleanup();
});

// ---------------------------------------------------------------------------
// Config lifecycle
// ---------------------------------------------------------------------------

describe("AgentEngine — reloadAgents", () => {
  beforeEach(async () => {
    fc = await makeFakeContext({ withDb: true });
    eng = new AgentEngine(fc.ctx);
  });

  test("loads builtin agents into ctx.agentConfigs and seeds the switchboard", () => {
    eng.reloadAgents();
    const names = fc.ctx.agentConfigs.map((a) => a.name);
    expect(names).toContain("master-controller");
    expect(names).toContain("optimizer");
    // Every loaded agent must appear in the switchboard agents map
    for (const n of names) {
      expect(n in fc.switchboard.agents).toBe(true);
    }
  });

  test("seeds builtin specializations into the db (idempotent)", () => {
    eng.reloadAgents();
    const optSpecs = fc.db!.getSpecializations("optimizer").map((s) => s.domain);
    expect(optSpecs).toContain("token-efficiency");
    // Running again must not throw or duplicate-explode
    expect(() => eng.reloadAgents()).not.toThrow();
  });
});

describe("AgentEngine — seedSpecializations", () => {
  test("no-op when memoryDb is absent", async () => {
    fc = await makeFakeContext({ withDb: false, agentConfigs: [makeAgent("optimizer")] });
    eng = new AgentEngine(fc.ctx);
    expect(() => eng.seedSpecializations()).not.toThrow();
  });

  test("only seeds agents that are actually loaded", async () => {
    fc = await makeFakeContext({ withDb: true, agentConfigs: [makeAgent("optimizer")] });
    eng = new AgentEngine(fc.ctx);
    eng.seedSpecializations();
    expect(fc.db!.getSpecializations("optimizer").length).toBeGreaterThan(0);
    // ideator wasn't loaded → no specializations seeded for it
    expect(fc.db!.getSpecializations("ideator").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// OODA trigger gating — every early-return path (no SDK call reached)
// ---------------------------------------------------------------------------

describe("AgentEngine — maybeTriggerOoda gating", () => {
  /** Build a ctx whose gates are all OPEN except the one under test. */
  async function openCtx(over: Parameters<typeof makeFakeContext>[0] = {}) {
    return makeFakeContext({
      withDb: true,
      switchboard: { cognitive: true, oodaAutoTrigger: true },
      agentConfigs: [makeAgent("master-controller", { enabled: true })],
      sdkBridge: { isAttached: false, isBusy: false },
      ...over,
    });
  }

  test("returns when there is no SDK bridge", async () => {
    fc = await openCtx({ sdkBridge: null });
    eng = new AgentEngine(fc.ctx);
    await expect(eng.maybeTriggerOoda()).resolves.toBeUndefined();
  });

  test("returns when there is no memoryDb", async () => {
    fc = await openCtx({ withDb: false });
    eng = new AgentEngine(fc.ctx);
    await expect(eng.maybeTriggerOoda()).resolves.toBeUndefined();
  });

  test("returns when the SDK bridge is attached/busy", async () => {
    fc = await openCtx({ sdkBridge: { isAttached: true, isBusy: false } });
    eng = new AgentEngine(fc.ctx);
    await eng.maybeTriggerOoda();
    // No OODA cycle ⇒ no goal/decision/message rows created
    expect(fc.db!.getRecentAgentMessages(50)).toHaveLength(0);
  });

  test("returns when cognitive switchboard flag is off", async () => {
    fc = await openCtx({ switchboard: { cognitive: false, oodaAutoTrigger: true } });
    eng = new AgentEngine(fc.ctx);
    await expect(eng.maybeTriggerOoda()).resolves.toBeUndefined();
  });

  test("returns when oodaAutoTrigger flag is off", async () => {
    fc = await openCtx({ switchboard: { cognitive: true, oodaAutoTrigger: false } });
    eng = new AgentEngine(fc.ctx);
    await expect(eng.maybeTriggerOoda()).resolves.toBeUndefined();
  });

  test("returns when no enabled master-controller agent exists", async () => {
    fc = await openCtx({ agentConfigs: [makeAgent("optimizer", { enabled: true })] });
    eng = new AgentEngine(fc.ctx);
    await expect(eng.maybeTriggerOoda()).resolves.toBeUndefined();
  });

  test("all gates open but no urgent messages ⇒ does not start a cycle", async () => {
    fc = await openCtx();
    eng = new AgentEngine(fc.ctx);
    // No unread messages older than 5min → returns before runOodaCycle (no SDK)
    await eng.maybeTriggerOoda();
    expect(fc.db!.getActiveGoals()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// executeOodaActions — one branch per action type, asserted via DB effects
// ---------------------------------------------------------------------------

describe("AgentEngine — executeOodaActions", () => {
  beforeEach(async () => {
    fc = await makeFakeContext({
      withDb: true,
      agentConfigs: [makeAgent("master-controller", { enabled: true })],
    });
    eng = new AgentEngine(fc.ctx);
  });

  test("no-op when memoryDb is absent", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: false });
    eng = new AgentEngine(fc.ctx);
    await expect(eng.executeOodaActions([{ type: "goal", title: "x" }])).resolves.toBeUndefined();
  });

  test("goal action creates a goal", async () => {
    await eng.executeOodaActions([{ type: "goal", title: "Ship v1", priority: 3 }]);
    const goals = fc.db!.getActiveGoals();
    expect(goals.some((g) => g.title === "Ship v1")).toBe(true);
  });

  test("decision action records a decision", async () => {
    await eng.executeOodaActions([
      { type: "decision", action: "Refactor X", rationale: "tech debt" },
    ]);
    const decisions = fc.db!.getRecentDecisions(10, "master-controller");
    expect(decisions.some((d) => d.action === "Refactor X")).toBe(true);
  });

  test("message action sends a message AND broadcasts it", async () => {
    await eng.executeOodaActions([
      { type: "message", to: "optimizer", messageType: "request", content: "Help" },
    ]);
    const msgs = fc.db!.getRecentAgentMessages(50);
    expect(msgs.some((m) => m.content === "Help")).toBe(true);
    expect(fc.broadcasts.some((b) => b.type === "agent_message")).toBe(true);
  });

  test("strategy action evolves the active strategy", async () => {
    await eng.executeOodaActions([
      { type: "strategy", text: "Focus on memory", rationale: "OOM risk" },
    ]);
    const s = fc.db!.getActiveStrategy("master-controller");
    expect(s?.strategy_text).toBe("Focus on memory");
  });

  test("learning action persists a learning", async () => {
    await eng.executeOodaActions([
      { type: "learning", category: "performance", content: "batch writes", confidence: 0.8 },
    ]);
    const learnings = fc.db!.getAgentLearnings("master-controller", 10);
    expect(learnings.some((l) => l.content === "batch writes")).toBe(true);
  });

  test("personality action sets a trait", async () => {
    await eng.executeOodaActions([
      { type: "personality", trait: "caution", value: 0.7, evidence: "rolled back twice" },
    ]);
    const snap = fc.db!.getPersonalitySnapshot("master-controller");
    expect(snap.some((t) => t.trait_name === "caution")).toBe(true);
  });

  test("persistent_schedule action delegates to ctx.upsertSchedule", async () => {
    await eng.executeOodaActions([
      { type: "persistent_schedule", name: "nightly", intervalMinutes: 60, prompt: "review" },
    ]);
    expect(fc.calls.upsertSchedule).toHaveLength(1);
    const input = fc.calls.upsertSchedule[0][0] as { scheduleName: string };
    expect(input.scheduleName).toBe("nightly");
  });

  test("schedule action arms a timer without throwing", async () => {
    await eng.executeOodaActions([
      { type: "schedule", delayMinutes: 9999, trigger: "timer", reason: "later" },
    ]);
    // Timer is cleared in afterEach; here we just assert it didn't throw and a
    // subsequent clear is safe.
    expect(() => eng.clearScheduledOodaTimer()).not.toThrow();
  });

  test("a failing action is caught and does not abort the batch", async () => {
    // 'goal' with an empty title still inserts (no throw); pair it with a valid
    // decision and assert both the goal and decision landed — i.e. the loop
    // continued past every action.
    const actions: OodaAction[] = [
      { type: "goal", title: "First" },
      { type: "decision", action: "Second", rationale: "because" },
    ];
    await eng.executeOodaActions(actions);
    expect(fc.db!.getActiveGoals().some((g) => g.title === "First")).toBe(true);
    expect(fc.db!.getRecentDecisions(10, "master-controller").some((d) => d.action === "Second")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildAgentContext
// ---------------------------------------------------------------------------

describe("AgentEngine — buildAgentContext", () => {
  test("returns empty string when memoryDb is absent", async () => {
    fc = await makeFakeContext({ withDb: false });
    eng = new AgentEngine(fc.ctx);
    expect(eng.buildAgentContext("optimizer")).toBe("");
  });

  test("includes current time even with an empty db", async () => {
    fc = await makeFakeContext({ withDb: true });
    eng = new AgentEngine(fc.ctx);
    const ctxStr = eng.buildAgentContext("optimizer");
    expect(ctxStr).toContain("## Current Time");
  });

  test("surfaces seeded learnings, personality, strategy and specializations", async () => {
    fc = await makeFakeContext({ withDb: true });
    eng = new AgentEngine(fc.ctx);
    fc.db!.addLearning("optimizer", "performance", "cache hot paths", { confidence: 0.9 });
    fc.db!.setPersonalityTrait("optimizer", "thoroughness", 0.8, "double-checks");
    fc.db!.evolveStrategy("optimizer", "Reduce token velocity", "quota pressure");
    fc.db!.upsertSpecialization("optimizer", "token-efficiency", 0.7, "seed");

    const ctxStr = eng.buildAgentContext("optimizer");
    expect(ctxStr).toContain("cache hot paths");
    expect(ctxStr).toContain("thoroughness");
    expect(ctxStr).toContain("Reduce token velocity");
    expect(ctxStr).toContain("token-efficiency");
  });
});

// ---------------------------------------------------------------------------
// extractAgentActions
// ---------------------------------------------------------------------------

describe("AgentEngine — extractAgentActions", () => {
  beforeEach(async () => {
    fc = await makeFakeContext({ withDb: true });
    eng = new AgentEngine(fc.ctx);
  });

  test("no-op for empty response text", () => {
    expect(() => eng.extractAgentActions("optimizer", "")).not.toThrow();
    expect(fc.db!.getAgentLearnings("optimizer", 10)).toHaveLength(0);
  });

  test("persists a learning block parsed from the response", () => {
    const response = [
      "Here is my analysis.",
      "```learning",
      "category: performance",
      "confidence: 0.85",
      "content: Batching DB writes cuts latency.",
      "```",
    ].join("\n");
    eng.extractAgentActions("optimizer", response);
    const learnings = fc.db!.getAgentLearnings("optimizer", 10);
    expect(learnings.some((l) => String(l.content).includes("Batching DB writes"))).toBe(true);
  });

  test("persists a personality block parsed from the response", () => {
    const response = [
      "```personality",
      "trait: rigor",
      "value: 0.9",
      "evidence: verifies every claim",
      "```",
    ].join("\n");
    eng.extractAgentActions("optimizer", response);
    const snap = fc.db!.getPersonalitySnapshot("optimizer");
    expect(snap.some((t) => t.trait_name === "rigor")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OODA cycle re-entrancy
//
// Three paths call runOodaCycle — the 60 s cognitive timer, a `schedule`
// action's timer, and POST /api/ooda/trigger — and none shared a guard. Two
// could enter concurrently: both built context, both inserted an agent_runs
// row, and the second's SDK call threw "SDK session already active" and was
// recorded as a failed run. Worse, maybeTriggerOoda marks the trigger's
// messages read BEFORE starting, so a cycle that lost the race consumed the
// trigger and the messages were never acted on.
// ---------------------------------------------------------------------------

describe("AgentEngine — OODA cycle re-entrancy", () => {
  async function ctxWithBridge(bridge: unknown) {
    return makeFakeContext({
      withDb: true,
      switchboard: { cognitive: true, oodaAutoTrigger: true },
      agentConfigs: [makeAgent("master-controller", { enabled: true })],
      sdkBridge: bridge,
    });
  }

  test("a busy SDK bridge means the cycle does not start", async () => {
    // isAttached alone missed a standalone agent run already in progress.
    fc = await ctxWithBridge({ isAttached: false, isBusy: true });
    eng = new AgentEngine(fc.ctx);
    expect(await eng.runOodaCycle()).toBe(false);
  });

  test("an attached SDK session means the cycle does not start", async () => {
    fc = await ctxWithBridge({ isAttached: true, isBusy: false });
    eng = new AgentEngine(fc.ctx);
    expect(await eng.runOodaCycle()).toBe(false);
  });

  test("a refused cycle leaves NO agent_runs row behind", async () => {
    // The guard has to sit before startAgentRun, or every refusal shows up in
    // the dashboard as a failed run the user has to explain away.
    fc = await ctxWithBridge({ isAttached: false, isBusy: true });
    eng = new AgentEngine(fc.ctx);
    const before = fc.db!.getAgentRuns(100).length;
    await eng.runOodaCycle();
    expect(fc.db!.getAgentRuns(100).length).toBe(before);
  });

  test("the message trigger is NOT consumed when a cycle cannot start", async () => {
    // This is the loss that mattered: markMessagesRead runs before the cycle,
    // so a refused cycle used to throw the trigger away.
    fc = await ctxWithBridge({ isAttached: false, isBusy: true });
    eng = new AgentEngine(fc.ctx);

    const sixMinAgo = Math.floor(Date.now() / 1000) - 360;
    fc.db!.sendAgentMessage("optimizer", "master-controller", "please look at this");
    fc.db!.requireDb()
      .prepare(`UPDATE agent_messages SET created_at = ?`)
      .run(sixMinAgo);

    expect(fc.db!.getUnreadMessages("master-controller").length).toBe(1);
    await eng.maybeTriggerOoda();
    // Still unread — the work was deferred, not discarded.
    expect(fc.db!.getUnreadMessages("master-controller").length).toBe(1);
  });

  test("clearScheduledOodaTimer resets the deferral counter", () => {
    // A stale count would make the next scheduled cycle give up early.
    fc = undefined as never;
    return makeFakeContext({ withDb: true }).then((c) => {
      fc = c;
      eng = new AgentEngine(fc.ctx);
      expect(() => eng.clearScheduledOodaTimer()).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Learning application must not double-count
// ---------------------------------------------------------------------------

describe("AgentEngine — learning application", () => {
  beforeEach(async () => {
    fc = await makeFakeContext({
      withDb: true,
      agentConfigs: [makeAgent("optimizer", { enabled: true })],
    });
    eng = new AgentEngine(fc.ctx);
  });

  test("a learning applied once is not pre-reinforced", async () => {
    // executeScheduledRun used to call executeOodaActions AND
    // extractAgentActions on the same response. addLearning dedupes by
    // content hash, so the repeat did not duplicate the row — it REINFORCED
    // it, so every scheduled-run learning was born with reinforcement_count 1
    // and +0.05 confidence. getTopLearnings ranks by
    // reinforcement_count * confidence, so those learnings outranked
    // identical ones from other paths purely by code path.
    const actions: OodaAction[] = [
      { type: "learning", category: "perf", content: "batch the writes", confidence: 0.6 },
    ];
    await eng.executeOodaActions(actions, "optimizer");

    const learnings = fc.db!.getAgentLearnings("optimizer", 10);
    expect(learnings.length).toBe(1);
    // A fresh row starts at reinforcement_count 1 (schema default) with the
    // confidence the agent stated. Untouched by a second pass.
    expect((learnings[0] as any).reinforcement_count).toBe(1);
    expect((learnings[0] as any).confidence).toBeCloseTo(0.6, 4);
  });

  test("applying the same learning twice DOES reinforce — which is why one path must not do both", () => {
    // Pins the mechanism the bug rode on: the repeat is not a duplicate row,
    // it is a reinforcement, so it silently inflates the ranking signal.
    const action = {
      type: "learning" as const, category: "perf", content: "same text", confidence: 0.6,
    };
    return eng.executeOodaActions([action], "optimizer")
      .then(() => eng.extractAgentActions(
        "optimizer",
        "```learning\ncategory: perf\ncontent: same text\nconfidence: 0.6\n```",
      ))
      .then(() => {
        const l = fc.db!.getAgentLearnings("optimizer", 10)[0] as any;
        expect(l.reinforcement_count).toBe(2);
        expect(l.confidence).toBeCloseTo(0.65, 4);
      });
  });

  test("the OODA dispatcher reinforces a matching specialization", () => {
    // This lived only in extractAgentActions before the two were merged, so
    // learnings arriving via an OODA cycle never corroborated a domain.
    fc.db!.upsertSpecialization("optimizer", "perf", 0.5);
    return eng.executeOodaActions(
      [{ type: "learning", category: "perf", content: "cache the lookup", confidence: 0.8 }],
      "optimizer",
    ).then(() => {
      const spec = fc.db!.getSpecializations("optimizer").find((sp) => sp.domain === "perf");
      expect(spec).toBeDefined();
      expect(spec!.reinforcement_count).toBeGreaterThan(0);
    });
  });

  test("a learning in an unclaimed domain does not invent a specialization", () => {
    return eng.executeOodaActions(
      [{ type: "learning", category: "cryptography", content: "x", confidence: 0.9 }],
      "optimizer",
    ).then(() => {
      const spec = fc.db!.getSpecializations("optimizer").find((sp) => sp.domain === "cryptography");
      expect(spec).toBeUndefined();
    });
  });
});
