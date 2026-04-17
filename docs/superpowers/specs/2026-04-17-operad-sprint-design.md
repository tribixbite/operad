# operad improvement sprint — design spec

**Date:** 2026-04-17  
**Author:** tribixbite  
**Status:** approved

---

## Problem statement

operad has grown to 6,644 lines in a single daemon file, 139 silent catch blocks, zero session-lifecycle tests, and agentic features that run by default on fresh installs without documentation or user awareness. The gap between what the project does and what users can discover is large.

## Product positioning (source of truth)

**Core product:** A hardened daemon for managing tmux sessions, Claude Code instances, and services across platforms. Features: session lifecycle management, health checks, auto-restart, dependency ordering, dashboard, memory/battery awareness, prompt history, skills/memory browser.

**Agentic layer:** Opt-in, experimental autonomous subsystem (OODA loops, agents, scheduling, memory consolidation). Not core. Disabled by default. Documented separately as "Advanced: Autonomous Layer."

---

## Sprint 0 — Bootstrap (prerequisite, done once before Sprint 1)

Before the Stop hook can advance sprints automatically, the following must exist:

1. `sprints/queue.txt` — 12 lines, one plan filename per line
2. `sprints/advance.sh` — shell script (see below)
3. All 12 `sprints/NN-*.md` plan files
4. `.claude/settings.json` in the operad repo root — Stop hook entry

**`advance.sh`** exact implementation:
```bash
#!/usr/bin/env bash
QUEUE="$HOME/git/operad/sprints/queue.txt"
[ -s "$QUEUE" ] || exit 0          # empty queue — done
PLAN=$(head -1 "$QUEUE")
tail -n +2 "$QUEUE" > "$QUEUE.tmp" && mv "$QUEUE.tmp" "$QUEUE"
PROMPT=$(cat "$HOME/git/operad/sprints/$PLAN")
cd "$HOME/git/operad" && claude --print "$PROMPT"
```

This avoids shell-quoting issues by writing the plan file path to stdin via `cat` and using `--print` for non-interactive execution. The working directory is set explicitly so relative paths in plans resolve correctly.

---

## Sprint structure

12 sprints total, executed sequentially via Stop hook + queue file.

### Sprint queue mechanism

**Files:**
```
sprints/
  queue.txt                     ← one filename per line, popped from top
  advance.sh                    ← Stop hook script
  01-gate-agentic.md
  02-doctor-command.md
  03-session-lifecycle-tests.md
  04-error-recovery-audit.md
  05-first-run-experience.md
  06-daemon-split-1-agents.md
  07-daemon-split-2-tools.md
  08-daemon-split-3-scheduling.md
  09-daemon-split-4-http-ipc.md
  10-daemon-split-5-core.md
  11-e2e-test-ci.md
  12-api-freeze.md
```

**`advance.sh`:** See Sprint 0 section for the exact implementation.

**Stop hook** in `operad/.claude/settings.json`:
```json
{
  "hooks": {
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "bash ~/git/operad/sprints/advance.sh" }] }]
  }
}
```

---

## Sprint 1 — Gate agentic features + in-app documentation

**Goal:** Fresh installs get a clean, core-only experience. All agentic features opt-in. Full in-app docs explain every feature before a user enables it.

### 1a. Default switchboard flip

Two files change:

**`src/types.ts` — `defaultSwitchboard()`:**
- `cognitive: false`
- `oodaAutoTrigger: false`
- `mindMeld: false`
- `all`, `sdkBridge`, `memoryInjection` remain `true` — `sdkBridge` and `memoryInjection` serve core session/prompt features, not agentic automation, so they stay on

**`src/agents.ts` — `getBuiltinAgents()`:**
- All four builtin agents (`master-controller`, `optimizer`, `preference-learner`, `ideator`) change `enabled: true` → `enabled: false`

Existing persisted state is not modified. Fresh state gets the new defaults.

### 1b. In-app docs page `/help`

New dashboard route at `/help` (SvelteKit page `dashboard/src/routes/help/+page.svelte`).

**Page structure:**
```
/help
  ├── Overview — what operad is, core vs agentic
  ├── Core Features
  │     ├── Session Management (lifecycle, state machine, health checks)
  │     ├── Dashboard (overview, memory, logs, telemetry, settings)
  │     ├── Config (operad.toml reference with all fields)
  │     ├── Prompt History (search, star, replay)
  │     └── Skills & Memory Browser
  └── Advanced: Autonomous Layer (collapsed by default)
        ├── Getting Started (how to enable, what to expect)
        ├── OODA Loop & Master Controller
        ├── Agents (optimizer, preference-learner, ideator)
        ├── Scheduling Engine (cron/interval syntax, trigger inspection)
        ├── Memory System (decay, consolidation, cross-pollination)
        ├── Specialization & Roundtable
        ├── Agent Chat & Tuning Guide
        └── Roadmap / TODOs
```

The "Advanced" section is a collapsible `<details>` block with a prominent notice: "Opt-in. Disabled by default. Enable via Settings → Switchboard."

### 1c. Switchboard UI update

Each toggle in `SettingsPanel` gets a `?` icon (link to `/help#<anchor>`) so users can read the docs before enabling. The Switchboard section gets a top-level notice: "All autonomous features are disabled on fresh installs."

### 1d. README update

`README.md` restructured:
- Lead section: core daemon capabilities only
- "Advanced: Autonomous Layer" section clearly separated, with opt-in callout
- 60-second quickstart that actually works (install → config → `operad boot` → dashboard)
- Link to in-app `/help` for detailed docs

---

## Sprint 2 — `operad doctor`

**Goal:** Single command that diagnoses a broken or misconfigured install.

### Checks:
1. `tmux` installed and version ≥ 3.2
2. Config file exists and parses without errors
3. All configured session commands exist on `$PATH`
4. Dashboard built (`dist/` present and non-empty)
5. IPC socket: daemon running? If yes, ping round-trip. If no, port 18970 available?
6. Platform-specific: on Android, `termux-info` available; `$PREFIX` set; phantom budget not exhausted
7. bun/node available on `$PATH`
8. Write permissions for state dir (`~/.local/share/tmx/`)
9. SQLite memory database: if present, run `PRAGMA integrity_check` and report corruption

**Output format:** colored checklist, `[OK]` / `[WARN]` / `[FAIL]`, with fix instructions for each failure.

**CLI:** `operad doctor` (new `case "doctor":` in `tmx.ts`), no daemon required.

---

## Sprint 3 — Integration tests: session lifecycle

**Goal:** Test the state machine (pending → running → degraded → failed) with mocked tmux and simulated health check failures.

### Approach:
Session management is currently implemented as methods on the `Orchestrator` class in `daemon.ts`. To make it testable without running a full daemon, Sprint 3 must first extract session state transition logic into pure functions or a thin `SessionController` class that accepts a `tmuxRunner: (args: string[]) => SpawnResult` parameter. The `Orchestrator` constructor receives a real runner; tests inject a fake.

**Prerequisite refactor (part of Sprint 3):** Extract `startSession()`, `stopSession()`, `checkSessionHealth()`, and the state transition logic from `Orchestrator` into `src/session-controller.ts`, wired back into `daemon.ts` via constructor injection.

- New file `src/__tests__/session-lifecycle.test.ts`
- Test scenarios:
  - Happy path: pending → starting → running
  - Health check failure → degraded → restart cascade
  - Max restarts exceeded → failed
  - Dependency ordering: session B waits for session A to reach running
  - Dependency failure: A fails, B never starts
  - Stop: running → stopping → stopped
  - Auto-restart on unexpected exit

---

## Sprint 4 — Error recovery audit

**Goal:** Eliminate silent failures in daemon.ts. Every `catch` block is either justified (with a comment) or upgraded to structured logging.

### Approach:
- Enumerate all 139 `catch` blocks in daemon.ts
- Categorize each: (a) genuinely safe to swallow, (b) should log warn, (c) should log error + surface to health status, (d) hides a real bug
- For (a): add a one-line comment explaining why silence is correct
- For (b)/(c): replace empty catch with `log.warn`/`log.error` + structured fields
- For (d): fix the underlying issue

---

## Sprint 5 — First-run experience

**Goal:** `npm i -g operadic && operad boot` works on a clean Linux, macOS, and Termux install.

### Work items:
- Config validation: on boot, validate the config against a schema; print actionable errors instead of crashing
- Generate a minimal `operad.toml` if none exists (interactive or `--init` flag)
- Quickstart in README: exact commands, expected output, link to `/help` for next steps
- Smoke-test the full install flow in CI (Linux only — use a Docker container or GitHub Actions job with no pre-existing config)

---

## Sprints 6–10 — daemon.ts refactor (5 sprints)

**Goal:** Reduce daemon.ts from 6,644 lines to a ~1,000-line orchestration core. Each sprint extracts one subsystem into its own module with a clean interface.

### Shared state problem

The `Orchestrator` class holds a dozen shared fields (`this.agentConfigs`, `this.memoryDb`, `this.switchboard`, `this.sdkBridge`, etc.) accessed from nearly every method. Before extraction, **Sprint 6 must first define a `OrchestratorContext` interface** that bundles all shared dependencies. Each extracted module receives the context object — this avoids circular imports and keeps the extracted files independently testable.

```ts
// src/orchestrator-context.ts (new, Sprint 6 prerequisite)
export interface OrchestratorContext {
  config: DaemonConfig;
  state: StateManager;
  memoryDb: MemoryDb | null;
  switchboard: Switchboard;
  sdkBridge: SdkBridge | null;
  log: Logger;
  // ... other shared deps
}
```

### Extraction plan

| Sprint | Extract | Target file | Approx lines freed |
|--------|---------|-------------|-------------------|
| 6 | `OrchestratorContext` interface + agent/cognitive system (OODA, consolidation, specialization, roundtable) | `src/agent-engine.ts` | ~1,800 |
| 7 | Tool dispatch (tool registry, tool execution, lease management) | `src/tool-engine.ts` | ~600 |
| 8 | Scheduling + state persistence (schedule engine, daily snapshots, state save/load) | `src/persistence.ts` | ~700 |
| 9 | HTTP + IPC layer (DashboardServer, REST routes, SSE, WS, IPC socket handler) | `src/server.ts` | ~1,200 |
| 10 | Slim core (session orchestration, health sweep, watchdog, boot/shutdown) | daemon.ts ~1,000 lines | — |

**Each sprint cadence:** extract → update imports → typecheck passes → `bun test` passes → `node dist/tmx.js --version` smoke test → commit. Do not merge a sprint that fails typecheck.

**Rollback plan:** Each sprint is an independent commit on `main`. If a sprint introduces a regression caught by CI, revert that commit cleanly (the `OrchestratorContext` pattern keeps coupling explicit so reverts are safe).

**Circular import risk:** All extracted modules import `OrchestratorContext` from `src/orchestrator-context.ts`. `daemon.ts` imports the extracted modules. `orchestrator-context.ts` imports only types. No cycles.

---

## Sprint 11 — End-to-end test in CI

**Goal:** One test that boots the daemon, hits every API endpoint, verifies every dashboard page renders with real data, and stops cleanly. Runs in CI on every push.

### Approach:
- New file `src/__tests__/e2e.test.ts`
- Uses a temp config with a single fake session (a `sleep 3600` process)
- Boot daemon, wait for `boot_complete`, hit REST endpoints, verify SSE emits events, stop daemon
- Dashboard: use `curl` to verify each static route returns 200
- Runs Linux only in CI (GitHub Actions)

---

## Sprint 12 — API documentation / freeze

**Goal:** Every public interface is documented and stable. Breaking changes require a version bump.

### Work items:
- `docs/api.md`: every REST endpoint, every SSE event type, every IPC command, with request/response shapes
- `docs/config.md`: full operad.toml reference (every field, type, default, example)
- `CHANGELOG.md`: kept up to date from this sprint forward
- Semver policy documented in README: patch = bugfix, minor = new endpoint, major = breaking change
- Add a CI step: if `src/http.ts` or `src/ipc.ts` changed in the PR (detected via `git diff --name-only origin/main HEAD`), the job checks that `docs/api.md` was also modified; if not, the step fails with a message "API source changed but docs/api.md was not updated". Implemented as a shell step in `.github/workflows/ci.yml`.

---

## Non-goals (this sprint series)

- No new agentic features
- No frontend redesign
- No new platform support
- No plugin system
