/**
 * skills/store.ts — SQLite + cache filesystem for installed skills.
 *
 * Spec §4.3 + §3.8. The store is the daemon's sole persistence layer
 * for skill state; per the single-writer principle (§3.6) the CLI
 * never touches it directly.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemoryDb } from "../memory-db.js";
import type { Logger } from "../log.js";
import {
  type OperadSkill,
  type Provider,
  type TrustTier,
  sanitizeLocator,
  versionDirName,
  locatorDirName,
} from "./types.js";

/**
 * Root for all skill cache directories. Computed lazily because some
 * test harnesses override $HOME after this module is imported — a
 * top-level `const` evaluation would capture the pre-override path.
 */
export function skillsCacheRoot(): string {
  return join(homedir(), ".local", "share", "operad", "skills", "cache");
}

/**
 * Row shape returned by the read queries. `manifest_json` is parsed
 * back into an `OperadSkill` by `rowToSkill`.
 */
interface SkillRow {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  locator: string;
  version: string;
  fetched_url: string;
  fetched_commit_sha: string | null;
  fetched_archive_sha256: string;
  fetched_at: number;
  trust_tier: string;
  enabled: number;
  tombstoned: number;
  manifest_json: string;
  installed_at: number;
}

interface ActiveVersionRow {
  provider: string;
  locator: string;
  version: string;
  generation: number;
}

export class SkillStore {
  private cacheRoot: string;

  constructor(private db: MemoryDb, private log: Logger) {
    this.cacheRoot = skillsCacheRoot();
    mkdirSync(this.cacheRoot, { recursive: true, mode: 0o700 });
  }

  /**
   * Path where a specific (provider, locator, version) bundle should
   * land on disk. Includes sanitization to prevent path traversal.
   */
  cacheDir(provider: Provider, locator: string, version: string): string {
    return join(this.cacheRoot, provider, locatorDirName(sanitizeLocator(locator)), versionDirName(version));
  }

  /**
   * Parent path that providers extract into. The provider's `fetch`
   * method receives this and returns the actual extracted_path
   * (typically `<cacheParent>/<version>/`).
   */
  cacheParent(provider: Provider, locator: string): string {
    return join(this.cacheRoot, provider, locatorDirName(sanitizeLocator(locator)));
  }

  /**
   * Insert the skill row + flip the active_version pointer in one
   * transaction. Used as the COMMIT step of the §3.15 5-store install
   * transaction.
   */
  commitInstall(skill: OperadSkill, generation: number): void {
    const db = this.db.requireDb();
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO skills (
          id, name, description, provider, locator, version, fetched_url,
          fetched_commit_sha, fetched_archive_sha256, fetched_at, trust_tier,
          enabled, tombstoned, manifest_json, installed_at, generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          fetched_url = excluded.fetched_url,
          fetched_commit_sha = excluded.fetched_commit_sha,
          fetched_archive_sha256 = excluded.fetched_archive_sha256,
          fetched_at = excluded.fetched_at,
          trust_tier = excluded.trust_tier,
          enabled = 1,
          tombstoned = 0,
          manifest_json = excluded.manifest_json,
          installed_at = excluded.installed_at,
          generation = excluded.generation`,
      ).run(
        skill.id,
        skill.name,
        skill.description,
        skill.source.provider,
        skill.source.locator,
        skill.source.version,
        skill.source.fetched_url,
        skill.source.fetched_commit_sha ?? null,
        skill.source.fetched_archive_sha256,
        skill.source.fetched_at,
        skill.trust_tier,
        JSON.stringify(skill),
        Math.floor(Date.now() / 1000),
        generation,
      );

      db.prepare(
        `INSERT INTO skill_active_version (provider, locator, version, generation)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider, locator) DO UPDATE SET
           version = excluded.version,
           generation = excluded.generation`,
      ).run(skill.source.provider, skill.source.locator, skill.source.version, generation);

      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Reverse `commitInstall` — used by §3.15 compensation when a later
   * transaction step fails after the SQLite row has been inserted.
   */
  rollbackInstall(skill: OperadSkill): void {
    const db = this.db.requireDb();
    db.exec("BEGIN");
    try {
      // If we're rolling back an UPSERT (i.e. there was a previous
      // version), the simplest correct behaviour is to delete the row;
      // any caller that needs the previous row preserved must capture
      // it before calling commitInstall. A0 only installs fresh.
      db.prepare(`DELETE FROM skill_active_version WHERE provider = ? AND locator = ?`)
        .run(skill.source.provider, skill.source.locator);
      db.prepare(`DELETE FROM skills WHERE id = ?`).run(skill.id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Mark a skill as tombstoned (uninstall). Cache directory is GC'd later. */
  markUninstalled(skillId: string): void {
    const db = this.db.requireDb();
    const row = db.prepare(
      `SELECT provider, locator FROM skills WHERE id = ?`,
    ).get(skillId) as { provider: string; locator: string } | undefined;
    if (!row) return;

    db.exec("BEGIN");
    try {
      db.prepare(`UPDATE skills SET tombstoned = 1, enabled = 0 WHERE id = ?`).run(skillId);
      db.prepare(
        `DELETE FROM skill_active_version WHERE provider = ? AND locator = ?`,
      ).run(row.provider, row.locator);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Set the enabled flag for a skill without touching the cache. */
  setEnabled(skillId: string, enabled: boolean): void {
    const db = this.db.requireDb();
    db.prepare(`UPDATE skills SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, skillId);
  }

  /** All currently-installed, non-tombstoned skills. */
  listInstalled(): OperadSkill[] {
    const db = this.db.requireDb();
    const rows = db.prepare(
      `SELECT * FROM skills WHERE tombstoned = 0 ORDER BY installed_at DESC`,
    ).all() as unknown as SkillRow[];
    return rows.map(rowToSkill);
  }

  /** Lookup a single skill by id. */
  get(skillId: string): OperadSkill | null {
    const db = this.db.requireDb();
    const row = db.prepare(
      `SELECT * FROM skills WHERE id = ? AND tombstoned = 0`,
    ).get(skillId) as SkillRow | undefined;
    return row ? rowToSkill(row) : null;
  }

  /** Lookup the currently-active version for a (provider, locator) pair. */
  getActive(provider: Provider, locator: string): OperadSkill | null {
    const db = this.db.requireDb();
    const av = db.prepare(
      `SELECT * FROM skill_active_version WHERE provider = ? AND locator = ?`,
    ).get(provider, locator) as ActiveVersionRow | undefined;
    if (!av) return null;
    const row = db.prepare(`SELECT * FROM skills WHERE id = ?`).get(
      `${av.provider}:${sanitizeLocator(av.locator)}@${av.version}`,
    ) as SkillRow | undefined;
    return row ? rowToSkill(row) : null;
  }

  /**
   * Append an event row. Used by SkillManager to track install /
   * update / uninstall / error / enable / disable events.
   */
  appendEvent(
    skillId: string,
    eventType: "install" | "update" | "enable" | "disable" | "uninstall" | "error",
    detail?: Record<string, unknown>,
  ): void {
    const db = this.db.requireDb();
    db.prepare(
      `INSERT INTO skill_events (skill_id, event_type, detail, occurred_at)
       VALUES (?, ?, ?, ?)`,
    ).run(skillId, eventType, detail ? JSON.stringify(detail) : null, Math.floor(Date.now() / 1000));
  }

  /**
   * Remove a cache directory from disk. Best-effort — failures are
   * logged but not raised, since the SQLite truth is authoritative
   * and a leftover directory just wastes space.
   */
  removeCacheDir(provider: Provider, locator: string, version: string): void {
    const dir = this.cacheDir(provider, locator, version);
    if (!existsSync(dir)) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.log.warn(`Failed to remove cache dir ${dir}: ${(err as Error).message}`);
    }
  }

  /**
   * Quick collision detector — used by SkillManager before any disk /
   * external-file write to give the user a typed error early.
   */
  hasActiveVersion(provider: Provider, locator: string): boolean {
    const db = this.db.requireDb();
    const row = db.prepare(
      `SELECT 1 FROM skill_active_version WHERE provider = ? AND locator = ?`,
    ).get(provider, locator);
    return row !== undefined;
  }
}

function rowToSkill(row: SkillRow): OperadSkill {
  const parsed = JSON.parse(row.manifest_json) as OperadSkill;
  // Defensive: ensure `enabled` reflects the row, not whatever was in
  // the cached manifest_json (this lets enable/disable bypass a
  // manifest rewrite).
  parsed.enabled = row.enabled === 1;
  parsed.trust_tier = row.trust_tier as TrustTier;
  return parsed;
}
