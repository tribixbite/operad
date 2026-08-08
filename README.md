# operad

Cross-platform tmux session orchestrator for Claude Code sessions. Designed for developers running multiple Claude Code projects simultaneously.

**What it does:**
- Boot and manage tmux sessions with dependency ordering
- Health checks, auto-restart, and session lifecycle management
- Web dashboard: session status, memory, logs, telemetry, settings
- Prompt history: search, star, and replay Claude prompts across all projects
- Battery and memory awareness on Android/Termux
- Token quota tracking with velocity trends and per-session attribution
- Workflow DAG engine: TOML-defined task pipelines with conditional edges (`success` / `error` / `always`), SQLite-persisted run history, REST execution
- Plugin/skill marketplace: multi-source aggregator for tools / agents / workflows / MCP servers / SKILL.md bundles from GitHub plugin repos, the official MCP registry, and a curated index — with per-tool autonomy caps and a 5-store transactional install. Enabled by default; set `enabled = false` under `[skills]` in `operad.toml` to hide it. See [`docs/skills.md`](docs/skills.md)
- Environment migration: export skills, commands, subagents, plans and memories **with their file contents** — plus plugin marketplace sources — as one JSON bundle, and import it on another machine. Settings → Migrate environment, or `GET /api/customization/export` + `POST /api/customization/import`. See [`docs/api.md`](docs/api.md#customization)

## Quick Start

```sh
npm install -g operadic
```

```sh
mkdir -p ~/.config/operad

# Create config with your projects
cat > ~/.config/operad/operad.toml << 'EOF'
[operad]
dashboard_port = 18970

[[session]]
name = "my-project"
type = "claude"
path = "$HOME/git/my-project"
EOF

operad boot
# Dashboard: http://localhost:18970
```

Run `operad doctor` to diagnose any setup issues.

## Config

Default location: `~/.config/operad/operad.toml` (TOML with `$ENV_VAR` expansion)

```toml
[operad]
dashboard_port = 18970
health_interval_s = 120
wake_lock_policy = "active_sessions"

[[session]]
name = "my-project"
type = "claude"
path = "$HOME/git/my-project"
auto_go = true

[[session]]
name = "spike"
type = "opencode"          # OpenCode (https://opencode.ai)
path = "$HOME/git/spike"

[[session]]
name = "research"
type = "codex"             # OpenAI Codex CLI
path = "$HOME/git/research"

[[session]]
name = "api-server"
type = "service"
command = "bun run dev"
path = "$HOME/git/api"
depends_on = ["my-project"]

[session.health]
check = "http"
url = "http://localhost:3000/health"
```

Session types:

| Type | Behaviour |
|---|---|
| `claude` | Claude Code with readiness detection. Supports UUID resume via `session_id` (set automatically when opening from Recent Projects). |
| `opencode` | [OpenCode](https://opencode.ai) TUI — project-cwd-scoped, resumes implicitly. |
| `codex` | [OpenAI Codex CLI](https://developers.openai.com/codex/cli) — same shape as OpenCode; first run pauses on the browser auth flow. |
| `daemon` | Long-running background command — no readiness contract, marked running on tmux create. |
| `service` | Headless service — same as daemon but conventionally for things with health checks. |

Adding a new agent runtime is a five-step adapter pattern — see `src/runtimes/runtime.ts` for the interface and the existing claude/opencode/codex adapters for examples.

### Runtime adapters

Coding-agent runtimes share the same lifecycle (tmux create → wait for ready prompt → optionally send "go") but differ in startup command, resume semantics, and what an idle prompt looks like. The `SessionRuntime` interface captures those differences:

```ts
// src/runtimes/runtime.ts
export interface SessionRuntime {
  readonly id: SessionType;            // matches TOML `type = "..."`
  readonly label: string;              // human-readable
  startupCommand(c: SessionConfig): string | null;
  readonly readyPatterns: readonly RegExp[];
  readonly readyTimeoutMs?: number;    // override default 60s
  readonly readyPollIntervalMs?: number;
}
```

Existing adapters (`src/runtimes/{claude,opencode,codex}.ts`) live next to it. To add a fourth:

1. Add the id to `SessionType` in `src/types.ts`.
2. Add it to `VALID_SESSION_TYPES` in `src/config.ts`.
3. Implement the adapter under `src/runtimes/<id>.ts`.
4. Register it in `src/runtimes/index.ts`'s `REGISTRY`.
5. (Optional) extend `checkAgentRuntimes()` in `src/doctor.ts` so first-run users get an install hint when the binary's missing.

Operad's session lifecycle code dispatches via `getRuntime(type)` — there are no `case "claude":` branches left in `session.ts` or `daemon.ts`. Test the adapter contract via `src/__tests__/runtimes.test.ts`.

**Gemini CLI is not supported.** Its stateless one-shot `gemini "<prompt>"` invocation model doesn't fit operad's persistent-session orchestration; supporting it would require a separate "agent runner" subsystem rather than a SessionRuntime adapter.

**`history` readers are runtime-specific.** `src/claude-session.ts` parses Claude's JSONL history; OpenCode and Codex store their conversation state differently (project-scoped, not UUID-keyed) and don't yet have parallel readers — opening them via Recent Projects works, but project-history search is Claude-only for now.

### Runtime overrides

The dashboard's **Settings → SDK Streaming** form persists to a JSON overlay at `<state_dir>/config-overrides.json` (typically `~/.local/share/operad/`). The TOML stays the structural source of truth; the overlay holds preferences the UI is allowed to mutate (SDK effort/thinking/budget/model, quota thresholds). New values take effect on the next daemon restart — `tmx upgrade` or a watchdog cycle.

## CLI Commands

| Command | Description |
|---------|-------------|
| `operad boot` | Start daemon + all sessions in dependency order |
| `operad status` | Session table with memory, battery, uptime |
| `operad health` | Run health sweep |
| `operad start <name>` | Start a specific session |
| `operad stop <name>` | Stop a specific session |
| `operad restart <name>` | Restart a specific session |
| `operad go <name>` | Send "go" to a Claude session |
| `operad open <path>` | Register and start a session for `<path>`. Reuses an existing entry if one is already registered for the same path; pass `--new` to deliberately spawn a parallel suffixed instance. |
| `operad close <name>` | Stop and unregister a dynamic session |
| `operad dedupe [--dry-run]` | Collapse duplicate registry entries that share a path. Live tmux sessions are never torn down — only stale duplicates are removed. |
| `operad recent` | Recent Claude projects from history |
| `operad tabs` | Open terminal tabs for running sessions |
| `operad memory` | System memory + per-session RSS |
| `operad suspend <name>` | SIGSTOP a session |
| `operad resume <name>` | SIGCONT a session |
| `operad watch` | Tail the daemon log for state-machine transitions, health checks, and IPC events. |
| `operad logs` | Stream daemon logs |
| `operad doctor` | Diagnose install issues |
| `operad install-tmux` | Install tmux + recommended plugins for first-time setup. |
| `operad upgrade` | Rebuild from a git checkout and hot-swap the daemon. (npm/bun installs: `bun add -g operadic@latest` or `npm i -g operadic@latest`.) |
| `operad shutdown` | Stop daemon (sessions persist in tmux) |

## Dashboard

The web dashboard at `http://localhost:18970` provides:

- **Overview** — session status, system memory, budget gauges, prompt history
- **Memory** — per-session RSS tracking, AI memory management (SQLite + FTS5), process manager
- **Logs** — real-time daemon logs with level filtering
- **Telemetry** — captured telemetry sink with SDK breakdown
- **Settings** — MCP servers, plugins, skills, plans, CLAUDE.md management

## Platforms

| Feature | Android/Termux | Linux | macOS | Windows (experimental) |
|---------|---------------|-------|-------|------------------------|
| Notifications | termux-notification | notify-send | osascript | PowerShell toast |
| Battery | termux-battery-status | /sys/power_supply | pmset | WMI (laptop only) |
| Wake lock | termux-wake-lock | systemd-inhibit | caffeinate | not implemented |
| Process info | /proc | /proc | ps/lsof | tasklist (limited) |
| Terminal tabs | am intents | n/a | Terminal.app | n/a |
| ADB protections | phantom fix + Doze | n/a | n/a | n/a |

Windows requires tmux via MSYS2 (`pacman -S tmux`) or WSL. See [docs/windows.md](docs/windows.md) for setup.

## Crash Resilience

On Android, the daemon, watchdog, and tmux server all run as independent processes (PPid: 1). When Android kills the Termux app, only the terminal UI dies — all sessions continue running. The watchdog auto-restarts the daemon, which re-adopts existing sessions.

Defense layers: wake lock (never released), phantom process killer fix, Doze whitelist, process detach, IPC socket self-healing, watchdog loop, crash-safe trace log.

---

## Advanced: Autonomous Layer

> **Opt-in. Disabled by default.** These features run AI agents autonomously.
> Enable via dashboard Settings → Switchboard after reading the [in-app docs](http://localhost:18970/help#agentic-overview).

operad includes an agentic layer for self-improving orchestration:

- **OODA loop** — periodic Observe→Orient→Decide→Act cycles via master-controller agent
- **Agents** — optimizer, preference-learner, ideator, master-controller
- **Scheduling engine** — cron/interval triggers for agents and commands
- **Memory system** — decay, consolidation, cross-pollination of agent learnings
- **Agent specialization** — domain expertise tracking with roundtable protocol for multi-agent collaboration
- **Tool registry** — extensible tool system with autonomy levels, trust calibration, and persistent leases
- **Tuning** — feed notes, personality traits, and chat logs to shape autonomous decisions

See in-app `/help` for full documentation.

## Development

```sh
bun install
bun run build       # bundle to dist/tmx.js
bun run typecheck   # TypeScript check
bun test            # unit tests
cd dashboard && bun run build  # build dashboard
```

## Docs

[operad.stream](https://operad.stream)

## License

MIT
