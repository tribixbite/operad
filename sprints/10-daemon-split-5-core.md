# Sprint 10: Daemon Split 5/5 — Slim Core

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Final cleanup of `src/daemon.ts` to reach ~1,000 lines. Remove all remaining private helper methods that belong in other modules. The result: daemon.ts contains only session orchestration (boot, health sweep, watchdog, dependency ordering, session start/stop) and the `Orchestrator` class constructor/wiring.

**Architecture:** This is a cleanup sprint, not a new extraction. Remove dead code, collapse thin wrappers, move any remaining misplaced methods to their correct home (session-controller.ts, agent-engine.ts, etc.). Prereqs: Sprints 6-9 complete.

**Tech Stack:** TypeScript strict mode. Prereqs: Sprints 6, 7, 8, 9 complete.

**Spec:** `docs/superpowers/specs/2026-04-17-operad-sprint-design.md` § Sprint 10

---

## Project Context

After Sprint 9, `src/daemon.ts` is ~2,300 lines. The remaining code should be:
- `Orchestrator` class constructor and field declarations
- `start()` and `stop()` lifecycle
- Boot sequence (`bootSessions()`, `bootSession()`, `waitForDependencies()`)
- Health sweep loop
- Watchdog / process monitoring
- Session start/stop/restart methods (or delegation to SessionController)
- Memory pressure handler
- Battery handler
- `updateSwitchboard()` method (owns switchboard mutation)

Everything else should already be extracted. If any agent/tool/HTTP logic remains, move it now.

---

## Task 1: Audit what's left in daemon.ts

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Read the full remaining daemon.ts**

```bash
wc -l src/daemon.ts
grep -n "private\|async\|function" src/daemon.ts | head -60
```

List all remaining private methods. For each, decide:
- (a) Belongs here (session lifecycle, boot, health) → keep
- (b) Misplaced (should be in an already-extracted engine) → move
- (c) Dead code → delete

- [ ] **Step 2: Move misplaced methods**

For any method that belongs in AgentEngine, ToolEngine, PersistenceEngine, or ServerEngine: cut, paste, typecheck.

- [ ] **Step 3: Delete dead code**

Any methods with no callers (verify with `grep -rn "methodName" src/`). Remove them.

- [ ] **Step 4: Collapse thin wrappers**

Any method that is just `return this.someEngine.someMethod(args)` with no added logic — remove the wrapper and update callers to call the engine directly.

- [ ] **Step 5: Typecheck + tests + build**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build
node dist/tmx.js --version
wc -l src/daemon.ts
```
Expected: daemon.ts ≤ 1,500 lines (target is ~1,000; 1,500 is acceptable if the remaining code is all legitimate core logic).

- [ ] **Step 6: Update CLAUDE.md line count**

The CLAUDE.md says daemon.ts is ~4,380 lines (already out of date). Update it:
```bash
grep -n "daemon.ts\|4380\|6644" CLAUDE.md
```
Update the line count to actual.

- [ ] **Step 7: Commit**

```bash
git add src/daemon.ts CLAUDE.md
git commit -m "refactor(daemon): final cleanup — daemon.ts now ~1,000 lines of core session logic

Removed dead code, collapsed thin wrappers, moved misplaced methods to
their correct engines. Orchestrator now contains only session lifecycle,
boot sequence, health sweep, watchdog, and memory/battery handlers.

— claude-sonnet-4-6"
```

---

## Task 2: Full regression check

- [ ] **Step 1: All tests**

```bash
cd ~/git/operad && bun test
```
Expected: all tests pass.

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```
Expected: clean.

- [ ] **Step 3: Build both bundles**

```bash
bun run build
cd dashboard && bun run build && cd ..
```
Expected: both build successfully.

- [ ] **Step 4: Summary commit (if any cleanup)**

```bash
git add -p  # review any remaining changes
git commit -m "chore(daemon): post-refactor cleanup and CLAUDE.md update — claude-sonnet-4-6"
```
