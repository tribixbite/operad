/**
 * agent-state.ts — Agent state export/import for portability
 *
 * Exports an agent's complete learned state (personality, learnings, strategies,
 * decisions, goals, trust score) into a self-contained JSON bundle. Bundles can
 * be imported on any operad instance for agent migration or backup.
 *
 * Bundle format: gzipped JSON with SHA-256 integrity check.
 * No DB IDs or external refs — fully self-contained.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { MemoryDb } from "./memory-db.js";
import type { AgentConfig } from "./agents.js";
import type { Logger } from "./log.js";

// -- Bundle types -------------------------------------------------------------

/** Full agent state bundle — self-contained, portable */
export interface AgentStateBundle {
  format_version: 1;
  meta: {
    exported_at: string;
    exported_from: string;  // hostname or instance ID
    operad_version: string;
    agent_name: string;
    checksum: string;       // SHA-256 of content (excluding meta.checksum)
  };
  config: Partial<AgentConfig>;
  personality: Array<{ trait_name: string; trait_value: number; evidence: string | null }>;
  learnings: Array<{
    category: string; content: string; content_hash: string;
    confidence: number; reinforcement_count: number; source_agent: string;
  }>;
  strategies: Array<{
    strategy_text: string; rationale: string;
    active: boolean; version: number; created_at: number;
  }>;
  decisions: Array<{
    action: string; rationale: string; alternatives: string | null;
    expected_outcome: string | null; actual_outcome: string | null;
    score: number | null; goal_id: number | null; created_at: number;
  }>;
  goals: Array<{
    title: string; description: string | null; status: string;
    priority: number; parent_title: string | null;
    expected_outcome: string | null; actual_outcome: string | null;
    success_score: number | null; created_at: number;
  }>;
  trust_score: number;
  run_stats: {
    total_runs: number;
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    avg_turns: number;
  };
  /** Optional: recent inter-agent messages (last 100) */
  messages?: Array<{
    from_agent: string; to_agent: string;
    message_type: string; content: string; created_at: number;
  }>;
  /** Optional: schedule definitions */
  schedules?: Array<{
    schedule_name: string; cron_expr: string | null;
    interval_minutes: number | null; prompt: string;
    max_budget_usd: number | null;
  }>;
}

/** Import merge options */
export interface ImportOptions {
  mode: "replace" | "merge";
  /** Which sections to import (default: all) */
  sections?: ("config" | "personality" | "learnings" | "strategies" | "goals" | "schedules")[];
  /** How to handle duplicate learnings */
  learningMerge: "keep_higher_confidence" | "prefer_import" | "prefer_existing";
  /** How to handle conflicting personality traits */
  personalityMerge: "prefer_import" | "prefer_existing" | "average";
}

const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  mode: "merge",
  learningMerge: "keep_higher_confidence",
  personalityMerge: "prefer_import",
};

// -- Export -------------------------------------------------------------------

/**
 * Export an agent's full state to a bundle.
 * @param template If true, exclude conversations/messages/decisions (lighter weight)
 */
export function exportAgentState(
  db: MemoryDb,
  agentConfig: AgentConfig,
  opts: { template?: boolean; hostname?: string; version?: string } = {},
): AgentStateBundle {
  const agentName = agentConfig.name;

  // Gather all state from DB
  const personality = db.getPersonalitySnapshot(agentName);
  const learnings = db.getAgentLearnings(agentName, 500) as Array<Record<string, unknown>>;
  const strategies = db.getStrategyHistory(agentName, 50) as Array<Record<string, unknown>>;
  const goals = db.getActiveGoals(agentName) as Array<Record<string, unknown>>;
  const decisions = opts.template ? [] : db.getRecentDecisions(100, agentName) as Array<Record<string, unknown>>;
  const trustScore = db.getTrustScore(agentName);

  // Run stats aggregate
  const runs = db.getAgentRuns(1000, agentName) as Array<Record<string, unknown>>;
  const runStats = {
    total_runs: runs.length,
    total_cost_usd: runs.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0),
    total_input_tokens: runs.reduce((s, r) => s + (Number(r.input_tokens) || 0), 0),
    total_output_tokens: runs.reduce((s, r) => s + (Number(r.output_tokens) || 0), 0),
    avg_turns: runs.length > 0
      ? Math.round(runs.reduce((s, r) => s + (Number(r.turns) || 0), 0) / runs.length)
      : 0,
  };

  // Messages (optional, last 100)
  const messages = opts.template ? undefined
    : (db.getConversationHistory(agentName, 100) as Array<Record<string, unknown>>).map((m) => ({
      from_agent: String(m.from_agent),
      to_agent: String(m.to_agent),
      message_type: String(m.message_type ?? "general"),
      content: String(m.content),
      created_at: Number(m.created_at),
    }));

  // Build bundle without checksum first
  const bundle: AgentStateBundle = {
    format_version: 1,
    meta: {
      exported_at: new Date().toISOString(),
      exported_from: opts.hostname ?? require("node:os").hostname(),
      operad_version: opts.version ?? "unknown",
      agent_name: agentName,
      checksum: "", // computed below
    },
    config: {
      name: agentConfig.name,
      description: agentConfig.description,
      prompt: agentConfig.prompt,
      max_turns: agentConfig.max_turns,
      effort: agentConfig.effort,
      model: agentConfig.model,
      permission_mode: agentConfig.permission_mode,
      max_budget_usd: agentConfig.max_budget_usd,
      enabled: agentConfig.enabled,
      allowed_tool_categories: agentConfig.allowed_tool_categories,
      max_tool_calls_per_run: agentConfig.max_tool_calls_per_run,
      autonomy_level: agentConfig.autonomy_level,
    },
    personality,
    learnings: learnings.map((l) => ({
      category: String(l.category),
      content: String(l.content),
      content_hash: String(l.content_hash ?? ""),
      confidence: Number(l.confidence ?? 0.5),
      reinforcement_count: Number(l.reinforcement_count ?? 0),
      source_agent: String(l.source_agent ?? agentName),
    })),
    strategies: strategies.map((s) => ({
      strategy_text: String(s.strategy_text),
      rationale: String(s.rationale ?? ""),
      active: Boolean(s.active),
      version: Number(s.version ?? 1),
      created_at: Number(s.created_at),
    })),
    decisions: decisions.map((d) => ({
      action: String(d.action),
      rationale: String(d.rationale),
      alternatives: d.alternatives ? String(d.alternatives) : null,
      expected_outcome: d.expected_outcome ? String(d.expected_outcome) : null,
      actual_outcome: d.actual_outcome ? String(d.actual_outcome) : null,
      score: d.score != null ? Number(d.score) : null,
      goal_id: d.goal_id != null ? Number(d.goal_id) : null,
      created_at: Number(d.created_at),
    })),
    goals: goals.map((g) => ({
      title: String(g.title),
      description: g.description ? String(g.description) : null,
      status: String(g.status),
      priority: Number(g.priority ?? 3),
      parent_title: g.parent_title ? String(g.parent_title) : null,
      expected_outcome: g.expected_outcome ? String(g.expected_outcome) : null,
      actual_outcome: g.actual_outcome ? String(g.actual_outcome) : null,
      success_score: g.success_score != null ? Number(g.success_score) : null,
      created_at: Number(g.created_at),
    })),
    trust_score: trustScore,
    run_stats: runStats,
    messages,
  };

  // Compute checksum over content (excluding meta.checksum)
  bundle.meta.checksum = computeBundleChecksum(bundle);

  return bundle;
}

/** Serialize bundle to gzipped JSON buffer */
export function serializeBundle(bundle: AgentStateBundle): Buffer {
  const json = JSON.stringify(bundle);
  return gzipSync(Buffer.from(json, "utf-8"));
}

/** Deserialize bundle from gzipped JSON buffer */
export function deserializeBundle(data: Buffer): AgentStateBundle {
  const json = gunzipSync(data).toString("utf-8");
  const bundle = JSON.parse(json) as AgentStateBundle;

  // Verify checksum
  const expected = bundle.meta.checksum;
  const actual = computeBundleChecksum(bundle);
  if (expected && actual !== expected) {
    throw new Error(`Bundle checksum mismatch: expected ${expected}, got ${actual}`);
  }

  if (bundle.format_version !== 1) {
    throw new Error(`Unsupported bundle format version: ${bundle.format_version}`);
  }

  return bundle;
}

// -- Import -------------------------------------------------------------------

/** Import results */
export interface ImportResult {
  agent_name: string;
  learnings_imported: number;
  learnings_skipped: number;
  personality_updated: number;
  strategies_imported: number;
  goals_imported: number;
  trust_initialized: boolean;
}

/**
 * Import an agent state bundle into the database.
 * Handles deduplication of learnings and personality merge.
 */
export function importAgentState(
  db: MemoryDb,
  bundle: AgentStateBundle,
  opts: Partial<ImportOptions> = {},
): ImportResult {
  const options = { ...DEFAULT_IMPORT_OPTIONS, ...opts };
  const agentName = bundle.meta.agent_name;
  const sections = options.sections ?? ["personality", "learnings", "strategies", "goals"];

  const result: ImportResult = {
    agent_name: agentName,
    learnings_imported: 0,
    learnings_skipped: 0,
    personality_updated: 0,
    strategies_imported: 0,
    goals_imported: 0,
    trust_initialized: false,
  };

  // Import learnings with deduplication
  if (sections.includes("learnings")) {
    const existing = db.getAgentLearnings(agentName, 10000) as Array<Record<string, unknown>>;
    const existingHashes = new Set(existing.map((l) => String(l.content_hash)));

    for (const learning of bundle.learnings) {
      if (existingHashes.has(learning.content_hash)) {
        // Duplicate — apply merge strategy
        if (options.learningMerge === "prefer_import") {
          // TODO: update existing learning confidence
          result.learnings_skipped++;
        } else {
          result.learnings_skipped++;
        }
        continue;
      }

      db.addLearning(agentName, learning.category, learning.content, {
        confidence: learning.confidence,
      });
      result.learnings_imported++;
    }
  }

  // Import personality traits
  if (sections.includes("personality")) {
    const existingTraits = db.getPersonalitySnapshot(agentName);
    const existingMap = new Map(existingTraits.map((t) => [t.trait_name, t.trait_value]));

    for (const trait of bundle.personality) {
      const existing = existingMap.get(trait.trait_name);
      let newValue = trait.trait_value;

      if (existing != null) {
        switch (options.personalityMerge) {
          case "prefer_existing": continue;
          case "average": newValue = (existing + trait.trait_value) / 2; break;
          case "prefer_import": break; // use imported value
        }
      }

      db.setPersonalityTrait(agentName, trait.trait_name, newValue, trait.evidence ?? "imported");
      result.personality_updated++;
    }
  }

  // Import strategies (append all, mark only the latest as active in replace mode)
  if (sections.includes("strategies")) {
    for (const strategy of bundle.strategies) {
      db.evolveStrategy(agentName, strategy.strategy_text, strategy.rationale);
      result.strategies_imported++;
    }
  }

  // Import goals (create new goals, skip duplicates by title)
  if (sections.includes("goals")) {
    const existingGoals = db.getActiveGoals(agentName) as Array<Record<string, unknown>>;
    const existingTitles = new Set(existingGoals.map((g) => String(g.title)));

    for (const goal of bundle.goals) {
      if (existingTitles.has(goal.title)) continue;
      db.createGoal(goal.title, {
        description: goal.description ?? undefined,
        priority: goal.priority,
        agentName,
      });
      result.goals_imported++;
    }
  }

  // Initialize trust score if none exists
  const currentScore = db.getTrustScore(agentName);
  if (currentScore === 0 && bundle.trust_score > 0) {
    db.recordTrustDelta(agentName, bundle.trust_score, "imported from bundle");
    result.trust_initialized = true;
  }

  return result;
}

// -- Snapshots ----------------------------------------------------------------

/** Snapshot retention policy */
interface RetentionPolicy {
  daily: number;   // keep N daily snapshots
  weekly: number;  // keep N weekly snapshots
  monthly: number; // keep N monthly snapshots
}

const DEFAULT_RETENTION: RetentionPolicy = {
  daily: 7,
  weekly: 4,
  monthly: 3,
};

/**
 * Save a snapshot of an agent's state to disk.
 * Directory: ~/.local/share/operad/snapshots/{agent-name}/
 */
export function saveSnapshot(
  db: MemoryDb,
  agentConfig: AgentConfig,
  snapshotDir: string,
  opts: { version?: string } = {},
): string {
  const agentDir = join(snapshotDir, agentConfig.name);
  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });

  const bundle = exportAgentState(db, agentConfig, { template: true, ...opts });
  const data = serializeBundle(bundle);

  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `${dateStr}.operad-agent.gz`;
  const filePath = join(agentDir, filename);

  writeFileSync(filePath, data);
  return filePath;
}

/**
 * Prune old snapshots according to retention policy.
 * Keeps: N daily (most recent), N weekly (Mondays), N monthly (1st of month).
 */
export function pruneSnapshots(
  snapshotDir: string,
  agentName: string,
  retention: RetentionPolicy = DEFAULT_RETENTION,
): number {
  const agentDir = join(snapshotDir, agentName);
  if (!existsSync(agentDir)) return 0;

  const files = readdirSync(agentDir)
    .filter((f) => f.endsWith(".operad-agent.gz"))
    .sort()
    .reverse(); // newest first

  if (files.length === 0) return 0;

  // Classify files by retention tier
  const keep = new Set<string>();
  let dailyCount = 0;
  let weeklyCount = 0;
  let monthlyCount = 0;

  for (const file of files) {
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;

    const date = new Date(dateMatch[1] + "T00:00:00Z");
    const isMonday = date.getUTCDay() === 1;
    const isFirst = date.getUTCDate() === 1;

    // Daily retention
    if (dailyCount < retention.daily) {
      keep.add(file);
      dailyCount++;
    }

    // Weekly retention (Mondays)
    if (isMonday && weeklyCount < retention.weekly) {
      keep.add(file);
      weeklyCount++;
    }

    // Monthly retention (1st of month)
    if (isFirst && monthlyCount < retention.monthly) {
      keep.add(file);
      monthlyCount++;
    }
  }

  // Delete files not in keep set
  let pruned = 0;
  for (const file of files) {
    if (!keep.has(file)) {
      try {
        unlinkSync(join(agentDir, file));
        pruned++;
      } catch { /* ignore */ }
    }
  }

  return pruned;
}

/** List available snapshots for an agent */
export function listSnapshots(snapshotDir: string, agentName: string): string[] {
  const agentDir = join(snapshotDir, agentName);
  if (!existsSync(agentDir)) return [];
  return readdirSync(agentDir)
    .filter((f) => f.endsWith(".operad-agent.gz"))
    .sort()
    .reverse();
}

// -- Helpers ------------------------------------------------------------------

/** Compute SHA-256 checksum of bundle content (excluding meta.checksum) */
function computeBundleChecksum(bundle: AgentStateBundle): string {
  const copy = { ...bundle, meta: { ...bundle.meta, checksum: "" } };
  const json = JSON.stringify(copy);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}
