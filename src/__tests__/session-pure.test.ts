/**
 * session-pure.test.ts
 *
 * Tests for the pure, IO-free helpers extracted from session.ts:
 *   - formatTmuxTarget()     — constructs the `=name` / `=name:` sigil correctly
 *   - classifyPaneLiveness() — reads a session's pane liveness out of tmux's
 *     `list-panes` output, which is what tells a deliberate exit from a crash
 *
 * Context: tmux has two target namespaces with different sigil requirements.
 *
 *   target-session subcommands (has-session, kill-session, list-clients,
 *   switch-client): accept `=name` for exact match.
 *
 *   target-pane subcommands (capture-pane, send-keys, list-panes,
 *   select-window): need `=name:` (trailing colon resolves to the session's
 *   current window → current pane). Without the colon, tmux errors with
 *   "can't find pane".
 *
 * This distinction is documented in CLAUDE.md under "tmux exact-match sigil"
 * and is the root cause of a class of subtle "can't find pane" bugs.
 *
 * All of session.ts's IO-bound functions (createSession, stopSession,
 * capturePane, sendKeys, …) delegate to tmux/spawnSync — they're not
 * tested here. Only the pure formatting helper is tested.
 */

import { describe, test, expect } from "bun:test";
import { formatTmuxTarget, classifyPaneLiveness, agentSessionsToAdopt } from "../session.js";

// ---------------------------------------------------------------------------
// formatTmuxTarget
// ---------------------------------------------------------------------------

describe("formatTmuxTarget", () => {
  // -- Basic session-level targets (has-session, kill-session) ----------------

  test("plain name → =name for session subcommands", () => {
    expect(formatTmuxTarget("myapp")).toBe("=myapp");
  });

  test("forPane=false (default) → no trailing colon", () => {
    expect(formatTmuxTarget("alpha", false)).toBe("=alpha");
  });

  test("forPane=true → =name: with trailing colon for pane subcommands", () => {
    expect(formatTmuxTarget("myapp", true)).toBe("=myapp:");
  });

  // -- Realistic session names ------------------------------------------------

  test("hyphenated session name is preserved", () => {
    expect(formatTmuxTarget("my-project-api")).toBe("=my-project-api");
    expect(formatTmuxTarget("my-project-api", true)).toBe("=my-project-api:");
  });

  test("numeric suffix in session name is preserved", () => {
    expect(formatTmuxTarget("session-2")).toBe("=session-2");
    expect(formatTmuxTarget("session-2", true)).toBe("=session-2:");
  });

  test("single-character session name", () => {
    expect(formatTmuxTarget("x")).toBe("=x");
    expect(formatTmuxTarget("x", true)).toBe("=x:");
  });

  // -- Sigil correctness (the key regression guard) ---------------------------

  test("session target never ends with colon", () => {
    const target = formatTmuxTarget("foo");
    expect(target.endsWith(":")).toBe(false);
  });

  test("pane target always ends with colon", () => {
    const target = formatTmuxTarget("foo", true);
    expect(target.endsWith(":")).toBe(true);
  });

  test("both forms always start with =", () => {
    expect(formatTmuxTarget("abc").startsWith("=")).toBe(true);
    expect(formatTmuxTarget("abc", true).startsWith("=")).toBe(true);
  });

  test("pane target starts with = and ends with : (full sigil contract)", () => {
    const t = formatTmuxTarget("some-session", true);
    expect(t).toBe("=some-session:");
    expect(t.startsWith("=")).toBe(true);
    expect(t.endsWith(":")).toBe(true);
    // The name in the middle must match exactly
    expect(t.slice(1, -1)).toBe("some-session");
  });

  test("session target has = prefix and name verbatim", () => {
    const t = formatTmuxTarget("some-session");
    expect(t).toBe("=some-session");
    expect(t.slice(1)).toBe("some-session");
  });

  // -- Consistency across forPane values -------------------------------------

  test("forPane=false produces strictly shorter result than forPane=true", () => {
    const sess = formatTmuxTarget("foo", false);
    const pane = formatTmuxTarget("foo", true);
    expect(pane.length).toBe(sess.length + 1);
  });

  test("pane target is the session target plus exactly ':'", () => {
    const name = "operad";
    expect(formatTmuxTarget(name, true)).toBe(formatTmuxTarget(name, false) + ":");
  });

  // -- Edge cases: unusual-but-valid names -----------------------------------

  test("long session name is preserved verbatim", () => {
    const long = "a".repeat(50);
    expect(formatTmuxTarget(long)).toBe(`=${long}`);
    expect(formatTmuxTarget(long, true)).toBe(`=${long}:`);
  });

  test("underscore in name (non-standard but passable) is preserved", () => {
    // operad names use [a-z0-9-] but the formatter must not strip underscores
    expect(formatTmuxTarget("my_session")).toBe("=my_session");
  });

  test("all-numeric name is preserved", () => {
    expect(formatTmuxTarget("12345")).toBe("=12345");
    expect(formatTmuxTarget("12345", true)).toBe("=12345:");
  });
});

// ---------------------------------------------------------------------------
// classifyPaneLiveness
// ---------------------------------------------------------------------------
// This decides whether a session that stopped running anything gets
// restarted. Reading every dead pane as a crash meant operad reopened
// sessions the user had just exited; reading every dead pane as an exit
// would give up the OOM resilience the supervisor exists for.

describe("classifyPaneLiveness", () => {
  test("any live pane means the session is alive", () => {
    expect(classifyPaneLiveness("0||").state).toBe("alive");
    expect(classifyPaneLiveness("1|0|\n0||").state).toBe("alive");
  });

  test("no rows means the session is gone", () => {
    expect(classifyPaneLiveness("").state).toBe("missing");
    expect(classifyPaneLiveness("\n  \n").state).toBe("missing");
  });

  test("a dead pane with a zero status is an exit", () => {
    const r = classifyPaneLiveness("1|0|");
    expect(r.state).toBe("exited");
    expect(r.state === "exited" && r.status).toBe(0);
  });

  test("a dead pane with empty status fields is still an exit", () => {
    // tmux 3.5a on Termux reports `pane_dead` but leaves the status and
    // signal fields empty, so "dead and nothing says it was killed" has to
    // read as an exit rather than as an unknown.
    expect(classifyPaneLiveness("1||").state).toBe("exited");
  });

  test("a signalled pane is a crash", () => {
    const r = classifyPaneLiveness("1||9");
    expect(r.state).toBe("killed");
    expect(r.state === "killed" && r.signal).toBe(9);
  });

  test("a named signal is a crash too", () => {
    // Some builds report the signal by name.
    const r = classifyPaneLiveness("1||KILL");
    expect(r.state).toBe("killed");
  });

  test("a non-zero exit status is a crash", () => {
    const r = classifyPaneLiveness("1|7|");
    expect(r.state).toBe("killed");
    expect(r.state === "killed" && r.status).toBe(7);
  });

  test("an empty middle field does not shift the signal into the status", () => {
    // With a space-separated format, a pane killed by signal 9 and no status
    // arrives as "1  9" — the empty field collapses and the signal reads as
    // an exit status, flipping the restart decision. The pipe-separated
    // format keeps the positions.
    const r = classifyPaneLiveness("1||9");
    expect(r.state).toBe("killed");
    expect(r.state === "killed" && r.signal).toBe(9);
    expect(r.state === "killed" && r.status).toBeUndefined();
  });

  test("one killed pane among exited ones is a crash", () => {
    expect(classifyPaneLiveness("1|0|\n1||9").state).toBe("killed");
  });
});

// ---------------------------------------------------------------------------
// classifyPaneLiveness — panes run under the exit recorder
// ---------------------------------------------------------------------------
// Rows are `dead|status|signal|server_pid|pane_id`. A pane started under the
// recorder has a record file: `running` while its shell runs, then the
// shell's exit status. That record, when present, overrides tmux's own
// status fields (which hold the wrapper's status, always 0). The lookup is
// injected so no filesystem is involved.

describe("classifyPaneLiveness with exit records", () => {
  const row = (dead: 0 | 1, pane: string) => `${dead}|0||4436|${pane}`;
  const records = (map: Record<string, number | "running">) => (key: string | null) =>
    key !== null && key in map ? map[key] : null;

  test("a recorded clean exit is an exit", () => {
    expect(classifyPaneLiveness(row(1, "%5"), records({ "4436-5": 0 }))).toEqual({ state: "exited", status: 0 });
  });

  test("a recorded non-zero `exit 3` is still the user's exit", () => {
    expect(classifyPaneLiveness(row(1, "%5"), records({ "4436-5": 3 }))).toEqual({ state: "exited", status: 3 });
  });

  test("a recorded SIGKILL is a crash — the case tmux could not report", () => {
    expect(classifyPaneLiveness(row(1, "%5"), records({ "4436-5": 137 }))).toEqual({ state: "killed", status: 137, signal: 9 });
  });

  test("a dead pane whose record still says `running` lost its recorder too: a crash", () => {
    // The wrapper only fails to overwrite `running` when it is killed
    // itself, so that is evidence of a kill, never of an exit.
    expect(classifyPaneLiveness(row(1, "%5"), records({ "4436-5": "running" })).state).toBe("killed");
  });

  test("a live pane is alive regardless of its record", () => {
    expect(classifyPaneLiveness(row(0, "%5"), records({ "4436-5": 0 })).state).toBe("alive");
  });

  test("every pane is judged by its own record", () => {
    const out = [row(1, "%5"), row(1, "%6")].join("\n");
    expect(classifyPaneLiveness(out, records({ "4436-5": 0, "4436-6": 137 })).state).toBe("killed");
    expect(classifyPaneLiveness(out, records({ "4436-5": 0, "4436-6": 0 })).state).toBe("exited");
  });

  test("a pane without any record (started before the recorder) keeps the tmux-field reading", () => {
    // An adopted session's original pane has no recorder; its windows
    // opened later do. Each is read its own way.
    expect(classifyPaneLiveness("1|||4436|%5", records({})).state).toBe("exited");
    expect(classifyPaneLiveness("1||9|4436|%5", records({})).state).toBe("killed");
    expect(classifyPaneLiveness([row(1, "%5"), "1|||4436|%7"].join("\n"), records({ "4436-5": 0 })).state).toBe("exited");
  });
});

// ---------------------------------------------------------------------------
// agentSessionsToAdopt — which running tmux sessions get the agent options
// at daemon start
// ---------------------------------------------------------------------------
// Boot adoption used to only mark already-running sessions "running"; their
// tmux options were never touched, so sessions that predated the exit
// handling never kept a dead pane and a manual exit was still read as a
// crash. Every configured, tmux-hosted agent session that is alive gets the
// options; services, bare sessions and sessions not in tmux do not.

describe("agentSessionsToAdopt", () => {
  const cfg = (name: string, type: string, bare = false) =>
    ({ name, type, bare }) as unknown as import("../types.js").SessionConfig;

  test("alive agent sessions are adopted; services, bare and absent ones are not", () => {
    const configs = [
      cfg("a", "claude"), cfg("b", "agy"), cfg("svc", "service"),
      cfg("bare", "claude", true), cfg("gone", "codex"),
    ];
    const alive = new Set(["a", "b", "svc", "bare", "unconfigured"]);
    expect(agentSessionsToAdopt(configs, alive)).toEqual(["a", "b"]);
  });
});
