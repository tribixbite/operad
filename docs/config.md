# operad Configuration Reference

Config file: `~/.config/operad/operad.toml`

Run `operad init` to generate a minimal starter config, or `operad doctor` to diagnose issues.

Environment variable expansion is supported in all string values using `$VAR` or `${VAR}` syntax.

---

## `[operad]` section

Also accepted as `[orchestrator]` for backwards compatibility.

| Field | Type | Default | Description |
|---|---|---|---|
| `socket` | string | platform default | Path to the IPC Unix socket. Android: `$PREFIX/tmp/tmx.sock`. Linux: `/tmp/operad.sock`. |
| `state_file` | string | platform default | Path to the JSON state file. Default: `~/.local/share/tmx/state.json`. |
| `log_dir` | string | platform default | Directory for structured log files. Default: `~/.local/share/tmx/logs/`. |
| `health_interval_s` | number | `120` | Seconds between health sweep cycles. |
| `boot_timeout_s` | number | `300` | Max seconds to wait for all sessions to reach `running` state on boot. |
| `process_budget` | number | `32` | Android 12+ phantom process limit. Must be ≥ enabled sessions + 5 overhead. |
| `wake_lock_policy` | enum | `active_sessions` | When to hold a wake lock. One of: `always`, `active_sessions`, `boot_only`, `never`. |
| `dashboard_port` | number | `18970` | HTTP port for the web dashboard and REST API. `0` disables the dashboard. |
| `memory_warning_mb` | number | `2000` | MemAvailable threshold (MB) for "warning" memory pressure. |
| `memory_critical_mb` | number | `1200` | MemAvailable threshold (MB) for "critical" pressure — may trigger auto-suspend. |
| `memory_emergency_mb` | number | `800` | MemAvailable threshold (MB) for "emergency" pressure — aggressive action. |
| `quota_weekly_tokens` | number | `0` | Approximate weekly token budget. `0` = unlimited (quota tracking disabled). |
| `quota_warning_pct` | number | `75` | Warn when weekly usage reaches this percentage of the weekly budget. |
| `quota_critical_pct` | number | `90` | Critical alert when weekly usage reaches this percentage. |
| `quota_window_hours` | number | `5` | Rolling window size in hours for velocity calculation. Matches Anthropic's 5-hour window. |

### `[operad.checkpoints]`

Protected checkpoints always require human approval regardless of agent autonomy level.

| Field | Type | Default | Description |
|---|---|---|---|
| `protected_files` | string[] | `["*.toml","*.env","package.json","Dockerfile"]` | Glob patterns for files that always require write approval. |
| `protected_git` | string[] | `["push","merge","rebase"]` | Git operations that always require approval. |
| `protected_tools` | string[] | `["session-stop","session-send"]` | Tool names that always require approval. |

**Example:**
```toml
[operad]
dashboard_port = 18970
health_interval_s = 60
quota_weekly_tokens = 1000000
quota_warning_pct = 75
wake_lock_policy = "active_sessions"

[operad.checkpoints]
protected_files = ["*.toml", "*.env", "Dockerfile"]
protected_git = ["push", "merge"]
protected_tools = ["session-stop"]
```

---

## `[[session]]` sections

Each `[[session]]` block defines a managed session. At least `name` is always required.

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `name` | string | — | yes | Kebab-case session identifier. Must match `[a-z0-9-]+`. Must be unique. |
| `type` | enum | `claude` | no | Session type. One of: `claude`, `daemon`, `service`. |
| `path` | string | — | for `claude`/`daemon` | Working directory. Required for `claude` and `daemon` types. Supports `$ENV_VAR`. |
| `command` | string | — | for `service` | Command to execute. Required for `service` type. |
| `enabled` | bool | `true` | no | Whether this session auto-starts on boot. |
| `auto_go` | bool | `false` | no | Send `go` automatically after startup (Claude sessions only). |
| `priority` | number | `10` | no | Start priority — lower numbers start first; used for topological tie-breaking. |
| `depends_on` | string[] | `[]` | no | Session names this session must wait for before starting. |
| `headless` | bool | `false` | no | Run without a UI tab (no tmux window). |
| `bare` | bool | `false` | no | Spawn as a detached process instead of a tmux session (for commands that crash in tmux PTY). |
| `max_restarts` | number | `3` | no | Maximum restart attempts before entering `failed` state. |
| `restart_backoff_s` | number | `5` | no | Base backoff in seconds before a restart attempt. |
| `session_id` | string | — | no | Claude session ID for `--resume` (multi-instance support). |

### `[session.env]`

Per-session environment variables. Values support `$ENV_VAR` expansion.

```toml
[[session]]
name = "my-project"
type = "claude"
path = "$HOME/git/my-project"

[session.env]
ANTHROPIC_API_KEY = "$ANTHROPIC_API_KEY"
NODE_ENV = "development"
```

### `[session.health]`

Per-session health check override. If omitted, the type default from `[health_defaults]` is used.

| Field | Type | Default | Description |
|---|---|---|---|
| `check` | enum | `tmux_alive` | Check method. One of: `tmux_alive`, `http`, `process`, `custom`. |
| `unhealthy_threshold` | number | `2` | Consecutive failures before marking the session as `degraded`. |
| `interval_s` | number | (global) | Override the global health check interval for this session. |
| `url` | string | — | HTTP endpoint to probe (required for `http` check). |
| `process_pattern` | string | — | Process name pattern to look for (required for `process` check). |
| `command` | string | — | Shell command to run (required for `custom` check). Exit 0 = healthy. |

**Example:**
```toml
[[session]]
name = "my-api"
type = "service"
command = "bun run server"
path = "$HOME/git/my-api"
priority = 5
depends_on = ["database"]
max_restarts = 5
restart_backoff_s = 10

[session.health]
check = "http"
url = "http://localhost:3000/health"
unhealthy_threshold = 3
interval_s = 30
```

---

## Session Types

| Type | `path` | `command` | tmux | Description |
|---|---|---|---|---|
| `claude` | required | — | yes | Launches `claude` CLI in a tmux session. |
| `daemon` | required | optional | yes | Runs a background daemon (e.g., a server) in tmux. |
| `service` | optional | required | yes | Runs an arbitrary command in tmux. |

For `bare = true` sessions, the command is spawned as a detached process instead of a tmux session.

---

## `[battery]` section

Battery monitoring controls (Android primarily).

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `true` | Enable battery monitoring. |
| `low_threshold_pct` | number | `10` | Battery percentage below which low-battery actions are triggered (radio disable). |
| `poll_interval_s` | number | `60` | Battery poll interval in seconds. Battery changes slowly so 60 s is adequate. |

**Example:**
```toml
[battery]
enabled = true
low_threshold_pct = 15
poll_interval_s = 120
```

---

## `[boot]` section

Controls which Claude sessions are auto-started on daemon boot.

| Field | Type | Default | Description |
|---|---|---|---|
| `auto_start` | number | `6` | Auto-start the N most recently used Claude sessions. |
| `visible` | number | `10` | Show up to N recent sessions in the dashboard with a play button. |

**Example:**
```toml
[boot]
auto_start = 3
visible = 8
```

---

## `[adb]` section

ADB wireless debugging configuration (Android only).

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `true` | Enable ADB integration. |
| `connect_script` | string | `""` | Path to a shell script that establishes wireless ADB. |
| `connect_timeout_s` | number | `45` | Timeout for the connect script in seconds. |
| `retry_interval_s` | number | `300` | Seconds between reconnect attempts. |
| `phantom_fix` | bool | `true` | Apply the Android phantom process killer workaround. |
| `boot_delay_s` | number | `15` | Seconds to wait after fresh boot before initializing ADB. |

**Example:**
```toml
[adb]
enabled = true
connect_script = "$HOME/bin/adb-connect.sh"
connect_timeout_s = 30
retry_interval_s = 600
```

---

## `[telemetry_sink]` section

Optional telemetry interception server. Captures requests from embedded WebViews.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Enable the telemetry sink. |
| `port` | number | `18971` | Port to listen on. |
| `max_body_bytes` | number | `4096` | Max request body bytes to read per capture. |
| `ring_buffer_size` | number | `500` | In-memory ring buffer size for recent records. |
| `rotate_at_bytes` | number | `10485760` | Rotate the JSONL log file at this size (default 10 MB). |

---

## `[health_defaults]` section

Default health check configs by session type. Each sub-section (`claude`, `daemon`, `service`) can
override the built-in defaults.

```toml
[health_defaults.claude]
check = "tmux_alive"
unhealthy_threshold = 2
interval_s = 60

[health_defaults.service]
check = "http"
url = "http://localhost:3000/health"
unhealthy_threshold = 3
```

---

## `[[agent]]` sections (opt-in)

Agent definitions for the agentic layer. All 4 built-in agents default to `enabled = false`.
User-defined agents can be added here or via the REST API / dashboard.

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | — | Kebab-case identifier (`[a-z0-9-]+`). Must be unique. |
| `description` | string | — | Natural language description used by the SDK to decide when to spawn. |
| `prompt` | string | — | System prompt text, or a path to a `.md` file. |
| `enabled` | bool | `true` | Whether this agent is active. |
| `model` | string | (default) | Model alias (`sonnet`, `opus`, `haiku`) or full model ID. |
| `max_turns` | number | — | Maximum API round-trips per run. |
| `background` | bool | — | Fire-and-forget mode (no response waited for). |
| `tools` | string[] | — | Allowed tools (inherits all if omitted). |
| `disallowed_tools` | string[] | — | Blocked tools. |
| `effort` | enum | — | Reasoning effort: `low`, `medium`, `high`, `max`. |
| `permission_mode` | enum | — | Tool permission mode: `auto`, `manual`. |
| `max_budget_usd` | number | — | Max USD spend per standalone run. |
| `autonomy_level` | enum | `observe` | Tool auto-approval scope. One of: `observe`, `suggest`, `supervised`, `trusted`, `autonomous`. |
| `allowed_tool_categories` | string[] | all | Tool categories: `observe`, `analyze`, `mutate`, `communicate`, `orchestrate`. |
| `max_tool_calls_per_run` | number | — | Budget guardrail on tool calls per run. |

**Example:**
```toml
[[agent]]
name = "code-reviewer"
description = "Reviews code changes and suggests improvements"
prompt = "You are a careful code reviewer..."
enabled = true
model = "sonnet"
max_turns = 20
autonomy_level = "observe"
allowed_tool_categories = ["observe", "analyze"]
```

---

## `[[tool]]` sections (opt-in)

User-defined shell tools available to agents. These supplement the built-in tool registry.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Tool identifier. |
| `description` | string | yes | What the tool does (shown to agents). |
| `category` | enum | no (`analyze`) | Tool category: `observe`, `analyze`, `mutate`, `communicate`, `orchestrate`. |
| `command` | string | yes | Shell command to execute. Use `{param_name}` for parameter substitution. |
| `timeout_ms` | number | no | Execution timeout in milliseconds. |

### `[[tool.params]]`

Parameter definitions for the tool command.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Parameter name (used in `{name}` substitution). |
| `type` | string | no | Parameter type hint (`string`, `number`, etc.). |
| `required` | bool | no | Whether the parameter is required. |
| `description` | string | no | Description of the parameter. |

**Example:**
```toml
[[tool]]
name = "git-log"
description = "Show recent git commits for a repository"
category = "observe"
command = "git -C {path} log --oneline -{count}"

[[tool.params]]
name = "path"
type = "string"
required = true
description = "Repository path"

[[tool.params]]
name = "count"
type = "number"
description = "Number of commits (default 10)"
```

---

## Config Validation

The daemon validates the config on startup:

- Session names must match `[a-z0-9-]+` and be unique.
- `path` is required for `claude` and `daemon` session types.
- `command` is required for `service` session types.
- `depends_on` entries must reference existing session names.
- `process_budget` must be ≥ enabled sessions + 5.

Validation errors print actionable fix instructions and exit with code 1.
Run `operad doctor` for a broader diagnostic beyond config validation.

---

## Full Example

```toml
[operad]
dashboard_port = 18970
health_interval_s = 60
wake_lock_policy = "active_sessions"
quota_weekly_tokens = 2000000
quota_warning_pct = 75

[battery]
enabled = true
low_threshold_pct = 10

[boot]
auto_start = 4
visible = 8

[[session]]
name = "main-project"
type = "claude"
path = "$HOME/git/my-project"
priority = 1
auto_go = false
enabled = true
max_restarts = 3

[session.env]
NODE_ENV = "development"

[[session]]
name = "api-server"
type = "service"
command = "bun run dev"
path = "$HOME/git/my-project"
priority = 2
depends_on = ["main-project"]

[session.health]
check = "http"
url = "http://localhost:3000/health"
unhealthy_threshold = 3
interval_s = 30
```
