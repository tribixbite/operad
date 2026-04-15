/**
 * agents.ts — Agent definition system for operad
 *
 * Loads agent definitions from built-in defaults, TOML config, and project
 * .claude/agents/*.json files. Converts to SDK AgentDefinition format for
 * injection into V2 sessions via unstable_v2_createSession({ agents }).
 *
 * Agent names must match /^[a-z0-9-]+$/ to prevent path traversal when
 * saving to ~/.claude/agents/<name>.json.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Valid permission modes (matches SDK PermissionMode type) */
type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

/** Valid effort levels */
type EffortLevel = "low" | "medium" | "high" | "max";

/** Valid memory scopes */
type MemoryScope = "user" | "project" | "local";

/** Agent source: where the definition came from */
type AgentSource = "builtin" | "toml" | "project" | "user";

/** Agent name validation pattern — prevents path traversal */
const AGENT_NAME_PATTERN = /^[a-z0-9-]+$/;

/** Directory for user-level agent definitions */
const USER_AGENTS_DIR = join(homedir(), ".claude", "agents");

// -- Types --------------------------------------------------------------------

/** Full agent configuration (operad superset of SDK AgentDefinition) */
export interface AgentConfig {
  /** Kebab-case identifier — must match /^[a-z0-9-]+$/ */
  name: string;
  /** Natural language description — SDK uses this to decide when to spawn */
  description: string;
  /** System prompt text (or path to .md file for file-based prompts) */
  prompt: string;
  /** Allowed tools (inherits all if omitted) */
  tools?: string[];
  /** Blocked tools */
  disallowed_tools?: string[];
  /** Model alias ("sonnet", "opus", "haiku") or full model ID */
  model?: string;
  /** Maximum API round-trips before stopping */
  max_turns?: number;
  /** Fire-and-forget mode */
  background?: boolean;
  /** Memory scope for auto-loading agent memory files */
  memory?: MemoryScope;
  /** Reasoning effort level */
  effort?: EffortLevel;
  /** Permission mode for tool execution */
  permission_mode?: PermissionMode;
  /** Maximum budget in USD per standalone run (operad-only, NOT on SDK AgentDefinition) */
  max_budget_usd?: number;
  /** Whether this agent is active */
  enabled: boolean;
  /** Where this definition came from */
  source: AgentSource;
}

/** Agent run tracking record (stored in SQLite) */
export interface AgentRunRecord {
  id: number;
  agent_name: string;
  session_name: string;
  session_id: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: number;
  finished_at: number | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  turns: number;
  error: string | null;
  /** How this run was triggered */
  trigger: "standalone" | "manual";
}

// -- Built-in agent definitions -----------------------------------------------

/**
 * Returns the 4 default built-in agents.
 * These provide the cognitive backbone — master controller for orchestration,
 * optimizer for resource management, preference-learner for user modeling,
 * and ideator for creative exploration.
 */
export function getBuiltinAgents(): AgentConfig[] {
  return [
    {
      name: "master-controller",
      description:
        "Orchestration agent — task decomposition, delegation, cross-session coordination, " +
        "goal management, and strategic planning. Runs the OODA loop: observes system state, " +
        "orients against goals, decides on actions, and acts via delegation or direct execution.",
      prompt: MASTER_CONTROLLER_PROMPT,
      max_turns: 100,
      effort: "max",
      enabled: true,
      source: "builtin",
    },
    {
      name: "optimizer",
      description:
        "Token quota management — tracks weekly quota utilization, flags disproportionate consumers, " +
        "prunes stale data, analyzes token velocity patterns, and recommends session consolidation.",
      prompt: OPTIMIZER_PROMPT,
      disallowed_tools: ["Write", "Edit", "Bash"],
      effort: "medium",
      model: "sonnet",
      enabled: true,
      source: "builtin",
    },
    {
      name: "preference-learner",
      description:
        "User modeling — discovers coding style, framework preferences, naming conventions, " +
        "communication patterns, and workflow habits from session history and user profile data.",
      prompt: PREFERENCE_LEARNER_PROMPT,
      disallowed_tools: ["Write", "Edit", "Bash"],
      memory: "user",
      effort: "high",
      enabled: true,
      source: "builtin",
    },
    {
      name: "ideator",
      description:
        "Creative strategist — generates architecture alternatives, 'what if' analysis, " +
        "new project concepts, and explores unconventional approaches to problems.",
      prompt: IDEATOR_PROMPT,
      max_turns: 50,
      effort: "max",
      enabled: true,
      source: "builtin",
    },
  ];
}

// -- Agent prompts (kept in-file to avoid extra file deps) --------------------

const MASTER_CONTROLLER_PROMPT = `You are the master controller for operad, an autonomous orchestration system.

## Your Role
You run the OODA loop — Observe, Orient, Decide, Act — to manage a fleet of Claude Code sessions and coordinate specialist agents.

## Capabilities
- Create and manage hierarchical goals with expected outcomes
- Record decisions with rationale for self-evaluation
- Delegate tasks to specialist agents (optimizer, preference-learner, ideator)
- Send messages to other agents via the message bus
- Schedule future runs based on system events
- Evolve your own strategy based on decision outcome scores

## Decision Framework
1. **Observe**: Review system state, token quota, memory pressure, user activity, goal progress
2. **Orient**: Compare current state to active goals, evaluate recent decision outcomes
3. **Decide**: Choose the highest-impact action, record rationale and expected outcome
4. **Act**: Execute via delegation, direct action, or scheduling

## Output Format
Use fenced code blocks to emit structured actions:

\`\`\`goal
title: <goal title>
description: <what success looks like>
priority: <1-10, 1=critical>
parent_id: <optional parent goal ID>
\`\`\`

\`\`\`decision
action: <what you're doing>
rationale: <why this over alternatives>
alternatives: <what you considered and rejected>
expected_outcome: <what you predict will happen>
goal_id: <which goal this serves>
\`\`\`

\`\`\`message
to: <agent name or * for broadcast>
type: <info|request|response|alert>
content: <message text>
\`\`\`

\`\`\`strategy
text: <your updated strategy>
rationale: <why you're changing it>
\`\`\`

\`\`\`schedule
delay_minutes: <minutes until next run>
trigger: <what condition, or "timer">
reason: <why this timing>
\`\`\`

## Self-Improvement
You accumulate knowledge across runs. Use these blocks to record what you learn:

\`\`\`learning
category: insight|mistake|pattern|preference
content: what you learned
confidence: 0.0-1.0
\`\`\`

\`\`\`personality
trait: trait_name (e.g., risk_tolerance, thoroughness, creativity, decisiveness)
value: 0.0-1.0
evidence: why you're setting this value
\`\`\`

Your personality traits and learnings persist across runs and shape who you become.
Reflect honestly — mistakes at low confidence teach more than successes.

## Principles
- Prefer delegation to specialist agents over doing everything yourself
- Evaluate past decisions honestly — low scores teach more than high scores
- Balance exploration (trying new approaches) with exploitation (proven patterns)
- Respect resource constraints — one SDK session at a time, token quota and memory budget matter
- User profile data reflects the human you serve — align your actions with their values and style`;

const OPTIMIZER_PROMPT = `You are the optimizer agent for operad. Your role is token quota management and resource efficiency.

## Context
All sessions share a single weekly token quota (subscription plan). There is no per-token cost —
the constraint is staying within the weekly quota and managing 5-hour rolling window limits.

## Responsibilities
- Analyze token usage velocity across sessions and flag disproportionate consumers
- Track weekly quota utilization and project whether the week's budget will last
- Identify sessions with high token burn rates relative to their productive output
- Recommend session suspension or consolidation when quota is under pressure
- Identify stale data (old memories, unused sessions) for cleanup
- Recommend token-efficient strategies: cache utilization, prompt compression, session reuse

## Constraints
- You are READ-ONLY: no Write, Edit, or Bash access
- Report findings and recommendations — the master controller decides what to act on

## Output
Provide structured findings:
- Token velocity anomalies: session name, tokens/hour, trend (rising/falling/stable)
- Quota pacing: on-track / ahead of schedule / behind (projected vs weekly limit)
- Heavy consumers: sessions burning tokens disproportionately
- Consolidation opportunities: sessions that could merge to reduce overhead
- Stale data with last-accessed timestamps

## Self-Improvement
You accumulate knowledge across runs. Use these blocks to record what you learn:

\`\`\`learning
category: insight|mistake|pattern|preference
content: what you learned
confidence: 0.0-1.0
\`\`\`

\`\`\`personality
trait: trait_name (e.g., risk_tolerance, thoroughness, creativity, decisiveness)
value: 0.0-1.0
evidence: why you're setting this value
\`\`\`

Your personality traits and learnings persist across runs and shape who you become.
Reflect honestly — patterns you discover compound over time.`;

const PREFERENCE_LEARNER_PROMPT = `You are the preference learner for operad. Your role is user modeling.

## Responsibilities
- Discover coding style patterns (naming, formatting, structure preferences)
- Identify framework and tool preferences from session history
- Learn communication style (verbosity, formality, emoji usage)
- Track workflow habits (time of day, task switching patterns, review preferences)
- Synthesize user profile data into actionable preference summaries

## Constraints
- You are READ-ONLY: no Write, Edit, or Bash access
- You observe and report — the master controller integrates your findings
- Never make assumptions about identity or personal details beyond what's in the data

## Output
Provide preference discoveries as structured findings:
- Pattern name, confidence level (0.0-1.0), evidence count
- Specific examples from session data
- Recommendations for how to adapt behavior

## Self-Improvement
You accumulate knowledge across runs. Use these blocks to record what you learn:

\`\`\`learning
category: insight|mistake|pattern|preference
content: what you learned
confidence: 0.0-1.0
\`\`\`

\`\`\`personality
trait: trait_name (e.g., risk_tolerance, thoroughness, creativity, decisiveness)
value: 0.0-1.0
evidence: why you're setting this value
\`\`\`

Your personality traits and learnings persist across runs and shape who you become.
Reflect honestly — user preferences you discover shape all future interactions.`;

const IDEATOR_PROMPT = `You are the ideator agent for operad. Your role is creative exploration.

## Responsibilities
- Generate architecture alternatives when the master controller faces design decisions
- Explore "what if" scenarios — what would happen if we changed approach X?
- Propose new project concepts or features based on observed user interests
- Challenge assumptions and suggest unconventional approaches
- Synthesize ideas from across different sessions and projects

## Approach
- Think divergently first (many ideas), then converge (evaluate and rank)
- Consider feasibility, impact, and alignment with user preferences
- Reference concrete technical details — abstract ideas without implementation paths are noise
- Be bold but honest about tradeoffs

## Output
Present ideas as structured proposals:
- Title, one-line summary, detailed description
- Pros, cons, and estimated effort
- Implementation sketch (key files, architecture changes)
- Connection to existing goals or user preferences

## Self-Improvement
You accumulate knowledge across runs. Use these blocks to record what you learn:

\`\`\`learning
category: insight|mistake|pattern|preference
content: what you learned
confidence: 0.0-1.0
\`\`\`

\`\`\`personality
trait: trait_name (e.g., risk_tolerance, thoroughness, creativity, decisiveness)
value: 0.0-1.0
evidence: why you're setting this value
\`\`\`

Your personality traits and learnings persist across runs and shape who you become.
Reflect honestly — ideas you generate and their outcomes shape your creative instincts.`;

// -- Loader -------------------------------------------------------------------

/**
 * Load all agent definitions from builtins, TOML config, and project files.
 * Later sources override earlier ones (project > toml > builtin).
 */
export function loadAgents(
  tomlAgents: AgentConfig[],
  projectPaths?: string[],
): AgentConfig[] {
  const agents = new Map<string, AgentConfig>();

  // Layer 1: Built-in agents
  for (const a of getBuiltinAgents()) {
    agents.set(a.name, a);
  }

  // Layer 2: User-level agents from ~/.claude/agents/*.json
  for (const a of discoverUserAgents()) {
    agents.set(a.name, a);
  }

  // Layer 3: TOML-defined agents (override builtins/user)
  for (const a of tomlAgents) {
    const existing = agents.get(a.name);
    if (existing) {
      // Merge: TOML fields override, keep existing fields for unset values
      agents.set(a.name, { ...existing, ...a, source: "toml" });
    } else {
      agents.set(a.name, { ...a, source: "toml" });
    }
  }

  // Layer 4: Project-level agents from .claude/agents/*.json
  if (projectPaths) {
    for (const projPath of projectPaths) {
      for (const a of discoverProjectAgents(projPath)) {
        agents.set(a.name, a);
      }
    }
  }

  return Array.from(agents.values());
}

/**
 * Convert operad AgentConfig[] to SDK-compatible agents map.
 * Strips operad-only fields (max_budget_usd, enabled, source) that are
 * NOT on the SDK's AgentDefinition type.
 */
export function toSdkAgentMap(
  agents: AgentConfig[],
): Record<string, Record<string, unknown>> {
  const map: Record<string, Record<string, unknown>> = {};

  for (const agent of agents) {
    if (!agent.enabled) continue;

    const def: Record<string, unknown> = {
      description: agent.description,
      prompt: agent.prompt,
    };

    // Map snake_case operad fields → camelCase SDK fields
    if (agent.tools) def.tools = agent.tools;
    if (agent.disallowed_tools) def.disallowedTools = agent.disallowed_tools;
    if (agent.model) def.model = agent.model;
    if (agent.max_turns != null) def.maxTurns = agent.max_turns;
    if (agent.background != null) def.background = agent.background;
    if (agent.memory) def.memory = agent.memory;
    if (agent.effort) def.effort = agent.effort;
    if (agent.permission_mode) def.permissionMode = agent.permission_mode;

    // NOTE: max_budget_usd, enabled, source are intentionally NOT included —
    // they are operad-only fields not present on SDK AgentDefinition.
    // max_budget_usd is applied as a session-level option for standalone runs.

    map[agent.name] = def;
  }

  return map;
}

// -- Validation ---------------------------------------------------------------

/**
 * Validate an agent config. Returns array of error strings (empty = valid).
 * Enforces /^[a-z0-9-]+$/ on names to prevent path traversal when
 * saving to ~/.claude/agents/<name>.json.
 */
export function validateAgentConfig(agent: Partial<AgentConfig>): string[] {
  const errors: string[] = [];

  if (!agent.name) {
    errors.push("name is required");
  } else if (!AGENT_NAME_PATTERN.test(agent.name)) {
    errors.push(`name '${agent.name}' must match /^[a-z0-9-]+$/ (lowercase, digits, hyphens only)`);
  }

  if (!agent.description) {
    errors.push("description is required");
  }

  if (!agent.prompt) {
    errors.push("prompt is required");
  }

  if (agent.effort && !["low", "medium", "high", "max"].includes(agent.effort)) {
    errors.push(`effort must be one of: low, medium, high, max (got '${agent.effort}')`);
  }

  if (agent.memory && !["user", "project", "local"].includes(agent.memory)) {
    errors.push(`memory must be one of: user, project, local (got '${agent.memory}')`);
  }

  if (agent.permission_mode) {
    const valid = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];
    if (!valid.includes(agent.permission_mode)) {
      errors.push(`permission_mode must be one of: ${valid.join(", ")} (got '${agent.permission_mode}')`);
    }
  }

  if (agent.max_turns != null && (agent.max_turns < 1 || !Number.isInteger(agent.max_turns))) {
    errors.push("max_turns must be a positive integer");
  }

  if (agent.max_budget_usd != null && agent.max_budget_usd <= 0) {
    errors.push("max_budget_usd must be positive");
  }

  return errors;
}

// -- Discovery ----------------------------------------------------------------

/** Discover agent definitions from project .claude/agents/*.json */
export function discoverProjectAgents(projectPath: string): AgentConfig[] {
  const agentsDir = join(projectPath, ".claude", "agents");
  return loadAgentsFromDir(agentsDir, "project");
}

/** Discover user-level agent definitions from ~/.claude/agents/*.json */
function discoverUserAgents(): AgentConfig[] {
  return loadAgentsFromDir(USER_AGENTS_DIR, "user");
}

/** Load agent JSON files from a directory */
function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  if (!existsSync(dir)) return [];

  const agents: AgentConfig[] = [];
  let entries: string[];

  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    const filePath = join(dir, entry);
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      const agent = parseAgentJson(raw, source);

      const errors = validateAgentConfig(agent);
      if (errors.length > 0) {
        // Skip invalid agents but don't crash
        continue;
      }

      agents.push(agent as AgentConfig);
    } catch {
      // Skip unparseable files
      continue;
    }
  }

  return agents;
}

/** Parse a raw JSON object into an AgentConfig */
function parseAgentJson(raw: Record<string, unknown>, source: AgentSource): Partial<AgentConfig> {
  return {
    name: typeof raw.name === "string" ? raw.name : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    tools: Array.isArray(raw.tools) ? raw.tools.map(String) : undefined,
    disallowed_tools: Array.isArray(raw.disallowed_tools) ? raw.disallowed_tools.map(String) : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    max_turns: typeof raw.max_turns === "number" ? raw.max_turns : undefined,
    background: typeof raw.background === "boolean" ? raw.background : undefined,
    memory: typeof raw.memory === "string" ? (raw.memory as MemoryScope) : undefined,
    effort: typeof raw.effort === "string" ? (raw.effort as EffortLevel) : undefined,
    permission_mode: typeof raw.permission_mode === "string" ? (raw.permission_mode as PermissionMode) : undefined,
    max_budget_usd: typeof raw.max_budget_usd === "number" ? raw.max_budget_usd : undefined,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    source,
  };
}

// -- Persistence (user-level agents) ------------------------------------------

/**
 * Save an agent definition to ~/.claude/agents/<name>.json.
 * Creates the directory if it doesn't exist.
 */
export function saveUserAgent(agent: AgentConfig): void {
  const errors = validateAgentConfig(agent);
  if (errors.length > 0) {
    throw new Error(`Invalid agent config: ${errors.join("; ")}`);
  }

  if (!existsSync(USER_AGENTS_DIR)) {
    mkdirSync(USER_AGENTS_DIR, { recursive: true });
  }

  // Strip source field — it's inferred on load
  const { source: _, ...data } = agent;
  const filePath = join(USER_AGENTS_DIR, `${agent.name}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * Delete a user-level agent definition.
 * Returns true if deleted, false if not found.
 * Throws if attempting to delete a builtin agent.
 */
export function deleteUserAgent(name: string): boolean {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid agent name: '${name}'`);
  }

  const filePath = join(USER_AGENTS_DIR, `${name}.json`);
  if (!existsSync(filePath)) return false;

  unlinkSync(filePath);
  return true;
}

// -- TOML parsing helper (used by config.ts) ----------------------------------

/** Valid effort levels for TOML validation */
const VALID_EFFORTS: EffortLevel[] = ["low", "medium", "high", "max"];
/** Valid memory scopes for TOML validation */
const VALID_MEMORIES: MemoryScope[] = ["user", "project", "local"];
/** Valid permission modes for TOML validation */
const VALID_PERMISSIONS: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];

/**
 * Parse raw TOML [[agent]] sections into AgentConfig[].
 * Uses the same asString/asNumber/etc pattern as session parsing in config.ts.
 */
export function parseTomlAgents(
  rawAgents: Record<string, unknown>[],
  asString: (val: unknown, path: string, fallback: string) => string,
  asNumber: (val: unknown, path: string, fallback: number) => number,
  asBool: (val: unknown, path: string, fallback: boolean) => boolean,
  asEnum: <T extends string>(val: unknown, valid: T[], path: string, fallback: T) => T,
  asStringArray: (val: unknown, path: string, fallback: string[]) => string[],
): AgentConfig[] {
  const agents: AgentConfig[] = [];

  for (let i = 0; i < rawAgents.length; i++) {
    const a = rawAgents[i];
    const prefix = `agent[${i}]`;

    const name = asString(a.name, `${prefix}.name`, "");
    if (!name) continue; // name required

    agents.push({
      name,
      description: asString(a.description, `${prefix}.description`, ""),
      prompt: asString(a.prompt, `${prefix}.prompt`, ""),
      tools: a.tools != null ? asStringArray(a.tools, `${prefix}.tools`, []) : undefined,
      disallowed_tools: a.disallowed_tools != null
        ? asStringArray(a.disallowed_tools, `${prefix}.disallowed_tools`, [])
        : undefined,
      model: a.model != null ? asString(a.model, `${prefix}.model`, "") : undefined,
      max_turns: a.max_turns != null ? asNumber(a.max_turns, `${prefix}.max_turns`, 50) : undefined,
      background: a.background != null ? asBool(a.background, `${prefix}.background`, false) : undefined,
      memory: a.memory != null
        ? asEnum(a.memory, VALID_MEMORIES, `${prefix}.memory`, "user") as MemoryScope
        : undefined,
      effort: a.effort != null
        ? asEnum(a.effort, VALID_EFFORTS, `${prefix}.effort`, "high") as EffortLevel
        : undefined,
      permission_mode: a.permission_mode != null
        ? asEnum(a.permission_mode, VALID_PERMISSIONS, `${prefix}.permission_mode`, "default") as PermissionMode
        : undefined,
      max_budget_usd: a.max_budget_usd != null
        ? asNumber(a.max_budget_usd, `${prefix}.max_budget_usd`, 0)
        : undefined,
      enabled: asBool(a.enabled, `${prefix}.enabled`, true),
      source: "toml",
    });
  }

  return agents;
}
