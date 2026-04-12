/**
 * memory-db.ts — SQLite + FTS5 persistent memory and cost tracking
 *
 * Uses bun:sqlite (zero-dep on Termux) with better-sqlite3 fallback for
 * CI/node environments. Database at ~/.local/share/operad/memory.db.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { Logger } from "./log.js";

/** Memory category types */
export type MemoryCategory = "convention" | "decision" | "discovery" | "warning" | "user_preference";

/** Memory record */
export interface MemoryRecord {
  id: number;
  project_path: string;
  category: MemoryCategory;
  content: string;
  content_hash: string;
  relevance_score: number;
  source_session_id: string | null;
  created_at: number;
  accessed_at: number;
  expires_at: number | null;
}

/** Cost record */
export interface CostRecord {
  id: number;
  session_name: string;
  session_id: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  num_turns: number;
  model: string | null;
  created_at: number;
}

/** Aggregated cost data */
export interface CostAggregate {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_duration_ms: number;
  total_turns: number;
  query_count: number;
}

/** SQLite database abstraction — supports bun:sqlite and better-sqlite3 */
interface DbHandle {
  exec(sql: string): void;
  prepare(sql: string): StmtHandle;
  close(): void;
}

/** Prepared statement abstraction */
interface StmtHandle {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** Default database directory */
const DB_DIR = join(homedir(), ".local", "share", "operad");
const DB_FILE = "memory.db";

/**
 * Schema statements — each string is one complete SQL statement.
 * Separated into an array because bun:sqlite's exec() only handles
 * one statement at a time (unlike better-sqlite3).
 */
const SCHEMA_STATEMENTS: string[] = [
  // Core memories table
  `CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'discovery',
    content TEXT NOT NULL,
    content_hash TEXT,
    relevance_score REAL DEFAULT 1.0,
    source_session_id TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    accessed_at INTEGER DEFAULT (unixepoch()),
    expires_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mem_project ON memories(project_path)`,
  `CREATE INDEX IF NOT EXISTS idx_mem_relevance ON memories(relevance_score DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_hash ON memories(project_path, content_hash)`,

  // FTS5 full-text search
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content='memories',
    content_rowid='id'
  )`,

  // Sync triggers: keep FTS5 in sync with memories table
  `CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE OF content ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
  END`,

  // Cost tracking table
  `CREATE TABLE IF NOT EXISTS costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_name TEXT NOT NULL,
    session_id TEXT,
    cost_usd REAL NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    duration_ms INTEGER,
    num_turns INTEGER,
    model TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_costs_session ON costs(session_name)`,
  `CREATE INDEX IF NOT EXISTS idx_costs_created ON costs(created_at)`,
];

/**
 * Open the database, auto-detecting runtime (bun:sqlite vs better-sqlite3).
 * bun:sqlite is a built-in bun module requiring zero compilation.
 */
async function openDatabase(dbPath: string): Promise<DbHandle> {
  // Try bun:sqlite first (zero-dep on Termux)
  if (typeof (globalThis as any).Bun !== "undefined") {
    try {
      // @ts-expect-error — bun:sqlite is a bun built-in, no TS declarations
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA foreign_keys=ON");
      return wrapBunSqlite(db);
    } catch {
      // Fall through to better-sqlite3
    }
  }

  // Fallback: better-sqlite3 (for node/CI environments)
  try {
    // @ts-expect-error — optional dependency, may not be installed
    const betterSqlite3 = await import("better-sqlite3");
    const Database = betterSqlite3.default ?? betterSqlite3;
    const db = new Database(dbPath);
    db.pragma("journal_mode=WAL");
    db.pragma("foreign_keys=ON");
    return wrapBetterSqlite3(db);
  } catch (err) {
    throw new Error(
      `No SQLite driver available. On Termux use bun; on node install better-sqlite3: ${err}`,
    );
  }
}

/** Wrap bun:sqlite Database to our DbHandle interface */
function wrapBunSqlite(db: any): DbHandle {
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]) => stmt.run(...params),
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params),
      };
    },
    close: () => db.close(),
  };
}

/** Wrap better-sqlite3 Database to our DbHandle interface */
function wrapBetterSqlite3(db: any): DbHandle {
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]) => stmt.run(...params),
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params),
      };
    },
    close: () => db.close(),
  };
}

/** Content hash for deduplication */
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export class MemoryDb {
  private db: DbHandle | null = null;
  private dbPath: string;
  private log: Logger;

  constructor(log: Logger, dbDir?: string) {
    this.log = log;
    const dir = dbDir ?? DB_DIR;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.dbPath = join(dir, DB_FILE);
  }

  /** Initialize the database and create tables */
  async init(): Promise<void> {
    this.db = await openDatabase(this.dbPath);
    // Execute schema — each statement separately for bun:sqlite compatibility
    for (const stmt of SCHEMA_STATEMENTS) {
      this.db.exec(stmt);
    }
    this.log.info(`Memory database initialized at ${this.dbPath}`);
  }

  /** Close the database */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private requireDb(): DbHandle {
    if (!this.db) throw new Error("Memory database not initialized — call init() first");
    return this.db;
  }

  // -- Memory CRUD -------------------------------------------------------------

  /**
   * Create a memory entry. Deduplicates by content hash per project.
   * Returns the memory ID, or null if duplicate.
   */
  createMemory(
    projectPath: string,
    category: MemoryCategory,
    content: string,
    sessionId?: string,
  ): number | null {
    const db = this.requireDb();
    const hash = hashContent(content);

    try {
      const result = db.prepare(
        `INSERT INTO memories (project_path, category, content, content_hash, source_session_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(projectPath, category, content, hash, sessionId ?? null);
      return Number(result.lastInsertRowid);
    } catch (err: any) {
      // UNIQUE constraint violation — duplicate content hash
      if (err?.message?.includes("UNIQUE")) {
        // Touch the existing memory instead (bump relevance)
        const existing = db.prepare(
          `SELECT id FROM memories WHERE project_path = ? AND content_hash = ?`,
        ).get(projectPath, hash) as { id: number } | undefined;
        if (existing) this.touchMemory(existing.id);
        return null;
      }
      throw err;
    }
  }

  /** Get top memories for a project, sorted by relevance */
  getTopMemories(projectPath: string, limit = 10): MemoryRecord[] {
    const db = this.requireDb();
    return db.prepare(
      `SELECT * FROM memories
       WHERE project_path = ? AND (expires_at IS NULL OR expires_at > unixepoch())
       ORDER BY relevance_score DESC, accessed_at DESC
       LIMIT ?`,
    ).all(projectPath, limit) as unknown as MemoryRecord[];
  }

  /** Full-text search memories for a project */
  searchMemories(projectPath: string, queryText: string, limit = 10): MemoryRecord[] {
    const db = this.requireDb();
    try {
      // Try FTS5 MATCH first
      return db.prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts fts ON fts.rowid = m.id
         WHERE m.project_path = ? AND fts.content MATCH ?
         AND (m.expires_at IS NULL OR m.expires_at > unixepoch())
         ORDER BY m.relevance_score DESC
         LIMIT ?`,
      ).all(projectPath, queryText, limit) as unknown as MemoryRecord[];
    } catch {
      // Fallback to LIKE if FTS5 query syntax is invalid
      return db.prepare(
        `SELECT * FROM memories
         WHERE project_path = ? AND content LIKE ?
         AND (expires_at IS NULL OR expires_at > unixepoch())
         ORDER BY relevance_score DESC
         LIMIT ?`,
      ).all(projectPath, `%${queryText}%`, limit) as unknown as MemoryRecord[];
    }
  }

  /** Get a single memory by ID */
  getMemory(id: number): MemoryRecord | undefined {
    const db = this.requireDb();
    return db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as unknown as MemoryRecord | undefined;
  }

  /** Delete a memory by ID */
  deleteMemory(id: number): boolean {
    const db = this.requireDb();
    const result = db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Bump accessed_at and boost relevance_score (capped at 2.0) */
  touchMemory(id: number): void {
    const db = this.requireDb();
    db.prepare(
      `UPDATE memories
       SET accessed_at = unixepoch(),
           relevance_score = MIN(relevance_score * 1.1, 2.0)
       WHERE id = ?`,
    ).run(id);
  }

  /** Decay relevance of old memories (multiply by 0.95, floor at 0.1) */
  decayMemories(projectPath: string, olderThanSec = 7 * 24 * 3600): number {
    const db = this.requireDb();
    const result = db.prepare(
      `UPDATE memories
       SET relevance_score = MAX(relevance_score * 0.95, 0.1)
       WHERE project_path = ?
       AND accessed_at < (unixepoch() - ?)
       AND relevance_score > 0.1`,
    ).run(projectPath, olderThanSec);
    return result.changes;
  }

  /** Delete expired memories */
  deleteExpired(): number {
    const db = this.requireDb();
    const result = db.prepare(
      `DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()`,
    ).run();
    return result.changes;
  }

  /** Count memories for a project */
  countMemories(projectPath: string): number {
    const db = this.requireDb();
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM memories WHERE project_path = ?`,
    ).get(projectPath) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  // -- Cost tracking -----------------------------------------------------------

  /** Record a cost entry from an SDK result message */
  recordCost(
    sessionName: string,
    sessionId: string | null,
    costUsd: number,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
    numTurns: number,
    model: string | null,
  ): number {
    const db = this.requireDb();
    const result = db.prepare(
      `INSERT INTO costs (session_name, session_id, cost_usd, input_tokens, output_tokens, duration_ms, num_turns, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionName, sessionId, costUsd, inputTokens, outputTokens, durationMs, numTurns, model);
    return Number(result.lastInsertRowid);
  }

  /** Get costs for a specific session */
  getSessionCosts(sessionName: string, limit = 100): CostRecord[] {
    const db = this.requireDb();
    return db.prepare(
      `SELECT * FROM costs WHERE session_name = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(sessionName, limit) as unknown as CostRecord[];
  }

  /** Get aggregate costs, optionally filtered by time range */
  getAggregateCosts(fromEpoch?: number, toEpoch?: number): CostAggregate {
    const db = this.requireDb();
    let sql = `SELECT
      COALESCE(SUM(cost_usd), 0) as total_cost_usd,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(duration_ms), 0) as total_duration_ms,
      COALESCE(SUM(num_turns), 0) as total_turns,
      COUNT(*) as query_count
    FROM costs`;
    const params: number[] = [];

    if (fromEpoch !== undefined || toEpoch !== undefined) {
      const conditions: string[] = [];
      if (fromEpoch !== undefined) {
        conditions.push("created_at >= ?");
        params.push(fromEpoch);
      }
      if (toEpoch !== undefined) {
        conditions.push("created_at <= ?");
        params.push(toEpoch);
      }
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    const row = db.prepare(sql).get(...params) as unknown as CostAggregate | undefined;
    return row ?? {
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_duration_ms: 0,
      total_turns: 0,
      query_count: 0,
    };
  }

  /** Get daily cost breakdown */
  getDailyCosts(days = 30): Array<{ date: string; cost_usd: number; queries: number }> {
    const db = this.requireDb();
    return db.prepare(
      `SELECT
        date(created_at, 'unixepoch') as date,
        SUM(cost_usd) as cost_usd,
        COUNT(*) as queries
      FROM costs
      WHERE created_at >= unixepoch() - (? * 86400)
      GROUP BY date(created_at, 'unixepoch')
      ORDER BY date DESC`,
    ).all(days) as unknown as Array<{ date: string; cost_usd: number; queries: number }>;
  }

  /** Get per-session cost breakdown */
  getPerSessionCosts(limit = 20): Array<{ session_name: string; total_cost: number; queries: number }> {
    const db = this.requireDb();
    return db.prepare(
      `SELECT
        session_name,
        SUM(cost_usd) as total_cost,
        COUNT(*) as queries
      FROM costs
      GROUP BY session_name
      ORDER BY total_cost DESC
      LIMIT ?`,
    ).all(limit) as unknown as Array<{ session_name: string; total_cost: number; queries: number }>;
  }
}
