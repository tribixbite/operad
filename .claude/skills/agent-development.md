# Agent Development

## Triggers
- User asks to create, modify, or debug an agent definition
- User says `/agent-development`
- Working on `src/agents.ts`, `src/cognitive.ts`, or `src/daemon.ts` agent-related code

## Agent Definition Schema (AgentConfig)

```typescript
interface AgentConfig {
  name: string;             // kebab-case, /^[a-z0-9-]+$/
  description: string;      // natural language — used by master-controller to decide when to spawn
  prompt: string;           // system prompt text OR path to .md file
  tools?: string[];         // allowed tools (inherits all if omitted)
  disallowed_tools?: string[];
  model?: string;           // "sonnet" | "opus" | "haiku" or full model ID
  max_turns?: number;       // API round-trips limit
  background?: boolean;     // fire-and-forget mode
  memory?: string;          // "user" | "project" | "local"
  effort?: string;          // "low" | "medium" | "high" | "max"
  permission_mode?: string; // "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"
  max_budget_usd?: number;  // operad-only field (NOT on SDK AgentDefinition)
  enabled: boolean;
  source: "builtin" | "toml" | "project" | "user";
}
```

## Defining Agents in TOML

```toml
# ~/.config/operad/operad.toml

[[agent]]
name = "my-agent"
description = "Does something useful"
prompt = """
You are a specialized agent that...
"""
model = "sonnet"
max_turns = 20
effort = "high"
permission_mode = "acceptEdits"
enabled = true
# tools = ["Read", "Grep", "Glob"]        # optional whitelist
# disallowed_tools = ["Bash", "Write"]     # optional blacklist
# max_budget_usd = 0.50                    # optional spend cap
```

Or reference an external prompt file:
```toml
[[agent]]
name = "my-agent"
description = "Does something useful"
prompt = "~/.claude/agents/my-agent-prompt.md"
model = "haiku"
```

## Builtin Agents (4 defaults)

| Name | Role | Model | Max Turns | Effort |
|------|------|-------|-----------|--------|
| `master-controller` | Orchestration + OODA loop | (default) | 100 | max |
| `optimizer` | Token/memory efficiency analysis | sonnet | 20 | high |
| `preference-learner` | User behavior modeling | sonnet | 15 | medium |
| `ideator` | Creative exploration + brainstorming | (default) | 50 | max |

Builtins are read-only — override by creating a TOML agent with the same name.

## Agent Layer Merge Order

```
builtin < user (~/.claude/agents/) < toml (operad.toml) < project (.claude/agents/)
```

Later layers override earlier ones (matched by name).

## OODA Action Types

Agents emit actions via fenced code blocks in their response:

````markdown
```goal
title: Optimize memory usage
description: Reduce RSS across idle sessions
priority: high
```

```decision
action: suspend idle sessions over 500MB
rationale: memory pressure is high, 3 sessions are idle
alternatives: kill lowest-priority session
expectedOutcome: ~1.5GB freed
```

```message
to: optimizer
messageType: request
content: analyze token usage for craftmatic session
```

```strategy
text: prioritize memory conservation over responsiveness
rationale: battery below 20%, high memory pressure
```

```schedule
delayMinutes: 30
trigger: re-evaluate memory after suspensions take effect
reason: wait for OS to reclaim pages
```

```learning
category: pattern
content: suspending sessions during active Claude runs causes state corruption
confidence: 0.8
```

```personality
trait: risk_tolerance
value: 0.4
evidence: aggressive optimizations caused session loss twice
```
````

## Running Agents

### Via Dashboard
AgentPanel → click "Run" on any agent card → standalone one-shot execution.

### Via OODA Loop
Master-controller spawns agents as actions during cognitive cycles.

### Via Agent Chat
AgentPanel → click "Chat" → conversational multi-turn (replay-based, no persistent session).

### Via CLI / API
```bash
# REST API
curl -X POST http://localhost:18970/api/agents/my-agent/run \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "analyze current session health"}'
```

## Key Source Files

| File | Purpose |
|------|---------|
| `src/agents.ts` | AgentConfig loading, validation, TOML parsing, SDK conversion |
| `src/cognitive.ts` | OODA loop engine, prompt builder, action parser |
| `src/daemon.ts` | Agent execution (`handleStandaloneAgentRun`, `executeOodaActions`), chat handler |
| `src/memory-db.ts` | Agent learnings, personality, decisions, messages persistence |
| `src/types.ts` | Switchboard config (per-agent enable/disable) |

## Validation Rules

- Name must be kebab-case (`/^[a-z0-9-]+$/`)
- Description required (used for spawning decisions)
- Prompt required (inline text or file path)
- Model must be valid alias or full ID
- `max_budget_usd` is operad-only — stripped before SDK calls via `toSdkAgentMap()`

## SDK Bridge

`toSdkAgentMap(agents)` converts operad AgentConfig → SDK AgentDefinition:
- Strips operad-only fields (`max_budget_usd`, `enabled`, `source`)
- Converts snake_case → camelCase (`disallowed_tools` → `disallowedTools`, `max_turns` → `maxTurns`)
- Filters to enabled agents only
