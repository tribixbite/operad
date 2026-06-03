/**
 * jsonl-binder.test.ts — Pin down the session ↔ conversation pairing.
 *
 * `pairSessionsToConversations` is the pure core of the live-JSONL binder
 * that disambiguates two operad sessions sharing one project path. It must:
 *   - keep sticky bindings stable across polls (no flapping),
 *   - bind resumed sessions to their resume id,
 *   - pair fresh sessions to the conversations they created in start order,
 *   - never bind one conversation to two sessions.
 */
import { describe, test, expect } from "bun:test";
import {
  pairSessionsToConversations,
  type BindableSession,
  type ConversationCandidate,
} from "../claude-session.js";

const t = (s: number) => s * 1000; // seconds → ms for readability

describe("pairSessionsToConversations", () => {
  test("two fresh sessions bind to distinct conversations in start order", () => {
    const sessions: BindableSession[] = [
      { name: "proj", startedAtMs: t(100) },
      { name: "proj-2", startedAtMs: t(200) },
    ];
    // Two conversations created after each session's start.
    const candidates: ConversationCandidate[] = [
      { id: "conv-a", startMs: t(105) },
      { id: "conv-b", startMs: t(205) },
    ];
    const out = pairSessionsToConversations(sessions, candidates, {});
    // Earliest session → earliest conversation; no double-binding.
    expect(out["proj"]).toBe("conv-a");
    expect(out["proj-2"]).toBe("conv-b");
    expect(new Set(Object.values(out)).size).toBe(2);
  });

  test("sticky binding survives re-pairing and the other session takes the rest", () => {
    const sessions: BindableSession[] = [
      { name: "proj", startedAtMs: t(100) },
      { name: "proj-2", startedAtMs: t(200) },
    ];
    const candidates: ConversationCandidate[] = [
      { id: "conv-a", startMs: t(105) },
      { id: "conv-b", startMs: t(205) },
    ];
    // Cross-bound from a prior poll (proj→conv-b, proj-2→conv-a). Sticky
    // bindings ignore the grace window, so both must be preserved exactly
    // rather than flapping back to naive start-order pairing.
    const out = pairSessionsToConversations(sessions, candidates, {
      proj: "conv-b",
      "proj-2": "conv-a",
    });
    expect(out["proj"]).toBe("conv-b");
    expect(out["proj-2"]).toBe("conv-a");
    expect(new Set(Object.values(out)).size).toBe(2);
  });

  test("a stale sticky binding (file gone) is dropped and re-paired", () => {
    const sessions: BindableSession[] = [{ name: "proj", startedAtMs: t(100) }];
    const candidates: ConversationCandidate[] = [{ id: "conv-new", startMs: t(110) }];
    const out = pairSessionsToConversations(sessions, candidates, { proj: "conv-deleted" });
    expect(out["proj"]).toBe("conv-new");
  });

  test("resume sessions bind to their resume id, not a fresh conversation", () => {
    const sessions: BindableSession[] = [
      { name: "resumed", startedAtMs: t(300), resumeId: "conv-old" },
      { name: "fresh", startedAtMs: t(300) },
    ];
    const candidates: ConversationCandidate[] = [
      { id: "conv-old", startMs: t(10) },   // pre-existing, resumed
      { id: "conv-fresh", startMs: t(305) }, // created by `fresh`
    ];
    const out = pairSessionsToConversations(sessions, candidates, {});
    expect(out["resumed"]).toBe("conv-old");
    expect(out["fresh"]).toBe("conv-fresh");
  });

  test("a session whose `cc` hasn't created a conversation yet stays unbound", () => {
    const sessions: BindableSession[] = [
      { name: "proj", startedAtMs: t(100) },
      { name: "proj-2", startedAtMs: t(500) }, // just started, no convo yet
    ];
    const candidates: ConversationCandidate[] = [{ id: "conv-a", startMs: t(105) }];
    const out = pairSessionsToConversations(sessions, candidates, {});
    expect(out["proj"]).toBe("conv-a");
    expect("proj-2" in out).toBe(false); // nothing to bind yet
  });

  test("does not bind a session to a conversation created before it started", () => {
    // Only an old conversation exists; the freshly-started session must not
    // grab it (that's another session's history).
    const sessions: BindableSession[] = [{ name: "proj", startedAtMs: t(1000) }];
    const candidates: ConversationCandidate[] = [{ id: "conv-old", startMs: t(10) }];
    const out = pairSessionsToConversations(sessions, candidates, {});
    expect("proj" in out).toBe(false);
  });

  test("grace window absorbs minor clock skew between start and first entry", () => {
    // Conversation first-entry stamped 30s before uptime_start (cc launched,
    // ASCII banner timestamp slightly precedes the running transition).
    const sessions: BindableSession[] = [{ name: "proj", startedAtMs: t(1000) }];
    const candidates: ConversationCandidate[] = [{ id: "conv", startMs: t(970) }];
    const out = pairSessionsToConversations(sessions, candidates, {}, 60_000);
    expect(out["proj"]).toBe("conv");
  });
});
