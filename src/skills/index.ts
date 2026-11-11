/**
 * skills/index.ts — SkillManager: the daemon-side orchestrator.
 *
 * Spec §4.4. The SkillManager is the single entry point for
 * install / uninstall / list / info operations against installed
 * skills. It composes:
 *   • the per-provider resolver (fetch + read)
 *   • the SQLite + cache store
 *   • the claude.json / settings.json writers
 *   • the in-memory ToolExecutor / WorkflowEngine / AgentEngine
 *     registries
 *
 * Phase A0 ships behind a `--enable-skills-preview` daemon flag. The
 * naïve "live pointer" registration model is replaced by full
 * generation discipline in Phase C; for now we refuse new installs
 * while any tool consumer is active.
 */

import { rmSync, existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import type { MemoryDb } from "../memory-db.js";
import type { Logger } from "../log.js";
import type { ToolExecutor } from "../tools.js";
import type { WorkflowEngine, WorkflowRecord, WorkflowSpec } from "../workflow.js";
import { resolveDaemonId, type DaemonIdResult } from "./daemon-id.js";
import {
  type OperadSkill,
  type Provider,
  type ProviderModule,
  type TrustTier,
  buildSkillId,
  SkillError,
  type SkillSearchHit,
  type SkillSearchResult,
} from "./types.js";
import { SkillStore, type InstallSnapshot } from "./store.js";
import { writeClaudeJson, type PriorMcpEntry } from "./claude-json.js";
import { writeSettingsJson } from "./settings-json.js";

/**
 * Returned to the IPC caller after install / uninstall. Mirrors the
 * shape of `OperadSkill` plus event metadata.
 */
export interface SkillInstallResult {
  skill: OperadSkill;
  warnings: string[];
}

export interface SkillManagerOpts {
  /**
   * Provider registry. Day-1: just `git+url`. Phase B adds
   * `claude-marketplace`, `mcp-official`, `operad-curated`.
   */
  providers: Record<Provider, ProviderModule>;
  toolExecutor: ToolExecutor;
  workflowEngine: WorkflowEngine | null;
  /**
   * Returns true if ANY tool consumer is active (workflow run /
   * agent cycle / REST tool call / IPC tool call / scheduled run).
   * Phase A0 implements this as a simple workflow-run check; Phase
   * A2 widens it to cover the other four caller types per §3.7.
   */
  hasActiveConsumers: () => Array<{ kind: string; ref_id: string }>;
}

export class SkillManager {
  private daemonId: DaemonIdResult;
  private installInProgress = false;

  constructor(
    private db: MemoryDb,
    private log: Logger,
    private opts: SkillManagerOpts,
  ) {
    this.daemonId = resolveDaemonId();
    if (this.daemonId.may_sync) {
      this.log.warn(
        `daemon-id stored at ${this.daemonId.path} — this path may be synced by dotfile tools (Syncthing, chezmoi). Add it to your sync exclusion list to avoid two-daemon conflicts.`,
      );
    }
  }

  get store(): SkillStore {
    return this._store ??= new SkillStore(this.db, this.log);
  }
  private _store?: SkillStore;

  /**
   * Install a skill. Implements the §3.15 5-store transaction:
   *   1. (Validate + active-consumer gate)
   *   2. Fetch + extract via provider
   *   3. Adapter merges marketplace.json + .operad/operad.toml
   *   4. Cache disk: tmp dir → atomic rename
   *   5. ~/.claude.json: surgical RMW
   *   6. ~/.claude/settings.json: surgical RMW
   *   7. In-memory registries: register tools / workflows
   *   8. SQLite COMMIT (skills + skill_active_version)
   *
   * Failure at any step rolls back the prior steps in reverse order.
   * Step-1 failures need no rollback; later failures rollback all
   * prior side effects.
   */
  async install(
    provider: Provider,
    locator: string,
    version: string = "latest",
    opts: {
      force_take_ownership?: boolean;
      /**
       * Confirm a cross-tier re-install at a stricter tier when it
       * would clamp one or more tools' current_bucket. Without this,
       * the install refuses with PROVIDER_TIER_DOWNGRADE.
       */
      accept_cap_downgrade?: boolean;
    } = {},
  ): Promise<SkillInstallResult> {
    // Step 0: serialize installs daemon-wide. A0 doesn't have per-
    // (provider, locator) mutexes; install is a coarse exclusive
    // operation. Phase A2 + Phase C will refine.
    if (this.installInProgress) {
      throw new SkillError(
        "TOOL_BLOCKED_BY_ACTIVE_INSTALL",
        "Another skill install is already in progress; retry shortly.",
      );
    }

    // Phase C: the A0/A2 coarse INSTALL_BLOCKED_BY_ACTIVE_CONSUMER
    // refusal is gone. Active consumers pin a generation snapshot at
    // their acquire time; the install transaction creates generation
    // N+1 in a pending state, swaps the live pointer on commit, and
    // leaves N alive (with pinned tools) until the GC sweeper drops
    // it. See spec §3.7.

    const providerMod = this.opts.providers[provider];
    if (!providerMod) {
      throw new SkillError("PROVIDER_NOT_FOUND", `unknown provider: ${provider}`);
    }

    // The flag gates tool execution while an install is mid-flight, so it must
    // be cleared on every exit path. It used to be set here with the try/finally
    // starting ~65 lines below, leaving trustTier(), getActive(),
    // getToolAutonomyCap(), setToolAutonomyCap(), appendEvent() and
    // beginGenerationTransaction() outside it — a throw in any of them latched
    // installInProgress permanently, so every subsequent tool call failed with
    // TOOL_BLOCKED_BY_ACTIVE_INSTALL until the daemon was restarted.
    this.installInProgress = true;
    try {
      return await this.installUnguarded(
        provider, locator, version, opts, providerMod,
      );
    } finally {
      this.installInProgress = false;
    }
  }

  /**
   * The install body. Always invoked through {@link install}, which owns the
   * installInProgress flag — keeping the flag handling in a thin wrapper means
   * no early-return or throw inside here can leak it.
   */
  private async installUnguarded(
    provider: Provider,
    locator: string,
    version: string,
    opts: { force_take_ownership?: boolean; accept_cap_downgrade?: boolean },
    providerMod: import("./types.js").ProviderModule,
  ): Promise<{ skill: OperadSkill; warnings: string[] }> {
    const trustTier = providerMod.trustTier(locator);
    const warnings: string[] = [];

    // Cross-tier always-more-restrictive cap rule (spec §3.4).
    // If a different-tier skill with the same (provider, locator) is
    // already installed and the NEW tier would tighten the cap below
    // any tool's current_bucket, refuse with PROVIDER_TIER_DOWNGRADE
    // unless --accept-cap-downgrade was passed.
    const existing = this.store.getActive(provider, locator);
    if (existing && existing.trust_tier !== trustTier) {
      const { tierRank, capForTier } = require("./types.js") as typeof import("./types.js");
      const isStricter = tierRank(trustTier) < tierRank(existing.trust_tier);
      if (isStricter) {
        const newCap = capForTier(trustTier);
        // BUCKET_RANK in memory-db.ts is private; re-declare the same
        // ordering here. Keep in sync with the canonical order used
        // by promoteToolBucket.
        const order: Record<string, number> = { observe: 0, suggest: 1, supervised: 2, trusted: 3, autonomous: 4 };
        const newCapRank = order[newCap];
        // Find any tool with current_bucket > new cap.
        const clamped: Array<{ tool: string; from: string; to: string }> = [];
        for (const t of existing.tools ?? []) {
          const row = this.db.getToolAutonomyCap(t.toml.name);
          if (!row) continue;
          if ((order[row.current_bucket] ?? 0) > newCapRank) {
            clamped.push({ tool: t.toml.name, from: row.current_bucket, to: newCap });
          }
        }
        if (clamped.length > 0 && !opts.accept_cap_downgrade) {
          // No generation is open yet, so there is nothing to abort; the
          // wrapper's finally clears installInProgress.
          throw new SkillError(
            "PROVIDER_TIER_DOWNGRADE",
            `Cross-tier re-install would clamp ${clamped.length} tool(s) below their current bucket. Re-run with --accept-cap-downgrade to confirm.`,
            { clamped, existing_tier: existing.trust_tier, new_tier: trustTier },
          );
        }
        if (clamped.length > 0) {
          // User confirmed: clamp each tool's current bucket to the new cap.
          for (const c of clamped) {
            this.db.setToolAutonomyCap(
              c.tool, newCap, newCap, provider,
            );
          }
          this.store.appendEvent(existing.id, "update", {
            kind: "autonomy_clamp", clamped, new_tier: trustTier,
          });
          warnings.push(
            `${clamped.length} tool(s) clamped to '${newCap}' due to cross-tier downgrade: ${clamped.map((c) => c.tool).join(", ")}`,
          );
        }
      }
    }

    // Track each side-effect we've completed so the rollback knows
    // how far to unwind.
    const completedSteps: InstallStep[] = [];
    let skill: OperadSkill | null = null;
    // Phase C: open a generation transaction NOW so registerInMemory
    // writes into the pending generation rather than the live one.
    // commitGeneration runs at step-8 success; abortGeneration in
    // rollback drops the pending gen + its tool entries — or, if it was
    // already committed, makes the previous live generation live again.
    const previousGen = this.opts.toolExecutor.getCurrentGeneration();
    const pendingGen = this.opts.toolExecutor.beginGenerationTransaction();
    completedSteps.push({ kind: "generation", gen: pendingGen, previousGen });

    try {
      // Step 2: provider fetch + extract.
      const cacheParent = this.store.cacheParent(provider, locator);
      // Which version dirs exist before this fetch. A re-install of an
      // installed version (or of whatever is cached) lands on an existing
      // dir; the rollback must not delete it, because the live install is
      // using it.
      const dirsBefore = new Set(existsSync(cacheParent) ? readdirSync(cacheParent) : []);
      const fetch = await providerMod.fetch(locator, version, cacheParent);
      // Same mapping (versionDirName) the provider used to name the dir. The
      // rollback used join(cacheParent, version), which for `commit:<sha>`
      // is not the `commit-<sha>` dir that was created — never removed.
      const fetchedDir = this.store.cacheDir(provider, locator, fetch.resolved_version);
      completedSteps.push({ kind: "fetch", dir: fetchedDir, preexisted: dirsBefore.has(basename(fetchedDir)) });

      // Step 3: adapter read.
      const manifest = await providerMod.read(fetch.extracted_path);

      // Surface the adapter's non-fatal findings. These were produced and then
      // dropped on the floor, so problems like "bare operad.toml shadowed" or
      // "unsupported MCP lifecycle, treating as config-only" never reached the
      // person running the install.
      if (manifest.warnings?.length) warnings.push(...manifest.warnings);

      // Phase A1+: the adapter's per-tool autonomy_cap comes from
      // whichever tier the provider's read() hardcoded into the
      // readSkillManifests call (git+url hardcodes "escape"). But
      // some providers (claude-marketplace, operad-curated) delegate
      // to git+url and the ACTUAL tier is computed per-locator by
      // SkillManager. Override here so the cap matches the real tier.
      if (manifest.tools) {
        const { capForTier: capFn } = require("./types.js") as typeof import("./types.js");
        const correctCap = capFn(trustTier);
        for (const t of manifest.tools) {
          t.autonomy_cap = correctCap;
        }
      }

      // Compile the canonical OperadSkill before any further side
      // effects, so collision detection runs once and atomically.
      skill = {
        id: buildSkillId(provider, locator, fetch.resolved_version),
        name: manifest.name,
        description: manifest.description,
        trust_tier: trustTier,
        enabled: true,
        source: {
          provider,
          locator,
          version: fetch.resolved_version,
          fetched_url: fetch.fetched_url,
          fetched_at: Math.floor(Date.now() / 1000),
          fetched_commit_sha: fetch.fetched_commit_sha,
          fetched_archive_sha256: fetch.fetched_archive_sha256,
        },
        tools: manifest.tools,
        agents: manifest.agents,
        workflows: manifest.workflows,
        mcps: manifest.mcps,
        skill_mds: manifest.skill_mds,
      };

      // Conflict detection. Fails fast before any externally-visible
      // mutation so the user can retry without cleanup.
      this.detectConflicts(skill);

      // Compile and validate every workflow BEFORE any side effect. A spec
      // that failed validateSpec inside registerInMemory threw after earlier
      // workflows and tool cap rows were already written — with no rollback
      // step recorded yet — so they stayed behind and every retry failed
      // with WORKFLOW_NAME_CONFLICT.
      const compiledWorkflows = this.compileWorkflows(skill);

      // Step 4: cache disk is already in `<cacheParent>/<version>/`
      // from the provider's fetch. We treat the provider's
      // extracted_path as the canonical install location; no atomic
      // rename here because the provider already chose the final path
      // (git clone targets directly). Phase B providers that download
      // a tarball will use a `<version>.tmp` intermediate.

      // Step 5: ~/.claude.json (MCP entries).
      if (skill.mcps && skill.mcps.length > 0) {
        // The writer journals what each name held before the write, so the
        // rollback can restore it verbatim.
        const { created, prior } = writeClaudeJson({
          daemon_id: this.daemonId.id,
          add: skill.mcps.map((m) => ({ entry: m, skill_id: skill!.id })),
          force_take_ownership: opts.force_take_ownership,
        });
        completedSteps.push({ kind: "claude_json", created, prior });
      }

      // Step 6: ~/.claude/settings.json (SKILL.md entries). Roll back only
      // the paths this write added: a same-version reinstall re-adds the
      // live install's own paths, and removing those stripped its SKILL.mds.
      if (skill.skill_mds && skill.skill_mds.length > 0) {
        const { added } = writeSettingsJson({ add: skill.skill_mds.map((s) => s.bundle_path) });
        completedSteps.push({ kind: "settings_json", paths: added });
      }

      // Step 7: in-memory registries — write into the pending
      // generation so the live one stays serving in-flight consumers
      // until the commit. The step is recorded BEFORE registering, with a
      // journal registerInMemory fills as it goes: a throw part-way through
      // used to leave everything already written with no rollback entry.
      const journal: RegisterJournal = { tools: [], workflows: [] };
      completedSteps.push({ kind: "register", journal });
      this.registerInMemory(skill, pendingGen, compiledWorkflows, journal);

      // Step 8: SQLite COMMIT + atomic generation swap. From this
      // point new lookups resolve at pendingGen; existing pinned
      // callers continue at their snapshotted older gen.
      // The snapshot is taken right before the commit and the step recorded
      // right after it, so anything failing from here on (commitGeneration,
      // the install event) restores the previous rows instead of deleting
      // the active-version pointer.
      const snapshot = this.store.snapshotInstall(skill);
      this.store.commitInstall(skill, pendingGen);
      completedSteps.push({ kind: "sqlite", snapshot });
      this.opts.toolExecutor.commitGeneration(pendingGen);

      this.store.appendEvent(skill.id, "install", {
        provider,
        locator,
        version: fetch.resolved_version,
        trust_tier: trustTier,
        warnings,
      });
      this.log.info(`Installed skill ${skill.id} (tier=${trustTier})`);
      return { skill, warnings };
    } catch (err) {
      this.log.error(`Install failed at step ${completedSteps.length}: ${(err as Error).message}`);
      this.rollback(completedSteps, skill);
      throw err;
    }
  }

  /**
   * Uninstall a skill. Symmetric inverse of install — unregisters
   * primitives, removes MCP entries, removes SKILL.md entries,
   * tombstones the SQLite row. The cache directory is deferred to GC
   * (Phase C) to avoid the ABA race; A0 ships without GC, so the
   * cache directory simply persists until next daemon restart can
   * sweep it.
   */
  uninstall(skillId: string, opts: { force_revoke?: boolean } = {}): void {
    const skill = this.store.get(skillId);
    if (!skill) {
      throw new SkillError("PROVIDER_NOT_FOUND", `skill not found: ${skillId}`);
    }

    // Phase C: dropped the coarse INSTALL_BLOCKED_BY_ACTIVE_CONSUMER
    // gate. Uninstall removes the tool from the live generation only;
    // pinned older generations still see it, so in-flight callers
    // complete cleanly. The lease cascade below remains the real
    // protection — if any agent holds a lease on a tool this skill
    // owns, uninstall still refuses (or --force-revoke).
    //
    // Phase A2 lease cascade — §3.12. Before removing any tool, check
    // whether agents hold active leases or scheduled runs reference
    // it. By default we refuse with TOOL_HAS_ACTIVE_CONSUMERS so the
    // operator sees what would break; --force-revoke (opts.force_revoke)
    // revokes the leases + pauses the scheduled runs and records the
    // cascade in skill_events.detail.
    const cascade: {
      leases: Array<{ tool_name: string; lease_id: number; agent_name: string }>;
      paused_schedules: Array<{ tool_name: string; id: number; schedule_name: string }>;
    } = { leases: [], paused_schedules: [] };
    for (const t of skill.tools ?? []) {
      const leases = this.db.getActiveLeasesForTool(t.toml.name);
      for (const l of leases) {
        cascade.leases.push({ tool_name: t.toml.name, lease_id: l.id, agent_name: l.agent_name });
      }
    }
    if (cascade.leases.length > 0 && !opts.force_revoke) {
      throw new SkillError(
        "TOOL_HAS_ACTIVE_CONSUMERS",
        `Skill uninstall blocked: ${cascade.leases.length} active lease(s) reference tools owned by this skill. Re-run with --force-revoke to revoke them.`,
        { cascade },
      );
    }
    if (opts.force_revoke) {
      const leaseIds = cascade.leases.map((l) => l.lease_id);
      if (leaseIds.length > 0) this.db.revokeLeasesByIds(leaseIds);
      for (const t of skill.tools ?? []) {
        const paused = this.db.pauseSchedulesMentioningTool(t.toml.name);
        for (const p of paused) cascade.paused_schedules.push({ tool_name: t.toml.name, ...p });
      }
    }

    if (skill.mcps && skill.mcps.length > 0) {
      writeClaudeJson({
        daemon_id: this.daemonId.id,
        remove: skill.mcps.map((m) => m.name),
      });
    }

    if (skill.skill_mds && skill.skill_mds.length > 0) {
      writeSettingsJson({ remove: skill.skill_mds.map((s) => s.bundle_path) });
    }

    // Phase C: open a generation transaction so pinned older
    // consumers keep seeing this skill's tools until they release.
    // The new generation = clone(live) MINUS this skill's tools.
    const pendingGen = this.opts.toolExecutor.beginGenerationTransaction();
    try {
      this.unregisterInMemory(skill, pendingGen);
      this.opts.toolExecutor.commitGeneration(pendingGen);
    } catch (err) {
      this.opts.toolExecutor.abortGeneration(pendingGen);
      throw err;
    }

    this.store.markUninstalled(skillId);
    this.store.appendEvent(skillId, "uninstall", {
      id: skillId,
      ...(cascade.leases.length > 0 || cascade.paused_schedules.length > 0
        ? { force_revoke_cascade: cascade }
        : {}),
    });

    // Best-effort cache delete (A0 has no GC; this is the only cleanup path).
    this.store.removeCacheDir(
      skill.source.provider,
      skill.source.locator,
      skill.source.version,
    );

    this.log.info(`Uninstalled skill ${skillId}`);
  }

  list(provider?: Provider): OperadSkill[] {
    const all = this.store.listInstalled();
    return provider ? all.filter((s) => s.source.provider === provider) : all;
  }

  get(skillId: string): OperadSkill | null {
    return this.store.get(skillId);
  }

  /**
   * Search providers for installable skills.
   *
   * `ProviderModule.list()` has been implemented by `mcp-official` and
   * `operad-curated` since Phase B but was reachable from nothing — no REST
   * route, no IPC command — so the marketplace UI could only install a URL you
   * already knew. This is the discovery half.
   *
   * A provider that fails (network down, registry 500) contributes an entry in
   * `errors` rather than failing the whole search: a broken registry should not
   * hide results from the ones that work. `git+url` and `claude-marketplace`
   * legitimately return nothing — there is no index to search.
   */
  async search(opts: {
    query?: string;
    provider?: Provider;
    limit?: number;
    cursor?: string;
  } = {}): Promise<SkillSearchResult> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const providers = opts.provider
      ? ([opts.provider] as Provider[])
      : (Object.keys(this.opts.providers) as Provider[]);

    const results: SkillSearchHit[] = [];
    const errors: Array<{ provider: Provider; error: string }> = [];

    await Promise.all(providers.map(async (id) => {
      const mod = this.opts.providers[id];
      if (!mod) return;
      try {
        const r = await mod.list({ query: opts.query, limit, cursor: opts.cursor });
        for (const item of r.items ?? []) {
          results.push({
            provider: id,
            locator: item.locator,
            name: item.name,
            description: item.description,
            latest_version: item.latest_version,
            popularity: item.popularity,
            trust_tier: mod.trustTier(item.locator),
            // Lets the UI mark an entry as already present without a second call.
            installed: this.store.getActive(id, item.locator) != null,
          });
        }
      } catch (err) {
        errors.push({ provider: id, error: (err as Error).message });
      }
    }));

    // Client-side filter for providers whose list() ignores `query`.
    const q = opts.query?.trim().toLowerCase();
    const filtered = q
      ? results.filter((r) =>
          r.name.toLowerCase().includes(q) ||
          r.locator.toLowerCase().includes(q) ||
          (r.description ?? "").toLowerCase().includes(q))
      : results;

    // Most popular first, then alphabetical for a stable order.
    filtered.sort((a, b) =>
      (b.popularity ?? 0) - (a.popularity ?? 0) || a.name.localeCompare(b.name));

    return { items: filtered.slice(0, limit), errors };
  }

  // -- internals -----------------------------------------------------------

  /**
   * Compile and validate every workflow in the manifest. Throws (with no side
   * effects) on the first invalid one, naming it.
   */
  private compileWorkflows(skill: OperadSkill): Map<string, WorkflowSpec> {
    const compiled = new Map<string, WorkflowSpec>();
    if (!this.opts.workflowEngine) return compiled;
    // Local require to avoid a circular import (matches registerInMemory).
    const { compileWorkflowConfig, validateSpec } = require("../workflow.js") as typeof import("../workflow.js");
    for (const w of skill.workflows ?? []) {
      try {
        const spec = compileWorkflowConfig(w);
        validateSpec(spec);
        compiled.set(w.name, spec);
      } catch (err) {
        throw new SkillError(
          "PROVIDER_READ_FAILED",
          `workflow '${w.name}' is invalid: ${(err as Error).message}`,
          { workflow: w.name },
        );
      }
    }
    return compiled;
  }

  /**
   * Register tools, cap rows and workflows for `skill`.
   *
   * `journal` records, before each write, what that name held beforehand
   * (cap row / workflow record, or null), so an install rollback can put
   * back exactly the previous state — restoring an upgrade's previous
   * version instead of deleting it. `compiled` carries the specs
   * compileWorkflows already validated.
   */
  private registerInMemory(
    skill: OperadSkill,
    gen?: number,
    compiled?: Map<string, WorkflowSpec>,
    journal?: RegisterJournal,
  ): void {
    const { defaultBucketForTier } = require("./types.js") as typeof import("./types.js");
    const defaultBucket = defaultBucketForTier(skill.trust_tier);

    const order: Record<string, number> = { observe: 0, suggest: 1, supervised: 2, trusted: 3, autonomous: 4 };
    for (const t of skill.tools ?? []) {
      const existingRow = this.db.getToolAutonomyCap(t.toml.name);
      journal?.tools.push({ name: t.toml.name, priorCap: existingRow });
      // Phase C: route into the pending generation (gen) if a
      // transaction is open; otherwise the live one. The
      // registerTomlTools overload threads gen down to register().
      this.opts.toolExecutor.registerTomlTools([t.toml], gen);
      // Phase A1: write the autonomy cap row alongside registration.
      // Cross-tier rule (§3.4 round-4): if an existing row already
      // has a current_bucket that's still within the new cap, keep
      // it — don't silently demote a user-promoted tool back to the
      // tier default. The cross-tier downgrade path above has
      // already clamped any rows that would otherwise exceed the
      // new cap, so anything here is either at-or-below cap.
      const capRank = order[t.autonomy_cap];
      const preserveCurrent = existingRow
        && (order[existingRow.current_bucket] ?? 0) <= capRank
        ? existingRow.current_bucket
        : defaultBucket;
      this.db.setToolAutonomyCap(
        t.toml.name,
        t.autonomy_cap,
        preserveCurrent,
        skill.source.provider,
      );
    }
    if (this.opts.workflowEngine) {
      const specs = compiled ?? this.compileWorkflows(skill);
      for (const w of skill.workflows ?? []) {
        const spec = specs.get(w.name);
        if (!spec) continue; // unreachable: compileWorkflows covers every entry
        journal?.workflows.push({ name: w.name, prior: this.opts.workflowEngine.get(w.name) });
        // Engine's upsert is idempotent (UPSERT on name).
        this.opts.workflowEngine.upsert(w.name, spec, `skill:${skill.id}`);
      }
    }
    // Agents (A1+): the AgentEngine doesn't yet expose a runtime
    // registration API the way ToolExecutor does. A0 ships without
    // agent registration; the agents land in the database via the
    // manifest_json column and Phase A1 will wire seedSpecializations.
  }

  /**
   * Reverse a (possibly partial) registerInMemory from its journal, newest
   * write first. Each restore is independent so one failure does not leave
   * the rest unrun; failures are rethrown together for rollback() to log.
   */
  private undoRegister(journal: RegisterJournal, gen?: number): void {
    const errors: string[] = [];
    for (const w of [...journal.workflows].reverse()) {
      try {
        if (!this.opts.workflowEngine) break;
        if (w.prior) {
          this.opts.workflowEngine.upsert(w.name, w.prior.spec, w.prior.created_by);
          if (!w.prior.enabled) this.opts.workflowEngine.setEnabled(w.name, false);
        } else {
          this.opts.workflowEngine.delete(w.name);
        }
      } catch (err) {
        errors.push(`workflow ${w.name}: ${(err as Error).message}`);
      }
    }
    for (const t of [...journal.tools].reverse()) {
      try {
        this.opts.toolExecutor.unregister(t.name, gen);
        if (t.priorCap) {
          this.db.setToolAutonomyCap(t.name, t.priorCap.max_bucket, t.priorCap.current_bucket, t.priorCap.set_by_provider);
        } else {
          this.db.deleteToolAutonomyCap(t.name);
        }
      } catch (err) {
        errors.push(`tool ${t.name}: ${(err as Error).message}`);
      }
    }
    if (errors.length > 0) throw new Error(errors.join("; "));
  }

  private unregisterInMemory(skill: OperadSkill, gen?: number): void {
    for (const t of skill.tools ?? []) {
      // Phase C: route to the right generation. For uninstall via the
      // happy path, gen is the (live) currentGen — but the same tool
      // may also exist in older pinned generations, which we leave
      // alone so in-flight runs keep working.
      this.opts.toolExecutor.unregister(t.toml.name, gen);
      this.db.deleteToolAutonomyCap(t.toml.name);
    }
    // Workflows: WorkflowEngine.delete by name.
    if (this.opts.workflowEngine) {
      for (const w of skill.workflows ?? []) {
        this.opts.workflowEngine.delete(w.name);
      }
    }
  }

  private detectConflicts(skill: OperadSkill): void {
    // Treat a re-install of the same (provider, locator) as an
    // upgrade, not a conflict — the existing skill OWNS these tool
    // and workflow names, and a fresh install at a new version will
    // overwrite them via the generation transaction. Only DIFFERENT
    // skills colliding on a name should refuse.
    const existing = this.store.getActive(skill.source.provider, skill.source.locator);
    const sameLogicalSkill = existing !== null;

    for (const t of skill.tools ?? []) {
      if (this.opts.toolExecutor.hasTool(t.toml.name)) {
        if (sameLogicalSkill) continue;
        throw new SkillError(
          "TOOL_NAME_CONFLICT",
          `tool '${t.toml.name}' already exists (owned by another skill)`,
          { name: t.toml.name },
        );
      }
    }
    if (this.opts.workflowEngine) {
      for (const w of skill.workflows ?? []) {
        if (this.opts.workflowEngine.get(w.name)) {
          if (sameLogicalSkill) continue;
          throw new SkillError(
            "WORKFLOW_NAME_CONFLICT",
            `workflow '${w.name}' already exists (owned by another skill)`,
            { name: w.name },
          );
        }
      }
    }
    // MCP conflicts and agent conflicts: A0 defers (claude.json
    // writer catches MCP_NAME_USER_OWNED at write-time;
    // AGENT_NAME_CONFLICT lands with Phase A1 agent registration).
  }

  /**
   * Reverse-order rollback of side-effects recorded in
   * `completedSteps`. Failure of a rollback step itself logs a
   * PARTIAL_INSTALL_RECOVERY_FAILED event and continues — we don't
   * want one broken step to leave the other rollbacks unrun.
   */
  private rollback(completedSteps: InstallStep[], skill: OperadSkill | null): void {
    for (let i = completedSteps.length - 1; i >= 0; i--) {
      const step = completedSteps[i];
      try {
        if (step.kind === "sqlite") {
          // Put back the pre-commit skill row and active-version pointer:
          // the previous version stays active on a failed upgrade, and a
          // fresh install's rows are simply removed.
          this.store.restoreInstall(step.snapshot);
        } else if (step.kind === "register") {
          // Phase C: tools are unregistered from the pending generation,
          // NOT live (abortGeneration drops it anyway). Cap rows and
          // workflows are not generation-scoped, so put back exactly what
          // the journal says each name held before: an upgrade's previous
          // version is restored, and only names this install created are
          // deleted. unregisterInMemory deleted them all — the live
          // version's workflows (with their run history) and cap rows too.
          const genStep = completedSteps.find((s): s is Extract<InstallStep, { kind: "generation" }> => s.kind === "generation");
          this.undoRegister(step.journal, genStep?.gen);
        } else if (step.kind === "settings_json") {
          if (step.paths.length > 0) writeSettingsJson({ remove: step.paths });
        } else if (step.kind === "claude_json") {
          // One write: remove the names this install created, and put every
          // overwritten entry back exactly as it was — the previous
          // version's, or a user-owned entry taken over with
          // force_take_ownership (which used to be deleted outright).
          if (step.created.length > 0 || step.prior.length > 0) {
            writeClaudeJson({ daemon_id: this.daemonId.id, remove: step.created, restore: step.prior });
          }
        } else if (step.kind === "fetch") {
          // A dir that existed before this fetch belongs to the live
          // install (same-version reinstall); deleting it broke that install.
          if (!step.preexisted && existsSync(step.dir)) {
            try {
              rmSync(step.dir, { recursive: true, force: true });
            } catch (e) {
              this.log.warn(`Rollback cache rm failed at ${step.dir}: ${(e as Error).message}`);
            }
          }
        } else if (step.kind === "generation") {
          // Drop the pending generation (idempotent). If the commit already
          // swapped it to live, abortGeneration is a no-op and the
          // half-installed tool surface stayed live — revert to the
          // generation that was live before this install.
          this.opts.toolExecutor.abortGeneration(step.gen);
          this.opts.toolExecutor.revertGeneration(step.gen, step.previousGen);
        }
      } catch (err) {
        // Recovery itself failed — log a structured event so the user
        // can clean up manually. This is the
        // PARTIAL_INSTALL_RECOVERY_FAILED case from §3.15.
        if (skill) {
          try {
            this.store.appendEvent(skill.id, "error", {
              code: "PARTIAL_INSTALL_RECOVERY_FAILED",
              step: step.kind,
              error: (err as Error).message,
            });
          } catch { /* even the event log is broken; nothing more we can do */ }
        }
        this.log.error(
          `PARTIAL_INSTALL_RECOVERY_FAILED at step ${step.kind}: ${(err as Error).message}`,
        );
      }
    }
  }
}

// -- Step descriptors for rollback ----------------------------------------

/** Cap row shape as MemoryDb.getToolAutonomyCap returns it. */
type CapRow = NonNullable<ReturnType<MemoryDb["getToolAutonomyCap"]>>;

/**
 * What registerInMemory overwrote, in write order. `null` means the name
 * did not exist before this install.
 */
interface RegisterJournal {
  tools: Array<{ name: string; priorCap: CapRow | null }>;
  workflows: Array<{ name: string; prior: WorkflowRecord | null }>;
}

type InstallStep =
  /** `previousGen` was live when the transaction opened. */
  | { kind: "generation"; gen: number; previousGen: number }
  /** `dir` is the version's cache dir; `preexisted` = it was there before the fetch. */
  | { kind: "fetch"; dir: string; preexisted: boolean }
  /** `created` had no entry before; `prior` is the exact pre-write state of the rest. */
  | { kind: "claude_json"; created: string[]; prior: PriorMcpEntry[] }
  /** Only the paths this install added. */
  | { kind: "settings_json"; paths: string[] }
  | { kind: "register"; journal: RegisterJournal }
  /** Rows commitInstall overwrote, restored verbatim on rollback. */
  | { kind: "sqlite"; snapshot: InstallSnapshot };
