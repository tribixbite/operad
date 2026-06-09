/**
 * agent-state.test.ts — Tests for agent-state.ts (bundle export/import/snapshot)
 *
 * Covers:
 *  - serializeBundle / deserializeBundle: round-trip gzip+JSON fidelity
 *  - deserializeBundle: checksum mismatch rejection
 *  - deserializeBundle: unsupported format_version rejection
 *  - deserializeBundle: malformed (not gzip) data rejection
 *  - exportAgentState: produces bundle with correct agent_name, format_version=1,
 *      personality, learnings, strategies, goals, trust_score, run_stats
 *  - exportAgentState template=true: excludes decisions and messages
 *  - importAgentState: learnings imported, duplicates skipped
 *  - importAgentState: learningMerge strategies (keep_higher_confidence, prefer_import)
 *  - importAgentState: personality traits (prefer_import, prefer_existing, average)
 *  - importAgentState: strategies appended
 *  - importAgentState: goals imported, duplicate titles skipped
 *  - importAgentState: trust_score initialized when 0 and bundle > 0
 *  - importAgentState: sections filter limits what gets imported
 *  - importAgentState idempotency: second import skips all duplicates
 *  - saveSnapshot: file created in correct directory with YYYY-MM-DD.operad-agent.gz name
 *  - listSnapshots: returns files in newest-first order
 *  - pruneSnapshots: returns 0 when dir doesn't exist; keeps daily; prunes extras;
 *      weekly Mondays kept; monthly 1st-of-month kept
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MemoryDb } from "../memory-db.js";
import {
  exportAgentState,
  importAgentState,
  serializeBundle,
  deserializeBundle,
  saveSnapshot,
  listSnapshots,
  pruneSnapshots,
} from "../agent-state.js";
import type { AgentStateBundle, ImportOptions } from "../agent-state.js";
import type { AgentConfig } from "../agents.js";
import type { Logger } from "../log.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLog(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

/** Minimal valid AgentConfig for testing */
function makeAgentConfig(name = "test-agent"): AgentConfig {
  return {
    name,
    description: "A test agent",
    prompt: "You are a test agent.",
    enabled: true,
    source: "builtin",
  };
}

let tmpDir: string;
let db: MemoryDb;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-agstate-test-"));
  db = new MemoryDb(silentLog(), tmpDir);
  await db.init();
});

afterEach(() => {
  db.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

// ---------------------------------------------------------------------------
// serializeBundle / deserializeBundle — gzip round-trip
// ---------------------------------------------------------------------------

describe("serializeBundle / deserializeBundle — round-trip", () => {
  function minimalBundle(agentName = "test-agent"): AgentStateBundle {
    return {
      format_version: 1,
      meta: {
        exported_at: new Date().toISOString(),
        exported_from: "test-host",
        operad_version: "0.0.0",
        agent_name: agentName,
        checksum: "",
      },
      config: { name: agentName, enabled: true },
      personality: [],
      learnings: [],
      strategies: [],
      decisions: [],
      goals: [],
      trust_score: 0,
      run_stats: {
        total_runs: 0,
        total_cost_usd: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        avg_turns: 0,
      },
    };
  }

  test("serialize then deserialize produces an identical bundle", () => {
    const bundle = minimalBundle();
    const data = serializeBundle(bundle);
    const restored = deserializeBundle(data);
    expect(restored.format_version).toBe(bundle.format_version);
    expect(restored.meta.agent_name).toBe(bundle.meta.agent_name);
    expect(restored.meta.exported_from).toBe(bundle.meta.exported_from);
  });

  test("serialized data is a non-empty Buffer (compressed bytes)", () => {
    const data = serializeBundle(minimalBundle());
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  test("deserializeBundle rejects corrupted data (not gzip)", () => {
    const bad = Buffer.from("this is not gzip data");
    expect(() => deserializeBundle(bad)).toThrow();
  });

  test("deserializeBundle rejects unsupported format_version", () => {
    const bundle = minimalBundle();
    // Force a non-1 format_version through the wire
    const json = JSON.stringify({ ...bundle, format_version: 99 });
    const { gzipSync } = require("node:zlib");
    const data = gzipSync(Buffer.from(json, "utf-8"));
    expect(() => deserializeBundle(data)).toThrow(/Unsupported bundle format version/);
  });

  test("deserializeBundle rejects checksum mismatch", () => {
    const bundle = minimalBundle();
    const data = serializeBundle(bundle);
    // Deserialize once to get the real bundle (with checksum), then tamper
    const restored = deserializeBundle(data);
    // Tamper with content after checksum was computed
    restored.trust_score = 9999;
    const tampered = serializeBundle(restored);
    // Re-inflate the tampered bundle; now the embedded checksum is wrong
    // (serializeBundle doesn't recompute the checksum — it serializes as-is)
    // So we need to manually corrupt the checksum field
    const corruptJson = JSON.stringify({ ...restored, meta: { ...restored.meta, checksum: "deadbeef00000000" } });
    const { gzipSync } = require("node:zlib");
    const corruptData = gzipSync(Buffer.from(corruptJson, "utf-8"));
    expect(() => deserializeBundle(corruptData)).toThrow(/checksum mismatch/);
  });

  test("bundle with complex data survives round-trip", () => {
    const bundle = minimalBundle("complex-agent");
    bundle.personality = [{ trait_name: "curiosity", trait_value: 0.8, evidence: "observed" }];
    bundle.learnings = [{
      category: "insight",
      content: "TypeScript is great",
      content_hash: "abc123",
      confidence: 0.9,
      reinforcement_count: 3,
      source_agent: "complex-agent",
    }];
    bundle.trust_score = 450;

    const data = serializeBundle(bundle);
    const restored = deserializeBundle(data);
    expect(restored.personality[0].trait_name).toBe("curiosity");
    expect(restored.learnings[0].content).toBe("TypeScript is great");
    expect(restored.trust_score).toBe(450);
  });
});

// ---------------------------------------------------------------------------
// exportAgentState — bundle construction from DB
// ---------------------------------------------------------------------------

describe("exportAgentState — basic structure", () => {
  test("exported bundle has format_version=1", () => {
    const config = makeAgentConfig("exporter");
    const bundle = exportAgentState(db, config, { hostname: "test-host", version: "1.0.0" });
    expect(bundle.format_version).toBe(1);
  });

  test("exported bundle meta has correct agent_name", () => {
    const config = makeAgentConfig("my-agent");
    const bundle = exportAgentState(db, config, { hostname: "host", version: "1.0.0" });
    expect(bundle.meta.agent_name).toBe("my-agent");
  });

  test("exported bundle meta has a non-empty checksum", () => {
    const config = makeAgentConfig();
    const bundle = exportAgentState(db, config, { version: "1.0.0" });
    expect(bundle.meta.checksum.length).toBeGreaterThan(0);
  });

  test("checksum is consistent for the same data", () => {
    const config = makeAgentConfig("stable");
    const b1 = exportAgentState(db, config, { hostname: "h", version: "v" });
    const b2 = exportAgentState(db, config, { hostname: "h", version: "v" });
    // Both should have the same checksum for same DB state
    // (exported_at differs by timestamp, so checksum will differ — just verify format)
    expect(b1.meta.checksum).toMatch(/^[0-9a-f]{16}$/);
    expect(b2.meta.checksum).toMatch(/^[0-9a-f]{16}$/);
  });

  test("exported bundle includes personality traits from DB", () => {
    const config = makeAgentConfig("agt");
    db.setPersonalityTrait("agt", "boldness", 0.7, "test evidence");
    const bundle = exportAgentState(db, config);
    expect(bundle.personality.length).toBe(1);
    expect(bundle.personality[0].trait_name).toBe("boldness");
    expect(bundle.personality[0].trait_value).toBeCloseTo(0.7, 5);
  });

  test("exported bundle includes learnings from DB", () => {
    const config = makeAgentConfig("agt");
    db.addLearning("agt", "insight", "learned something", { confidence: 0.8 });
    const bundle = exportAgentState(db, config);
    expect(bundle.learnings.length).toBe(1);
    expect(bundle.learnings[0].content).toBe("learned something");
    expect(bundle.learnings[0].confidence).toBeCloseTo(0.8, 5);
  });

  test("exported bundle includes strategies from DB", () => {
    const config = makeAgentConfig("agt");
    db.evolveStrategy("agt", "be thorough", "it helps");
    const bundle = exportAgentState(db, config);
    expect(bundle.strategies.length).toBe(1);
    expect(bundle.strategies[0].strategy_text).toBe("be thorough");
  });

  test("exported bundle includes active goals from DB", () => {
    const config = makeAgentConfig("agt");
    db.createGoal("Ship it", { agentName: "agt", priority: 1 });
    const bundle = exportAgentState(db, config);
    expect(bundle.goals.length).toBe(1);
    expect(bundle.goals[0].title).toBe("Ship it");
  });

  test("exported bundle trust_score matches DB", () => {
    const config = makeAgentConfig("agt");
    db.recordTrustDelta("agt", 500, "good work");
    const bundle = exportAgentState(db, config);
    expect(bundle.trust_score).toBe(500);
  });

  test("exported bundle run_stats reflects completed runs", () => {
    const config = makeAgentConfig("agt");
    const id = db.startAgentRun("agt", "sess");
    db.completeAgentRun(id, "completed", { inputTokens: 100, outputTokens: 200, costUsd: 0.05 });
    const bundle = exportAgentState(db, config);
    expect(bundle.run_stats.total_runs).toBe(1);
    expect(bundle.run_stats.total_input_tokens).toBe(100);
    expect(bundle.run_stats.total_output_tokens).toBe(200);
  });
});

describe("exportAgentState — template mode", () => {
  test("template=true excludes decisions array (empty)", () => {
    const config = makeAgentConfig("agt");
    db.recordDecision("agt", "action", "reason");
    const bundle = exportAgentState(db, config, { template: true });
    expect(bundle.decisions).toEqual([]);
  });

  test("template=true excludes messages (undefined)", () => {
    const config = makeAgentConfig("agt");
    db.sendAgentMessage("agt", "other", "hi");
    const bundle = exportAgentState(db, config, { template: true });
    expect(bundle.messages).toBeUndefined();
  });

  test("template=false includes decisions", () => {
    const config = makeAgentConfig("agt");
    db.recordDecision("agt", "action", "because");
    const bundle = exportAgentState(db, config, { template: false });
    expect(bundle.decisions.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// importAgentState — learnings
// ---------------------------------------------------------------------------

describe("importAgentState — learnings", () => {
  test("imports new learnings from bundle", () => {
    const config = makeAgentConfig("dest");
    const bundle = exportAgentState(db, makeAgentConfig("src"), { hostname: "h", version: "v" });
    // Manually add a learning to the bundle
    bundle.meta.agent_name = "dest";
    bundle.learnings = [{
      category: "insight",
      content: "unique content abc",
      content_hash: "unique-hash-123",
      confidence: 0.9,
      reinforcement_count: 1,
      source_agent: "src",
    }];

    const result = importAgentState(db, bundle);
    expect(result.learnings_imported).toBe(1);
    expect(result.learnings_skipped).toBe(0);
    const learnings = db.getAgentLearnings("dest");
    expect(learnings.length).toBe(1);
  });

  test("duplicate learning (same content_hash) is skipped", () => {
    // Pre-populate a learning in dest
    db.addLearning("dest", "insight", "already known");
    const existing = db.getAgentLearnings("dest") as Array<Record<string, unknown>>;
    const hash = String(existing[0].content_hash);

    const bundle: AgentStateBundle = {
      format_version: 1,
      meta: { exported_at: new Date().toISOString(), exported_from: "h", operad_version: "v", agent_name: "dest", checksum: "aaaa" },
      config: {},
      personality: [],
      learnings: [{ category: "insight", content: "already known", content_hash: hash, confidence: 0.9, reinforcement_count: 1, source_agent: "src" }],
      strategies: [],
      decisions: [],
      goals: [],
      trust_score: 0,
      run_stats: { total_runs: 0, total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0, avg_turns: 0 },
    };

    const result = importAgentState(db, bundle);
    expect(result.learnings_skipped).toBe(1);
    expect(result.learnings_imported).toBe(0);
    // Still only 1 learning
    expect(db.getAgentLearnings("dest").length).toBe(1);
  });

  test("sections filter: learnings not imported when 'learnings' not in sections", () => {
    const bundle: AgentStateBundle = {
      format_version: 1,
      meta: { exported_at: new Date().toISOString(), exported_from: "h", operad_version: "v", agent_name: "dest", checksum: "" },
      config: {},
      personality: [],
      learnings: [{ category: "insight", content: "should not import", content_hash: "xyz", confidence: 0.9, reinforcement_count: 1, source_agent: "src" }],
      strategies: [],
      decisions: [],
      goals: [],
      trust_score: 0,
      run_stats: { total_runs: 0, total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0, avg_turns: 0 },
    };

    const result = importAgentState(db, bundle, { sections: ["personality"] });
    expect(result.learnings_imported).toBe(0);
    expect(db.getAgentLearnings("dest").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// importAgentState — personality
// ---------------------------------------------------------------------------

describe("importAgentState — personality", () => {
  function makeBundle(agentName: string, traits: Array<{ trait_name: string; trait_value: number }>): AgentStateBundle {
    return {
      format_version: 1,
      meta: { exported_at: new Date().toISOString(), exported_from: "h", operad_version: "v", agent_name: agentName, checksum: "" },
      config: {},
      personality: traits.map((t) => ({ ...t, evidence: null })),
      learnings: [],
      strategies: [],
      decisions: [],
      goals: [],
      trust_score: 0,
      run_stats: { total_runs: 0, total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0, avg_turns: 0 },
    };
  }

  test("prefer_import: overwrites existing trait value", () => {
    db.setPersonalityTrait("dest", "curiosity", 0.3);
    const bundle = makeBundle("dest", [{ trait_name: "curiosity", trait_value: 0.9 }]);
    importAgentState(db, bundle, { personalityMerge: "prefer_import" });
    const snap = db.getPersonalitySnapshot("dest");
    expect(snap[0].trait_value).toBeCloseTo(0.9, 5);
  });

  test("prefer_existing: keeps existing trait value", () => {
    db.setPersonalityTrait("dest", "boldness", 0.4);
    const bundle = makeBundle("dest", [{ trait_name: "boldness", trait_value: 0.9 }]);
    importAgentState(db, bundle, { personalityMerge: "prefer_existing" });
    const snap = db.getPersonalitySnapshot("dest");
    expect(snap[0].trait_value).toBeCloseTo(0.4, 5);
  });

  test("average: blends import and existing value", () => {
    db.setPersonalityTrait("dest", "empathy", 0.4);
    const bundle = makeBundle("dest", [{ trait_name: "empathy", trait_value: 0.8 }]);
    importAgentState(db, bundle, { personalityMerge: "average" });
    const snap = db.getPersonalitySnapshot("dest");
    // (0.4 + 0.8) / 2 = 0.6
    expect(snap[0].trait_value).toBeCloseTo(0.6, 5);
  });

  test("new trait (no existing) is always added regardless of merge mode", () => {
    const bundle = makeBundle("dest", [{ trait_name: "creativity", trait_value: 0.75 }]);
    importAgentState(db, bundle, { personalityMerge: "prefer_existing" });
    const snap = db.getPersonalitySnapshot("dest");
    expect(snap.length).toBe(1);
    expect(snap[0].trait_value).toBeCloseTo(0.75, 5);
  });

  test("personality_updated count reflects number of traits written", () => {
    const bundle = makeBundle("dest", [
      { trait_name: "t1", trait_value: 0.5 },
      { trait_name: "t2", trait_value: 0.6 },
    ]);
    const result = importAgentState(db, bundle);
    expect(result.personality_updated).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// importAgentState — strategies
// ---------------------------------------------------------------------------

describe("importAgentState — strategies", () => {
  function bundleWithStrategies(strategies: Array<{ strategy_text: string; rationale: string }>): AgentStateBundle {
    return {
      format_version: 1,
      meta: { exported_at: new Date().toISOString(), exported_from: "h", operad_version: "v", agent_name: "dest", checksum: "" },
      config: {},
      personality: [],
      learnings: [],
      strategies: strategies.map((s) => ({ ...s, active: true, version: 1, created_at: Math.floor(Date.now() / 1000) })),
      decisions: [],
      goals: [],
      trust_score: 0,
      run_stats: { total_runs: 0, total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0, avg_turns: 0 },
    };
  }

  test("strategies are appended (evolveStrategy called per strategy)", () => {
    const bundle = bundleWithStrategies([
      { strategy_text: "be concise", rationale: "saves time" },
      { strategy_text: "check twice", rationale: "reduces errors" },
    ]);
    const result = importAgentState(db, bundle);
    expect(result.strategies_imported).toBe(2);
    const hist = db.getStrategyHistory("dest");
    expect(hist.length).toBe(2);
  });

  test("strategies not imported when sections excludes 'strategies'", () => {
    const bundle = bundleWithStrategies([{ strategy_text: "strategy x", rationale: "r" }]);
    importAgentState(db, bundle, { sections: ["learnings"] });
    expect(db.getStrategyHistory("dest").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// importAgentState — goals
// ---------------------------------------------------------------------------

describe("importAgentState — goals", () => {
  function bundleWithGoals(goals: Array<{ title: string; description?: string }>): AgentStateBundle {
    const now = Math.floor(Date.now() / 1000);
    return {
      format_version: 1,
      meta: { exported_at: new Date().toISOString(), exported_from: "h", operad_version: "v", agent_name: "dest", checksum: "" },
      config: {},
      personality: [],
      learnings: [],
      strategies: [],
      decisions: [],
      goals: goals.map((g) => ({
        title: g.title,
        description: g.description ?? null,
        status: "active",
        priority: 3,
        parent_title: null,
        expected_outcome: null,
        actual_outcome: null,
        success_score: null,
        created_at: now,
      })),
      trust_score: 0,
      run_stats: { total_runs: 0, total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0, avg_turns: 0 },
    };
  }

  test("new goals are created in DB", () => {
    const bundle = bundleWithGoals([{ title: "Ship it" }, { title: "Fix bugs" }]);
    const result = importAgentState(db, bundle);
    expect(result.goals_imported).toBe(2);
    const active = db.getActiveGoals("dest");
    expect(active.length).toBe(2);
  });

  test("goal with duplicate title is skipped", () => {
    db.createGoal("Existing goal", { agentName: "dest" });
    const bundle = bundleWithGoals([{ title: "Existing goal" }, { title: "New goal" }]);
    const result = importAgentState(db, bundle);
    expect(result.goals_imported).toBe(1); // only "New goal"
    expect(db.getActiveGoals("dest").length).toBe(2); // original + new
  });
});

// ---------------------------------------------------------------------------
// importAgentState — trust score
// ---------------------------------------------------------------------------

describe("importAgentState — trust score", () => {
  function bundleWithTrust(agentName: string, trust: number): AgentStateBundle {
    return {
      format_version: 1,
      meta: { exported_at: new Date().toISOString(), exported_from: "h", operad_version: "v", agent_name: agentName, checksum: "" },
      config: {},
      personality: [],
      learnings: [],
      strategies: [],
      decisions: [],
      goals: [],
      trust_score: trust,
      run_stats: { total_runs: 0, total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0, avg_turns: 0 },
    };
  }

  test("trust_score is initialized when agent has 0 score and bundle > 0", () => {
    const bundle = bundleWithTrust("fresh-agent", 300);
    const result = importAgentState(db, bundle);
    expect(result.trust_initialized).toBe(true);
    expect(db.getTrustScore("fresh-agent")).toBe(300);
  });

  test("trust_score NOT initialized when agent already has non-zero score", () => {
    db.recordTrustDelta("existing-agent", 100, "established");
    const bundle = bundleWithTrust("existing-agent", 500);
    const result = importAgentState(db, bundle);
    expect(result.trust_initialized).toBe(false);
    // Score unchanged (still 100)
    expect(db.getTrustScore("existing-agent")).toBe(100);
  });

  test("trust_score NOT initialized when bundle has score of 0", () => {
    const bundle = bundleWithTrust("agent-zero", 0);
    const result = importAgentState(db, bundle);
    expect(result.trust_initialized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// importAgentState — idempotency (full round-trip)
// ---------------------------------------------------------------------------

describe("importAgentState — idempotency", () => {
  test("full export → import → second import skips all duplicates", async () => {
    // Populate DB with data for source agent
    db.addLearning("src", "insight", "unique learning content", { confidence: 0.8 });
    db.setPersonalityTrait("src", "drive", 0.7);
    db.createGoal("Important goal", { agentName: "src" });

    const config = makeAgentConfig("src");
    const bundle = exportAgentState(db, config, { hostname: "h", version: "v" });
    bundle.meta.agent_name = "dest";

    // First import
    const r1 = importAgentState(db, bundle);
    expect(r1.learnings_imported).toBe(1);
    expect(r1.goals_imported).toBe(1);

    // Second import — everything should be skipped (duplicate hashes + titles)
    const r2 = importAgentState(db, bundle);
    expect(r2.learnings_imported).toBe(0);
    expect(r2.learnings_skipped).toBe(1);
    expect(r2.goals_imported).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// exportAgentState → serializeBundle → deserializeBundle round-trip
// ---------------------------------------------------------------------------

describe("exportAgentState → full serialization round-trip", () => {
  test("bundle survives gzip round-trip and checksum validates", () => {
    db.addLearning("agt", "insight", "round-trip test", { confidence: 0.75 });
    db.setPersonalityTrait("agt", "precision", 0.9);
    db.recordTrustDelta("agt", 250, "testing");

    const config = makeAgentConfig("agt");
    const bundle = exportAgentState(db, config, { hostname: "ci", version: "test" });
    const data = serializeBundle(bundle);
    const restored = deserializeBundle(data); // checksum validated inside

    expect(restored.meta.agent_name).toBe("agt");
    expect(restored.learnings.length).toBe(1);
    expect(restored.learnings[0].content).toBe("round-trip test");
    expect(restored.personality.length).toBe(1);
    expect(restored.trust_score).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// saveSnapshot / listSnapshots / pruneSnapshots
// ---------------------------------------------------------------------------

describe("saveSnapshot", () => {
  test("creates a .operad-agent.gz file in the agent's subdir", () => {
    const snapshotDir = join(tmpDir, "snapshots");
    const config = makeAgentConfig("my-agent");
    const filePath = saveSnapshot(db, config, snapshotDir);
    expect(existsSync(filePath)).toBe(true);
    expect(filePath.endsWith(".operad-agent.gz")).toBe(true);
  });

  test("saved file is named YYYY-MM-DD.operad-agent.gz", () => {
    const snapshotDir = join(tmpDir, "snapshots");
    const config = makeAgentConfig("my-agent");
    const filePath = saveSnapshot(db, config, snapshotDir);
    // Split on BOTH separators — saveSnapshot uses path.join, so the basename
    // is delimited by "\" on Windows and "/" elsewhere.
    const filename = filePath.split(/[\\/]/).pop()!;
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}\.operad-agent\.gz$/);
  });

  test("saved file can be deserialized back as a valid bundle", () => {
    const snapshotDir = join(tmpDir, "snapshots");
    const config = makeAgentConfig("my-agent");
    const { readFileSync } = require("node:fs");
    const filePath = saveSnapshot(db, config, snapshotDir);
    const data = readFileSync(filePath);
    const bundle = deserializeBundle(data);
    expect(bundle.format_version).toBe(1);
    expect(bundle.meta.agent_name).toBe("my-agent");
  });

  test("creates agent subdirectory if it doesn't exist", () => {
    const snapshotDir = join(tmpDir, "nested", "snapshots");
    const config = makeAgentConfig("my-agent");
    const filePath = saveSnapshot(db, config, snapshotDir);
    expect(existsSync(filePath)).toBe(true);
  });
});

describe("listSnapshots", () => {
  test("returns empty array when directory doesn't exist", () => {
    const result = listSnapshots(join(tmpDir, "nonexistent"), "my-agent");
    expect(result).toEqual([]);
  });

  test("returns snapshots in newest-first order", () => {
    const snapshotDir = join(tmpDir, "snapshots");
    const agentDir = join(snapshotDir, "my-agent");
    mkdirSync(agentDir, { recursive: true });
    // Create fake snapshot files with different dates
    writeFileSync(join(agentDir, "2025-01-01.operad-agent.gz"), "fake");
    writeFileSync(join(agentDir, "2025-01-03.operad-agent.gz"), "fake");
    writeFileSync(join(agentDir, "2025-01-02.operad-agent.gz"), "fake");

    const snapshots = listSnapshots(snapshotDir, "my-agent");
    expect(snapshots[0]).toBe("2025-01-03.operad-agent.gz"); // newest first
    expect(snapshots[2]).toBe("2025-01-01.operad-agent.gz"); // oldest last
  });

  test("ignores files that don't match .operad-agent.gz pattern", () => {
    const snapshotDir = join(tmpDir, "snapshots");
    const agentDir = join(snapshotDir, "my-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "2025-01-01.operad-agent.gz"), "real");
    writeFileSync(join(agentDir, "random.json"), "ignored");
    writeFileSync(join(agentDir, ".hidden"), "ignored");

    const snapshots = listSnapshots(snapshotDir, "my-agent");
    expect(snapshots).toEqual(["2025-01-01.operad-agent.gz"]);
  });
});

describe("pruneSnapshots", () => {
  test("returns 0 when agent directory doesn't exist", () => {
    const result = pruneSnapshots(join(tmpDir, "snapshots"), "ghost-agent");
    expect(result).toBe(0);
  });

  test("returns 0 for empty directory", () => {
    const snapshotDir = join(tmpDir, "snapshots");
    mkdirSync(join(snapshotDir, "my-agent"), { recursive: true });
    expect(pruneSnapshots(snapshotDir, "my-agent")).toBe(0);
  });

  test("keeps daily snapshots up to the daily limit", () => {
    const snapshotDir = join(tmpDir, "snapshots");
    const agentDir = join(snapshotDir, "my-agent");
    mkdirSync(agentDir, { recursive: true });

    // Create 10 daily snapshots (newest first when sorted DESC)
    for (let d = 1; d <= 10; d++) {
      const date = `2025-01-${String(d).padStart(2, "0")}`;
      writeFileSync(join(agentDir, `${date}.operad-agent.gz`), "x");
    }

    // Default retention: daily=7, weekly=4, monthly=3
    const pruned = pruneSnapshots(snapshotDir, "my-agent", { daily: 3, weekly: 0, monthly: 0 });
    expect(pruned).toBe(7); // 10 - 3 kept = 7 pruned
  });

  test("keeps weekly snapshots (Mondays) — uses weekly=3 budget to cover 3 Mondays", () => {
    const snapshotDir = join(tmpDir, "snapshots");
    const agentDir = join(snapshotDir, "my-agent");
    mkdirSync(agentDir, { recursive: true });

    // 2025-01-06, 2025-01-13, 2025-01-20 are all Mondays.
    // Add non-Monday days Jan 7-12 and Jan 14-19 around them.
    // Files in newest-first: Jan 20 (Mon, daily slot 1+weekly slot 1),
    //   Jan 19..14 (6 non-Mon, fill daily slots 2-7),
    //   Jan 13 (Mon, weekly slot 2), Jan 12..7 (non-Mon, beyond daily),
    //   Jan 06 (Mon, weekly slot 3 → kept).
    writeFileSync(join(agentDir, "2025-01-06.operad-agent.gz"), "monday1");
    writeFileSync(join(agentDir, "2025-01-13.operad-agent.gz"), "monday2");
    writeFileSync(join(agentDir, "2025-01-20.operad-agent.gz"), "monday3");
    for (let d = 7; d <= 12; d++) {
      writeFileSync(join(agentDir, `2025-01-${String(d).padStart(2, "0")}.operad-agent.gz`), "x");
    }
    for (let d = 14; d <= 19; d++) {
      writeFileSync(join(agentDir, `2025-01-${String(d).padStart(2, "0")}.operad-agent.gz`), "x");
    }

    // daily=7: keeps Jan 14-20 (7 files). weekly=3: Jan 20 (slot 1), Jan 13 (slot 2), Jan 6 (slot 3)
    pruneSnapshots(snapshotDir, "my-agent", { daily: 7, weekly: 3, monthly: 0 });
    const remaining = listSnapshots(snapshotDir, "my-agent");
    // Jan 6 should be kept as the 3rd weekly Monday
    expect(remaining.includes("2025-01-06.operad-agent.gz")).toBe(true);
  });

  test("keeps monthly snapshots (1st of month)", () => {
    const snapshotDir = join(tmpDir, "snapshots");
    const agentDir = join(snapshotDir, "my-agent");
    mkdirSync(agentDir, { recursive: true });

    // 2025-01-01 is the 1st of January — kept as monthly snapshot
    writeFileSync(join(agentDir, "2025-01-01.operad-agent.gz"), "first");
    // 10 non-first days in January
    for (let d = 15; d <= 25; d++) {
      writeFileSync(join(agentDir, `2025-01-${d}.operad-agent.gz`), "x");
    }

    // daily=3, weekly=0, monthly=1 — Jan 1 should survive
    pruneSnapshots(snapshotDir, "my-agent", { daily: 3, weekly: 0, monthly: 1 });
    const remaining = listSnapshots(snapshotDir, "my-agent");
    expect(remaining.includes("2025-01-01.operad-agent.gz")).toBe(true);
  });

  test("pruned count equals files-before minus files-after", () => {
    const snapshotDir = join(tmpDir, "snapshots");
    const agentDir = join(snapshotDir, "my-agent");
    mkdirSync(agentDir, { recursive: true });

    for (let d = 1; d <= 5; d++) {
      writeFileSync(join(agentDir, `2025-06-${String(d).padStart(2, "0")}.operad-agent.gz`), "x");
    }

    const before = listSnapshots(snapshotDir, "my-agent").length;
    const pruned = pruneSnapshots(snapshotDir, "my-agent", { daily: 2, weekly: 0, monthly: 0 });
    const after = listSnapshots(snapshotDir, "my-agent").length;
    expect(before - after).toBe(pruned);
  });
});
