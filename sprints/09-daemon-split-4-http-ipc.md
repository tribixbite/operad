# Sprint 9: Daemon Split 4/5 — HTTP & IPC Layer

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the HTTP REST routes, SSE, WebSocket handling, and IPC socket handler from `src/daemon.ts` (~1,200 lines) into `src/server.ts`. Note: `src/http.ts` already exists for the static dashboard server — `src/server.ts` will handle the API/IPC layer.

**Architecture:** Same `OrchestratorContext` pattern. `ServerEngine` class handles all WebSocket message dispatch, REST route handlers, SSE subscription management, and IPC command dispatch. Prereqs: Sprints 6-8 complete.

**Tech Stack:** TypeScript strict mode. Prereqs: Sprints 6, 7, 8 complete.

**Spec:** `docs/superpowers/specs/2026-04-17-operad-sprint-design.md` § Sprint 9

---

## Project Context

After Sprint 8, `src/daemon.ts` is ~3,500 lines. HTTP/IPC includes:
- REST route handlers (GET/POST endpoints for sessions, agents, quota, etc.)
- WebSocket message handler (`handleWsMessage`)
- SSE subscription management
- IPC socket command handler (`handleIpcCommand`)
- `broadcastSwitchboard()` method

Find methods:
```bash
grep -n "handleWsMessage\|handleIpc\|broadcast\|sseClient\|REST\|router\|app\.get\|app\.post" src/daemon.ts | head -30
```

Also read `src/http.ts` to understand what's already extracted (static serving) vs. what remains in daemon.ts (API routes).

---

## Task 1: Create ServerEngine

**Files:**
- Create: `src/server.ts` (note: may conflict with existing names — check `ls src/` first)
- Modify: `src/daemon.ts`

- [ ] **Step 1: Check for existing server.ts**

```bash
ls src/server.ts 2>/dev/null && echo "exists" || echo "does not exist"
```

If it exists, use `src/api-server.ts` instead.

- [ ] **Step 2: Read HTTP/IPC methods in daemon.ts**

Run the grep above. Read `handleWsMessage`, `handleIpcCommand`, and REST route setup code.

- [ ] **Step 3: Create `src/server.ts` (or `src/api-server.ts`) with stubs**

```typescript
import type { OrchestratorContext } from "./orchestrator-context.js";

export class ServerEngine {
  constructor(private ctx: OrchestratorContext) {}

  // Stubs for: handleWsMessage, handleIpcCommand, broadcast, setupRoutes, etc.
}
```

- [ ] **Step 4: Move implementations one at a time**

Same pattern: cut → paste → `this.*` → `this.ctx.*` → delegating stub → typecheck.

Pay special attention to `broadcastSwitchboard()` — it's referenced from many places. Extract it to ServerEngine and update all callers via the `ctx.broadcast` interface.

- [ ] **Step 5: Wire ServerEngine into Orchestrator**

Construct with full `OrchestratorContext`. Update `ctx.broadcast` to delegate to `this.serverEngine.broadcast()`.

- [ ] **Step 6: Typecheck, test, build**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build && node dist/tmx.js --version
wc -l src/daemon.ts
```
Expected: daemon.ts ~2,300 lines.

- [ ] **Step 7: Commit**

```bash
git add src/daemon.ts src/server.ts  # or api-server.ts
git commit -m "refactor(daemon): extract HTTP/IPC/WS/SSE layer into ServerEngine

Moves ~1,200 lines of REST routes, WebSocket dispatch, SSE subscriptions,
and IPC command handling from Orchestrator. daemon.ts now ~2,300 lines.

— claude-sonnet-4-6"
```
