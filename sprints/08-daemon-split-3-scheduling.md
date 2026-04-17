# Sprint 8: Daemon Split 3/5 — Scheduling & State Persistence

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract scheduling engine and state persistence methods from `src/daemon.ts` (~700 lines) into `src/persistence.ts`. Uses `OrchestratorContext` from Sprint 6.

**Architecture:** Same pattern as Sprints 6-7. `PersistenceEngine` class receives `OrchestratorContext`, encapsulates schedule tick, daily snapshot, state save/load/migration helpers.

**Tech Stack:** TypeScript strict mode. Prereqs: Sprints 6 and 7 complete.

**Spec:** `docs/superpowers/specs/2026-04-17-operad-sprint-design.md` § Sprint 8

---

## Project Context

After Sprint 7, `src/daemon.ts` is ~4,200 lines. Scheduling and persistence includes:
- Schedule tick (check due schedules, fire them)
- Daily snapshot creation and retention management
- State save/load helpers beyond what `StateManager` already handles
- Any migration helpers called from daemon

Find methods:
```bash
grep -n "schedule\|snapshot\|persist\|saveState\|loadState\|migration" src/daemon.ts | grep -i "private\|async" | head -30
```

Also check `src/schedule.ts` — scheduling types/logic may already be partially extracted there.

---

## Task 1: Create PersistenceEngine

**Files:**
- Create: `src/persistence.ts`
- Modify: `src/daemon.ts`

- [ ] **Step 1: Read schedule/persistence methods in daemon.ts**

Run the grep above. Read each identified method (~lines identified) to understand signatures.

- [ ] **Step 2: Create `src/persistence.ts` with stubs**

```typescript
import type { OrchestratorContext } from "./orchestrator-context.js";

export class PersistenceEngine {
  constructor(private ctx: OrchestratorContext) {}

  // Stub each identified method
}
```

- [ ] **Step 3: Move implementations one at a time**

Same pattern: cut → paste → update `this.*` → `this.ctx.*` → delegating stub in daemon.ts → typecheck.

- [ ] **Step 4: Wire PersistenceEngine into Orchestrator**

Add `private persistenceEngine: PersistenceEngine` to `Orchestrator`. Construct in constructor with full `OrchestratorContext`.

- [ ] **Step 5: Replace stubs, typecheck, test, build**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build && node dist/tmx.js --version
wc -l src/daemon.ts
```
Expected: daemon.ts ~3,500 lines.

- [ ] **Step 6: Commit**

```bash
git add src/daemon.ts src/persistence.ts
git commit -m "refactor(daemon): extract scheduling and state persistence into PersistenceEngine

Moves ~700 lines of schedule tick, daily snapshots, and state persistence
helpers from Orchestrator. daemon.ts now ~3,500 lines.

— claude-sonnet-4-6"
```
