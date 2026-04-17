# Sprint 14: Audit Fixes + State Migration

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the specific issues flagged by the Sprint 1-12 audit: SessionController's stub healthChecker, switchboard reference drift, non-monotone restartCount, missing VALID_TRANSITIONS enforcement, and state migration so upgrading users get the new opt-in defaults.

**Architecture:** Targeted bug fixes + one migration step. Each fix is independent — commit each.

**Tech Stack:** TypeScript strict mode.

**Spec:** Closes gaps found in the Sprint 1-12 verification audit.

---

## Project Context

Audit findings to address:

1. **Stub healthChecker** — `src/daemon.ts` constructs SessionController with `healthChecker: async () => ({ healthy: true })`. Real health delegation is not wired.
2. **Switchboard reference drift** — `OrchestratorContext.switchboard` captures a reference at construction. If `updateSwitchboard` replaces rather than mutates, the ctx field goes stale.
3. **Non-monotone restartCount** — `SessionController.handleHealthFailure` increments `restartCount` and never decrements. After 3 separate successful restarts over hours, a 4th failure marks the session failed.
4. **VALID_TRANSITIONS not enforced** — `SessionController.transition()` writes any `status`, ignoring the canonical state machine in `src/types.ts`.
5. **Existing installs miss opt-in defaults** — `loadConfig` merges `defaultSwitchboard()` with persisted state: `{ ...defaultSwitchboard(), ...persisted }`. If user previously had `cognitive: true` in state.json, it stays true.

---

## Task 1: Wire real healthChecker into SessionController

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Read how daemon currently runs health checks**

```bash
grep -n "runHealthSweep\|checkHealth\|healthCheck" src/daemon.ts | head -10
```

`src/health.ts` exports `runHealthSweep(sessions, tmux, platform)`. There may be per-session single-check helpers. If not, add a small helper in `health.ts`:

```typescript
export async function checkSessionHealth(
  name: string,
  config: SessionConfig,
  tmux: TmuxRunner,
  platform: Platform,
): Promise<HealthResult> { ... }
```

- [ ] **Step 2: Replace the stub**

In daemon constructor where SessionController is created:

```typescript
this.sessionController = new SessionController({
  tmuxRunner,
  healthChecker: async (name, config) => {
    const result = await checkSessionHealth(name, config, tmuxRunner, this.platform);
    return result;
  },
  log: this.log,
});
```

- [ ] **Step 3: Typecheck + test**

```bash
cd ~/git/operad && bun run typecheck && bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts src/health.ts
git commit -m "fix(session-controller): wire real healthChecker into SessionController

Previously a no-op stub (always returned healthy). Now delegates to health.ts
single-session check that runs the configured health probe (tmux/http/process/custom).

— claude-sonnet-4-6"
```

---

## Task 2: Fix switchboard reference drift

**Files:**
- Modify: `src/daemon.ts`, `src/orchestrator-context.ts`, consumers that read `ctx.switchboard`

- [ ] **Step 1: Verify the drift is real**

```bash
grep -n "this.switchboard = \|Object.assign(this.switchboard" src/daemon.ts | head -10
```

If `this.switchboard = { ...this.switchboard, ...patch }` appears anywhere, the reference is replaced and ctx goes stale. If only `Object.assign(this.switchboard, patch)` — reference is preserved; still worth making explicit.

- [ ] **Step 2: Change OrchestratorContext to use a getter**

Replace the static field with a getter:

```typescript
// in orchestrator-context.ts
export interface OrchestratorContext {
  // ...
  getSwitchboard: () => Switchboard;  // was: switchboard: Switchboard
  // ...
}
```

- [ ] **Step 3: Update all consumers**

In every engine class, replace `this.ctx.switchboard` with `this.ctx.getSwitchboard()`.

- [ ] **Step 4: Daemon constructs context with a getter**

```typescript
const ctx: OrchestratorContext = {
  // ...
  getSwitchboard: () => this.switchboard,
  // ...
};
```

- [ ] **Step 5: Typecheck + test + commit**

```bash
cd ~/git/operad && bun run typecheck && bun test
git add src/orchestrator-context.ts src/daemon.ts src/agent-engine.ts src/tool-engine.ts src/server-engine.ts src/persistence.ts
git commit -m "fix(context): switchboard access via getter to prevent reference drift

updateSwitchboard may replace the object reference; engines now always see
current state via ctx.getSwitchboard().

— claude-sonnet-4-6"
```

---

## Task 3: Reset restartCount after successful restart

**Files:**
- Modify: `src/session-controller.ts`, `src/__tests__/session-lifecycle.test.ts`

- [ ] **Step 1: Update handleHealthFailure logic**

Currently `handleHealthFailure` increments `restartCount` and never resets. After a successful restart (`start()` returns `running`), the counter should reset.

In `SessionController.handleHealthFailure`:

```typescript
async handleHealthFailure(name: string, config: SessionConfig): Promise<SessionRuntimeState> {
  const state = this.states.get(name);
  if (!state) return this.transition(name, "failed");

  const maxRestarts = config.max_restarts ?? this.opts.maxRestarts;
  if (state.restartCount >= maxRestarts) {
    this.opts.log.error(`Session '${name}' exceeded max restarts (${maxRestarts})`);
    return this.transition(name, "failed", { restartCount: state.restartCount });
  }

  this.opts.log.warn(`Session '${name}' degraded — restarting (${state.restartCount + 1}/${maxRestarts})`);
  this.transition(name, "degraded", { restartCount: state.restartCount + 1 });

  await this.stop(name);
  if (this.opts.restartDelayMs > 0) {
    await new Promise(r => setTimeout(r, this.opts.restartDelayMs));
  }
  const afterStart = await this.start(name, config);
  // NEW: reset counter if the restart succeeded
  if (afterStart.status === "running") {
    return this.transition(name, "running", { restartCount: 0 });
  }
  return afterStart;
}
```

- [ ] **Step 2: Update tests**

Update `src/__tests__/session-lifecycle.test.ts`:

Add a new test:
```typescript
test("restartCount resets to 0 after successful restart", async () => {
  const ctrl = new SessionController({ tmuxRunner: okRunner, healthChecker: healthyChecker, log, restartDelayMs: 0 });
  await ctrl.start("app", makeConfig("app"));
  const state = await ctrl.handleHealthFailure("app", makeConfig("app"));
  expect(state.status).toBe("running");
  expect(ctrl.getState("app")?.restartCount).toBe(0);  // was 1 under old behavior
});
```

Update the existing `first failure restarts` test that asserted `restartCount === 1`:
```typescript
// After handleHealthFailure succeeds, the count resets.
expect(ctrl.getState("app")?.restartCount).toBe(0);
```

- [ ] **Step 3: Typecheck + test + commit**

```bash
cd ~/git/operad && bun run typecheck && bun test
git add src/session-controller.ts src/__tests__/session-lifecycle.test.ts
git commit -m "fix(session-controller): reset restartCount after successful restart

Counter previously monotone — 3 successful restarts over hours would cause
a 4th failure to mark the session failed. Now resets to 0 after recovery.

— claude-sonnet-4-6"
```

---

## Task 4: Enforce VALID_TRANSITIONS in SessionController

**Files:**
- Modify: `src/session-controller.ts`, `src/types.ts`, possibly `src/__tests__/session-lifecycle.test.ts`

- [ ] **Step 1: Read the canonical state machine**

```bash
grep -n "VALID_TRANSITIONS\|SessionStatus" src/types.ts | head -20
```

The transitions table lists which `from → to` pairs are legal.

- [ ] **Step 2: Decide: enforce or update the table**

The current SessionController transitions include `pending → starting` (not strictly in the table). Options:
- (a) Update `VALID_TRANSITIONS` to include `pending → starting` and `failed → starting` directly (simpler, matches reality)
- (b) Enforce the original table and have SessionController walk `pending → waiting → starting` (more fiddly)

Pick (a) — update the table to reflect how the controller actually works. Document why each pair is allowed.

- [ ] **Step 3: Add enforcement**

In `SessionController.transition`:

```typescript
private transition(name: string, to: SessionStatus, extra: Partial<SessionRuntimeState> = {}): SessionRuntimeState {
  const existing = this.states.get(name) ?? { name, status: "pending" as SessionStatus, restartCount: 0, lastTransition: new Date() };
  const allowed = VALID_TRANSITIONS[existing.status];
  if (!allowed.includes(to)) {
    this.opts.log.warn(`Invalid transition for '${name}': ${existing.status} → ${to} (forcing)`);
  }
  const next: SessionRuntimeState = { ...existing, status: to, lastTransition: new Date(), ...extra };
  this.states.set(name, next);
  return next;
}
```

Warn rather than throw — the session state machine isn't life-critical; invalid transitions should be logged but not crash the daemon.

- [ ] **Step 4: Tests still pass with updated table**

```bash
cd ~/git/operad && bun test
```

- [ ] **Step 5: Commit**

```bash
git add src/session-controller.ts src/types.ts
git commit -m "fix(session-controller): enforce VALID_TRANSITIONS via warn-on-invalid

Updates table to match SessionController's actual transitions (pending → starting,
failed → starting). Invalid transitions now log.warn but don't throw — keeps
daemon resilient to edge cases.

— claude-sonnet-4-6"
```

---

## Task 5: State migration for existing installs

Sprint 1 flipped `cognitive`, `oodaAutoTrigger`, `mindMeld` defaults to `false`. But existing users have those as `true` in persisted state.json. They never see the new defaults.

**Files:**
- Modify: `src/state.ts` (or wherever state schema lives)
- Modify: `src/daemon.ts` (call migration on boot)

- [ ] **Step 1: Read state.ts**

```bash
grep -n "migrate\|version\|schema" src/state.ts | head -10
```

Understand current state file shape. State likely has a `version` field; if not, add one.

- [ ] **Step 2: Design the migration**

Add a `schemaVersion` field. Current version is implicit v1; this migration makes it v2.

Migration rule: if user's state has `switchboard.cognitive === true` AND `schemaVersion < 2`, leave it alone (respect existing user choice). If state has `switchboard.cognitive === undefined`, apply new default (false). Only reset if user hasn't explicitly set the field.

Actually, simpler: the goal is that fresh installs get opt-in defaults. Existing users who explicitly enabled cognitive should keep it on. So the only case that matters is: users who never touched the setting.

If persisted state was saved with previous default `true`, we can't distinguish explicit-true from default-true. Pragmatic choice: print a one-time notice on first boot after v0.4.0:

```
operad v0.4.0 changed opt-in defaults for cognitive/OODA features.
Your current settings are preserved. To reset to new defaults:
  operad switchboard reset
```

Add a `switchboard reset` IPC command / CLI that clears the three flags.

- [ ] **Step 3: Implement schemaVersion + notice**

In `state.ts`:
```typescript
interface PersistedState {
  schemaVersion?: number;
  // ...
}

export function migrateState(state: PersistedState): { state: PersistedState; notice: string | null } {
  if ((state.schemaVersion ?? 1) < 2) {
    const notice = `operad v0.4.0: cognitive/OODA/mindMeld defaults flipped to false on fresh installs.
Your existing settings are preserved. Run 'operad switchboard reset' to apply new defaults.`;
    state.schemaVersion = 2;
    return { state, notice };
  }
  return { state, notice: null };
}
```

In daemon.ts on boot, after loading state:
```typescript
const { state: migrated, notice } = migrateState(this.state.getState());
this.state.setState(migrated);
if (notice) {
  this.log.info(notice);
  console.log(notice);
}
```

- [ ] **Step 4: Add `operad switchboard reset` command**

In `src/tmx.ts`:
```typescript
case "switchboard":
  return runSwitchboard();
```

Implement to delegate via IPC to a new `switchboard_reset` command, which resets cognitive/oodaAutoTrigger/mindMeld to `false`.

- [ ] **Step 5: Typecheck + test + build + commit**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build
git add src/state.ts src/daemon.ts src/tmx.ts
git commit -m "feat(state): one-time notice for v0.4.0 opt-in default change

Existing users keep their current switchboard values (respects their explicit
choices). New notice on first boot. New 'operad switchboard reset' command
to apply the new opt-in defaults manually.

— claude-sonnet-4-6"
```

---

## Task 6: Final verification

- [ ] **Step 1: Full build + test**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build
cd dashboard && bun run build && cd ..
node dist/tmx.js --version
node dist/tmx.js doctor | head -15
```

- [ ] **Step 2: Git status clean**

```bash
git status
```

All changes committed.
