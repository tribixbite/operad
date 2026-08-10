/**
 * skills/gc.ts — Background cache sweeper.
 *
 * Spec §3.14. Two-phase tombstone:
 *   Pass 1 (mark): rows with refcount = 0 AND
 *     installed_at > cache_ttl AND NOT referenced from
 *     ~/.claude/settings.json skills[] → insert into
 *     skill_cache_pending_delete.
 *   Pass 2 (delete): rows still pending after the next sweeper tick
 *     AND still zero-refcount → rm -rf the directory + DELETE the
 *     skills row (if tombstoned) + DELETE the pending row.
 *
 * Pin-acquire-during-window: if a pin lands on a row that's in
 * pending_delete, the SkillManager (or whoever acquires the pin)
 * clears the pending row in the same transaction. A0 has no pins
 * yet, so the acquire-clears-pending path is a no-op until Phase C.
 *
 * Honours the recent-versions retention floor (§3.14): per
 * (provider, locator), the 3 most recent *installed* versions are never
 * swept, even with refcount = 0. Older versions GC unconditionally.
 *
 * Tombstoned (uninstalled) rows do NOT consume a retain slot — the floor
 * exists so a recent version can be rolled back to, and an uninstalled one
 * cannot be. Counting them meant a skill with <= 3 versions, all uninstalled,
 * was permanently protected and leaked both its cache dir and its DB row.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { MemoryDb } from "../memory-db.js";
import type { Logger } from "../log.js";
import type { ToolExecutor } from "../tools.js";
import { SkillStore } from "./store.js";

/**
 * Is `cacheDir` referenced by any path in `refs`?
 *
 * A settings.json entry points at a bundle *inside* a version's cache dir
 * (`<cacheDir>/skills/<name>`), so a prefix test is required — but the old
 * `ref.startsWith(cacheDir + "/")` hardcoded a POSIX separator and therefore
 * never matched on Windows, where both sides use backslashes. The GC would
 * then happily delete a cache dir Claude Code was actively loading a skill
 * from.
 *
 * Both sides are resolved and separator-normalised so the comparison holds on
 * every platform. Exported for testing.
 */
export function isPathReferenced(cacheDir: string, refs: Iterable<string>): boolean {
  const norm = (p: string) => resolve(p).split(sep).join("/");
  const target = norm(cacheDir);
  for (const ref of refs) {
    if (!ref) continue;
    const r = norm(ref);
    if (r === target || r.startsWith(target + "/")) return true;
  }
  return false;
}

/** Lazy — see same rationale in claude-json.ts / settings-json.ts. */
/**
 * Same home seam as settings-json.ts — without it the GC pass in tests reads
 * (and prunes against) the developer's real ~/.claude/settings.json.
 */
let homeOverride: string | null = null;
function settingsPath(): string { return join(homeOverride ?? homedir(), ".claude", "settings.json"); }

/**
 * Test-only: redirect settings.json resolution. Reset to null in afterEach.
 * @internal
 */
export function _setGcHome(home: string | null): void { homeOverride = home; }
const DEFAULT_TTL_HOURS = 168; // 7 days per §3.14
const DEFAULT_RETAIN_PER_PAIR = 3;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour — also the two-phase delay

export interface SkillGcOpts {
  /** Override default 7-day TTL (in hours). */
  cache_ttl_hours?: number;
  /** Per (provider, locator) versions kept on disk. Default 3. */
  retain_per_pair?: number;
  /** Sweep interval (ms). Default 1h. The same value is the gap between
   *  pass 1 (mark) and pass 2 (delete), implementing the two-phase
   *  tombstone window from §3.7. */
  sweep_interval_ms?: number;
}

interface SkillRow {
  id: string;
  provider: string;
  locator: string;
  version: string;
  fetched_at: number;
  installed_at: number;
  tombstoned: number;
}

interface PendingRow {
  provider: string;
  locator: string;
  version: string;
  marked_at: number;
}

export class SkillGc {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ttlSec: number;
  private retainPerPair: number;
  private intervalMs: number;
  /**
   * Optional ToolExecutor for in-memory generation pruning. When
   * present, pass-2 also calls toolExecutor.pruneGeneration(n) after
   * the SQL row is gone, dropping the per-generation tool map from
   * memory. Without this, old generations leak until daemon restart
   * (bounded by install rate × map size — small in practice but
   * proper to clean up).
   */
  private toolExecutor: ToolExecutor | null = null;

  constructor(
    private db: MemoryDb,
    private log: Logger,
    private store: SkillStore,
    opts: SkillGcOpts = {},
  ) {
    this.ttlSec = (opts.cache_ttl_hours ?? DEFAULT_TTL_HOURS) * 3600;
    this.retainPerPair = opts.retain_per_pair ?? DEFAULT_RETAIN_PER_PAIR;
    this.intervalMs = opts.sweep_interval_ms ?? SWEEP_INTERVAL_MS;
  }

  /** Wire the ToolExecutor so pass-2 can prune in-memory generations. */
  bindToolExecutor(te: ToolExecutor): void {
    this.toolExecutor = te;
  }

  /** Begin periodic sweeping. Calls sweep() once immediately. */
  start(): void {
    if (this.timer) return;
    this.runOnce("startup");
    this.timer = setInterval(() => this.runOnce("interval"), this.intervalMs);
    if (typeof (this.timer as any).unref === "function") {
      (this.timer as any).unref();
    }
    this.log.info(`Skill GC sweeper started (ttl=${this.ttlSec / 3600}h, retain=${this.retainPerPair}, interval=${this.intervalMs / 60000}min)`);
  }

  /** Stop the periodic timer. Call on daemon shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one full sweep: pass-2 (delete previously marked rows) + pass-1
   * (mark newly eligible rows). Public for tests + on-demand admin
   * calls. Errors are logged, not raised — GC must never block the
   * daemon's main loop.
   */
  runOnce(trigger: "startup" | "interval" | "manual"): {
    deleted: PendingRow[];
    marked: PendingRow[];
  } {
    const deleted = this.runPass2();
    const marked = this.runPass1();
    if (deleted.length > 0 || marked.length > 0) {
      this.log.info(
        `Skill GC (${trigger}): deleted ${deleted.length}, marked ${marked.length}`,
      );
    }
    return { deleted, marked };
  }

  /**
   * Pass 1 — find sweep-eligible rows and INSERT them into
   * skill_cache_pending_delete. Rows already pending are skipped
   * (idempotent). Rows that fail any eligibility test are NOT
   * removed from pending (if they had been previously marked, the
   * next acquire-clears-pending path is the only way out — which
   * lands with Phase C).
   */
  runPass1(): PendingRow[] {
    const db = this.db.requireDb();
    const now = Math.floor(Date.now() / 1000);
    const settingsRefs = this.readSettingsSkillRefs();
    const marked: PendingRow[] = [];

    try {
      // Candidates: tombstoned OR installed_at + ttl < now. The
      // active-version row is never tombstoned, so it's only
      // eligible via the TTL path — which it never hits because
      // installed_at gets bumped on each install/update. Net effect:
      // active version is naturally protected.
      const candidates = db.prepare(
        `SELECT id, provider, locator, version, fetched_at, installed_at, tombstoned
           FROM skills
          WHERE tombstoned = 1 OR (installed_at + ? < ?)
          ORDER BY installed_at ASC`,
      ).all(this.ttlSec, now) as unknown as SkillRow[];

      // Group by (provider, locator) so we can apply the retain-floor.
      const grouped = new Map<string, SkillRow[]>();
      for (const r of candidates) {
        const key = `${r.provider}:${r.locator}`;
        const list = grouped.get(key) ?? [];
        list.push(r);
        grouped.set(key, list);
      }

      for (const [key, rows] of grouped) {
        // The retain floor exists to keep the N most recent *usable* versions
        // of a (provider, locator) around for quick rollback. A tombstoned row
        // is an explicit uninstall — there is nothing to roll back to, so it
        // must never consume a retain slot.
        //
        // Applying the floor to all candidates (the previous behaviour) meant
        // a skill with <= retain_per_pair versions, all tombstoned, was fully
        // protected: it never got marked, so it never reached pass-2, and both
        // its cache dir and its skills row leaked forever. Four such rows were
        // found on a real machine.
        const tombstoned = rows.filter((r) => r.tombstoned === 1);
        const live = rows.filter((r) => r.tombstoned !== 1);
        const liveSweepable = [...live]
          .sort((a, b) => b.installed_at - a.installed_at)
          .slice(this.retainPerPair);
        const sweepable = [...tombstoned, ...liveSweepable];

        for (const r of sweepable) {
          // Honour SKILL.md settings.json refs (§3.14 round-4 fix).
          const cacheDir = this.store.cacheDir(
            r.provider as any, r.locator, r.version,
          );
          if (isPathReferenced(cacheDir, settingsRefs)) continue;

          // Idempotent insert — ON CONFLICT do nothing.
          const result = db.prepare(
            `INSERT INTO skill_cache_pending_delete
               (provider, locator, version, marked_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(provider, locator, version) DO NOTHING`,
          ).run(r.provider, r.locator, r.version, now);
          if (result.changes > 0) {
            marked.push({ provider: r.provider, locator: r.locator, version: r.version, marked_at: now });
          }
        }
      }
    } catch (err) {
      this.log.warn(`GC pass-1 failed: ${(err as Error).message}`);
    }
    return marked;
  }

  /**
   * Pass 2 — delete previously marked rows whose pending row is at
   * least one sweep_interval old (gives Phase C pin-acquirers the
   * chance to clear the pending flag). Refcounts are checked too
   * once §3.7 generation pins exist; A0 has no pins so the check
   * is implicit (no row ever appears in skill_generation_refs).
   */
  runPass2(): PendingRow[] {
    const db = this.db.requireDb();
    const now = Math.floor(Date.now() / 1000);
    const minAgeSec = Math.floor(this.intervalMs / 1000);
    const deleted: PendingRow[] = [];

    try {
      // The pin gate joins skill_generation_refs through skills.generation,
      // NOT through skill_active_version. markUninstalled deletes the
      // active-version row, so the old subquery returned no generations for
      // any uninstalled skill, NOT EXISTS was trivially true, and pass-2
      // deleted the cache dir even while consumers still held live pins on
      // that generation — exactly the case the gate exists to prevent.
      // skills.generation is written at install and survives tombstoning.
      const pending = db.prepare(
        `SELECT spd.provider, spd.locator, spd.version, spd.marked_at
           FROM skill_cache_pending_delete spd
          WHERE spd.marked_at + ? < ?
            AND NOT EXISTS (
              SELECT 1
                FROM skill_generation_refs r
                JOIN skills sk
                  ON sk.generation = r.generation
                 AND sk.provider = spd.provider
                 AND sk.locator  = spd.locator
                 AND sk.version  = spd.version
            )
            AND NOT EXISTS (
              SELECT 1 FROM skill_generation_refs r2
                WHERE r2.generation IN (
                  SELECT generation FROM skill_active_version sav
                   WHERE sav.provider = spd.provider AND sav.locator = spd.locator
                )
            )`,
      ).all(minAgeSec, now) as unknown as PendingRow[];

      for (const p of pending) {
        try {
          this.store.removeCacheDir(p.provider as any, p.locator, p.version);
          // Drop the skills row + active_version pointer (if still
          // present) + the pending row in one transaction.
          db.exec("BEGIN");
          try {
            // Active-version is gone post-uninstall in markUninstalled
            // but in the TTL-expired-active case (rare) we still want
            // to drop both. Use composite predicate.
            db.prepare(
              `DELETE FROM skill_active_version
                 WHERE provider = ? AND locator = ? AND version = ?`,
            ).run(p.provider, p.locator, p.version);
            db.prepare(
              `DELETE FROM skills
                 WHERE provider = ? AND locator = ? AND version = ?`,
            ).run(p.provider, p.locator, p.version);
            db.prepare(
              `DELETE FROM skill_cache_pending_delete
                 WHERE provider = ? AND locator = ? AND version = ?`,
            ).run(p.provider, p.locator, p.version);
            db.exec("COMMIT");
            deleted.push(p);
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
        } catch (err) {
          this.log.warn(`GC pass-2 failed for ${p.provider}:${p.locator}@${p.version}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.log.warn(`GC pass-2 query failed: ${(err as Error).message}`);
    }

    // Phase C in-memory pruning. After the SQL+disk cleanup, drop any
    // tool-executor generations that no longer have a backing
    // skill_active_version row AND no skill_generation_refs pin. The
    // current (live) generation is implicitly protected by
    // pruneGeneration's own guard.
    if (this.toolExecutor && deleted.length > 0) {
      this.pruneOrphanGenerations();
    }
    return deleted;
  }

  /**
   * Drop every ToolExecutor generation that no SQL row + no pin
   * references. Called after pass-2 because that's where rows
   * disappear. Best-effort — failures are logged not raised.
   */
  private pruneOrphanGenerations(): void {
    if (!this.toolExecutor) return;
    const db = this.db.requireDb();
    try {
      const activeRows = db.prepare(
        `SELECT DISTINCT generation FROM skill_active_version`,
      ).all() as Array<{ generation: number }>;
      const pinnedRows = db.prepare(
        `SELECT DISTINCT generation FROM skill_generation_refs`,
      ).all() as Array<{ generation: number }>;
      const keep = new Set<number>([
        ...activeRows.map((r) => r.generation),
        ...pinnedRows.map((r) => r.generation),
        this.toolExecutor.getCurrentGeneration(),
      ]);
      for (const gen of this.toolExecutor.listGenerations()) {
        if (!keep.has(gen)) {
          const pruned = this.toolExecutor.pruneGeneration(gen);
          if (pruned) this.log.debug(`GC pruned in-memory generation ${gen}`);
        }
      }
    } catch (err) {
      this.log.warn(`GC pruneOrphanGenerations failed: ${(err as Error).message}`);
    }
  }

  /**
   * Read absolute SKILL.md bundle paths from ~/.claude/settings.json's
   * skills[] array. Used by pass-1 to avoid GC'ing a cache directory
   * Claude Code is currently referencing.
   */
  private readSettingsSkillRefs(): Set<string> {
    if (!existsSync(settingsPath())) return new Set();
    try {
      const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
      const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
      return new Set(
        skills.filter((s): s is string => typeof s === "string"),
      );
    } catch {
      // Malformed settings.json — treat as no refs. Better to risk an
      // over-eager GC than to be silently blocked by an unreadable file.
      this.log.warn("GC: ~/.claude/settings.json unreadable; treating as no skill refs");
      return new Set();
    }
  }
}
