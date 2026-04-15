/**
 * memory-db.ts — SQLite + FTS5 persistent memory and cost tracking
 *
 * Uses bun:sqlite (zero-dep on Termux) with better-sqlite3 fallback for
 * CI/node environments. Database at ~/.local/share/operad/memory.db.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

/** Token quota status for subscription-based rate limiting */
export interface QuotaStatus {
  /** Auto-detected plan info from ~/.claude/.credentials.json */
  plan: string | null;               // e.g. "Max 20x", "Max 5x", "Pro"
  rate_limit_tier: string | null;    // e.g. "default_claude_max_20x"
  weekly_tokens_used: number;
  weekly_tokens_limit: number;       // 0 = auto (plan-detected, no hard number)
  weekly_pct: number;                // 0-100 (only meaningful if limit > 0)
  weekly_level: "ok" | "warning" | "critical" | "exceeded" | "unconfigured";
  window_tokens_used: number;
  window_hours: number;
  tokens_per_hour: number;           // current velocity in window
  daily_avg_tokens: number;          // average daily consumption this week
  velocity_trend: "rising" | "falling" | "stable"; // vs daily average
  projected_weekly_total: number;    // at current rate, extrapolated to full week
  top_sessions: Array<{ name: string; tokens: number; pct: number }>;
}

/** Detected Claude plan from credentials file */
interface ClaudePlanInfo {
  subscriptionType: string;
  rateLimitTier: string;
  label: string;
}

/** Known plan tier labels by rateLimitTier prefix */
const PLAN_LABELS: Record<string, string> = {
  default_claude_max_20x: "Max 20x",
  default_claude_max_5x: "Max 5x",
  default_claude_max: "Max",
  default_claude_pro: "Pro",
};

/**
 * Auto-detect Claude subscription plan from ~/.claude/.credentials.json.
 * Returns null if credentials are missing or unparseable.
 */
export function detectClaudePlan(): ClaudePlanInfo | null {
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    if (!existsSync(credPath)) return null;
    const raw = JSON.parse(readFileSync(credPath, "utf-8"));
    const oauth = raw?.claudeAiOauth;
    if (!oauth?.rateLimitTier) return null;
    const tier = String(oauth.rateLimitTier);
    const subType = String(oauth.subscriptionType ?? "unknown");
    // Match known tier prefixes (tier may have suffixes we don't know about)
    const label = Object.entries(PLAN_LABELS).find(([prefix]) => tier.startsWith(prefix))?.[1]
      ?? `${subType.charAt(0).toUpperCase()}${subType.slice(1)}`;
    return { subscriptionType: subType, rateLimitTier: tier, label };
  } catch {
    return null;
  }
}

/** Compute quota status from DB, config thresholds, and auto-detected plan */
export function computeQuotaStatus(
  db: MemoryDb,
  quotaConfig: { quota_weekly_tokens: number; quota_warning_pct: number; quota_critical_pct: number; quota_window_hours: number },
): QuotaStatus {
  // Auto-detect plan tier from credentials
  const plan = detectClaudePlan();

  const weekly = db.getWeeklyTokens();
  const windowTokens = db.getWindowTokens(quotaConfig.quota_window_hours);
  const windowTotal = windowTokens.reduce((sum, s) => sum + s.total_tokens, 0);
  const tokensPerHour = quotaConfig.quota_window_hours > 0
    ? Math.round(windowTotal / quotaConfig.quota_window_hours)
    : 0;

  // Hours elapsed this week (since Monday 00:00 UTC)
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const hoursElapsed = daysSinceMonday * 24 + now.getUTCHours() + now.getUTCMinutes() / 60;
  const hoursRemaining = Math.max(0, 168 - hoursElapsed); // 168 hours in a week
  const projected = weekly.total_tokens + tokensPerHour * hoursRemaining;

  // Daily average: total tokens this week / days elapsed (min 1)
  const daysElapsed = Math.max(1, Math.ceil(hoursElapsed / 24));
  const dailyAvg = Math.round(weekly.total_tokens / daysElapsed);

  // Velocity trend: compare current hourly rate to the daily average hourly rate
  const avgHourlyRate = dailyAvg / 24;
  const ratio = avgHourlyRate > 0 ? tokensPerHour / avgHourlyRate : 1;
  const velocityTrend: QuotaStatus["velocity_trend"] =
    ratio > 1.5 ? "rising" : ratio < 0.5 ? "falling" : "stable";

  // Use manual limit if configured, otherwise no hard limit (plan auto-detected)
  const limit = quotaConfig.quota_weekly_tokens;
  const pct = limit > 0 ? Math.round((weekly.total_tokens / limit) * 100) : 0;

  let level: QuotaStatus["weekly_level"];
  if (limit === 0) {
    // No manual limit set — use velocity-based awareness instead
    // Still useful to show "unconfigured" so dashboard knows there's no hard cap
    level = "unconfigured";
  } else if (pct >= 100) {
    level = "exceeded";
  } else if (pct >= quotaConfig.quota_critical_pct) {
    level = "critical";
  } else if (pct >= quotaConfig.quota_warning_pct) {
    level = "warning";
  } else {
    level = "ok";
  }

  // Top sessions by token usage this week
  const weeklyBySession = db.getWindowTokens(hoursElapsed || 1);
  const weekTotal = weekly.total_tokens || 1; // avoid div by zero
  const topSessions = weeklyBySession
    .filter(s => s.total_tokens > 0)
    .slice(0, 5)
    .map(s => ({
      name: s.session_name,
      tokens: s.total_tokens,
      pct: Math.round((s.total_tokens / weekTotal) * 100),
    }));

  return {
    plan: plan?.label ?? null,
    rate_limit_tier: plan?.rateLimitTier ?? null,
    weekly_tokens_used: weekly.total_tokens,
    weekly_tokens_limit: limit,
    weekly_pct: pct,
    weekly_level: level,
    window_tokens_used: windowTotal,
    window_hours: quotaConfig.quota_window_hours,
    tokens_per_hour: tokensPerHour,
    daily_avg_tokens: dailyAvg,
    velocity_trend: velocityTrend,
    projected_weekly_total: Math.round(projected),
    top_sessions: topSessions,
  };
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

  // Agent run tracking
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    session_name TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    started_at INTEGER DEFAULT (unixepoch()),
    finished_at INTEGER,
    cost_usd REAL DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    turns INTEGER DEFAULT 0,
    error TEXT,
    trigger TEXT NOT NULL DEFAULT 'standalone'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_agent ON agent_runs(agent_name)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_started ON agent_runs(started_at DESC)`,

  // Persistent goal tree: hierarchical goals with outcome tracking
  `CREATE TABLE IF NOT EXISTS agent_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES agent_goals(id),
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    priority INTEGER DEFAULT 5,
    agent_name TEXT,
    expected_outcome TEXT,
    actual_outcome TEXT,
    success_score REAL,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    completed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_goals_status ON agent_goals(status)`,
  `CREATE INDEX IF NOT EXISTS idx_goals_agent ON agent_goals(agent_name)`,
  `CREATE INDEX IF NOT EXISTS idx_goals_parent ON agent_goals(parent_id)`,

  // Decision journal: every decision with rationale and outcome scoring
  `CREATE TABLE IF NOT EXISTS agent_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    session_name TEXT,
    goal_id INTEGER REFERENCES agent_goals(id),
    action TEXT NOT NULL,
    rationale TEXT NOT NULL,
    alternatives TEXT,
    expected_outcome TEXT,
    actual_outcome TEXT,
    score REAL,
    context_snapshot TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    evaluated_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_agent ON agent_decisions(agent_name)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_goal ON agent_decisions(goal_id)`,

  // Inter-agent message bus
  `CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'info',
    content TEXT NOT NULL,
    metadata TEXT,
    read_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_msgs_to ON agent_messages(to_agent, read_at)`,

  // User profile: mind meld data with weighting
  `CREATE TABLE IF NOT EXISTS user_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT,
    weight REAL NOT NULL DEFAULT 1.0,
    source TEXT,
    tags TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_hash ON user_profile(content_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_profile_category ON user_profile(category)`,
  `CREATE INDEX IF NOT EXISTS idx_profile_weight ON user_profile(weight DESC)`,

  // Strategy evolution: self-modifying strategy loaded into master controller
  `CREATE TABLE IF NOT EXISTS agent_strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    strategy_text TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    rationale TEXT,
    performance_score REAL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_agent ON agent_strategies(agent_name, active)`,

  // Agent conversation history (persistent chat sessions)
  `CREATE TABLE IF NOT EXISTS agent_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    session_id TEXT,
    thinking TEXT,
    cost_usd REAL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conv_agent ON agent_conversations(agent_name, created_at)`,

  // Per-agent accumulated knowledge (persists across runs)
  `CREATE TABLE IF NOT EXISTS agent_learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'insight',
    content TEXT NOT NULL,
    content_hash TEXT,
    confidence REAL DEFAULT 0.5,
    source_run_id INTEGER,
    reinforcement_count INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    last_reinforced_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_hash ON agent_learnings(agent_name, content_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_learning_agent ON agent_learnings(agent_name, confidence DESC)`,

  // Per-agent personality trait evolution (versioned for drift tracking)
  `CREATE TABLE IF NOT EXISTS agent_personality (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    trait_name TEXT NOT NULL,
    trait_value REAL NOT NULL,
    evidence TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_personality ON agent_personality(agent_name, trait_name)`,

  // Tool execution audit log (append-only forensic trail)
  `CREATE TABLE IF NOT EXISTS tool_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_category TEXT NOT NULL,
    params_json TEXT NOT NULL,
    result_success INTEGER NOT NULL,
    result_summary TEXT,
    side_effects TEXT,
    duration_ms INTEGER,
    approval TEXT NOT NULL DEFAULT 'auto',
    error TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_agent ON tool_executions(agent_name, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_executions(tool_name, created_at)`,

  // Trust calibration ledger — running score of agent reliability
  `CREATE TABLE IF NOT EXISTS agent_trust_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    score_delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    context_goal_id INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trust_agent ON agent_trust_ledger(agent_name, created_at)`,

  // Tool leases — goal-scoped tool permissions with usage limits
  `CREATE TABLE IF NOT EXISTS tool_leases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    goal_id INTEGER,
    max_executions INTEGER,
    executions_used INTEGER DEFAULT 0,
    expires_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_lease_agent ON tool_leases(agent_name, status)`,
  `CREATE INDEX IF NOT EXISTS idx_lease_tool ON tool_leases(tool_name, status)`,
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

  // -- Token aggregation (quota management) ------------------------------------

  /** Get aggregate token usage in a time range */
  getAggregateTokens(fromEpoch?: number, toEpoch?: number): {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    num_entries: number;
  } {
    const db = this.requireDb();
    let sql = `SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) as total_tokens,
      COUNT(*) as num_entries
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

    const row = db.prepare(sql).get(...params) as { input_tokens: number; output_tokens: number; total_tokens: number; num_entries: number } | undefined;
    return row ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0, num_entries: 0 };
  }

  /** Get per-session token usage for the current rolling window */
  getWindowTokens(windowHours: number): Array<{
    session_name: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    num_turns: number;
  }> {
    const db = this.requireDb();
    const windowEpoch = Math.floor(Date.now() / 1000) - windowHours * 3600;
    return db.prepare(
      `SELECT
        session_name,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) as total_tokens,
        COALESCE(SUM(num_turns), 0) as num_turns
      FROM costs
      WHERE created_at >= ?
      GROUP BY session_name
      ORDER BY total_tokens DESC`,
    ).all(windowEpoch) as unknown as Array<{
      session_name: string; input_tokens: number; output_tokens: number;
      total_tokens: number; num_turns: number;
    }>;
  }

  /** Get daily token totals */
  getDailyTokens(days = 14): Array<{
    date: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    turns: number;
  }> {
    const db = this.requireDb();
    return db.prepare(
      `SELECT
        date(created_at, 'unixepoch') as date,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) as total_tokens,
        COALESCE(SUM(num_turns), 0) as turns
      FROM costs
      WHERE created_at >= unixepoch() - (? * 86400)
      GROUP BY date(created_at, 'unixepoch')
      ORDER BY date DESC`,
    ).all(days) as unknown as Array<{
      date: string; input_tokens: number; output_tokens: number;
      total_tokens: number; turns: number;
    }>;
  }

  /** Get weekly token total since last Monday 00:00 UTC */
  getWeeklyTokens(): { input_tokens: number; output_tokens: number; total_tokens: number } {
    const now = new Date();
    // Monday = 1 in getUTCDay(), Sunday = 0
    const dayOfWeek = now.getUTCDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
    const mondayEpoch = Math.floor(monday.getTime() / 1000);
    return this.getAggregateTokens(mondayEpoch);
  }

  // -- Agent runs ---------------------------------------------------------------

  /** Start tracking an agent run. Returns the run ID. */
  startAgentRun(
    agentName: string,
    sessionName: string,
    trigger: "standalone" | "manual" = "standalone",
  ): number {
    const db = this.requireDb();
    const result = db.prepare(
      `INSERT INTO agent_runs (agent_name, session_name, trigger) VALUES (?, ?, ?)`,
    ).run(agentName, sessionName, trigger);
    return Number(result.lastInsertRowid);
  }

  /** Complete an agent run with results */
  completeAgentRun(
    runId: number,
    status: "completed" | "failed" | "cancelled",
    result: { sessionId?: string; costUsd?: number; inputTokens?: number; outputTokens?: number; turns?: number; error?: string },
  ): void {
    const db = this.requireDb();
    db.prepare(
      `UPDATE agent_runs SET
        status = ?, finished_at = unixepoch(), session_id = ?,
        cost_usd = ?, input_tokens = ?, output_tokens = ?,
        turns = ?, error = ?
      WHERE id = ?`,
    ).run(
      status, result.sessionId ?? null,
      result.costUsd ?? 0, result.inputTokens ?? 0, result.outputTokens ?? 0,
      result.turns ?? 0, result.error ?? null, runId,
    );
  }

  /** Get recent agent runs */
  getAgentRuns(limit = 50, agentName?: string): Record<string, unknown>[] {
    const db = this.requireDb();
    if (agentName) {
      return db.prepare(
        `SELECT * FROM agent_runs WHERE agent_name = ? ORDER BY started_at DESC LIMIT ?`,
      ).all(agentName, limit);
    }
    return db.prepare(
      `SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?`,
    ).all(limit);
  }

  /** Get per-agent cost summary */
  getAgentCostSummary(): Array<{ agent_name: string; total_cost: number; run_count: number; avg_cost: number }> {
    const db = this.requireDb();
    return db.prepare(
      `SELECT agent_name, SUM(cost_usd) as total_cost, COUNT(*) as run_count,
        AVG(cost_usd) as avg_cost
      FROM agent_runs WHERE status = 'completed'
      GROUP BY agent_name ORDER BY total_cost DESC`,
    ).all() as unknown as Array<{ agent_name: string; total_cost: number; run_count: number; avg_cost: number }>;
  }

  // -- Goals ------------------------------------------------------------------

  /** Create a goal. Returns the goal ID. */
  createGoal(
    title: string,
    opts?: { description?: string; parentId?: number; priority?: number; agentName?: string; expectedOutcome?: string },
  ): number {
    const db = this.requireDb();
    const result = db.prepare(
      `INSERT INTO agent_goals (title, description, parent_id, priority, agent_name, expected_outcome)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      title, opts?.description ?? null, opts?.parentId ?? null,
      opts?.priority ?? 5, opts?.agentName ?? null, opts?.expectedOutcome ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /** Update a goal's status and/or outcome */
  updateGoal(
    id: number,
    updates: { status?: string; actualOutcome?: string; successScore?: number },
  ): boolean {
    const db = this.requireDb();
    const sets: string[] = ["updated_at = unixepoch()"];
    const params: unknown[] = [];

    if (updates.status) {
      sets.push("status = ?");
      params.push(updates.status);
      if (updates.status === "completed" || updates.status === "failed") {
        sets.push("completed_at = unixepoch()");
      }
    }
    if (updates.actualOutcome) {
      sets.push("actual_outcome = ?");
      params.push(updates.actualOutcome);
    }
    if (updates.successScore != null) {
      sets.push("success_score = ?");
      params.push(updates.successScore);
    }

    params.push(id);
    const result = db.prepare(
      `UPDATE agent_goals SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...params);
    return result.changes > 0;
  }

  /** Get a single goal by ID */
  getGoal(id: number): Record<string, unknown> | undefined {
    const db = this.requireDb();
    return db.prepare(`SELECT * FROM agent_goals WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  }

  /** Get active goals, optionally filtered by agent */
  getActiveGoals(agentName?: string): Record<string, unknown>[] {
    const db = this.requireDb();
    if (agentName) {
      return db.prepare(
        `SELECT * FROM agent_goals WHERE status = 'active' AND agent_name = ? ORDER BY priority ASC`,
      ).all(agentName);
    }
    return db.prepare(
      `SELECT * FROM agent_goals WHERE status = 'active' ORDER BY priority ASC`,
    ).all();
  }

  /** Get full goal tree (all goals with children counts) */
  getGoalTree(): Record<string, unknown>[] {
    const db = this.requireDb();
    return db.prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM agent_goals c WHERE c.parent_id = g.id) as children_count
       FROM agent_goals g ORDER BY g.priority ASC, g.created_at DESC`,
    ).all();
  }

  // -- Decisions --------------------------------------------------------------

  /** Record a decision with rationale */
  recordDecision(
    agentName: string,
    action: string,
    rationale: string,
    opts?: { sessionName?: string; goalId?: number; alternatives?: string[]; expectedOutcome?: string; contextSnapshot?: Record<string, unknown> },
  ): number {
    const db = this.requireDb();
    const result = db.prepare(
      `INSERT INTO agent_decisions (agent_name, session_name, goal_id, action, rationale, alternatives, expected_outcome, context_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentName, opts?.sessionName ?? null, opts?.goalId ?? null,
      action, rationale,
      opts?.alternatives ? JSON.stringify(opts.alternatives) : null,
      opts?.expectedOutcome ?? null,
      opts?.contextSnapshot ? JSON.stringify(opts.contextSnapshot) : null,
    );
    return Number(result.lastInsertRowid);
  }

  /** Evaluate a past decision with actual outcome and score */
  evaluateDecision(id: number, actualOutcome: string, score: number): boolean {
    const db = this.requireDb();
    const result = db.prepare(
      `UPDATE agent_decisions SET actual_outcome = ?, score = ?, evaluated_at = unixepoch() WHERE id = ?`,
    ).run(actualOutcome, score, id);
    return result.changes > 0;
  }

  /** Get recent decisions, optionally filtered by agent */
  getRecentDecisions(limit = 20, agentName?: string): Record<string, unknown>[] {
    const db = this.requireDb();
    if (agentName) {
      return db.prepare(
        `SELECT * FROM agent_decisions WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?`,
      ).all(agentName, limit);
    }
    return db.prepare(
      `SELECT * FROM agent_decisions ORDER BY created_at DESC LIMIT ?`,
    ).all(limit);
  }

  /** Get rolling decision quality trend for an agent */
  getDecisionQualityTrend(agentName: string, windowSize = 10): {
    avg_score: number | null;
    scored_count: number;
    total_count: number;
    trend: "improving" | "declining" | "stable" | "insufficient_data";
  } {
    const db = this.requireDb();
    const rows = db.prepare(
      `SELECT score FROM agent_decisions WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(agentName, windowSize) as Array<{ score: number | null }>;

    const total = rows.length;
    const scored = rows.filter((r) => r.score != null);
    if (scored.length < 3) {
      return { avg_score: null, scored_count: scored.length, total_count: total, trend: "insufficient_data" };
    }

    const avg = scored.reduce((sum, r) => sum + r.score!, 0) / scored.length;
    // Compare first half (recent) vs second half (older) for trend
    const mid = Math.floor(scored.length / 2);
    const recentAvg = scored.slice(0, mid).reduce((s, r) => s + r.score!, 0) / mid;
    const olderAvg = scored.slice(mid).reduce((s, r) => s + r.score!, 0) / (scored.length - mid);
    const delta = recentAvg - olderAvg;
    const trend = delta > 0.1 ? "improving" : delta < -0.1 ? "declining" : "stable";

    return { avg_score: avg, scored_count: scored.length, total_count: total, trend };
  }

  /** Get decisions for a specific goal */
  getDecisionsByGoal(goalId: number): Record<string, unknown>[] {
    const db = this.requireDb();
    return db.prepare(
      `SELECT * FROM agent_decisions WHERE goal_id = ? ORDER BY created_at DESC`,
    ).all(goalId);
  }

  // -- Inter-agent messages ---------------------------------------------------

  /** Send a message between agents */
  sendAgentMessage(
    fromAgent: string,
    toAgent: string,
    content: string,
    opts?: { messageType?: string; metadata?: Record<string, unknown> },
  ): number {
    const db = this.requireDb();
    const result = db.prepare(
      `INSERT INTO agent_messages (from_agent, to_agent, message_type, content, metadata)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      fromAgent, toAgent, opts?.messageType ?? "info", content,
      opts?.metadata ? JSON.stringify(opts.metadata) : null,
    );
    return Number(result.lastInsertRowid);
  }

  /** Get unread messages for an agent */
  getUnreadMessages(agentName: string): Record<string, unknown>[] {
    const db = this.requireDb();
    return db.prepare(
      `SELECT * FROM agent_messages
       WHERE (to_agent = ? OR to_agent = '*') AND read_at IS NULL
       ORDER BY created_at ASC`,
    ).all(agentName);
  }

  /** Mark messages as read */
  markMessagesRead(messageIds: number[]): void {
    const db = this.requireDb();
    for (const id of messageIds) {
      db.prepare(`UPDATE agent_messages SET read_at = unixepoch() WHERE id = ?`).run(id);
    }
  }

  /** Get message conversation between two agents */
  getConversation(agent1: string, agent2: string, limit = 50): Record<string, unknown>[] {
    const db = this.requireDb();
    return db.prepare(
      `SELECT * FROM agent_messages
       WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)
       ORDER BY created_at DESC LIMIT ?`,
    ).all(agent1, agent2, agent2, agent1, limit);
  }

  // -- User profile (mind meld) -----------------------------------------------

  /** Add a profile entry. Deduplicates by content hash. */
  addProfileEntry(
    category: "chat_export" | "note" | "trait" | "style" | "preference",
    content: string,
    opts?: { weight?: number; source?: string; tags?: string[] },
  ): number | null {
    const db = this.requireDb();
    const hash = hashContent(content);

    // Default weights by category
    const defaultWeights: Record<string, number> = {
      chat_export: 0.5,
      note: 2.0,
      trait: 3.0,
      style: 2.0,
      preference: 2.5,
    };
    const weight = opts?.weight ?? defaultWeights[category] ?? 1.0;

    try {
      const result = db.prepare(
        `INSERT INTO user_profile (category, content, content_hash, weight, source, tags)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(category, content, hash, weight, opts?.source ?? null,
        opts?.tags ? JSON.stringify(opts.tags) : null);
      return Number(result.lastInsertRowid);
    } catch (err: any) {
      if (err?.message?.includes("UNIQUE")) return null; // duplicate
      throw err;
    }
  }

  /** Get profile entries, sorted by weight (highest first) */
  getProfile(category?: string, limit = 100): Record<string, unknown>[] {
    const db = this.requireDb();
    if (category) {
      return db.prepare(
        `SELECT * FROM user_profile WHERE category = ? ORDER BY weight DESC, updated_at DESC LIMIT ?`,
      ).all(category, limit);
    }
    return db.prepare(
      `SELECT * FROM user_profile ORDER BY weight DESC, updated_at DESC LIMIT ?`,
    ).all(limit);
  }

  /** Update a profile entry */
  updateProfileEntry(
    id: number,
    updates: { content?: string; weight?: number; tags?: string[] },
  ): boolean {
    const db = this.requireDb();
    const sets: string[] = ["updated_at = unixepoch()"];
    const params: unknown[] = [];

    if (updates.content) {
      sets.push("content = ?", "content_hash = ?");
      params.push(updates.content, hashContent(updates.content));
    }
    if (updates.weight != null) {
      sets.push("weight = ?");
      params.push(updates.weight);
    }
    if (updates.tags) {
      sets.push("tags = ?");
      params.push(JSON.stringify(updates.tags));
    }

    params.push(id);
    const result = db.prepare(
      `UPDATE user_profile SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...params);
    return result.changes > 0;
  }

  /** Delete a profile entry */
  deleteProfileEntry(id: number): boolean {
    const db = this.requireDb();
    return db.prepare(`DELETE FROM user_profile WHERE id = ?`).run(id).changes > 0;
  }

  /** Search profile entries by content */
  searchProfile(query: string, limit = 20): Record<string, unknown>[] {
    const db = this.requireDb();
    return db.prepare(
      `SELECT * FROM user_profile WHERE content LIKE ? ORDER BY weight DESC LIMIT ?`,
    ).all(`%${query}%`, limit);
  }

  // -- Strategy evolution ------------------------------------------------------

  /** Get the active strategy for an agent */
  getActiveStrategy(agentName: string): Record<string, unknown> | undefined {
    const db = this.requireDb();
    return db.prepare(
      `SELECT * FROM agent_strategies WHERE agent_name = ? AND active = 1 ORDER BY version DESC LIMIT 1`,
    ).get(agentName) as Record<string, unknown> | undefined;
  }

  /** Evolve strategy — deactivates current, creates new version */
  evolveStrategy(
    agentName: string,
    strategyText: string,
    rationale: string,
    performanceScore?: number,
  ): number {
    const db = this.requireDb();

    // Deactivate current strategy
    db.prepare(
      `UPDATE agent_strategies SET active = 0 WHERE agent_name = ? AND active = 1`,
    ).run(agentName);

    // Get latest version number
    const latest = db.prepare(
      `SELECT MAX(version) as v FROM agent_strategies WHERE agent_name = ?`,
    ).get(agentName) as { v: number | null } | undefined;
    const nextVersion = (latest?.v ?? 0) + 1;

    const result = db.prepare(
      `INSERT INTO agent_strategies (agent_name, strategy_text, version, rationale, performance_score)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(agentName, strategyText, nextVersion, rationale, performanceScore ?? null);
    return Number(result.lastInsertRowid);
  }

  /** Get strategy version history for an agent */
  getStrategyHistory(agentName: string, limit = 10): Record<string, unknown>[] {
    const db = this.requireDb();
    return db.prepare(
      `SELECT * FROM agent_strategies WHERE agent_name = ? ORDER BY version DESC LIMIT ?`,
    ).all(agentName, limit);
  }

  // -- Agent conversations (persistent chat) -----------------------------------

  /** Append a message to an agent conversation */
  appendConversation(
    agentName: string,
    role: string,
    content: string,
    opts?: { sessionId?: string; thinking?: string; costUsd?: number; tokensIn?: number; tokensOut?: number },
  ): number {
    const db = this.requireDb();
    const result = db.prepare(
      `INSERT INTO agent_conversations (agent_name, role, content, session_id, thinking, cost_usd, tokens_in, tokens_out)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentName, role, content, opts?.sessionId ?? null, opts?.thinking ?? null,
      opts?.costUsd ?? null, opts?.tokensIn ?? null, opts?.tokensOut ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /** Get conversation history for an agent */
  getConversationHistory(agentName: string, limit = 50): Record<string, unknown>[] {
    const db = this.requireDb();
    return db.prepare(
      `SELECT * FROM agent_conversations WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(agentName, limit).reverse(); // chronological order
  }

  /** Clear conversation history for an agent */
  clearConversation(agentName: string): number {
    const db = this.requireDb();
    return db.prepare(`DELETE FROM agent_conversations WHERE agent_name = ?`).run(agentName).changes;
  }

  // -- Agent learnings (accumulated knowledge) ---------------------------------

  /** Add or reinforce a learning. Deduplicates via content hash — if duplicate, reinforces confidence. */
  addLearning(
    agentName: string,
    category: string,
    content: string,
    opts?: { confidence?: number; sourceRunId?: number },
  ): number | null {
    const db = this.requireDb();
    const hash = hashContent(content);

    // Check for existing learning with same hash
    const existing = db.prepare(
      `SELECT id, confidence, reinforcement_count FROM agent_learnings WHERE agent_name = ? AND content_hash = ?`,
    ).get(agentName, hash) as { id: number; confidence: number; reinforcement_count: number } | undefined;

    if (existing) {
      // Reinforce: bump confidence (capped at 1.0), increment count
      const newConfidence = Math.min(1.0, existing.confidence + 0.05);
      db.prepare(
        `UPDATE agent_learnings SET confidence = ?, reinforcement_count = reinforcement_count + 1, last_reinforced_at = unixepoch() WHERE id = ?`,
      ).run(newConfidence, existing.id);
      return existing.id;
    }

    const result = db.prepare(
      `INSERT INTO agent_learnings (agent_name, category, content, content_hash, confidence, source_run_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(agentName, category, content, hash, opts?.confidence ?? 0.5, opts?.sourceRunId ?? null);
    return Number(result.lastInsertRowid);
  }

  /** Get top learnings for an agent, sorted by confidence */
  getAgentLearnings(agentName: string, limit = 20, category?: string): Record<string, unknown>[] {
    const db = this.requireDb();
    if (category) {
      return db.prepare(
        `SELECT * FROM agent_learnings WHERE agent_name = ? AND category = ? ORDER BY confidence DESC LIMIT ?`,
      ).all(agentName, category, limit);
    }
    return db.prepare(
      `SELECT * FROM agent_learnings WHERE agent_name = ? ORDER BY confidence DESC LIMIT ?`,
    ).all(agentName, limit);
  }

  /** Decay old learnings with low reinforcement */
  decayLearnings(agentName: string, olderThanDays = 30): number {
    const db = this.requireDb();
    const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
    return db.prepare(
      `UPDATE agent_learnings SET confidence = MAX(0.1, confidence * 0.95)
       WHERE agent_name = ? AND last_reinforced_at < ? AND confidence > 0.1`,
    ).run(agentName, cutoff).changes;
  }

  /** Get high-confidence learnings from all agents except one (cross-pollination) */
  getSharedInsights(excludeAgent: string, minConfidence = 0.7, limit = 5): Record<string, unknown>[] {
    const db = this.requireDb();
    return db.prepare(
      `SELECT * FROM agent_learnings WHERE agent_name != ? AND confidence >= ? ORDER BY confidence DESC LIMIT ?`,
    ).all(excludeAgent, minConfidence, limit);
  }

  // -- Agent personality (trait evolution) -------------------------------------

  /** Set or update a personality trait. Creates new version for history tracking. */
  setPersonalityTrait(agentName: string, traitName: string, value: number, evidence?: string): number {
    const db = this.requireDb();
    const clampedValue = Math.max(0, Math.min(1, value));

    // Get current version for this trait
    const current = db.prepare(
      `SELECT MAX(version) as v FROM agent_personality WHERE agent_name = ? AND trait_name = ?`,
    ).get(agentName, traitName) as { v: number | null } | undefined;
    const nextVersion = (current?.v ?? 0) + 1;

    const result = db.prepare(
      `INSERT INTO agent_personality (agent_name, trait_name, trait_value, evidence, version) VALUES (?, ?, ?, ?, ?)`,
    ).run(agentName, traitName, clampedValue, evidence ?? null, nextVersion);
    return Number(result.lastInsertRowid);
  }

  /** Get current personality snapshot for an agent (latest version of each trait) */
  getPersonalitySnapshot(agentName: string): Array<{ trait_name: string; trait_value: number; evidence: string | null }> {
    const db = this.requireDb();
    return db.prepare(
      `SELECT trait_name, trait_value, evidence FROM agent_personality
       WHERE agent_name = ? AND version = (
         SELECT MAX(version) FROM agent_personality p2
         WHERE p2.agent_name = agent_personality.agent_name AND p2.trait_name = agent_personality.trait_name
       )
       ORDER BY trait_name`,
    ).all(agentName) as Array<{ trait_name: string; trait_value: number; evidence: string | null }>;
  }

  /** Get trait evolution history for drift tracking */
  getPersonalityHistory(agentName: string, traitName: string, limit = 20): Record<string, unknown>[] {
    const db = this.requireDb();
    return db.prepare(
      `SELECT * FROM agent_personality WHERE agent_name = ? AND trait_name = ? ORDER BY version DESC LIMIT ?`,
    ).all(agentName, traitName, limit);
  }

  /** Detect significant trait changes (drift) */
  getPersonalityDrift(agentName: string, windowDays = 7): Array<{
    trait_name: string;
    current_value: number;
    previous_value: number;
    delta: number;
    direction: "increased" | "decreased" | "stable";
  }> {
    const db = this.requireDb();
    const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86400;

    // Get current values
    const current = this.getPersonalitySnapshot(agentName);
    const drift: Array<{ trait_name: string; current_value: number; previous_value: number; delta: number; direction: "increased" | "decreased" | "stable" }> = [];

    for (const trait of current) {
      // Find the oldest value within the window
      const older = db.prepare(
        `SELECT trait_value FROM agent_personality
         WHERE agent_name = ? AND trait_name = ? AND created_at <= ?
         ORDER BY version DESC LIMIT 1`,
      ).get(agentName, trait.trait_name, cutoff) as { trait_value: number } | undefined;

      if (older) {
        const delta = trait.trait_value - older.trait_value;
        if (Math.abs(delta) > 0.05) { // threshold for "significant" change
          drift.push({
            trait_name: trait.trait_name,
            current_value: trait.trait_value,
            previous_value: older.trait_value,
            delta,
            direction: delta > 0.05 ? "increased" : delta < -0.05 ? "decreased" : "stable",
          });
        }
      }
    }
    return drift;
  }

  // -- Recent agent messages (for dashboard) -----------------------------------

  /** Get all recent agent messages */
  getRecentAgentMessages(limit = 50): Record<string, unknown>[] {
    const db = this.requireDb();
    return db.prepare(
      `SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?`,
    ).all(limit);
  }

  /** Get unique agent conversation pairs with metadata */
  getAgentConversationPairs(): Array<{ agent1: string; agent2: string; message_count: number; last_message_at: number }> {
    const db = this.requireDb();
    return db.prepare(
      `SELECT
         MIN(from_agent, to_agent) as agent1,
         MAX(from_agent, to_agent) as agent2,
         COUNT(*) as message_count,
         MAX(created_at) as last_message_at
       FROM agent_messages
       WHERE to_agent != '*'
       GROUP BY MIN(from_agent, to_agent), MAX(from_agent, to_agent)
       ORDER BY last_message_at DESC`,
    ).all() as Array<{ agent1: string; agent2: string; message_count: number; last_message_at: number }>;
  }

  /** Get per-agent decision quality metrics */
  getDecisionMetrics(): Array<{
    agent_name: string;
    total_decisions: number;
    scored_decisions: number;
    avg_score: number | null;
  }> {
    const db = this.requireDb();
    return db.prepare(
      `SELECT agent_name,
              COUNT(*) as total_decisions,
              COUNT(score) as scored_decisions,
              AVG(score) as avg_score
       FROM agent_decisions
       GROUP BY agent_name
       ORDER BY agent_name`,
    ).all() as Array<{ agent_name: string; total_decisions: number; scored_decisions: number; avg_score: number | null }>;
  }

  // -- Tool execution audit log -----------------------------------------------

  /** Log a tool execution (append-only audit trail) */
  logToolExecution(entry: {
    agent_name: string;
    tool_name: string;
    tool_category: string;
    params_json: string;
    result_success: boolean;
    result_summary?: string;
    side_effects?: string[];
    duration_ms?: number;
    approval?: string;
    error?: string;
  }): number {
    const db = this.requireDb();
    const result = db.prepare(
      `INSERT INTO tool_executions (agent_name, tool_name, tool_category, params_json, result_success, result_summary, side_effects, duration_ms, approval, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.agent_name,
      entry.tool_name,
      entry.tool_category,
      entry.params_json,
      entry.result_success ? 1 : 0,
      entry.result_summary ?? null,
      entry.side_effects ? JSON.stringify(entry.side_effects) : null,
      entry.duration_ms ?? null,
      entry.approval ?? "auto",
      entry.error ?? null,
    );
    return (result as any).lastInsertRowid ?? 0;
  }

  /** Get recent tool executions, optionally filtered by agent */
  getToolExecutions(agentName?: string, limit = 50): Array<{
    id: number;
    agent_name: string;
    tool_name: string;
    tool_category: string;
    params_json: string;
    result_success: number;
    result_summary: string | null;
    side_effects: string | null;
    duration_ms: number | null;
    approval: string;
    error: string | null;
    created_at: number;
  }> {
    const db = this.requireDb();
    if (agentName) {
      return db.prepare(
        `SELECT * FROM tool_executions WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?`,
      ).all(agentName, limit) as any;
    }
    return db.prepare(
      `SELECT * FROM tool_executions ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as any;
  }

  /** Get tool usage stats per agent (total calls, success rate, top tools) */
  getToolStats(agentName?: string): Array<{
    tool_name: string;
    tool_category: string;
    total_calls: number;
    success_count: number;
    avg_duration_ms: number;
  }> {
    const db = this.requireDb();
    const where = agentName ? "WHERE agent_name = ?" : "";
    const params = agentName ? [agentName] : [];
    return db.prepare(
      `SELECT tool_name, tool_category,
              COUNT(*) as total_calls,
              SUM(result_success) as success_count,
              AVG(duration_ms) as avg_duration_ms
       FROM tool_executions ${where}
       GROUP BY tool_name, tool_category
       ORDER BY total_calls DESC`,
    ).all(...params) as any;
  }

  // -- Trust calibration -------------------------------------------------------

  /** Record a trust score delta for an agent */
  recordTrustDelta(agentName: string, delta: number, reason: string, goalId?: number): void {
    const db = this.requireDb();
    db.prepare(
      `INSERT INTO agent_trust_ledger (agent_name, score_delta, reason, context_goal_id)
       VALUES (?, ?, ?, ?)`,
    ).run(agentName, delta, reason, goalId ?? null);
  }

  /** Get current trust score for an agent (sum of deltas, bounded 0-1000) */
  getTrustScore(agentName: string): number {
    const db = this.requireDb();
    const row = db.prepare(
      `SELECT COALESCE(SUM(score_delta), 0) as total FROM agent_trust_ledger WHERE agent_name = ?`,
    ).get(agentName) as { total: number } | undefined;
    const raw = row?.total ?? 0;
    return Math.max(0, Math.min(1000, raw));
  }

  /** Get trust ledger history for an agent */
  getTrustHistory(agentName: string, limit = 50): Array<{
    id: number; score_delta: number; reason: string;
    context_goal_id: number | null; created_at: number;
  }> {
    const db = this.requireDb();
    return db.prepare(
      `SELECT id, score_delta, reason, context_goal_id, created_at
       FROM agent_trust_ledger WHERE agent_name = ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(agentName, limit) as any;
  }

  /**
   * Get recommended autonomy level based on trust score.
   * Returns a recommendation — actual level change requires user approval.
   */
  getRecommendedAutonomy(agentName: string): { score: number; recommended: import("./types.js").AutonomyLevel } {
    const score = this.getTrustScore(agentName);
    let recommended: import("./types.js").AutonomyLevel;
    if (score >= 700) {
      recommended = "trusted";
    } else if (score >= 300) {
      recommended = "supervised";
    } else {
      recommended = "observe";
    }
    return { score, recommended };
  }

  // -- Tool leases -------------------------------------------------------------

  /** Create a tool lease (goal-scoped tool permission) */
  createToolLease(agentName: string, toolName: string, opts: {
    goalId?: number; maxExecutions?: number; expiresAt?: number;
  } = {}): number {
    const db = this.requireDb();
    const result = db.prepare(
      `INSERT INTO tool_leases (agent_name, tool_name, goal_id, max_executions, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(agentName, toolName, opts.goalId ?? null, opts.maxExecutions ?? null, opts.expiresAt ?? null);
    return Number(result.lastInsertRowid);
  }

  /** Check if an agent has an active lease for a tool (optionally scoped to a goal) */
  hasActiveLease(agentName: string, toolName: string, goalId?: number): boolean {
    const db = this.requireDb();
    const now = Math.floor(Date.now() / 1000);
    const goalClause = goalId != null ? " AND goal_id = ?" : "";
    const params: any[] = [agentName, toolName, now];
    if (goalId != null) params.push(goalId);
    const row = db.prepare(
      `SELECT id FROM tool_leases
       WHERE agent_name = ? AND tool_name = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > ?)
         AND (max_executions IS NULL OR executions_used < max_executions)
         ${goalClause}
       LIMIT 1`,
    ).get(...params);
    return row != null;
  }

  /** Increment lease usage after tool execution, auto-exhaust if max reached */
  incrementLeaseUsage(agentName: string, toolName: string): void {
    const db = this.requireDb();
    const now = Math.floor(Date.now() / 1000);
    // Find active lease for this agent+tool
    const lease = db.prepare(
      `SELECT id, max_executions, executions_used FROM tool_leases
       WHERE agent_name = ? AND tool_name = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC LIMIT 1`,
    ).get(agentName, toolName, now) as { id: number; max_executions: number | null; executions_used: number } | undefined;
    if (!lease) return;

    const newUsed = lease.executions_used + 1;
    const newStatus = lease.max_executions != null && newUsed >= lease.max_executions ? "exhausted" : "active";
    db.prepare(
      `UPDATE tool_leases SET executions_used = ?, status = ? WHERE id = ?`,
    ).run(newUsed, newStatus, lease.id);
  }

  /** Revoke all active leases for an agent (e.g., on goal completion or trust violation) */
  revokeLeases(agentName: string, goalId?: number): number {
    const db = this.requireDb();
    const goalClause = goalId != null ? " AND goal_id = ?" : "";
    const params: any[] = [agentName];
    if (goalId != null) params.push(goalId);
    const result = db.prepare(
      `UPDATE tool_leases SET status = 'revoked'
       WHERE agent_name = ? AND status = 'active'${goalClause}`,
    ).run(...params);
    return result.changes;
  }

  /** Get active leases for an agent */
  getActiveLeases(agentName: string): Array<{
    id: number; tool_name: string; goal_id: number | null;
    max_executions: number | null; executions_used: number;
    expires_at: number | null; created_at: number;
  }> {
    const db = this.requireDb();
    const now = Math.floor(Date.now() / 1000);
    return db.prepare(
      `SELECT id, tool_name, goal_id, max_executions, executions_used, expires_at, created_at
       FROM tool_leases
       WHERE agent_name = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`,
    ).all(agentName, now) as any;
  }

  /** Expire all leases past their expiry time */
  expireLeases(): number {
    const db = this.requireDb();
    const now = Math.floor(Date.now() / 1000);
    const result = db.prepare(
      `UPDATE tool_leases SET status = 'expired'
       WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
    ).run(now);
    return result.changes;
  }
}
