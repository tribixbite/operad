# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
