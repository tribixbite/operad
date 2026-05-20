/**
 * skills/claude-json.ts — Concurrency-safe surgical RMW writer for
 * `~/.claude.json`.
 *
 * Spec §3.5 + §7.6. The writer:
 *   1. flock-advisory-locks `~/.claude.json.lock` (operad-vs-operad
 *      synchronisation; claude-code does NOT honour this lock).
 *   2. Reads `~/.claude.json`, captures `(mtime_ns, sha256(body))`.
 *   3. Parses; aborts with `CLAUDE_JSON_MALFORMED` if parse fails —
 *      operad never touches a malformed file.
 *   4. Computes the surgical update over `mcpServers` + `operad_managed`.
 *   5. Re-stats. If `(mtime_ns, sha256)` changed, the file was rewritten
 *      between read and rename (most likely by claude-code via `/mcp` or
 *      an auth-token rotation). Release lock, retry the whole sequence
 *      ONCE. On second race, abort with `CLAUDE_JSON_RACED`.
 *   6. Writes via temp-file-then-rename for atomicity.
 *
 * The `operad_managed` field is an OBJECT keyed by mcp name (NOT an
 * array — round-3 reviewer caught that). Each entry records the
 * skill_id and daemon_id of the operad instance that owns it.
 *
 * Collision behaviours per §3.5:
 *   • mcpServers[name] exists but operad_managed[name] absent →
 *     user-owned. Refuse with MCP_NAME_USER_OWNED unless
 *     force_take_ownership.
 *   • operad_managed[name].daemon_id ≠ ours → another daemon owns it.
 *     Refuse with MCP_OWNED_BY_OTHER_DAEMON. Manual resolution only —
 *     no force flag, deliberately.
 *   • mcpServers[name] absent but operad_managed[name] present →
 *     orphan (user manually deleted mcpServers entry). Log a warning,
 *     drop the operad_managed entry on this operation.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { SkillError, type SkillMcpEntry } from "./types.js";

const CLAUDE_JSON_PATH = join(homedir(), ".claude.json");
const LOCK_PATH = join(homedir(), ".claude.json.lock");

/**
 * What we record in `~/.claude.json.operad_managed.<name>` so the writer
 * can detect concurrent-daemon edits and orphaned entries.
 */
export interface OperadManagedEntry {
  skill_id: string;
  daemon_id: string;
  installed_at: number;
}

/**
 * Snapshot of the file at read time. Used to detect concurrent writes.
 * mtime_ns is the better signal but not always granular enough; we
 * combine it with a body sha256 for paranoia.
 */
interface ReadSnapshot {
  parsed: Record<string, unknown>;
  mtime_ns: bigint;
  sha256: string;
}

export interface ClaudeJsonWriteOpts {
  daemon_id: string;
  /** MCPs to add (or replace if we already own them). */
  add?: Array<{ entry: SkillMcpEntry; skill_id: string }>;
  /**
   * MCP names to remove. Only entries operad owns (per
   * operad_managed) are touched.
   */
  remove?: string[];
  /**
   * Override the user-owned safety check. Surfaced from the CLI as
   * `--force-take-ownership`. Does NOT override
   * MCP_OWNED_BY_OTHER_DAEMON — cross-daemon resolution is manual.
   */
  force_take_ownership?: boolean;
}

/**
 * Apply a surgical RMW to `~/.claude.json`. Returns nothing on success;
 * throws SkillError on any precondition failure.
 *
 * Caller is responsible for invoking this OUTSIDE any other long-held
 * lock — the flock here is fine-grained.
 */
export function writeClaudeJson(opts: ClaudeJsonWriteOpts): void {
  ensureFileExists();
  withFlock(LOCK_PATH, () => attemptWrite(opts, /* retriesLeft */ 1));
}

/**
 * One pass of read-modify-write. On race detection, recurses with
 * `retriesLeft - 1`; on second race, throws CLAUDE_JSON_RACED.
 */
function attemptWrite(opts: ClaudeJsonWriteOpts, retriesLeft: number): void {
  const snap = readSnapshot();
  const next = applyEdits(snap.parsed, opts);

  // Re-stat just before rename. We want to catch any write that
  // landed between our read and our planned rename.
  const post = statSync(CLAUDE_JSON_PATH, { bigint: true });
  const postSha = sha256Of(readFileSync(CLAUDE_JSON_PATH));
  if (post.mtimeNs !== snap.mtime_ns || postSha !== snap.sha256) {
    if (retriesLeft > 0) {
      attemptWrite(opts, retriesLeft - 1);
      return;
    }
    throw new SkillError(
      "CLAUDE_JSON_RACED",
      "~/.claude.json was rewritten by another process between operad's read and write. Retry the install after closing the conflicting client.",
      { path: CLAUDE_JSON_PATH },
    );
  }

  writeAtomic(next);
}

/**
 * Compute the post-edit JSON from the pre-edit JSON + opts. Pure —
 * does no IO. Visible for unit tests.
 */
export function applyEdits(
  parsed: Record<string, unknown>,
  opts: ClaudeJsonWriteOpts,
): Record<string, unknown> {
  const next = { ...parsed };
  const mcpServers: Record<string, unknown> = {
    ...((next.mcpServers as Record<string, unknown>) ?? {}),
  };
  const operadManaged: Record<string, OperadManagedEntry> = {
    ...((next.operad_managed as Record<string, OperadManagedEntry>) ?? {}),
  };

  // First, GC orphan operad_managed entries (mcpServers[name] gone but
  // operad_managed[name] present). This is the "user manually deleted
  // mcpServers entry" case — we don't try to restore it; we just stop
  // claiming ownership so the next operation has a clean slate.
  for (const name of Object.keys(operadManaged)) {
    if (!(name in mcpServers)) {
      delete operadManaged[name];
    }
  }

  // Removes — only if we own the name.
  for (const name of opts.remove ?? []) {
    const owner = operadManaged[name];
    if (!owner) continue; // Not ours; skip silently. Caller already validated.
    if (owner.daemon_id !== opts.daemon_id) {
      throw new SkillError(
        "MCP_OWNED_BY_OTHER_DAEMON",
        `MCP '${name}' is owned by another operad daemon (${owner.daemon_id}). Manual cross-daemon resolution required.`,
        { name, owner_daemon_id: owner.daemon_id, our_daemon_id: opts.daemon_id },
      );
    }
    delete mcpServers[name];
    delete operadManaged[name];
  }

  // Adds.
  for (const { entry, skill_id } of opts.add ?? []) {
    const existing = mcpServers[entry.name];
    const owner = operadManaged[entry.name];

    if (existing && !owner) {
      if (!opts.force_take_ownership) {
        throw new SkillError(
          "MCP_NAME_USER_OWNED",
          `MCP '${entry.name}' already exists in ~/.claude.json and is not managed by operad. Pass --force-take-ownership to claim it, or rename in the skill manifest.`,
          { name: entry.name },
        );
      }
      // Falls through to take ownership.
    }

    if (owner && owner.daemon_id !== opts.daemon_id) {
      throw new SkillError(
        "MCP_OWNED_BY_OTHER_DAEMON",
        `MCP '${entry.name}' is owned by another operad daemon (${owner.daemon_id}).`,
        { name: entry.name, owner_daemon_id: owner.daemon_id, our_daemon_id: opts.daemon_id },
      );
    }

    mcpServers[entry.name] = serializeMcpEntry(entry);
    operadManaged[entry.name] = {
      skill_id,
      daemon_id: opts.daemon_id,
      installed_at: Math.floor(Date.now() / 1000),
    };
  }

  next.mcpServers = mcpServers;
  next.operad_managed = operadManaged;
  return next;
}

/**
 * Translate our SkillMcpEntry into the wire format Claude Code reads.
 * stdio entries use `{command, args, env}`; http/sse entries use
 * `{type, url}`.
 */
function serializeMcpEntry(entry: SkillMcpEntry): Record<string, unknown> {
  if (entry.url) {
    return {
      type: entry.transport === "sse" ? "sse" : "http",
      url: entry.url,
      ...(entry.env ? { env: entry.env } : {}),
    };
  }
  return {
    command: entry.command,
    ...(entry.args ? { args: entry.args } : {}),
    ...(entry.env ? { env: entry.env } : {}),
  };
}

function readSnapshot(): ReadSnapshot {
  const body = readFileSync(CLAUDE_JSON_PATH);
  const st = statSync(CLAUDE_JSON_PATH, { bigint: true });
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch (err) {
    throw new SkillError(
      "CLAUDE_JSON_MALFORMED",
      `Failed to parse ~/.claude.json: ${(err as Error).message}. operad will not touch a malformed file; please fix it manually before retrying.`,
      { path: CLAUDE_JSON_PATH },
    );
  }
  return { parsed, mtime_ns: st.mtimeNs, sha256: sha256Of(body) };
}

function writeAtomic(obj: Record<string, unknown>): void {
  const tmp = `${CLAUDE_JSON_PATH}.operad-tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, CLAUDE_JSON_PATH);
}

function ensureFileExists(): void {
  if (!existsSync(CLAUDE_JSON_PATH)) {
    mkdirSync(dirname(CLAUDE_JSON_PATH), { recursive: true });
    writeFileSync(CLAUDE_JSON_PATH, JSON.stringify({}, null, 2), { mode: 0o600 });
  }
}

function sha256Of(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Run `fn` while holding a O_EXCL-style lockfile. This gives operad-vs-
 * operad mutual exclusion (claude-code doesn't honour it either way, so
 * the real protection is the mtime+sha256 re-check inside `attemptWrite`).
 *
 * The lockfile is created with `O_EXCL`; if another operad install is
 * mid-flight, we busy-wait with a small backoff up to 5 s, then proceed
 * unlocked rather than failing the whole install. Stale lockfiles from
 * a crashed daemon are detected via mtime > 30 s and forcibly removed.
 */
function withFlock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const acquired = acquireLockfile(lockPath);
  try {
    return fn();
  } finally {
    if (acquired) {
      try { unlinkSync(lockPath); } catch { /* ignore — caller could have unlinked */ }
    }
  }
}

function acquireLockfile(lockPath: string): boolean {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      closeSync(fd);
      return true;
    } catch {
      // Lock held. Check for staleness.
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > 30_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch { /* lock vanished between exists check and stat — retry */ }
      // Busy-wait with backoff.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  // Best effort. The re-stat in attemptWrite catches the race.
  return false;
}
