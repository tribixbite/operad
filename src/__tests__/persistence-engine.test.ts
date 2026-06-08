/**
 * persistence-engine.test.ts — In-process tests for PersistenceEngine.
 *
 * PersistenceEngine handles daily agent snapshots (self-deduplicating) and
 * idle-gated memory consolidation. We drive both against a real in-temp-dir
 * MemoryDb and assert the gating logic + side effects (broadcast) without a
 * live daemon clock.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PersistenceEngine } from "../persistence.js";
import { makeFakeContext, makeAgent, type FakeContext } from "./helpers/fake-context.js";

let fc: FakeContext;
afterEach(() => fc.cleanup());

describe("PersistenceEngine — maybeDailySnapshot", () => {
  beforeEach(async () => {
    fc = await makeFakeContext({
      withDb: true,
      agentConfigs: [makeAgent("optimizer"), makeAgent("ideator", { enabled: false })],
    });
  });

  test("no-op when memoryDb is absent", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: false, agentConfigs: [makeAgent("optimizer")] });
    const eng = new PersistenceEngine(fc.ctx);
    // Should not throw despite null db
    expect(() => eng.maybeDailySnapshot()).not.toThrow();
  });

  test("writes a snapshot for each enabled agent and dedups within the day", () => {
    // Inject a hermetic temp snapshot dir so we never touch real ~/.local/share
    const snapDir = join(fc.dir, "snapshots");
    const eng = new PersistenceEngine(fc.ctx, snapDir);
    eng.maybeDailySnapshot();
    // The enabled agent's snapshot dir should now exist
    expect(existsSync(join(snapDir, "optimizer"))).toBe(true);
    // Disabled agent is skipped
    expect(existsSync(join(snapDir, "ideator"))).toBe(false);

    // Second call same day is a no-op (lastSnapshotDate guard) — must not throw
    expect(() => eng.maybeDailySnapshot()).not.toThrow();
  });
});

describe("PersistenceEngine — maybeConsolidate", () => {
  beforeEach(async () => {
    fc = await makeFakeContext({
      withDb: true,
      agentConfigs: [makeAgent("optimizer")],
    });
  });

  test("no-op when memoryDb is absent", async () => {
    fc.cleanup();
    fc = await makeFakeContext({ withDb: false });
    const eng = new PersistenceEngine(fc.ctx);
    expect(() => eng.maybeConsolidate()).not.toThrow();
  });

  test("skips consolidation when the system is not idle (recent activity)", () => {
    // updateLastActivityEpoch sets activity to now → idleSeconds ≈ 0 → skip
    fc.ctx.updateLastActivityEpoch();
    const eng = new PersistenceEngine(fc.ctx);
    eng.maybeConsolidate();
    expect(fc.broadcasts.some((b) => b.type === "consolidation")).toBe(false);
  });

  test("runs consolidation and broadcasts when idle long enough", () => {
    // Force a long idle window by overriding getLastActivityEpoch far in the past
    const longAgo = Math.floor(Date.now() / 1000) - 3600;
    fc = { ...fc };
    (fc.ctx as { getLastActivityEpoch: () => number }).getLastActivityEpoch = () => longAgo;
    const eng = new PersistenceEngine(fc.ctx);
    eng.maybeConsolidate();
    expect(fc.broadcasts.some((b) => b.type === "consolidation")).toBe(true);
  });
});
