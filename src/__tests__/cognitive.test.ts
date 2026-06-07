/**
 * cognitive.test.ts — Unit tests for parseOodaResponse() and buildOodaPrompt()
 *
 * Tests the fenced code block parser that extracts structured actions
 * from master controller responses. Each block type has specific
 * required fields; blocks missing required fields are silently skipped.
 *
 * Also covers buildOodaPrompt() section rendering and edge-case formatting.
 */

import { describe, test, expect } from "bun:test";
import { parseOodaResponse, buildOodaPrompt } from "../cognitive.js";
import type { OodaContext, DecisionQualityTrend } from "../cognitive.js";

describe("parseOodaResponse", () => {
  test("parse goal block", () => {
    const input = [
      "Some preamble text.",
      "```goal",
      "title: Improve session uptime",
      "description: Monitor and restart failed sessions proactively",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "goal",
      title: "Improve session uptime",
      description: "Monitor and restart failed sessions proactively",
      priority: undefined,
      parentId: undefined,
    });
  });

  test("parse decision block", () => {
    const input = [
      "```decision",
      "action: Restart degraded session",
      "rationale: Session has been degraded for 5 minutes",
      "alternatives: Wait for self-recovery",
      "expected_outcome: Session returns to running state",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "decision",
      action: "Restart degraded session",
      rationale: "Session has been degraded for 5 minutes",
      alternatives: "Wait for self-recovery",
      expectedOutcome: "Session returns to running state",
      goalId: undefined,
    });
  });

  test("parse message block", () => {
    const input = [
      "```message",
      "to: optimizer",
      "type: request",
      "content: Please analyze token velocity for the past hour",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "message",
      to: "optimizer",
      messageType: "request",
      content: "Please analyze token velocity for the past hour",
    });
  });

  test("parse strategy block", () => {
    const input = [
      "```strategy",
      "text: Prioritize battery conservation during off-peak hours",
      "rationale: User typically inactive between 2-8 AM",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "strategy",
      text: "Prioritize battery conservation during off-peak hours",
      rationale: "User typically inactive between 2-8 AM",
    });
  });

  test("parse learning block", () => {
    const input = [
      "```learning",
      "content: Sessions using ws transport recover faster from network drops",
      "category: observation",
      "confidence: 0.85",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "learning",
      content: "Sessions using ws transport recover faster from network drops",
      category: "observation",
      confidence: 0.85,
    });
  });

  test("parse personality block", () => {
    const input = [
      "```personality",
      "trait: caution",
      "value: 0.7",
      "evidence: Multiple restart decisions have proven premature",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "personality",
      trait: "caution",
      value: 0.7,
      evidence: "Multiple restart decisions have proven premature",
    });
  });

  test("parse tool block", () => {
    const input = [
      "```tool",
      "name: restart_session",
      "session: my-app",
      "force: true",
      "timeout: 30",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("tool_call");
    const action = actions[0] as Extract<typeof actions[0], { type: "tool_call" }>;
    expect(action.name).toBe("restart_session");
    expect(action.params).toEqual({
      session: "my-app",
      force: true,
      timeout: 30,
    });
  });

  test("parse tool_sequence block with --- separators", () => {
    // NOTE: The parser splits the body by "---" and parses each sub-block
    // independently. The top-level `reason` field is read from the whole body
    // via parseBlockFields(body), but it also appears in the first step's
    // params since the step parser only excludes `name` from params.
    const input = [
      "```tool_sequence",
      "reason: Rolling restart of all services",
      "name: stop_session",
      "session: svc-a",
      "---",
      "name: start_session",
      "session: svc-a",
      "---",
      "name: stop_session",
      "session: svc-b",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);

    expect(actions).toHaveLength(1);
    const action = actions[0] as Extract<typeof actions[0], { type: "tool_sequence" }>;
    expect(action.type).toBe("tool_sequence");
    expect(action.reason).toBe("Rolling restart of all services");
    expect(action.steps).toHaveLength(3);
    // First step includes `reason` in params (leaks from shared block before first ---)
    expect(action.steps[0]).toEqual({
      name: "stop_session",
      params: { reason: "Rolling restart of all services", session: "svc-a" },
    });
    expect(action.steps[1]).toEqual({ name: "start_session", params: { session: "svc-a" } });
    expect(action.steps[2]).toEqual({ name: "stop_session", params: { session: "svc-b" } });
  });

  test("parse roundtable block", () => {
    const input = [
      "```roundtable",
      "topic: Should we implement auto-scaling for session memory?",
      "agents: optimizer, ideator, preference-learner",
      "context: Memory pressure has been high this week",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "roundtable",
      topic: "Should we implement auto-scaling for session memory?",
      agents: ["optimizer", "ideator", "preference-learner"],
      context: "Memory pressure has been high this week",
    });
  });

  test("multiple blocks in one response", () => {
    const input = [
      "After observing the system state, I'll take the following actions:",
      "",
      "```goal",
      "title: Reduce memory pressure",
      "description: Target below 80% memory usage",
      "```",
      "",
      "```decision",
      "action: Restart leaky session",
      "rationale: RSS has grown 3x in the past hour",
      "```",
      "",
      "```learning",
      "content: Session X leaks memory after 4 hours",
      "category: pattern",
      "```",
      "",
      "I'll check back in 30 minutes.",
      "",
      "```schedule",
      "delay_minutes: 30",
      "trigger: timer",
      "reason: Follow up on memory actions",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);

    expect(actions).toHaveLength(4);
    expect(actions[0].type).toBe("goal");
    expect(actions[1].type).toBe("decision");
    expect(actions[2].type).toBe("learning");
    expect(actions[3].type).toBe("schedule");
  });

  test("malformed block (missing required fields) is skipped", () => {
    const input = [
      "```goal",
      "description: No title provided here",
      "```",
      "",
      "```decision",
      "action: Only action, no rationale",
      "```",
      "",
      "```goal",
      "title: This one is valid",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);

    // Only the valid goal block should be parsed
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("goal");
    expect((actions[0] as any).title).toBe("This one is valid");
  });

  test("empty input returns empty array", () => {
    const actions = parseOodaResponse("");
    expect(actions).toEqual([]);
  });

  test("text without code blocks returns empty array", () => {
    const input = "Just some plain text without any fenced code blocks.\nAnother line.";
    const actions = parseOodaResponse(input);
    expect(actions).toEqual([]);
  });

  // ---- schedule block --------------------------------------------------------

  test("parse schedule block with all fields", () => {
    const input = [
      "```schedule",
      "delay_minutes: 30",
      "trigger: timer",
      "reason: Follow up on memory actions",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<typeof actions[0], { type: "schedule" }>;
    expect(a.type).toBe("schedule");
    expect(a.delayMinutes).toBe(30);
    expect(a.trigger).toBe("timer");
    expect(a.reason).toBe("Follow up on memory actions");
  });

  test("parse schedule block with defaults when trigger/reason absent", () => {
    const input = [
      "```schedule",
      "delay_minutes: 60",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<typeof actions[0], { type: "schedule" }>;
    expect(a.delayMinutes).toBe(60);
    expect(a.trigger).toBe("timer");    // default
    expect(a.reason).toBe("scheduled"); // default
  });

  test("schedule block missing delay_minutes is skipped", () => {
    const input = [
      "```schedule",
      "trigger: timer",
      "reason: no delay specified",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(0);
  });

  // ---- persistent_schedule block ---------------------------------------------

  test("parse persistent_schedule with cron expression", () => {
    const input = [
      "```persistent_schedule",
      "name: nightly-reflection",
      "cron: 0 2 * * *",
      "prompt: Perform nightly reflection and update strategy",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<typeof actions[0], { type: "persistent_schedule" }>;
    expect(a.type).toBe("persistent_schedule");
    expect(a.name).toBe("nightly-reflection");
    expect(a.cronExpr).toBe("0 2 * * *");
    expect(a.intervalMinutes).toBeUndefined();
    expect(a.prompt).toBe("Perform nightly reflection and update strategy");
    expect(a.maxBudgetUsd).toBeUndefined();
  });

  test("parse persistent_schedule with interval_minutes and max_budget_usd", () => {
    const input = [
      "```persistent_schedule",
      "name: hourly-check",
      "interval_minutes: 60",
      "prompt: Check session health",
      "max_budget_usd: 0.05",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<typeof actions[0], { type: "persistent_schedule" }>;
    expect(a.intervalMinutes).toBe(60);
    expect(a.maxBudgetUsd).toBeCloseTo(0.05);
    expect(a.cronExpr).toBeUndefined();
  });

  test("persistent_schedule missing name is skipped", () => {
    const input = [
      "```persistent_schedule",
      "prompt: No name provided",
      "interval_minutes: 30",
      "```",
    ].join("\n");

    expect(parseOodaResponse(input)).toHaveLength(0);
  });

  test("persistent_schedule missing prompt is skipped", () => {
    const input = [
      "```persistent_schedule",
      "name: orphan-schedule",
      "interval_minutes: 30",
      "```",
    ].join("\n");

    expect(parseOodaResponse(input)).toHaveLength(0);
  });

  // ---- goal with optional fields ---------------------------------------------

  test("parse goal block with priority and parent_id", () => {
    const input = [
      "```goal",
      "title: Sub-goal task",
      "description: A nested sub-goal",
      "priority: 2",
      "parent_id: 7",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<typeof actions[0], { type: "goal" }>;
    expect(a.priority).toBe(2);
    expect(a.parentId).toBe(7);
    expect(a.description).toBe("A nested sub-goal");
  });

  // ---- decision with optional goalId -----------------------------------------

  test("parse decision block with goal_id", () => {
    const input = [
      "```decision",
      "action: Restart session",
      "rationale: Memory exceeds threshold",
      "goal_id: 3",
      "expected_outcome: Session returns to healthy state",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<typeof actions[0], { type: "decision" }>;
    expect(a.goalId).toBe(3);
    expect(a.expectedOutcome).toBe("Session returns to healthy state");
  });

  test("decision missing rationale is skipped", () => {
    const input = [
      "```decision",
      "action: Some action without rationale",
      "```",
    ].join("\n");

    expect(parseOodaResponse(input)).toHaveLength(0);
  });

  // ---- message defaults ------------------------------------------------------

  test("message without type field defaults messageType to 'info'", () => {
    const input = [
      "```message",
      "to: optimizer",
      "content: Please review token usage",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<typeof actions[0], { type: "message" }>;
    expect(a.messageType).toBe("info");
  });

  test("message missing to field is skipped", () => {
    const input = [
      "```message",
      "content: Message with no recipient",
      "type: request",
      "```",
    ].join("\n");

    expect(parseOodaResponse(input)).toHaveLength(0);
  });

  test("message missing content field is skipped", () => {
    const input = [
      "```message",
      "to: optimizer",
      "type: request",
      "```",
    ].join("\n");

    expect(parseOodaResponse(input)).toHaveLength(0);
  });

  // ---- strategy required fields ----------------------------------------------

  test("strategy missing rationale is skipped", () => {
    const input = [
      "```strategy",
      "text: Do more things carefully",
      "```",
    ].join("\n");

    expect(parseOodaResponse(input)).toHaveLength(0);
  });

  test("strategy missing text is skipped", () => {
    const input = [
      "```strategy",
      "rationale: No strategy text provided",
      "```",
    ].join("\n");

    expect(parseOodaResponse(input)).toHaveLength(0);
  });

  // ---- tool block type coercion ----------------------------------------------

  test("tool block coerces boolean and numeric params correctly", () => {
    const input = [
      "```tool",
      "name: adjust_threshold",
      "dry_run: true",
      "force: false",
      "threshold: 0.75",
      "count: 3",
      "label: memory-high",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<typeof actions[0], { type: "tool_call" }>;
    expect(a.params.dry_run).toBe(true);
    expect(a.params.force).toBe(false);
    expect(a.params.threshold).toBeCloseTo(0.75);
    expect(a.params.count).toBe(3);
    // String values preserved as strings
    expect(a.params.label).toBe("memory-high");
  });

  test("tool block with id field — id passed through, excluded from params", () => {
    const input = [
      "```tool",
      "name: list_sessions",
      "id: call-42",
      "status: active",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<typeof actions[0], { type: "tool_call" }>;
    expect(a.id).toBe("call-42");
    // id must NOT appear in params
    expect(a.params).not.toHaveProperty("id");
    expect(a.params.status).toBe("active");
  });

  test("tool block missing name is skipped", () => {
    const input = [
      "```tool",
      "session: my-app",
      "force: true",
      "```",
    ].join("\n");

    expect(parseOodaResponse(input)).toHaveLength(0);
  });

  // ---- roundtable edge cases -------------------------------------------------

  test("roundtable with single agent parses correctly", () => {
    const input = [
      "```roundtable",
      "topic: Evaluate token cost of nightly reflection",
      "agents: optimizer",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<typeof actions[0], { type: "roundtable" }>;
    expect(a.agents).toEqual(["optimizer"]);
    expect(a.context).toBeUndefined();
  });

  test("roundtable with empty agents string is skipped", () => {
    const input = [
      "```roundtable",
      "topic: No agents specified",
      "agents:   ",
      "```",
    ].join("\n");

    // agents.split(",").map(trim).filter(Boolean) → []
    expect(parseOodaResponse(input)).toHaveLength(0);
  });

  test("roundtable missing topic is skipped", () => {
    const input = [
      "```roundtable",
      "agents: optimizer, ideator",
      "```",
    ].join("\n");

    expect(parseOodaResponse(input)).toHaveLength(0);
  });

  // ---- multi-line value continuation -----------------------------------------

  test("parseBlockFields handles indented continuation lines as multi-line value", () => {
    // Decision block with a multi-line rationale (continuation lines indented with 2+ spaces)
    const input = [
      "```decision",
      "action: Complex restart sequence",
      "rationale: Memory grew 3x in 4 hours.",
      "  Also, the error rate increased.",
      "  Two compounding signals warrant action.",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<typeof actions[0], { type: "decision" }>;
    // The rationale should include continuation lines joined by newlines
    expect(a.rationale).toContain("Memory grew 3x in 4 hours.");
    expect(a.rationale).toContain("Also, the error rate increased.");
    expect(a.rationale).toContain("Two compounding signals warrant action.");
  });

  // ---- tool_sequence edge cases ----------------------------------------------

  test("tool_sequence with no named steps is skipped", () => {
    // A body with only a reason line and no step with a name field
    const input = [
      "```tool_sequence",
      "reason: Orphaned sequence",
      "```",
    ].join("\n");

    // The single block before first "---" has no `name` field, so steps = []
    expect(parseOodaResponse(input)).toHaveLength(0);
  });

  test("tool_sequence reason defaults when absent", () => {
    const input = [
      "```tool_sequence",
      "name: stop_session",
      "session: svc-a",
      "---",
      "name: start_session",
      "session: svc-a",
      "```",
    ].join("\n");

    const actions = parseOodaResponse(input);
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<typeof actions[0], { type: "tool_sequence" }>;
    expect(a.reason).toBe("multi-step tool execution"); // default
    expect(a.steps).toHaveLength(2);
  });
});

// ---- buildOodaPrompt — section rendering ------------------------------------

/**
 * Build a minimal OodaContext to drive buildOodaPrompt() deterministically.
 * The function is pure (reads only ctx + Date.now) — we test section presence
 * and key formatting logic without a real DB.
 */
function minimalCtx(overrides: Partial<OodaContext> = {}): OodaContext {
  const emptyTrend: DecisionQualityTrend = {
    avg_score: null,
    scored_count: 0,
    total_count: 0,
    trend: "insufficient_data",
  };
  return {
    observations: {
      sessions: [],
      memory: null,
      battery: null,
      quota: {
        weekly_tokens_used: 0,
        weekly_tokens_limit: 0,
        weekly_pct: 0,
        weekly_level: "ok",
        daily_avg_tokens: 0,
        window_tokens_used: 0,
        window_hours: 5,
        tokens_per_hour: 0,
        velocity_trend: "stable",
        top_sessions: [],
        plan: null,
        rate_limit_tier: null,
        projected_weekly_total: 0,
      },
      pending_goals: 0,
      unread_messages: 0,
    },
    goals: [],
    decisionHistory: [],
    decisionTrend: emptyTrend,
    inbox: [],
    strategy: null,
    userProfile: { traits: [], notes: [], styles: [], chat_export_count: 0 },
    personality: [],
    agentLearnings: [],
    sharedInsights: [],
    personalityDrift: [],
    ...overrides,
  };
}

describe("buildOodaPrompt", () => {
  test("minimal context produces all required section headers", () => {
    const prompt = buildOodaPrompt(minimalCtx());
    expect(prompt).toContain("## Current Time");
    expect(prompt).toContain("## System State");
    expect(prompt).toContain("## Active Goals");
    expect(prompt).toContain("## Decision Journal");
    expect(prompt).toContain("## Current Strategy");
    expect(prompt).toContain("## Available Actions");
  });

  test("no active goals shows placeholder text", () => {
    const prompt = buildOodaPrompt(minimalCtx({ goals: [] }));
    expect(prompt).toContain("No active goals");
  });

  test("no decisions shows placeholder text", () => {
    const prompt = buildOodaPrompt(minimalCtx({ decisionHistory: [] }));
    expect(prompt).toContain("No decisions recorded yet");
  });

  test("no strategy shows placeholder text", () => {
    const prompt = buildOodaPrompt(minimalCtx({ strategy: null }));
    expect(prompt).toContain("No strategy defined yet");
  });

  test("strategy text is rendered verbatim when present", () => {
    const ctx = minimalCtx({ strategy: "Prioritize battery when below 40%." });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("Prioritize battery when below 40%.");
    expect(prompt).not.toContain("No strategy defined");
  });

  test("session list is rendered with status", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        sessions: [
          { name: "api", status: "running", activity: null, rss_mb: 120 },
          { name: "worker", status: "degraded", activity: "indexing", rss_mb: null },
        ],
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("api: running");
    expect(prompt).toContain("120MB");
    expect(prompt).toContain("worker: degraded");
    expect(prompt).toContain("indexing");
  });

  test("memory section rendered when present", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        memory: { available_mb: 512, pressure: "normal" },
      },
    });
    expect(buildOodaPrompt(ctx)).toContain("512MB available (normal)");
  });

  test("battery section rendered when present", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        battery: { pct: 75, charging: true },
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("75%");
    expect(prompt).toContain("(charging)");
  });

  test("battery discharging indicator", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        battery: { pct: 20, charging: false },
      },
    });
    expect(buildOodaPrompt(ctx)).toContain("(discharging)");
  });

  test("quota critical warning injected when level is critical", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        quota: {
          weekly_tokens_used: 90_000,
          weekly_tokens_limit: 100_000,
          weekly_pct: 90,
          weekly_level: "critical",
          daily_avg_tokens: 15_000,
          window_tokens_used: 10_000,
          window_hours: 5,
          tokens_per_hour: 2_000,
          velocity_trend: "rising",
          top_sessions: [],
          rate_limit_tier: null,
          plan: null,
          projected_weekly_total: 105_000,
        },
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("QUOTA WARNING");
    expect(prompt).toContain("conserve tokens");
  });

  test("quota exceeded warning injected when level is exceeded", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        quota: {
          weekly_tokens_used: 105_000,
          weekly_tokens_limit: 100_000,
          weekly_pct: 105,
          weekly_level: "exceeded",
          daily_avg_tokens: 20_000,
          window_tokens_used: 15_000,
          window_hours: 5,
          tokens_per_hour: 3_000,
          velocity_trend: "rising",
          top_sessions: [],
          rate_limit_tier: null,
          plan: null,
          projected_weekly_total: 130_000,
        },
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("QUOTA EXCEEDED");
    expect(prompt).toContain("Only essential observe tools");
  });

  test("no quota warning when level is ok", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        quota: {
          ...minimalCtx().observations.quota,
          weekly_level: "ok",
          weekly_pct: 20,
        },
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).not.toContain("QUOTA WARNING");
    expect(prompt).not.toContain("QUOTA EXCEEDED");
  });

  test("decision quality section rendered when trend is not insufficient_data", () => {
    const ctx = minimalCtx({
      decisionTrend: {
        avg_score: 0.82,
        scored_count: 5,
        total_count: 7,
        trend: "improving",
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("## Decision Quality");
    expect(prompt).toContain("0.82");
    expect(prompt).toContain("improving");
  });

  test("decision quality section omitted when trend is insufficient_data", () => {
    const prompt = buildOodaPrompt(minimalCtx()); // default trend = insufficient_data
    expect(prompt).not.toContain("## Decision Quality");
  });

  test("personality section rendered with drift indicators", () => {
    const ctx = minimalCtx({
      personality: [
        { trait_name: "caution", trait_value: 0.75, evidence: "Restarted 3 times" },
      ],
      personalityDrift: [
        { trait_name: "caution", current_value: 0.75, previous_value: 0.55, delta: 0.2 },
      ],
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("## Your Personality");
    expect(prompt).toContain("caution");
    expect(prompt).toContain("0.75");
    // drift arrow indicator (↑) present when delta > 0
    expect(prompt).toContain("↑");
    expect(prompt).toContain("+0.20");
  });

  test("personality section rendered without drift when no drift data", () => {
    const ctx = minimalCtx({
      personality: [
        { trait_name: "boldness", trait_value: 0.5, evidence: null },
      ],
      personalityDrift: [],
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("boldness");
    expect(prompt).toContain("(stable)");
    expect(prompt).not.toContain("↑");
    expect(prompt).not.toContain("↓");
  });

  test("agent learnings section rendered with category summary", () => {
    const ctx = minimalCtx({
      agentLearnings: [
        { category: "observation", content: "Sessions recover faster on ws", confidence: 0.9, reinforcement_count: 3 },
        { category: "observation", content: "Battery drains fast under load", confidence: 0.7, reinforcement_count: 1 },
        { category: "pattern", content: "Peaks occur at 9 AM", confidence: 0.8, reinforcement_count: 2 },
      ],
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("## Your Knowledge Base");
    // 2 observations, 1 pattern should appear in summary
    expect(prompt).toContain("2 observations");
    expect(prompt).toContain("1 patterns");
    // reinforced indicator for count > 1
    expect(prompt).toContain("reinforced 3x");
  });

  test("cross-agent insights section rendered when sharedInsights present", () => {
    const ctx = minimalCtx({
      sharedInsights: [
        { agent_name: "optimizer", content: "Token spike at 14:00 daily", confidence: 0.92 },
      ],
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("## Insights from Other Agents");
    expect(prompt).toContain("optimizer");
    expect(prompt).toContain("Token spike at 14:00 daily");
  });

  test("inbox section rendered when messages present", () => {
    const ctx = minimalCtx({
      inbox: [
        { from_agent: "ideator", message_type: "request", content: "Review my strategy draft" },
      ],
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("## Inbox (unread)");
    expect(prompt).toContain("ideator");
    expect(prompt).toContain("Review my strategy draft");
  });

  test("user profile rendered when traits or notes present", () => {
    const ctx = minimalCtx({
      userProfile: {
        traits: [{ content: "Values conciseness", weight: 1.5 }],
        notes: [{ content: "Prefers dark mode UI", weight: 1.0 }],
        styles: [],
        chat_export_count: 0,
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("## User Profile");
    expect(prompt).toContain("Values conciseness");
    expect(prompt).toContain("Prefers dark mode UI");
  });

  test("chat export count hint rendered when count > 0", () => {
    const ctx = minimalCtx({
      userProfile: {
        traits: [{ content: "Some trait", weight: 1.0 }],
        notes: [],
        styles: [],
        chat_export_count: 42,
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("42 chat export segments");
  });

  test("available tools section rendered when availableToolsPrompt present", () => {
    const ctx = minimalCtx({ availableToolsPrompt: "- restart_session: Restart a named session" });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("## Available Tools");
    expect(prompt).toContain("restart_session");
    // tool block listed in Available Actions
    expect(prompt).toContain("`tool`");
  });

  test("available tools section absent when availableToolsPrompt not provided", () => {
    const prompt = buildOodaPrompt(minimalCtx());
    expect(prompt).not.toContain("## Available Tools");
    // tool action NOT listed when no tools registered
    expect(prompt).not.toContain("`tool`");
  });

  test("top token consumers rendered when quota.top_sessions has entries", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        quota: {
          ...minimalCtx().observations.quota,
          weekly_tokens_limit: 100_000,
          weekly_tokens_used: 50_000,
          top_sessions: [
            { name: "api", tokens: 30_000, pct: 60 },
            { name: "worker", tokens: 15_000, pct: 30 },
          ],
        },
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("Top consumers");
    expect(prompt).toContain("api");
    expect(prompt).toContain("worker");
  });

  test("fmtTokens renders M suffix for values >= 1_000_000", () => {
    // Exercised indirectly via weekly_tokens_used
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        quota: {
          ...minimalCtx().observations.quota,
          weekly_tokens_used: 2_500_000,
          weekly_tokens_limit: 0,
        },
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("2.5M");
  });

  test("fmtTokens renders K suffix for values >= 1_000 but < 1_000_000", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        quota: {
          ...minimalCtx().observations.quota,
          weekly_tokens_used: 45_000,
          weekly_tokens_limit: 0,
        },
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("45K");
  });

  test("fmtTokens renders raw number for values < 1_000", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        quota: {
          ...minimalCtx().observations.quota,
          weekly_tokens_used: 500,
          weekly_tokens_limit: 0,
        },
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("500");
    // Must not apply K suffix
    expect(prompt).not.toContain("500K");
  });

  test("plan label rendered when quota.plan is set", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        quota: {
          ...minimalCtx().observations.quota,
          plan: "Pro",
        },
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("Claude Pro");
    expect(prompt).toContain("(auto-detected)");
  });

  test("velocity rising arrow rendered in window section", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        quota: {
          ...minimalCtx().observations.quota,
          velocity_trend: "rising",
          tokens_per_hour: 1234,
          window_hours: 5,
          window_tokens_used: 6000,
        },
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("↑");
    expect(prompt).toContain("1K/hr");
  });

  test("velocity falling arrow rendered in window section", () => {
    const ctx = minimalCtx({
      observations: {
        ...minimalCtx().observations,
        quota: {
          ...minimalCtx().observations.quota,
          velocity_trend: "falling",
          tokens_per_hour: 200,
          window_hours: 5,
          window_tokens_used: 1000,
        },
      },
    });
    const prompt = buildOodaPrompt(ctx);
    expect(prompt).toContain("↓");
  });
});
