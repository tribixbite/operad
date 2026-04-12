# operad Debugging & Operations

## Triggers
- User reports operad/tmx not starting, crashing, or misbehaving
- User asks about daemon status, logs, or session issues
- Debugging platform-specific problems

## Quick Diagnostics

```sh
tmx status           # Session table with states, memory, uptime
tmx health           # Run health sweep across all sessions
tmx memory           # System memory + per-session RSS
tmux list-sessions   # Raw tmux state (truth source)
```

## Logs

### Trace log (crash-safe, survives SIGKILL)
```sh
tail -50 ~/.local/share/tmx/logs/trace.log
```
Last line shows what daemon was doing before death. Uses `appendFileSync` (no open FD).

### Daemon stderr
```sh
cat ~/.local/share/tmx/logs/daemon-stderr.log
```

### Dashboard real-time logs
Open http://localhost:18970 → Logs tab (filterable by level and session).

## Common Issues

### Daemon won't start / duplicate instances
- Check: `cat $PREFIX/tmp/tmx.sock` exists? → `tmx shutdown` first
- Check: `tmux list-sessions` for orphaned sessions
- NEVER delete the socket manually — `isRunning()` handles stale detection
- Timeout returns true (busy), only ECONNREFUSED/ENOENT indicate dead

### Sessions stuck in stopping/starting
- After daemon restart, stale transient states block boot
- `adoptExistingSessions()` should recover these — check trace log
- Force: `tmx stop <name>` then `tmx start <name>`

### Android process kills
- Verify wake lock: `dumpsys power | grep -i wake`
- Check phantom fix: `settings get global settings_enable_monitor_phantom_procs` → should be empty or error
- Watchdog running: `ps aux | grep watchdog`
- Daemon stderr for last crash clues

### LD_PRELOAD issues (Android/bun)
- Symptoms: `am` commands silently fail, notifications don't fire
- Check: `echo $LD_PRELOAD` in tmux — should contain `libtermux-exec.so`
- Fix: `tmux set-environment -g LD_PRELOAD $PREFIX/lib/libtermux-exec.so`

### Dashboard not loading
- Check port: `ss -tlnp | grep 18970` or `curl http://localhost:18970/api/state`
- SSE exhaustion: close all browser tabs, restart browser
- Port race after restart: http.ts retries bind 3x with 2s delay

### Platform detection wrong
```sh
node -e "console.log(process.env.TERMUX_VERSION, process.platform)"
```
- TERMUX_VERSION set → android
- process.platform === "darwin" → darwin
- else → linux

## IPC Socket
- Android: `$PREFIX/tmp/tmx.sock`
- Linux: `/tmp/operad.sock` or `$XDG_RUNTIME_DIR/operad.sock`
- Protocol: newline-delimited JSON over Unix socket
- Self-heals: daemon `ensureSocket()` recreates during health sweeps

## State Files
- Config: `~/.config/operad/operad.toml`
- State: `~/.local/share/tmx/state.json`
- Registry: `~/.local/share/tmx/registry.json`
- Trace: `~/.local/share/tmx/logs/trace.log`
