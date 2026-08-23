# operad API Reference

> **Stability:** This API is frozen as of v0.3.x. Breaking changes require a major version bump.

## REST API

### Authentication

Every `/api/*` route requires the dashboard token. The daemon binds
`127.0.0.1` by default; `[operad] bind` opts into wider exposure and the token
is required either way.

```sh
operad token                       # prints the URL, the bare token, and the header form
curl -H "Authorization: Bearer $TOKEN" http://localhost:18970/api/status
```

Browsers use the one-time handshake instead: opening
`http://host:18970/?token=<token>` exchanges it for an `HttpOnly;
SameSite=Strict` cookie and redirects to a clean URL.

`EventSource` and browser `WebSocket` cannot set headers, so `?token=<token>`
is also accepted on `/api/*`. The WebSocket upgrade is gated identically; an
unauthenticated upgrade is refused with `401`.

A request may carry the token in more than one place (say a stale
`Authorization` header from a proxy alongside a good cookie). All of them are
tried; the request is authorised if any matches.

**Origin check.** `SameSite=Strict` is not sufficient on its own here, and
until 0.5.1 this document claimed otherwise. Cookies are not port-scoped, and
per RFC 6265bis the "site" for `localhost` or a bare IP excludes the port — so
a page on `http://localhost:3000`, i.e. any other dev server you happen to be
running, is same-site with the dashboard and the browser attaches the cookie.
Requests authenticated **by cookie** are therefore also checked against the
`Origin` header: it must match the authority the request arrived on (port
included) or appear in `[operad] allowed_origins`. Requests authenticated by
`Authorization: Bearer` or `?token=` are not origin-checked, because a
cross-origin page cannot read the token in the first place. A request with no
`Origin` at all — curl, the CLI — is allowed; it has no ambient cookie to
abuse.

If you serve the dashboard from a separate dev server (`bun run dev` in
`dashboard/`), add its origin to `allowed_origins` or the proxied API calls
will 401.

Unauthenticated requests get `401` with `WWW-Authenticate: Bearer`. Static
dashboard assets are served without auth — they are public code, and the
handshake requires the page to load first. Everything that exposes data or
performs an action is under `/api`.

The token lives in `<state_dir>/dashboard-token` (mode 0600), not in
`operad.toml` — configs get pasted into issues and committed to dotfile repos.
`OPERAD_DASHBOARD_TOKEN` overrides it for containers and CI. It is deliberately
not written to the log; use `operad token` to retrieve it.

CORS: no `Access-Control-Allow-Origin` header is emitted unless the request's
origin is in `[operad] allowed_origins`. Same-origin needs none.



Base URL: `http://localhost:18970` (port configurable via `dashboard_port` in `operad.toml`)

All requests and responses use `application/json`.
Body size limit: 1 MB. Request body timeout: 10 s. Request bodies are read for
`POST`, `PUT`, `PATCH` and `DELETE`.

### Conventions

**`?limit=`** — where a route accepts it, the value must be a positive
integer; it is floored and capped at 1000. Anything else (non-numeric,
negative, zero, infinite) falls back to the route's default rather than
silently returning the whole collection. `days`, `goal_id`, `from` and `to`
are validated the same way.

**Error responses** — `4xx` bodies carry a specific `{ "error": … }`. A `500`
returns a generic message; the detail, including any stack, goes to the daemon
log. Malformed percent-encoding in a path segment is a `400`, not a `500`.

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

### Workflows

Workflows are DAGs of shell tasks with conditional edges. Each workflow has a unique name; runs are persisted with per-node status.

#### `GET /api/workflows`
List all workflows (config-defined + user-created). Returns `[{ id, name, spec, enabled, created_by }]`.

#### `GET /api/workflows/:name`
Fetch a single workflow by name. 404 if missing.

#### `POST /api/workflows`
Upsert a workflow.

Body: `{ "name": "string", "spec": { "nodes": [...], "edges": [...] } }`

Node shape: `{ "id": "string", "type": "task" | "noop", "command"?: "string", "cwd"?: "string", "env"?: { ... }, "timeout_s"?: 600 }`.
Edge shape: `{ "from": "id", "to": "id", "on"?: "success" | "error" | "always" }`. Default `on = "success"`.

Returns `{ id }`. 400 on cycle / dangling edge / duplicate node id.

#### `DELETE /api/workflows/:name`
Delete a workflow + cascade its run history. Returns `{ deleted: boolean }`.

#### `PATCH /api/workflows/:name`
Toggle the enabled flag.

Body: `{ "enabled": boolean }`

#### `POST /api/workflows/:name/run`
Execute a workflow synchronously. Returns the full `WorkflowRunResult`: `{ run_id, workflow_name, status, message, nodes: { <id>: { status, exit_code?, output?, error? } }, started_at, finished_at }`. `status` is `success` | `failed` | `cancelled`.

#### `GET /api/workflows/:name/runs`
Recent runs for a workflow, newest first (default limit 20). Returns `[{ id, workflow_id, workflow_name, status, started_at, finished_at, message }]`.

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

> **Two sources, and they disagree by design.** `/api/quota`,
> `/api/tokens-daily` and `/api/tokens-window` read the `costs` SQLite table,
> which **only the agent/SDK path writes** — on an install that runs no agents
> they legitimately return zeros. `/api/token-usage` and `/api/tokens` derive
> from the Claude Code JSONL transcripts instead, so they report real usage on
> any install. The dashboard's Tokens panel uses `/api/token-usage` for that
> reason.

> **Costs are estimates, not bills.** Every `cost_usd` is list API pricing for
> the model that produced the tokens, including the cache multipliers
> (0.1x input for a read, 1.25x for a 5-minute write, 2x for a 1-hour write).
> Tokens from a model with no published rate are excluded from `cost_usd` and
> reported in `unpriced_tokens` / `unpriced_models` — a non-zero
> `unpriced_tokens` means the cost shown is incomplete.

#### `GET /api/token-usage`
Range-scoped token summary derived from the Claude Code JSONL transcripts.
Backs the dashboard's Tokens panel.

Query: `?range=all|week|day` (default `all`; anything else falls back to `all`).

Response (`TokenRangeSummary`):

```json
{
  "range": "week",
  "since": "2026-08-15T00:00:00.000Z",
  "totals": {
    "input_tokens": 0, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_creation_tokens": 0,
    "total_tokens": 0, "turns": 0,
    "cost_usd": 0, "unpriced_tokens": 0, "unpriced_models": []
  },
  "projects": [{ "name": "...", "path": "...", "totals": {}, "sessions": [] }],
  "daily": [{ "date": "2026-08-21", "total_tokens": 0, "cost_usd": 0 }],
  "generated_at": "2026-08-22T00:00:00.000Z",
  "scan_ms": 2
}
```

`since` is null for `range=all`. `scan_ms` is the wall-clock cost of the scan;
it is ~0 on a cache hit, because the scanner reads only bytes appended since
the previous call.

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

Response: `ProjectTokenUsage` or `ProjectTokenUsage[]`. Per-session totals
carry `cost_usd`, `unpriced_tokens` and `unpriced_models` as described above.

The aggregate is **one entry per project directory, not per session**. The
scan reads a directory's whole JSONL corpus, and several sessions routinely
share one directory, so a per-session list repeated identical transcripts and
inflated the totals. `name` is therefore the directory's own name; `path` is
unique across the array, which is what `/api/token-usage` and the dashboard's
keyed lists rely on. `GET /api/tokens/:name` is an explicit lookup and still
reports the session name it was asked about.

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

### Customization

Aggregates all user- and project-level customization a user has installed
across the Claude Code / Codex / OpenCode ecosystem — hooks, skills, plans,
slash commands, subagent markdown, memories, `CLAUDE.md`, `AGENTS.md`, MCP
servers, plugins, and marketplace data.

#### `GET /api/customization[/:projectPath]`

Returns user-level + optionally project-scoped customization for a single
project. When `projectPath` is supplied (URL-encoded), project-level sources
from `<projectPath>/.claude/…` and `<projectPath>/{CLAUDE,AGENTS}.md` are
merged in.

Response body (shape):

```json
{
  "ok": true,
  "data": {
    "mcpServers": [...],
    "plugins": [...],
    "skills":       [ { "name", "path", "scope": "user"|"project" } ],
    "plans":        [ { "name", "path", "scope" } ],
    "commands":     [ { "name", "path", "scope" } ],   // .claude/commands/*.md
    "agentsMd":     [ { "name", "path", "scope" } ],   // .claude/agents/*.md
    "memories":     [ { "name", "path", "scope" } ],   // .claude/memories/*.md
    "claudeMds":    [ { "label", "path", "scope" } ],  // CLAUDE.md everywhere
    "agentsMdFiles":[ { "label", "path", "scope",
                        "consumers": ["Claude Code","Codex","OpenCode"] } ],
    "hooks":        [ { "event", "matcher", "type", "command", "timeout?",
                        "scope": "user"|"project" } ],
    "marketplace": { "sources": [...], "available": [...] },
    "projectPath": "string?"
  }
}
```

Scopes are `"user"` (from `~/.claude/…` or `$HOME/AGENTS.md`) or
`"project"` (from `<projectPath>/.claude/…` or `<projectPath>/AGENTS.md`).

#### `GET /api/customization/all-projects`

Returns customization across **every** known project — enumerated from
`~/.claude/history.jsonl`. Projects are included only if they contribute at
least one entry.

Response shape:

```json
{
  "ok": true,
  "data": {
    "user": {
      "hooks": [...], "skills": [...], "plans": [...],
      "commands": [...], "agentsMd": [...], "memories": [...],
      "claudeMds": [...], "agentsMdFiles": [...]
    },
    "projects": [
      {
        "path": "/abs/project",
        "name": "project-basename",
        "hooks": [...], "skills": [...], "plans": [...],
        "commands": [...], "agentsMd": [...], "memories": [...],
        "claudeMd":     { "path": "..." }?,        // optional, single file
        "agentsMdFile": { "path": "...", "consumers": [...] }?
      }
    ]
  }
}
```

#### `GET /api/customization-file/:path`
Read any allowed customization file by its filesystem path (URL-encoded). Allowed paths:
- Anything under `~/.claude/`
- `<project>/CLAUDE.md`, `<project>/AGENTS.md`, `<project>/.claude/**` for known projects
- `$HOME/AGENTS.md`

#### `POST /api/customization-file`
Write a file.

Body: `{ "path": "string", "content": "string" }`

Paths must satisfy the same allowlist as the GET variant.

#### `GET /api/env`

Host facts the dashboard needs for display: `home`, `platform`, `path_sep`.
Exists because several panels shorten absolute paths to `~/…` and previously
hardcoded the Termux home, so every path rendered in full on other platforms.

#### `POST /api/agents/<name>/restore`

Restore an agent from a snapshot. Body: `{ file?, options? }` — `file` defaults
to the newest and must be one of `GET /api/agents/<name>/snapshots`, which is
what prevents a traversal. The import is pinned to the agent in the URL.

#### `GET /api/skills/search?q=&provider=&limit=`

Discover installable skills across providers. Only `mcp-official` and
`operad-curated` have an index; `git+url` and `claude-marketplace` return
nothing. A provider that fails contributes to `errors[]` rather than failing
the whole search.

#### `GET /api/customization/export[?project=<path>]`

Build a complete, **re-importable** environment bundle for migrating a machine.

Unlike the dashboard's per-section `⤓` downloads (which emit file *paths* and
metadata only), this payload carries actual document **content** plus plugin
marketplace **sources**, so it restores on a machine that has never seen these
files.

Collected: `skills`, `commands`, `agents`, `plans`, `memories` (both the flat
`foo.md` and directory `foo/SKILL.md` layouts, following symlinks), plus
`known_marketplaces.json` sources, installed plugins, and MCP server entries.

```json
{
  "kind": "operad-customization-bundle",
  "format_version": 1,
  "meta": { "exported_at": "ISO", "exported_from": "hostname", "operad_version": "0.4.8" },
  "documents":   [ { "collection": "skills", "scope": "user", "rel_path": "foo/SKILL.md", "content": "..." } ],
  "marketplaces":[ { "name": "claude-plugins-official", "source": { "source": "github", "repo": "anthropics/..." } } ],
  "plugins":     [ { "id": "sp@official", "name", "marketplace", "version", "enabled", "scope" } ],
  "mcp_servers": [ { "name", "scope", "command", "args", "env", "disabled" } ]
}
```

#### `POST /api/customization/import`

Apply a previously exported bundle to this machine.

Body: `{ "bundle": <bundle>, "options": { ... } }` (a bare bundle body is also
accepted).

| Option | Default | Meaning |
|---|---|---|
| `dry_run` | `false` | Report what would happen; touch no files |
| `overwrite` | `false` | Replace existing files instead of skipping them |
| `collections` | all | Restrict to e.g. `["skills","commands"]` |
| `include_plugins` | `true` | Register marketplaces + `enabledPlugins` |
| `include_mcp` | `false` | Merge MCP servers into `~/.claude.json` |
| `project_path` | — | Target for `scope: "project"` documents |

Response is a per-item report — individual rejects never fail the request:

```json
{
  "written": ["/home/u/.claude/skills/foo/SKILL.md"],
  "skipped": [ { "path": "../../evil.md", "reason": "unsafe path (traversal or absolute path rejected)" } ],
  "marketplaces_added": ["claude-plugins-official"],
  "plugins_enabled": ["superpowers@claude-plugins-official"],
  "mcp_servers_added": [],
  "warnings": ["..."]
}
```

**What import does not do:** it never clones plugin repositories or runs an
installer. It registers the marketplace source and marks the plugin enabled;
Claude Code materialises the plugin on next launch. Fabricating
`installed_plugins.json` entries pointing at install paths that don't exist on
the target machine would leave Claude Code with a broken plugin table.

**Secrets:** exports redact secret-looking MCP env values to `"***"`. Import
drops any value equal to `"***"` (with a warning) rather than writing a
plausible-looking but broken credential. Re-enter those by hand.

**Path safety:** every `rel_path` is validated before use — traversal (`..`),
absolute paths, Windows drive prefixes, control characters and trailing
dot/space components are refused. Bundles are untrusted input.

#### AGENTS.md cross-tool compat

`AGENTS.md` is the emerging cross-tool standard ([agents.md](https://agents.md)) read by Claude Code, Codex, OpenCode, and others. operad surfaces it as a distinct `agentsMdFiles[]` array rather than lumping it with `CLAUDE.md`, and each entry carries a `consumers` list so the UI can indicate which tools will pick it up.

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

#### `POST /api/leases/:agentName`
Grant a tool lease — a temporary, optionally goal-scoped, execution-capped
permission to call one tool.

A lease **widens** what an agent may do: it lets a call through that the
agent's standing `autonomy_level` would otherwise send for approval. It never
narrows anything, and it cannot override `protected_tools` — that list is an
explicit "never without a human", and a lease is not a human. A lease's
execution budget is charged only when the lease is what allowed the call; if
the agent's own autonomy level already permitted it, nothing is spent.

```json
{ "tool": "git-commit", "max_executions": 5, "ttl_seconds": 3600, "goal_id": 12 }
```

`tool` is required. At least one of `max_executions` or `ttl_seconds` must be
given — an unbounded grant is what `autonomy_level` is for, so a lease with
neither bound is rejected with `400`.

Returns `{ "id": <leaseId>, "agent": …, "tool": … }`.

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

### Skill Marketplace

Enabled by default. Set `enabled = false` under `[skills]` in `operad.toml`
to hide the surface, or override per-run with `--enable-skills-preview` /
`--disable-skills-preview` on `operad daemon` / `operad stream`. When
disabled, every route below returns **503**.

#### `GET /api/skills[?provider=<id>]`
Installed skills. Providers: `git+url`, `claude-marketplace`, `mcp-official`,
`operad-curated`.

#### `GET /api/skills/events?limit=N`
Recent install/uninstall/GC events, newest first.

#### `GET /api/skills/:id`
Full manifest for one skill. `404` if unknown.

#### `POST /api/skills/install`
Body: `{ provider, locator, version?, force_take_ownership?, accept_cap_downgrade? }`
→ `201`. `409` for ownership/autonomy conflicts, `400` otherwise.

Locators are validated: only `https://`, `http://`, `ssh://`, `git://`,
`file://`, `git@host:path` and local filesystem paths are accepted. The `ext::`
transport and `-`-prefixed locators are refused — both are git argument
injection vectors. `version` is validated as a single path component before it
is used as a cache directory name.

#### `POST /api/skills/:id/uninstall`
Body: `{ force_revoke? }`. `409` on `TOOL_HAS_ACTIVE_CONSUMERS`.

#### `GET /api/tool-autonomy` · `POST /api/tool-autonomy`
Read/set per-tool autonomy buckets (`observe` → `autonomous`). POST body:
`{ tool_id, bucket }`; `409` on `AUTONOMY_CAP_VIOLATION`.

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
