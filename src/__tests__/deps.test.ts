/**
 * deps.test.ts — Unit tests for dependency graph topological sort
 *
 * Tests computeStartupOrder() and CycleError from deps.ts.
 * Uses minimal SessionConfig stubs (cast via `as any`) since we only
 * need the fields relevant to dependency ordering.
 */

import { describe, test, expect } from "bun:test";
import {
  computeStartupOrder,
  computeShutdownOrder,
  getTransitiveDeps,
  getTransitiveDependents,
  CycleError,
} from "../deps.js";
import type { SessionConfig } from "../types.js";

/** Helper: build a minimal SessionConfig stub with only the fields deps.ts uses */
function session(name: string, opts: { enabled?: boolean; depends_on?: string[]; priority?: number } = {}): SessionConfig {
  return {
    name,
    enabled: opts.enabled ?? true,
    depends_on: opts.depends_on ?? [],
    priority: opts.priority ?? 10,
  } as any;
}

describe("computeStartupOrder", () => {
  test("linear chain A→B→C produces 3 batches", () => {
    const sessions = [
      session("A", { depends_on: ["B"] }),
      session("B", { depends_on: ["C"] }),
      session("C"),
    ];
    const batches = computeStartupOrder(sessions);

    expect(batches).toHaveLength(3);
    // C has no deps — starts first (depth 0)
    expect(batches[0].depth).toBe(0);
    expect(batches[0].sessions).toEqual(["C"]);
    // B depends on C — depth 1
    expect(batches[1].depth).toBe(1);
    expect(batches[1].sessions).toEqual(["B"]);
    // A depends on B — depth 2
    expect(batches[2].depth).toBe(2);
    expect(batches[2].sessions).toEqual(["A"]);
  });

  test("diamond deps: A depends on B+C, B+C have no deps", () => {
    const sessions = [
      session("A", { depends_on: ["B", "C"] }),
      session("B"),
      session("C"),
    ];
    const batches = computeStartupOrder(sessions);

    expect(batches).toHaveLength(2);
    // B and C start first (in same batch)
    expect(batches[0].depth).toBe(0);
    expect(batches[0].sessions).toContain("B");
    expect(batches[0].sessions).toContain("C");
    expect(batches[0].sessions).toHaveLength(2);
    // A starts after B+C
    expect(batches[1].depth).toBe(1);
    expect(batches[1].sessions).toEqual(["A"]);
  });

  test("cycle A→B→A throws CycleError", () => {
    const sessions = [
      session("A", { depends_on: ["B"] }),
      session("B", { depends_on: ["A"] }),
    ];

    expect(() => computeStartupOrder(sessions)).toThrow(CycleError);
  });

  test("empty graph returns empty array", () => {
    const batches = computeStartupOrder([]);
    expect(batches).toEqual([]);
  });

  test("single node produces one batch", () => {
    const sessions = [session("solo")];
    const batches = computeStartupOrder(sessions);

    expect(batches).toHaveLength(1);
    expect(batches[0].depth).toBe(0);
    expect(batches[0].sessions).toEqual(["solo"]);
  });

  test("disabled sessions are filtered out", () => {
    const sessions = [
      session("A", { depends_on: ["B"] }),
      session("B", { enabled: false }),
    ];
    const batches = computeStartupOrder(sessions);

    // B is disabled, so A's dep on B is ignored (unknown ref)
    expect(batches).toHaveLength(1);
    expect(batches[0].sessions).toEqual(["A"]);
  });

  test("priority ordering within batch (lower priority = first)", () => {
    const sessions = [
      session("high", { priority: 50 }),
      session("low", { priority: 1 }),
      session("mid", { priority: 25 }),
    ];
    const batches = computeStartupOrder(sessions);

    // All in batch 0 (no deps), sorted by priority ascending
    expect(batches).toHaveLength(1);
    expect(batches[0].sessions).toEqual(["low", "mid", "high"]);
  });

  test("self-loop A→A throws CycleError", () => {
    const sessions = [session("A", { depends_on: ["A"] })];
    expect(() => computeStartupOrder(sessions)).toThrow(CycleError);
  });

  test("longer cycle A→B→C→A throws CycleError", () => {
    const sessions = [
      session("A", { depends_on: ["B"] }),
      session("B", { depends_on: ["C"] }),
      session("C", { depends_on: ["A"] }),
    ];
    expect(() => computeStartupOrder(sessions)).toThrow(CycleError);
  });

  test("CycleError.cycle contains the stuck nodes", () => {
    const sessions = [
      session("X", { depends_on: ["Y"] }),
      session("Y", { depends_on: ["X"] }),
    ];
    let err: CycleError | undefined;
    try { computeStartupOrder(sessions); } catch (e) { if (e instanceof CycleError) err = e; }
    expect(err).toBeDefined();
    expect(err!.cycle).toContain("X");
    expect(err!.cycle).toContain("Y");
  });

  test("dependency on missing/disabled node is ignored (not an error)", () => {
    const sessions = [
      session("A", { depends_on: ["missing"] }),
    ];
    // "missing" is not in the enabled set — the ref is silently dropped
    const batches = computeStartupOrder(sessions);
    expect(batches).toHaveLength(1);
    expect(batches[0].sessions).toEqual(["A"]);
  });

  test("multiple independent roots all land in batch 0", () => {
    const sessions = [
      session("root1"),
      session("root2"),
      session("root3"),
    ];
    const batches = computeStartupOrder(sessions);
    expect(batches).toHaveLength(1);
    expect(batches[0].sessions).toHaveLength(3);
  });

  test("diamond deps with shared dep: A→B, A→C, B→D, C→D produces 3-layer ordering", () => {
    // D is the shared dependency
    // Layer 0: D (no deps)
    // Layer 1: B, C (both depend only on D)
    // Layer 2: A (depends on B and C)
    const sessions = [
      session("A", { depends_on: ["B", "C"] }),
      session("B", { depends_on: ["D"] }),
      session("C", { depends_on: ["D"] }),
      session("D"),
    ];
    const batches = computeStartupOrder(sessions);
    expect(batches).toHaveLength(3);
    expect(batches[0].sessions).toEqual(["D"]);
    expect(batches[1].sessions).toContain("B");
    expect(batches[1].sessions).toContain("C");
    expect(batches[2].sessions).toEqual(["A"]);
  });
});

// ---------------------------------------------------------------------------
// computeShutdownOrder
// ---------------------------------------------------------------------------

describe("computeShutdownOrder", () => {
  test("shutdown order is reverse of startup order", () => {
    const sessions = [
      session("A", { depends_on: ["B"] }),
      session("B", { depends_on: ["C"] }),
      session("C"),
    ];
    // Startup: C(depth0) → B(depth1) → A(depth2)
    // Shutdown: A(depth0) → B(depth1) → C(depth2)
    const batches = computeShutdownOrder(sessions);
    expect(batches).toHaveLength(3);
    expect(batches[0].sessions).toEqual(["A"]); // A stops first (highest startup depth)
    expect(batches[1].sessions).toEqual(["B"]);
    expect(batches[2].sessions).toEqual(["C"]); // C stops last (deepest dep)
  });

  test("shutdown depth is re-indexed from 0", () => {
    const sessions = [
      session("A", { depends_on: ["B"] }),
      session("B"),
    ];
    const batches = computeShutdownOrder(sessions);
    expect(batches[0].depth).toBe(0);
    expect(batches[1].depth).toBe(1);
  });

  test("empty graph shutdown returns empty array", () => {
    expect(computeShutdownOrder([])).toEqual([]);
  });

  test("cycle in shutdown order also throws CycleError", () => {
    const sessions = [
      session("A", { depends_on: ["B"] }),
      session("B", { depends_on: ["A"] }),
    ];
    expect(() => computeShutdownOrder(sessions)).toThrow(CycleError);
  });
});

// ---------------------------------------------------------------------------
// getTransitiveDeps
// ---------------------------------------------------------------------------

describe("getTransitiveDeps", () => {
  test("returns all transitive dependencies in topo order (excluding self)", () => {
    const sessions = [
      session("A", { depends_on: ["B"] }),
      session("B", { depends_on: ["C"] }),
      session("C"),
    ];
    const deps = getTransitiveDeps("A", sessions);
    expect(deps).toContain("B");
    expect(deps).toContain("C");
    expect(deps).not.toContain("A"); // self excluded
    // C must come before B in the result (it's deeper in the dep tree)
    expect(deps.indexOf("C")).toBeLessThan(deps.indexOf("B"));
  });

  test("returns empty array for a node with no dependencies", () => {
    const sessions = [session("solo")];
    expect(getTransitiveDeps("solo", sessions)).toEqual([]);
  });

  test("handles diamond deps — shared dep appears once", () => {
    const sessions = [
      session("A", { depends_on: ["B", "C"] }),
      session("B", { depends_on: ["D"] }),
      session("C", { depends_on: ["D"] }),
      session("D"),
    ];
    const deps = getTransitiveDeps("A", sessions);
    const dCount = deps.filter((n) => n === "D").length;
    expect(dCount).toBe(1); // deduped by visited set
    expect(deps).toContain("B");
    expect(deps).toContain("C");
    expect(deps).not.toContain("A");
  });

  test("returns empty for unknown session name", () => {
    const sessions = [session("A")];
    expect(getTransitiveDeps("ghost", sessions)).toEqual([]);
  });

  test("direct dependency only (no transitive)", () => {
    const sessions = [
      session("A", { depends_on: ["B"] }),
      session("B"),
    ];
    const deps = getTransitiveDeps("A", sessions);
    expect(deps).toEqual(["B"]);
  });
});

// ---------------------------------------------------------------------------
// getTransitiveDependents
// ---------------------------------------------------------------------------

describe("getTransitiveDependents", () => {
  test("returns all transitive dependents (excluding self)", () => {
    const sessions = [
      session("A", { depends_on: ["B"] }),
      session("B", { depends_on: ["C"] }),
      session("C"),
    ];
    // C is depended on by B; B is depended on by A
    const deps = getTransitiveDependents("C", sessions);
    expect(deps).toContain("B");
    expect(deps).toContain("A");
    expect(deps).not.toContain("C"); // self excluded
  });

  test("returns empty for a session with no dependents", () => {
    const sessions = [
      session("A", { depends_on: ["B"] }),
      session("B"),
    ];
    // A is the root — nothing depends on it
    expect(getTransitiveDependents("A", sessions)).toEqual([]);
  });

  test("returns empty for unknown session name", () => {
    const sessions = [session("A")];
    expect(getTransitiveDependents("ghost", sessions)).toEqual([]);
  });

  test("diamond: both branches are returned when both depend on same node", () => {
    const sessions = [
      session("A", { depends_on: ["B", "C"] }),
      session("B", { depends_on: ["D"] }),
      session("C", { depends_on: ["D"] }),
      session("D"),
    ];
    // D is depended on by B and C; A depends on both
    const deps = getTransitiveDependents("D", sessions);
    expect(deps).toContain("B");
    expect(deps).toContain("C");
    expect(deps).toContain("A");
    expect(deps).not.toContain("D");
  });
});
