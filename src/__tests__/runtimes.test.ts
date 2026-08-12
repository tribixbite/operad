/**
 * runtimes.test.ts — Pin down the SessionRuntime adapter contract.
 *
 * The adapters in `src/runtimes/*.ts` are the boundary between operad's
 * generic agent lifecycle (tmux create → wait for ready → send "go")
 * and per-tool quirks (which binary to run, what an idle prompt looks
 * like). Regressions here would silently break startup for one runtime
 * while leaving the others working.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionConfig } from "../types.js";
import { getRuntime, listRuntimes } from "../runtimes/index.js";
import { claudeRuntime } from "../runtimes/claude.js";
import { opencodeRuntime } from "../runtimes/opencode.js";
import { codexRuntime } from "../runtimes/codex.js";

/**
 * Create a throwaway Claude conversation JSONL so the claude adapter's
 * "does this conversation still exist?" guard sees a real file. Mirrors
 * claude-session.ts's manglePath + PROJECTS_DIR layout. Returns the
 * project path to feed into the SessionConfig and a cleanup fn.
 */
function seedConversation(uuid: string): { projectPath: string; cleanup: () => void } {
  // Unique project path so the mangled dir can't collide with a real one.
  const projectPath = `/tmp/operad-runtime-test-${uuid}`;
  const mangled = projectPath.replace(/[^a-zA-Z0-9]/g, "-");
  // Resolve home the SAME way claude-session.ts does (process.env.HOME ||
  // homedir()) so the fixture lands exactly where the adapter looks — even if
  // a sibling test file left a global node:os mock or $HOME override in place.
  const dir = join(process.env.HOME || homedir(), ".claude", "projects", mangled);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uuid}.jsonl`), `{"type":"summary"}\n`);
  return { projectPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const cleanups: Array<() => void> = [];
afterAll(() => { for (const c of cleanups) c(); });

function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    name: "svc",
    type: "claude",
    command: undefined,
    path: "/tmp/proj",
    session_id: undefined,
    auto_go: false,
    priority: 50,
    depends_on: [],
    headless: false,
    env: {},
    health: undefined,
    max_restarts: 3,
    restart_backoff_s: 5,
    enabled: true,
    bare: false,
    ...overrides,
  } as SessionConfig;
}

describe("runtime registry", () => {
  test("getRuntime returns the matching adapter for known agent types", () => {
    expect(getRuntime("claude")?.id).toBe("claude");
    expect(getRuntime("opencode")?.id).toBe("opencode");
    expect(getRuntime("codex")?.id).toBe("codex");
  });

  test("getRuntime returns null for non-agent types", () => {
    expect(getRuntime("daemon")).toBeNull();
    expect(getRuntime("service")).toBeNull();
  });

  test("listRuntimes enumerates exactly the registered agent runtimes", () => {
    const ids = listRuntimes().map((r) => r.id).sort();
    expect(ids).toEqual(["claude", "codex", "opencode"]);
  });
});

describe("claude adapter", () => {
  test("uses `cc` when no session_id is set", () => {
    expect(claudeRuntime.startupCommand(makeConfig())).toBe("cc");
  });

  test("emits --resume with a valid UUID when the conversation exists", () => {
    const uuid = "11a565bd-b74e-4e5c-a563-7032963954bf";
    const { projectPath, cleanup } = seedConversation(uuid);
    cleanups.push(cleanup);
    const cmd = claudeRuntime.startupCommand(makeConfig({ session_id: uuid, path: projectPath }));
    expect(cmd).toBe(`claude --resume ${uuid} --dangerously-skip-permissions`);
  });

  test("falls back to `cc` when the conversation no longer exists on disk", () => {
    // Stale session_id (resumed on another machine / history pruned) —
    // `claude --resume` would abort with "No conversation found", so the
    // adapter must start fresh instead.
    const uuid = "22b676ce-c85f-4f6d-b674-8143a74a65cf";
    const cmd = claudeRuntime.startupCommand(
      makeConfig({ session_id: uuid, path: "/tmp/operad-runtime-test-nonexistent" }),
    );
    expect(cmd).toBe("cc");
  });

  test("falls back to `cc` when session_id is malformed (defence in depth)", () => {
    // Guard repeats here even though the registry strips on load — any
    // future caller that builds a SessionConfig in memory has to pass
    // through this path before send-keys.
    const cmd = claudeRuntime.startupCommand(makeConfig({ session_id: "not-a-uuid; rm -rf /" }));
    expect(cmd).toBe("cc");
  });

  test("ready patterns include the canonical Claude prompt suffix", () => {
    const matches = claudeRuntime.readyPatterns.some((p) => p.test("> "));
    expect(matches).toBe(true);
  });
});

/**
 * Readiness is matched against a WHOLE tmux pane capture, not a single line.
 *
 * The original patterns (`/>\s*$/`, `/\$\s*$/`, `/\?\s*$/`) had no `m` flag,
 * so `$` anchored to the end of the entire capture — and every real TUI draws
 * a footer and trailing blank lines below its input row. Captures taken from
 * three live, idle Claude sessions matched none of them, so each start burned
 * the full 60 s timeout and `auto_go` never sent its "go" (sendGoToSession
 * skips the send unless readiness is positively detected).
 *
 * The fixtures below are trimmed from real `tmux capture-pane` output.
 */
describe("readiness detection against realistic pane captures", () => {
  const isReady = (rt: { readyPatterns: readonly RegExp[] }, pane: string): boolean =>
    rt.readyPatterns.some((p) => p.test(pane));

  // Real Claude Code TUI: box rule, U+276F prompt row, mode footer, blank lines.
  const CLAUDE_IDLE_PANE = [
    "  ⎿  Shell cwd was reset to",
    "     /home/u/git/thing",
    "─────────────────── can you update yt-dlp (Branch 2) ──",
    "❯",
    "────────────────────────────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for …",
    "",
    "",
  ].join("\n");

  const CLAUDE_FRESH_PANE = ["╭────────────╮", "│ >          │", "╰────────────╯", "  ? for shortcuts", ""].join("\n");

  test("an idle Claude pane is detected as ready", () => {
    expect(isReady(claudeRuntime, CLAUDE_IDLE_PANE)).toBe(true);
  });

  test("a freshly-drawn Claude input box is detected as ready", () => {
    expect(isReady(claudeRuntime, CLAUDE_FRESH_PANE)).toBe(true);
  });

  test("a trailing footer below the prompt does not defeat the anchor", () => {
    // The specific regression: content after the prompt row used to make
    // every `$`-anchored pattern miss.
    expect(isReady(claudeRuntime, "❯\nsome footer line\n")).toBe(true);
  });

  test("mid-startup output is NOT reported ready", () => {
    for (const pane of [
      "Loading…\n",
      "npm install\nadded 42 packages in 3s\n",
      "Do you trust the files in this folder?\n",
    ]) {
      expect(isReady(claudeRuntime, pane)).toBe(false);
    }
  });

  test("a line that merely ends in '>' is not a prompt", () => {
    // Adding the `m` flag to a bare `/>\s*$/` would have matched any line of
    // output closing an HTML/XML tag — ready before the TUI even exists.
    expect(isReady(claudeRuntime, '  <div class="x">\n')).toBe(false);
  });

  for (const rt of [opencodeRuntime, codexRuntime]) {
    test(`${rt.id}: a prompt row above a footer is detected as ready`, () => {
      expect(isReady(rt, "›\n  status footer here\n\n")).toBe(true);
    });

    test(`${rt.id}: plain startup noise is not ready`, () => {
      expect(isReady(rt, "scanning workspace…\nindexed 900 files\n")).toBe(false);
    });
  }
});

describe("opencode adapter", () => {
  test("startup command is just `opencode` — resumption is by cwd", () => {
    expect(opencodeRuntime.startupCommand(makeConfig({ type: "opencode" }))).toBe("opencode");
  });

  test("ignores session_id (OpenCode has no UUID resume)", () => {
    expect(
      opencodeRuntime.startupCommand(
        makeConfig({ type: "opencode", session_id: "11a565bd-b74e-4e5c-a563-7032963954bf" }),
      ),
    ).toBe("opencode");
  });

  test("readyTimeoutMs is bumped above the operad default", () => {
    expect(opencodeRuntime.readyTimeoutMs).toBeGreaterThan(60_000);
  });
});

describe("codex adapter", () => {
  test("startup command is just `codex` — resumption is by cwd", () => {
    expect(codexRuntime.startupCommand(makeConfig({ type: "codex" }))).toBe("codex");
  });

  test("ignores session_id (Codex has no UUID resume)", () => {
    expect(
      codexRuntime.startupCommand(
        makeConfig({ type: "codex", session_id: "11a565bd-b74e-4e5c-a563-7032963954bf" }),
      ),
    ).toBe("codex");
  });

  test("readyTimeoutMs is bumped to cover first-run OAuth pause", () => {
    expect(codexRuntime.readyTimeoutMs).toBeGreaterThan(60_000);
  });
});
