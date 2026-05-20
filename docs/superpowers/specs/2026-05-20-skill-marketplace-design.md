# Skill / plugin marketplace — design spec

Date: 2026-05-20
Status: draft (round 4 — post-reviewer-4 pivots, pending round-5 sign-off)
Owner: tribixbite
Reviewers: gemini-3-pro-preview (round 1), high-thinking subagent (rounds
2 / 3 / 4)

## 1 — Goal

Give `operad` users an "Obtainium-style" multi-source aggregator for installing
bundles of tools, agents, workflows, and SKILL.md context produced by the wider
ecosystem (Anthropic's `claude-plugins-official`, third-party plugin
marketplaces like `wshobson/agents`, the official MCP registry, and arbitrary
git URLs). Installation is one command. The daemon hot-loads new primitives
with carefully-scoped guarantees about in-flight work. Trust is graded by
source. No central registry operad has to keep online for the system to work;
the curated index at `operad.stream/skills` is one source among many.

## 2 — Non-goals

- Inventing a new package format competing with `.claude-plugin/marketplace.json`.
- Acting as a registry-of-registries publisher requiring a server we own.
- Runtime capability sandboxing — Termux makes this theatre. Autonomy buckets
  do the real work.
- Scraping closed-API platforms (Tessl, mcp.so) until they ship public JSON
  APIs.
- Re-implementing MCP transport semantics; operad orchestrates lifecycle but
  the protocol is owned by the MCP spec.
- **`proxied` MCP multiplexing** — round-2 review caught that wedging an HTTP
  shim in front of stdio breaks sampling / elicitation / roots and requires
  a non-trivial multiplexer. Cut from v1.
- **`gateway` MCP mode** — round-3 review caught that as a "config-write
  helper" it's behaviourally identical to `config-only` (Claude Code owns
  lifecycle, operad just writes a config entry). Two enum values producing
  the same behaviour means v1.1's real gateway logic would silently
  re-define the meaning of `gateway` for any v1 author who declared it. Cut
  to ONE lifecycle value in v1.
- **MCP Tasks primitive** (June 2026 spec) — out of scope for v1. Re-evaluate
  alongside `gateway` reintroduction.
- **Auto-update on a schedule** — cut.
- **Bulk update (`--all`)** — cut.
- **CLI search (`skill.search`)** — deferred to v1.1. Search across 4
  providers with no common ranking is bad UX. Users discover via the
  operad.stream landing page or upstream marketplaces' own UIs.
- **`--check` on `tmx skill list`** — deferred to v1.1. Update on demand via
  `tmx skill update <id>`.

## 3 — Locked decisions

### 3.1 Scope of a "skill"

A skill is a bundle that may contain any combination of:

- **Tools** — operad `[[tool]]` definitions.
- **Agents** — `[[agent]]` definitions.
- **Workflows** — `[[workflow]]` DAGs (see `src/workflow.ts`).
- **MCP servers** — same shape as `~/.claude.json` `mcpServers` entries,
  always under `lifecycle = "config-only"` in v1. Both stdio (`command` +
  `args`) and HTTP (`url`) servers route through the same code path. The
  `McpLifecycle` enum is reserved (single-value) for future expansion.
- **SKILL.md bundles** — Anthropic Agent Skills.

A skill may also be empty of operad-specific content if it's a pure
Claude-Code plugin aggregated for discovery.

### 3.2 Distribution model

operad is an aggregator/resolver, not a registry. Each installed skill
carries a `Source` record describing which provider resolved its identity
and how to refetch / check for updates.

### 3.3 Manifest split

Authors publish **two files** in the same repo / bundle:

1. `.claude-plugin/marketplace.json` — Anthropic's plugin format, untouched.
2. `.operad/operad.toml` — operad-native primitives (tools, agents,
   workflows, mcp-lifecycle hints).

**Discovery order:** the adapter looks for `.operad/operad.toml` first. If
absent, it checks bare `operad.toml` at the repo root. If both exist, the
adapter prefers `.operad/` and logs a `WARN: bare operad.toml shadowed by
.operad/operad.toml at <path>` event into `skill_events.detail`. The
adapter never merges across both paths — pick one.

The adapter merges marketplace.json + the resolved operad.toml at read
time. Authors who only target Claude Code skip the operad file.

CI in the operad-curated repo runs `claude plugin install` against a
fixture skill containing `.operad/` and fails the build if claude-code
rejects it. This is an after-the-fact catch, not a prevention — older
claude-code versions on user machines may behave differently. We document
the minimum supported Claude Code version (currently `>= 2.0`).

### 3.4 Trust model

**Autonomy buckets.** Every tool a skill ships is registered with the
ToolExecutor in the `suggest` bucket by default. User must promote each
tool to `autonomous` for it to fire without confirmation.

**Source-tier install prompts.** Three trust tiers, ordered most→least
trusted: `trusted` > `community` > `escape`.

- `trusted` — `claude-marketplace` resolved to
  `anthropics/claude-plugins-official`, `mcp-official`, or
  `operad-curated`. Installs silently.
- `community` — `claude-marketplace` resolved to anything else. Installs
  after confirmation showing the manifest.
- `escape` — `git+url`. Installs after detailed confirmation including
  the manifest diff vs. any previous install.

**Autonomy ceiling — net-new work.** Implemented as part of this work
(not assumed):

- New `tool_autonomy_caps` table: `(tool_id PRIMARY KEY, max_bucket)`.
- **Migration: existing tools (pre-marketplace) get `max_bucket =
  autonomous` to preserve status quo.** New skills set their per-tier
  cap at install. The migration is a one-shot at first daemon boot after
  upgrade.
- ToolExecutor's promotion API consults the cap; dashboard UI disables
  forbidden promotions; CLI `tmx tool autonomy <id> <bucket>` rejects
  promotions above the cap with a typed `AUTONOMY_CAP_VIOLATION` error.
- Per-tier cap mapping:
  - `trusted` → cap `autonomous` (default bucket `suggest`).
  - `community` → cap `autonomous` (default bucket `suggest`).
  - `escape` → cap `suggest` (default bucket `observe`).
- The cap is recorded at install. Re-install from a different provider
  for an identical `(locator, version)` is a no-op if the new tier
  matches the recorded one. Cross-tier re-install is governed by the
  **always-more-restrictive** rule (round-4 fix; reverses the round-3
  "upward only" rule which let a user silently keep elevated autonomy
  on code re-installed from a less-trusted source):
  - Re-install at a stricter tier (e.g. `community → escape`): the cap
    drops to the stricter ceiling. If any tool currently has a bucket
    > the new cap, the install requires `--accept-cap-downgrade` and
    re-prompts the user; on confirm, all affected tool buckets are
    clamped to the new cap and an `autonomy_clamp` entry is recorded
    in `skill_events.detail`.
  - Re-install at a more permissive tier (e.g. `escape → trusted`):
    cap relaxes; buckets are unchanged (user can opt-in to promote).
  - Same-tier re-install: no-op.
- Skill manifests cannot set their own cap. Source tier is the only
  knob.

**Name conflicts between skills are rejected at install time.** The
new skill's primitives are validated against the existing view; on
collision, install aborts with one of:

- `TOOL_NAME_CONFLICT` — `[[tool]]` collides with an existing tool.
- `WORKFLOW_NAME_CONFLICT` — `[[workflow]]` collides with an existing
  workflow (covers the round-4 gap: workflow.ts has no name-collision
  guard today).
- `AGENT_NAME_CONFLICT` — `[[agent]]` collides with an existing agent
  specialization.
- `MCP_NAME_CONFLICT` — `[[mcps]]` entry name collides with another
  operad-managed MCP (user-owned and other-daemon-owned cases are
  separately handled in §3.5).

All conflict errors return the colliding name + the already-installed
skill id. Operators resolve manually (uninstall the old one, or rename
in their fork).

### 3.5 MCP server lifecycle (single mode in v1)

One mode: `config-only`. operad writes the server block to `~/.claude.json`
under flock-advisory-locked surgical RMW. Claude Code spawns and supervises
the process. operad does nothing at runtime.

Both stdio (`command`/`args`) and HTTP/SSE (`url` + `type: "http"|"sse"`)
servers route through this path; Claude Code already handles both transport
families. The `McpLifecycle` enum stays as a single-value type so future
modes (`proxied`, `gateway`, `task-gateway`) can be added without churning
the schema.

**`~/.claude.json` writer:**

- Acquire `flock` on `~/.claude.json.lock` (advisory). On platforms
  without flock (Windows), use `proper-lockfile`. The lock synchronises
  operad-vs-operad only; **claude-code does not honour it** (round-4
  reviewer was right that the round-3 spec implied protection it didn't
  have).
- Read `~/.claude.json` and capture `{mtime_ns, sha256(body)}`.
- Parse. If parse fails, install aborts with `CLAUDE_JSON_MALFORMED` —
  operad never touches a malformed file.
- Compute the surgical update.
- Re-stat the file. If `mtime_ns` or `sha256` changed, the file was
  rewritten between read and the rename (most likely by claude-code
  via `/mcp` or auth rotation). Release the lock, retry the whole
  sequence ONCE. On second race, abort with `CLAUDE_JSON_RACED` and
  return a typed error suggesting the user retry after closing the
  conflicting client. We never silently clobber a concurrent write.
- Surgically update `mcpServers` and a top-level **object** (not array)
  named `operad_managed`:

  ```json
  "operad_managed": {
    "<mcp-name>": {
      "skill_id": "<operad-skill-id>",
      "daemon_id": "<machine-uuid>",
      "installed_at": 1747752000
    }
  }
  ```

  `daemon_id` is a UUID generated at first daemon boot. **Location
  precedence (round-4 fix):**
  1. `$XDG_RUNTIME_DIR/operad/daemon-id` if `$XDG_RUNTIME_DIR` is set
     and writable (Linux desktop). `$XDG_RUNTIME_DIR` is per-machine
     `tmpfs`, exactly the right scope.
  2. Else `$PREFIX/var/lib/operad/daemon-id` on Termux (per-Android-
     device, never synced).
  3. Else `~/.local/share/operad/daemon-id` as fallback with a
     `doctor` warning that the path may sync via dotfile tools — user
     should add it to their syncthing/chezmoi exclusion list.
  The path is decided once on first boot and cached so re-bootstrapping
  doesn't accidentally produce a different id under a different
  $XDG_RUNTIME_DIR.

- Write via temp-file-then-rename.

**Collision behaviours:**

- `mcpServers[name]` exists, `operad_managed[name]` absent → user-owned
  hand-written entry. operad refuses to install, returns
  `MCP_NAME_USER_OWNED` listing the name and the operator's options
  (rename in the skill manifest, or `--force-take-ownership` to claim it).
- `operad_managed[name].daemon_id` ≠ this daemon's id → another daemon
  owns it. Install refuses with `MCP_OWNED_BY_OTHER_DAEMON`. The user
  decides which daemon should own it; manual resolution.
- `mcpServers[name]` absent, `operad_managed[name]` present → orphan
  state (user manually deleted the mcpServers entry). operad logs a
  warning and removes the `operad_managed` entry on the next operation
  that touches the file.

### 3.6 Single-writer principle

CLI never writes to skills SQLite, the cache directory, or `~/.claude.json`.
`tmx skill add <id>` sends an IPC `skill.install` request. The daemon
performs the full transaction. Read-only CLI operations also go through
IPC.

### 3.7 Hot-load and generation-counter discipline (Phase B work, deferred)

**The MVP ships without generation discipline** (see §9). The MVP caveat:
"don't install skills while ANY tool consumer is live". The daemon
refuses installs while **any of the five caller types** holds a live
tool reference (round-4 fix; the round-3 spec only blocked on workflow
runs, which would have demonstrated the failure mode it claimed to
defer — single-shot REST tool calls or OODA cycles would race silently).

The gate is symmetric: while an install is in progress, the daemon
refuses new tool reference acquisitions from any caller type. The
typed errors are `INSTALL_BLOCKED_BY_ACTIVE_CONSUMER` (lists the
specific caller kinds + ref_ids holding references) and
`TOOL_BLOCKED_BY_ACTIVE_INSTALL` (returns the in-flight install id).

This is coarse and acknowledged as such. It does mean the dashboard
cannot be used for ad-hoc tool calls during an install — which is
correct behaviour, since the alternative is silent registry tearing.
Phase C replaces this with proper generation pinning.

Generation discipline lands in Phase C once the MVP has been exercised
and we know which engines actually need it. The full design:

- ToolExecutor, AgentEngine, and WorkflowEngine each expose a monotonic
  `generation` counter. Each registration writes its primitives into a
  generation-tagged shadow map: `tools[generation] = {...}`.
- The current "live" generation is a single pointer (`current_generation`).
- **Every entry-point that calls `ToolExecutor.execute` acquires a
  generation pin.** Acquire/release contract per call site:

  | Caller | Acquire | Release |
  |---|---|---|
  | `WorkflowEngine.run()` | at run start | at run finish / abort |
  | `AgentEngine` OODA cycle | at cycle entry | at cycle exit |
  | REST `POST /api/tool/<id>/run` | at request entry | at response send |
  | IPC `tool.execute` | at command entry | at command exit |
  | ScheduleEngine fire | at handler entry | at handler exit |

- `skill_generation_refs.ref_kind` enum:
  `workflow_run | agent_cycle | rest_request | ipc_call | scheduled_run`.
  `ref_id` is the caller's identifier (workflow run UUID, request UUID, etc).
- On install, the new generation is built but `current_generation` swaps
  only after all pending pins have been recorded (no torn reads).
- **Cache GC two-phase tombstone (round-3 fix):** sweeper marks cache
  directories where refcount = 0 and `installed_at > TTL` as
  `pending_delete` in the DB. A second pass, run on the next sweeper
  tick (default 1h later), deletes only if the row is still `pending_delete`
  AND refcount is still 0. Acquire-during-delete-window starts a new pin,
  re-checks the pending flag, and removes it if found. This blocks the
  ABA race the round-2 spec missed.

### 3.8 Disk layout

```
~/.local/share/operad/
  daemon-id                                       # UUID, generated once
  skills/
    index.db                                      # SQLite
    cache/
      <provider>/
        <sanitized-locator>/
          <version>/                              # canonical version string
            .claude-plugin/marketplace.json       # if present
            plugin.json                           # if present
            skills/<name>/SKILL.md + bundle       # if present
            .operad/operad.toml                   # if present
            .source                               # JSON: fetched_url,
                                                  # fetched_commit_sha,
                                                  # fetched_archive_sha256,
                                                  # fetched_at
```

**No symlinks.** All references between the cache and Claude Code's view
of the world go through absolute paths in `~/.claude.json` and
`~/.claude/settings.json`.

**SKILL.md delivery.** One path: write absolute-path entries into
`~/.claude/settings.json` under `skills`. Min Claude Code version `>= 2.0`,
enforced by a `doctor` precheck. No fallback.

### 3.9 Day-1 providers (4)

| Provider | Locator example | Trust tier | Notes |
|---|---|---|---|
| `claude-marketplace` | `wshobson/agents` | `community` (or `trusted` for `anthropics/*`) | Reads `.claude-plugin/marketplace.json` + plugin bundles via git clone. Tag-pinned. |
| `mcp-official` | `exa-search` | `trusted` | `registry.modelcontextprotocol.io/v0.1/servers`. Resolver TLS-pins the registry hostname (SPKI in source) **plus a backup pin** so a single rotation doesn't brick the resolver. Both pins must rotate at most once per release; backup pin grace period is one release cycle. |
| `operad-curated` | `operad/git-tools` | `trusted` | Resolver pins the **commit SHA** of the index repo (embedded in operad source); PR-to-add new entries. |
| `git+url` | `https://github.com/foo/bar@v1.0` | `escape` | Plain git clone with tag pin. Universal escape hatch. Repos without a tag at HEAD fall back to using the commit SHA as the version string (`commit:<sha>`). |

Deferred: `smithery`, `github-topic`, `awesome-list`, `tessl`,
`huggingface-spaces`.

### 3.10 Update model

- `tmx skill list` shows pinned version only (no auto-`HEAD` check).
- `tmx skill update <provider>:<locator>` — explicit per-skill update.
- No `--all`, no auto-update.

### 3.11 Version-string normalization

The resolver canonicalises locator versions before any DB or cache write.

- Semver tags: `v1.0.0` and `1.0.0` both canonicalise to `v1.0.0` (the
  `v` prefix is added if missing). Pre-release suffixes are preserved.
- Commit SHAs: `commit:<full-40-char-sha>`. Short SHAs are rejected with
  `LOCATOR_AMBIGUOUS_SHA`.
- The string `latest` resolves to the highest semver tag in the source
  (or HEAD commit if no tags); the resolved canonical form is stored,
  not `latest` literally. Re-resolving `latest` later may produce a
  different canonical version; that's the point of `tmx skill update`.

UNIQUE constraint on `(provider, locator, version)` operates on the
canonical form. `wshobson/agents@v1.0` and `wshobson/agents@1.0` produce
one row, not two.

### 3.12 Lease invalidation on uninstall / update

Phase-10B leases reference tools by name. Uninstall and update paths
consult `tool_leases` AND scheduled runs (`agent_schedules` rows that
reference the tool in their prompt or planned actions). If any consumer
exists, the operation:

- Refuses with a typed `TOOL_HAS_ACTIVE_CONSUMERS` error listing
  affected leases + scheduled runs (default), or
- Force-revokes with `--force-revoke`: revokes leases, marks affected
  scheduled runs as `paused` with reason `tool_removed_by_skill_op`.
  The skill_events entry for the install/update records the cascade
  details under `detail.force_revoke_cascade`. No separate event type.

Updates that strictly add (no rename, no removal) skip the lease check.

### 3.13 Integrity primitives

- **Git sources** (`claude-marketplace`, `git+url`, `operad-curated`):
  `git rev-parse HEAD` is recorded as `fetched_commit_sha`. This is the
  canonical integrity primitive — bit-stable, verifiable later.
  **Do NOT use `git archive` as a secondary digest** (round-4 fix):
  `git archive` output is NOT byte-stable across git versions (it
  includes compression metadata and tar mtime drift), so a CI builder
  and a user machine on the same commit would produce different
  digests. If we want a secondary cross-version digest, use
  `git ls-tree -r <sha>` (a deterministic tree-of-blob-hashes listing)
  sha256'd. That value lands in `fetched_archive_sha256` (kept
  column name for schema continuity).
- **Registry sources** (`mcp-official`): `sha256(json_body)` is the
  integrity primitive. **`ETag`/`Last-Modified` are NOT used for cache
  invalidation** — Cloudflare-fronted registries rotate ETags on cache
  rotation without content change, which would trigger spurious updates.
  We compare the body sha256 only.

### 3.14 Cache GC

- Background sweeper runs on daemon idle.
- Eligible directories: refcount = 0 AND `installed_at` >
  `cache_ttl_hours` AND **not currently referenced from
  `~/.claude/settings.json` `skills`** (round-4 question — a SKILL.md
  bundle still wired into Claude Code's settings must not be GC'd even
  if no operad pin holds it). The GC computes the union of pinned
  generations and `settings.json`-referenced bundle paths before
  marking.
- **Two-phase tombstone (see §3.7)** with explicit SQL ordering:

  ```sql
  -- Pass 1 (mark)
  BEGIN;
    SELECT provider, locator, version FROM <eligible-query>;
    INSERT INTO skill_cache_pending_delete (...) SELECT ...;
  COMMIT;

  -- Pass 2 (delete), runs on the *next* sweeper tick
  BEGIN;
    SELECT spd.provider, spd.locator, spd.version
      FROM skill_cache_pending_delete spd
      LEFT JOIN skill_generation_refs r
        ON r.generation = (SELECT generation FROM skill_active_version
                            WHERE provider = spd.provider AND locator = spd.locator)
     WHERE r.ref_id IS NULL;                  -- still no refs
    -- rm -rf the disk dirs returned, then:
    DELETE FROM skill_cache_pending_delete WHERE (provider,locator,version) IN (...);
  COMMIT;
  ```

  Pin acquire on a `pending_delete` row clears the pending flag inside
  the same transaction that records the pin, so the next pass-2 skips
  the row.
- Default `cache_ttl_hours = 168` (7 days). Configurable in
  `operad.toml` under `[skills]`.
- Per `(provider, locator)`, keep at most **3** versions on disk: the
  currently-active one plus up to two recent inactive ones for rollback.
  Older versions are GC'd unconditionally even if refcount = 0.

### 3.15 Install transaction shape (5-store coordination)

A single install touches five stores in order. Failure at any step
rolls back the side-effects of all prior steps in the same install.
Forward-recovery is not attempted automatically — partial installs are
always rolled back rather than left half-applied (round-4 reviewer was
right that without this, partially-installed skills accumulate
silently).

| # | Store | Operation | Failure compensation |
|---|---|---|---|
| 1 | SQLite | `BEGIN`. Insert `skills` row, insert tombstone-pending if updating. | `ROLLBACK`. No external side-effects yet. |
| 2 | Cache disk | Extract bundle to `<version>.tmp/`, sha256-verify, atomic-rename to `<version>/`. | `rm -rf <version>.tmp/`. `ROLLBACK` SQLite. |
| 3 | `~/.claude.json` | flock + mtime-stat + RMW (see §3.5 writer). | `rm -rf <version>/`. `ROLLBACK` SQLite. Release lock. |
| 4 | `~/.claude/settings.json` | Same flock-style RMW pattern for the `skills` array. | Re-RMW `~/.claude.json` to undo step 3. `rm -rf <version>/`. `ROLLBACK` SQLite. |
| 5 | In-memory registries | Register tools / agents / workflows in ToolExecutor / AgentEngine / WorkflowEngine. | Unregister anything that registered. Undo settings.json (step 4). Undo claude.json (step 3). Delete cache (step 2). ROLLBACK SQLite. |

After step 5 succeeds, SQLite `COMMIT` flips `skill_active_version` and
`enabled = 1` in one statement; from that point the install is
"committed" and uninstall is the symmetric inverse path.

If a compensation step itself fails (rare — most likely on
`~/.claude.json` write during step-4 rollback), the daemon logs a
`PARTIAL_INSTALL_RECOVERY_FAILED` event with the full diagnostic state
needed for manual cleanup. The install IPC response includes the
recovery state so the CLI can surface "manual cleanup needed" to the
user with a concrete checklist.

## 4 — Architecture

### 4.1 Layers

```
                  ┌────────────────────────────────────────────┐
   Dashboard /    │           SkillManager (state, in daemon)   │
   CLI commands ──IPC▶  installed skills · enabled/disabled    │
                  │  per-skill autonomy cap · generation        │
                  │  refcount · update state                    │
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
        │                            │                 ToolExecutor /
        │                            │                 AgentEngine /
        │                            │                 WorkflowEngine
        │                            │                 registries (with
        │                            │                 generation
        │                            │                 discipline added in
        ▼                            │                 Phase C)
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

// Single-value union in v1; reserved for future expansion (proxied,
// gateway, task-gateway, etc).
export type McpLifecycle = "config-only";

export interface SkillSource {
  provider: Provider;
  locator: string;
  version: string;                  // canonical form (see §3.11)
  fetched_url: string;
  fetched_at: number;
  fetched_commit_sha?: string;      // for git sources
  fetched_archive_sha256: string;   // git-archive bytes OR json body bytes
}

export interface OperadSkill {
  id: string;                       // <provider>:<sanitized-locator>@<version>
  name: string;
  description: string;
  source: SkillSource;
  trust_tier: TrustTier;
  enabled: boolean;

  tools?: SkillToolEntry[];
  agents?: AgentConfig[];
  workflows?: WorkflowConfig[];
  mcps?: SkillMcpEntry[];
  skill_mds?: SkillMdEntry[];
}

export interface SkillToolEntry {
  toml: TomlToolConfig;
  autonomy_cap: AutonomyBucket;     // computed at install from tier
}

export interface SkillMcpEntry {
  name: string;
  command?: string;                 // stdio
  args?: string[];
  env?: Record<string, string>;
  url?: string;                     // http / sse
  transport?: "stdio" | "http" | "sse";
  lifecycle: McpLifecycle;          // always "config-only" in v1
}

export interface SkillMdEntry {
  name: string;
  bundle_path: string;              // absolute path into cache
  frontmatter: Record<string, unknown>;
}
```

### 4.3 SQLite schema

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  provider TEXT NOT NULL,
  locator TEXT NOT NULL,
  version TEXT NOT NULL,
  fetched_url TEXT NOT NULL,
  fetched_commit_sha TEXT,
  fetched_archive_sha256 TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  trust_tier TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  tombstoned INTEGER NOT NULL DEFAULT 0,
  manifest_json TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  UNIQUE(provider, locator, version)
);

CREATE INDEX idx_skills_provider_locator
  ON skills(provider, locator);
CREATE INDEX idx_skills_tombstoned
  ON skills(tombstoned, installed_at);

CREATE TABLE skill_active_version (
  provider TEXT NOT NULL,
  locator TEXT NOT NULL,
  version TEXT NOT NULL,
  generation INTEGER NOT NULL,
  PRIMARY KEY (provider, locator)
);

-- Phase C: refcount table for generation pins
CREATE TABLE skill_generation_refs (
  generation INTEGER NOT NULL,
  ref_kind TEXT NOT NULL,           -- workflow_run | agent_cycle |
                                    -- rest_request | ipc_call |
                                    -- scheduled_run
  ref_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (generation, ref_kind, ref_id)
);
CREATE INDEX idx_skill_gen_refs_gen ON skill_generation_refs(generation);

-- Pending-delete state for two-phase cache tombstone
CREATE TABLE skill_cache_pending_delete (
  provider TEXT NOT NULL,
  locator TEXT NOT NULL,
  version TEXT NOT NULL,
  marked_at INTEGER NOT NULL,
  PRIMARY KEY (provider, locator, version)
);

-- Autonomy ceiling
CREATE TABLE tool_autonomy_caps (
  tool_id TEXT PRIMARY KEY,
  max_bucket TEXT NOT NULL,         -- observe | suggest | autonomous
  set_by_provider TEXT,             -- provider that set the current cap
  set_at INTEGER NOT NULL
);

CREATE TABLE skill_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  event_type TEXT NOT NULL,         -- install | update | enable | disable
                                    -- | uninstall | error
                                    -- (force_revoke folded into detail)
  detail TEXT,                      -- json
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
  adapter.ts        — manifest → OperadSkill (claude-plugin + operad.toml merge)
  loader.ts         — apply / unapply / generation refcounts (Phase C)
  store.ts          — sqlite + cache disk layout
  claude_json.ts    — flock-locked surgical RMW writer
  gc.ts             — background cache + tombstone sweeper
  daemon_id.ts      — UUID provisioning
  providers/
    claude-marketplace.ts
    mcp-official.ts
    operad-curated.ts
    git-url.ts
```

### 4.5 Provider interface

```typescript
export interface ProviderModule {
  id: Provider;
  trustTier(locator: string): TrustTier;

  // Listing — for future search; not invoked in v1 since CLI search is
  // deferred. Implementations may stub.
  list(opts: { query?: string; cursor?: string; limit?: number }): Promise<{
    items: ProviderListing[];
    next_cursor?: string;
  }>;

  // Fetch + extract a specific skill version.
  fetch(locator: string, version: string, cacheDir: string): Promise<{
    extracted_path: string;
    resolved_version: string;
    fetched_url: string;
    fetched_commit_sha?: string;
    fetched_archive_sha256: string;
  }>;

  // Read whatever manifests exist in the extracted directory and normalize.
  read(extracted_path: string): Promise<Omit<OperadSkill, "id" | "source" | "trust_tier" | "installed_at" | "enabled">>;

  // HEAD check for updates (Phase D — dashboard "update available" badge).
  latest(locator: string): Promise<string>;
}
```

## 5 — IPC + REST surface

### 5.1 IPC commands

```
skill.install <provider> <locator> [<version>=latest]
              [--force-revoke] [--force-take-ownership]
skill.uninstall <provider> <locator> [--force-revoke]
skill.update <provider> <locator>
skill.list [--provider=<p>]
skill.enable <provider> <locator>
skill.disable <provider> <locator>
skill.info <provider> <locator>
```

Deferred to v1.1: `skill.search`, `--check` on `list`.

### 5.2 REST API (dashboard)

```
GET    /api/skills                          list installed
GET    /api/skills/<id>                     get one (full manifest)
POST   /api/skills/install                  { provider, locator, version?,
                                              force_revoke?,
                                              force_take_ownership? }
POST   /api/skills/<id>/enable
POST   /api/skills/<id>/disable
POST   /api/skills/<id>/uninstall           { force_revoke? }
POST   /api/skills/<id>/update              install latest if newer
GET    /api/skills/events                   recent events (timeline)
```

Skill state transitions multiplex onto the existing daemon `/api/events`
SSE channel under `type: "skill"`. No new SSE endpoint.

### 5.3 CLI surface

```sh
tmx skill add <provider>:<locator>[@<version>] [--force-take-ownership]
tmx skill add <github-url>              # → git+url
tmx skill remove <provider>:<locator> [--force-revoke]
tmx skill list [--provider=<p>]
tmx skill update <provider>:<locator>
tmx skill enable <provider>:<locator>
tmx skill disable <provider>:<locator>
tmx skill info <provider>:<locator>
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
    my-command.md
  agents/
    my-agent.md
  .operad/
    operad.toml                      # operad-specific
```

Publishing checklist:

1. Repo on GitHub. Tag releases with semver (`v1.0.0`).
2. Optional: `topic:claude-code-plugin` for future `github-topic` discovery.
3. Optional: PR to `operad-stream/skills` to be listed in `operad-curated`.

Users install with `tmx skill add git+url:https://github.com/me/my-plugin@v1.0.0`
or `tmx skill add operad-curated:me/my-plugin`.

## 7 — Failure modes addressed

### 7.1 Two orchestrators fighting over one MCP process

`proxied` and `gateway` modes both cut from v1. Only `config-only` ships;
Claude Code owns every MCP lifecycle. Zero overlap.

### 7.2 SQLITE_BUSY / partial-read races

CLI is a pure IPC client. Daemon is the sole writer. SkillManager
serialises install transactions on a per-`(provider, locator)` mutex.
Cache writes go to `<version>.tmp` and atomic-rename after sha256 check.

### 7.3 In-flight workflow run referencing tools from an old version

MVP: install refused while any workflow run is active
(`INSTALL_BLOCKED_BY_RUN`); workflow start refused while install in
progress. Phase C adds generation pinning across workflows / OODA cycles
/ REST / IPC / scheduled runs.

### 7.4 Schema collision with Anthropic

Two-file split, no extension of upstream schemas. CI smoke test in
operad-curated catches breakage; minimum Claude Code version enforced
by `doctor`.

### 7.5 Termux symlink failures

Zero symlinks. All cross-references go through absolute paths in
`~/.claude.json` and `~/.claude/settings.json`.

### 7.6 `~/.claude.json` concurrent edit by user / two daemons

flock-advisory-locked surgical RMW. `operad_managed` is an object keyed by
mcp name with `{skill_id, daemon_id, installed_at}`. Three collision
cases: user-owned entry refuses with `MCP_NAME_USER_OWNED` (overridable
with `--force-take-ownership`); other-daemon-owned refuses with
`MCP_OWNED_BY_OTHER_DAEMON`; orphan `operad_managed` entry without a
matching `mcpServers` entry is GC'd on next touch.

### 7.7 Untrusted skill installs

`escape`-tier → `observe` bucket, cap `suggest`. `community`/`trusted` →
`suggest` bucket, cap `autonomous`. Caps enforced at promotion time.

### 7.8 Skill removing a tool with active consumers

Lease + scheduled-run check. Refuses unless `--force-revoke`.

### 7.9 Registry compromise / DNS hijack

- `mcp-official` TLS-pins SPKI (primary + backup).
- `operad-curated` commit-SHA-pins the index repo; rotated only on
  operad release.
- Git sources audit-log the resolved commit SHA.

### 7.10 Tool name collision between skills

Rejected at install with `TOOL_NAME_CONFLICT`. User resolves manually.

### 7.11 Cache GC ABA race

Two-phase tombstone (mark → wait sweeper tick → delete only if still
zero refcount).

### 7.12 SSE channel exhaustion

Skill events multiplex onto existing `/api/events` channel under
`type: "skill"`. No new EventSource.

## 8 — Testing strategy

- **Unit tests** for each provider's `fetch` / `read` / `latest` with
  recorded fixtures (no network). Includes `mcp-official` TLS-pin test
  that fails on cert mismatch (uses a fake cert + override of the pin
  for the test).
- **Unit tests** for the adapter merging `marketplace.json` +
  `.operad/operad.toml`, including the `.operad/` vs bare-`operad.toml`
  precedence warning, the no-operad-file case, and the no-marketplace-file
  case.
- **Unit tests** for `claude.json` writer: lock contention, malformed
  parse, user-owned name refusal, other-daemon-owned refusal, orphan
  cleanup, surgical update preserving unrelated entries.
- **Unit tests** for SkillManager: install / uninstall / update
  transactions, rollback on failure, autonomy-cap enforcement, lease +
  scheduled-run cascade, tool-name-conflict rejection.
- **Property test** for the cache atomic-rename: random crash injection
  between extract and rename.
- **Integration test (MVP):** install a fixture skill via IPC, verify
  tools/agents/workflows are registered, run a workflow that uses a tool,
  refuse a concurrent install while the workflow is running, uninstall,
  verify deregistration.
- **Integration test (Phase C):** generation discipline — start a long
  workflow, install a skill mid-flight that renames a tool the workflow
  uses, verify the in-flight run completes against the old generation
  while a new run picks up the new generation, verify cache GC waits
  for the pin to release.
- **CI smoke test in operad-curated:** install a fixture skill containing
  `.operad/operad.toml` with `claude plugin install` and assert
  claude-code accepts it.

## 9 — Implementation phases (round-3 restructure)

Round-3 reviewer rightly flagged that round-2's Phase A (generation
counter first, touching all three engines) was speculative engineering
ahead of validated demand. New phases:

### Phase A0 — load-bearing pipeline (round-4 split)
The minimum that proves the architecture works end-to-end. Lands behind
an `--enable-skills-preview` daemon flag so we can dogfood without
shipping unreviewed code paths to all users. Stop here for a week,
install some real skills, and let real usage drive A1/A2 priorities.

1. SQLite schema migration (all tables; generation tables exist but
   unused).
2. `daemon_id` provisioning (per §3.5 location precedence).
3. `~/.claude.json` writer (flock + mtime+sha256 re-check + retry-once).
4. `~/.claude/settings.json` writer (same pattern).
5. `SkillManager` skeleton, `types`, `store`.
6. `git+url` provider (simplest — validates the pipeline end-to-end).
7. Adapter merge logic + `.operad/operad.toml` parser.
8. 5-store install transaction (§3.15) with rollback on failure.
9. IPC handlers (install / uninstall / list / info — no enable /
   disable / update yet).
10. Naïve "live pointer" registration — installs allowed only when no
    tool consumers are active across ALL five caller types
    (`INSTALL_BLOCKED_BY_ACTIVE_CONSUMER`).
11. Unit tests for the writer, adapter, transaction, rollback paths.

### Phase A1 — autonomy ceiling
12. `tool_autonomy_caps` table + migration default (`autonomous` for
    pre-existing tools).
13. ToolExecutor promotion gate (`AUTONOMY_CAP_VIOLATION`).
14. CLI / dashboard plumbing for tool promotion respecting caps.
15. Cross-tier re-install rule (always-more-restrictive +
    `--accept-cap-downgrade`).
16. Unit tests for cap enforcement, migration, cross-tier rules.

### Phase A2 — conflicts + lease cascade
17. Tool / workflow / agent / mcp name-conflict rejection.
18. Lease invalidation on uninstall/update + scheduled-run paused
    cascade (`--force-revoke`).
19. enable / disable / update IPC + REST.
20. Unit tests for the conflict matrix + cascade behaviours.

### Phase B — more providers (broadens reach without architecture changes)
13. `operad-curated` (static index — also needs `operad-stream/skills`
    repo bootstrap).
14. `claude-marketplace` (biggest leverage).
15. `mcp-official` (registry + TLS pin + backup pin).
16. Provider fixture tests.

### Phase C — generation discipline (post-validation, scope only)
17. Generation counter in ToolExecutor / AgentEngine / WorkflowEngine.
18. Pin acquire/release at every call site (table from §3.7).
19. Two-phase cache tombstone in GC.
20. Drop the `INSTALL_BLOCKED_BY_RUN` coarse refusal.
21. Integration test for mid-flight install.

### Phase D — UX
22. REST endpoints + multiplexed SSE messages.
23. Dashboard `SkillManager.svelte` panel.
24. CLI `tmx skill` subcommands wired to IPC.
25. Docs in `docs/skills.md`.
26. CHANGELOG, README, landing-page entries.

### Phase E — hardening
27. Property tests for cache atomic rename.
28. Integration test for end-to-end MVP install/use/uninstall.
29. CI smoke test in operad-curated for claude-plugin compatibility.
30. Doctor probes: `~/.claude.json` consistency, Claude Code version,
    daemon_id existence.
31. Cache GC sweeper.

## 10 — Future work (out of scope for v1)

- `proxied` MCP mode (requires real stdio multiplexer).
- `gateway` MCP mode (re-add with real proxy semantics).
- `task-gateway` MCP mode (MCP Tasks primitive support).
- `smithery` provider (auth + rate limit + cache + debounce).
- `github-topic` provider (per-result trust UX).
- `huggingface-spaces` MCP-filtered provider.
- `tessl` adapter once they ship a public API.
- Auto-update on a daily cron.
- Signed manifests (sigstore / cosign).
- "Skill packs" (curated collections installed together).
- Bulk `--all` operations.
- `tmx skill search` across providers.
- `--check` on `tmx skill list`.

## 11 — Reviewer trail

- **Round 1 — Gemini 3 Pro Preview**: caught manifest-abuse schema
  collision, proxied-MCP zombie-port-lock, symlink/FUSE breakage,
  SQLite single-writer requirement.
- **Round 2 — high-thinking spec reviewer**: caught that `proxied` mode
  is broken at the protocol layer, "atomic version pointer" is
  DB-only-not-runtime, autonomy ceiling didn't exist, git sha
  meaningless for git clones, lease invalidation missing,
  `~/.claude.json` had no concurrency story, SSE at 6-per-origin limit.
  `proxied` and `smithery` cut.
- **Round 3 — high-thinking spec reviewer**: caught generation-counter
  scope omission (non-workflow callers), `operad_managed` array
  needed object+daemon_id semantics, `gateway` mode as dead weight,
  schema migration for `tool_autonomy_caps` unspecified, cross-tier
  re-install ambiguous, cache GC ABA race, `force_revoke` cascade
  incomplete, `.operad/operad.toml` discovery order ambiguous,
  version-string normalization missing, mcp-official backup TLS pin
  missing, 24h cache TTL magic number, git+url tag-less repo fallback
  missing, ETag instability, phase ordering speculative. `gateway`
  cut to single-value `McpLifecycle`. Phases restructured: MVP first
  (coarse install-blocked-by-run refusal), generation discipline
  deferred to Phase C.
- **Round 4 — high-thinking spec reviewer**: caught that the round-3
  MVP gate only blocked workflows (would race against OODA / REST /
  IPC / scheduled callers), the cross-tier "upward only" cap rule was
  backwards (silently kept elevated autonomy on less-trusted code),
  `flock` does NOT protect against claude-code's own writes to
  `~/.claude.json` (claude-code never agreed to the lock — needs
  mtime+sha256 re-check + retry-once), `daemon_id` at
  `~/.local/share/operad/daemon-id` is exactly what Syncthing syncs
  by default (must move to `$XDG_RUNTIME_DIR` or per-Android
  `$PREFIX/var/lib/`), `git archive` output is NOT byte-stable
  across git versions (use `git ls-tree` digest instead),
  `WORKFLOW_NAME_CONFLICT` was missing, the round-3 Phase A bundled
  twelve items, the 5-store transaction had no spec'd rollback
  contract. `daemon_id` relocated; cap rule reversed to
  always-more-restrictive; claude.json writer now does mtime+sha256
  re-check; phase A split into A0 (load-bearing pipe), A1 (autonomy
  cap), A2 (conflicts + lease). Round-4 reviewer asked the GC-of-
  in-flight-SKILL.md-cache question: GC now consults
  `~/.claude/settings.json` skills entries before marking. Round-5
  pending.
