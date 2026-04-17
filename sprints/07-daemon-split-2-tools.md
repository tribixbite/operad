# Sprint 7: Daemon Split 2/5 — Tool Dispatch Engine

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the tool registry, tool execution, and lease management subsystem from `src/daemon.ts` (~600 lines) into `src/tool-engine.ts`. Uses the `OrchestratorContext` pattern established in Sprint 6.

**Architecture:** Same pattern as Sprint 6. Define `ToolEngine` class, stub methods, move implementations one at a time with typecheck after each, wire back via `OrchestratorContext`, remove stubs.

**Tech Stack:** TypeScript strict mode. Prereq: Sprint 6 complete (`OrchestratorContext` exists in `src/orchestrator-context.ts`).

**Spec:** `docs/superpowers/specs/2026-04-17-operad-sprint-design.md` § Sprint 7

---

## Project Context

After Sprint 6, `src/daemon.ts` is ~4,800 lines. The tool dispatch system handles:
- Tool registry (registering built-in and user-defined tools)
- Tool execution with timeout and lease management
- Tool lease acquisition/release (autonomy level enforcement)
- Tool call logging/history

Find tool-related methods by:
```bash
grep -n "tool\|lease\|registry\|ToolCall\|ToolLease" src/daemon.ts | grep -i "private\|async\|function" | head -30
```

Also check `src/tools.ts` — it may already contain tool type definitions that `daemon.ts` uses.

---

## Task 1: Create ToolEngine

**Files:**
- Create: `src/tool-engine.ts`
- Modify: `src/daemon.ts`

- [ ] **Step 1: Read tool methods in daemon.ts**

```bash
grep -n "private.*[Tt]ool\|async.*[Tt]ool\|registerTool\|executeTool\|acquireLease\|releaseLease" src/daemon.ts | head -30
```

Read each identified method to understand its signature and dependencies.

- [ ] **Step 2: Create `src/tool-engine.ts` with stubs**

```typescript
import type { OrchestratorContext } from "./orchestrator-context.js";

export class ToolEngine {
  constructor(private ctx: OrchestratorContext) {}

  // Add stubs for each method identified in Step 1.
  // Example:
  // async executeTool(toolName: string, args: unknown): Promise<unknown> {
  //   throw new Error("not yet implemented");
  // }
}
```

- [ ] **Step 3: Typecheck**

```bash
cd ~/git/operad && bun run typecheck
```

- [ ] **Step 4: Move implementations one at a time**

For each tool method:
1. Cut from daemon.ts
2. Paste into ToolEngine, update `this.*` → `this.ctx.*`
3. Add delegating stub in Orchestrator pointing to `this.toolEngine.*`
4. Typecheck

- [ ] **Step 5: Wire ToolEngine into Orchestrator**

In `Orchestrator` constructor:
```typescript
this.toolEngine = new ToolEngine({
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

- [ ] **Step 6: Replace stubs with direct calls, typecheck, test, build**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build && node dist/tmx.js --version
wc -l src/daemon.ts
```
Expected: daemon.ts ~4,200 lines.

- [ ] **Step 7: Commit**

```bash
git add src/daemon.ts src/tool-engine.ts
git commit -m "refactor(daemon): extract tool dispatch/registry/lease system into ToolEngine

Moves ~600 lines of tool registration, execution, and lease management
from Orchestrator into ToolEngine. daemon.ts now ~4,200 lines.

— claude-sonnet-4-6"
```
