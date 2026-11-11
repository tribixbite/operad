/**
 * conversations.ts — find the conversation an agy or Codex session is on.
 *
 * operad restores a session by replaying its runtime's startup command. With
 * no conversation id that command can only say "resume the project's most
 * recent conversation" (`agy --continue`, `codex resume --last`), which is
 * the wrong one as soon as the user has run the same tool in the same
 * project anywhere else since. Recording the id while the session runs lets
 * the restore name the conversation exactly, as Claude sessions already do.
 *
 * Each tool keeps an index operad can read without the tool's cooperation:
 *
 *  - Antigravity: `~/.gemini/antigravity-cli/conversation_summaries.db`, one
 *    row per conversation with its workspace URIs and last-modified time.
 *    Opened strictly read-only — the database belongs to agy.
 *  - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, one file per
 *    session whose first line (`session_meta`) records its id and cwd. A
 *    resumed session appends to its ORIGINAL file, so recency comes from
 *    mtime, never from the date directory.
 *
 * Both locators answer "the newest top-level conversation for this project
 * that was written to at or after `sinceMs`" — the caller passes the time it
 * first saw the agent running in the pane, so a conversation this run never
 * touched is never claimed. Subagent conversations are excluded: resuming
 * one would drop the user into a child thread.
 *
 * Known limit: two panes running the same tool in the same project at once
 * both see the same newest conversation. The tools expose no pane→
 * conversation mapping, and this is no worse than `--continue`, which is
 * what restore used before.
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { queryReadonly } from "../sqlite-readonly.js";

/** Default location of Antigravity's conversation index. */
export function defaultAgySummariesDb(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "conversation_summaries.db");
}

/** Default root of Codex's session rollouts. */
export function defaultCodexSessionsDir(): string {
  return join(homedir(), ".codex", "sessions");
}

/** Compare project paths independent of a trailing slash. */
function normaliseProjectPath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/**
 * Parse Antigravity's timestamps — Go's `time.Time` text form, e.g.
 * `2026-11-10 15:27:02.17870896+00:00` — to epoch ms. JS `Date.parse` does
 * not accept the space separator or more than three fractional digits on
 * every engine, so the shape is normalised first. Go's zero time
 * (`0001-01-01…`, used for "never") and anything unparseable are null.
 */
export function parseAgyTimestamp(raw: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, date, time, frac = "", zone] = m;
  if (date.startsWith("0001-")) return null;
  const ms = (frac + "000").slice(0, 3);
  const parsed = Date.parse(`${date}T${time}.${ms}${zone}`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Workspace URIs of an Antigravity row as filesystem paths. */
function agyWorkspacePaths(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const uris = JSON.parse(raw) as unknown;
    if (!Array.isArray(uris)) return [];
    const paths: string[] = [];
    for (const uri of uris) {
      if (typeof uri !== "string" || !uri.startsWith("file:")) continue;
      try { paths.push(normaliseProjectPath(fileURLToPath(uri))); } catch { /* not a file URI */ }
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * Newest top-level Antigravity conversation for `projectPath` modified at
 * or after `sinceMs`, or null.
 *
 * Rows are filtered in JS rather than with `LIKE` on `workspace_uris`, so a
 * project path that is a prefix of another (`/p` vs `/p2`) or that needs URI
 * escaping can't match the wrong row.
 */
export function latestAgyConversation(
  projectPath: string,
  sinceMs: number,
  dbPath: string = defaultAgySummariesDb(),
): string | null {
  const rows = queryReadonly(
    dbPath,
    `SELECT conversation_id, workspace_uris, last_modified_time
       FROM conversation_summaries
      WHERE parent_conversation_id = '' AND nesting_depth = 0
      ORDER BY last_modified_time DESC`,
  );
  if (!rows) return null;
  const want = normaliseProjectPath(projectPath);
  let best: { id: string; at: number } | null = null;
  for (const row of rows) {
    const id = row.conversation_id;
    const at = parseAgyTimestamp(String(row.last_modified_time ?? ""));
    if (typeof id !== "string" || !id || at === null || at < sinceMs) continue;
    if (!agyWorkspacePaths(row.workspace_uris).includes(want)) continue;
    // ORDER BY on the text column is only a hint (offsets can differ), so
    // compare parsed times rather than taking the first match.
    if (!best || at > best.at) best = { id, at };
  }
  return best?.id ?? null;
}

/** Upper bound on the first line we read from a rollout file. */
const SESSION_META_MAX_BYTES = 64 * 1024;

/** Read just the first line of a file (bounded), or null. */
function readFirstLine(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(SESSION_META_MAX_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf-8");
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(0, nl) : text;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Every `rollout-*.jsonl` below the sessions root, with its mtime. */
function listRollouts(root: string): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        // YYYY/MM/DD — three levels; don't wander further.
        if (depth < 3) walk(full, depth + 1);
      } else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
        out.push({ path: full, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Newest top-level Codex session for `projectPath` written at or after
 * `sinceMs`, or null. Files are visited newest-mtime first and only their
 * first line is read, so the cost is one stat per rollout plus a few small
 * reads.
 */
export function latestCodexSession(
  projectPath: string,
  sinceMs: number,
  sessionsDir: string = defaultCodexSessionsDir(),
): string | null {
  const want = normaliseProjectPath(projectPath);
  const candidates = listRollouts(sessionsDir)
    .filter((f) => f.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of candidates) {
    const line = readFirstLine(file.path);
    if (!line) continue;
    let meta: { type?: unknown; payload?: Record<string, unknown> };
    try { meta = JSON.parse(line); } catch { continue; }
    const p = meta.payload;
    if (meta.type !== "session_meta" || !p) continue;
    if (typeof p.id !== "string" || typeof p.cwd !== "string") continue;
    if (p.parent_thread_id) continue; // a subagent thread
    if (normaliseProjectPath(p.cwd) === want) return p.id;
  }
  return null;
}
