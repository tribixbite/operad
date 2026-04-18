# operad — Claude Code Configuration

## Project Overview
Cross-platform tmux session orchestrator for managing Claude Code sessions. npm package: `operadic`, CLI: `operad`.

**Key value props:**
- Web dashboard for managing skills, memories, prompt history across all projects
- Auto-boot saved projects on startup with dependency ordering
- Full prompt history with search and starring/saving
- Session lifecycle: health checks, auto-restart, memory pressure response, battery awareness

## Architecture

### Source Structure
```
src/
  tmx.ts                  — CLI entry point (~1050 lines)
  daemon.ts               — Main daemon lifecycle (~1790 lines — boot, session start/stop, shutdown, dashboard server)
  agent-engine.ts         — OODA loop, agent dispatch, context builder, chat, executeOodaActions (~800 lines)
  tool-engine.ts          — ToolContext builder for agent tool dispatch (~70 lines)
  persistence.ts          — Memory consolidation + daily snapshots (~95 lines)
  server-engine.ts        — REST/WS/IPC dispatch — ~103 REST routes, WS handler, IPC handler (~2550 lines)
  session-controller.ts   — Session lifecycle state machine (unit-testable)
  session-commands.ts     — cmd* handlers (status/start/stop/restart/go/send/tabs/open/close/etc.) (~780 lines)
  session-resolver.ts     — Pure resolveSessionName/Path/OpenTarget helpers (~95 lines)
  android-engine.ts       — ADB serial resolution, phantom-process fix, auto-stop list, Android apps (~635 lines)
  monitoring-engine.ts    — Memory polling + shedding, battery polling, SSE push, status notification (~440 lines)
  orchestrator-context.ts — Shared dependency interface for extracted engines (~170 lines)
  config.ts               — TOML config parser with env var expansion
  session.ts              — Session lifecycle, tmux interaction (~780 lines)
  http.ts                 — Dashboard HTTP server + SSE + REST API
  ipc.ts                  — Unix socket IPC (newline-delimited JSON)
  health.ts               — Health check engine (tmux/http/process/custom)
  memory.ts               — System memory monitoring via /proc or platform API
  activity.ts             — Per-session CPU tracking via /proc/PID/stat
  battery.ts              — Battery monitoring + radio control
  wake.ts                 — Wake lock management (acquire-only, never release)
  budget.ts               — Android phantom process budget tracking
  state.ts                — State persistence (~/.local/share/tmx/state.json)
  registry.ts             — Dynamic session registry
  log.ts                  — Structured logging + crash-safe trace log
  notifications.ts        — Claude session notification parsing
  claude-session.ts       — Claude readiness detection
  prompts.ts              — Prompt history extraction from Claude JSONL
  migrate.ts              — Legacy config migration
  types.ts                — Type definitions (~530 lines)
  deps.ts                 — Dependency graph (topological sort)
  git-info.ts             — Git repo metadata
  telemetry-sink.ts       — Token usage tracking
  display-types.ts        — Dashboard display types
  import-meta-shim.js     — esbuild CJS inject for import.meta
  platform/
    platform.ts       — Platform interface + detectPlatform() factory
    common.ts         — Shared /proc helpers (android + linux)
    android.ts        — Termux-specific implementations
    linux.ts          — Desktop Linux implementations
    darwin.ts         — macOS implementations
```

### Build System
- **Bundle**: esbuild → `dist/tmx.js` (~113KB CJS)
- **Build command**: `bun run build` (runs `node build.cjs` — NOT `bun build.cjs`)
- **Typecheck**: `bun run typecheck`
- **Format**: CJS (not ESM — TLA not supported, ws package breaks ESM output)
- **import.meta shim**: `import-meta-shim.js` injected by esbuild to provide `import.meta.url` in CJS
- **Runtime**: `bun` (shebang `#!/usr/bin/env node`, works with both bun and node)

### Dashboard
- **Stack**: SvelteKit 2 + Svelte 5 + Tailwind v4 (migrated from Astro 5; adapter-static, SPA mode)
- **Location**: `dashboard/`
- **Build**: `cd dashboard && bun install && node scripts/fix-android-binaries.mjs && bun run build`
- **Served by**: `http.ts` DashboardServer on port 18970
- **Pages**: Overview, Memory, Logs, Settings, Telemetry
- **Components**: `dashboard/src/lib/components/`; routes: `dashboard/src/routes/`
- **SSE client**: shared store in `store.svelte.ts` (Svelte 5 `$state` pattern)

### Landing Page
- **Stack**: Astro 5 + Tailwind v4
- **Location**: `site/`
- **Domain**: operad.stream (GitHub Pages)
- **Deploy**: `.github/workflows/deploy-site.yml` on push to main (paths: site/**)

### Config
- **File**: `~/.config/operad/operad.toml` (TOML with `$ENV_VAR` expansion)
- **TOML sections**: `[operad]` (also accepts `[orchestrator]` for backwards compat), `[[session]]`, `[battery]`
- **State**: `~/.local/share/tmx/state.json`
- **IPC socket**: platform-dependent (`$PREFIX/tmp/tmx.sock` on Android, `/tmp/operad.sock` on Linux)

## Build & Test

```sh
# Install deps
bun install

# Build CLI bundle
bun run build

# Typecheck
bun run typecheck

# Build dashboard
cd dashboard && bun install && bun run build && cd ..

# Build landing page
cd site && bun install && bun run build && cd ..

# Run locally (symlink approach)
ln -sf ~/git/operad/dist/tmx.js ~/.local/bin/tmx
chmod +x dist/tmx.js
tmx boot
```

## CI/CD

- **CI**: `.github/workflows/ci.yml` — ubuntu-latest + macos-latest matrix (typecheck + build + smoke test)
- **Publish**: `.github/workflows/publish.yml` — npm publish with OIDC provenance on GitHub release
- **Site deploy**: `.github/workflows/deploy-site.yml` — GitHub Pages on push to site/**
- **Trusted publishing**: Configured on npmjs.com (repo: tribixbite/operad, workflow: publish.yml)

## Code Conventions

- TypeScript for all source, strict mode
- ES module syntax in source (esbuild bundles to CJS)
- `async/await` over Promise chains
- Platform-specific code goes in `src/platform/`, never in consumer modules
- Config uses snake_case (TOML convention)
- Types in `types.ts`, display-only types in `display-types.ts`
- Crash-safe trace log: `appendFileSync` (no open FD), HH:MM:SS.mmm timestamps
- Session state machine: pending → waiting → starting → running ⇄ degraded → failed / stopping → stopped

## Critical Rules

- **Wake lock**: Acquire-only, NEVER release. `termux-wake-unlock` causes Android to kill processes.
- **IPC isRunning() timeout**: Returns `true` (busy), NOT `false` (dead). Only ECONNREFUSED/ENOENT delete socket.
- **Watchdog**: Must NOT delete socket before boot. Let `isRunning()` handle stale detection.
- **LD_PRELOAD on Termux**: Bun's glibc runner strips it. `cleanEnv()` re-injects, `ensureTmuxLdPreload()` sets via tmux.
- **esbuild android binary**: `node build.cjs` (not `bun build.cjs`). Bun's platform detection rejects the android binary.
- **tmux spawnSync**: Use array args, not string concatenation. No shell quoting needed.
- **Symlink resolution**: Use `realpathSync(__filename)` to resolve repo root from symlinked `~/.local/bin/tmx`.
- **Nested CC detection**: Daemon strips `CLAUDECODE`, `CLAUDE_CODE_*`, `ENABLE_CLAUDE_CODE_*`, `CLAUDE_TMPDIR` from env.
- **SSE connection limit**: Close EventSource on `beforeunload`/`pagehide` to avoid exhausting 6-per-origin limit.

## Commit Style

- Conventional commits (feat/fix/chore/ci/docs)
- Sign with emdash + model version, no "Co-Authored-By: Claude"
- Never push without explicit permission
