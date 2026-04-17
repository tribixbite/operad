# operad

Cross-platform tmux session orchestrator for Claude Code sessions. Designed for developers running multiple Claude Code projects simultaneously.

**What it does:**
- Boot and manage tmux sessions with dependency ordering
- Health checks, auto-restart, and session lifecycle management
- Web dashboard: session status, memory, logs, telemetry, settings
- Prompt history: search, star, and replay Claude prompts across all projects
- Battery and memory awareness on Android/Termux
- Token quota tracking with velocity trends and per-session attribution

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
name = "api-server"
type = "service"
command = "bun run dev"
path = "$HOME/git/api"
depends_on = ["my-project"]

[session.health]
check = "http"
url = "http://localhost:3000/health"
```

Session types: `claude` (Claude Code with readiness detection), `daemon` (long-running command), `service` (headless).

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
| `operad open <path>` | Register and start a dynamic session |
| `operad close <name>` | Stop and unregister a dynamic session |
| `operad recent` | Recent Claude projects from history |
| `operad tabs` | Open terminal tabs for running sessions |
| `operad memory` | System memory + per-session RSS |
| `operad suspend <name>` | SIGSTOP a session |
| `operad resume <name>` | SIGCONT a session |
| `operad logs` | Stream daemon logs |
| `operad doctor` | Diagnose install issues |
| `operad upgrade` | Rebuild and hot-swap daemon |
| `operad shutdown` | Stop daemon (sessions persist in tmux) |

## Dashboard

The web dashboard at `http://localhost:18970` provides:

- **Overview** — session status, system memory, budget gauges, prompt history
- **Memory** — per-session RSS tracking, AI memory management (SQLite + FTS5), process manager
- **Logs** — real-time daemon logs with level filtering
- **Telemetry** — captured telemetry sink with SDK breakdown
- **Settings** — MCP servers, plugins, skills, plans, CLAUDE.md management

## Platforms

| Feature | Android/Termux | Linux | macOS |
|---------|---------------|-------|-------|
| Notifications | termux-notification | notify-send | osascript |
| Battery | termux-battery-status | /sys/power_supply | pmset |
| Wake lock | termux-wake-lock | systemd-inhibit | caffeinate |
| Process info | /proc | /proc | ps/lsof |
| Terminal tabs | am intents | n/a | Terminal.app |
| ADB protections | phantom fix + Doze | n/a | n/a |

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
