/**
 * skills/daemon-id.ts — Per-machine UUID provisioning.
 *
 * The daemon_id distinguishes operad instances when their `~/.claude.json`
 * file is shared across machines (Syncthing / Mutagen / chezmoi). It's
 * written to `operad_managed.<mcp-name>.daemon_id` in `~/.claude.json` so
 * the writer can refuse to clobber another daemon's MCP entries.
 *
 * Location precedence (§3.5 of the spec):
 *   1. $XDG_RUNTIME_DIR/operad/daemon-id   — Linux desktop, per-machine tmpfs
 *   2. $PREFIX/var/lib/operad/daemon-id    — Termux per-Android-device
 *   3. ~/.local/share/operad/daemon-id     — fallback (with doctor warning;
 *                                             this path syncs by default
 *                                             under most dotfile tools)
 *
 * The chosen path is decided once on first boot and cached in
 * `~/.local/share/operad/daemon-id.path` so re-bootstrapping under a
 * different `$XDG_RUNTIME_DIR` (which can change on session swap) doesn't
 * accidentally produce a new id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Cache file recording which absolute path we settled on for this install.
 * The module-level default uses the real homedir; pass `baseDir` to
 * `resolveDaemonId` / `chooseLocation` to redirect in tests without
 * mutating `process.env.HOME`.
 */
function pathCache(baseDir?: string): string {
  return join(baseDir ?? homedir(), ".local", "share", "operad", "daemon-id.path");
}

export interface DaemonIdResult {
  id: string;
  /** Absolute path where the id is stored. */
  path: string;
  /**
   * True if the chosen path is `~/.local/share/operad/daemon-id` —
   * the fallback that likely syncs. The daemon surfaces this as a
   * doctor warning when true.
   */
  may_sync: boolean;
}

/**
 * Resolve (or provision, if first run) the daemon UUID.
 *
 * Idempotent: subsequent calls on the same machine return the same id.
 * After provisioning, the chosen path is sticky — even if
 * `$XDG_RUNTIME_DIR` becomes unset later, we keep reading from the
 * originally-chosen path until that path itself is missing.
 *
 * @param baseDir - Optional base directory override for the cache and
 *   fallback path (test harness use only; defaults to `homedir()`).
 */
export function resolveDaemonId(baseDir?: string): DaemonIdResult {
  const cache = pathCache(baseDir);
  const home = baseDir ?? homedir();

  // Honour the cached path first if it exists AND the file exists. This
  // is the steady-state path on every boot after the first.
  if (existsSync(cache)) {
    const cachedPath = readFileSync(cache, "utf8").trim();
    if (cachedPath && existsSync(cachedPath)) {
      return {
        id: readFileSync(cachedPath, "utf8").trim(),
        path: cachedPath,
        may_sync: isSyncProneFallback(cachedPath, home),
      };
    }
    // Cached path is stale — fall through to re-decide. We don't error
    // here because the user may have wiped $XDG_RUNTIME_DIR or
    // uninstalled a package.
  }

  const chosen = chooseLocation(baseDir);
  const id = randomUUID();
  mkdirSync(dirname(chosen), { recursive: true, mode: 0o700 });
  writeFileSync(chosen, id, { mode: 0o600 });

  // Cache the chosen path. We never overwrite an existing cache to keep
  // the sticky-path semantics; if PATH_CACHE existed and we got here,
  // the cache pointed at a missing file and we just provisioned a new
  // location — rewrite the cache.
  mkdirSync(dirname(cache), { recursive: true, mode: 0o700 });
  writeFileSync(cache, chosen, { mode: 0o600 });

  return { id, path: chosen, may_sync: isSyncProneFallback(chosen, home) };
}

/**
 * Pick a per-machine writable location in priority order. Visible for
 * tests so they can stub the env without touching the real filesystem.
 *
 * @param baseDir - Optional override for the `~/.local/share` fallback
 *   root (test harness use only; defaults to `homedir()`).
 */
export function chooseLocation(baseDir?: string): string {
  // 1. $XDG_RUNTIME_DIR — per-user, per-session, tmpfs on Linux desktop.
  //    Cleared on logout (acceptable — the id is per-machine, not per-
  //    session, and we cache the chosen path elsewhere anyway).
  const xdg = process.env.XDG_RUNTIME_DIR;
  // isAbsolute() rather than startsWith("/") so a drive-letter path is accepted
  // on Windows; the intent is "ignore a relative XDG value", and a bare "/"
  // check wrongly rejects every absolute Windows path.
  if (xdg && isAbsolute(xdg) && safeWritable(xdg)) {
    return join(xdg, "operad", "daemon-id");
  }

  // 2. Termux: $PREFIX/var/lib/operad/daemon-id — per-device, never
  //    syncs across phones because $PREFIX is the Termux install root.
  const prefix = process.env.PREFIX;
  if (prefix && prefix.includes("com.termux") && safeWritable(prefix)) {
    return join(prefix, "var", "lib", "operad", "daemon-id");
  }

  // 3. Fallback. This is what the round-4 reviewer flagged as
  //    Syncthing-prone; the caller is expected to surface a doctor
  //    warning when `may_sync` comes back true.
  return join(baseDir ?? homedir(), ".local", "share", "operad", "daemon-id");
}

function safeWritable(dir: string): boolean {
  try {
    // We don't actually try to write — just confirm the dir exists.
    // mkdirSync below will create the subdir if needed.
    return existsSync(dir);
  } catch {
    return false;
  }
}

function isSyncProneFallback(p: string, home?: string): boolean {
  return p.startsWith(join(home ?? homedir(), ".local", "share"));
}
