/**
 * session-pure.test.ts
 *
 * Tests for the pure, IO-free helpers extracted from session.ts:
 *   - formatTmuxTarget()  — constructs the `=name` / `=name:` sigil correctly
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
import { formatTmuxTarget } from "../session.js";

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
