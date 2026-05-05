/**
 * config-overrides.ts — runtime-mutable overlay layered on top of TOML.
 *
 * The TOML config (`~/.config/operad/operad.toml`) is the source of truth
 * for things the user explicitly authored: sessions, ADB block, battery,
 * etc. But a few knobs are "preference" rather than "structure" — SDK
 * defaults, quota thresholds, things the dashboard's Settings form
 * should be able to mutate without rewriting TOML.
 *
 * Rather than writing TOML (risky: comment loss, formatting drift, race
 * conditions with the user's editor), we keep these in a JSON overlay
 * at `<state-dir>/config-overrides.json`. The daemon merges them on top
 * of the TOML at boot; the REST PATCH endpoint writes them atomically.
 *
 * The shape is intentionally narrow: only the fields that are safe to
 * mutate from a UI. New keys require an explicit allow-list update here
 * + a daemon-side consumer.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The full overlay shape. Every field is optional — a missing key means
 * "use the TOML value (or the daemon's hard-coded default)". Adding a
 * field here is one of two changes; the other is teaching the daemon to
 * prefer the overlay over the TOML for that field.
 */
export interface ConfigOverrides {
  /** SDK bridge defaults applied to every new SDK query. */
  sdk?: {
    effort?: "low" | "medium" | "high" | "max";
    thinking?: "adaptive" | "enabled" | "disabled";
    /** Max USD budget per query. 0 = unlimited. */
    max_budget_usd?: number;
    /** Override model name. Empty string / undefined = SDK default. */
    model?: string;
  };
  /** Quota tracking thresholds (percent of weekly token budget). */
  quota?: {
    /** Warning band, e.g. 80 (default). */
    warning_pct?: number;
    /** Critical band, e.g. 95 (default). */
    critical_pct?: number;
    /** Override TOML's quota_weekly_tokens. */
    weekly_tokens?: number;
  };
}

/**
 * Default empty overlay. Returned when no overlay file exists or the
 * file is malformed — callers can always treat this as a clean baseline.
 */
const EMPTY: ConfigOverrides = Object.freeze({});

/** Resolve the overlay path from the state-dir. */
export function overridesPathFor(stateFile: string): string {
  return join(dirname(stateFile), "config-overrides.json");
}

/**
 * Read the overlay. Returns the parsed object, or the empty overlay
 * when the file is missing / corrupt. Never throws — a bad overlay
 * shouldn't prevent the daemon from booting; the user can still fix
 * via TOML or the REST endpoint will overwrite next time.
 */
export function loadOverrides(stateFile: string): ConfigOverrides {
  const path = overridesPathFor(stateFile);
  if (!existsSync(path)) return EMPTY;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ConfigOverrides;
    return sanitise(raw);
  } catch {
    return EMPTY;
  }
}

/**
 * Atomically merge `patch` into the overlay file. Existing keys not
 * mentioned in `patch` are preserved. Sub-objects (sdk, quota) are
 * shallow-merged — passing `{ sdk: { effort: "max" } }` keeps the
 * user's existing sdk.thinking / sdk.model values intact.
 *
 * Atomic via temp-file-then-rename so a daemon crash mid-write can't
 * leave a half-written JSON file.
 */
export function patchOverrides(stateFile: string, patch: ConfigOverrides): ConfigOverrides {
  const current = loadOverrides(stateFile);
  const merged: ConfigOverrides = {
    sdk: { ...current.sdk, ...patch.sdk },
    quota: { ...current.quota, ...patch.quota },
  };
  // Strip empty sub-objects so the file stays tidy.
  if (!merged.sdk || Object.keys(merged.sdk).length === 0) delete merged.sdk;
  if (!merged.quota || Object.keys(merged.quota).length === 0) delete merged.quota;
  saveOverrides(stateFile, merged);
  return merged;
}

/** Atomically replace the overlay file (used by tests and full resets). */
export function saveOverrides(stateFile: string, overrides: ConfigOverrides): void {
  const path = overridesPathFor(stateFile);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(sanitise(overrides), null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Validate + coerce the input shape. Anything that doesn't match the
 * documented contract is dropped silently — we'd rather lose a bad
 * field than persist garbage that crashes the daemon on next boot.
 */
function sanitise(raw: unknown): ConfigOverrides {
  if (!raw || typeof raw !== "object") return EMPTY;
  const r = raw as Record<string, unknown>;
  const out: ConfigOverrides = {};
  if (r.sdk && typeof r.sdk === "object") {
    const s = r.sdk as Record<string, unknown>;
    const sdk: ConfigOverrides["sdk"] = {};
    if (s.effort === "low" || s.effort === "medium" || s.effort === "high" || s.effort === "max") {
      sdk.effort = s.effort;
    }
    if (s.thinking === "adaptive" || s.thinking === "enabled" || s.thinking === "disabled") {
      sdk.thinking = s.thinking;
    }
    if (typeof s.max_budget_usd === "number" && Number.isFinite(s.max_budget_usd) && s.max_budget_usd >= 0) {
      sdk.max_budget_usd = s.max_budget_usd;
    }
    if (typeof s.model === "string") sdk.model = s.model;
    if (Object.keys(sdk).length > 0) out.sdk = sdk;
  }
  if (r.quota && typeof r.quota === "object") {
    const q = r.quota as Record<string, unknown>;
    const quota: ConfigOverrides["quota"] = {};
    for (const key of ["warning_pct", "critical_pct", "weekly_tokens"] as const) {
      const v = q[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) quota[key] = v;
    }
    if (Object.keys(quota).length > 0) out.quota = quota;
  }
  return out;
}
