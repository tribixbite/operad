/**
 * consolidation.ts — Memory consolidation & reflection engine
 *
 * Runs during idle periods (no user activity, battery > 30%, on charger).
 * Performs "REM sleep" for agent memory:
 * 1. Decay stale learnings (unreinforced 30+ days)
 * 2. Prune low-confidence learnings (< 0.15)
 * 3. Detect and merge redundant learnings (same category, similar content hash prefix)
 * 4. Cross-pollinate high-confidence learnings between agents
 * 5. Build reflection prompt for master controller (optional, costs tokens)
 *
 * Design: consolidation is purely local DB operations — no SDK calls except
 * for the optional reflection step. Safe to run frequently.
 */

import type { MemoryDb } from "./memory-db.js";
import type { Logger } from "./log.js";

// -- Types --------------------------------------------------------------------

/** Consolidation run results */
export interface ConsolidationResult {
  started_at: number;
  completed_at: number;
  learnings_decayed: number;
  learnings_pruned: number;
  learnings_merged: number;
  cross_pollinated: number;
  duration_ms: number;
}

/** Idle conditions required for consolidation */
export interface IdleConditions {
  /** Seconds since last user activity (prompt submission) */
  idleSeconds: number;
  /** Battery percentage */
  batteryPct: number;
  /** Whether device is charging */
  charging: boolean;
  /** Whether SDK bridge is busy */
  sdkBusy: boolean;
}

// -- Consolidation engine -----------------------------------------------------

/** Minimum idle time before consolidation triggers (30 minutes) */
const MIN_IDLE_SECONDS = 1800;
/** Minimum battery percentage for consolidation */
const MIN_BATTERY_PCT = 30;
/** Minimum hours between consolidation runs */
const MIN_INTERVAL_HOURS = 12;

/**
 * Check if conditions are met for consolidation.
 * Requires: idle 30+ min, battery > 30%, charging, SDK not busy.
 */
export function shouldConsolidate(
  conditions: IdleConditions,
  lastConsolidationEpoch: number | null,
): boolean {
  // Must be idle for at least 30 minutes
  if (conditions.idleSeconds < MIN_IDLE_SECONDS) return false;

  // Must be charging with sufficient battery
  if (!conditions.charging || conditions.batteryPct < MIN_BATTERY_PCT) return false;

  // SDK must not be busy
  if (conditions.sdkBusy) return false;

  // Respect minimum interval
  if (lastConsolidationEpoch) {
    const hoursSince = (Date.now() / 1000 - lastConsolidationEpoch) / 3600;
    if (hoursSince < MIN_INTERVAL_HOURS) return false;
  }

  return true;
}

/**
 * Run memory consolidation for all agents.
 * This is the local-only, zero-cost version (no SDK calls).
 */
export function runConsolidation(
  db: MemoryDb,
  agentNames: string[],
  log: Logger,
): ConsolidationResult {
  const start = Date.now();
  const startEpoch = Math.floor(start / 1000);
  let totalDecayed = 0;
  let totalPruned = 0;
  let totalMerged = 0;
  let totalCrossPollinated = 0;

  for (const agentName of agentNames) {
    // 1. Decay stale learnings (unreinforced for 30+ days)
    const decayed = db.decayLearnings(agentName, 30);
    totalDecayed += decayed;
    if (decayed > 0) log.debug(`Consolidation: decayed ${decayed} learnings for ${agentName}`);

    // 2. Prune low-confidence learnings (below threshold)
    const pruned = pruneLowConfidenceLearnings(db, agentName, 0.15);
    totalPruned += pruned;
    if (pruned > 0) log.debug(`Consolidation: pruned ${pruned} learnings for ${agentName}`);

    // 3. Detect and merge similar learnings within same category
    const merged = mergeSimilarLearnings(db, agentName);
    totalMerged += merged;
    if (merged > 0) log.debug(`Consolidation: merged ${merged} learnings for ${agentName}`);
  }

  // 4. Decay stale specializations (unreinforced 60+ days)
  try {
    const specDecayed = db.decaySpecializations(60);
    if (specDecayed > 0) log.debug(`Consolidation: decayed ${specDecayed} specializations`);
  } catch {
    // Table may not exist in older DBs — silently ignore
  }

  // 5. Cross-pollinate high-confidence learnings between agents
  if (agentNames.length > 1) {
    for (const agent of agentNames) {
      const insights = db.getSharedInsights(agent, 0.8, 3);
      for (const insight of insights) {
        const content = String(insight.content);
        const category = String(insight.category);
        // addLearning deduplicates by content_hash — safe to call repeatedly
        db.addLearning(agent, category, content, { confidence: 0.6 });
        totalCrossPollinated++;
      }
    }
  }

  const completedAt = Math.floor(Date.now() / 1000);
  const durationMs = Date.now() - start;

  // Log consolidation run to DB
  logConsolidationRun(db, {
    started_at: startEpoch,
    completed_at: completedAt,
    learnings_decayed: totalDecayed,
    learnings_pruned: totalPruned,
    learnings_merged: totalMerged,
    cross_pollinated: totalCrossPollinated,
    duration_ms: durationMs,
  });

  log.info(
    `Consolidation complete: decayed=${totalDecayed} pruned=${totalPruned} ` +
    `merged=${totalMerged} cross-pollinated=${totalCrossPollinated} (${durationMs}ms)`,
  );

  return {
    started_at: startEpoch,
    completed_at: completedAt,
    learnings_decayed: totalDecayed,
    learnings_pruned: totalPruned,
    learnings_merged: totalMerged,
    cross_pollinated: totalCrossPollinated,
    duration_ms: durationMs,
  };
}

/**
 * Build a reflection prompt for the master controller.
 * Used during optional reflection runs (costs tokens).
 */
export function buildReflectionPrompt(db: MemoryDb, agentName: string): string {
  const learnings = db.getAgentLearnings(agentName, 100);
  const personality = db.getPersonalitySnapshot(agentName);
  const decisions = db.getRecentDecisions(30, agentName);
  const strategy = db.getActiveStrategy(agentName);

  const sections: string[] = [];
  sections.push("# Reflection Session\n");
  sections.push("You are reviewing your accumulated knowledge and recent experiences.");
  sections.push("This is a reflection session — no external actions will be taken.\n");

  // Full knowledge base
  sections.push("## Your Complete Knowledge Base\n");
  if (learnings.length === 0) {
    sections.push("_No learnings recorded yet._\n");
  } else {
    for (const l of learnings) {
      const conf = Number(l.confidence ?? 0.5).toFixed(2);
      const reinforced = Number(l.reinforcement_count ?? 0);
      sections.push(`- [${l.category}] (conf: ${conf}, reinforced: ${reinforced}x) ${l.content}`);
    }
    sections.push("");
  }

  // Decision history
  sections.push("## Decision History (last 30 days)\n");
  if (decisions.length === 0) {
    sections.push("_No decisions recorded._\n");
  } else {
    for (const d of decisions) {
      const score = d.score != null ? ` → score: ${d.score}` : " → pending";
      const outcome = d.actual_outcome ? ` | outcome: ${d.actual_outcome}` : "";
      sections.push(`- **${d.action}**: ${d.rationale}${outcome}${score}`);
    }
    sections.push("");
  }

  // Personality evolution
  sections.push("## Your Personality\n");
  if (personality.length === 0) {
    sections.push("_No personality traits defined._\n");
  } else {
    for (const t of personality) {
      sections.push(`- **${t.trait_name}**: ${t.trait_value} (${t.evidence ?? "no evidence"})`);
    }
    sections.push("");
  }

  // Current strategy
  if (strategy) {
    sections.push("## Current Strategy\n");
    sections.push(String(strategy.strategy_text ?? ""));
    sections.push("");
  }

  // Reflection questions
  sections.push("## Reflective Questions\n");
  sections.push("1. What patterns emerge in your successful vs failed decisions?");
  sections.push("2. Are any learnings contradicted by recent evidence?");
  sections.push("3. What knowledge gaps do you notice?");
  sections.push("4. How should your personality traits evolve based on outcomes?");
  sections.push("5. What should your strategy prioritize for the coming week?");
  sections.push("");
  sections.push("Emit `learning`, `personality`, and `strategy` blocks with your insights.");

  return sections.join("\n");
}

/** Get the last consolidation run timestamp */
export function getLastConsolidationTime(db: MemoryDb): number | null {
  try {
    const dbHandle = db.requireDb();
    const row = dbHandle.prepare(
      `SELECT completed_at FROM consolidation_runs ORDER BY completed_at DESC LIMIT 1`,
    ).get() as { completed_at: number } | undefined;
    return row?.completed_at ?? null;
  } catch {
    return null; // table may not exist yet
  }
}

/** Get recent consolidation run history */
export function getConsolidationHistory(db: MemoryDb, limit = 10): ConsolidationResult[] {
  try {
    const dbHandle = db.requireDb();
    return dbHandle.prepare(
      `SELECT * FROM consolidation_runs ORDER BY completed_at DESC LIMIT ?`,
    ).all(limit) as unknown as ConsolidationResult[];
  } catch {
    return [];
  }
}

// -- Internal helpers ---------------------------------------------------------

/** Prune learnings below confidence threshold with zero reinforcement */
function pruneLowConfidenceLearnings(db: MemoryDb, agentName: string, threshold: number): number {
  const dbHandle = db.requireDb();
  return dbHandle.prepare(
    `DELETE FROM agent_learnings
     WHERE agent_name = ? AND confidence < ? AND reinforcement_count = 0`,
  ).run(agentName, threshold).changes;
}

/**
 * Merge learnings in the same category that share a content_hash prefix.
 * When two learnings are similar (first 8 chars of hash match), keep the
 * higher-confidence one and boost it.
 */
function mergeSimilarLearnings(db: MemoryDb, agentName: string): number {
  const dbHandle = db.requireDb();
  // Find groups of learnings with the same category and hash prefix (first 8 chars)
  const candidates = dbHandle.prepare(
    `SELECT id, category, content, content_hash, confidence, reinforcement_count
     FROM agent_learnings WHERE agent_name = ?
     ORDER BY category, content_hash`,
  ).all(agentName) as Array<{
    id: number; category: string; content: string;
    content_hash: string; confidence: number; reinforcement_count: number;
  }>;

  let merged = 0;
  const seen = new Map<string, { id: number; confidence: number; reinforcement_count: number }>();

  for (const c of candidates) {
    // Group key: category + first 8 chars of hash
    const key = `${c.category}:${c.content_hash.slice(0, 8)}`;
    const existing = seen.get(key);

    if (existing) {
      // Merge: keep the one with higher confidence, delete the other
      if (c.confidence > existing.confidence) {
        // New one is better — delete old, update map
        dbHandle.prepare(`DELETE FROM agent_learnings WHERE id = ?`).run(existing.id);
        // Boost the surviving learning
        dbHandle.prepare(
          `UPDATE agent_learnings SET reinforcement_count = reinforcement_count + ? WHERE id = ?`,
        ).run(existing.reinforcement_count + 1, c.id);
        seen.set(key, { id: c.id, confidence: c.confidence, reinforcement_count: c.reinforcement_count });
      } else {
        // Existing is better — delete new
        dbHandle.prepare(`DELETE FROM agent_learnings WHERE id = ?`).run(c.id);
        dbHandle.prepare(
          `UPDATE agent_learnings SET reinforcement_count = reinforcement_count + ? WHERE id = ?`,
        ).run(c.reinforcement_count + 1, existing.id);
      }
      merged++;
    } else {
      seen.set(key, { id: c.id, confidence: c.confidence, reinforcement_count: c.reinforcement_count });
    }
  }

  return merged;
}

/** Log a consolidation run to the database */
function logConsolidationRun(db: MemoryDb, result: ConsolidationResult): void {
  try {
    const dbHandle = db.requireDb();
    dbHandle.prepare(
      `INSERT INTO consolidation_runs (started_at, completed_at, learnings_reviewed, learnings_merged, learnings_pruned, syntheses_created, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      result.started_at, result.completed_at,
      result.learnings_decayed, // reusing reviewed column for decayed count
      result.learnings_merged, result.learnings_pruned,
      result.cross_pollinated, result.duration_ms,
    );
  } catch {
    // Table may not exist yet — silently ignore
  }
}
