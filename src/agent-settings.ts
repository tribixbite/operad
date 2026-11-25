/**
 * agent-settings.ts — the few agent settings worth surfacing on the dashboard.
 *
 * Claude Code's `~/.claude/settings.json` holds values whose effect is easy to
 * miss until it costs something: `cleanupPeriodDays` decides when transcripts
 * are deleted (default 30 days of inactivity), and a deleted transcript cannot
 * be recovered. This module reports those values and edits them.
 *
 * Edits are allow-listed: only keys in CLAUDE_SETTINGS can be written, each
 * with a validator, and every other key in the file is preserved. Hooks,
 * permissions rules, MCP servers and plugins stay out of reach on purpose —
 * they run commands, and the dashboard has its own audited editors for MCP.
 *
 * Codex values are read-only here: config.toml is hand-written TOML with
 * comments, and rewriting it would drop them.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseTomlPreferBun } from "./toml.js";

/** How a setting's value is typed and validated. */
export type SettingType = "int" | "bool" | "enum" | "string";

export interface SettingSpec {
  /** Dot path into the settings object, e.g. `permissions.defaultMode`. */
  key: string;
  label: string;
  /** What the value does, in one or two sentences, for the dashboard. */
  description: string;
  type: SettingType;
  /** The value the agent uses when the key is unset (null = no fixed default). */
  default: unknown;
  options?: string[];
  /** Lowest accepted int. */
  min?: number;
  /** When a change takes effect. */
  appliesOn: string;
}

/**
 * Claude Code settings the dashboard shows and may edit.
 *
 * cleanupPeriodDays has min 1: 0 makes Claude Code keep no transcripts at all,
 * which is not something to set by mistyping in a form.
 */
export const CLAUDE_SETTINGS: readonly SettingSpec[] = [
  {
    key: "cleanupPeriodDays",
    label: "Transcript retention (days)",
    description:
      "Claude Code deletes session transcripts that have been inactive this many days, when it starts. " +
      "Deleted transcripts are gone for good: /resume, prompt history in operad and token totals lose them.",
    type: "int",
    default: 30,
    min: 1,
    appliesOn: "next Claude Code start",
  },
  {
    key: "permissions.defaultMode",
    label: "Default permission mode",
    description: "Permission mode new sessions start in.",
    type: "enum",
    default: "default",
    options: ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"],
    appliesOn: "new sessions",
  },
  {
    key: "effortLevel",
    label: "Effort level",
    description: "Reasoning effort new sessions use.",
    type: "enum",
    default: null,
    options: ["low", "medium", "high", "xhigh", "max"],
    appliesOn: "new sessions",
  },
  {
    key: "alwaysThinkingEnabled",
    label: "Extended thinking",
    description: "Turn extended thinking on by default.",
    type: "bool",
    default: false,
    appliesOn: "new sessions",
  },
  {
    key: "model",
    label: "Default model",
    description: "Model alias or ID new sessions use. Unset uses the account default.",
    type: "string",
    default: null,
    appliesOn: "new sessions",
  },
];

/** One reported setting. `value` is null when unset. */
export interface SettingRow {
  key: string;
  label: string;
  description: string;
  type: SettingType;
  options?: string[];
  min?: number;
  default: unknown;
  value: unknown;
  isSet: boolean;
  appliesOn: string;
  editable: boolean;
}

function getPath(obj: Record<string, unknown> | null, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function rowsFor(specs: readonly SettingSpec[], obj: Record<string, unknown> | null, editable: boolean): SettingRow[] {
  return specs.map((s) => {
    const v = getPath(obj, s.key);
    return {
      key: s.key, label: s.label, description: s.description, type: s.type,
      options: s.options, min: s.min, default: s.default,
      value: v === undefined ? null : v, isSet: v !== undefined,
      appliesOn: s.appliesOn, editable,
    };
  });
}

/** Report every allow-listed Claude Code setting from a parsed settings.json. */
export function describeClaudeSettings(settings: Record<string, unknown> | null): SettingRow[] {
  return rowsFor(CLAUDE_SETTINGS, settings, true);
}

export type Validated = { ok: true; value: unknown } | { ok: false; error: string };

/** Coerce and check a value from the dashboard form against its spec. */
export function validateSettingValue(spec: SettingSpec, raw: unknown): Validated {
  switch (spec.type) {
    case "int": {
      const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isInteger(n)) return { ok: false, error: `${spec.key} must be a whole number` };
      if (spec.min !== undefined && n < spec.min) return { ok: false, error: `${spec.key} must be at least ${spec.min}` };
      return { ok: true, value: n };
    }
    case "bool": {
      if (raw === true || raw === "true") return { ok: true, value: true };
      if (raw === false || raw === "false") return { ok: true, value: false };
      return { ok: false, error: `${spec.key} must be true or false` };
    }
    case "enum": {
      if (typeof raw === "string" && spec.options?.includes(raw)) return { ok: true, value: raw };
      return { ok: false, error: `${spec.key} must be one of ${spec.options?.join(", ")}` };
    }
    case "string": {
      if (typeof raw === "string" && raw.trim() !== "") return { ok: true, value: raw.trim() };
      return { ok: false, error: `${spec.key} must be a non-empty string` };
    }
  }
}

export type ApplyResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Set (or with `raw === null`, remove) one allow-listed key in settings.json.
 *
 * The file is re-read right before the write so edits Claude Code made since
 * the dashboard loaded are kept, and replaced with a rename so a reader never
 * sees a half-written file. An unparseable file is left alone.
 */
export function applyClaudeSetting(settingsPath: string, key: string, raw: unknown): ApplyResult {
  const spec = CLAUDE_SETTINGS.find((s) => s.key === key);
  if (!spec) return { ok: false, error: `${key} is not an editable setting` };

  let value: unknown = undefined;
  if (raw !== null) {
    const v = validateSettingValue(spec, raw);
    if (!v.ok) return v;
    value = v.value;
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: `${settingsPath} is not a JSON object; not rewriting it` };
      }
      settings = parsed as Record<string, unknown>;
    } catch (err) {
      return { ok: false, error: `${settingsPath} does not parse (${(err as Error).message}); not rewriting it` };
    }
  }

  const parts = key.split(".");
  let parent = settings;
  for (const part of parts.slice(0, -1)) {
    const next = parent[part];
    if (next === undefined) {
      if (value === undefined) break; // removing under a missing parent: nothing to do
      parent[part] = {};
    } else if (next === null || typeof next !== "object" || Array.isArray(next)) {
      return { ok: false, error: `${part} in ${settingsPath} is not an object` };
    }
    parent = parent[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (value === undefined) delete parent[leaf];
  else parent[leaf] = value;

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.operad-tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    renameSync(tmp, settingsPath);
  } catch (err) {
    return { ok: false, error: `Failed to write ${settingsPath}: ${(err as Error).message}` };
  }
  return { ok: true, value: value === undefined ? null : value };
}

/** What the current retention period means for the transcripts on disk. */
export interface RetentionReport {
  /** Top-level session transcripts (subagent transcripts are not counted). */
  sessions: number;
  /** Project directories holding at least one. */
  projects: number;
  /** The least recently active transcript and when it becomes deletable. */
  oldest: { path: string; modified: number; deletesAt: number } | null;
  /** Transcripts already past the period: deleted at the next Claude start. */
  overdue: number;
  periodDays: number;
}

const DAY_MS = 86_400_000;

/**
 * Walk `<claude>/projects/<project>/<session>.jsonl` (one level, like Claude
 * Code's own layout) and report the oldest transcript against `periodDays`.
 * Activity is the file's mtime, which is what the cleanup compares.
 */
export function transcriptRetention(projectsDir: string, periodDays: number, now: number): RetentionReport {
  const report: RetentionReport = { sessions: 0, projects: 0, oldest: null, overdue: 0, periodDays };
  let dirs: string[];
  try { dirs = readdirSync(projectsDir); } catch { return report; }
  const cutoff = now - periodDays * DAY_MS;
  for (const d of dirs) {
    let files: string[];
    try { files = readdirSync(join(projectsDir, d)); } catch { continue; }
    let any = false;
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(projectsDir, d, f);
      let mtime: number;
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        mtime = st.mtimeMs;
      } catch { continue; }
      any = true;
      report.sessions++;
      if (mtime < cutoff) report.overdue++;
      if (!report.oldest || mtime < report.oldest.modified) {
        report.oldest = { path: p, modified: mtime, deletesAt: mtime + periodDays * DAY_MS };
      }
    }
    if (any) report.projects++;
  }
  return report;
}

/** Codex settings shown read-only. */
export const CODEX_SETTINGS: readonly SettingSpec[] = [
  { key: "model", label: "Model", description: "Default model.", type: "string", default: null, appliesOn: "new sessions" },
  {
    key: "model_reasoning_effort", label: "Reasoning effort", description: "Default reasoning effort.",
    type: "string", default: null, appliesOn: "new sessions",
  },
  {
    key: "history.persistence", label: "Prompt history",
    description: "save-all keeps prompts in ~/.codex/history.jsonl; none keeps nothing.",
    type: "enum", options: ["save-all", "none"], default: "save-all", appliesOn: "new sessions",
  },
];

/** Report the Codex settings from config.toml (absent or unparseable → all unset). */
export function describeCodexSettings(configPath: string): SettingRow[] {
  let parsed: Record<string, unknown> | null = null;
  try {
    if (existsSync(configPath)) parsed = parseTomlPreferBun(readFileSync(configPath, "utf-8"));
  } catch { parsed = null; }
  return rowsFor(CODEX_SETTINGS, parsed, false);
}
