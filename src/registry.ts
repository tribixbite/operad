/**
 * registry.ts — Dynamic session registry for non-config Claude sessions
 *
 * Persists "dynamically opened" Claude sessions in registry.json alongside
 * the static tmx.toml config. Both sources merge on boot so all sessions
 * survive OOM/crash/reboot. Also provides `recent` command by parsing
 * Claude Code's ~/.claude/history.jsonl.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionConfig, SessionType } from "./types.js";
import type { Logger } from "./log.js";
import { forEachJsonlLine } from "./jsonl-lines.js";
import { isSafeConversationId } from "./runtimes/runtime.js";
import { TranscriptTitleCache } from "./title-cache.js";

/** A dynamically registered Claude session */
export interface RegistryEntry {
  /** Session name (unique, lowercase, matches [a-z0-9-]+) */
  name: string;
  /** Absolute path to the project directory */
  path: string;
  /** ISO timestamp when first opened */
  opened_at: string;
  /** ISO timestamp of last known activity */
  last_active: string;
  /** Start priority (default 50 — lower than config sessions) */
  priority: number;
  /** Auto-send "go" after startup */
  auto_go: boolean;
  /** Claude session ID for --resume (multi-instance support) */
  session_id?: string;
  /**
   * Which agent runtime this session runs (claude/codex/opencode/agy, or a
   * service type). Absent on entries written before this field existed, and
   * treated as "claude" for those.
   *
   * It has to be persisted: the registry is the only record of a session the
   * daemon did not get from TOML, and `toSessionConfigs()` used to stamp
   * every one of them `claude`. So a Codex or Antigravity session survived a
   * restart in name only — operad brought it back running Claude Code in the
   * same directory, which is not the session the user had.
   */
  type?: SessionType;
  /** Command for service/daemon entries (ignored for agent runtimes). */
  command?: string;
}

/** Persisted registry data */
interface RegistryData {
  version: number;
  sessions: RegistryEntry[];
}

/** Entry from ~/.claude/history.jsonl */
export interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

/** Recent project info returned by `operad recent` */
export interface RecentProject {
  /** Derived name (basename of path) */
  name: string;
  /** Project path */
  path: string;
  /** Most recent timestamp */
  last_active: string;
  /** Claude session ID from history */
  session_id: string;
  /** Status: running in operad, registered in registry, in config, or untracked */
  status: "running" | "registered" | "config" | "untracked";
}

const CURRENT_VERSION = 1;
const NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Session types a registry entry may name. Kept here rather than imported
 * from config.ts to avoid a cycle; `types-runtime.test.ts` asserts the two
 * lists stay in step.
 */
const REGISTRY_SESSION_TYPES: SessionType[] = [
  "claude", "opencode", "codex", "agy", "daemon", "service",
];

export class Registry {
  private data: RegistryData;
  private filePath: string;
  /** Optional — load-time problems are silent without it. */
  private log?: Logger;

  constructor(filePath: string, log?: Logger) {
    this.filePath = filePath;
    this.log = log;
    this.data = this.load();
  }

  /** Get all registry entries */
  entries(): RegistryEntry[] {
    return this.data.sessions;
  }

  /** Find an entry by name */
  find(name: string): RegistryEntry | undefined {
    return this.data.sessions.find((e) => e.name === name);
  }

  /** Find first entry by path */
  findByPath(path: string): RegistryEntry | undefined {
    const abs = resolve(path);
    return this.data.sessions.find((e) => e.path === abs);
  }

  /** Find all entries sharing a path (multi-instance) */
  findAllByPath(path: string): RegistryEntry[] {
    const abs = resolve(path);
    return this.data.sessions.filter((e) => e.path === abs);
  }

  /** Find entry by Claude session ID */
  findBySessionId(sessionId: string): RegistryEntry | undefined {
    return this.data.sessions.find((e) => e.session_id === sessionId);
  }

  /** Add a new entry. Returns the entry, or null if name conflict. */
  add(entry: Omit<RegistryEntry, "opened_at" | "last_active">): RegistryEntry | null {
    if (this.find(entry.name)) return null; // duplicate name

    const full: RegistryEntry = {
      ...entry,
      path: resolve(entry.path),
      opened_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
    };
    this.data.sessions.push(full);
    this.save();
    return full;
  }

  /** Remove an entry by name. Returns true if found and removed. */
  remove(name: string): boolean {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((e) => e.name !== name);
    if (this.data.sessions.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  /** Update last_active timestamp for a session */
  updateActivity(name: string): void {
    const entry = this.find(name);
    if (entry) {
      entry.last_active = new Date().toISOString();
      // Don't save on every poll — save periodically or on shutdown
    }
  }

  /** Save current registry state (call on shutdown or after mutations) */
  flush(): void {
    this.save();
  }

  /** Remove entries older than maxAgeDays */
  prune(maxAgeDays = 30): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((e) => {
      return new Date(e.last_active).getTime() > cutoff;
    });
    const pruned = before - this.data.sessions.length;
    if (pruned > 0) this.save();
    return pruned;
  }

  /** Convert registry entries to SessionConfig[] for merging with config */
  toSessionConfigs(): SessionConfig[] {
    return this.data.sessions.map((e): SessionConfig => ({
      name: e.name,
      type: e.type ?? ("claude" as SessionType),
      path: e.path,
      command: e.command,
      auto_go: e.auto_go,
      priority: e.priority,
      depends_on: [],
      headless: false,
      env: {},
      health: undefined,
      max_restarts: 3,
      restart_backoff_s: 5,
      enabled: true,
      bare: false,
      session_id: e.session_id,
    }));
  }

  // -- Persistence ------------------------------------------------------------

  /**
   * Move an unusable registry aside before it is overwritten.
   *
   * Returning an empty registry is not harmless: the next save() writes that
   * emptiness over the file, erasing every dynamically registered session.
   * A version mismatch — running an older operad against a newer registry —
   * hit exactly that path, so a downgrade silently wiped the user's
   * registrations. Only the most recent bad copy is kept.
   */
  private quarantine(reason: string): void {
    const backup = `${this.filePath}.corrupt`;
    try {
      copyFileSync(this.filePath, backup);
      this.log?.warn(`Unusable registry saved to ${backup} (${reason})`);
    } catch { /* nothing more we can do; the original is still about to go */ }
  }

  private load(): RegistryData {
    try {
      if (existsSync(this.filePath)) {
        const content = readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(content) as RegistryData;
        if (parsed.version === CURRENT_VERSION && Array.isArray(parsed.sessions)) {
          // Sanitise on load. This path bypasses the validation that add()
          // applies at runtime, and a registry file can be edited by hand or
          // written by another tool.
          //
          // session_id is interpolated into `claude --resume <id>`, so a
          // tampered value could otherwise smuggle shell text. Names reach
          // tmux targets and paths, and — contrary to what the comment here
          // used to claim — were NOT being checked at all.
          const clean = parsed.sessions.filter((entry) => {
            if (!entry || typeof entry.name !== "string" || !isValidName(entry.name)) {
              this.log?.warn(`Dropping registry entry with invalid name: ${JSON.stringify(entry?.name)}`);
              return false;
            }
            return true;
          });
          for (const entry of clean) {
            // `type` selects a runtime adapter and, for service types, pairs
            // with a `command` that is sent to a shell. A hand-edited or
            // foreign registry must not be able to name a type operad doesn't
            // know, nor smuggle a command in under an agent type. Checked
            // first, because it decides which session_id rule applies.
            if (entry.type !== undefined && !REGISTRY_SESSION_TYPES.includes(entry.type)) {
              this.log?.warn(`Dropping unknown type '${String(entry.type)}' from registry entry '${entry.name}'`);
              entry.type = undefined;
            }
            if (entry.session_id && !isValidSessionIdFor(entry.type, entry.session_id)) {
              entry.session_id = undefined;
            }
            if (entry.command !== undefined && typeof entry.command !== "string") {
              entry.command = undefined;
            }
          }
          return { version: CURRENT_VERSION, sessions: clean };
        }
        // Parsed, but unusable — a future/older schema version, or `sessions`
        // is not an array. Preserve it: the next save() overwrites the file.
        this.quarantine(`version ${String(parsed?.version)} != ${CURRENT_VERSION}`);
      }
    } catch (err) {
      if (existsSync(this.filePath)) this.quarantine(String(err));
    }
    return { version: CURRENT_VERSION, sessions: [] };
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
      renameSync(tmp, this.filePath);
    } catch { /* best effort */ }
  }
}

// -- History parsing ----------------------------------------------------------

/**
 * Parse ~/.claude/history.jsonl to find recently active projects.
 * Reads the tail of the file (last `maxLines` lines) for performance.
 * Deduplicates by project path, keeping the most recent entry.
 */
export function parseRecentProjects(historyPath: string, maxLines = 1000): Array<{
  name: string;
  path: string;
  last_active: string;
  session_id: string;
}> {
  if (!existsSync(historyPath)) return [];

  try {
    // Deduplicate by project path, keeping latest timestamp. Only the last
    // `maxLines` lines count; they are read newest-first from the end of the
    // file, so the rest of the history is never loaded.
    const byPath = new Map<string, { timestamp: number; sessionId: string }>();
    let seen = 0;
    forEachJsonlLine(historyPath, (line) => {
      if (++seen > maxLines) return false;
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (!entry.project || !entry.timestamp) return;
        const existing = byPath.get(entry.project);
        if (!existing || entry.timestamp > existing.timestamp) {
          byPath.set(entry.project, {
            timestamp: entry.timestamp,
            sessionId: entry.sessionId,
          });
        }
      } catch { /* skip malformed lines */ }
    }, { reverse: true });

    // Convert to sorted array (most recent first)
    const results: Array<{
      name: string;
      path: string;
      last_active: string;
      session_id: string;
    }> = [];

    for (const [path, info] of byPath) {
      results.push({
        name: deriveName(path),
        path,
        last_active: new Date(info.timestamp).toISOString(),
        session_id: info.sessionId,
      });
    }

    results.sort((a, b) => b.last_active.localeCompare(a.last_active));
    return results;
  } catch {
    return [];
  }
}

/** Derive a session name from a path (basename, lowercased, sanitized) */
export function deriveName(path: string): string {
  const base = basename(path).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return base || "unnamed";
}

/** Validate a session name */
export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/**
 * Strict UUID validator (any version) used to gate Claude `--resume <id>`
 * arguments. The session_id ends up as a token in a shell command sent via
 * `tmux send-keys`, so a malicious or corrupted registry could otherwise
 * inject extra commands. Rejecting anything that isn't a canonical UUID
 * gives us a hard wall before that interpolation.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidSessionId(id: string): boolean {
  return UUID_PATTERN.test(id);
}

/**
 * Validate a stored conversation id for the runtime that will resume it.
 * Claude Code issues UUIDs, and an entry with no type is Claude; the other
 * runtimes issue other shapes (OpenCode's `ses_…`), which only have to be
 * safe to place in a startup command.
 */
export function isValidSessionIdFor(type: SessionType | undefined, id: string): boolean {
  return type === undefined || type === "claude" ? isValidSessionId(id) : isSafeConversationId(id);
}

/** A named Claude session discovered from session JSONL custom-title entries */
export interface NamedSession {
  /** User-assigned session title (from /rename) */
  title: string;
  /** Claude session UUID */
  session_id: string;
  /** Project path */
  path: string;
  /** Most recent activity timestamp (ISO) */
  last_active: string;
}

/**
 * How far past the history window the newest-first walk keeps reading
 * before it stops. history.jsonl is appended in time order, but concurrent
 * sessions can interleave a line or two out of order.
 */
const HISTORY_ORDER_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * Find Claude sessions that have user-assigned names (via /rename).
 * Scans history.jsonl for recent sessions, then checks each session's JSONL
 * for `type: "custom-title"` entries. Only returns sessions with short titles
 * (< 30 chars) active within maxAgeDays — these are intentional named sessions.
 */
export function findNamedSessions(
  historyPath: string,
  maxAgeDays = 7,
  titles: TranscriptTitleCache = new TranscriptTitleCache(null),
): NamedSession[] {
  if (!existsSync(historyPath)) return [];

  try {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    // Collect recent sessions: sessionId → { path, timestamp }.
    //
    // Walked newest-first and stopped once well past the window, instead of
    // reading the whole history (12k+ lines, years of prompts) into memory.
    // The file is append-ordered but two sessions writing at once can leave
    // a line slightly out of order, so the walk only stops after a day's
    // margin beyond the cutoff, and each entry is still checked against it.
    const stopBelow = cutoff - HISTORY_ORDER_SLACK_MS;
    const recentById = new Map<string, { path: string; timestamp: number }>();
    forEachJsonlLine(historyPath, (line) => {
      let entry: HistoryEntry;
      try { entry = JSON.parse(line) as HistoryEntry; } catch { return; }
      if (typeof entry.timestamp === "number" && entry.timestamp < stopBelow) return false;
      if (!entry.project || !entry.timestamp || !entry.sessionId) return;
      if (entry.timestamp < cutoff) return;
      const existing = recentById.get(entry.sessionId);
      if (!existing || entry.timestamp > existing.timestamp) {
        recentById.set(entry.sessionId, { path: entry.project, timestamp: entry.timestamp });
      }
    }, { reverse: true });

    // Scan each session's JSONL for custom-title entries
    const claudeDir = dirname(historyPath); // ~/.claude
    const projectsDir = join(claudeDir, "projects");
    const results: NamedSession[] = [];

    for (const [sessionId, info] of recentById) {
      // Derive project dir name from path (same encoding Claude uses: all non-alnum to -)
      const projectDirName = info.path.replace(/[^a-zA-Z0-9]/g, "-");
      const sessionJsonl = join(projectsDir, projectDirName, `${sessionId}.jsonl`);

      if (!existsSync(sessionJsonl)) continue;

      // The LAST custom-title entry (most recent rename). The cache answers
      // unchanged transcripts without reading them and reads only appended
      // bytes otherwise — see title-cache.ts for why this dominated boot.
      const customTitle = titles.lastCustomTitle(sessionJsonl);

      // Only include sessions with short, meaningful titles
      if (customTitle && customTitle.length < 30 && !customTitle.includes("(Fork)")) {
        results.push({
          title: customTitle,
          session_id: sessionId,
          path: info.path,
          last_active: new Date(info.timestamp).toISOString(),
        });
      }
    }

    results.sort((a, b) => b.last_active.localeCompare(a.last_active));
    return results;
  } catch {
    return [];
  }
}

/** Find next available suffixed name: torch → torch-2 → torch-3 */
export function nextSuffix(baseName: string, existingNames: string[]): string {
  const pattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-(\\d+))?$`);
  const nums = existingNames
    .map((n) => {
      const m = n.match(pattern);
      if (!m) return NaN;
      return m[1] ? parseInt(m[1], 10) : 1; // bare name counts as 1
    })
    .filter((n) => !isNaN(n));
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `${baseName}-${max + 1}`;
}
