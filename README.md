# operad

Cross-platform tmux session orchestrator. Manages multiple sessions with dependency-ordered boot, health checks, auto-restart, memory monitoring, battery management, and a real-time web dashboard.

Supports **Android/Termux**, **Linux**, and **macOS**.

## Install

```sh
npm i -g operadic
```

## Quick start

```sh
mkdir -p ~/.config/operad
# Create operad.toml with your sessions (see operad.toml.example)

operad boot      # Start daemon + all sessions
operad status    # Show session table
operad shutdown  # Stop daemon (sessions persist in tmux)
```

## Configuration

Default: `~/.config/operad/operad.toml` (TOML with `$ENV_VAR` expansion)

```toml
[operad]
dashboard_port = 18970
health_interval_s = 120

[[session]]
name = "my-project"
type = "claude"
path = "$HOME/git/my-project"

[[session]]
name = "api"
type = "service"
command = "bun run dev"
depends_on = ["my-project"]
```

Session types: `claude` (Claude Code), `daemon` (long-running command), `service` (headless).

## CLI

| Command | Description |
|---|---|
| `operad boot` | Start daemon + boot all sessions |
| `operad status` | Session table with memory, battery, uptime |
| `operad health` | Run health sweep |
| `operad go <name>` | Send "go" to a Claude session |
| `operad start/stop/restart <name>` | Control individual sessions |
| `operad open <path>` | Register and start a dynamic session |
| `operad close <name>` | Stop and unregister a dynamic session |
| `operad recent` | Recent Claude projects from history |
| `operad tabs` | Open terminal tabs for running sessions |
| `operad memory` | System memory + per-session RSS |
| `operad suspend/resume <name>` | SIGSTOP/SIGCONT session |
| `operad shutdown` | Stop daemon (sessions persist) |

## Dashboard

Web dashboard on port 18970 with real-time SSE updates. Pages: Overview, Memory, Logs.

## Platform support

| Feature | Android/Termux | Linux | macOS |
|---|---|---|---|
| Notifications | termux-notification | notify-send | osascript |
| Battery | termux-battery-status | /sys/power_supply | pmset |
| Wake lock | termux-wake-lock | systemd-inhibit | caffeinate |
| Process info | /proc | /proc | ps/lsof |
| Terminal tabs | am intents | n/a | Terminal.app |
| ADB protections | phantom fix + Doze | n/a | n/a |

## Docs

[operad.stream](https://operad.stream)

## License

MIT
