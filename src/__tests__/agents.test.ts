/**
 * agents.test.ts — Unit tests for agents.ts
 *
 * Coverage areas:
 *   - validateAgentConfig: name pattern enforcement, required fields,
 *     optional field validation (effort, memory, permission_mode, max_turns,
 *     max_budget_usd), accumulation of multiple errors, valid configs
 *   - getBuiltinAgents: shape, uniqueness, required fields present
 *   - toSdkAgentMap: disabled agents excluded, snake_case → camelCase mapping,
 *     operad-only fields stripped, optional fields conditional inclusion
 *   - loadAgents: builtin layer, TOML override merge, project override wins,
 *     disabled agents preserved in loadAgents (only toSdkAgentMap filters)
 *   - discoverProjectAgents: missing dir → empty, invalid JSON skipped,
 *     invalid agent config skipped, valid agent loaded
 *   - parseTomlAgents: name required, optional fields, defaults applied
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  validateAgentConfig,
  getBuiltinAgents,
  toSdkAgentMap,
  loadAgents,
  discoverProjectAgents,
  parseTomlAgents,
  type AgentConfig,
} from "../agents.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-agents-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

/** Build a minimal valid AgentConfig for use in tests */
function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "A test agent",
    prompt: "You are a test agent.",
    enabled: true,
    source: "toml",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateAgentConfig
// ---------------------------------------------------------------------------

describe("validateAgentConfig — name validation", () => {
  test("valid name (lowercase, digits, hyphens) returns no errors", () => {
    const errors = validateAgentConfig(makeAgent({ name: "my-agent-42" }));
    expect(errors).toHaveLength(0);
  });

  test("missing name produces error", () => {
    const errors = validateAgentConfig(makeAgent({ name: "" }));
    expect(errors.some(e => e.includes("name is required"))).toBe(true);
  });

  test("name with uppercase letters is rejected", () => {
    const errors = validateAgentConfig(makeAgent({ name: "MyAgent" }));
    expect(errors.some(e => e.includes("name"))).toBe(true);
  });

  test("name with spaces is rejected", () => {
    const errors = validateAgentConfig(makeAgent({ name: "my agent" }));
    expect(errors.some(e => e.includes("name"))).toBe(true);
  });

  test("name with path-traversal characters is rejected", () => {
    const errors = validateAgentConfig(makeAgent({ name: "../etc-passwd" }));
    expect(errors.some(e => e.includes("name"))).toBe(true);
  });

  test("name with underscore is rejected (only hyphens allowed)", () => {
    const errors = validateAgentConfig(makeAgent({ name: "my_agent" }));
    expect(errors.some(e => e.includes("name"))).toBe(true);
  });

  test("single-character lowercase name is valid", () => {
    const errors = validateAgentConfig(makeAgent({ name: "a" }));
    expect(errors).toHaveLength(0);
  });

  test("name that is all digits is valid", () => {
    const errors = validateAgentConfig(makeAgent({ name: "123" }));
    expect(errors).toHaveLength(0);
  });
});

describe("validateAgentConfig — required fields", () => {
  test("missing description produces error", () => {
    const errors = validateAgentConfig(makeAgent({ description: "" }));
    expect(errors.some(e => e.includes("description"))).toBe(true);
  });

  test("missing prompt produces error", () => {
    const errors = validateAgentConfig(makeAgent({ prompt: "" }));
    expect(errors.some(e => e.includes("prompt"))).toBe(true);
  });

  test("all required fields present → no errors", () => {
    expect(validateAgentConfig(makeAgent())).toHaveLength(0);
  });
});

describe("validateAgentConfig — optional field validation", () => {
  test("valid effort level 'low' is accepted", () => {
    expect(validateAgentConfig(makeAgent({ effort: "low" }))).toHaveLength(0);
  });

  test("valid effort level 'max' is accepted", () => {
    expect(validateAgentConfig(makeAgent({ effort: "max" }))).toHaveLength(0);
  });

  test("invalid effort level produces error", () => {
    // @ts-expect-error — intentionally passing invalid value
    const errors = validateAgentConfig(makeAgent({ effort: "ultra" }));
    expect(errors.some(e => e.includes("effort"))).toBe(true);
  });

  test("valid memory scope 'user' is accepted", () => {
    expect(validateAgentConfig(makeAgent({ memory: "user" }))).toHaveLength(0);
  });

  test("invalid memory scope produces error", () => {
    // @ts-expect-error — intentionally passing invalid value
    const errors = validateAgentConfig(makeAgent({ memory: "global" }));
    expect(errors.some(e => e.includes("memory"))).toBe(true);
  });

  test("valid permission_mode 'bypassPermissions' is accepted", () => {
    expect(validateAgentConfig(makeAgent({ permission_mode: "bypassPermissions" }))).toHaveLength(0);
  });

  test("invalid permission_mode produces error", () => {
    // @ts-expect-error — intentionally passing invalid value
    const errors = validateAgentConfig(makeAgent({ permission_mode: "sudo" }));
    expect(errors.some(e => e.includes("permission_mode"))).toBe(true);
  });

  test("max_turns = 1 is valid", () => {
    expect(validateAgentConfig(makeAgent({ max_turns: 1 }))).toHaveLength(0);
  });

  test("max_turns = 0 is invalid", () => {
    const errors = validateAgentConfig(makeAgent({ max_turns: 0 }));
    expect(errors.some(e => e.includes("max_turns"))).toBe(true);
  });

  test("max_turns fractional is invalid", () => {
    const errors = validateAgentConfig(makeAgent({ max_turns: 1.5 }));
    expect(errors.some(e => e.includes("max_turns"))).toBe(true);
  });

  test("max_budget_usd > 0 is valid", () => {
    expect(validateAgentConfig(makeAgent({ max_budget_usd: 0.01 }))).toHaveLength(0);
  });

  test("max_budget_usd = 0 is invalid", () => {
    const errors = validateAgentConfig(makeAgent({ max_budget_usd: 0 }));
    expect(errors.some(e => e.includes("max_budget_usd"))).toBe(true);
  });

  test("max_budget_usd negative is invalid", () => {
    const errors = validateAgentConfig(makeAgent({ max_budget_usd: -1 }));
    expect(errors.some(e => e.includes("max_budget_usd"))).toBe(true);
  });

  test("multiple invalid fields accumulate into multiple errors", () => {
    const errors = validateAgentConfig(makeAgent({
      name: "BAD NAME!",
      description: "",
      // @ts-expect-error — intentionally passing invalid value
      effort: "ultra",
      max_turns: 0,
    }));
    // Should have at least 3 errors: name + description + effort + max_turns
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// getBuiltinAgents
// ---------------------------------------------------------------------------

describe("getBuiltinAgents", () => {
  test("returns exactly 4 agents", () => {
    expect(getBuiltinAgents()).toHaveLength(4);
  });

  test("all agent names are unique", () => {
    const names = getBuiltinAgents().map(a => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("all agents have source = 'builtin'", () => {
    expect(getBuiltinAgents().every(a => a.source === "builtin")).toBe(true);
  });

  test("all agents have non-empty name, description, and prompt", () => {
    for (const agent of getBuiltinAgents()) {
      expect(agent.name.length).toBeGreaterThan(0);
      expect(agent.description.length).toBeGreaterThan(0);
      expect(agent.prompt.length).toBeGreaterThan(0);
    }
  });

  test("all agents have names matching /^[a-z0-9-]+$/", () => {
    const pattern = /^[a-z0-9-]+$/;
    for (const agent of getBuiltinAgents()) {
      expect(pattern.test(agent.name)).toBe(true);
    }
  });

  test("all builtin agents are disabled by default", () => {
    expect(getBuiltinAgents().every(a => !a.enabled)).toBe(true);
  });

  test("master-controller agent exists with correct properties", () => {
    const mc = getBuiltinAgents().find(a => a.name === "master-controller");
    expect(mc).toBeDefined();
    expect(mc!.effort).toBe("max");
    expect(mc!.max_turns).toBeGreaterThan(0);
  });

  test("optimizer agent is read-only (has disallowed_tools with Write, Edit, Bash)", () => {
    const opt = getBuiltinAgents().find(a => a.name === "optimizer");
    expect(opt?.disallowed_tools).toContain("Write");
    expect(opt?.disallowed_tools).toContain("Edit");
    expect(opt?.disallowed_tools).toContain("Bash");
  });

  test("preference-learner has memory = 'user'", () => {
    const pl = getBuiltinAgents().find(a => a.name === "preference-learner");
    expect(pl?.memory).toBe("user");
  });

  test("each call returns a fresh array (not a shared reference)", () => {
    const a = getBuiltinAgents();
    const b = getBuiltinAgents();
    // Mutating a does not affect b
    a[0].name = "mutated";
    expect(b[0].name).toBe("master-controller");
  });
});

// ---------------------------------------------------------------------------
// toSdkAgentMap
// ---------------------------------------------------------------------------

describe("toSdkAgentMap", () => {
  test("disabled agents are excluded from the SDK map", () => {
    const agents = [
      makeAgent({ name: "enabled-one", enabled: true }),
      makeAgent({ name: "disabled-one", enabled: false }),
    ];
    const map = toSdkAgentMap(agents);
    expect("enabled-one" in map).toBe(true);
    expect("disabled-one" in map).toBe(false);
  });

  test("empty agents array returns empty map", () => {
    expect(toSdkAgentMap([])).toEqual({});
  });

  test("all disabled → empty map", () => {
    const agents = [
      makeAgent({ name: "a", enabled: false }),
      makeAgent({ name: "b", enabled: false }),
    ];
    expect(toSdkAgentMap(agents)).toEqual({});
  });

  test("description and prompt are always included", () => {
    const agent = makeAgent({ name: "x", enabled: true, description: "desc", prompt: "prompt text" });
    const map = toSdkAgentMap([agent]);
    expect(map.x.description).toBe("desc");
    expect(map.x.prompt).toBe("prompt text");
  });

  test("operad-only field 'enabled' is NOT in the SDK output", () => {
    const map = toSdkAgentMap([makeAgent({ name: "x", enabled: true })]);
    expect("enabled" in map.x).toBe(false);
  });

  test("operad-only field 'source' is NOT in the SDK output", () => {
    const map = toSdkAgentMap([makeAgent({ name: "x", enabled: true })]);
    expect("source" in map.x).toBe(false);
  });

  test("operad-only field 'max_budget_usd' is NOT in the SDK output", () => {
    const map = toSdkAgentMap([makeAgent({ name: "x", enabled: true, max_budget_usd: 5.0 })]);
    expect("max_budget_usd" in map.x).toBe(false);
  });

  test("snake_case 'max_turns' maps to camelCase 'maxTurns'", () => {
    const map = toSdkAgentMap([makeAgent({ name: "x", enabled: true, max_turns: 42 })]);
    expect(map.x.maxTurns).toBe(42);
    expect("max_turns" in map.x).toBe(false);
  });

  test("snake_case 'disallowed_tools' maps to camelCase 'disallowedTools'", () => {
    const map = toSdkAgentMap([makeAgent({ name: "x", enabled: true, disallowed_tools: ["Write", "Edit"] })]);
    expect(map.x.disallowedTools).toEqual(["Write", "Edit"]);
    expect("disallowed_tools" in map.x).toBe(false);
  });

  test("snake_case 'permission_mode' maps to camelCase 'permissionMode'", () => {
    const map = toSdkAgentMap([makeAgent({ name: "x", enabled: true, permission_mode: "plan" })]);
    expect(map.x.permissionMode).toBe("plan");
  });

  test("optional fields absent when not set", () => {
    const map = toSdkAgentMap([makeAgent({ name: "x", enabled: true })]);
    // No optional fields should appear
    expect("tools" in map.x).toBe(false);
    expect("disallowedTools" in map.x).toBe(false);
    expect("model" in map.x).toBe(false);
    expect("maxTurns" in map.x).toBe(false);
    expect("background" in map.x).toBe(false);
    expect("memory" in map.x).toBe(false);
    expect("effort" in map.x).toBe(false);
    expect("permissionMode" in map.x).toBe(false);
  });

  test("tools array is preserved when set", () => {
    const map = toSdkAgentMap([makeAgent({ name: "x", enabled: true, tools: ["Read", "Write"] })]);
    expect(map.x.tools).toEqual(["Read", "Write"]);
  });

  test("model string is included when set", () => {
    const map = toSdkAgentMap([makeAgent({ name: "x", enabled: true, model: "claude-opus-4-5" })]);
    expect(map.x.model).toBe("claude-opus-4-5");
  });

  test("background=false is included (explicit falsy)", () => {
    const map = toSdkAgentMap([makeAgent({ name: "x", enabled: true, background: false })]);
    expect(map.x.background).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadAgents — layer merging
// ---------------------------------------------------------------------------

describe("loadAgents — layer merging", () => {
  test("no TOML agents → returns 4 builtins", () => {
    const agents = loadAgents([]);
    expect(agents.length).toBeGreaterThanOrEqual(4);
    // All 4 builtins must be present
    const names = agents.map(a => a.name);
    expect(names).toContain("master-controller");
    expect(names).toContain("optimizer");
    expect(names).toContain("preference-learner");
    expect(names).toContain("ideator");
  });

  test("TOML agent with same name as builtin merges and overrides fields", () => {
    const tomlOverride: AgentConfig = {
      name: "optimizer",
      description: "TOML override description",
      prompt: "Custom prompt",
      enabled: true,
      source: "toml",
    };
    const agents = loadAgents([tomlOverride]);
    const opt = agents.find(a => a.name === "optimizer");
    expect(opt!.description).toBe("TOML override description");
    expect(opt!.source).toBe("toml");
  });

  test("TOML agent merges: keeps builtin fields not overridden in TOML", () => {
    // Override only 'description'; builtin 'disallowed_tools' should be preserved
    const partial: AgentConfig = {
      name: "optimizer",
      description: "New description",
      prompt: "Custom",
      enabled: true,
      source: "toml",
    };
    const agents = loadAgents([partial]);
    const opt = agents.find(a => a.name === "optimizer");
    // Builtin optimizer has disallowed_tools = ["Write", "Edit", "Bash"]
    expect(opt?.disallowed_tools).toContain("Write");
  });

  test("new TOML agent not in builtins is added", () => {
    const newAgent: AgentConfig = {
      name: "custom-analyst",
      description: "Analyses things",
      prompt: "You analyse.",
      enabled: true,
      source: "toml",
    };
    const agents = loadAgents([newAgent]);
    expect(agents.some(a => a.name === "custom-analyst")).toBe(true);
  });

  test("project-level agent overrides TOML agent of same name", () => {
    // Set up a project .claude/agents/ dir with an agent JSON
    const projectPath = tmpDir;
    const agentsDir = join(projectPath, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "custom-analyst.json"), JSON.stringify({
      name: "custom-analyst",
      description: "Project-level override",
      prompt: "Project prompt",
      enabled: true,
    }));

    const tomlAgent: AgentConfig = {
      name: "custom-analyst",
      description: "TOML description",
      prompt: "TOML prompt",
      enabled: true,
      source: "toml",
    };
    const agents = loadAgents([tomlAgent], [projectPath]);
    const a = agents.find(a => a.name === "custom-analyst");
    // Project source wins
    expect(a!.description).toBe("Project-level override");
    expect(a!.source).toBe("project");
  });

  test("loadAgents result has unique names (no duplicates)", () => {
    const agents = loadAgents([]);
    const names = agents.map(a => a.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// discoverProjectAgents
// ---------------------------------------------------------------------------

describe("discoverProjectAgents", () => {
  test("missing .claude/agents directory returns empty array", () => {
    const result = discoverProjectAgents(tmpDir);
    expect(result).toEqual([]);
  });

  test("empty .claude/agents directory returns empty array", () => {
    const agentsDir = join(tmpDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    expect(discoverProjectAgents(tmpDir)).toEqual([]);
  });

  test("non-JSON files are ignored", () => {
    const agentsDir = join(tmpDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "readme.txt"), "not json");
    writeFileSync(join(agentsDir, "notes.md"), "# Notes");
    expect(discoverProjectAgents(tmpDir)).toHaveLength(0);
  });

  test("invalid JSON file is silently skipped", () => {
    const agentsDir = join(tmpDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "broken.json"), "{ not valid json }");
    expect(discoverProjectAgents(tmpDir)).toHaveLength(0);
  });

  test("agent JSON with invalid config (bad name) is silently skipped", () => {
    const agentsDir = join(tmpDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "bad.json"), JSON.stringify({
      name: "BAD NAME!",  // fails name validation
      description: "desc",
      prompt: "prompt",
    }));
    expect(discoverProjectAgents(tmpDir)).toHaveLength(0);
  });

  test("valid agent JSON is loaded with source='project'", () => {
    const agentsDir = join(tmpDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "my-agent.json"), JSON.stringify({
      name: "my-agent",
      description: "A project agent",
      prompt: "Do things",
    }));
    const agents = discoverProjectAgents(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("my-agent");
    expect(agents[0].source).toBe("project");
  });

  test("multiple valid agent JSON files are all loaded", () => {
    const agentsDir = join(tmpDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    for (const name of ["agent-a", "agent-b", "agent-c"]) {
      writeFileSync(join(agentsDir, `${name}.json`), JSON.stringify({
        name,
        description: `Description for ${name}`,
        prompt: `Prompt for ${name}`,
      }));
    }
    const agents = discoverProjectAgents(tmpDir);
    expect(agents).toHaveLength(3);
  });

  test("agent JSON with extra unknown fields is loaded (extra fields ignored)", () => {
    const agentsDir = join(tmpDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "extra.json"), JSON.stringify({
      name: "extra-agent",
      description: "Agent with extras",
      prompt: "Prompt",
      unknown_field: "should be ignored",
      another_unknown: 42,
    }));
    const agents = discoverProjectAgents(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("extra-agent");
  });

  test("agent JSON with enabled=false is loaded (disabled is valid)", () => {
    const agentsDir = join(tmpDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "disabled.json"), JSON.stringify({
      name: "disabled-agent",
      description: "Desc",
      prompt: "Prompt",
      enabled: false,
    }));
    const agents = discoverProjectAgents(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].enabled).toBe(false);
  });

  test("agent JSON without enabled field defaults enabled to true", () => {
    const agentsDir = join(tmpDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "no-enabled.json"), JSON.stringify({
      name: "no-enabled",
      description: "Desc",
      prompt: "Prompt",
    }));
    const agents = discoverProjectAgents(tmpDir);
    expect(agents[0].enabled).toBe(true);
  });

  test("valid and invalid JSON files in same dir: only valid ones returned", () => {
    const agentsDir = join(tmpDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "valid.json"), JSON.stringify({
      name: "valid-agent",
      description: "Desc",
      prompt: "Prompt",
    }));
    writeFileSync(join(agentsDir, "invalid.json"), "{ bad json");
    const agents = discoverProjectAgents(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("valid-agent");
  });
});

// ---------------------------------------------------------------------------
// parseTomlAgents — TOML helper parsing
// ---------------------------------------------------------------------------

describe("parseTomlAgents", () => {
  // Trivial implementations of the helpers that config.ts passes in
  const asString = (val: unknown, _path: string, fallback: string): string =>
    typeof val === "string" ? val : fallback;

  const asNumber = (val: unknown, _path: string, fallback: number): number =>
    typeof val === "number" ? val : fallback;

  const asBool = (val: unknown, _path: string, fallback: boolean): boolean =>
    typeof val === "boolean" ? val : fallback;

  const asEnum = <T extends string>(val: unknown, valid: T[], _path: string, fallback: T): T =>
    valid.includes(val as T) ? (val as T) : fallback;

  const asStringArray = (val: unknown, _path: string, fallback: string[]): string[] =>
    Array.isArray(val) ? val.map(String) : fallback;

  test("empty array returns empty array", () => {
    expect(parseTomlAgents([], asString, asNumber, asBool, asEnum, asStringArray)).toEqual([]);
  });

  test("entry without name is skipped", () => {
    const raw = [{ description: "desc", prompt: "p" }];
    const result = parseTomlAgents(raw, asString, asNumber, asBool, asEnum, asStringArray);
    expect(result).toHaveLength(0);
  });

  test("minimal valid entry produces an agent with source='toml'", () => {
    const raw = [{ name: "my-toml-agent", description: "desc", prompt: "p" }];
    const result = parseTomlAgents(raw, asString, asNumber, asBool, asEnum, asStringArray);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-toml-agent");
    expect(result[0].source).toBe("toml");
  });

  test("enabled defaults to true when not specified", () => {
    const raw = [{ name: "agt", description: "d", prompt: "p" }];
    const result = parseTomlAgents(raw, asString, asNumber, asBool, asEnum, asStringArray);
    expect(result[0].enabled).toBe(true);
  });

  test("enabled=false is respected", () => {
    const raw = [{ name: "agt", description: "d", prompt: "p", enabled: false }];
    const result = parseTomlAgents(raw, asString, asNumber, asBool, asEnum, asStringArray);
    expect(result[0].enabled).toBe(false);
  });

  test("optional fields: tools, disallowed_tools, model, max_turns, background, memory, effort", () => {
    const raw = [{
      name: "full-agent",
      description: "d",
      prompt: "p",
      tools: ["Read", "Write"],
      disallowed_tools: ["Bash"],
      model: "claude-haiku",
      max_turns: 25,
      background: true,
      memory: "project",
      effort: "high",
    }];
    const result = parseTomlAgents(raw, asString, asNumber, asBool, asEnum, asStringArray);
    const a = result[0];
    expect(a.tools).toEqual(["Read", "Write"]);
    expect(a.disallowed_tools).toEqual(["Bash"]);
    expect(a.model).toBe("claude-haiku");
    expect(a.max_turns).toBe(25);
    expect(a.background).toBe(true);
    expect(a.memory).toBe("project");
    expect(a.effort).toBe("high");
  });

  test("optional fields absent when not in raw object (undefined, not null)", () => {
    const raw = [{ name: "min", description: "d", prompt: "p" }];
    const result = parseTomlAgents(raw, asString, asNumber, asBool, asEnum, asStringArray);
    expect(result[0].tools).toBeUndefined();
    expect(result[0].model).toBeUndefined();
    expect(result[0].max_turns).toBeUndefined();
    expect(result[0].background).toBeUndefined();
    expect(result[0].memory).toBeUndefined();
    expect(result[0].effort).toBeUndefined();
  });

  test("invalid effort value falls back to 'high' (asEnum default)", () => {
    const raw = [{ name: "agt", description: "d", prompt: "p", effort: "ultra" }];
    const result = parseTomlAgents(raw, asString, asNumber, asBool, asEnum, asStringArray);
    expect(result[0].effort).toBe("high");
  });

  test("invalid memory value falls back to 'user' (asEnum default)", () => {
    const raw = [{ name: "agt", description: "d", prompt: "p", memory: "global" }];
    const result = parseTomlAgents(raw, asString, asNumber, asBool, asEnum, asStringArray);
    expect(result[0].memory).toBe("user");
  });

  test("multiple entries parsed correctly", () => {
    const raw = [
      { name: "agent-one", description: "d1", prompt: "p1" },
      { name: "agent-two", description: "d2", prompt: "p2", enabled: false },
    ];
    const result = parseTomlAgents(raw, asString, asNumber, asBool, asEnum, asStringArray);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("agent-one");
    expect(result[1].name).toBe("agent-two");
    expect(result[1].enabled).toBe(false);
  });
});
