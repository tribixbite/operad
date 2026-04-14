# Phase 9: Agentic Tool Use, State Portability, Scheduling & Autonomy

## Context

Phase 8 completed the cognitive feedback loops: agent chat, learning/personality systems, inter-agent messaging, growth tracking, streaming, markdown rendering, and thinking blocks. Agents can now think, reflect, learn, and evolve -- but they **cannot act**. They have no file I/O, no shell access, no API calls, no tool use. Phase 9 gives agents hands.

**Design sources**: Opus deep architecture review + Gemini 3 Pro creative brainstorm + codebase analysis.

---

## Phase 9A: Tool Registry & Built-in Tools

### 9A.1 Tool Type System
**File**: `src/tools.ts` (NEW)

```typescript
type ToolCategory =
  | "observe"      // read-only: file listing, git status, system info
  | "analyze"      // compute: search, diff, token counting
  | "mutate"       // write: file edit, git commit, memory manipulation
  | "communicate"  // external: HTTP request, notification
  | "orchestrate"; // meta: session start/stop, agent spawn

interface ToolDef {
  name: string;                    // kebab-case identifier
  description: string;             // for agent prompt injection
  category: ToolCategory;
  params: ToolParam[];             // JSON Schema subset for validation
  timeout_ms: number;              // default 30_000
  parallelizable: boolean;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

interface ToolContext {
  agentName: string;
  cwd: string;
  autonomyLevel: AutonomyLevel;
  db: MemoryDb;
  log: Logger;
  signal: AbortSignal;
}

interface ToolResult {
  success: boolean;
  data: unknown;
  summary: string;                 // max 2000 chars for agent consumption
  sideEffects: string[];
  duration_ms: number;
  cost_usd?: number;
}
```

### 9A.2 Built-in Tool Set (initial, conservative)

**Observe** (always auto-approved):
- `system-status` — sessions, memory, battery, costs (same as OODA observations)
- `file-read` — read file with path validation (restricted to project dirs + `~/.claude/`)
- `file-list` — list directory with depth control
- `git-status` — git status for a session's working directory
- `git-log` — recent commits for a project
- `session-output` — last N lines from a tmux session pane
- `cost-report` — aggregate cost data for a time period

**Analyze** (always auto-approved):
- `grep-search` — search file contents across a project
- `memory-search` — FTS5 search across project memories
- `diff-files` — diff between two files or git refs

**Mutate** (requires approval by default):
- `file-write` — write/edit file (with backup + diff preview)
- `file-create` — create a new file (path validation)
- `git-commit` — stage and commit files
- `memory-create` — add a memory to a project
- `goal-update` — update goal status/outcome/score

**Communicate** (requires approval by default):
- `http-fetch` — GET/POST to URL (domain allowlist in TOML)
- `notify` — send notification via platform abstraction

**Orchestrate** (always requires approval):
- `session-start` / `session-stop` / `session-suspend`
- `session-send` — send text to a tmux pane
- `agent-spawn` — trigger another agent's run

### 9A.3 Tool Emission via Fenced Blocks
**File**: `src/cognitive.ts`

Extends `OodaAction` union:
```typescript
| { type: "tool_call"; name: string; params: Record<string, unknown>; id?: string }
| { type: "tool_sequence"; steps: Array<{ name: string; params: Record<string, unknown> }>; reason: string }
```

Agent emits:
```
\`\`\`tool
name: file-read
path: /home/user/project/src/main.ts
lines: 1-50
\`\`\`
```

Multi-step sequences support `$prev.data.fieldName` template syntax for chaining.

### 9A.4 Tool Execution Pipeline
**File**: `src/daemon.ts`, extend `executeOodaActions()`

```
Agent emits ```tool block
  → parseOodaResponse() extracts tool_call
  → ToolExecutor.execute(toolName, params, context)
    → Validate params against schema
    → Check permission: category vs agent autonomy level
      → Auto-approve if category <= autonomy
      → Request human approval via WS (reuse permission modal)
      → Deny if in agent's disallowed_tools
    → Execute with timeout + AbortController
    → Log to tool_executions audit table
    → Return ToolResult → injected into next prompt as ## Tool Results
```

### 9A.5 Tool Audit Log
**File**: `src/memory-db.ts`

```sql
CREATE TABLE IF NOT EXISTS tool_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_category TEXT NOT NULL,
  params_json TEXT NOT NULL,
  result_success INTEGER NOT NULL,
  result_summary TEXT,
  side_effects TEXT,           -- JSON array
  duration_ms INTEGER,
  cost_usd REAL DEFAULT 0,
  approval TEXT NOT NULL DEFAULT 'auto',  -- auto|human_approved|human_denied|denied_by_policy
  error TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tool_agent ON tool_executions(agent_name, created_at);
```

Append-only — no UPDATE/DELETE in MemoryDb API. Full forensic trail.

### 9A.6 OODA Prompt: Available Tools Section
**File**: `src/cognitive.ts`, `buildOodaPrompt()`

Add section listing available tools per agent's permission scope:
```
## Available Tools
You can execute tools using ```tool blocks. Available to you:
- file-read [observe]: Read a file (params: path, lines?)
- grep-search [analyze]: Search file contents (params: pattern, path, limit?)
- file-write [mutate, requires approval]: Write file (params: path, content)
...
```

### 9A.7 Per-Agent Tool Scoping
**File**: `src/agents.ts`, extend `AgentConfig`

```typescript
interface AgentConfig {
  // ... existing ...
  tool_category_overrides?: Record<string, ToolCategory>;
  autonomy_level?: AutonomyLevel;
  max_tool_calls_per_run?: number;
  allowed_paths?: string[];  // glob patterns
}
```

Default tool access:
- **master-controller**: All tools, `supervised`
- **optimizer**: observe + analyze only
- **preference-learner**: observe + analyze + memory-search
- **ideator**: observe + analyze + file-read + grep-search

---

## Phase 9B: Autonomy & Budget Guardrails

### 9B.1 Autonomy Levels
**File**: `src/types.ts`

```typescript
type AutonomyLevel =
  | "observe"     // read-only tools auto-approved
  | "suggest"     // read + propose changes (diffs shown, not applied)
  | "supervised"  // all tools available, mutate+ requires approval
  | "trusted"     // observe/analyze/mutate auto-approved; communicate/orchestrate need approval
  | "autonomous"; // everything auto-approved; human notified post-hoc
```

### 9B.2 Dynamic Trust Calibration (Gemini idea)
**File**: `src/memory-db.ts`

```sql
CREATE TABLE IF NOT EXISTS agent_trust_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  score_delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  context_goal_id INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);
-- Current trust = SUM(score_delta) bounded 0-1000
```

Algorithm:
- Successful task completion (verified by MC or human): **+10**
- Tool execution failure/exception: **-15**
- Human override/intervention: **-50**
- Schedule auto-disabled (3 failures): **-30**

Trust score → autonomy recommendation:
- `< 300`: strict HITL (every tool needs approval)
- `300-700`: supervised (safe tools auto, writes need approval)
- `> 700`: trusted (most auto-approved)

Adjustments are **recommendations** shown in dashboard — user approves or dismisses.

### 9B.3 Budget Guardrails
**File**: `src/types.ts`, `src/daemon.ts`

```typescript
interface AgentBudgetGuardrails {
  max_cost_per_run: number;       // existing max_budget_usd
  max_cost_per_day: number;       // 24h rolling window
  max_cost_per_week: number;      // 7-day rolling window
  max_tool_calls_per_run: number;
  max_tool_calls_per_day: number;
  max_scheduled_runs_per_day: number;
}
```

When any cap is hit → agent auto-disabled in switchboard, notification fires, schedules paused.

### 9B.4 Protected Checkpoints
**File**: `src/config.ts`

```toml
[agent.checkpoints]
protected_files = ["*.toml", "*.env", "package.json", "Dockerfile"]
protected_git = ["push", "merge", "rebase"]
cost_threshold_usd = 1.00
protected_tools = ["session-stop", "session-send", "http-fetch"]
```

These always require human approval regardless of autonomy level.

### 9B.5 Contextual Tool Leases (Gemini idea)
**File**: `src/memory-db.ts`

```sql
CREATE TABLE IF NOT EXISTS tool_leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  goal_id INTEGER,
  max_executions INTEGER,
  executions_used INTEGER DEFAULT 0,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',  -- active|revoked|exhausted|expired
  created_at INTEGER DEFAULT (unixepoch())
);
```

When agent takes a Goal, master-controller grants specific tool leases. Lease expires when goal completes or max_executions reached. Limits blast radius of prompt injection.

---

## Phase 9C: Persistent Scheduling

### 9C.1 Schedule Table
**File**: `src/memory-db.ts`

```sql
CREATE TABLE IF NOT EXISTS agent_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  schedule_name TEXT NOT NULL,
  cron_expr TEXT,                    -- standard 5-field cron
  interval_minutes INTEGER,          -- simple interval (mutually exclusive with cron)
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_budget_usd REAL,
  last_run_at INTEGER,
  next_run_at INTEGER,               -- precomputed for efficient polling
  total_cost_usd REAL DEFAULT 0,
  run_count INTEGER DEFAULT 0,
  consecutive_failures INTEGER DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'agent',
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(agent_name, schedule_name)
);
CREATE INDEX IF NOT EXISTS idx_schedule_next ON agent_schedules(enabled, next_run_at);
```

### 9C.2 Schedule Engine
**File**: `src/schedule.ts` (NEW)

Replaces in-memory `scheduledOodaTimer`. Polls every 30s, fires due schedules, tracks failures, auto-disables after 3 consecutive failures. Survives daemon restarts.

### 9C.3 Agent Schedule Emission

Extended `schedule` block format:
```
\`\`\`schedule
name: daily-cost-review
cron: 0 9 * * *
prompt: Review yesterday's cost data. Flag sessions over $2.
max_budget_usd: 0.50
\`\`\`
```

Backwards compatible: existing `delayMinutes`-only blocks become one-shot schedules.

### 9C.4 Event-Driven Triggers (Gemini "wake word" idea)
**File**: `src/triggers.ts` (NEW), `src/memory-db.ts`

```sql
CREATE TABLE IF NOT EXISTS agent_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- cost_threshold|memory_pressure|session_change|file_change
  condition_json TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_budget_usd REAL,
  cooldown_s INTEGER DEFAULT 300,
  last_fired_at INTEGER,
  fire_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(agent_name, trigger_name)
);
```

Examples:
- `cost_threshold`: "When daily cost exceeds $5, run optimizer"
- `memory_pressure`: "When pressure hits critical, run MC with suspension prompt"
- `session_change`: "When a session enters failed state, analyze the error"

Evaluated in the daemon's existing tick loop — lightweight condition checks, no polling overhead.

---

## Phase 9D: Agent State Portability

### 9D.1 Agent State Bundle Format
**File**: `src/agent-state.ts` (NEW)

```typescript
interface AgentStateBundle {
  format_version: 1;
  meta: {
    exported_at: string;
    exported_from: string;
    operad_version: string;
    agent_name: string;
    checksum: string;  // SHA-256 of content (excluding this field)
  };
  config: AgentConfig;                    // the "DNA"
  personality: PersonalityTraitRow[];     // full versioned history
  learnings: LearningRow[];              // with confidence + reinforcement
  strategies: StrategyRow[];             // all versions
  decisions: DecisionRow[];              // with outcomes and scores
  goals: GoalRow[];                      // full tree
  conversations?: ConversationRow[];     // optional (can be large)
  run_stats: RunStatsAggregate;          // aggregated, not per-run
  messages?: MessageRow[];               // last 100 inter-agent messages
  schedules?: ScheduleRow[];            // persistent scheduled jobs
  trust_score?: number;                  // current trust score
}
```

Single `.operad-agent` file — gzipped JSON, self-contained, no external refs or DB IDs.

### 9D.2 Export/Import API
**File**: `src/daemon.ts`

```
GET  /api/agents/:name/export             → full bundle (gzipped JSON)
GET  /api/agents/:name/export?template=1  → template mode: no conversations/messages/decisions
POST /api/agents/:name/import             → upload bundle, merge or replace
POST /api/agents/import                   → import new agent from bundle
```

CLI:
```sh
operad agent export master-controller > mc.operad-agent
operad agent import < mc.operad-agent
operad agent import --merge < mc.operad-agent
```

### 9D.3 Import Merge Strategy

```typescript
interface ImportOptions {
  mode: "replace" | "merge";
  sections?: ("config" | "personality" | "learnings" | "strategies" | ...)[];
  learningMerge: "keep_higher_confidence" | "average" | "prefer_import";
  personalityMerge: "prefer_import" | "prefer_existing" | "average";
}
```

Learnings: dedup via `content_hash`. Duplicate → keep higher confidence, sum reinforcement counts.
Personality: merge strategy determines which value wins for same trait.
Strategies: all versions concatenated, import's active replaces only in `replace` mode.

### 9D.4 Automatic Snapshots

Daily snapshots in `~/.local/share/operad/snapshots/{agent-name}/{date}.operad-agent.gz`.
Retention: 7 daily, 4 weekly, 3 monthly (configurable in TOML).
Triggered during consolidation timer. Each snapshot is a full bundle (minus conversations for size).

---

## Phase 9E: Memory Consolidation & Reflection

### 9E.1 REM Sleep Consolidation (Gemini idea)
**File**: `src/consolidation.ts` (NEW)

Triggers during idle periods (no user activity 30+ min, battery > 30%, on charger):

1. Fetch all learnings across agents
2. Detect contradictions (conflicting content) → resolve via decision outcome scores
3. Detect redundancies (semantically similar) → merge, boost confidence
4. Decay stale knowledge (source decisions scored poorly, unreinforced 30+ days)
5. Synthesize emergent patterns (3+ learnings in same category → higher-order `"synthesis"` insight)
6. Prune low-confidence, unreinforced learnings

```sql
CREATE TABLE IF NOT EXISTS consolidation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER DEFAULT (unixepoch()),
  completed_at INTEGER,
  learnings_reviewed INTEGER DEFAULT 0,
  learnings_merged INTEGER DEFAULT 0,
  learnings_pruned INTEGER DEFAULT 0,
  syntheses_created INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0
);
```

### 9E.2 Agent Reflection ("Dreams")

During consolidation, master-controller gets a special reflection prompt:

```
You are reviewing your accumulated knowledge and recent experiences.
This is a reflection session — no actions will be taken.

## Your Complete Knowledge Base
[all learnings, all categories, full detail]

## Your Decision History (last 30 days)
[all decisions with outcomes and scores]

## Your Personality Evolution
[trait history showing how you've changed]

## Reflective Questions
1. What patterns in successful vs failed decisions?
2. Any learnings contradicted by recent evidence?
3. What knowledge gaps do you notice?
4. How should personality traits evolve?
5. What should strategy prioritize next week?

Emit ```learning```, ```personality```, and ```strategy``` blocks.
```

Runs with `effort: "max"` and extended thinking. Output is purely self-improvement.

### 9E.3 Strategy A/B Forking (Gemini idea)

When optimizer detects a recurring goal type, it can fork strategies:
1. Create Variant A and Variant B with different approaches
2. MC routes goal instances randomly between variants
3. Decision journal scores outcomes
4. After N=10 instances with statistical significance, promote winner, deprecate loser

This is true meta-learning — the system experiments with *how* it solves problems.

---

## Phase 9F: Collaborative Patterns

### 9F.1 Roundtable Protocol

MC can invoke structured multi-agent discussion:
```
\`\`\`roundtable
topic: Should we consolidate the 3 Python sessions?
participants: optimizer, ideator, preference-learner
rounds: 2
budget_per_agent_usd: 0.25
\`\`\`
```

Daemon orchestrates:
1. Round 1: Each participant responds independently to topic + context
2. All Round 1 responses aggregated
3. Round 2: Each participant sees all Round 1 responses, refines position
4. MC receives full transcript, makes final decision

Different perspectives emerge because agents have different personalities, learnings, strategies.

### 9F.2 Agent Specialization Tracking

Track what task types each agent handles successfully:
```typescript
interface AgentSpecialization {
  strengths: Array<{ domain: string; success_rate: number; evidence_count: number }>;
  weaknesses: Array<{ domain: string; success_rate: number; evidence_count: number }>;
}
```

MC uses specialization data when delegating: "optimizer has 0.92 success rate on memory tasks → delegate memory consolidation there."

---

## Implementation Order

```
9A: Tool Registry + Built-in Tools        ← foundation, everything depends on this
  │
9B: Autonomy + Budget + Trust Calibration  ← required before agents can use tools safely
  │
9C: Persistent Scheduling + Triggers       ← agents can schedule their own work
  │
9D: Agent State Portability                ← export/import/snapshot system
  │
9E: Memory Consolidation + Reflection      ← idle-time self-improvement
  │
9F: Collaborative Patterns                 ← roundtable, specialization
```

Each phase produces a commit. 9A-9B are prerequisites. 9C-9F can be parallelized.

---

## New Files

| File | Purpose |
|------|---------|
| `src/tools.ts` | Tool registry, ToolExecutor, built-in tool implementations |
| `src/schedule.ts` | ScheduleEngine — persistent cron/interval execution |
| `src/agent-state.ts` | AgentStateBundle export/import, snapshot management |
| `src/consolidation.ts` | Memory consolidation + reflection prompt builder |
| `src/triggers.ts` | Event trigger registration and evaluation |

## Modified Files

| File | Changes |
|------|---------|
| `src/types.ts` | `AutonomyLevel`, `AgentBudgetGuardrails` |
| `src/agents.ts` | New `AgentConfig` fields: `autonomy_level`, `max_tool_calls_per_run`, `allowed_paths` |
| `src/cognitive.ts` | New `OodaAction` variants (`tool_call`, `tool_sequence`, `roundtable`), available tools prompt section |
| `src/memory-db.ts` | 5 new tables, ~20 new CRUD methods |
| `src/daemon.ts` | Wire ScheduleEngine, ToolExecutor, consolidation timer, triggers, new REST endpoints, agent export/import |
| `src/config.ts` | Parse `[agent.checkpoints]`, `[agent.budget]`, `allowed_domains` |
| `dashboard/src/components/CognitivePanel.svelte` | Tools tab (audit log), Schedules tab, agent health metrics |
| `dashboard/src/components/AgentPanel.svelte` | Autonomy selector, budget display, export/import buttons |
| `dashboard/src/lib/api.ts` | ~15 new fetch helpers |
| `dashboard/src/lib/types.ts` | Tool, schedule, trigger, trust types |

## New SQLite Tables

```sql
tool_executions      -- tool audit log (append-only)
agent_schedules      -- persistent cron/interval schedules
agent_triggers       -- event-driven reactive triggers
agent_trust_ledger   -- trust score deltas
tool_leases          -- goal-scoped tool permissions
consolidation_runs   -- consolidation history
```

---

## Key Design Decisions

1. **Tools use fenced-block emission**, not native SDK tool_use. Keeps agents model-agnostic (they output text, daemon parses). If SDK adds native agent tool calling later, it layers on without breaking.

2. **Trust is earned, not configured.** The trust ledger tracks a running score. Agents earn autonomy through demonstrated competence. User always has final say.

3. **Schedules survive daemon restarts.** SQLite + precomputed `next_run_at` = efficient polling. Auto-disable after 3 failures prevents runaway costs.

4. **Agent state bundles are self-contained JSON.** No DB IDs, no external refs. Any bundle can import on any operad instance.

5. **Tool leases scope permissions to goals.** If an agent is compromised during a specific task, blast radius is limited to leased tools for that goal.

6. **Consolidation runs during idle time.** Costs tokens but produces compounding knowledge. Budget guardrails prevent runaway.

7. **Roundtable is daemon-mediated.** Agents cannot spawn other agents directly — they request via action blocks, daemon orchestrates. This is defense-in-depth.
