# Health Check Configuration

## Triggers
- User asks about health checks, monitoring, or session health
- User says `/health-check`
- Debugging degraded/failed sessions
- Working on `src/health.ts` or health-related config

## Health Check Types

| Type | What It Checks | Required Config |
|------|---------------|-----------------|
| `tmux_alive` | tmux session exists (`tmux has-session`) | none |
| `http` | HTTP endpoint returns 2xx | `url` |
| `process` | Process matching pattern is running (`pgrep -f`) | `process_pattern` |
| `custom` | Shell command exits 0 | `command` |
| `pid_alive` | Process PID exists in `/proc` | (internal, not user-configurable) |

## TOML Configuration

### Per-session health check
```toml
[[session]]
name = "my-api"
type = "daemon"
command = "node server.js"

[session.health]
check = "http"
url = "http://localhost:3000/health"
unhealthy_threshold = 3          # consecutive failures before degraded
interval_s = 30                  # override global sweep interval
```

### Global defaults by session type
```toml
[health_defaults]
# Applied to all sessions of this type unless overridden
claude_check = "tmux_alive"
daemon_check = "tmux_alive"
service_check = "process"
```

### Global sweep interval
```toml
[operad]
health_interval_s = 60           # seconds between health sweeps (default: 60)
```

## Examples for Each Check Type

### tmux_alive (default for claude/daemon types)
```toml
[session.health]
check = "tmux_alive"
unhealthy_threshold = 3
```
Simply verifies the tmux session named after the session still exists.

### http
```toml
[session.health]
check = "http"
url = "http://localhost:8080/healthz"
unhealthy_threshold = 5
```
Runs `curl -s <url>` and expects HTTP 2xx. Good for web servers, APIs.

### process
```toml
[session.health]
check = "process"
process_pattern = "my-daemon-binary"
unhealthy_threshold = 3
```
Runs `pgrep -f <pattern>`. Good for services that don't expose HTTP.

### custom
```toml
[session.health]
check = "custom"
command = "redis-cli ping | grep -q PONG"
unhealthy_threshold = 2
```
Runs arbitrary shell command. Exit 0 = healthy, non-zero = unhealthy.

## State Machine Transitions

```
running ──(check fails)──► degraded ──(threshold exceeded)──► failed
   ▲                          │
   └──(check passes)──────────┘
```

- **running → degraded**: First health check failure increments `consecutive_failures`
- **degraded → running**: Health check passes, resets `consecutive_failures` to 0
- **degraded → failed**: `consecutive_failures >= unhealthy_threshold` AND `restart_count >= max_restarts`
- **failed**: Terminal state — session won't auto-restart. Manual `tmx start <name>` required.

## Restart Behavior

```toml
[[session]]
name = "my-service"
max_restarts = 5                 # max auto-restarts before giving up (default: 3)
restart_backoff_s = 10           # delay between restarts (default: 5)
```

When a session enters `degraded` and exceeds `unhealthy_threshold`:
1. If `restart_count < max_restarts`: auto-restart with backoff delay
2. If `restart_count >= max_restarts`: transition to `failed`

## Bare Session Health

Sessions with `bare = true` (e.g., termux-x11) use PID adoption:
- `findBareServicePid(pattern)` discovers reparented processes
- Health sweep re-scans for adopted PIDs during `rescanBareClaudeSessions()`
- Known service patterns: `termux-x11` → `/com\.termux\.x11\.Loader/`, `playwright` → `/playwright.*mcp|mcp.*playwright/`

## CLI Commands

```bash
tmx health              # Run health sweep across all sessions, print results
tmx status              # Session table includes health state + consecutive failures
```

## Dashboard

Session cards on the Overview page show health status badges:
- Green dot = running (healthy)
- Yellow dot = degraded (failing checks)
- Red dot = failed (exceeded thresholds)
- Gray dot = stopped

## Key Source Files

| File | Purpose |
|------|---------|
| `src/health.ts` | `checkSessionHealth()`, `runHealthSweep()`, check implementations |
| `src/types.ts` | `HealthCheckConfig` interface, `SessionStatus` state machine |
| `src/config.ts` | TOML parsing for `[session.health]` and `[health_defaults]` |
| `src/daemon.ts` | Sweep scheduling, restart logic, bare PID adoption |
| `src/session.ts` | `findBareServicePid()`, `sessionExists()` |

## Troubleshooting

### Session stuck in degraded
```bash
tmx health                       # See which check is failing
tmx stop <name> && tmx start <name>  # Manual restart resets counters
```

### Custom check debugging
```bash
# Test the command manually
sh -c 'your-custom-command-here'
echo $?                          # 0 = would pass, non-zero = would fail
```

### HTTP check timing out
The HTTP check uses a 5s timeout. If your service is slow to respond:
- Increase `unhealthy_threshold` to tolerate occasional timeouts
- Or use `process` check instead if the process being alive is sufficient
