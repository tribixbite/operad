# Sprint 4: Error Recovery Audit

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate silent failures in daemon.ts. Categorize all 139 catch blocks, add structured logging where silence is unjustified, and fix any bugs hiding behind empty catch blocks.

**Architecture:** Read-then-fix audit. Work through daemon.ts catch blocks in file order, categorize each, update in-place. No new files needed. Commit in 4-5 logical batches (process-kill group, health group, agent group, etc.).

**Tech Stack:** TypeScript. No new dependencies. Uses existing `log.warn` / `log.error` from `src/log.ts` (Logger instance methods).

**Spec:** `docs/superpowers/specs/2026-04-17-operad-sprint-design.md` § Sprint 4

---

## Project Context

`src/daemon.ts` has 139 `catch` blocks. The Logger instance (`this.log`) has methods: `error(msg, meta?)`, `warn(msg, meta?)`, `info(msg, meta?)`, `debug(msg, meta?)`. Structured logging uses an optional second argument: `this.log.warn("message", { key: value })`.

Categories:
- **(a) Genuinely safe** — add a one-line comment explaining why silence is correct (e.g., `/* already dead */`)
- **(b) Should log warn** — replace empty catch with `this.log.warn(...)`
- **(c) Should log error + surface** — replace with `this.log.error(...)` and consider updating session health status
- **(d) Hides a real bug** — fix the underlying issue

---

## Task 1: Audit and fix process-kill catch blocks (~lines 830-850)

These are the `try { process.kill(pid, "SIGTERM") } catch { /* already dead */ }` pattern. Safe to silence.

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Read daemon.ts lines 825-860**

Find all catch blocks in the process-kill section. Confirm they wrap `process.kill()` calls. These are legitimately safe to silence (race condition — process died between PID check and kill).

- [ ] **Step 2: Ensure all have a justification comment**

Each empty `catch` around `process.kill()` should have exactly: `/* already dead — race between PID check and kill */`

If they already have a comment, leave them. If empty, add the comment.

- [ ] **Step 3: Typecheck + test**

```bash
cd ~/git/operad && bun run typecheck && bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts
git commit -m "fix(daemon): document safe process-kill catch blocks

Empty catch around process.kill() is intentional — documents the
PID-check/kill race condition.

— claude-sonnet-4-6"
```

---

## Task 2: Audit health check catch blocks (~lines 1080-1300)

The health sweep has multiple catch blocks. Health check failures should always be logged.

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Read daemon.ts lines 1075-1310**

Find all catch blocks in the health check section. For each:
- If it silences a specific transient error (e.g., ECONNREFUSED for HTTP check) → document with comment
- If it silences unexpected errors → upgrade to `this.log.warn("Health check error", { session: name, err: String(err) })`

- [ ] **Step 2: Apply fixes**

For each catch block in the health section that is empty without justification, replace `} catch {` with:
```typescript
} catch (err) {
  this.log.warn("Health check failed unexpectedly", { err: String(err) });
}
```

For catch blocks that are expected (e.g., HTTP connection refused when service is starting), add a comment:
```typescript
} catch { /* ECONNREFUSED expected while session is starting */ }
```

- [ ] **Step 3: Typecheck + test**

```bash
cd ~/git/operad && bun run typecheck && bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts
git commit -m "fix(daemon): add structured logging to health check catch blocks

Previously silent health check errors now log.warn with session name and
error string. Expected connection-refused cases documented with comments.

— claude-sonnet-4-6"
```

---

## Task 3: Audit agent/cognitive catch blocks (~lines 2100-2500)

Agent runs and cognitive loop have several catch blocks. Failures here should always surface.

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Read daemon.ts lines 2090-2510**

Find all catch blocks in agent execution and OODA sections. For each:
- If it silences an agent run error → upgrade to `this.log.error("Agent run failed", { agent: name, err: String(err) })`
- If it silences a broadcastSwitchboard error → safe to warn (non-critical)
- Look for `catch { return null; }` patterns (e.g., ~line 2105) — these should at minimum log debug

- [ ] **Step 2: Apply fixes**

Key patterns to fix:
```typescript
// BEFORE: silent
} catch { return null; }

// AFTER: logged
} catch (err) {
  this.log.debug("Agent context fetch failed", { err: String(err) });
  return null;
}
```

For agent run errors:
```typescript
// BEFORE
} catch (err) {
  this.broadcastSwitchboard("ooda_status", { running: false, error: String(err) });
}

// AFTER — keep broadcast, add log
} catch (err) {
  this.log.error("OODA cycle failed", { err: String(err) });
  this.broadcastSwitchboard("ooda_status", { running: false, error: String(err) });
}
```

- [ ] **Step 3: Typecheck + test**

```bash
cd ~/git/operad && bun run typecheck && bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts
git commit -m "fix(daemon): surface agent and OODA loop errors via structured logging

Agent run failures, OODA cycle errors, and context fetch failures now emit
log.error/warn instead of silently swallowing. Broadcast to WS clients preserved.

— claude-sonnet-4-6"
```

---

## Task 4: Audit remaining catch blocks (lines 150-760, 1350-2090, 2510-6644)

Sweep the rest of daemon.ts for catch blocks not covered by Tasks 1-3.

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: List all remaining empty catch blocks**

```bash
grep -n "} catch {$\|} catch (err) {$" src/daemon.ts | grep -v "already dead\|ECONNREFUSED\|SIGTERM\|SIGKILL"
```

Review each line number. For each empty `catch {}`:
- (a) If the surrounding code is clearly best-effort (e.g., cleanup on shutdown) → add comment
- (b) If the error would indicate a real problem → add `this.log.warn(...)`
- (c) If it's in a critical path (session start, state save) → add `this.log.error(...)`

- [ ] **Step 2: Apply remaining fixes**

Work through the list from Step 1 and fix each.

Special attention to:
- `src/daemon.ts:158` — top of file, likely in initialization — critical path, use `log.error`
- `src/daemon.ts:429` — early in daemon.start() — use `log.error`
- `src/daemon.ts:1082` — likely in IPC or network — use `log.warn`
- `src/daemon.ts:1133` and nearby — use `log.warn` unless documented otherwise

- [ ] **Step 3: Final typecheck + full test run**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build && node dist/tmx.js --version
```
Expected: all clean.

- [ ] **Step 4: Final commit**

```bash
git add src/daemon.ts
git commit -m "fix(daemon): complete error recovery audit — no more unjustified silent failures

All 139 catch blocks in daemon.ts now either have a justification comment (safe
to silence) or emit structured log.warn/error. Critical-path errors emit log.error.

— claude-sonnet-4-6"
```
