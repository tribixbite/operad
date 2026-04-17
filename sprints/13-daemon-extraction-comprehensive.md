# Sprint 13: Comprehensive daemon.ts Extraction

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the daemon.ts extraction that Sprints 6-10 only scaffolded. Move the large remaining methods (`handleIpcCommand`, `handleWsMessage`, `executeOodaActions`, `handleAgentChat`, `consolidateMemory`, and the REST route handlers) into their appropriate engine classes. Target: `src/daemon.ts` ≤ 2,500 lines (from 6,523).

**Architecture:** The engine classes and `OrchestratorContext` interface already exist from Sprints 6-10. This sprint populates them with the bulk of the remaining logic. Work in small, committable batches — each batch must leave the build + tests green.

**Tech Stack:** TypeScript strict mode. Build: `bun run build` (routes to `node build.cjs`). Typecheck: `bun run typecheck`. Tests: `bun test`.

**Spec:** Finishes the work deferred from Sprints 6-10. Audit report flagged ServerEngine as "0 active call sites" and noted most REST/WS/IPC logic still lives in daemon.ts.

---

## Project Context

After Sprints 6-10, here's what's actually in place:

- `src/orchestrator-context.ts` — interface exists with `config`, `state`, `memoryDb`, `switchboard`, `sdkBridge`, `log`, `agentConfigs`, `broadcast`, `updateSwitchboard`, `getToolExecutor`, `executeOodaActions` callbacks
- `src/agent-engine.ts` — has `maybeTriggerOoda()`, `runOodaCycle()` (wired, 3 call sites)
- `src/tool-engine.ts` — has `buildToolContext()` (wired, 2 call sites)
- `src/persistence.ts` — has `maybeDailySnapshot()` (wired, 1 call site)
- `src/server-engine.ts` — has `buildSwitchboardPayload`, `buildAgentListPayload`, `isAgentEnabled` (NOT WIRED — dead code)
- `src/session-controller.ts` — SessionController exists but healthChecker is a stub

Target methods still in daemon.ts that should be extracted:

```bash
grep -n "private async handleIpcCommand\|private async handleWsMessage\|private async executeOodaActions\|private async handleAgentChat\|private async consolidateMemory\|private async runAgent\|private buildAgentContext" src/daemon.ts
```

Expected matches:
- `handleIpcCommand` — routes IPC socket commands (~500 lines)
- `handleWsMessage` — routes WebSocket client messages (~200 lines)
- `executeOodaActions` — dispatches OODA action types (run_agent, execute_tool, send_prompt, etc.) (~300 lines)
- `handleAgentChat` — multi-turn agent chat with replay (~100 lines)
- `consolidateMemory` — memory consolidation runner (~50 lines)
- `runAgent` — primary agent runner (~150 lines)
- `buildAgentContext` — agent prompt context assembler (~200 lines)

---

## Task 1: Wire ServerEngine helpers (fix dead code)

Audit found `ServerEngine` constructed but 0 call sites. Fix that first — small, safe change.

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Find inline `buildSwitchboardPayload` calls in daemon.ts**

```bash
grep -n "broadcastSwitchboard\|buildSwitchboardPayload\|agent_list" src/daemon.ts | head -20
```

Daemon likely has inline code that constructs WS payloads identical to `ServerEngine.buildSwitchboardPayload` and `ServerEngine.buildAgentListPayload`.

- [ ] **Step 2: Replace inline payload construction with ServerEngine calls**

At each site where daemon builds a switchboard or agent list payload inline, replace with:
```typescript
const payload = this.serverEngine.buildSwitchboardPayload();
// or
const payload = this.serverEngine.buildAgentListPayload();
```

- [ ] **Step 3: Consolidate `isAgentEnabled`**

If `Daemon.isAgentEnabled()` exists and duplicates `ServerEngine.isAgentEnabled()`, delete the Daemon copy and make all call sites go through `this.serverEngine.isAgentEnabled(name)`.

- [ ] **Step 4: Typecheck + test + commit**

```bash
cd ~/git/operad && bun run typecheck && bun test
git add src/daemon.ts
git commit -m "refactor(daemon): wire ServerEngine helpers — remove inline payload duplication

ServerEngine was constructed but never called. Inline switchboard/agent-list
payload construction replaced with ServerEngine method calls. isAgentEnabled
deduplicated.

— claude-sonnet-4-6"
```

---

## Task 2: Extract consolidateMemory to PersistenceEngine

Smaller extraction, good warm-up. `consolidateMemory` is called by OODA cycle and has moderate dependencies.

**Files:**
- Modify: `src/persistence.ts`, `src/daemon.ts`, `src/orchestrator-context.ts`

- [ ] **Step 1: Read `consolidateMemory` in daemon.ts**

```bash
grep -n "private async consolidateMemory\|private async maybeConsolidate" src/daemon.ts
```

Read the method bodies.

- [ ] **Step 2: Identify dependencies**

Common deps: `this.memoryDb`, `this.log`, `this.config`, `this.agentConfigs`, `this.sdkBridge`. All already on OrchestratorContext.

If `lastUserActivityEpoch` is needed, add a getter to OrchestratorContext:
```typescript
  /** Seconds since last user-driven action — for idle-based triggers */
  getIdleSeconds: () => number;
```

- [ ] **Step 3: Move method to PersistenceEngine**

Cut from daemon.ts, paste into `src/persistence.ts` as public method. Replace `this.X` with `this.ctx.X`. Remove the delegation stub — call sites invoke `this.persistenceEngine.consolidateMemory(...)` directly.

- [ ] **Step 4: Typecheck + test + commit**

```bash
cd ~/git/operad && bun run typecheck && bun test
git add src/persistence.ts src/daemon.ts src/orchestrator-context.ts
git commit -m "refactor(daemon): extract consolidateMemory into PersistenceEngine

— claude-sonnet-4-6"
```

---

## Task 3: Extract buildAgentContext + runAgent + handleAgentChat into AgentEngine

These are tightly coupled — extract together to avoid partial states.

**Files:**
- Modify: `src/agent-engine.ts`, `src/daemon.ts`, `src/orchestrator-context.ts` (possibly)

- [ ] **Step 1: Read all three methods**

```bash
grep -n "private buildAgentContext\|private async runAgent\|private async handleAgentChat" src/daemon.ts
```

Read each. List all `this.*` dependencies.

- [ ] **Step 2: Extend OrchestratorContext if needed**

If the methods reach for Daemon fields not yet in context (e.g., `this.wsClients`, `this.notificationParser`, `this.toolExecutor`), add them to OrchestratorContext as read-only accessors or callbacks:
```typescript
  getWsClients: () => Set<WebSocket>;
  getNotificationParser: () => NotificationParser;
```

Keep the additions minimal — only what these three methods need.

- [ ] **Step 3: Move all three methods to AgentEngine as public**

Cut → paste → `this.X` → `this.ctx.X` → update call sites in daemon.ts to call `this.agentEngine.methodName(...)` directly (no delegation stub).

- [ ] **Step 4: Typecheck**

```bash
cd ~/git/operad && bun run typecheck
```

Fix any type errors. Don't suppress with `any` — resolve them.

- [ ] **Step 5: Test + build + smoke test**

```bash
bun test && bun run build && node dist/tmx.js --version
```

- [ ] **Step 6: Commit**

```bash
git add src/agent-engine.ts src/daemon.ts src/orchestrator-context.ts
git commit -m "refactor(daemon): extract buildAgentContext, runAgent, handleAgentChat into AgentEngine

Three tightly-coupled methods (~450 lines) moved together. OrchestratorContext
extended with wsClients + notificationParser accessors as needed.

— claude-sonnet-4-6"
```

---

## Task 4: Extract executeOodaActions into AgentEngine

The OrchestratorContext already has `executeOodaActions: (actions) => Promise<void>` as a callback. Now invert: move the real impl into AgentEngine and remove the callback.

**Files:**
- Modify: `src/agent-engine.ts`, `src/daemon.ts`, `src/orchestrator-context.ts`

- [ ] **Step 1: Read `executeOodaActions` in daemon.ts**

```bash
grep -n "private async executeOodaActions\|executeOodaActions" src/daemon.ts | head -10
```

- [ ] **Step 2: Understand action type handlers**

The method switches on action types: `run_agent`, `execute_tool`, `send_prompt`, `update_goal`, `schedule_run`, etc. List them.

- [ ] **Step 3: Move to AgentEngine**

Cut from daemon.ts, paste into AgentEngine as public method. Replace `this.X` with `this.ctx.X`. For `this.runAgent()` and `this.executeTool()` — these should now be methods on engines. Call them directly (e.g., `this.runAgent()` within AgentEngine, or `this.ctx.getToolExecutor()?.execute(...)`).

- [ ] **Step 4: Remove `executeOodaActions` from OrchestratorContext**

`runOodaCycle` previously called `this.ctx.executeOodaActions(...)` as a callback. Now it calls `this.executeOodaActions(...)` directly (both on AgentEngine). Remove the callback from OrchestratorContext.

- [ ] **Step 5: Typecheck + test + commit**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build
git add src/agent-engine.ts src/daemon.ts src/orchestrator-context.ts
git commit -m "refactor(daemon): extract executeOodaActions into AgentEngine

Removes executeOodaActions callback from OrchestratorContext — AgentEngine
owns the action dispatcher directly. Closes OODA loop inside the engine.

— claude-sonnet-4-6"
```

---

## Task 5: Extract handleWsMessage into ServerEngine

**Files:**
- Modify: `src/server-engine.ts`, `src/daemon.ts`, `src/orchestrator-context.ts`

- [ ] **Step 1: Read `handleWsMessage` and its dispatch table**

```bash
grep -n "private async handleWsMessage\|handleWsMessage\|\"ws:\|WsClientMessage" src/daemon.ts | head -20
```

WebSocket client messages include: `run_agent`, `run_schedule`, `agent_chat`, `chat_stop`, `toggle_agent`, `toggle_subsystem`, etc. Inventory them.

- [ ] **Step 2: Identify which action handlers stay vs move**

Handlers that just delegate to an engine method (e.g., run_agent → agentEngine.runAgent) — move to ServerEngine and have ServerEngine call the appropriate engine. Handlers that manipulate daemon-only state (e.g., toggle a session's enabled flag) — keep the logic in daemon but let ServerEngine call a daemon method via a new OrchestratorContext callback.

- [ ] **Step 3: Move handleWsMessage to ServerEngine**

Cut from daemon.ts, paste into ServerEngine as public method. The method now needs access to the other engines (AgentEngine, ToolEngine, etc.). Two options:

**Option A**: Pass engines into ServerEngine constructor:
```typescript
export class ServerEngine {
  constructor(
    private ctx: OrchestratorContext,
    private agentEngine: AgentEngine,
    private toolEngine: ToolEngine,
  ) {}
}
```

**Option B**: Add engine accessors to OrchestratorContext.

Pick Option A — cleaner and more explicit about the dependency.

- [ ] **Step 4: Update Daemon constructor to pass engines**

```typescript
this.serverEngine = new ServerEngine(ctx, this.agentEngine, this.toolEngine);
```

- [ ] **Step 5: Replace daemon's handleWsMessage call site with ServerEngine call**

```typescript
// daemon.ts WS onmessage handler:
this.serverEngine.handleWsMessage(ws, msg);
```

- [ ] **Step 6: Typecheck + test + build + commit**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build
git add src/server-engine.ts src/daemon.ts
git commit -m "refactor(daemon): extract handleWsMessage into ServerEngine

ServerEngine now receives AgentEngine + ToolEngine via constructor to dispatch
WS client messages. daemon.ts offloads ~200 lines of WS routing.

— claude-sonnet-4-6"
```

---

## Task 6: Extract handleIpcCommand into ServerEngine

Same pattern as handleWsMessage but for the IPC socket. Largest extraction — ~500 lines of `switch (cmd)` branches.

**Files:**
- Modify: `src/server-engine.ts`, `src/daemon.ts`

- [ ] **Step 1: Read handleIpcCommand**

```bash
grep -n "private async handleIpcCommand\|cmd === \"\|case \"" src/daemon.ts | head -40
```

The method is a large `switch` on command names (`status`, `start`, `stop`, `restart`, `shutdown`, `health`, `switchboard_get`, `switchboard_update`, `stream`, etc.).

- [ ] **Step 2: Categorize each case**

For each case:
- **Delegatable**: already has an engine method that handles it (e.g., `switchboard_update` → ServerEngine method)
- **Daemon-local**: manipulates session start/stop/restart — keep in daemon but expose as OrchestratorContext callback (e.g., `startSession: (name) => Promise<void>`)
- **Pure query**: reads state, returns — extract easily

- [ ] **Step 3: Add session lifecycle callbacks to OrchestratorContext**

For daemon-local operations, add to context:
```typescript
  startSession: (name: string) => Promise<void>;
  stopSession: (name: string) => Promise<void>;
  restartSession: (name: string) => Promise<void>;
  shutdownDaemon: (kill: boolean) => Promise<void>;
  runHealthSweep: () => Promise<HealthReport>;
```

- [ ] **Step 4: Move handleIpcCommand to ServerEngine**

Cut → paste → replace `this.X` with `this.ctx.X` or engine calls → update daemon's IPC wire-up to call `this.serverEngine.handleIpcCommand(cmd)`.

- [ ] **Step 5: Test thoroughly**

IPC is the main CLI→daemon channel. Test each command:
```bash
bun run build
node dist/tmx.js daemon --config /tmp/test-config.toml &
DAEMON_PID=$!
sleep 3
node dist/tmx.js status
node dist/tmx.js shutdown
wait $DAEMON_PID
```

- [ ] **Step 6: Typecheck + full test + commit**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build
git add src/server-engine.ts src/daemon.ts src/orchestrator-context.ts
git commit -m "refactor(daemon): extract handleIpcCommand into ServerEngine

~500 lines of IPC command dispatch moved to ServerEngine. Session lifecycle
operations exposed via OrchestratorContext callbacks.

— claude-sonnet-4-6"
```

---

## Task 7: Extract REST routes into ServerEngine

The final large extraction. The HTTP API has ~80 routes currently registered inline in daemon.ts.

**Files:**
- Modify: `src/server-engine.ts`, `src/daemon.ts`, `src/http.ts`

- [ ] **Step 1: Find REST route registration**

```bash
grep -n "registerRoute\|\.get(\"/\|\.post(\"/" src/daemon.ts | head -30
```

- [ ] **Step 2: Move route handlers to ServerEngine**

Define a `registerRoutes(dashboard: DashboardServer)` method on ServerEngine that registers all routes. Daemon's `start()` method just calls `this.serverEngine.registerRoutes(this.dashboard)`.

- [ ] **Step 3: Route handlers use engine methods directly**

Inside each route handler, use `this.agentEngine.X()`, `this.toolEngine.X()`, `this.ctx.memoryDb`, etc.

- [ ] **Step 4: Final verification**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build
# Exercise REST API via e2e test (or manual curl)
wc -l src/daemon.ts src/server-engine.ts
```

Expected: `daemon.ts` now ≤ 2,500 lines. `server-engine.ts` grew to ~1,500 lines.

- [ ] **Step 5: Commit**

```bash
git add src/server-engine.ts src/daemon.ts
git commit -m "refactor(daemon): extract REST route registration into ServerEngine

All ~80 REST handlers moved. daemon.ts now under 2,500 lines.
ServerEngine owns HTTP/WS/IPC dispatch end-to-end.

— claude-sonnet-4-6"
```

---

## Task 8: Update CLAUDE.md + final verification

- [ ] **Step 1: Update CLAUDE.md**

Update the Source Structure section with new line counts:
```
daemon.ts               — Main daemon lifecycle (~2,300 lines — session boot, health, watchdog)
agent-engine.ts         — OODA + agent dispatch + context builder (~1,000 lines)
tool-engine.ts          — Tool dispatch + context builder (~200 lines)
persistence.ts          — Memory consolidation + daily snapshots (~300 lines)
server-engine.ts        — HTTP/WS/IPC dispatch (~1,500 lines)
session-controller.ts   — Session lifecycle state machine (~130 lines)
orchestrator-context.ts — Shared dependency interface (~60 lines)
```

Adjust numbers to actual post-extraction line counts.

- [ ] **Step 2: Full regression check**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build
cd dashboard && bun run build && cd ..
node dist/tmx.js --version
```

All green.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): update engine line counts post-extraction

— claude-sonnet-4-6"
```
