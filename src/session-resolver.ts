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
import { parseRecentProjects, findNamedSessions, deriveName, isValidName, nextSuffix } from "./registry.js";
import type { StateManager } from "./state.js";
import type { Logger } from "./log.js";

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

/**
 * Resolve which Claude sessions to auto-start based on Claude history recency.
 *
 * Phase 1: Primary instances — one per project path, no session_id, uses `cc`.
 * Phase 2: Named sessions — user-renamed via /rename, resumed by session_id.
 * Phase 3: Partition into auto-start vs visible-only vs hidden based on config.
 *
 * Non-claude sessions (services/daemons) are untouched — they always start.
 * Called during boot() after mergeRegistrySessions() but before startAllSessions().
 *
 * NOTE: Mutates config.sessions (enables/disables sessions) and calls
 * registry.add() for newly discovered projects. Both mutations are
 * intentional — callers expect the side effects.
 */
export function resolveBootSessions(
  config: TmxConfig,
  registry: Registry,
  state: StateManager,
  log: Logger,
): void {
  const home = homedir();
  const historyPath = join(home, ".claude", "history.jsonl");
  const recentProjects = parseRecentProjects(historyPath, 1000);
  const namedSessions = findNamedSessions(historyPath, 7);
  const { auto_start, visible } = config.boot;

  // Build path→config lookup (one entry per path for primary matching)
  const configByPath = new Map<string, SessionConfig>();
  for (const s of config.sessions) {
    if (s.path) configByPath.set(resolve(s.path), s);
  }

  // Track ranked claude sessions for partitioning
  const recentClaude: { config: SessionConfig; rank: number }[] = [];
  let rank = 0;

  // --- Phase 1: Primary instances (one per project, no session_id, uses cc) ---
  for (const proj of recentProjects) {
    if (rank >= visible) break;

    const resolvedPath = resolve(proj.path);
    const existing = configByPath.get(resolvedPath);

    if (existing) {
      if (existing.type === "claude" && existing.enabled) {
        // Primary instance uses cc (--continue), no session_id
        existing.session_id = undefined;
        recentClaude.push({ config: existing, rank: rank++ });
      }
    } else {
      // Untracked project — auto-register
      const name = deriveName(proj.path);
      if (!config.sessions.find((s) => s.name === name)) {
        registry.add({ name, path: resolvedPath, priority: 50, auto_go: false });
        const newConfig: SessionConfig = {
          name, type: "claude", path: resolvedPath, command: undefined,
          auto_go: false, priority: 50, depends_on: [], headless: false,
          env: {}, health: undefined, max_restarts: 3, restart_backoff_s: 5,
          enabled: true, bare: false,
        };
        config.sessions.push(newConfig);
        configByPath.set(resolvedPath, newConfig);
        recentClaude.push({ config: newConfig, rank: rank++ });
      }
    }
  }

  // --- Phase 2: Named sessions (user-renamed via /rename, resumed by session_id) ---
  const registeredIds = new Set<string>();
  // Check existing config/registry for already-registered named sessions
  for (const s of config.sessions) {
    if (s.session_id) registeredIds.add(s.session_id);
  }

  for (const named of namedSessions) {
    if (rank >= visible) break;
    if (registeredIds.has(named.session_id)) continue;

    const resolvedPath = resolve(named.path);
    // Sanitize title to valid session name
    const titleName = named.title.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
    if (!titleName || !isValidName(titleName)) continue;

    // Check name conflicts — suffix if needed
    const existingNames = config.sessions.map((s) => s.name);
    const sessionName = existingNames.includes(titleName)
      ? nextSuffix(titleName, existingNames.filter((n) => n === titleName || n.match(new RegExp(`^${titleName}-\\d+$`))))
      : titleName;

    registry.add({
      name: sessionName, path: resolvedPath, priority: 50,
      auto_go: false, session_id: named.session_id,
    });

    const newConfig: SessionConfig = {
      name: sessionName, type: "claude", path: resolvedPath, command: undefined,
      auto_go: false, priority: 50, depends_on: [], headless: false,
      env: {}, health: undefined, max_restarts: 3, restart_backoff_s: 5,
      enabled: true, bare: false, session_id: named.session_id,
    };
    config.sessions.push(newConfig);
    registeredIds.add(named.session_id);
    recentClaude.push({ config: newConfig, rank: rank++ });
  }

  // Partition claude sessions: auto-start vs visible-only vs hidden
  const autoStartNames = new Set<string>();
  const visibleNames = new Set<string>();

  for (const { config: sc, rank: r } of recentClaude) {
    if (r < auto_start) {
      autoStartNames.add(sc.name);
    } else if (r < visible) {
      visibleNames.add(sc.name);
    }
  }

  // Disable claude sessions not in auto-start set
  for (const s of config.sessions) {
    if (s.type !== "claude") continue;
    if (autoStartNames.has(s.name)) continue;
    if (visibleNames.has(s.name)) {
      s.enabled = false;
      continue;
    }
    if (!autoStartNames.has(s.name)) {
      s.enabled = false;
    }
  }

  // Re-init state entries for any newly added sessions
  state.initFromConfig(config.sessions);

  log.info(`Boot recency: auto-start=[${[...autoStartNames].join(",")}] ` +
    `visible=[${[...visibleNames].join(",")}]`);
}
