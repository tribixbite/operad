/**
 * conversation-locators.test.ts — finding the conversation an agy or Codex
 * session was using, so a restore resumes that exact conversation instead of
 * "the project's most recent".
 *
 * Fixtures mirror what the tools actually write (inspected on-device):
 *  - Antigravity: `~/.gemini/antigravity-cli/conversation_summaries.db`, one
 *    row per conversation with a JSON array of `file://` workspace URIs and
 *    a nanosecond-precision `last_modified_time`; subagent conversations
 *    carry `parent_conversation_id` / `nesting_depth`.
 *  - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, whose first line
 *    is a `session_meta` record with `id`, `cwd`, and — for subagent
 *    threads — `parent_thread_id`. A resumed session keeps appending to its
 *    original file, so only mtime says it is current.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseAgyTimestamp,
  latestAgyConversation,
  latestCodexSession,
} from "../runtimes/conversations.js";
import { agyRuntime } from "../runtimes/agy.js";
import { codexRuntime } from "../runtimes/codex.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "operad-conv-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("parseAgyTimestamp", () => {
  test("reads Go's nanosecond timestamps", () => {
    expect(parseAgyTimestamp("2026-11-10 15:27:02.17870896+00:00")).toBe(Date.UTC(2026, 10, 10, 15, 27, 2, 178));
  });

  test("honours a non-UTC offset", () => {
    expect(parseAgyTimestamp("2026-11-10 10:00:00-05:00")).toBe(Date.UTC(2026, 10, 10, 15, 0, 0));
  });

  test("Go's zero time and garbage are not timestamps", () => {
    expect(parseAgyTimestamp("0001-01-01 00:00:00+00:00")).toBeNull();
    expect(parseAgyTimestamp("yesterday")).toBeNull();
  });
});

describe("latestAgyConversation", () => {
  const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
  const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "+00:00");

  function makeDb(rows: Array<{ id: string; ws: string[]; at: number; parent?: string; depth?: number }>): string {
    const path = join(root, "conversation_summaries.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY, workspace_uris text NOT NULL,
      last_modified_time datetime NOT NULL, parent_conversation_id text NOT NULL DEFAULT '',
      nesting_depth integer NOT NULL DEFAULT 0)`);
    const ins = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)");
    for (const r of rows) {
      ins.run(r.id, JSON.stringify(r.ws.map((p) => `file://${p}`)), iso(r.at), r.parent ?? "", r.depth ?? 0);
    }
    db.close();
    return path;
  }

  test("newest top-level conversation for the project", () => {
    const db = makeDb([
      { id: "old", ws: ["/p"], at: T0 },
      { id: "new", ws: ["/p"], at: T0 + 60_000 },
      { id: "other", ws: ["/q"], at: T0 + 120_000 },
      { id: "sub", ws: ["/p"], at: T0 + 180_000, parent: "new", depth: 1 },
    ]);
    expect(latestAgyConversation("/p", 0, db)).toBe("new");
  });

  test("a trailing slash on the project path still matches", () => {
    const db = makeDb([{ id: "a", ws: ["/p"], at: T0 }]);
    expect(latestAgyConversation("/p/", 0, db)).toBe("a");
  });

  test("a conversation not touched since `sinceMs` is not this run's", () => {
    const db = makeDb([{ id: "a", ws: ["/p"], at: T0 }]);
    expect(latestAgyConversation("/p", T0 + 1, db)).toBeNull();
    expect(latestAgyConversation("/p", T0, db)).toBe("a");
  });

  test("matches any of a multi-root workspace", () => {
    const db = makeDb([{ id: "a", ws: ["/q", "/p"], at: T0 }]);
    expect(latestAgyConversation("/p", 0, db)).toBe("a");
  });

  test("no database → null, not an error", () => {
    expect(latestAgyConversation("/p", 0, join(root, "missing.db"))).toBeNull();
  });

  test("reads without writing: the tool's database is never modified", () => {
    const db = makeDb([{ id: "a", ws: ["/p"], at: T0 }]);
    const before = Bun.file(db).size;
    latestAgyConversation("/p", 0, db);
    expect(Bun.file(db).size).toBe(before);
    // A read-write open in WAL mode would have created these.
    expect(Bun.file(`${db}-wal`).size).toBe(0);
  });
});

describe("latestCodexSession", () => {
  const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);

  function rollout(day: string, file: string, meta: Record<string, unknown>, mtimeMs: number, extra = ""): void {
    const dir = join(root, ...day.split("/"));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, file);
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: meta }) + "\n" + extra);
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  }

  test("newest top-level session for the cwd, by last write", () => {
    rollout("2026/11/01", "rollout-a.jsonl", { id: "aaa", cwd: "/p" }, T0 + 50_000);
    rollout("2026/11/09", "rollout-b.jsonl", { id: "bbb", cwd: "/p" }, T0 + 10_000);
    // A session resumed today keeps writing to its November 1st file: its
    // mtime, not its directory, says it is the current one.
    expect(latestCodexSession("/p", 0, root)).toBe("aaa");
  });

  test("subagent threads and other projects are skipped", () => {
    rollout("2026/11/10", "rollout-top.jsonl", { id: "top", cwd: "/p" }, T0);
    rollout("2026/11/10", "rollout-sub.jsonl", { id: "sub", cwd: "/p", parent_thread_id: "top" }, T0 + 5_000);
    rollout("2026/11/10", "rollout-q.jsonl", { id: "qqq", cwd: "/q" }, T0 + 9_000);
    expect(latestCodexSession("/p", 0, root)).toBe("top");
  });

  test("a session not written since `sinceMs` is not this run's", () => {
    rollout("2026/11/10", "rollout-a.jsonl", { id: "aaa", cwd: "/p" }, T0);
    expect(latestCodexSession("/p", T0 + 1000, root)).toBeNull();
  });

  test("a malformed first line is skipped, not fatal", () => {
    mkdirSync(join(root, "2026", "11", "10"), { recursive: true });
    writeFileSync(join(root, "2026", "11", "10", "rollout-bad.jsonl"), "{not json\n");
    rollout("2026/11/10", "rollout-ok.jsonl", { id: "ok", cwd: "/p" }, T0);
    expect(latestCodexSession("/p", 0, root)).toBe("ok");
  });

  test("no sessions directory → null", () => {
    expect(latestCodexSession("/p", 0, join(root, "nope"))).toBeNull();
  });
});

describe("adapters expose their locator", () => {
  test("agy and codex can say which conversation a session is on", () => {
    expect(typeof agyRuntime.latestConversationId).toBe("function");
    expect(typeof codexRuntime.latestConversationId).toBe("function");
  });
});
