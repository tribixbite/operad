/**
 * types-runtime.test.ts — Tests for the runtime functions in src/types.ts.
 *
 * NOTE: The vast majority of src/types.ts is pure interface/type declarations
 * with zero runtime. Only two things in the file have actual runtime:
 *
 *   1. VALID_TRANSITIONS — the state-machine edge table (object constant).
 *      Tested here for shape/completeness; the live transition mechanics are
 *      in state-transitions.test.ts via StateManager.
 *
 *   2. defaultSwitchboard() — factory for the default Switchboard value.
 *      Not tested anywhere else; tested here for default fields + isolation.
 *
 * Everything else (SessionStatus, SessionConfig, OrchestratorConfig, IpcCommand,
 * TmxState, BatterySnapshot, etc.) is pure type/interface with no generated
 * runtime code — there is nothing to test there.
 */

import { describe, test, expect } from "bun:test";
import { VALID_TRANSITIONS, defaultSwitchboard } from "../types.js";
import type { SessionStatus, Switchboard } from "../types.js";

// ---------------------------------------------------------------------------
// VALID_TRANSITIONS — shape and completeness
// ---------------------------------------------------------------------------

const ALL_STATES: SessionStatus[] = [
  "pending", "waiting", "starting", "running",
  "degraded", "failed", "stopping", "stopped",
];

describe("VALID_TRANSITIONS — structural completeness", () => {
  test("table has an entry for every SessionStatus", () => {
    for (const s of ALL_STATES) {
      expect(Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, s)).toBe(true);
    }
  });

  test("every allowed-transition target is itself a valid SessionStatus", () => {
    const validSet = new Set<string>(ALL_STATES);
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of targets as string[]) {
        expect(validSet.has(to)).toBe(true); // target must be a known status
      }
      void from; // suppress unused-var lint
    }
  });

  test("no state lists itself as an allowed target (no self-loops)", () => {
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      expect((targets as string[]).includes(from)).toBe(false);
    }
  });

  test("table has exactly 8 entries (one per status)", () => {
    expect(Object.keys(VALID_TRANSITIONS).length).toBe(ALL_STATES.length);
  });
});

describe("VALID_TRANSITIONS — specific reachability invariants", () => {
  /**
   * These are load-bearing design decisions from the architecture doc.
   * Freezing them prevents silent widening that could skip restart
   * accounting or let a stopped session start without tmux.
   */

  test("pending can reach 'waiting' (normal boot path)", () => {
    expect(VALID_TRANSITIONS.pending).toContain("waiting");
  });

  test("pending can reach 'starting' (direct-boot path that skips waiting)", () => {
    expect(VALID_TRANSITIONS.pending).toContain("starting");
  });

  test("pending can reach 'stopped' (never-enabled sessions go straight to stopped)", () => {
    expect(VALID_TRANSITIONS.pending).toContain("stopped");
  });

  test("running can reach 'degraded' (health check failure)", () => {
    expect(VALID_TRANSITIONS.running).toContain("degraded");
  });

  test("running can reach 'stopping' (graceful shutdown)", () => {
    expect(VALID_TRANSITIONS.running).toContain("stopping");
  });

  test("degraded can reach 'starting' (auto-restart)", () => {
    expect(VALID_TRANSITIONS.degraded).toContain("starting");
  });

  test("degraded can reach 'running' (post-restart reset when already alive)", () => {
    expect(VALID_TRANSITIONS.degraded).toContain("running");
  });

  test("failed can reach 'starting' (manual recovery)", () => {
    expect(VALID_TRANSITIONS.failed).toContain("starting");
  });

  test("stopped can reach 'starting' (manual restart path)", () => {
    expect(VALID_TRANSITIONS.stopped).toContain("starting");
  });

  test("stopping can ONLY reach 'stopped' (no shortcut back to running)", () => {
    expect(VALID_TRANSITIONS.stopping).toEqual(["stopped"]);
  });

  test("running cannot reach 'starting' directly (must pass through stopping or degraded)", () => {
    // If this fails, the auto-restart bypass would skip restart_count accounting.
    expect(VALID_TRANSITIONS.running).not.toContain("starting");
  });

  test("running cannot reach 'pending' (no backward jump past the start gate)", () => {
    expect(VALID_TRANSITIONS.running).not.toContain("pending");
  });

  test("waiting cannot reach 'running' directly (must go through starting)", () => {
    expect(VALID_TRANSITIONS.waiting).not.toContain("running");
  });
});

// ---------------------------------------------------------------------------
// defaultSwitchboard() — factory isolation + defaults
// ---------------------------------------------------------------------------

describe("defaultSwitchboard()", () => {
  test("returns a new object on each call (no shared reference)", () => {
    const a = defaultSwitchboard();
    const b = defaultSwitchboard();
    expect(a).not.toBe(b);
    // Mutating one must not affect the other
    a.cognitive = true;
    expect(b.cognitive).toBe(false);
  });

  test("all field is true by default", () => {
    expect(defaultSwitchboard().all).toBe(true);
  });

  test("sdkBridge is true by default", () => {
    expect(defaultSwitchboard().sdkBridge).toBe(true);
  });

  test("cognitive is false by default (opt-in subsystem)", () => {
    expect(defaultSwitchboard().cognitive).toBe(false);
  });

  test("oodaAutoTrigger is false by default (opt-in autonomous behavior)", () => {
    expect(defaultSwitchboard().oodaAutoTrigger).toBe(false);
  });

  test("memoryInjection is true by default", () => {
    expect(defaultSwitchboard().memoryInjection).toBe(true);
  });

  test("mindMeld is false by default (opt-in)", () => {
    expect(defaultSwitchboard().mindMeld).toBe(false);
  });

  test("agents dict is empty by default (no per-agent force-disable)", () => {
    const sw = defaultSwitchboard();
    expect(sw.agents).toEqual({});
    expect(Object.keys(sw.agents)).toHaveLength(0);
  });

  test("returned agents dict is mutable (callers can add per-agent overrides)", () => {
    const sw = defaultSwitchboard();
    sw.agents["my-agent"] = false;
    expect(sw.agents["my-agent"]).toBe(false);
  });

  test("satisfies the Switchboard interface shape (all required keys present)", () => {
    const sw: Switchboard = defaultSwitchboard();
    // Accessing every key — TypeScript would reject missing ones at compile time,
    // but this also confirms runtime values are actually set (not undefined).
    expect(typeof sw.all).toBe("boolean");
    expect(typeof sw.sdkBridge).toBe("boolean");
    expect(typeof sw.cognitive).toBe("boolean");
    expect(typeof sw.oodaAutoTrigger).toBe("boolean");
    expect(typeof sw.memoryInjection).toBe("boolean");
    expect(typeof sw.mindMeld).toBe("boolean");
    expect(typeof sw.agents).toBe("object");
  });
});
