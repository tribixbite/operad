/**
 * cognitive.test.ts — Unit tests for parseOodaResponse()
 *
 * Tests the fenced code block parser that extracts structured actions
 * from master controller responses. Each block type has specific
 * required fields; blocks missing required fields are silently skipped.
 */

import { describe, test, expect } from "bun:test";
import { parseOodaResponse } from "../cognitive.js";

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
});
