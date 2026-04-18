/**
 * session-resolver.ts — Pure session-name resolution helpers
 *
 * Extracted from daemon.ts. Resolves fuzzy session names (exact → prefix →
 * substring) and disk paths for sessions defined in config, registry, or
 * Claude history.jsonl. No daemon state — all deps passed in.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { TmxConfig, SessionConfig } from "./types.js";
import type { Registry } from "./registry.js";
import { parseRecentProjects } from "./registry.js";

/**
 * Fuzzy-match a session name (exact → prefix → substring) against config
 * sessions and registry entries. Returns null on no-match or ambiguous match.
 */
export function resolveSessionName(
  config: TmxConfig,
  registry: Registry,
  input: string,
): string | null {
  const names = config.sessions.map((s) => s.name);
  for (const entry of registry.entries()) {
    if (!names.includes(entry.name)) names.push(entry.name);
  }
  if (names.includes(input)) return input;
  const prefix = names.filter((n) => n.startsWith(input));
  if (prefix.length === 1) return prefix[0];
  const substring = names.filter((n) => n.includes(input));
  if (substring.length === 1) return substring[0];
  return null;
}

/**
 * Resolve a session name to its cwd path. Returns null if no match or the
 * resolved session has no path.
 */
export function resolveSessionPath(
  config: TmxConfig,
  registry: Registry,
  sessionName: string,
): string | null {
  const resolved = resolveSessionName(config, registry, sessionName);
  if (!resolved) return null;
  const cfg = config.sessions.find((s: SessionConfig) => s.name === resolved);
  if (cfg?.path) return cfg.path;
  for (const entry of registry.entries()) {
    if (entry.name === resolved && entry.path) return entry.path;
  }
  return null;
}

/**
 * Resolve an `operad open` target to an absolute path. Searches config
 * sessions, registry, and ~/.claude/history.jsonl. Returns null on no-match.
 */
export function resolveOpenTarget(
  config: TmxConfig,
  registry: Registry,
  input: string,
): string | null {
  const lower = input.toLowerCase();

  const configExact = config.sessions.find((s) => s.name === lower && s.path);
  if (configExact?.path) return resolve(configExact.path);

  const regExact = registry.find(lower);
  if (regExact) return regExact.path;

  const historyPath = join(homedir(), ".claude", "history.jsonl");
  const recent = parseRecentProjects(historyPath, 1000);

  const recentExact = recent.find((p) => p.name === lower);
  if (recentExact) return recentExact.path;

  const allSources: Array<{ name: string; path: string }> = [
    ...config.sessions.filter((s) => s.path).map((s) => ({ name: s.name, path: s.path! })),
    ...registry.entries().map((e) => ({ name: e.name, path: e.path })),
    ...recent,
  ];

  const prefix = allSources.filter((s) => s.name.startsWith(lower));
  if (prefix.length === 1) return resolve(prefix[0].path);

  const substring = allSources.filter((s) => s.name.includes(lower));
  if (substring.length === 1) return resolve(substring[0].path);

  if (prefix.length > 0) return resolve(prefix[0].path);
  if (substring.length > 0) return resolve(substring[0].path);

  return null;
}
