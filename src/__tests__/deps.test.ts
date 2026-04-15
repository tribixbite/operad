/**
 * deps.test.ts — Unit tests for dependency graph topological sort
 *
 * Tests computeStartupOrder() and CycleError from deps.ts.
 * Uses minimal SessionConfig stubs (cast via `as any`) since we only
 * need the fields relevant to dependency ordering.
 */

import { describe, test, expect } from "bun:test";
import { computeStartupOrder, CycleError } from "../deps.js";
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
});
