# Sprint 12: API Documentation & Freeze

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document every REST endpoint, SSE event type, and IPC command. Add a CI check that fails if API source files change without docs update. Establish semver policy.

**Architecture:** Read `src/http.ts` and `src/ipc.ts` (and `src/server.ts` if created in Sprint 9) exhaustively. Write `docs/api.md` with request/response shapes. Write `docs/config.md` as full config reference. Add CI diff-check step.

**Tech Stack:** Markdown docs. Shell script for CI diff check. No new TypeScript.

**Spec:** `docs/superpowers/specs/2026-04-17-operad-sprint-design.md` § Sprint 12

---

## Project Context

- `src/http.ts` — DashboardServer, REST route registration
- `src/ipc.ts` — Unix socket IPC, command definitions
- `src/server.ts` (if Sprint 9 created it) — WebSocket and SSE
- `src/types.ts` — type definitions for request/response shapes
- `CHANGELOG.md` — exists but may need updating
- `README.md` — already restructured in Sprint 1

---

## Task 1: Write `docs/api.md`

**Files:**
- Create: `docs/api.md`

- [ ] **Step 1: Read all HTTP routes**

```bash
grep -n "app\.get\|app\.post\|app\.put\|app\.delete\|router\.\|\.get(\|\.post(" src/http.ts src/server.ts 2>/dev/null | head -60
```

Also grep daemon.ts for any remaining route registrations.

- [ ] **Step 2: Read all IPC commands**

```bash
grep -n "case\|cmd.*==\|\"cmd\"\|ipc.*command" src/ipc.ts | head -40
```

- [ ] **Step 3: Read SSE event types**

```bash
grep -n "type.*:\|\"type\"\|event.*type\|broadcastSwitchboard\|broadcast(" src/daemon.ts src/server.ts 2>/dev/null | grep -i "type\|event" | head -30
```

- [ ] **Step 4: Write `docs/api.md`**

Structure:

```markdown
# operad API Reference

> **Stability:** This API is frozen as of v0.3.x. Breaking changes require a major version bump.

## REST API

Base URL: `http://localhost:18970` (port configurable in `operad.toml`)

### Sessions

#### GET /api/sessions
Returns all session states.

**Response:**
\`\`\`json
[
  {
    "name": "my-session",
    "status": "running",
    "restartCount": 0,
    "lastTransition": "2026-04-17T10:00:00.000Z",
    "pid": 12345
  }
]
\`\`\`

#### POST /api/sessions/:name/start
Start a stopped session.

#### POST /api/sessions/:name/stop
Stop a running session.

#### POST /api/sessions/:name/restart
Restart a session.

### System

#### GET /api/status
Returns daemon state.

**Response:**
\`\`\`json
{
  "daemon_start": "2026-04-17T09:00:00.000Z",
  "boot_complete": true,
  "uptime_ms": 3600000
}
\`\`\`

#### GET /api/memory
Returns current system memory snapshot.

#### GET /api/quota
Returns current token quota status.

#### GET /api/logs
Returns recent log entries.

### Agents (opt-in)

#### GET /api/agents
Returns registered agent configurations.

#### POST /api/agents/:name/run
Trigger a manual agent run.

### Scheduling (opt-in)

#### GET /api/schedule
List all schedules.

#### POST /api/schedule
Create a new schedule.

**Body:**
\`\`\`json
{
  "name": "daily-optimize",
  "agent": "optimizer",
  "cron": "0 9 * * *"
}
\`\`\`

#### DELETE /api/schedule/:name
Delete a schedule.

---

## SSE Events

Connect to `GET /api/events` (or `/api/sse`) for a server-sent event stream.

Each event is a JSON object with a `type` field.

| Event type | Payload | Description |
|------------|---------|-------------|
| `session_update` | `{ name, status, ... }` | Session state changed |
| `memory_update` | `{ ...SystemMemorySnapshot }` | Memory snapshot |
| `battery_update` | `{ ...BatterySnapshot }` | Battery snapshot |
| `switchboard_update` | `{ ...Switchboard }` | Switchboard state changed |
| `ooda_status` | `{ running, lastRun?, error? }` | OODA loop status |
| `log` | `{ level, message, meta }` | Log entry |

---

## IPC Commands

Connect to the Unix socket at `$PREFIX/tmp/tmx.sock` (Android) or `/tmp/operad.sock` (Linux/macOS).

Send newline-delimited JSON: `{ "cmd": "<command>", ...args }\n`

| Command | Args | Response |
|---------|------|----------|
| `status` | — | `{ ok: true, sessions: [...] }` |
| `start` | `{ name: string }` | `{ ok: true }` |
| `stop` | `{ name: string }` | `{ ok: true }` |
| `restart` | `{ name: string }` | `{ ok: true }` |
| `shutdown` | — | `{ ok: true }` |
| `health` | `{ name?: string }` | health check results |
| `switchboard_get` | — | current switchboard state |
| `switchboard_update` | `{ ...Partial<Switchboard> }` | updated switchboard |
| `stream` | — | boot + stream session events |

---

## Versioning Policy

- **Patch** (x.x.N) — bug fixes, no API changes
- **Minor** (x.N.0) — new endpoints or event types (backwards compatible)
- **Major** (N.0.0) — breaking changes to existing endpoints, removed fields, changed types
```

Document ALL endpoints you find in Step 1-3. Do not omit any.

- [ ] **Step 5: Commit**

```bash
git add docs/api.md
git commit -m "docs(api): complete REST/SSE/IPC API reference

Documents every endpoint, SSE event type, and IPC command with
request/response shapes. Establishes semver policy.

— claude-sonnet-4-6"
```

---

## Task 2: Write `docs/config.md`

**Files:**
- Create: `docs/config.md`

- [ ] **Step 1: Read `src/config.ts` exhaustively**

Read the full config parser to enumerate every field, its type, default, and validation.

- [ ] **Step 2: Write `docs/config.md`**

Document every field in `[operad]` (also `[orchestrator]` for backwards compat), `[[session]]`, `[battery]`, and `[session.health]` blocks. Format: field name, type, default, description, example.

- [ ] **Step 3: Commit**

```bash
git add docs/config.md
git commit -m "docs(config): full operad.toml field reference

Every config field documented with type, default, and example.

— claude-sonnet-4-6"
```

---

## Task 3: Add API drift CI check

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add diff-check step**

In the existing `build` job (or as a separate job), add:

```yaml
      - name: Check API docs updated if API source changed
        run: |
          # Only run on PRs (not push to main)
          if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
            API_CHANGED=$(git diff --name-only origin/main HEAD -- src/http.ts src/ipc.ts src/server.ts 2>/dev/null | wc -l)
            if [ "$API_CHANGED" -gt "0" ]; then
              DOCS_CHANGED=$(git diff --name-only origin/main HEAD -- docs/api.md | wc -l)
              if [ "$DOCS_CHANGED" -eq "0" ]; then
                echo "ERROR: API source changed (src/http.ts, src/ipc.ts, or src/server.ts) but docs/api.md was not updated."
                echo "Please update docs/api.md to reflect the API changes."
                exit 1
              fi
            fi
          fi
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: fail PRs that change API source without updating docs/api.md

— claude-sonnet-4-6"
```

---

## Task 4: Update CHANGELOG.md

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read CHANGELOG.md**

- [ ] **Step 2: Add v0.4.0 section**

Add an entry for the sprint series work:

```markdown
## [Unreleased]

### Added
- `operad doctor` command — diagnoses install issues with colored checklist
- `operad init` command — generates minimal config on fresh install
- `/help` documentation page in dashboard (core features + agentic layer docs)
- Session lifecycle integration tests (`SessionController`)
- End-to-end CI test (boots daemon, exercises all API endpoints)
- Full REST/SSE/IPC API documentation (`docs/api.md`)
- Full config reference (`docs/config.md`)

### Changed
- **BREAKING DEFAULT**: All agentic features now default to opt-in (disabled on fresh installs)
- `operad boot` now validates config before starting and prints actionable errors
- README restructured: core daemon leads, agentic is opt-in advanced section
- daemon.ts refactored into focused modules (agent-engine, tool-engine, persistence, server)

### Fixed
- 139 silent catch blocks in daemon.ts now log structured errors
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): document sprint series changes for v0.4.0

— claude-sonnet-4-6"
```
