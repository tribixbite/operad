# operad

Cross-platform orchestrator for managing Claude Code sessions via tmux. Designed for developers running multiple Claude Code projects simultaneously.

## What it does

- **Web dashboard** for managing all your Claude Code sessions, skills, memories, and prompt history across every project — searchable, with starring/saving
- **Auto-boot saved projects** — all your active projects start automatically on boot, dependency-ordered with health monitoring
- **Full prompt history** across all projects with search and the ability to star/save important conversations
- **Session lifecycle management** — health checks, auto-restart on failure, memory pressure response, battery awareness
- **Real-time monitoring** — system memory, per-session RSS, battery, process budget — all via SSE-powered dashboard

Supports **Android/Termux**, **Linux**, and **macOS**.

## Install

```sh
npm i -g operadic
```

## Quick start

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

# Boot everything
operad boot

# Open dashboard
open http://localhost:18970
```

## Configuration

Default: `~/.config/operad/operad.toml` (TOML with `$ENV_VAR` expansion)

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

## CLI

| Command | Description |
|---|---|
| `operad boot` | Start daemon + boot all sessions in dependency order |
| `operad status` | Session table with memory, battery, uptime |
| `operad health` | Run health sweep |
| `operad go <name>` | Send "go" to a Claude session |
| `operad start/stop/restart <name>` | Control individual sessions |
| `operad open <path>` | Register and start a dynamic session |
| `operad close <name>` | Stop and unregister a dynamic session |
| `operad recent` | Recent Claude projects from history |
| `operad tabs` | Open terminal tabs for running sessions |
| `operad memory` | System memory + per-session RSS |
| `operad suspend/resume <name>` | SIGSTOP/SIGCONT a session |
| `operad shutdown` | Stop daemon (sessions persist in tmux) |

## Dashboard

Web dashboard on port 18970 with real-time SSE updates.

**Overview** — session table with start/stop/restart controls, memory/battery/ADB gauges, recent projects with search
**Memory** — system memory breakdown, per-session RSS, process manager
**Logs** — real-time structured log tail, filterable by level and session
**Settings** — skills, memories, and configuration across all projects
**Telemetry** — prompt history with search, starring, and token usage tracking

## Platform support

| Feature | Android/Termux | Linux | macOS |
|---|---|---|---|
| Notifications | termux-notification | notify-send | osascript |
| Battery | termux-battery-status | /sys/power_supply | pmset |
| Wake lock | termux-wake-lock | systemd-inhibit | caffeinate |
| Process info | /proc | /proc | ps/lsof |
| Terminal tabs | am intents | n/a | Terminal.app |
| ADB protections | phantom fix + Doze | n/a | n/a |

## Crash resilience

On Android, the daemon, watchdog, and tmux server all run as independent processes (PPid: 1). When Android kills the Termux app, only the terminal UI dies — all sessions continue running. The watchdog auto-restarts the daemon, which re-adopts existing sessions.

Defense layers: wake lock (never released), phantom process killer fix, Doze whitelist, process detach, IPC socket self-healing, watchdog loop, crash-safe trace log.

## Docs

[operad.stream](https://operad.stream)

## License

MIT
