/**
 * skills/types.ts — Canonical shapes for the skill / plugin marketplace.
 *
 * See docs/superpowers/specs/2026-05-20-skill-marketplace-design.md for
 * the full design. This file is the single source of truth for the
 * `OperadSkill` shape and its supporting enums.
 *
 * Provider modules adapt their native manifest formats into `OperadSkill`
 * via the `ProviderModule.read()` contract; the daemon never sees a
 * foreign manifest shape past the adapter layer.
 */

import type { TomlToolConfig } from "../tools.js";
import type { AgentConfig } from "../agents.js";
import type { WorkflowConfig } from "../workflow.js";

/**
 * Day-1 providers (4). See §3.9 of the spec. `smithery`, `github-topic`,
 * `awesome-list`, `tessl`, `huggingface-spaces` are deferred and
 * intentionally not in this union — adding them is a v1.1 schema change
 * with an explicit migration story.
 */
export type Provider =
  | "claude-marketplace"
  | "mcp-official"
  | "operad-curated"
  | "git+url";

/**
 * Trust tier governs install prompt + autonomy ceiling. Ordered
 * most → least trusted: `trusted` > `community` > `escape`. The
 * always-more-restrictive cross-tier re-install rule (§3.4) needs this
 * ordering to be load-bearing — use `tierRank` below to compare.
 */
export type TrustTier = "trusted" | "community" | "escape";

export function tierRank(t: TrustTier): number {
  // Higher number = more trusted.
  switch (t) {
    case "trusted": return 2;
    case "community": return 1;
    case "escape": return 0;
  }
}

/**
 * Autonomy bucket for a single tool. Existing Phase-10B primitive,
 * mirrored here for the cap type.
 */
export type AutonomyBucket = "observe" | "suggest" | "autonomous";

/**
 * MCP lifecycle mode. Single-value union in v1 (config-only). Reserved
 * for future expansion: `proxied`, `gateway`, `task-gateway`. Authors
 * who hand-roll a manifest with a future-mode value get a typed
 * `MCP_LIFECYCLE_UNSUPPORTED` error at install — better than silent
 * downgrade.
 */
export type McpLifecycle = "config-only";

/**
 * Where this skill version came from, fully resolved for audit. The
 * `version` field is the *canonical* form (semver with `v` prefix, or
 * `commit:<40-char-sha>`) — see §3.11 for normalization rules.
 */
export interface SkillSource {
  provider: Provider;
  locator: string;
  version: string;                  // canonical form
  fetched_url: string;
  fetched_at: number;
  /** Git sources only. `git rev-parse HEAD` after clone. */
  fetched_commit_sha?: string;
  /**
   * Bit-stable digest of the fetched bundle.
   * - Git sources: sha256 of `git ls-tree -r <sha>` output (NOT
   *   `git archive`, which isn't byte-stable across git versions).
   * - Registry sources: sha256 of the JSON response body.
   */
  fetched_archive_sha256: string;
}

/**
 * A single tool entry in a skill, carrying its TOML definition AND the
 * autonomy ceiling derived from the source tier. The cap is recorded
 * here so the loader can write it to `tool_autonomy_caps` without a
 * separate computation.
 */
export interface SkillToolEntry {
  toml: TomlToolConfig;
  autonomy_cap: AutonomyBucket;
}

/**
 * MCP server entry. Both stdio (`command`+`args`) and HTTP/SSE (`url`)
 * are supported in v1 under the single `config-only` lifecycle; Claude
 * Code owns the runtime in both cases.
 */
export interface SkillMcpEntry {
  name: string;
  // stdio form
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http / sse form
  url?: string;
  transport?: "stdio" | "http" | "sse";
  lifecycle: McpLifecycle;
}

/**
 * SKILL.md bundle. The `bundle_path` is an *absolute* path into the
 * cache directory — Claude Code's `~/.claude/settings.json` `skills`
 * array references it directly (no symlinks; see §3.8).
 */
export interface SkillMdEntry {
  name: string;
  bundle_path: string;
  frontmatter: Record<string, unknown>;
}

/**
 * The canonical internal shape every provider adapter normalizes into.
 * The five primitive arrays are all optional — a skill may ship any
 * subset (including the empty set, in which case operad still tracks
 * it for discovery / unification with Claude Code's view).
 *
 * `id` is `<provider>:<sanitized-locator>@<version>` and is the
 * primary key in the DB; the sanitization rule for locator collapses
 * `/` to `_`, lowercases, and rejects `..` segments.
 */
export interface OperadSkill {
  id: string;
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

/**
 * Provider-side listing entry. Used by the Phase D dashboard search;
 * not invoked in A0. Providers may stub.
 */
export interface ProviderListing {
  locator: string;
  name: string;
  description?: string;
  latest_version?: string;
  /** Provider-specific signal — e.g. smithery's useCount, GitHub stars. */
  popularity?: number;
}

/** One installable skill found by {@link SkillManager.search}. */
export interface SkillSearchHit {
  provider: Provider;
  locator: string;
  name: string;
  description?: string;
  latest_version?: string;
  popularity?: number;
  /** Tier the skill would install at — drives the UI's trust badge. */
  trust_tier: TrustTier;
  /** Whether this (provider, locator) already has an active install. */
  installed: boolean;
}

/**
 * Search across providers. `errors` is per-provider and non-fatal: one
 * unreachable registry must not hide results from the others.
 */
export interface SkillSearchResult {
  items: SkillSearchHit[];
  errors: Array<{ provider: Provider; error: string }>;
}

/**
 * Result of a `ProviderModule.fetch()` call. The provider extracts
 * the bundle into `<cacheDir>/<provider>/<sanitized-locator>/<version>/`
 * (the daemon owns the `<provider>/...` path layout; the provider is
 * passed just the parent and returns its created subdir).
 */
export interface FetchResult {
  extracted_path: string;
  resolved_version: string;          // canonical form
  fetched_url: string;
  fetched_commit_sha?: string;
  fetched_archive_sha256: string;
}

/**
 * What `ProviderModule.read()` returns — the OperadSkill minus the
 * fields the daemon populates (id, source metadata, trust tier,
 * installed_at, enabled flag).
 */
export type ProviderReadResult = Omit<
  OperadSkill,
  "id" | "source" | "trust_tier" | "enabled"
> & {
  /**
   * Non-fatal problems found while reading the bundle — a bare `operad.toml`
   * shadowed by `.operad/operad.toml`, an unsupported MCP lifecycle, an
   * unparseable `marketplace.json`.
   *
   * The adapter has always produced these; the type omitted them and
   * SkillManager.install discarded them, so users never saw any of it. Part of
   * the install result now.
   */
  warnings?: string[];
};

/**
 * The pluggable provider contract. New providers in v1.1+ implement
 * this interface and register in `src/skills/providers/index.ts`.
 */
export interface ProviderModule {
  id: Provider;
  trustTier(locator: string): TrustTier;
  list(opts: {
    query?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: ProviderListing[]; next_cursor?: string }>;
  fetch(
    locator: string,
    version: string,
    cacheDir: string,
  ): Promise<FetchResult>;
  read(extracted_path: string): Promise<ProviderReadResult>;
  latest(locator: string): Promise<string>;
}

// -- Typed error names --------------------------------------------------------

/**
 * The complete enumeration of skill-related typed errors. Spec
 * cross-references these names directly; keep this list in sync with
 * the spec when adding new error modes.
 *
 * Why string literals not an enum: bun:sqlite serializes these as
 * strings into `skill_events.detail`, and we want grep-ability across
 * the codebase + reviewer tooling.
 */
export type SkillErrorCode =
  // 3.5 — claude.json writer
  | "CLAUDE_JSON_MALFORMED"
  | "CLAUDE_JSON_RACED"
  | "MCP_NAME_USER_OWNED"
  | "MCP_OWNED_BY_OTHER_DAEMON"
  // 3.4 — conflicts / autonomy
  | "TOOL_NAME_CONFLICT"
  | "WORKFLOW_NAME_CONFLICT"
  | "AGENT_NAME_CONFLICT"
  | "MCP_NAME_CONFLICT"
  | "AUTONOMY_CAP_VIOLATION"
  | "PROVIDER_TIER_DOWNGRADE"             // not used in A0; reserved for cross-tier reinstall
  // 3.7 — install gate
  | "INSTALL_BLOCKED_BY_ACTIVE_CONSUMER"
  | "TOOL_BLOCKED_BY_ACTIVE_INSTALL"
  // 3.11 — locator
  | "LOCATOR_AMBIGUOUS_SHA"
  | "LOCATOR_MALFORMED"
  // 3.5 — mcp lifecycle
  | "MCP_LIFECYCLE_UNSUPPORTED"
  // 3.12 — lease cascade
  | "TOOL_HAS_ACTIVE_CONSUMERS"
  // 3.15 — install transaction
  | "PARTIAL_INSTALL_RECOVERY_FAILED"
  // Provider-side
  | "PROVIDER_FETCH_FAILED"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_READ_FAILED";

export class SkillError extends Error {
  constructor(
    public readonly code: SkillErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = "SkillError";
  }
}

// -- Constants ----------------------------------------------------------------

/**
 * Map a trust tier to the autonomy cap it imposes. Per §3.4:
 *   trusted   → autonomous (default bucket suggest)
 *   community → autonomous (default bucket suggest)
 *   escape    → suggest    (default bucket observe)
 */
export function capForTier(tier: TrustTier): AutonomyBucket {
  return tier === "escape" ? "suggest" : "autonomous";
}

/**
 * Map a trust tier to the default bucket new tools land in. Per §3.4.
 */
export function defaultBucketForTier(tier: TrustTier): AutonomyBucket {
  return tier === "escape" ? "observe" : "suggest";
}

/**
 * Sanitize a locator into a filesystem-safe path segment. Rejects path
 * traversal attempts; collapses `/` to `_`; lowercases. Used by both
 * the cache layout and the skill `id` derivation so both stay in
 * lockstep.
 */
export function sanitizeLocator(locator: string): string {
  if (locator.includes("..")) {
    throw new SkillError("LOCATOR_MALFORMED", `locator contains '..': ${locator}`);
  }
  return locator
    .toLowerCase()
    .replace(/\//g, "_")
    .replace(/[^a-z0-9_.\-@:]/g, "_");
}

/**
 * Map a canonical version string to a filesystem-safe directory name.
 *
 * `commit:<sha>` is a legal POSIX filename but not a legal Windows one — the
 * colon introduces an NTFS alternate data stream, so `git clone` into
 * `C:\cache\...\commit:abc` fails. The logical version keeps the colon (it is
 * the identity stored in SQLite and returned by the API); only the on-disk
 * name is rewritten. Must be used by every path that builds a version
 * directory, or the provider and the store will disagree about where a bundle
 * lives.
 */
export function versionDirName(version: string): string {
  return version.replace(/:/g, "-");
}

/**
 * Map a sanitized locator to a filesystem-safe directory name.
 *
 * sanitizeLocator deliberately keeps ':' because it is part of the stable
 * skill id (`git+url:https:__host_o_r@v1`), and changing that would rename
 * every already-installed skill. But a colon cannot appear in a Windows
 * directory name — it opens an NTFS alternate data stream — so a locator like
 * `C:\repos\r` produced `c:_repos_r` and mkdir failed with ENOTDIR, which is
 * why every install died on Windows.
 *
 * Same split as versionDirName: the identity keeps the colon, the path does
 * not. Both cacheDir() and the provider must use this, or they disagree about
 * where a bundle lives.
 */
export function locatorDirName(sanitizedLocator: string): string {
  return sanitizedLocator.replace(/:/g, "-");
}

/**
 * Build the canonical `OperadSkill.id` from its components. Stable
 * across re-installs of the same (provider, locator, version).
 */
export function buildSkillId(
  provider: Provider,
  locator: string,
  version: string,
): string {
  return `${provider}:${sanitizeLocator(locator)}@${version}`;
}
