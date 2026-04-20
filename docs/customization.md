# Customization Sources

operad surfaces every per-user and per-project customization file from your Claude Code / Codex / OpenCode installs. The dashboard at `/settings` shows each type with User / Current Project / All Projects tabs and a JSON download per tab. This page documents what operad scans, where each type lives, and which tools consume it.

## Cross-tool standard: `AGENTS.md`

[AGENTS.md](https://agents.md) is a plain-text instructions file that all major agentic CLIs read from the project root. It's the closest thing to a universal "system prompt per repo". operad surfaces it as a first-class aggregated type.

| Tool | Reads | Notes |
|------|-------|-------|
| Claude Code | `<project>/AGENTS.md`, `~/AGENTS.md` | Merged after `CLAUDE.md` |
| Codex | `<project>/AGENTS.md` | Primary project instructions file |
| OpenCode | `<project>/AGENTS.md` | Primary project instructions file |

If you also maintain a Claude-specific `CLAUDE.md`, keep both — operad shows them as separate rows so you can see which files are cross-compat vs Claude-only.

## Per-type locations

All locations are scanned for both the current project (when a project is selected in the dashboard) and every known project from `~/.claude/history.jsonl`.

### Skills
- `~/.claude/skills/*.md` (user)
- `<project>/.claude/skills/*.md` (project)
- Consumed by: Claude Code via the `Skill` tool

### Slash commands
- `~/.claude/commands/*.md` (user)
- `<project>/.claude/commands/*.md` (project)
- Consumed by: Claude Code via `/<name>` in a prompt

### Subagents (Claude Code's agent registry)
- `~/.claude/agents/*.md` (user)
- `<project>/.claude/agents/*.md` (project)
- Each file is a frontmatter-typed agent config with a description, model override, and allowed tools. Invoked via the `Task` tool with `subagent_type` set to the file's basename.

### Plans
- `~/.claude/plans/*.md` (user)
- `<project>/.claude/plans/*.md` (project)
- Consumed by: Claude Code's plan mode / superpowers:writing-plans skill

### Memories (user-authored notes)
- `~/.claude/memories/*.md` (user)
- `<project>/.claude/memories/*.md` (project)
- Free-form context notes. Distinct from the auto-managed memory files at `~/.claude/projects/{mangled}/memory/*.md` which operad surfaces under `claudeMds`.

### `CLAUDE.md`
- `~/.claude/CLAUDE.md` (user-global)
- `<project>/CLAUDE.md` (project root)
- `~/.claude/projects/{mangled}/memory/*.md` (Claude's per-project auto-memory snapshots)
- Consumed by: Claude Code

### `AGENTS.md`
- `$HOME/AGENTS.md` (rarely used, some tools support it)
- `<project>/AGENTS.md` (standard location)
- `~/.claude/projects/{mangled}/AGENTS.md` (Claude-specific project override, if present)
- Consumed by: Claude Code, Codex, OpenCode, and any other tool that follows the [agents.md](https://agents.md) spec

### Hooks
- `~/.claude/settings.json → hooks` (user)
- `<project>/.claude/settings.json → hooks` (project)
- Consumed by: Claude Code — the harness invokes these shell commands on PreToolUse / PostToolUse / Stop / SessionStart / etc.

### MCP servers
- `~/.claude.json → mcpServers`
- `~/.claude/settings.json → mcpServers`
- Project-scoped entries via `~/.claude.json → projects.<path>.mcpServers`
- Consumed by: Claude Code (and other MCP-aware clients)

### Plugins
- `~/.claude/plugins/installed_plugins.json`
- `~/.claude/plugins/known_marketplaces.json` (sources + available plugins)
- Enabled flags from `~/.claude/settings.json → enabledPlugins`
- Consumed by: Claude Code

## Dashboard

Every type has a dedicated panel with three tabs:

- **User** — `~/.claude/…` or `$HOME/AGENTS.md`
- **Current Project** — `<selectedProject>/…`
- **All Projects** — every path from `history.jsonl` that has at least one file of this type, with a Project column

Every tab has a **"Download JSON"** button that exports the current view as `operad-{type}-{scope}-{YYYY-MM-DD}.json`. Use these to back up your setup, share a config, or diff across machines.

## REST endpoints

See [docs/api.md](./api.md) § Customization for:

- `GET /api/customization[/:projectPath]` — user + one project
- `GET /api/customization/all-projects` — every project
- `GET /api/customization-file/:path` — read an individual file
- `POST /api/customization-file` — write an individual file

All file-level endpoints enforce path allowlisting (`~/.claude/…`, known project `CLAUDE.md` / `AGENTS.md` / `.claude/**`, `$HOME/AGENTS.md`).
