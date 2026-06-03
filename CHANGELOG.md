# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Autostart pins (⭐) for sessions.** Each session row in the dashboard
  gets a star toggle that pins/unpins it for auto-boot. The choice is
  persisted in `state.json` (`autostart_overrides`) and applied over the
  recency/TOML-resolved `enabled` flag on the next daemon boot, so the
  autostart set is now an explicit, trackable handle instead of being
  inferred from recency — fixing the "120 inactive projects all look the
  same" confusion. New `SessionState.autostart` wire field,
  `POST /api/autostart/<name> { enabled }` REST route, `autostart` IPC
  command, and `operad autostart <name> [on|off]` CLI. Closing a session
  clears its pin.
- **Prompt Library: tap to expand.** In the home-page library, tapping a
  prompt row now expands its clamped two-line preview to the full text
  (and tap again to collapse) — no need to open the conversation just to
  read a long prompt.
- **Roadmap doc** — `docs/roadmap.md` enumerates every v1.1+ skill
  marketplace deferral with spec back-references (IPC/REST/CLI gaps,
  provider queue, deferred MCP lifecycle modes, supply-chain hardening,
  Operit-pattern follow-ups, dashboard mobile-pass list).
- **`tmx skill events [--limit=<n>]`** — CLI mirror of the existing
  `GET /api/skills/events` REST endpoint, exposes the install/update/
  uninstall timeline including `autonomy_clamp` cascade entries.
- **Dashboard cap-downgrade retry path** — `SkillManagerPanel` now
  catches `PROVIDER_TIER_DOWNGRADE` on install and offers an inline
  retry with `accept_cap_downgrade`, matching the existing
  `TOOL_HAS_ACTIVE_CONSUMERS` retry UX on uninstall. `installSkill()`
  API gains the `accept_cap_downgrade` option.

### Fixed
- **Prompt Library "open" arrow targets the right conversation.** The
  open-conversation arrow now passes the prompt's originating Claude
  `session_id` through to the conversation viewer, so it loads the exact
  historical conversation the prompt came from instead of the project's
  most-recently-active one.
- **Two operad sessions sharing a project path no longer cross-load
  conversations.** A live-JSONL binder runs each monitoring poll: for any
  project with 2+ running claude sessions it pairs each session to the
  distinct conversation it created (resumed sessions → their resume id;
  fresh `cc` sessions → the conversation that began at/after the session
  started, matched in start order). The binding is sticky, persisted in
  `state.json` (`bound_jsonl_id`), and surfaced as `SessionState.session_id`
  so the conversation drawer opens each session's own conversation — even
  two fresh `cc` instances of the same project. Lone sessions stay unbound
  and follow the project's most-recent conversation as before.
- **Sessions table separators align.** The `Session` and actions cells no
  longer set `display:flex` directly on the `<td>` (which dropped the cell
  out of table-row height sync and stepped the collapsed border-top);
  the flex layout moved to inner wrappers so every row's horizontal rule
  is a single straight line.
- **No more dead `--resume` on a missing conversation.** The Claude
  runtime adapter now verifies the bound `session_id`'s JSONL exists on
  disk before emitting `claude --resume <id>`; a stale id (resumed on
  another machine, pruned history) falls back to a fresh `cc` instead of
  leaving the pane at a "No conversation found" error.
- **REST `POST /api/skills/install`** now plumbs `accept_cap_downgrade`
  through to `SkillManager.install`, so the dashboard and other REST
  callers can recover from `PROVIDER_TIER_DOWNGRADE`. Previously the
  field was silently dropped. Status codes broadened to 409 for the
  full set of recoverable gating refusals
  (`TOOL_HAS_ACTIVE_CONSUMERS`, `TOOL_NAME_CONFLICT`,
  `WORKFLOW_NAME_CONFLICT`, `AGENT_NAME_CONFLICT`,
  `MCP_NAME_USER_OWNED`, `MCP_OWNED_BY_OTHER_DAEMON`,
  `PROVIDER_TIER_DOWNGRADE`, `AUTONOMY_CAP_VIOLATION`) so clients can
  distinguish retry-with-flag from "your payload is wrong".

- **Skill marketplace Phase C — concurrent installs via generation
  discipline.** The coarse `INSTALL_BLOCKED_BY_ACTIVE_CONSUMER` gate
  is replaced by per-generation shadow tool maps. When an OODA cycle
  / scheduled run / workflow / REST call holds a ConsumerTracker
  pin, the install transaction creates generation N+1 in parallel,
  atomically swaps the live pointer on commit, and leaves generation
  N resident until the pin releases. The background GC sweeper drops
  unreferenced generations + their tool maps on the next interval.
  ToolExecutor gains beginGenerationTransaction / commitGeneration /
  abortGeneration / pruneGeneration; ConsumerTracker.acquire() returns
  a PinHandle carrying the snapshotted generation; long-running
  callers pass `pin.generation` to `toolExecutor.execute(..., gen)`
  so concurrent installs don't tear the registry under their run.
  Cross-tier re-install rule: stricter tier clamps the cap + requires
  `--accept-cap-downgrade` if any tool's current bucket would exceed
  the new cap; cascade is recorded under
  `skill_events.detail.kind = autonomy_clamp`. New typed errors:
  `PROVIDER_TIER_DOWNGRADE`. `OPERAD_CURATED_INDEX_URL_TEMPLATE` env
  var lets mirrors / local file paths replace the GitHub raw URL.
  4 crash-injection tests added in `skills-crash.test.ts` validate
  the §3.15 5-store rollback contract under fault injection at
  fetch + read; 263 tests total (was 256). End-user docs in
  `docs/skills.md` updated with the new concurrent-install
  guarantee.

- **Skill / plugin marketplace (preview)** — multi-source aggregator
  for installing bundles of tools, agents, workflows, MCP servers, and
  SKILL.md context. Four day-1 providers: `git+url` (escape tier),
  `claude-marketplace` (`anthropics/*` → trusted, others → community),
  `mcp-official` (trusted; HTTPS to `registry.modelcontextprotocol.io`
  with optional SPKI pin), `operad-curated` (trusted; commit-SHA-pinned
  static index, disabled-by-default until a known-good SHA is committed).
  Authors publish a Claude-Code plugin repo with an optional
  `.operad/operad.toml` sidecar — the adapter merges them. Per-tool
  autonomy caps enforce a source-tier ceiling
  (`AUTONOMY_CAP_VIOLATION` on over-promotion). Uninstall runs a lease
  cascade against tool_leases + agent_schedules
  (`TOOL_HAS_ACTIVE_CONSUMERS`, `--force-revoke` to override). Install
  gates on a daemon-wide ConsumerTracker (OODA cycles, scheduled runs,
  workflow runs all acquire pins). Five-store install transaction
  (SQLite + cache + `~/.claude.json` + `~/.claude/settings.json` +
  in-memory registries) with reverse-order rollback on partial
  failure. Behind `--enable-skills-preview` daemon flag in this
  release; promoted to default-on after the dashboard panel + docs
  ship. New CLI: `tmx skill add|remove|list|info`,
  `tmx tool autonomy list|set`. New REST: `/api/skills`,
  `/api/skills/install`, `/api/skills/<id>/uninstall`,
  `/api/skills/events`, `/api/tool-autonomy`. 53 new tests (251 total
  was 206). Full design spec at
  `docs/superpowers/specs/2026-05-20-skill-marketplace-design.md`;
  end-user docs at `docs/skills.md`.
- **Workflow DAG engine** — new `[[workflow]]` TOML section defines DAG task pipelines (`[[workflow.task]]` entries with `id`, `command`, optional `cwd` / `timeout_s` / `needs` / `on`). Engine implements adjacency-list + in-degree topology with DFS cycle detection and Kahn's-algorithm execution; edge `on` semantics (`success` default, `error`, `always`) gate downstream nodes with skip-propagation. Three new SQLite tables (`agent_workflows`, `agent_workflow_runs`, `agent_workflow_run_nodes`) persist definitions + run history. REST: `GET / POST / DELETE / PATCH /api/workflows[/<name>]`, `POST /api/workflows/<name>/run`, `GET /api/workflows/<name>/runs`. Default `TaskRunner` is `child_process.spawn` with timeout + abort signal; the interface is pluggable so tests inject deterministic fakes. Algorithm adopted (in spirit) from Operit's `core/workflow/WorkflowExecutor.kt`, trimmed to operad's needs — ConditionNode/LogicNode/ExtractNode deferred (operad workflows feed shell commands which already branch via exit-code edges). 15 new tests in `src/__tests__/workflow.test.ts`.
- **Doctor: `git`, `adb`, `sqlite` probes** — `operad doctor` now warns if `git` is missing (branch/commit display will be empty), fails if `[adb] enabled = true` in config but `adb` isn't on PATH (would otherwise hang boot for `connect_timeout_s`), and fails if no SQLite driver is loadable (bun:sqlite when running under bun, otherwise better-sqlite3, otherwise tells you to install bun or rebuild better-sqlite3). The sqlite probe is dual-runtime aware — if doctor runs under node but bun is on PATH, it knows the daemon will spawn under bun and reports OK.
- **Termux:API circuit breaker logs** — when 3 consecutive `termux-api` calls time out the breaker opens for 30 s and silently dropped calls. It now logs a structured `warn` line on open ("dropping all termux-api calls until service recovers") and an `info` line on close ("service responsive again"). Throttled to once per minute so a sustained outage doesn't spam logs.
- **Off-Android `/api/bridge` fast-fail** — every CFC bridge endpoint now returns HTTP 501 with a useful explanation when operad isn't on Termux/Android, pointing users at the Claude for Chrome extension instead of letting the binary search fumble through Termux-shaped paths. Dashboard surfaces the remediation hint inline in the CFC card.
- **Multi-runtime support** — `[[session]] type` now accepts `"opencode"` and `"codex"` alongside `"claude"`. New `SessionRuntime` adapter interface in `src/runtimes/runtime.ts` defines the shape (id, label, startup command, ready patterns, optional timeout/poll override); claude/opencode/codex adapters live next to it. Lifecycle code in `session.ts` dispatches via `getRuntime(type)`, so adding a fourth agent is purely an adapter file. Gemini CLI is intentionally not supported — its stateless one-shot model doesn't fit operad's persistent-session orchestration. 13 new tests in `runtimes.test.ts` pin the adapter contract and per-runtime startup-command semantics.
- **Doctor: per-runtime binary probes** — when `operad.toml` references `type = "opencode"` or `type = "codex"` for any session, doctor now probes `<bin> --version` and emits a fail with platform-specific install hint when the binary's not on PATH. Mirrors the adb probe so first-run users see a clear actionable error instead of a silent boot failure when their agent CLI isn't installed.
- **Dashboard runtime badge** — session rows render an inline `OPENCODE` / `CODEX` chip next to the session name when those runtimes are in use. Subtle accent colours (purple for OpenCode, cyan for Codex). Hidden on the default Claude case so the row stays uncluttered.
- **Config overrides JSON overlay** — new `config-overrides.json` overlay at `<state_dir>/` lets the dashboard's Settings form persist SDK Defaults (effort/thinking/max_budget/model) and quota thresholds without touching the user's TOML. Atomic write via temp-file-then-rename. New `GET /api/config-overrides` and `PATCH /api/config-overrides` endpoints; daemon merges the overlay into SdkBridge config at boot. Settings → SDK Streaming gains a Save button + status line; ten new tests in `config-overrides.test.ts` lock the contract.
- **Multi-runtime config tests** — `config-state.test.ts` extended with parser-level tests covering opencode/codex types, missing-path rejection for agent runtimes, and unknown-type rejection.
- **Memory promotion** (Kai-inspired) — agent context now pins a separate "Core Knowledge" section above the rotating Accumulated Knowledge list. `MemoryDb.getCoreAgentLearnings()` returns the top-N learnings ranked by `reinforcement_count × confidence` with hard floors (default ≥ 3 reinforcements AND ≥ 0.7 confidence). Promoted ids are skipped from the regular list to avoid duplication.
- **Governance dashboard panel** (`GovernancePanel.svelte`) — new Settings section 11 surfaces four agent-governance endpoints that previously had no UI: per-agent **Trust** scores + ledger history, active **Tool Leases** with revoke-all, persistent **Schedules** CRUD (cron + interval, enable/disable, delete), **Consolidation** runs with last-run timestamp + run-now button.
- **Plans aggregation panel** (`PlansPanel.svelte`) — User / Current Project / All Projects tabs with JSON download, mirroring the existing Skills/Hooks/Commands/Subagents/Memories layout. Closes the gap where project-scoped plans were not visible across projects.
- **CLAUDE.md aggregation panel** (`ClaudeMdPanel.svelte`) — same three-tab structure. Memory snapshots (under `~/.claude/projects/{mangled}/memory/*.md`) keep the existing `memory` badge.
- **Agent run output persistence** — `agent_runs` table extended with `prompt`, `response_text`, `thinking_text` columns (idempotent migration via `PRAGMA table_info` introspection). Standalone runs, chat, OODA cycles, roundtables, and scheduled runs all now persist what the agent actually said. New `GET /api/agents/runs/{id}` endpoint returns the full body; the list endpoint serves a 280-char `response_preview` plus `has_more_response` / `has_thinking` flags to keep payloads bounded.
- **Agent panel runs tab** — clicking a run reveals the full prompt (collapsed by default), response text, optional thinking text behind a toggle, and any error. Existing runs from before the migration show as "No response text captured (run may pre-date v0.4.8)".
- **Inactive-session sort + grouping** (`SessionTable.svelte`) — inactive sessions split into **Registered** (defined in `operad.toml`) and **Ad-hoc** subsections, with Registered always on top. New chronological/alphabetical sort toggle (chronological default — recently-active sessions float to the top via `uptime_start` desc, `last_health_check` fallback). Backend now emits `from_config: boolean` per session; older daemons that omit it fall through to the Ad-hoc bucket.
- **`tmx open --new` + GUI "Open another instance"** — Recent Projects rows gain a `+` button next to running/registered entries that posts `?new=1` to `/api/open/<path>`. Default Open button now reuses any existing entry for the same path.
- **`tmx dedupe [--dry-run]` + GUI Dedupe** — collapses duplicate registry/config entries that share a path. Live tmux sessions are never torn down — only stale duplicates are removed. Dashboard exposes a two-step preview-then-apply flow.
- **`launch_package` session field + dashboard launch button** — TOML `[[session]]` blocks can declare an Android package. Session row gains a launch icon that fires the user-facing activity via ADB monkey (preferred) with `am start -n <pkg>/.MainActivity` fallback.
- **Date column + copy-session_id button** in Recent Projects rows.
- **159 tests** (was 87) — new `session-commands.test.ts` (cmdOpen reuse + dedupe + force_new) and `state-transitions.test.ts` (auto-generated coverage of every legal/illegal pair in `VALID_TRANSITIONS`).

### Fixed
- **Governance → Consolidation history showed "undefined" in every count column.** `getConsolidationHistory()` did `SELECT *` on the persisted `consolidation_runs` table (which uses the legacy column names `learnings_reviewed` / `syntheses_created`) and cast the rows as the modern `ConsolidationResult` interface (`learnings_decayed` / `cross_pollinated`). The cast lied silently. Now the read path explicitly remaps legacy → modern, mirroring the inverse mapping the INSERT path has done since v0.4.4. Regression test pinned in `consolidation.test.ts` so the column drift can't recur.
- **MCP and Plugins "Download JSON" buttons rendered the literal text `\u2913`** instead of the ⤓ glyph. Svelte mustaches `{...}` evaluate JS escapes, but bare HTML text content does not — the two earliest header buttons used the unwrapped form. Replaced with the literal character.
- **SessionCard slim**: the expanded session detail's PID/Restarts/Health/Activity/RSS/Started/Error grid duplicated almost everything already shown in the row header (RSS, activity dot, restart count) and the PID column was always "—" because tmux_pid is null on this state path. Trimmed to Health + Started, with Error appearing only when present. Wrapped in a tighter card to stop long error strings overflowing on phones.
- **Action button column clipped on phone viewports.** With the recent 44 px touch-target bump, six action icons no longer fit the desktop-sized 8.5 rem actions column. `.td-actions` is now `display:flex; flex-wrap:wrap; justify-content:flex-end` and the mobile media query drops the column to width:auto, so 6+ buttons reflow to a second line instead of clipping past the table edge. The `.td-expand` cell also gains `max-width:100%; overflow-x:hidden; box-sizing:border-box` plus a `:global(>*)` rule so child components can't punch out the cell width.
- **tmux `=name` exact-match targets** — every `tmux -t <name>` call across `session.ts`, `memory.ts`, `platform/android.ts`, `rest-handler.ts`, and the TermuxService attach script now uses tmux's `=name` exact-match sigil. Without it, `has-session -t foo` matched `foo-2`, which (a) made `sessionExists` lie when suffixed siblings existed, (b) silently routed `kill-session`/`send-keys` to the wrong session, and (c) made `tmx dedupe` misclassify dead canonical entries as live conflicts. 15 call sites fixed; names are validated `[a-z0-9-]+` so prefixing `=` is always safe.
- **`session_id` shell-injection hardening** — registry entries are user-modifiable on disk; the `session_id` field used to be interpolated raw into `claude --resume <id>` over `tmux send-keys`. Now strict UUID-validated on registry load AND at the consumption site. `isValidSessionId()` exported for future call sites.
- **Bare-session `pidAliveCheck` cmdline match** — PIDs are recycled on busy systems; `kill(pid,0)` alone kept dead bare services looking healthy after their PID had been reused. Each check now also reads `/proc/<pid>/cmdline` and demands a marker token derived from the session's spawn command. Best-effort — non-Linux platforms quietly fall back to liveness-only.
- **Touch targets ≥ 44 px on phone viewports** (`@media (max-width: 640px)` in `app.css`). SessionTable rows pack 6–7 icon buttons each; at 28 px they were untappable on a finger pointer.
- **`tmx upgrade` on npm/bun installs** detects the install path and shows ONE matching upgrade command instead of dumping both.

### Deferred
- **SDK + quota config knobs in Settings** — the SDK Defaults form already exists in the dashboard but its `bind:value` targets a `$state` object with no save endpoint, and there's no daemon-side config-mutation surface (TOML writer or runtime override layer). Persisting these from the UI needs that mutation surface designed first; reopen when it lands.

## [0.4.7] — 2026-04-20

Customization aggregation extended beyond hooks and skills. Adds slash commands, subagent definitions, memories, and the cross-tool `AGENTS.md` file (Claude Code + Codex + OpenCode compat). Every type supports User / Current Project / All Projects tabs with JSON download.

### Added
- **Slash commands** (`.claude/commands/*.md`) — new `CommandsPanel.svelte` with User / Current Project / All Projects tabs.
- **Subagent markdown files** (`.claude/agents/*.md`) — new `SubagentsPanel.svelte` for Claude Code's agent registry files.
- **Memories** (`.claude/memories/*.md`) — new `MemoriesPanel.svelte` for user-authored context notes.
- **`AGENTS.md` cross-tool compat** — new `AgentsMdPanel.svelte` with a `consumers` badge row showing which tools read each file (Claude Code, Codex, OpenCode). Subtle info banner links to [agents.md](https://agents.md).
- **Backend**: `/api/customization` response extended with `commands[]`, `agentsMd[]`, `memories[]`, `agentsMdFiles[]`. `/api/customization/all-projects` response extended with the same fields in `user` + per-`projects[]` entries.
- **`$HOME/AGENTS.md`** and **`<project>/AGENTS.md`** added to the file-read/write allowlist.
- **`docs/customization.md`** — new doc explaining what operad scans, where each file lives, and which tools consume it.
- **`docs/api.md` § Customization** rewritten with complete response shapes.

### Notes on OpenCode + Codex
operad surfaces `AGENTS.md` as a first-class cross-tool file — read by Claude Code, Codex, and OpenCode alike. Operad itself still runs tmux sessions; the new view is about making the user's multi-tool config visible in one place. Future work: start sessions targeted at `codex` / `opencode` runtimes and route to the correct tool's config paths on boot.

## [0.4.6] — 2026-04-20

This release focuses on bundle size, real fresh-install proof, runtime hardening, and a hooks/skills aggregation view in the dashboard.

### Added
- **`operad watch`** — live session status in the terminal. Polls the daemon once per second in an alt-screen buffer with color-coded state, uptime, RSS, activity, restart count. Ctrl+C restores the main screen and exits.
- **Dashboard Hooks panel** (`HooksPanel.svelte`) — three tabs (User / Current Project / All Projects), tables with event / matcher / command / timeout columns, and a per-tab "Download JSON" button. Fixes "per-project hooks don't display" and gives a way to export hooks.
- **Dashboard Skills panel** (`SkillsPanel.svelte`) — same three-tab structure for skills.
- **`/api/customization/all-projects`** — new endpoint returning hooks + skills + plans aggregated across every known project (enumerated from Claude's `history.jsonl` via `parseRecentProjects`).
- **Platform-aware `checkTmux()` fix message** — Windows users now see `operad install-tmux` and winget guidance instead of apt/brew/pkg text.
- **CI job `fresh-install-ubuntu`** — removes tmux, installs operadic from packed tarball (simulating `npm i -g operadic`), runs `operad install-tmux -y`, asserts `tmux -V` works, then runs `operad init` + `operad doctor`. First real proof the install story works on a truly fresh machine.
- **CI job `fresh-install-windows`** — asserts `operad install-tmux` (non-interactive path) and `operad doctor` both emit winget guidance.
- **IPC fuzz tests** (`src/__tests__/ipc-fuzz.test.ts`) — 10 scenarios covering malformed JSON, partial messages, binary garbage, concatenated messages, unicode. Confirms the existing 1 MB buffer cap holds.

### Changed
- **Bundle size**: `dist/tmx.js` reduced from **692 KB → 369 KB (-47%)** via esbuild minification with `keepNames: true` (stack traces stay readable).
- **`@anthropic-ai/claude-agent-sdk` moved** from `dependencies` to `optionalDependencies`. Already external in the bundle; this removes the install footprint for users who don't use agentic features.
- **Dashboard visual polish** — consistent typography scale, restored mono font on paths/previews, better spacing in SettingsPanel tables, design-token cleanup in HooksPanel + SkillsPanel. No feature changes.
- **GitHub Actions**: `actions/checkout@v4 → v5`, `actions/setup-node@v4 → v5` across all workflows. Removes the Node.js 20 deprecation warning.

### Fixed
- **SSE backpressure**: slow clients with >1 MB of buffered output now get dropped via `res.destroy()` instead of leaking memory. Max 50 concurrent SSE clients (new connections over cap get 503).
- **`operad doctor` on Windows with `FAIL tmux`** now mentions winget (`arndawg.tmux-windows`) and routes to `operad install-tmux`.

## [0.4.5] — 2026-04-20

### Added
- **Windows tmux install via winget** — `operad install-tmux` and `operad init` now prefer `winget install -e --id arndawg.tmux-windows` on Windows 10 1809+ / Windows 11 (where winget is pre-installed). Falls back to `scoop` then `choco` if on PATH, then MSYS2 manual instructions if no package manager is found.
- **Claude for Chrome extension check** in `operad doctor` on Linux/macOS/Windows — heuristically detects a Chromium-based browser (Chrome, Chromium, Edge, Brave) and surfaces the [extension install URL](https://chromewebstore.google.com/detail/claude-for-chrome/mhlfhmbeohhnidmkdpjmaflpcnhfchck). Warns if no browser detected. This is the desktop equivalent of the Android CFC bridge.

### Changed
- Windows `doctor.ts` tmux-missing fix message now recommends `winget install -e --id arndawg.tmux-windows` when winget is present, before falling back to MSYS2.
- `docs/cfc-bridge.md` now documents the desktop (Chrome extension) path alongside the Android (bridge + Edge Canary) path.

## [0.4.4] — 2026-04-19

### Added
- **`operad install-tmux`** — new CLI command. Detects the platform's package manager (`pkg` on Termux, `brew` on macOS, `apt`/`dnf`/`pacman`/`zypper`/`apk` on Linux) and runs the install with `sudo` when needed. Prompts on TTY; falls through to printed instructions on non-interactive invocations. Windows routes to the MSYS2 install page.
- **`operad init` now offers to install tmux** after writing the config. Keeps the fresh-install flow to a single prompt.
- **`operad boot`/`stream` offers install before forking the daemon** — if tmux is missing and stdin is a TTY, prompts with the platform's package manager command; declines or non-TTY fall through to a clean error.
- 4 new unit tests for pkg-manager detection + availability check.

### Changed
- `operad init` help line clarifies the new flow (config → tmux prompt → run doctor/boot).

## [0.4.3] — 2026-04-19

### Fixed (P0)
- **Daemon silently boots with no tmux**: `Daemon.preflight()` now hard-fails with a multi-platform install hint (`apt`/`brew`/`pkg`/MSYS2). Previously the daemon would start, sessions would silently never boot, and the dashboard looked healthy.
- **`TMUX_BIN` frozen at module load**: Resolved on first call instead — fixes wrong path when tmux is installed late on PATH (MSYS2 on Windows, late Termux pkgs).
- **`operad doctor` dashboard fallback** pointed at `~/git/operad/dashboard/dist` (a developer's local checkout). Removed; npm-installed users now get the correct fix instruction (`bun add -g operadic@latest`).

### Fixed (P1)
- **`bunx operadic` (no args)** now prints help instead of `Daemon not running. Start with: operad stream`.
- **`operad init` template** uses Windows-friendly paths (`%APPDATA%\operad` config dir on Windows; `pathJoin` for the `cwd` example).
- **`operad upgrade`** refuses cleanly on npm installs (no `build.cjs`) with a hint to use `bun add -g operadic@latest` instead of crashing.
- **`migrate.ts`** generated config no longer hardcodes `~/git/termux-tools/tools/adb-wireless-connect.sh` for `connect_script` (was a developer-specific path); empty default now.
- **`/api/bridge` 404 on missing claude-chrome-android**: Previously wrote a startup script pointing at a non-existent file and silently failed via TermuxService intent. Now returns `{ status: 404, fix: "bun add -g claude-chrome-android" }` immediately.
- **Windows `notify()` PowerShell injection** via session-name interpolation. Title and content now passed via env vars (`OPERAD_NOTIFY_TITLE`/`OPERAD_NOTIFY_CONTENT`) — no string interpolation in the heredoc.
- **`isTmuxServerAlive()` swallowed ENOENT**: now writes a stderr diagnostic so a missing tmux is visible.
- **OrchestratorContext.memoryDb / sdkBridge** captured by value at constructor time when both were `null`. Engines reading them post-init saw stale `null`. Converted to lazy getters (`getMemoryDb()` / `getSdkBridge()`); all 6 consumer files updated.

### Added
- **`operad doctor`**: two new Android-only checks
  - `cfc-bridge` — searches global bun + npm install paths for `claude-chrome-android`; warns with install command when missing
  - `edge-canary` — `pm list packages com.microsoft.emmx.canary`; warns with install hint when missing
- **`peerDependenciesMeta`** declares `claude-chrome-android` as an optional peer so `bun i -g operadic` surfaces it
- **`docs/cfc-bridge.md`** — explains what CFC is, install paths, Edge Canary requirements, troubleshooting

### Changed
- **`scripts/fix-android-binaries.mjs`** silent on non-Android (was logging confusing `[fix-android-binaries] Not on Android, skipping.` during every `npm install` on Linux/Mac/Windows)
- Postinstall tries `bun add` before `npm install` for the android-arm64 esbuild binary

## [0.4.2] — 2026-04-19

### Fixed
- **npm publish workflow ENEEDAUTH** — `setup-node@v4` was writing an empty `_authToken=` line to `.npmrc` whenever the (unset) `NPM_TOKEN` secret was referenced. This blocked OIDC trusted-publisher auth. Removed the env var; OIDC now works.
- **Workflow npm version too old for OIDC** — bumped runner to node 24 which ships npm ≥ 11.5.1. Node 22 ships npm 10.x which silently falls back to token auth.
- **README missing from npm tarball** — `package.json` `files` array now explicitly includes `README.md`, `CHANGELOG.md`, `LICENSE`.

## [0.4.1] — 2026-04-19

### Fixed
- **Daemon boot crash**: `loadAutoStopList()` was called in the `Daemon` constructor before `androidEngine` was instantiated, causing "Cannot read properties of undefined (reading 'loadAutoStopList')" on every boot. v0.4.0 users hitting this should upgrade. Discovered by newly-robust e2e test.
- **E2E test silent false-positives**: `src/__tests__/e2e.test.ts` previously used `describe.skipIf(!daemonReady)` + per-test `if (!daemonReady) return` which made every test "pass" when the daemon couldn't start. It now throws in `beforeAll` with full stderr capture if the daemon isn't ready within 20s. Uses a random high-range port and an explicit hermetic config.

### Added
- 30+ new unit tests across three files:
  - `session-resolver.test.ts` — fuzzy name matching, path resolution
  - `config-state.test.ts` — `validateConfig` error shape, `migrateState` idempotency
  - `cli-smoke.test.ts` — `operad --version/init/doctor` exit codes + output format

## [0.4.0] — 2026-04-19

### Added
- `operad doctor` command — diagnoses install issues with colored checklist
- `operad init` command — generates minimal config on fresh install
- `operad switchboard reset` command — resets autonomous feature toggles to new opt-in defaults
- `/help` documentation page in dashboard (core features + agentic layer docs)
- Help links on Switchboard toggles pointing to `/help` anchors
- End-to-end CI test (boots daemon, exercises REST endpoints + dashboard pages)
- First-run CI smoke job (`operad init` + `operad doctor` on fresh HOME)
- API-drift CI check — fails PRs that modify `src/http.ts`/`src/ipc.ts`/`src/rest-handler.ts` without updating `docs/api.md`
- Full REST/SSE/IPC API documentation (`docs/api.md`)
- Full config reference (`docs/config.md`)
- Windows platform support (experimental) — `WindowsPlatform` using `%LOCALAPPDATA%\operad` for state/logs/socket; process info via `tasklist`; battery via WMI; requires MSYS2 tmux or WSL. See `docs/windows.md`.

### Changed
- **BREAKING DEFAULT**: Autonomous features (`cognitive`, `oodaAutoTrigger`, `mindMeld`) now default `false` on fresh installs; all 4 builtin agents default `enabled: false`. Existing installs preserve their settings; a one-time notice on first boot after upgrade explains the change.
- Config validation now prints structured errors with fix instructions and exits 1 on failure
- README restructured: core daemon leads, agentic is opt-in advanced section
- **Architecture: daemon.ts split from 6,523 lines → 1,480 lines (-77%)** across 12 focused modules:
  - `rest-handler.ts` (REST API dispatch) + `src/routes/` (customization, mcp, scripts, adb route handlers)
  - `ipc-handler.ts` (IPC command routing)
  - `ws-handler.ts` (WebSocket message dispatch)
  - `agent-engine.ts` (OODA loop + agent chat + executeOodaActions + scheduled runs)
  - `session-commands.ts` (20 cmd\* IPC command handlers)
  - `android-engine.ts` (ADB + phantom-process fix + auto-stop list + app mgmt)
  - `monitoring-engine.ts` (memory/battery polling + SSE push + status notification)
  - `persistence.ts` (memory consolidation + daily snapshots)
  - `tool-engine.ts` (ToolContext builder)
  - `session-resolver.ts` (pure name/path/open-target resolution + boot-session selection)
  - `orchestrator-context.ts` (shared DI interface, now split into 6 documented sub-interfaces)

### Fixed
- Silent catch blocks in daemon.ts audited — 28 blocks now either have justification comments or emit structured `log.warn`/`log.error`
- `operad doctor`: state dir path corrected to `$HOME/.local/share/tmx` on Android (was mistakenly `$PREFIX/var/lib/tmx`)
- `operad doctor`: Termux probe switched from `termux-info` (always present) to `termux-battery-status` (actually from `termux-api` package)
- `checkDashboard()` uses `realpathSync(__filename)` matching symlink resolution pattern in `tmx.ts`
- SessionController's `restartDelayMs` option was accepted but never applied — now enforced between stop+start in health-failure handling
- Switchboard reference drift: `ctx.switchboard` replaced with `ctx.getSwitchboard()` getter so engines see current state after `updateSwitchboard` replaces the object
- `restartCount` now resets to 0 after a successful restart (was monotone — could mark long-running sessions failed after N successful recoveries over hours)
- State-machine transitions enforced via `VALID_TRANSITIONS` table; invalid transitions log warnings instead of silently succeeding

### Removed
- Dead-infrastructure: `src/session-controller.ts` and its 11 tests. The class was extracted with a design that couldn't cleanly integrate with production. `VALID_TRANSITIONS` in `types.ts` is the real state-machine contract.

## [0.3.0] — 2026-04-15

### Added
- SvelteKit 2 dashboard (migrated from Astro 5)
- Plans management in Settings (view/edit .claude/plans/ files)
- Unit test suite (bun test) — deps, cognitive parser, consolidation
- CHANGELOG.md

### Changed
- Dashboard framework: Astro 5 + Svelte 5 → SvelteKit 2 + Svelte 5
- Adapter-static output to `dist/` (unchanged serving path)

## [0.2.0] — 2026-03-01

### Added
- Platform abstraction layer (Android/Linux/macOS)
- Token quota management (weekly limits, velocity tracking)
- Agentic AI system: 4 built-in agents with OODA cognitive loop
- Agent chat with replay-based multi-turn conversations
- Goal trees, decision journal, strategy versioning
- Memory consolidation engine (decay, prune, merge, cross-pollinate)
- Tool registry with autonomy levels and trust calibration
- Persistent scheduling engine (cron/interval, SQLite-backed)
- Agent state export/import with daily snapshots
- Specialization registry and roundtable protocol
- MCP server management (CRUD via dashboard)
- Plugin marketplace integration
- Conversation viewer with live streaming
- Session timeline events
- Prompt history with search and starring
- Telemetry sink monitoring
- Process manager (Android app kill/force-stop)
- Switchboard for subsystem enable/disable
- Mind meld user profile system
- Cognitive panel (goals, decisions, strategy, messages, growth)

### Changed
- Config section renamed from `[orchestrator]` to `[operad]` (backwards compatible)
- CLI renamed from `tmx` to `operad`

## [0.1.0] — 2025-12-01

### Added
- Initial release
- tmux session orchestration
- TOML configuration with env var expansion
- Health checks and auto-restart
- Web dashboard (Astro + Svelte)
- System memory monitoring
- Battery awareness
- Dependency-ordered boot
