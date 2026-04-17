# operad API Reference

> **Stability:** This API is frozen as of v0.3.x. Breaking changes require a major version bump.

## REST API

Base URL: `http://localhost:18970` (port configurable via `dashboard_port` in `operad.toml`)

All requests and responses use `application/json`. CORS headers are set to `*`.
Body size limit: 1 MB. Request body timeout: 10 s.

---

### Sessions

#### `GET /api/status`
Returns status for all sessions (or a single named session).

Query: `?name=<sessionName>` (optional — omit for all sessions).

Response: `{ sessions: SessionState[], daemon_start, boot_complete, adb_fixed, memory, battery, switchboard }`

#### `POST /api/start/:name`
Start a stopped or failed session.

#### `POST /api/stop/:name`
Gracefully stop a running session.

#### `POST /api/restart/:name`
Restart a session (stop + start).

#### `POST /api/go/:name`
Send the literal text `go` to a session's tmux pane (triggers Claude to proceed).

#### `POST /api/send/:name`
Send arbitrary text to a session's tmux pane.

Body: `{ "text": "string" }`

#### `POST /api/suspend/:name`
Freeze a session with SIGSTOP (zero CPU, pages may be swapped).

#### `POST /api/resume/:name`
Unfreeze a SIGSTOP'd session.

#### `POST /api/suspend-others/:name`
Suspend all sessions except `:name`.

#### `POST /api/suspend-all`
Suspend every running session.

#### `POST /api/resume-all`
Resume all suspended sessions.

#### `POST /api/tab/:name`
Open a Termux tab attached to the named session and bring Termux to the foreground (Android only).

#### `GET /api/recent`
Returns the 20 most recently accessed sessions (from the session registry).

#### `POST /api/open/:name`
Open a session from a filesystem path.

Body: `{ "path": "string", "auto_go": bool, "priority": number }` — body is optional; `:name` is the
path or alias used to look up the session.

#### `POST /api/close/:name`
Remove a dynamically opened session from the registry.

#### `POST /api/register`
Scan for git repos under a path and register them as sessions.

Body (optional): `{ "path": "string" }` — defaults to current directory or home.

#### `POST /api/clone`
Clone a git repo and open the resulting session.

Body: `{ "url": "string", "name": "string" (optional) }`

#### `POST /api/create/:name`
Create an empty project directory and register it as a new session.

---

### Scripts

#### `GET /api/scripts/:name`
List available scripts for a session (`.sh` files in root and `scripts/`, plus `package.json` scripts).

#### `POST /api/run-script/:name`
Run a script or ad-hoc command inside a session.

Body: `{ "command": "string" }` or `{ "script": "string", "source": "root|scripts|package.json|saved" }`

#### `POST /api/save-script/:name`
Save an ad-hoc command as a reusable script (stored in `.tmx-scripts/` inside the session path).

Body: `{ "name": "string", "command": "string" }`

#### `POST /api/run-build/:name`
Launch `build-on-termux.sh` from the session's project directory in a new Termux tab.

---

### System

#### `GET /api/status`
See Sessions above — also includes system-level fields (`memory`, `battery`, `switchboard`).

#### `GET /api/memory`
Returns a `SystemMemorySnapshot`: `{ total_mb, available_mb, swap_total_mb, swap_free_mb, pressure, used_pct }`.

#### `GET /api/health`
Returns the last health check result for all sessions.

Response: `HealthResult[]` where each entry has `{ session, healthy, message, duration_ms }`.

#### `GET /api/logs[/:sessionName]`
Return the last 100 structured log entries, optionally filtered to a session.

Response: `LogEntry[]` — each entry has `{ ts, level, msg, session?, ...meta }`.

#### `GET /api/telemetry`
Return recent telemetry sink records (requires `telemetry_sink.enabled = true`).

Query: `?sdk=<sdk>` (filter by SDK), `?limit=100`.

Response: `{ records: TelemetryRecord[], stats: TelemetryStats }`.

#### `GET /api/config`
Returns IPC `config` response — the sanitized (no secrets) parsed config. TBD shape.

---

### Token Quota

#### `GET /api/quota`
Returns current quota status including weekly token usage, velocity, and projected total.

Requires `quota_weekly_tokens` to be configured; otherwise returns zeros.

Response: `{ weekly_pct, weekly_tokens, weekly_limit, velocity, projected_total, top_sessions[] }`

#### `GET /api/tokens-daily`
Per-day token breakdown.

Query: `?days=14` (default 14).

Response: `Array<{ date: string, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens }>`

#### `GET /api/tokens-window`
Tokens consumed in the current rolling window (size = `quota_window_hours`).

Response: Same shape as tokens-daily, single entry for the window.

#### `GET /api/tokens[/:name]`
Token usage from Claude JSONL files.

- `GET /api/tokens` — aggregate over all running Claude sessions.
- `GET /api/tokens/:name` — single session.

Response: `ProjectTokenUsage` or `ProjectTokenUsage[]`.

#### `GET /api/costs`
Aggregate costs (legacy compatibility endpoint, now token-centric).

Variants: `/api/costs/daily?days=30`, `/api/costs/per-session`, `/api/costs/:sessionName`.

#### `GET /api/cost-timeline`
Daily token/cost timeline across all sessions.

Query: `?days=14`.

---

### Conversations & History

#### `GET /api/conversation/:name`
Paginated Claude JSONL conversation viewer.

Query: `?before=<uuid>`, `?limit=20`, `?session_id=<uuid>`.

Response: `ConversationPage` with `entries`, `oldest_uuid`, `has_more`, `session_id`.

#### `GET /api/timeline/:name`
Session event timeline merging trace log and Claude JSONL events.

Query: `?since=<iso>`, `?limit=100`.

#### `GET /api/prompts`
Search/list prompt history extracted from Claude JSONL files.

Query: `?q=`, `?starred=true`, `?project=`, `?limit=50`, `?offset=0`.

#### `GET /api/prompts/projects`
Unique project paths for the prompt filter dropdown.

#### `POST /api/prompts/:id/star`
Star a prompt by its UUID.

#### `DELETE /api/prompts/:id/star`
Unstar a prompt.

#### `GET /api/notifications`
Recent Claude session notifications (tool approvals, permission requests, etc.).

Query: `?limit=50`, `?since=<iso>`.

---

### Customization (CLAUDE.md / memory files)

#### `GET /api/customization[/:projectPath]`
List CLAUDE.md files and memory files for the given project (or all projects).

#### `GET /api/customization-file/:path`
Read a CLAUDE.md or memory file by its filesystem path (URL-encoded).

#### `POST /api/customization-file`
Write a file.

Body: `{ "path": "string", "content": "string" }`

---

### Git & Files

#### `GET /api/git/:name`
Git repo metadata for a session (branch, commit hash, remote, dirty status).

#### `GET /api/files/:name`
File tree for a session's project directory.

Query: `?path=<subdir>` (optional sub-directory).

#### `GET /api/file-content/:name`
Read a file from a session's project directory.

Query: `?path=<relative-path>` (required).

#### `POST /api/branch/:name`
Create a branched (resumed) session from an existing session ID.

Body: `{ "session_id": "string" }`

---

### MCP Servers

#### `GET /api/mcp`
List all MCP servers from `~/.claude/claude_desktop_config.json`.

Response: `{ servers: [{ name, command, args, env, enabled, source }] }`

#### `POST /api/mcp`
Add a new MCP server.

Body: `{ "name": "string", "command": "string", "args": [], "env": {} }`

#### `PUT /api/mcp/:name`
Update an MCP server.

Body: `{ "command"?: string, "args"?: [], "env"?: {} }`

#### `DELETE /api/mcp/:name`
Remove an MCP server.

#### `POST /api/mcp/:name/toggle`
Enable or disable an MCP server.

---

### Switchboard

The switchboard controls which autonomous subsystems are active. Persisted across daemon restarts.

#### `GET /api/switchboard`
Returns current `Switchboard` state: `{ all, sdkBridge, cognitive, oodaAutoTrigger, memoryInjection, mindMeld, agents: Record<string,bool> }`

#### `PUT /api/switchboard`
Partial patch — only specified fields are updated.

Body: any subset of `Switchboard` fields.

---

### Agents (opt-in)

Agentic features require `cognitive = true` or individual agent `enabled = true` on the switchboard.

#### `GET /api/agents`
List all agent definitions (builtin + user-defined).

#### `POST /api/agents`
Create a user-level agent.

Body: `AgentConfig` fields (see `docs/config.md`).

#### `GET /api/agents/:name`
Get a single agent by name.

#### `PUT /api/agents/:name`
Update agent fields.

#### `DELETE /api/agents/:name`
Delete a user-level agent (403 for builtins).

#### `POST /api/agents/:name/toggle`
Enable or disable an agent.

#### `POST /api/agents/:name/run`
Trigger a standalone agent run (non-blocking — result streamed via WebSocket).

Body (optional): `{ "prompt": "string" }`

Returns `202 Accepted`.

#### `GET /api/agents/:name/learnings`
Accumulated knowledge for an agent.

Query: `?category=<string>`, `?limit=20`.

#### `GET /api/agents/:name/personality`
Current personality snapshot.

Sub-routes: `/personality/history?trait=X`, `/personality/drift`.

#### `GET /api/agents/:name/strategy-history`
Strategy version history.

Query: `?limit=20`.

#### `GET /api/agents/runs`
Agent run history.

Query: `?agent=<name>`, `?limit=50`.

#### `GET /api/agents/costs`
Per-agent cost summary.

#### `GET /api/agents/:name/export`
Export agent state bundle (learnings, personality, strategy).

Query: `?template=1` for a template with placeholders.

#### `POST /api/agents/:name/import`
Import a state bundle.

Body: `{ "bundle": AgentStateBundle, "options"?: ImportOptions }`

#### `GET /api/agents/:name/snapshots`
List available daily snapshots.

#### `POST /api/agents/:name/snapshot`
Create a snapshot immediately.

---

### Agent Chat

#### `GET /api/agent-chat/:agentName`
Conversation history for an agent.

Query: `?limit=50`.

#### `DELETE /api/agent-chat/:agentName`
Clear conversation history.

Note: To send a message use the WebSocket `agent_chat` message (see WebSocket section).

---

### Agent Messages (inter-agent bus)

#### `GET /api/agent-messages`
Recent messages on the agent message bus.

Query: `?limit=50`.

#### `GET /api/agent-messages/:agent1/:agent2`
Direct conversation history between two agents.

Query: `?limit=50`.

#### `POST /api/agent-messages`
Inject a message into the agent bus.

Body: `{ "from": "string", "to": "string", "content": "string", "type"?: string }`

#### `GET /api/agent-messages/pairs`
List pairs of agents that have exchanged messages.

---

### Cognitive (OODA)

#### `GET /api/cognitive/state`
Current OODA context — assembled from sessions, memory, and goal tree.

#### `POST /api/cognitive/trigger`
Manually trigger an OODA cycle (non-blocking, 202 Accepted).

#### `GET /api/cognitive/goals`
Goal tree for the master controller.

#### `POST /api/cognitive/goals`
Create a goal manually.

Body: `{ "title": "string", "description"?: string, "priority"?: number, "parentId"?: number }`

#### `PUT /api/cognitive/goals/:id`
Update a goal's status or outcome.

Body: `{ "status"?: string, "actualOutcome"?: string, "successScore"?: number }`

#### `GET /api/cognitive/decisions`
Decision journal entries.

Query: `?limit=20`, `?agent=<name>`.

#### `GET /api/cognitive/strategy/:agent`
Current active strategy for an agent.

#### `GET /api/cognitive/messages`
Unread messages for an agent.

Query: `?agent=master-controller` (default).

#### `GET /api/cognitive/metrics`
Per-agent decision quality metrics.

---

### User Profile (Mind Meld)

#### `GET /api/profile`
List profile entries.

Query: `?category=<trait|note|style|chat_export>`, `?limit=100`.

#### `POST /api/profile/note`
Add a note or idea.

Body: `{ "content": "string", "tags"?: string[], "weight"?: number }`

#### `POST /api/profile/trait`
Add a personality trait.

Body: `{ "content": "string", "weight"?: number }`

#### `POST /api/profile/chat-export`
Ingest a chat export text (chunked and stored).

Body: `{ "content": "string", "source"?: string }`

#### `GET /api/profile/preview`
Preview the assembled profile prompt (used for mind meld injection).

#### `PUT /api/profile/:id`
Update a profile entry.

Body: `{ "content"?: string, "weight"?: number, "tags"?: string[] }`

#### `DELETE /api/profile/:id`
Delete a profile entry.

---

### Memories

#### `GET /api/memories/:projectPath`
List memories for a project.

Query: `?limit=20`.

#### `GET /api/memories/:projectPath/search`
Full-text search within a project's memories.

Query: `?q=<query>`, `?limit=10`.

#### `POST /api/memories/:projectPath`
Create a memory.

Body: `{ "category": "string", "content": "string", "sessionId"?: string }`

#### `DELETE /api/memories/:projectPath/:id`
Delete a memory by ID.

#### `POST /api/memories/decay`
Trigger memory decay across all projects (reduces weight of stale memories).

---

### Tools

#### `GET /api/tools`
List all registered tools.

Query: `?source=builtin|user|toml`, `?category=observe|analyze|mutate|communicate|orchestrate`.

#### `GET /api/tools/:name`
Get a single tool definition.

#### `GET /api/tools/:name/history`
Execution history for a tool.

Query: `?limit=50`.

---

### Trust & Leases

#### `GET /api/trust`
Trust scores and autonomy recommendations for all agents.

#### `GET /api/trust/:agentName`
Trust score + history + autonomy recommendation for a single agent.

#### `GET /api/leases/:agentName`
Active tool leases for an agent.

#### `DELETE /api/leases/:agentName`
Revoke all leases for an agent.

Query: `?goal_id=<number>` (optional — revoke only leases tied to a goal).

---

### Memory Consolidation

#### `GET /api/consolidation`
History of consolidation runs and timestamp of last run.

#### `POST /api/consolidation`
Trigger manual consolidation for all enabled agents.

---

### Specializations & Roundtables

#### `GET /api/specializations[/:agent]`
All agent specializations, or those for a specific agent.

#### `GET /api/roundtables`
Recent roundtable discussion messages.

Query: `?limit=20`.

#### `POST /api/roundtables`
Trigger a roundtable discussion.

Body: `{ "topic": "string", "agents": string[], "context"?: string }`

---

### Scheduling (opt-in)

Persistent schedules execute agents on a cron expression or fixed interval.

#### `GET /api/schedules[/:agent]`
List all schedules, optionally filtered by agent name.

Also accepts `?agent=<name>` query parameter.

#### `POST /api/schedules`
Create or update a schedule.

Body:
```json
{
  "agent_name": "string",
  "schedule_name": "string",
  "prompt": "string",
  "cron_expr": "string (optional)",
  "interval_minutes": "number (optional)",
  "max_budget_usd": "number (optional)"
}
```
Either `cron_expr` or `interval_minutes` is required.

#### `DELETE /api/schedules/:scheduleName`
Delete a schedule.

Query: `?agent=<agentName>` (default: `master-controller`).

#### `PATCH /api/schedules/:id`
Enable or disable a schedule by numeric ID.

Body: `{ "enabled": true|false }`

---

### Bridge (Android / CFC)

These endpoints are Android-specific and proxy to the `claude-chrome-android` bridge process.

#### `GET /api/bridge`
Check bridge health. Returns `{ status: "online"|"offline" }`.

#### `POST /api/bridge/start`
Spawn the bridge process (detached).

#### `POST /api/bridge/termux-service`
Launch the bridge via a Termux TermuxService intent (survives Termux background kill).

#### `POST /api/bridge/memory-pressure`
Simulate a Chrome memory pressure notification via CDP.

---

### SDK (Claude Code API bridge)

These endpoints control a long-lived Claude Code SDK session attached to the daemon.

#### `GET /api/sdk/status`
Returns `{ attached: bool, activeSession: string|null, busy: bool }`.

#### `POST /api/sdk/attach/:sessionName`
Attach the SDK bridge to a Claude Code session.

Body (optional): `{ "sessionId"?: string, "cwd"?: string }`

#### `POST /api/sdk/detach`
Detach the active SDK session.

#### `POST /api/sdk/prompt`
Send a prompt to the attached session (non-blocking — stream via WebSocket).

Body: `{ "prompt": "string", "effort"?: string, "thinking"?: object }`

Returns `202 Accepted`.

#### `POST /api/sdk/interrupt`
Interrupt the currently active SDK prompt.

#### `GET /api/sdk/sessions`
List available Claude Code JSONL sessions.

Query: `?dir=<path>`, `?limit=50`.

#### `GET /api/sdk/sessions/:id/messages`
Get messages for a specific session ID.

---

### Android / ADB

These endpoints are Android-specific.

#### `GET /api/processes`
List Android apps sorted by RSS (via ADB).

#### `POST /api/kill/:pkg`
Force-stop an Android app by package name.

#### `GET /api/autostop`
List packages registered for auto-stop on memory pressure.

#### `POST /api/autostop/:pkg`
Toggle auto-stop for a package.

#### `GET /api/adb`
List connected ADB devices.

#### `POST /api/adb/connect`
Initiate wireless ADB connection (runs `connect_script`).

#### `POST /api/adb/disconnect[/:serial]`
Disconnect a specific ADB device (or all if no serial given).

---

### Misc

#### `POST /api/fix-socket`
Re-bind the IPC socket. Called by the CLI when the socket is missing but the HTTP server is alive.

---

## SSE Events

Connect to `GET /api/events` for a persistent Server-Sent Events stream.

On connect, the server immediately sends:
```
event: connected
data: { "id": <clientId> }
```

Close the `EventSource` on `beforeunload`/`pagehide` to avoid exhausting the browser's 6-per-origin
connection limit.

| Event type | Payload | Description |
|---|---|---|
| `connected` | `{ id: number }` | Initial handshake after connect |
| `state` | Full `IpcResponse` of `cmdStatus()` | Session states changed (on health sweep) |
| `conversation` | `{ name, activity, claudeStatus, lastOutput }` | Claude session activity update |
| `notification` | `{ type, title, content }` | System notification (e.g., battery_low) |
| `telemetry` | `TelemetryRecord` | Captured telemetry request (if sink enabled) |

---

## WebSocket

Connect to `ws://localhost:18970/ws` for bidirectional streaming (SDK prompts, agent chat, run updates).

### Client → Server messages

| `type` | Fields | Description |
|---|---|---|
| `ping` | — | Keepalive; server responds with `{ type: "pong" }` |
| `subscribe` | `sessionName` | Subscribe to a session room for per-session updates |
| `unsubscribe` | `sessionName` | Unsubscribe from a session room |
| `prompt` | `sessionName`, `text`, `effort?`, `thinking?` | Send a prompt to the attached SDK session |
| `permission_response` | `id`, `resolved` | Respond to a tool permission request |
| `abort` | — | Abort an in-progress SDK prompt |
| `attach` | `sessionName`, `sessionId?`, `cwd?` | Attach SDK bridge to a session |
| `detach` | — | Detach SDK bridge |
| `agent_run` | `agentName`, `prompt?` | Trigger a standalone agent run |
| `switchboard_get` | — | Request current switchboard state |
| `switchboard_update` | Partial `Switchboard` | Patch switchboard |
| `agent_chat` | `agentName`, `prompt` | Send a chat message to an agent |
| `agent_chat_history` | `agentName` | Request conversation history |
| `agent_chat_clear` | `agentName` | Clear conversation history |

### Server → Client messages

| `type` | Fields | Description |
|---|---|---|
| `connected` | `timestamp` | Initial connection confirmation |
| `pong` | — | Response to ping |
| `subscribed` | `sessionName` | Confirms room subscription |
| `unsubscribed` | `sessionName` | Confirms room unsubscription |
| `attach_result` | SDK attach result | Result of `attach` |
| `agent_run_started` | `agentName` | Agent run has started |
| `agent_run_update` | `agentName`, `runId`, `status`, `cost?`, `error?` | Agent run status changed |
| `agent_chat_start` | `agentName` | Agent chat response started |
| `agent_chat_stream` | `agentName`, `text`, `thinking?` | Streaming text chunk |
| `agent_chat_complete` | `agentName`, full response | Agent chat response complete |
| `agent_chat_error` | `agentName`, `message` | Agent chat error |
| `agent_chat_history` | `agentName`, `messages` | History response |
| `agent_chat_cleared` | `agentName`, `cleared` | History cleared |
| `switchboard_update` | Switchboard fields | Current switchboard state |
| `agent_message` | `id`, `from_agent`, `to_agent`, `message_type`, `content`, `created_at` | Inter-agent bus message |
| `tool_result` | `toolName`, `result`, `agentName` | Tool execution result |
| `consolidation` | Consolidation result | Memory consolidation completed |
| `roundtable_status` | `running`, `topic`, `agents`, `result?` | Roundtable started or finished |
| `permission_resolved` | `id`, `resolved` | Permission request resolved |
| `error` | `message` | Error from the server |

---

## IPC Commands

Unix socket: `$PREFIX/tmp/tmx.sock` (Android/Termux) or `/tmp/operad.sock` (Linux/macOS).

Protocol: newline-delimited JSON — send `{ "cmd": "...", ...args }\n`, receive `{ "ok": bool, "data"?: any, "error"?: string }\n`.

Max buffer: 1 MB. Default client timeout: 30 s.

| Command | Required Args | Optional Args | Description |
|---|---|---|---|
| `status` | — | `name` | Session status (all or named) |
| `start` | — | `name` | Start a session |
| `stop` | — | `name` | Stop a session |
| `restart` | — | `name` | Restart a session |
| `health` | — | — | Health check results |
| `stream` | — | — | (Internal) stream daemon state |
| `boot` | — | — | Alias for `stream` (backwards compat) |
| `shutdown` | — | `kill: bool` | Graceful daemon shutdown (or kill if `kill=true`) |
| `go` | `name` | — | Send "go" to a session's tmux pane |
| `send` | `name`, `text` | — | Send text to a session's tmux pane |
| `tabs` | — | `names: string[]` | Open Termux tabs for sessions |
| `config` | — | — | Return sanitized daemon config |
| `memory` | — | — | System memory snapshot |
| `open` | `path` | `name`, `auto_go`, `priority` | Open a new session |
| `close` | `name` | — | Close / unregister a session |
| `recent` | — | `count` | Recent session list |
| `suspend` | `name` | — | SIGSTOP a session |
| `resume` | `name` | — | SIGCONT a session |
| `suspend-others` | `name` | — | Suspend all except named session |
| `suspend-all` | — | — | Suspend all sessions |
| `resume-all` | — | — | Resume all sessions |
| `register` | — | `path` | Scan and register projects |
| `clone` | `url` | `name` | Clone a repo and open it |
| `create` | `name` | — | Create a new project |

---

## Error Handling

All REST endpoints return:
- `200` on success
- `201` on resource creation
- `202` on accepted (non-blocking operations)
- `400` for bad request (missing params, invalid JSON)
- `403` for forbidden operations (e.g., deleting a builtin agent)
- `404` for not found
- `405` for wrong HTTP method
- `413` for oversized request body
- `503` when a required subsystem is not initialized (e.g., memory DB, SDK bridge)
- `500` for unexpected errors

Error body: `{ "error": "description string" }`

---

## Versioning Policy

- **Patch** (x.x.N) — bug fixes, no API changes
- **Minor** (x.N.0) — new endpoints or event types (backwards compatible)
- **Major** (N.0.0) — breaking changes to existing endpoints, removed fields, or changed types
