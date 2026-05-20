# Skill / plugin marketplace — design spec

Date: 2026-05-20
Status: draft (pre-implementation)
Owner: tribixbite
Reviewers: gemini-3-pro-preview (round 1)

## 1 — Goal

Give `operad` users an "Obtainium-style" multi-source aggregator for installing
bundles of tools, agents, workflows, and SKILL.md context produced by the wider
ecosystem (Anthropic's `claude-plugins-official`, third-party plugin
marketplaces like `wshobson/agents`, the official MCP registry, smithery, and
arbitrary git URLs). Installation is one command. The daemon hot-loads new
primitives without restart. Trust is graded by source. No central registry
operad has to keep online for the system to work; the curated index at
`operad.stream/skills` is one source among many.

## 2 — Non-goals

- Inventing a new package format competing with `.claude-plugin/marketplace.json`.
- Acting as a registry-of-registries publisher requiring a server we own.
- Runtime capability sandboxing (Termux makes this theatre — autonomy buckets
  do the real work).
- Scraping closed-API platforms (e.g. Tessl, mcp.so) until they ship public
  JSON APIs.
- Re-implementing MCP transport semantics; operad orchestrates lifecycle but
  the protocol is owned by the MCP spec.

## 3 — Locked decisions (with rationale)

### 3.1 Scope of a "skill"

A skill is a bundle that may contain any combination of:

- **Tools** — operad `[[tool]]` definitions (shell command + parameter schema).
- **Agents** — `[[agent]]` definitions (specialization, prompts, personality).
- **Workflows** — `[[workflow]]` DAGs (see `src/workflow.ts`).
- **MCP servers** — same shape as `~/.claude.json` `mcpServers` entries, with
  an operad-side lifecycle hint (`config-only` | `proxied` | `gateway`).
- **SKILL.md bundles** — Anthropic Agent Skills, with optional `scripts/`,
  `references/`, `assets/` subdirectories.

A skill may also be empty of operad-specific content if it's a pure
Claude-Code plugin we're aggregating for discovery.

### 3.2 Distribution model

operad is an **aggregator/resolver**, not a single registry. Modelled on
Obtainium: each installed skill carries a `Source` record describing which
provider resolved its identity and how to refetch / check for updates.

### 3.3 Manifest split (pivot from Gemini round 1)

Authors publish **two files** in the same repo / bundle:

1. `.claude-plugin/marketplace.json` — Anthropic's plugin format, untouched.
   Claude Code consumes this directly. operad's adapter reads it for
   skills / MCPs / commands / hooks / agents.
2. `operad.toml` — operad-native primitives (tools, agents in operad's richer
   shape, workflows, autonomy hints, mcp-lifecycle flags).

The adapter merges them at read time. Authors who only target Claude Code
publish (1) only; authors who want operad's full surface publish both.

**This replaces the earlier "stuff workflows into `metadata.operad.*`"
strategy** which Gemini correctly flagged as schema abuse — Anthropic is
free to add strict marketplace validation without operad needing to
unwedge any deployed plugin.

### 3.4 Trust model

Two cooperating mechanisms, both already implemented in operad:

- **Autonomy buckets** — every tool a skill ships is registered with the
  ToolExecutor in the `suggest` bucket by default (already a Phase-10B
  primitive). User must promote each tool to `autonomous` for it to fire
  without confirmation.
- **Source-tier install prompts** — three trust tiers:
  - `trusted`: `claude-marketplace` resolved to
    `anthropics/claude-plugins-official`, `mcp-official`, or
    `operad-curated`. Installs silently into `suggest`.
  - `community`: `smithery`, `claude-marketplace` resolved to anything
    else. Installs after confirmation showing the manifest. Lands in
    `suggest`.
  - `escape`: `git+url` or `github-topic` (when shipped). Installs after
    detailed confirmation including the manifest diff vs. a previous
    install. Lands in `observe` — every tool call requires confirmation
    until the user promotes.

The autonomy default per skill can be overridden in `operad.toml` for
authors who genuinely want a `autonomous`-by-default tool (e.g. a
read-only `git status` wrapper) — but the source tier always caps the
ceiling.

### 3.5 MCP server lifecycle (pivot from Gemini round 1)

Three modes, declared in `operad.toml` under `[mcp.<name>]`:

- `config-only` (default) — operad writes the server block to
  `~/.claude.json`. Claude Code spawns it. operad does nothing at
  runtime. Suitable for stdio MCPs Claude Code already manages.
- `proxied` — operad spawns AND owns the process. operad exposes an HTTP
  proxy endpoint; the entry written to `~/.claude.json` points at the
  proxy, NOT at the raw subprocess. **Exactly one process exists, even
  if Claude Code and operad's OODA agents both call it.** Eliminates the
  "two orchestrators fighting over one binary" failure mode.
- `gateway` — for stateless HTTP / streamable MCPs (per the MCP 2026
  spec direction). No daemon-owned long-running process; operad acts as
  a thin router and forwards requests to the URL on demand. `~/.claude.json`
  points at operad's gateway. Future-proofs against the transport shift.

### 3.6 Single-writer principle (pivot from Gemini round 1)

The CLI never writes to the skills SQLite tables or the cache directory.
`tmx skill add <id>` sends an IPC `skill.install` request to the daemon.
The daemon performs:

1. Resolver dispatch → fetch → extract.
2. Adapter normalization → `OperadSkill` shape.
3. DB write + cache layout.
4. Runtime loader registration + ack to CLI.

This avoids SQLITE_BUSY, partial-JSON reads, and TOCTOU races between CLI
and daemon. The CLI is a thin client.

### 3.7 Hot-load mechanism

The daemon's install handler updates in-memory tool/agent/workflow registries
synchronously as part of the install transaction. No filesystem watcher. No
restart. Failure rolls back the in-memory registration before acking.

The dashboard's `/api/skills` SSE channel emits state transitions
(`installing` → `installed` / `failed`) for live UI updates.

### 3.8 Disk layout (pivot from Gemini round 1)

```
~/.local/share/operad/skills/
  index.db                                        # SQLite — see schema below
  cache/
    <provider>/
      <sanitized-locator>/
        <version>/
          .claude-plugin/marketplace.json         # if present
          plugin.json                             # if present
          skills/<name>/SKILL.md + bundle         # if present
          operad.toml                             # if present
          checksum                                # sha256 of bundle
```

**No symlinks.** `~/.claude.json` entries written by operad use absolute paths
into the cache. Avoids Android scoped-storage / FUSE breakage when users
keep their Claude config on `/storage/emulated/0`.

SKILL.md bundles are surfaced to Claude Code by writing absolute-path entries
into a `~/.claude/settings.json` `skills` field (per the Claude Code skills
spec — operad reads the path conventions from agentskills.io). If that
mechanism isn't supported in a user's Claude Code version, operad falls back
to writing the SKILL.md content into the agent context directly.

### 3.9 Day-1 providers (5)

| Provider | Locator example | Trust tier | Notes |
|---|---|---|---|
| `claude-marketplace` | `wshobson/agents` | `community` (or `trusted` for `anthropics/*`) | Reads `.claude-plugin/marketplace.json` + plugin bundles via git clone. Tag-pinned. |
| `mcp-official` | `exa-search` | `trusted` | `registry.modelcontextprotocol.io/v0.1/servers`. API freeze means safe to ship. |
| `smithery` | `@exa/exa-mcp` | `community` | `registry.smithery.ai/servers`. 5k+ entries. `useCount` used for ranking in the dashboard search. |
| `operad-curated` | `operad/git-tools` | `trusted` | Static `index.json` hosted at `operad.stream/skills/index.json` (GitHub Pages). PR-to-add. |
| `git+url` | `https://github.com/foo/bar@v1.0` | `escape` | Plain git clone with tag pin. Universal escape hatch. |

Deferred to v1.1 / later:

- `github-topic` — high-discovery but high-malware-risk. Defer until trust UX is
  proven and we can add a per-result detailed confirm prompt.
- `awesome-list` — markdown scraping fragility. Add only if the curated index
  + git+url combo proves too narrow.
- `tessl` — no public API. Skip until they ship one.
- `huggingface-spaces` — promising for MCP-tagged Gradio spaces; defer to v1.1.

### 3.10 Update model

- `tmx skill list` shows pinned vs. latest available (resolver runs a HEAD
  check per source).
- `tmx skill update <name>` — explicit per-skill update.
- `tmx skill update --all` — resolve all sources, install newer versions side
  by side in `cache/<provider>/<locator>/<new-version>/`, atomically switch
  the active version pointer in the DB, run the runtime loader, keep old
  version for rollback.
- No auto-update by default. Optional opt-in via `[skills.auto_update]` in
  `operad.toml` config — daily check, install-on-tag-bump only (never on
  branch HEAD).

## 4 — Architecture

### 4.1 Layers

```
                  ┌────────────────────────────────────────────┐
   Dashboard /    │           SkillManager (state, in daemon)   │
   CLI commands ──IPC▶  installed skills · enabled/disabled    │
                  │  per-skill autonomy bucket · update state   │
                  └──────────────────┬─────────────────────────┘
                                     │
        ┌────────────────────────────┼──────────────────────────┐
        │                            │                          │
        ▼                            ▼                          ▼
  ┌──────────┐                ┌────────────┐              ┌──────────┐
  │ Resolver │  ── pluggable ─│  Adapter   │── normalize ─│  Runtime │
  │ (locator │     providers  │  (manifest │   to operad  │ Loader   │
  │ → fetch) │                │  → skill)  │   internal   │ (apply)  │
  └──────────┘                └────────────┘              └──────────┘
        │                            │                          │
        │                            │                          ▼
        │                            │                  registers tools,
        │                            │                  agents, workflows
        │                            │                  with running daemon
        ▼                            │                  (hot-load, no restart)
   ┌─────────────────────────────────┼───┐
   │  Providers (day-1, plug-in arch)│   │
   │  • claude-marketplace           │   │
   │  • mcp-official                 │   │
   │  • smithery                     │   │
   │  • operad-curated               │   │
   │  • git+url                      │   │
   └─────────────────────────────────────┘
```

### 4.2 Internal canonical shape

```typescript
// src/skills/types.ts (new file)

export type Provider =
  | "claude-marketplace"
  | "mcp-official"
  | "smithery"
  | "operad-curated"
  | "git+url";

export type TrustTier = "trusted" | "community" | "escape";

export type McpLifecycle = "config-only" | "proxied" | "gateway";

export interface SkillSource {
  provider: Provider;
  locator: string;          // owner/repo, smithery name, etc.
  version: string;          // tag, commit, or "latest"
  fetched_url: string;      // fully resolved url, for audit
  fetched_at: number;       // unix epoch
  fetched_sha256: string;   // sha256 of the bundle tarball/zip
}

export interface OperadSkill {
  id: string;               // <provider>:<sanitized-locator>@<version>
  name: string;
  description: string;
  source: SkillSource;
  trust_tier: TrustTier;
  enabled: boolean;
  autonomy_default: "observe" | "suggest" | "autonomous";

  // Primitive bundles — any subset
  tools?: TomlToolConfig[];
  agents?: AgentConfig[];
  workflows?: WorkflowConfig[];
  mcps?: SkillMcpEntry[];
  skill_mds?: SkillMdEntry[];
}

export interface SkillMcpEntry {
  name: string;
  command?: string;         // stdio
  args?: string[];
  env?: Record<string, string>;
  url?: string;             // http / streamable
  lifecycle: McpLifecycle;
}

export interface SkillMdEntry {
  name: string;
  bundle_path: string;      // absolute path into cache
  frontmatter: Record<string, unknown>;
}
```

### 4.3 SQLite schema

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,                     -- <provider>:<locator>@<version>
  name TEXT NOT NULL,
  description TEXT,
  provider TEXT NOT NULL,
  locator TEXT NOT NULL,
  version TEXT NOT NULL,
  fetched_url TEXT NOT NULL,
  fetched_sha256 TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  trust_tier TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  autonomy_default TEXT NOT NULL DEFAULT 'suggest',
  manifest_json TEXT NOT NULL,             -- full OperadSkill serialized
  installed_at INTEGER NOT NULL,
  UNIQUE(provider, locator, version)
);

CREATE INDEX idx_skills_provider_locator
  ON skills(provider, locator);

-- Installed-version pointer per (provider, locator). When updating, the new
-- version inserts a row; the pointer swap is a one-statement update so the
-- runtime loader sees an atomic switch.
CREATE TABLE skill_active_version (
  provider TEXT NOT NULL,
  locator TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (provider, locator),
  FOREIGN KEY (provider, locator, version) REFERENCES skills(provider, locator, version)
);

-- Records installation events for the dashboard timeline / undo.
CREATE TABLE skill_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  event_type TEXT NOT NULL,                -- install | update | enable | disable | uninstall | error
  detail TEXT,                             -- json
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

CREATE INDEX idx_skill_events_occurred ON skill_events(occurred_at DESC);
```

### 4.4 Source code layout

```
src/skills/
  index.ts          — public SkillManager class (daemon-side)
  types.ts          — shared types
  resolver.ts       — locator → fetch (provider dispatch)
  adapter.ts        — manifest → OperadSkill (provider dispatch)
  loader.ts         — apply / unapply to running daemon
  store.ts          — sqlite + cache disk layout
  providers/
    claude-marketplace.ts
    mcp-official.ts
    smithery.ts
    operad-curated.ts
    git-url.ts
  mcp/
    proxy.ts        — proxied lifecycle subprocess + http proxy
    gateway.ts      — gateway lifecycle stateless router
```

### 4.5 Provider interface

```typescript
export interface ProviderModule {
  id: Provider;
  trustTier(locator: string): TrustTier;

  // List available skills (used by dashboard search). May paginate.
  list(opts: { query?: string; cursor?: string; limit?: number }): Promise<{
    items: ProviderListing[];
    next_cursor?: string;
  }>;

  // Fetch + extract a specific skill version. Returns the path to the
  // extracted directory in the cache.
  fetch(locator: string, version: string, cacheDir: string): Promise<{
    extracted_path: string;
    resolved_version: string;     // when locator says "latest", what was that?
    fetched_url: string;
    fetched_sha256: string;
  }>;

  // Read whatever manifests exist in the extracted directory and normalize to
  // OperadSkill. Adapter for the provider's native format.
  read(extracted_path: string): Promise<Omit<OperadSkill, "id" | "source" | "trust_tier" | "installed_at" | "enabled" | "autonomy_default">>;

  // Lightweight HEAD check for updates. Returns the latest version string
  // available, without fetching the bundle.
  latest(locator: string): Promise<string>;
}
```

## 5 — IPC + REST surface

### 5.1 IPC commands (daemon ↔ CLI)

```
skill.install <provider> <locator> [<version>=latest] [--force]
skill.uninstall <provider> <locator>
skill.update <provider> <locator>
skill.update_all
skill.list [--provider=<p>]
skill.search <query> [--provider=<p>]
skill.enable <provider> <locator>
skill.disable <provider> <locator>
skill.set_autonomy <provider> <locator> <bucket>
```

The CLI is a thin wrapper that sends these messages and renders the JSON
responses. No DB or cache access on the CLI side.

### 5.2 REST API (dashboard)

```
GET    /api/skills                          list installed
GET    /api/skills/<id>                     get one
POST   /api/skills/install                  { provider, locator, version?, force? }
POST   /api/skills/<id>/enable
POST   /api/skills/<id>/disable
POST   /api/skills/<id>/uninstall
POST   /api/skills/<id>/update              install latest if newer
GET    /api/skills/search                   { provider?, q }
GET    /api/skills/events                   recent events (timeline)
GET    /api/skills/sse                      live state stream
```

### 5.3 CLI surface

```sh
tmx skill add <provider>:<locator>[@<version>]
tmx skill add <github-url>            # → git+url provider, version = tag at HEAD
tmx skill remove <provider>:<locator>
tmx skill list [--provider=<p>]
tmx skill search <query> [--provider=<p>]
tmx skill update [<provider>:<locator> | --all]
tmx skill enable <provider>:<locator>
tmx skill disable <provider>:<locator>
tmx skill autonomy <provider>:<locator> <bucket>
tmx skill info <provider>:<locator>   # show manifest, source, autonomy
```

## 6 — Author workflow

```
my-plugin/
  .claude-plugin/marketplace.json    # claude-plugin native, unchanged
  plugin.json                        # claude-plugin per-plugin manifest
  skills/
    my-skill/SKILL.md
    my-skill/scripts/...
  commands/
    my-command.md                    # claude-plugin command
  agents/
    my-agent.md                      # claude-plugin agent (subagent)
  operad.toml                        # operad-specific tools/agents/workflows/mcps
```

Publishing checklist:

1. Repo on GitHub. Tag releases with semver.
2. Optional: add `topic:claude-code-plugin` or `topic:operad-skill` for
   discoverability under `github-topic` later.
3. Optional: PR to `operad-stream/skills` repo to be listed in
   `operad-curated`.

Users install with `tmx skill add github.com/me/my-plugin@v1.0.0` or
`tmx skill add operad-curated:me/my-plugin` once curated.

## 7 — Failure modes addressed

### 7.1 Zombie port lock (Gemini round 1)

When operad manages an MCP (`proxied` mode), `~/.claude.json` points to
operad's proxy endpoint — NOT the raw stdio subprocess. Only one process
exists per MCP. If the subprocess dies, operad notices via the same
process-supervision machinery that handles `service` sessions, restarts it,
and the proxy endpoint stays stable for Claude Code. No port collision.

### 7.2 SQLITE_BUSY / partial-read races

CLI is a pure IPC client. Daemon is the sole writer. SkillManager
serialises install transactions on a per-skill mutex. Cache directory
writes happen to a `<version>.tmp` directory and atomically rename to
`<version>` after sha256 verification.

### 7.3 Schema collision with Anthropic

We do not extend `marketplace.json` or `plugin.json`. operad-specific
content lives in a sibling `operad.toml`. If Anthropic adds strict
validation, plugin authors that target both ecosystems are unaffected.

### 7.4 Termux symlink failures

Zero symlinks. All references between the cache and Claude Code's view of
the world go through absolute paths in `~/.claude.json` and
`~/.claude/settings.json`.

### 7.5 Android OOM-kill of managed MCPs

`proxied` MCP processes are tracked by the existing monitoring engine
(memory polling, restart-on-failure). When Android kills the subprocess,
operad respawns it within the same proxy endpoint; in-flight requests
return 503 with a retry hint. Heavy MCPs that are likely to be killed
should be marked `gateway` (no resident process at all).

### 7.6 Untrusted skill installs

`escape`-tier installs land in `observe` bucket, requiring user
confirmation on every tool call. `community` tier requires installation
confirmation but trusts the tool calls at the `suggest` level. `trusted`
tier installs silently. No skill ever gets `autonomous` by default — that
promotion is always explicit.

## 8 — Testing strategy

- Unit tests for each provider's `list` / `fetch` / `read` / `latest` with
  recorded fixtures (no network in CI).
- Unit tests for the adapter merging `marketplace.json` + `operad.toml`.
- Unit tests for SkillManager install/uninstall/update transactions
  (including rollback on failure).
- Integration test: install a fixture skill via IPC, verify tools/agents/
  workflows are registered, run a workflow that uses a tool from the skill,
  uninstall, verify everything is deregistered.
- Integration test for `proxied` MCP: start an echo MCP via proxy, send a
  request, kill the subprocess mid-flight, verify auto-restart and
  request-side 503-then-retry semantics.
- Property test for the cache-directory atomic-rename logic — random crash
  injection between extract and rename.

## 9 — Implementation phases

### Phase A — internal plumbing (no provider-specific code)
1. SQLite schema migration.
2. `SkillManager`, `types`, `store`.
3. IPC handlers.
4. Runtime loader (apply/unapply to running ToolExecutor / AgentEngine /
   WorkflowEngine).
5. Adapter merge logic + `operad.toml` parser.
6. Unit tests for the above.

### Phase B — providers
7. `claude-marketplace` (most leverage — covers anthropics/skills,
   wshobson/agents, etc).
8. `git+url` (escape hatch).
9. `operad-curated` (the static index — also needs a one-time site/
   addition).
10. `mcp-official` (registry API).
11. `smithery` (registry API).
12. Provider unit tests with fixtures.

### Phase C — MCP lifecycle
13. `config-only` mode (writes `~/.claude.json`).
14. `proxied` mode (subprocess + http proxy).
15. `gateway` mode (stateless router).

### Phase D — UX
16. REST endpoints + SSE channel.
17. Dashboard `SkillManager.svelte` panel: list, search, install, autonomy.
18. CLI `tmx skill` subcommands.
19. Docs in `docs/skills.md`.
20. CHANGELOG, README, landing-page entries.

### Phase E — hardening
21. Property tests for cache atomic rename.
22. Integration test for end-to-end install/use/uninstall.
23. Doctor probes: validate `~/.claude.json` consistency with installed
    `mcps`.

## 10 — Future work (out of scope for v1)

- `github-topic` provider with detailed confirm prompts.
- `huggingface-spaces` MCP-filtered provider.
- `tessl` adapter once they ship a public API.
- Auto-update on a daily cron.
- Signed manifests (sigstore / cosign style).
- Per-tool autonomy promotion via the dashboard (one toggle per tool, not
  per skill).
- "Skill packs" — curated collections of skills installed together.
