# Skill / plugin marketplace — design spec

Date: 2026-05-20
Status: draft (round 2 — post-reviewer-2 pivots)
Owner: tribixbite
Reviewers: gemini-3-pro-preview (round 1), high-thinking subagent (round 2)

## 1 — Goal

Give `operad` users an "Obtainium-style" multi-source aggregator for installing
bundles of tools, agents, workflows, and SKILL.md context produced by the wider
ecosystem (Anthropic's `claude-plugins-official`, third-party plugin
marketplaces like `wshobson/agents`, the official MCP registry, and arbitrary
git URLs). Installation is one command. The daemon hot-loads new primitives
without restart, with carefully-scoped guarantees about in-flight work. Trust
is graded by source. No central registry operad has to keep online for the
system to work; the curated index at `operad.stream/skills` is one source
among many.

## 2 — Non-goals

- Inventing a new package format competing with `.claude-plugin/marketplace.json`.
- Acting as a registry-of-registries publisher requiring a server we own.
- Runtime capability sandboxing — Termux makes this theatre. Autonomy buckets
  do the real work.
- Scraping closed-API platforms (Tessl, mcp.so) until they ship public JSON
  APIs.
- Re-implementing MCP transport semantics; operad orchestrates lifecycle but
  the protocol is owned by the MCP spec.
- **`proxied` MCP multiplexing** — round-2 review caught that wedging an
  HTTP shim in front of a stdio MCP breaks sampling / elicitation / roots
  and requires a non-trivial per-session multiplexer. Cut from v1. Revisit
  after MCP 2026-06 lands and there is a real-world need.
- **MCP Tasks primitive** (June 2026 spec) — out of scope for v1. `gateway`
  mode is request/response only; Tasks support is a v1.1 follow-up that may
  require a new `task-gateway` mode.
- **Auto-update on a schedule** — every iteration of the design has had a
  daily-cron knob; every reviewer has wanted it cut for v1 scope-creep
  reasons. Cut, period. Per-skill manual update only.

## 3 — Locked decisions

### 3.1 Scope of a "skill"

A skill is a bundle that may contain any combination of:

- **Tools** — operad `[[tool]]` definitions (shell command + parameter schema).
- **Agents** — `[[agent]]` definitions (specialization, prompts, personality).
- **Workflows** — `[[workflow]]` DAGs (see `src/workflow.ts`).
- **MCP servers** — same shape as `~/.claude.json` `mcpServers` entries, plus
  a `lifecycle` flag (`config-only` | `gateway`). `proxied` was cut from v1.
- **SKILL.md bundles** — Anthropic Agent Skills, with optional `scripts/`,
  `references/`, `assets/` subdirectories.

A skill may also be empty of operad-specific content if it's a pure
Claude-Code plugin we're aggregating for discovery.

### 3.2 Distribution model

operad is an **aggregator/resolver**, not a single registry. Modelled on
Obtainium: each installed skill carries a `Source` record describing which
provider resolved its identity and how to refetch / check for updates.

### 3.3 Manifest split

Authors publish **two files** in the same repo / bundle:

1. `.claude-plugin/marketplace.json` — Anthropic's plugin format, untouched.
   Claude Code consumes this directly. operad's adapter reads it for
   skills / MCPs / commands / hooks / agents.
2. `.operad/operad.toml` — operad-native primitives (tools, agents,
   workflows, mcp-lifecycle flags). The path is `.operad/` (not bare
   `operad.toml` at repo root) to keep the root clean and to give
   Anthropic room to extend their loader's repo-root scan without
   colliding with operad files. The adapter searches `.operad/operad.toml`
   first, then bare `operad.toml`, then gives up.

The adapter merges them at read time. Authors who only target Claude Code
publish (1) only; authors who want operad's full surface publish both. CI
in operad-curated includes a smoke test that runs `claude plugin install`
on a fixture skill with `.operad/` present, verifying claude-code ignores
the sibling directory cleanly. If the smoke test ever fails, we have
upstream conversation to start, not silent breakage.

This replaces the round-1 "stuff workflows into `metadata.operad.*`"
strategy which would have been schema abuse.

### 3.4 Trust model

Two cooperating mechanisms.

**Autonomy buckets.** Every tool a skill ships is registered with the
ToolExecutor in the `suggest` bucket by default (existing Phase-10B
primitive). User must promote each tool to `autonomous` for it to fire
without confirmation.

**Source-tier install prompts.** Three trust tiers:

- `trusted` — `claude-marketplace` resolved to
  `anthropics/claude-plugins-official`, `mcp-official`, or
  `operad-curated`. Installs silently. Default autonomy: `suggest`.
- `community` — `claude-marketplace` resolved to anything else (community
  plugin marketplaces). Installs after confirmation showing the manifest.
  Default autonomy: `suggest`.
- `escape` — `git+url`. Installs after detailed confirmation including
  the manifest diff vs. any previous install. Default autonomy: `observe`.

**Autonomy ceiling — net-new work.** Round-2 review correctly flagged
that the existing code has *one* bucket per tool, not a max-bucket. The
ceiling is implemented as part of this work, not assumed:

- New `tool_autonomy_caps` table: `(tool_id, max_bucket)`.
- ToolExecutor's promotion API consults the cap; dashboard UI disables
  forbidden promotions; CLI `tmx tool autonomy <id> <bucket>` rejects
  promotions above the cap with a clear error.
- `escape`-tier skills set cap = `suggest`; `community`/`trusted` cap =
  `autonomous`. The cap is per-source-tier, recorded at install, never
  raised retroactively when re-installed from a different provider.
- Skill manifests cannot lower the cap to autonomous — only the source
  tier sets the ceiling. Author-supplied autonomy overrides cut entirely
  to remove the footgun.

### 3.5 MCP server lifecycle

Two modes, declared in `.operad/operad.toml` under `[mcp.<name>]`. `proxied`
mode (round-1 design) was **cut** per round-2 review — wedging HTTP in
front of stdio breaks sampling/elicitation/roots, two clients can't share
one stdio session, and the multiplexer needed to make this work would be
a substantial sub-project by itself.

- `config-only` (default) — operad writes the server block to
  `~/.claude.json`. Claude Code spawns it. operad does nothing at
  runtime. Suitable for stdio MCPs Claude Code already manages.
- `gateway` — for stateless HTTP / streamable MCPs (per MCP 2026-06
  transport direction). No daemon-owned long-running process. operad
  records the URL and writes a `type: "http"` (or `"sse"`) entry into
  `~/.claude.json`. `gateway` is currently just a config-write helper
  for HTTP MCPs — a future v1.1 might add real proxy logic to support
  request retries, auth header injection, or audit logging, but v1
  treats it as a thin "MCP-is-an-HTTP-URL" record.

**`~/.claude.json` writes** are read-modify-write under a `flock`-based
advisory lock on `~/.claude.json.lock`. On platforms without flock
(Windows), we use `proper-lockfile`. operad never blind-overwrites; it
parses, surgically updates the `mcpServers` block under a top-level
`operad_managed` array of names so we know what we own vs. what the user
hand-added, and writes via temp-file-then-rename. If parsing fails, the
install aborts with a typed error — operad does not touch a malformed
`~/.claude.json`.

### 3.6 Single-writer principle

The CLI never writes to the skills SQLite tables, the cache directory,
or `~/.claude.json`. `tmx skill add <id>` sends an IPC `skill.install`
request to the daemon. The daemon performs:

1. Resolver dispatch → fetch → extract.
2. Adapter normalization → `OperadSkill` shape.
3. DB write + cache layout.
4. Runtime loader registration.
5. Ack to CLI.

This avoids SQLITE_BUSY, partial-JSON reads, and TOCTOU races between CLI
and daemon. The CLI is a thin client. Even read-only operations (`tmx
skill list`, `tmx skill info`) go through IPC — never direct DB reads —
so future write-through paths inherit the same transactional guarantees.

### 3.7 Hot-load and generation-counter discipline

Round-2 review caught a critical race: in-flight workflow runs reference
live tool/agent registries. A naïve "swap the version pointer and re-
register the new primitives" approach silently corrupts a running workflow
whose next node lands on a renamed parameter or a removed tool.

Mechanism:

- ToolExecutor, AgentEngine, and WorkflowEngine each expose a monotonic
  `generation` counter. Each registration writes its primitives into a
  generation-tagged shadow map: `tools[generation] = {...}`.
- The current "live" generation is a single pointer (`current_generation`).
- A workflow run snapshots `current_generation` at start. Every tool
  lookup during the run resolves against `tools[snapshot_gen]`, not the
  live pointer. The snapshot generation is refcounted; oldest generations
  are GC'd only when refcount = 0.
- Skill install / update / uninstall:
  1. Build a new generation-tagged primitive map (current + delta).
  2. Atomically swap `current_generation` to the new value.
  3. New workflow runs pin the new generation; in-flight runs continue
     against their pinned generation.
- The cache directory keeps the old `<version>/` directory until no
  workflow run holds its generation. A background sweeper GCs cache
  directories with zero refcount and `installed_at` older than 24h.
- Uninstall is similarly deferred: the row is marked `tombstoned` in
  SQLite, primitives are no longer added to *new* generations, but
  existing pinned generations keep working. The actual disk removal
  happens on next GC pass.

The dashboard's `/api/skills` SSE channel emits state transitions
(`installing` → `installed` / `failed`) for live UI updates.

**SSE budget** — operad already runs into the browser 6-per-origin limit
on EventSources. Skill events multiplex onto the existing daemon-state
SSE channel under a `type: "skill"` envelope; no new channel.

### 3.8 Disk layout

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
          .operad/operad.toml                     # if present
          .source                                 # JSON: fetched_url,
                                                  # fetched_commit_sha (git
                                                  # sources), fetched_archive_sha256
                                                  # (registry / url sources),
                                                  # fetched_at
```

**No symlinks.** `~/.claude.json` entries written by operad use absolute paths
into the cache. Avoids Android scoped-storage / FUSE breakage when users
keep their Claude config on `/storage/emulated/0`.

**SKILL.md delivery.** Exactly one path: write absolute-path entries into
`~/.claude/settings.json` under `skills`. Round-2 review correctly
flagged the round-1 "fallback to writing SKILL.md into agent context"
path as a maintenance liability (two delivery paths, double the bugs).
We document the minimum Claude Code version (≥ 2.0, which is well
deployed) in the install precheck; older versions get a fatal `doctor`
warning telling the user to upgrade Claude Code or skip SKILL.md skills.

### 3.9 Day-1 providers (4)

Round-2 cut `smithery` (no auth/rate-limit/caching story) to v1.1.

| Provider | Locator example | Trust tier | Notes |
|---|---|---|---|
| `claude-marketplace` | `wshobson/agents` | `community` (or `trusted` for `anthropics/*`) | Reads `.claude-plugin/marketplace.json` + plugin bundles via git clone. Tag-pinned. |
| `mcp-official` | `exa-search` | `trusted` | `registry.modelcontextprotocol.io/v0.1/servers`. API freeze means safe to ship. TLS-pin the registry hostname (SPKI in source) so a DNS hijack can't silent-install. |
| `operad-curated` | `operad/git-tools` | `trusted` | Static `index.json` hosted at `operad.stream/skills/index.json` (GitHub Pages). Resolver pins the **commit SHA** of the index repo (not `main` HEAD) so repo compromise can't push silent updates; the SHA pin updates on operad release, manual rotation only. PR-to-add new entries. |
| `git+url` | `https://github.com/foo/bar@v1.0` | `escape` | Plain git clone with tag pin. Universal escape hatch. |

Deferred:

- `smithery` — v1.1 with caching + debounce + (likely) API key story.
- `github-topic` — high-discovery but high-malware-risk. v1.1 once trust
  UX is exercised.
- `awesome-list`, `tessl`, `huggingface-spaces` — not in plan.

### 3.10 Update model

- `tmx skill list` shows pinned version vs. latest available (resolver
  runs a HEAD check per source). The HEAD check is opt-in via `--check`
  to avoid hammering registries on every list call.
- `tmx skill update <id>` — explicit per-skill update.
- **No `--all` bulk update** — round-2 review correctly flagged the
  "everything broke at once" support scenario. Per-skill only.
- **No auto-update.** Future work. Cut from spec.

### 3.11 Lease invalidation on uninstall / update

Round-2 caught this: Phase-10B leases are persistent and reference tools
by name. Uninstall and update paths consult `tool_leases`; if any lease
is active for a tool the operation would remove, the operation either:

- Refuses with a typed error listing the leases (default behaviour), or
- Force-revokes leases with `--force-revoke` (explicit flag, lands an
  entry in `skill_events`).

Updates that strictly add (no rename, no removal) skip the lease check.

### 3.12 Integrity primitives

Round-2 noted that git clones aren't bit-stable, so a "tarball sha256"
is meaningless for git sources.

- **Git sources** (`claude-marketplace`, `git+url`, `operad-curated` index
  repo): integrity primitive is the resolved **commit SHA**. After
  clone, `git rev-parse HEAD` is recorded in `.source`. For audit
  reproducibility, `git archive <sha>` is also taken and its sha256
  recorded — this is bit-stable across machines and verifiable later.
- **Registry sources** (`mcp-official`): integrity primitive is the
  sha256 of the fetched JSON document plus a recorded `Last-Modified`
  / `ETag`. operad TLS-pins the registry hostname.

### 3.13 Cache GC

- A background sweeper runs on daemon idle. Cache directories with
  refcount 0 and last `installed_at` > 24h are eligible for removal.
- Tombstoned rows whose cache directory has been swept are hard-deleted
  from the DB at the same time.
- Per `(provider, locator)`, keep at most **3** versions on disk: the
  currently-active one plus up to two recent inactive ones for rollback.
  Older versions are GC'd unconditionally.

## 4 — Architecture

### 4.1 Layers

```
                  ┌────────────────────────────────────────────┐
   Dashboard /    │           SkillManager (state, in daemon)   │
   CLI commands ──IPC▶  installed skills · enabled/disabled    │
                  │  per-skill autonomy bucket · generation     │
                  │  refcount · update state                    │
                  └──────────────────┬─────────────────────────┘
                                     │
        ┌────────────────────────────┼──────────────────────────┐
        │                            │                          │
        ▼                            ▼                          ▼
  ┌──────────┐                ┌────────────┐              ┌──────────┐
  │ Resolver │  ── pluggable ─│  Adapter   │── normalize ─│  Runtime │
  │ (locator │     providers  │  (manifest │   to operad  │ Loader   │
  │ → fetch) │                │  → skill)  │   internal   │ (apply,  │
  └──────────┘                └────────────┘              │  gen-tag)│
        │                            │                    └──────────┘
        │                            │                          │
        │                            │                          ▼
        │                            │                 generation-tagged
        │                            │                 ToolExecutor /
        │                            │                 AgentEngine /
        │                            │                 WorkflowEngine
        │                            │                 registries; live
        │                            │                 generation pointer
        ▼                            │                 swaps atomically
   ┌─────────────────────────────────┼───┐
   │  Providers (day-1, 4)           │   │
   │  • claude-marketplace           │   │
   │  • mcp-official                 │   │
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
  | "operad-curated"
  | "git+url";

export type TrustTier = "trusted" | "community" | "escape";

export type AutonomyBucket = "observe" | "suggest" | "autonomous";

export type McpLifecycle = "config-only" | "gateway";

export interface SkillSource {
  provider: Provider;
  locator: string;          // owner/repo, registry name, etc.
  version: string;          // tag, commit, or "latest" alias resolved
  fetched_url: string;      // fully resolved url, for audit
  fetched_at: number;       // unix epoch
  fetched_commit_sha?: string;     // for git sources
  fetched_archive_sha256: string;  // git archive output OR tarball/json
}

export interface OperadSkill {
  id: string;               // <provider>:<sanitized-locator>@<version>
  name: string;
  description: string;
  source: SkillSource;
  trust_tier: TrustTier;
  enabled: boolean;

  // Primitive bundles — any subset
  tools?: SkillToolEntry[];
  agents?: AgentConfig[];
  workflows?: WorkflowConfig[];
  mcps?: SkillMcpEntry[];
  skill_mds?: SkillMdEntry[];
}

export interface SkillToolEntry {
  toml: TomlToolConfig;
  // Per-tier ceiling, computed at install. Cannot be raised by re-install.
  autonomy_cap: AutonomyBucket;
}

export interface SkillMcpEntry {
  name: string;
  command?: string;         // stdio (config-only)
  args?: string[];
  env?: Record<string, string>;
  url?: string;             // http / streamable (gateway)
  transport?: "stdio" | "http" | "sse";
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
  fetched_commit_sha TEXT,                 -- nullable: git sources only
  fetched_archive_sha256 TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  trust_tier TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  tombstoned INTEGER NOT NULL DEFAULT 0,
  manifest_json TEXT NOT NULL,             -- full OperadSkill serialized
  installed_at INTEGER NOT NULL,
  UNIQUE(provider, locator, version)
);

CREATE INDEX idx_skills_provider_locator
  ON skills(provider, locator);
CREATE INDEX idx_skills_tombstoned
  ON skills(tombstoned, installed_at);

-- Active version pointer per (provider, locator). Updating = inserting a new
-- `skills` row + flipping this pointer in a single transaction.
CREATE TABLE skill_active_version (
  provider TEXT NOT NULL,
  locator TEXT NOT NULL,
  version TEXT NOT NULL,
  generation INTEGER NOT NULL,             -- pinned at activation
  PRIMARY KEY (provider, locator),
  FOREIGN KEY (provider, locator, version) REFERENCES skills(provider, locator, version)
);

-- In-flight workflow runs that pin a generation. Refcount for cache GC.
CREATE TABLE skill_generation_refs (
  generation INTEGER NOT NULL,
  ref_kind TEXT NOT NULL,                  -- 'workflow_run' | 'session'
  ref_id TEXT NOT NULL,
  PRIMARY KEY (generation, ref_kind, ref_id)
);
CREATE INDEX idx_skill_gen_refs_gen ON skill_generation_refs(generation);

-- Per-tool autonomy ceiling. Set at skill install; read by ToolExecutor.
CREATE TABLE tool_autonomy_caps (
  tool_id TEXT PRIMARY KEY,
  max_bucket TEXT NOT NULL                 -- 'observe' | 'suggest' | 'autonomous'
);

CREATE TABLE skill_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  event_type TEXT NOT NULL,                -- install | update | enable | disable
                                           -- | uninstall | error | force_revoke
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
  adapter.ts        — manifest → OperadSkill (provider dispatch +
                      claude-plugin + operad.toml merge)
  loader.ts         — apply / unapply / generation refcounts
  store.ts          — sqlite + cache disk layout + claude.json writer
  gc.ts             — background cache + tombstone sweeper
  providers/
    claude-marketplace.ts
    mcp-official.ts
    operad-curated.ts
    git-url.ts
  mcp/
    config_only.ts  — write to ~/.claude.json
    gateway.ts      — record HTTP URL + write to ~/.claude.json
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
    resolved_version: string;          // when locator says "latest", what was that?
    fetched_url: string;
    fetched_commit_sha?: string;       // git sources
    fetched_archive_sha256: string;
  }>;

  // Read whatever manifests exist in the extracted directory and normalize to
  // OperadSkill. Adapter for the provider's native format.
  read(extracted_path: string): Promise<Omit<OperadSkill, "id" | "source" | "trust_tier" | "installed_at" | "enabled">>;

  // Lightweight HEAD check for updates. Returns the latest version string
  // available, without fetching the bundle.
  latest(locator: string): Promise<string>;
}
```

## 5 — IPC + REST surface

### 5.1 IPC commands (daemon ↔ CLI)

```
skill.install <provider> <locator> [<version>=latest] [--force-revoke]
skill.uninstall <provider> <locator> [--force-revoke]
skill.update <provider> <locator>
skill.list [--provider=<p>] [--check]
skill.search <query> [--provider=<p>]
skill.enable <provider> <locator>
skill.disable <provider> <locator>
skill.info <provider> <locator>
```

The CLI is a thin wrapper that sends these messages and renders the JSON
responses. No DB or cache access on the CLI side, ever.

### 5.2 REST API (dashboard)

```
GET    /api/skills                          list installed
GET    /api/skills/<id>                     get one (full manifest)
POST   /api/skills/install                  { provider, locator, version?,
                                              force_revoke? }
POST   /api/skills/<id>/enable
POST   /api/skills/<id>/disable
POST   /api/skills/<id>/uninstall           { force_revoke? }
POST   /api/skills/<id>/update              install latest if newer
GET    /api/skills/search                   { provider?, q }
GET    /api/skills/events                   recent events (timeline)
```

Skill state transitions multiplex onto the existing daemon `/api/events`
SSE channel under `type: "skill"`. No new SSE endpoint.

### 5.3 CLI surface

```sh
tmx skill add <provider>:<locator>[@<version>]
tmx skill add <github-url>              # → git+url, version = tag at HEAD
tmx skill remove <provider>:<locator> [--force-revoke]
tmx skill list [--provider=<p>] [--check]
tmx skill search <query> [--provider=<p>]
tmx skill update <provider>:<locator>
tmx skill enable <provider>:<locator>
tmx skill disable <provider>:<locator>
tmx skill info <provider>:<locator>     # show manifest, source, autonomy caps
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
  .operad/
    operad.toml                      # operad-specific tools/agents/workflows/mcps
```

Publishing checklist:

1. Repo on GitHub. Tag releases with semver.
2. Optional: add `topic:claude-code-plugin` for discoverability under the
   eventual `github-topic` provider.
3. Optional: PR to `operad-stream/skills` repo to be listed in
   `operad-curated`.

Users install with `tmx skill add git+url:https://github.com/me/my-plugin@v1.0.0`
or `tmx skill add operad-curated:me/my-plugin` once curated.

## 7 — Failure modes addressed

### 7.1 Two orchestrators fighting over one MCP process

`proxied` mode is **cut from v1**. operad never spawns an MCP process
that Claude Code might also try to spawn. `config-only` writes to
`~/.claude.json` and lets Claude Code own the lifecycle entirely;
`gateway` writes an HTTP URL with no daemon-owned process. Zero overlap.

### 7.2 SQLITE_BUSY / partial-read races

CLI is a pure IPC client. Daemon is the sole writer. SkillManager
serialises install transactions on a per-`(provider, locator)` mutex.
Cache directory writes happen to a `<version>.tmp` directory and
atomically rename to `<version>` after sha256 verification.

### 7.3 In-flight workflow run referencing tools from an old version

Generation-counter discipline (§3.7). Workflow runs pin a generation at
start; tool lookups resolve against the pinned snapshot, not the live
pointer. Old generations are refcounted; cache GC waits for refcount = 0
before disk removal.

### 7.4 Schema collision with Anthropic

We do not extend `marketplace.json` or `plugin.json`. operad-specific
content lives in `.operad/operad.toml`. If Anthropic adds strict
validation, plugin authors that target both ecosystems are unaffected. A
CI smoke test in operad-curated runs `claude plugin install` on a
fixture skill with `.operad/` present and fails the build if claude-code
rejects it.

### 7.5 Termux symlink failures

Zero symlinks. All references between the cache and Claude Code's view of
the world go through absolute paths in `~/.claude.json` and
`~/.claude/settings.json`.

### 7.6 `~/.claude.json` concurrent edit by user

operad reads via `flock`-advisory-locked read-modify-write, parses,
surgically updates `mcpServers` under a top-level `operad_managed`
array so we know what we own, writes via temp-file-then-rename. If parse
fails, install aborts. operad never blind-overwrites.

### 7.7 Untrusted skill installs

`escape`-tier installs land in `observe` bucket with `autonomy_cap =
suggest` — user can promote to suggest with confirmation, never to
autonomous. `community` tier installs into `suggest` with cap =
`autonomous`. `trusted` tier same as community but installs silently.

### 7.8 Skill removing a tool with an active lease

Uninstall and update paths consult `tool_leases`; refuse with typed
error listing affected leases unless `--force-revoke` is passed (logs
to `skill_events`).

### 7.9 Registry compromise / DNS hijack

- `mcp-official` resolver TLS-pins the registry SPKI in source. On
  cert mismatch, the resolver aborts with a typed error.
- `operad-curated` resolver pins the index repo's commit SHA. The SHA is
  embedded in operad source; rotating it is a release event, never an
  auto-pull.
- Other providers (`claude-marketplace`, `git+url`) rely on git's tag
  pinning + SHA recording; users see the resolved commit in `tmx skill
  info`.

### 7.10 Android OOM-kill of any operad-managed process

Not applicable in v1 — operad doesn't manage any MCP processes. Returns
to relevance if `proxied` mode is reintroduced.

## 8 — Testing strategy

- **Unit tests** for each provider's `list` / `fetch` / `read` / `latest`
  with recorded fixtures (no network in CI). Includes a `mcp-official`
  TLS-pin test that fails the resolver when the cert doesn't match.
- **Unit tests** for the adapter merging `marketplace.json` + `operad.toml`.
- **Unit tests** for SkillManager install/uninstall/update transactions
  (including rollback on failure, force-revoke logging, autonomy-cap
  enforcement).
- **Unit tests** for the `~/.claude.json` writer (lock contention,
  malformed input, surgical update preserving user entries).
- **Property test** for the cache-directory atomic-rename logic — random
  crash injection between extract and rename.
- **Integration test**: install a fixture skill via IPC, verify
  tools/agents/workflows are registered, run a workflow that uses a tool
  from the skill, update the skill mid-run, verify the in-flight run
  completes against the old generation while a new run picks up the new
  generation, uninstall, verify everything is deregistered and cache
  GC'd.
- **CI smoke test in operad-curated repo**: install a fixture skill
  containing `.operad/operad.toml` with `claude plugin install` and
  assert claude-code accepts it.

## 9 — Implementation phases

### Phase A — internal plumbing
1. SQLite schema migration.
2. `SkillManager`, `types`, `store`.
3. Generation counter + refcount in ToolExecutor / AgentEngine /
   WorkflowEngine. **This is the biggest in-tree change** — it touches
   the three engines and the workflow runner. Land first, ship behind a
   feature flag, validate with existing workflow tests still passing.
4. IPC handlers.
5. `~/.claude.json` advisory-locked writer.
6. Runtime loader (apply/unapply, generation tagging).
7. Adapter merge logic + `operad.toml` parser.
8. Autonomy ceiling: `tool_autonomy_caps` table + ToolExecutor promotion
   gate + CLI / dashboard plumbing.
9. Unit tests for all of the above.

### Phase B — providers
10. `git+url` (escape hatch — simplest, validates the pipeline).
11. `operad-curated` (static index — also needs site/ skills index
    bootstrap).
12. `claude-marketplace` (most leverage — anthropics/skills,
    wshobson/agents, etc).
13. `mcp-official` (registry API + TLS pin).
14. Provider unit tests with fixtures.

### Phase C — MCP lifecycle
15. `config-only` mode.
16. `gateway` mode (HTTP URL recording + claude.json write).

### Phase D — UX
17. REST endpoints + multiplexed SSE messages.
18. Dashboard `SkillManager.svelte` panel: list, search, install, autonomy.
19. CLI `tmx skill` subcommands.
20. Docs in `docs/skills.md`.
21. CHANGELOG, README, landing-page entries.

### Phase E — hardening
22. Property tests for cache atomic rename.
23. Integration test for end-to-end install/use/uninstall.
24. CI smoke test in operad-curated for claude-plugin compatibility.
25. Doctor probes: validate `~/.claude.json` consistency with installed
    `mcps`, validate Claude Code version ≥ 2.0 if skill_mds installed.
26. Cache GC sweeper.

## 10 — Future work (out of scope for v1)

- `proxied` MCP mode — requires a proper stdio multiplexer with explicit
  capability-intersection table; only worth doing if there's real demand
  for OODA agents to call stdio MCPs directly while Claude Code is also
  running.
- `smithery` provider — auth + rate-limit + caching + debounce.
- `github-topic` provider — needs per-result trust UX.
- `huggingface-spaces` MCP-filtered provider.
- `tessl` adapter once they ship a public API.
- MCP Tasks primitive support — likely a new `task-gateway` mode.
- Auto-update on a daily cron.
- Signed manifests (sigstore / cosign style).
- "Skill packs" — curated collections of skills installed together.

## 11 — Reviewer trail

- **Round 1 — Gemini 3 Pro Preview**: caught the manifest-abuse
  schema-collision risk, the proxied-MCP zombie-port-lock failure mode,
  the symlink/FUSE breakage, and the SQLite single-writer requirement.
  All folded in.
- **Round 2 — high-thinking spec reviewer**: caught that `proxied` mode
  is broken at the protocol layer (stdio multiplexing breaks
  sampling/elicitation/roots), that "atomic version pointer" is only
  atomic at the DB layer and not the runtime layer, that the autonomy
  "ceiling" was asserted without implementation, that git sources can't
  have a meaningful "tarball sha256", that lease invalidation was
  missing, that `~/.claude.json` had no concurrency story, and that the
  SSE budget was already at the 6-per-origin limit. All folded in;
  `proxied` and `smithery` cut from v1.
