# State & Registry Operations

## Triggers
- User asks about session state, state file, or registry
- User says `/state-registry`
- Debugging stuck sessions, stale state, or registry entries
- Working on `src/state.ts`, `src/registry.ts`, or state-related daemon code

## Two Persistence Systems

operad has two complementary persistence files:

| File | Purpose | Content |
|------|---------|---------|
| `~/.local/share/tmx/state.json` | Runtime state (daemon lifecycle, session statuses) | Daemon start time, boot status, per-session state machine |
| `~/.local/share/tmx/registry.json` | Dynamic session registry (sessions added via `tmx open`) | Session name, path, priority, session_id |

Config-defined sessions (`[[session]]` in operad.toml) are NOT in the registry — they come from TOML. Both sources merge on boot.

## State File (`state.json`)

### TmxState structure
```json
{
  "daemon_start": "2026-04-14T10:00:00.000Z",
  "boot_complete": true,
  "adb_fixed": false,
  "sessions": {
    "torch": {
      "name": "torch",
      "status": "running",
      "uptime_start": "2026-04-14T10:01:23.000Z",
      "restart_count": 0,
      "last_error": null,
      "last_health_check": "2026-04-14T12:30:00.000Z",
      "consecutive_failures": 0,
      "tmux_pid": 12345,
      "rss_mb": 280,
      "activity": { "cpu_pct": 2.1, "idle_s": 300 },
      "suspended": false,
      "auto_suspended": false,
      "last_output": "Waiting for input...",
      "claude_status": "idle"
    }
  }
}
```

### SessionState fields

| Field | Type | Persisted | Description |
|-------|------|-----------|-------------|
| `name` | string | yes | Session identifier |
| `status` | SessionStatus | yes | Current state machine position |
| `uptime_start` | ISO string | yes | When session entered `running` (null if not running) |
| `restart_count` | number | yes | Auto-restart count (resets on manual start) |
| `last_error` | string | yes | Most recent error message |
| `last_health_check` | ISO string | yes | Timestamp of last health sweep |
| `consecutive_failures` | number | yes | Sequential failed health checks |
| `tmux_pid` | number | yes | tmux pane PID |
| `rss_mb` | number | **no** | RSS memory (transient, updated every poll) |
| `activity` | object | **no** | CPU % and idle seconds (transient) |
| `suspended` | boolean | yes | SIGSTOP'd via `tmx suspend` |
| `auto_suspended` | boolean | yes | Auto-suspended by memory pressure |
| `last_output` | string | **no** | Last tmux pane output line (transient) |
| `claude_status` | string | **no** | Claude readiness state (transient) |

### State machine transitions

```
pending → waiting → starting → running ⇄ degraded → failed
                                  │                     │
                                  ▼                     ▼
                              stopping → stopped     stopped
```

Valid transitions enforced by `VALID_TRANSITIONS` map in `types.ts`. Invalid transitions are logged and rejected.

### Key StateManager methods

```typescript
// State transitions
transition(name, to, error?)     // Validates transition, updates metadata, persists
forceStatus(name, status)        // Skip validation (adoption/reconciliation only)

// Session lifecycle
initFromConfig(sessions)         // Initialize from TOML, prune stale entries
removeSession(name)              // Delete session state entirely

// Health tracking
recordHealthCheck(name, healthy, message?)  // Update consecutive_failures + last_health_check
setTmuxPid(name, pid)           // Set after tmux session creation
setSuspended(name, suspended, auto?)  // Mark SIGSTOP/SIGCONT state

// Transient metrics (NOT persisted — updated every poll cycle)
updateSessionMetrics(name, rss_mb, activity, lastOutput?, claudeStatus?)
updateSystemMemory(memory)
updateBattery(battery)

// Daemon lifecycle
setBootComplete(complete)
setAdbFixed(fixed)
resetDaemonStart()
flush()                          // Force write to disk
```

### Atomic persistence
State writes use tmp-file + rename pattern: `writeFileSync(path.tmp)` → `renameSync(path.tmp, path)`. This prevents corruption on crash/OOM.

## Registry (`registry.json`)

### RegistryEntry structure
```json
{
  "version": 1,
  "sessions": [
    {
      "name": "my-project",
      "path": "/home/user/code/my-project",
      "opened_at": "2026-04-10T08:00:00.000Z",
      "last_active": "2026-04-14T12:00:00.000Z",
      "priority": 50,
      "auto_go": true,
      "session_id": "abc-123-def"
    }
  ]
}
```

### Key Registry methods

```typescript
// Lookup
entries()                   // All entries
find(name)                  // By name
findByPath(path)            // First entry matching path
findAllByPath(path)         // All entries for path (multi-instance)
findBySessionId(sessionId)  // By Claude session UUID

// Mutations
add(entry)                  // Add new entry (null if name conflict)
remove(name)                // Remove by name
updateActivity(name)        // Touch last_active timestamp
prune(maxAgeDays = 30)      // Remove entries inactive > N days

// Conversion
toSessionConfigs()          // Convert to SessionConfig[] for merge with TOML config
flush()                     // Force save
```

### Name derivation
`deriveName(path)` converts paths to valid session names:
- Takes basename, lowercases, replaces non-`[a-z0-9-]` with `-`, strips leading/trailing dashes
- `nextSuffix(baseName, existingNames)` appends `-2`, `-3` etc. for duplicates

### Multi-instance support
Multiple registry entries can share the same `path` with different `session_id` values. This enables running multiple Claude sessions against the same project (e.g., `torch`, `torch-2`).

## CLI Operations

```bash
tmx open /path/to/project    # Add to registry + start session
tmx close <name>             # Stop session + remove from registry
tmx recent                   # Parse ~/.claude/history.jsonl for recent projects
tmx status                   # Shows state of all sessions (config + registry)
tmx config                   # Shows merged config (TOML + registry)
```

## History Parsing

`parseRecentProjects(historyPath, maxLines)` reads `~/.claude/history.jsonl`:
- Deduplicates by project path (keeps most recent)
- Returns `{ name, path, last_active, session_id }` sorted by recency
- Used by `tmx recent` and the dashboard session picker

`findNamedSessions(historyPath, maxAgeDays)` discovers user-renamed sessions:
- Scans history for recent sessions, then checks each session's JSONL for `custom-title` entries
- Only returns sessions with short titles (< 30 chars, no "(Fork)") — these are intentional names
- Used by dashboard session picker for display names

## Troubleshooting

### Session stuck in starting/stopping
After daemon crash, transient states persist to disk. `adoptExistingSessions()` should fix these on restart. If not:
```bash
# Check if tmux session actually exists
tmux has-session -t <name> 2>/dev/null && echo "alive" || echo "gone"
# Manual recovery
tmx stop <name>
tmx start <name>
```

### Registry entry for deleted project
```bash
tmx close <name>    # Removes from registry + stops session
```
Or manually edit `~/.local/share/tmx/registry.json` and restart daemon.

### State file corruption
If `state.json` is corrupted (JSON parse error), the daemon starts fresh automatically — logged as "Failed to load state, starting fresh". Session entries with invalid shape are individually dropped rather than crashing.

### Duplicate sessions after OOM
The merge logic deduplicates: TOML config sessions take priority, registry entries with matching names are skipped. If you see duplicates, check for name collisions between config and registry.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/state.ts` | `StateManager` class, `newSessionState()`, state transitions, persistence |
| `src/registry.ts` | `Registry` class, history parsing, name derivation |
| `src/types.ts` | `TmxState`, `SessionState`, `SessionStatus`, `VALID_TRANSITIONS` |
| `src/daemon.ts` | `adoptExistingSessions()`, session lifecycle orchestration |
| `src/config.ts` | TOML parsing, config + registry merge |
