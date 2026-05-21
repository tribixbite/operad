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

import { mkdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryDb } from "../memory-db.js";
import type { Logger } from "../log.js";
import type { ToolExecutor } from "../tools.js";
import type { WorkflowEngine } from "../workflow.js";
import { resolveDaemonId, type DaemonIdResult } from "./daemon-id.js";
import {
  type OperadSkill,
  type Provider,
  type ProviderModule,
  type TrustTier,
  buildSkillId,
  SkillError,
} from "./types.js";
import { SkillStore } from "./store.js";
import { writeClaudeJson } from "./claude-json.js";
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
    opts: { force_take_ownership?: boolean } = {},
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

    this.installInProgress = true;
    const trustTier = providerMod.trustTier(locator);
    const warnings: string[] = [];

    // Track each side-effect we've completed so the rollback knows
    // how far to unwind.
    const completedSteps: InstallStep[] = [];
    let skill: OperadSkill | null = null;
    // Phase C: open a generation transaction NOW so registerInMemory
    // writes into the pending generation rather than the live one.
    // commitGeneration runs at step-8 success; abortGeneration in
    // rollback drops the pending gen + its tool entries.
    const pendingGen = this.opts.toolExecutor.beginGenerationTransaction();
    completedSteps.push({ kind: "generation", gen: pendingGen });

    try {
      // Step 2: provider fetch + extract.
      const cacheParent = this.store.cacheParent(provider, locator);
      const fetch = await providerMod.fetch(locator, version, cacheParent);
      completedSteps.push({ kind: "fetch", cacheParent, version: fetch.resolved_version });

      // Step 3: adapter read.
      const manifest = await providerMod.read(fetch.extracted_path);

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

      // Step 4: cache disk is already in `<cacheParent>/<version>/`
      // from the provider's fetch. We treat the provider's
      // extracted_path as the canonical install location; no atomic
      // rename here because the provider already chose the final path
      // (git clone targets directly). Phase B providers that download
      // a tarball will use a `<version>.tmp` intermediate.

      // Step 5: ~/.claude.json (MCP entries).
      if (skill.mcps && skill.mcps.length > 0) {
        writeClaudeJson({
          daemon_id: this.daemonId.id,
          add: skill.mcps.map((m) => ({ entry: m, skill_id: skill!.id })),
          force_take_ownership: opts.force_take_ownership,
        });
        completedSteps.push({ kind: "claude_json", mcp_names: skill.mcps.map((m) => m.name) });
      }

      // Step 6: ~/.claude/settings.json (SKILL.md entries).
      if (skill.skill_mds && skill.skill_mds.length > 0) {
        writeSettingsJson({ add: skill.skill_mds.map((s) => s.bundle_path) });
        completedSteps.push({ kind: "settings_json", paths: skill.skill_mds.map((s) => s.bundle_path) });
      }

      // Step 7: in-memory registries — write into the pending
      // generation so the live one stays serving in-flight consumers
      // until the commit.
      this.registerInMemory(skill, pendingGen);
      completedSteps.push({ kind: "register" });

      // Step 8: SQLite COMMIT + atomic generation swap. From this
      // point new lookups resolve at pendingGen; existing pinned
      // callers continue at their snapshotted older gen.
      this.store.commitInstall(skill, pendingGen);
      this.opts.toolExecutor.commitGeneration(pendingGen);
      completedSteps.push({ kind: "sqlite" });

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
    } finally {
      this.installInProgress = false;
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

  // -- internals -----------------------------------------------------------

  private registerInMemory(skill: OperadSkill, gen?: number): void {
    const { defaultBucketForTier } = require("./types.js") as typeof import("./types.js");
    const defaultBucket = defaultBucketForTier(skill.trust_tier);

    for (const t of skill.tools ?? []) {
      // Phase C: route into the pending generation (gen) if a
      // transaction is open; otherwise the live one. The
      // registerTomlTools overload threads gen down to register().
      this.opts.toolExecutor.registerTomlTools([t.toml], gen);
      // Phase A1: write the autonomy cap row alongside registration.
      this.db.setToolAutonomyCap(
        t.toml.name,
        t.autonomy_cap,
        defaultBucket,
        skill.source.provider,
      );
    }
    if (this.opts.workflowEngine) {
      for (const w of skill.workflows ?? []) {
        // Compile + upsert. Engine's upsert is idempotent.
        // Use a local import to avoid circular deps.
        const { compileWorkflowConfig } = require("../workflow.js") as typeof import("../workflow.js");
        this.opts.workflowEngine.upsert(w.name, compileWorkflowConfig(w), `skill:${skill.id}`);
      }
    }
    // Agents (A1+): the AgentEngine doesn't yet expose a runtime
    // registration API the way ToolExecutor does. A0 ships without
    // agent registration; the agents land in the database via the
    // manifest_json column and Phase A1 will wire seedSpecializations.
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
    for (const t of skill.tools ?? []) {
      if (this.opts.toolExecutor.hasTool(t.toml.name)) {
        throw new SkillError(
          "TOOL_NAME_CONFLICT",
          `tool '${t.toml.name}' already exists`,
          { name: t.toml.name },
        );
      }
    }
    if (this.opts.workflowEngine) {
      for (const w of skill.workflows ?? []) {
        if (this.opts.workflowEngine.get(w.name)) {
          throw new SkillError(
            "WORKFLOW_NAME_CONFLICT",
            `workflow '${w.name}' already exists`,
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
        if (step.kind === "sqlite" && skill) {
          this.store.rollbackInstall(skill);
        } else if (step.kind === "register" && skill) {
          // Phase C: unregister from the pending generation, NOT live.
          // Find the generation step (always first if present) and use
          // it; fall back to live for legacy installs.
          const genStep = completedSteps.find((s): s is Extract<InstallStep, { kind: "generation" }> => s.kind === "generation");
          this.unregisterInMemory(skill, genStep?.gen);
        } else if (step.kind === "settings_json") {
          writeSettingsJson({ remove: step.paths });
        } else if (step.kind === "claude_json") {
          writeClaudeJson({ daemon_id: this.daemonId.id, remove: step.mcp_names });
        } else if (step.kind === "fetch") {
          const dir = join(step.cacheParent, step.version);
          if (existsSync(dir)) {
            try {
              rmSync(dir, { recursive: true, force: true });
            } catch (e) {
              this.log.warn(`Rollback cache rm failed at ${dir}: ${(e as Error).message}`);
            }
          }
        } else if (step.kind === "generation") {
          // Drop the pending generation. Idempotent — if commit
          // already swapped it to live, abortGeneration is a no-op.
          this.opts.toolExecutor.abortGeneration(step.gen);
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

type InstallStep =
  | { kind: "generation"; gen: number }
  | { kind: "fetch"; cacheParent: string; version: string }
  | { kind: "claude_json"; mcp_names: string[] }
  | { kind: "settings_json"; paths: string[] }
  | { kind: "register" }
  | { kind: "sqlite" };
