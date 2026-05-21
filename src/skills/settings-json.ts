/**
 * skills/settings-json.ts — Concurrency-safe RMW for the SKILL.md
 * registration entries in `~/.claude/settings.json`.
 *
 * Mirrors the `claude-json` writer pattern: flock-ish lockfile +
 * mtime+sha256 re-check + retry-once. Settings.json is mostly a UX
 * config so the race window is narrower than `claude.json` (less
 * frequent claude-code self-writes), but the same protocol applies.
 *
 * The skills field is treated as an array of absolute bundle paths.
 * Spec §3.8 chose this single delivery path; round-2 dropped the
 * fallback. Each skill's `SkillMdEntry.bundle_path` is appended (on
 * install) or removed (on uninstall).
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
import { SkillError } from "./types.js";

/**
 * Lazy paths — same rationale as claude-json's. Test harnesses
 * override $HOME after module import, so a top-level `const` would
 * capture the pre-override path.
 */
function settingsPath(): string { return join(homedir(), ".claude", "settings.json"); }
function lockPath(): string { return join(homedir(), ".claude", "settings.json.lock"); }

export interface SettingsJsonWriteOpts {
  /** Absolute bundle paths to add. */
  add?: string[];
  /** Absolute bundle paths to remove. */
  remove?: string[];
}

interface ReadSnapshot {
  parsed: Record<string, unknown>;
  mtime_ns: bigint;
  sha256: string;
}

export function writeSettingsJson(opts: SettingsJsonWriteOpts): void {
  ensureFileExists();
  withLockfile(lockPath(), () => attemptWrite(opts, /* retriesLeft */ 1));
}

function attemptWrite(opts: SettingsJsonWriteOpts, retriesLeft: number): void {
  const snap = readSnapshot();
  const next = applyEdits(snap.parsed, opts);

  const post = statSync(settingsPath(), { bigint: true });
  const postSha = sha256Of(readFileSync(settingsPath()));
  if (post.mtimeNs !== snap.mtime_ns || postSha !== snap.sha256) {
    if (retriesLeft > 0) {
      attemptWrite(opts, retriesLeft - 1);
      return;
    }
    throw new SkillError(
      "CLAUDE_JSON_RACED",
      "~/.claude/settings.json was rewritten by another process between operad's read and write. Retry the install after closing the conflicting client.",
      { path: settingsPath() },
    );
  }

  writeAtomic(next);
}

/**
 * Apply skills add/remove diffs to the parsed settings. Pure — no IO.
 * Visible for tests.
 */
export function applyEdits(
  parsed: Record<string, unknown>,
  opts: SettingsJsonWriteOpts,
): Record<string, unknown> {
  const next = { ...parsed };
  const skills = Array.isArray(next.skills) ? [...(next.skills as string[])] : [];

  const removeSet = new Set(opts.remove ?? []);
  const after = skills.filter((s) => !removeSet.has(s));

  for (const path of opts.add ?? []) {
    if (!after.includes(path)) after.push(path);
  }

  next.skills = after;
  return next;
}

function readSnapshot(): ReadSnapshot {
  const body = readFileSync(settingsPath());
  const st = statSync(settingsPath(), { bigint: true });
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch (err) {
    throw new SkillError(
      "CLAUDE_JSON_MALFORMED",
      `Failed to parse ~/.claude/settings.json: ${(err as Error).message}.`,
      { path: settingsPath() },
    );
  }
  return { parsed, mtime_ns: st.mtimeNs, sha256: sha256Of(body) };
}

function writeAtomic(obj: Record<string, unknown>): void {
  const tmp = `${settingsPath()}.operad-tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, settingsPath());
}

function ensureFileExists(): void {
  if (!existsSync(settingsPath())) {
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({}, null, 2), { mode: 0o600 });
  }
}

function sha256Of(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function withLockfile<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const acquired = acquireLockfile(lockPath);
  try {
    return fn();
  } finally {
    if (acquired) {
      try { unlinkSync(lockPath); } catch { /* ignore */ }
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
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > 30_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch { /* retry */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  return false;
}
