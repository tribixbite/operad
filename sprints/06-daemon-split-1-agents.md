# Sprint 6: Daemon Split 1/5 — Agent & Cognitive Engine

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the agent/cognitive system from `src/daemon.ts` (~1,800 lines) into `src/agent-engine.ts`, using a new `OrchestratorContext` interface to pass shared dependencies. `daemon.ts` shrinks by ~1,800 lines; behavior is unchanged.

**Architecture:** First define `OrchestratorContext` in `src/orchestrator-context.ts` (types only, no logic). Then extract all agent/cognitive methods from `Orchestrator` into an `AgentEngine` class that accepts context. Finally wire `AgentEngine` back into `Orchestrator` via delegation. Each step typechecks before proceeding.

**Tech Stack:** TypeScript strict mode. Build: `bun run build` (routes to `node build.cjs`). Typecheck: `bun run typecheck`. Tests: `bun test`.

**Spec:** `docs/superpowers/specs/2026-04-17-operad-sprint-design.md` § Sprints 6-10 (this is Sprint 6)

---

## Project Context

`src/daemon.ts` is 6,644 lines with a single `Orchestrator` class. Shared fields used across subsystems:
- `this.config` — DaemonConfig
- `this.state` — StateManager (from `src/state.ts`)
- `this.memoryDb` — MemoryDb | null (from `src/memory-db.ts`)
- `this.switchboard` — Switchboard
- `this.sdkBridge` — SdkBridge | null (from `src/sdk-bridge.ts`)
- `this.log` — Logger
- `this.agentConfigs` — AgentConfig[]
- `this.broadcastSwitchboard()` — method to broadcast WS events

Agent/cognitive methods to extract (identify by reading daemon.ts):
- `maybeTriggerOoda()` (~line 3004)
- `runOodaCycle()` — called by maybeTriggerOoda
- `runAgent()` — general agent runner
- `runAgentChat()` — multi-turn chat
- `buildAgentContext()` — context assembler
- `consolidateMemory()` — memory consolidation
- `runDailySnapshots()` — daily state snapshots
- Specialization/roundtable methods
- Cognitive timer setup/teardown

---

## Task 1: Define OrchestratorContext

**Files:**
- Create: `src/orchestrator-context.ts`

- [ ] **Step 1: Read daemon.ts to identify all shared fields**

```bash
grep -n "this\.\(config\|state\|memoryDb\|switchboard\|sdkBridge\|log\|agentConfigs\|broadcastSwitchboard\)" src/daemon.ts | head -50
```

Review the output to confirm the full set of shared dependencies.

- [ ] **Step 2: Create `src/orchestrator-context.ts`**

```typescript
import type { DaemonConfig } from "./config.js";
import type { StateManager } from "./state.js";
import type { MemoryDb } from "./memory-db.js";
import type { Switchboard, AgentConfig } from "./types.js";
import type { SdkBridge } from "./sdk-bridge.js";
import type { Logger } from "./log.js";

/**
 * Shared dependency container passed to extracted subsystem engines.
 * All fields are references — mutations are visible across the system.
 * This is intentionally a data bag, not a service locator — keep it flat.
 */
export interface OrchestratorContext {
  config: DaemonConfig;
  state: StateManager;
  memoryDb: MemoryDb | null;
  switchboard: Switchboard;
  sdkBridge: SdkBridge | null;
  log: Logger;
  agentConfigs: AgentConfig[];
  /** Broadcast a typed event to all connected WebSocket clients */
  broadcast: (type: string, payload: Record<string, unknown>) => void;
  /** Update switchboard state and persist */
  updateSwitchboard: (patch: Partial<Switchboard>) => Switchboard;
}
```

- [ ] **Step 3: Typecheck**

```bash
cd ~/git/operad && bun run typecheck
```
Expected: no errors (new file, no consumers yet).

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator-context.ts
git commit -m "refactor(daemon): define OrchestratorContext interface for subsystem extraction

Types-only interface that bundles shared Orchestrator dependencies.
No logic — just the contract that extracted engines will receive.

— claude-sonnet-4-6"
```

---

## Task 2: Create AgentEngine shell

**Files:**
- Create: `src/agent-engine.ts`

- [ ] **Step 1: Read agent/cognitive methods in daemon.ts**

Read `src/daemon.ts` lines 2685-3600 (the agent and cognitive section, marked with `// -- Agent & cognitive methods`). Identify all methods belonging to the agent system.

- [ ] **Step 2: Create `src/agent-engine.ts` with method stubs**

Start with a class shell that imports OrchestratorContext and stubs all identified methods. Do NOT copy implementation yet — just the signatures. This lets typecheck verify the interface before the big move.

```typescript
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { AgentConfig } from "./types.js";

export class AgentEngine {
  constructor(private ctx: OrchestratorContext) {}

  /** Called every 60s by cognitiveTimer */
  async maybeTriggerOoda(): Promise<void> {
    // TODO: move implementation from daemon.ts
  }

  async runAgent(agentName: string, prompt: string, sessionName?: string): Promise<{ costUsd: number; output: string }> {
    // TODO: move implementation from daemon.ts
    throw new Error("not yet implemented");
  }

  // Add stubs for all other agent methods identified in Step 1
  // Common pattern: async methodName(...args): Promise<ReturnType> { throw new Error("not yet implemented"); }
}
```

- [ ] **Step 3: Typecheck**

```bash
cd ~/git/operad && bun run typecheck
```
Expected: no errors.

---

## Task 3: Move implementations into AgentEngine

**Files:**
- Modify: `src/daemon.ts`, `src/agent-engine.ts`

- [ ] **Step 1: Move `buildAgentContext()` first (it has no deps on other agent methods)**

Cut the method body from `Orchestrator` in daemon.ts, paste into `AgentEngine`. Update the method to use `this.ctx.*` instead of `this.*`. Keep a delegating stub in `Orchestrator`:

```typescript
// In Orchestrator (daemon.ts):
private async buildAgentContext(...args) {
  return this.agentEngine.buildAgentContext(...args);
}
```

Typecheck after each method move.

- [ ] **Step 2: Move remaining agent methods one at a time**

Order: `runAgent()` → `runAgentChat()` → `consolidateMemory()` → `runDailySnapshots()` → specialization/roundtable methods → `maybeTriggerOoda()` → `runOodaCycle()`.

For each:
1. Cut from daemon.ts
2. Paste into AgentEngine, update `this.*` → `this.ctx.*`
3. Add delegating stub in Orchestrator
4. Run `bun run typecheck` — fix any type errors before moving to the next method

- [ ] **Step 3: Add AgentEngine instance to Orchestrator**

```typescript
// In Orchestrator class (daemon.ts):
private agentEngine: AgentEngine;

// In constructor, after context fields are initialized:
this.agentEngine = new AgentEngine({
  config: this.config,
  state: this.state,
  memoryDb: this.memoryDb,
  switchboard: this.switchboard,
  sdkBridge: this.sdkBridge,
  log: this.log,
  agentConfigs: this.agentConfigs,
  broadcast: (type, payload) => this.broadcastSwitchboard(type, payload),
  updateSwitchboard: (patch) => this.updateSwitchboard(patch),
});
```

- [ ] **Step 4: Typecheck + tests + build**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build
```
Expected: all clean. Line count of daemon.ts should drop by ~1,800.

```bash
wc -l src/daemon.ts src/agent-engine.ts
```

- [ ] **Step 5: Smoke test**

```bash
node dist/tmx.js --version
```

- [ ] **Step 6: Commit**

```bash
git add src/daemon.ts src/agent-engine.ts src/orchestrator-context.ts
git commit -m "refactor(daemon): extract agent/cognitive system into AgentEngine

Moves ~1,800 lines of agent/OODA/consolidation/specialization/roundtable
code from Orchestrator into AgentEngine class (src/agent-engine.ts).
Orchestrator delegates via thin stubs. OrchestratorContext passes shared deps.

— claude-sonnet-4-6"
```

---

## Task 4: Remove delegating stubs from Orchestrator

Once AgentEngine is working, the delegating stubs in daemon.ts can be replaced with direct calls to `this.agentEngine.*` at the call sites.

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Find all `this.agentEngine.` delegation calls in daemon.ts**

```bash
grep -n "this\.agentEngine\." src/daemon.ts
```

- [ ] **Step 2: At each call site, call `this.agentEngine.method()` directly**

The delegating stubs were temporary scaffolding. Remove them and replace with direct `this.agentEngine.*` calls at each consumer site.

- [ ] **Step 3: Typecheck + tests + build**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build && node dist/tmx.js --version
```

- [ ] **Step 4: Final line count check**

```bash
wc -l src/daemon.ts
```
Expected: approximately 4,800 lines (down ~1,800 from 6,644).

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts
git commit -m "refactor(daemon): replace delegation stubs with direct AgentEngine calls

daemon.ts now ~4,800 lines. Agent/cognitive system fully encapsulated in
src/agent-engine.ts with clean OrchestratorContext interface.

— claude-sonnet-4-6"
```
