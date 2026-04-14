# Operad/TMX -- Orchestrator Quick Reference

Concise operational reference for the tmx orchestrator. For build/deploy see `operad-build-deploy.md`, for debugging see `operad-debugging.md`.

## Commands

### Core

```bash
tmx boot                    # Start daemon + all configured sessions (dependency-ordered)
tmx shutdown                # Detach daemon, leave tmux sessions running for next boot to adopt
tmx shutdown --kill         # Stop all sessions AND kill daemon
tmx status                  # Session table: states, memory, uptime
tmx health                  # Run health sweep across all sessions
tmx memory                  # System memory + per-session RSS breakdown
tmx config                  # Print resolved config (toml + registry merged)
```

### Session Management

```bash
tmx go <name>               # Send Enter to a Claude session waiting for input
tmx tabs                    # Create Termux tabs for all running sessions
tmx open <path>             # Add and start a new Claude session at runtime
tmx close <name>            # Stop + remove a registry-only session
tmx stop <name>             # Stop a single session
tmx start <name>            # Start a single stopped session
```

### Suspension (SIGSTOP/SIGCONT)

```bash
tmx suspend <name>          # SIGSTOP all processes in session's pane
tmx resume <name>           # SIGCONT all processes in session's pane
tmx suspend-others <name>   # Suspend all sessions except <name>
tmx suspend-all             # Suspend every session
tmx resume-all              # Resume every session
```

Suspension sends signals to process groups (`kill -STOP -<pgid>`) obtained from `tmux list-panes -F '#{pane_pid}'`. Always resume before stopping -- SIGSTOP'd processes cannot respond to shutdown signals.

### History & Discovery

```bash
tmx recent                  # Parse ~/.claude/history.jsonl for recent projects
tmx upgrade                 # Rebuild bundle, stop daemon, watchdog auto-restarts
tmx migrate                 # Convert legacy repos.conf to tmx.toml
```

## Paths

| Resource | Path |
|---|---|
| Config | `~/.config/operad/operad.toml` (falls back to `~/.config/tmx/tmx.toml`) |
| State | `~/.local/share/tmx/state.json` |
| Registry | `~/.local/share/tmx/registry.json` (dynamically opened sessions) |
| Trace log | `~/.local/share/tmx/logs/trace.log` (crash-safe, appendFileSync) |
| Daemon stderr | `~/.local/share/tmx/logs/daemon-stderr.log` |
| IPC socket | `$PREFIX/tmp/tmx.sock` (Android) / `/tmp/operad.sock` (Linux) |
| Bundle | `~/git/operad/dist/tmx.js` (~361KB CJS) |
| Symlink | `~/.local/bin/tmx` -> `~/git/operad/dist/tmx.js` |

## Ports

| Port | Service |
|---|---|
| 18970 | Dashboard (HTTP + SSE + REST API) |
| 18971 | Telemetry sink (receives redirected Edge telemetry) |

## Session Types

| Type | Behavior |
|---|---|
| `claude` | Starts Claude Code, polls for readiness (60s timeout, question mark pattern), sends "go" |
| `daemon` | Custom command (arbitrary process supervised by tmx) |
| `service` | Headless process, no terminal interaction expected |

## Session State Machine

```
pending -> waiting -> starting -> running <-> degraded -> failed
                                    |                       |
                                    v                       v
                                stopping -> stopped      stopped
```

- `pending`: configured but not yet started
- `waiting`: blocked on dependency session
- `starting`: tmux session created, process launching
- `running`: health checks passing
- `degraded`: health checks failing, within retry threshold
- `failed`: exceeded retry threshold, not auto-restarting
- `stopping`: graceful shutdown in progress
- `stopped`: cleanly terminated

Sessions stuck in `stopping`/`starting` after daemon restart are recovered by `adoptExistingSessions()` -- transitions to `stopped` if the tmux session is gone.

## Build

```bash
cd ~/git/operad
bun install
bun run build               # Runs: node build.cjs (NOT bun build.cjs)
bun run typecheck           # Zero errors required before commit
```

**Critical:** `bun run build` routes through `node build.cjs` as a shell command. Never call `bun build.cjs` directly -- bun's platform detection rejects the android-arm64 esbuild binary.

### Dashboard

```bash
cd ~/git/operad/dashboard
bun install
node scripts/fix-android-binaries.mjs   # Android only (lightningcss, tailwind oxide, esbuild)
bun run dev                              # Dev server with Vite proxy to daemon :18970
bun run build                            # Production build -> dashboard/dist/
```

## Watchdog

`orchestrator/watchdog.sh` -- bash loop that restarts the daemon after OOM kill.

- Checks `daemon_alive()` before spawning to avoid duplicates
- Waits for tmux sessions before attaching
- Does NOT delete the socket (let `isRunning()` handle stale detection)
- Socket deletion causes cascade: `isRunning()` returns false -> spawns duplicate -> load spike

## IPC Protocol

Newline-delimited JSON over Unix socket at `$PREFIX/tmp/tmx.sock`.

```bash
# Quick connectivity test
echo '{"command":"status"}' | socat - UNIX-CONNECT:$PREFIX/tmp/tmx.sock
```

Socket self-heals: daemon's `ensureSocket()` recreates during health sweeps. CLI hits `POST /api/fix-socket` for instant recovery when socket is missing but HTTP is alive.

## Critical Rules

### CLAUDECODE Env Var Stripping
Daemon must strip `CLAUDECODE`, `CLAUDE_CODE_*`, `ENABLE_CLAUDE_CODE_*`, and `CLAUDE_TMPDIR` from env before spawning tmux sessions. If present, child Claude Code processes detect a parent session and refuse to launch ("cannot launch inside another CC session").

### LD_PRELOAD Injection
Bun's glibc runner strips `LD_PRELOAD` from child processes. The `libtermux-exec.so` library intercepts `execve` to rewrite `/usr/bin/env` paths. Without it: `am` commands silently no-op, Claude shebangs fail, Termux tools break.

Fix points in the codebase:
- `cleanEnv()` in session.ts re-injects LD_PRELOAD
- `ensureTmuxLdPreload()` sets `tmux set-environment -g`
- `spawnBareProcess()` injects for bare sessions
- `amEnv()` injects for am/intent commands

### Termux Tab Scripts
Scripts launched via `am startservice` + TermuxService need `$PREFIX/bin/bash` shebang (not `#!/usr/bin/env bash`) because LD_PRELOAD is not available in that launch context.

### Wake Lock
Acquire-only, NEVER release. `termux-wake-unlock` causes Android to kill background processes. The OS-level wake lock persists after SIGKILL -- this is desired behavior.

### IPC Timeout Semantics
A 3-second IPC timeout must return `true` (daemon is busy), NOT `false` (daemon is dead). Only `ECONNREFUSED` or `ENOENT` should delete the socket and indicate dead daemon. Previous incorrect behavior (timeout -> delete socket) caused cascade spawning of dozens of daemon instances.

## Common Troubleshooting

### Daemon won't start
```bash
tmux list-sessions          # Check for orphaned tmux sessions
ls $PREFIX/tmp/tmx.sock     # Socket exists?
tmx shutdown                # Clean shutdown first, then retry boot
```
Never delete the socket manually.

### Duplicate daemons running
```bash
# Check for multiple daemon processes
ps aux | grep tmx
# Kill all, let watchdog restart one
pkill -f 'tmx.js'
```
Root cause is usually socket deletion causing `isRunning()` to return false.

### Sessions stuck in starting/stopping
After daemon crash/restart, stale transient states block boot. `adoptExistingSessions()` should recover these automatically. If not:
```bash
tmx stop <stuck-session>
tmx start <stuck-session>
```

### Socket missing but daemon alive
```bash
curl http://localhost:18970/api/fix-socket
```
Triggers immediate socket recreation via the HTTP API.

### Dashboard not loading
```bash
ss -tlnp | grep 18970      # Port bound?
curl http://localhost:18970/api/state   # API responding?
```
Port may be in TIME_WAIT after restart (http.ts retries bind 3x with 2s delay). Close all browser tabs if SSE connections are exhausted (browser 6-per-origin limit).
