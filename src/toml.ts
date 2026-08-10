/**
 * toml.ts — dependency-free TOML subset parser.
 *
 * Extracted from config.ts so the skills adapter can share it. Both need to
 * read TOML, and the adapter previously threw PROVIDER_READ_FAILED on any
 * runtime without Bun's built-in TOML — which is every `node` invocation of
 * the shipped bundle (`#!/usr/bin/env node`), so no skill carrying an
 * `operad.toml` could be installed there at all.
 *
 * Callers should prefer Bun's TOML when available (see `parseTomlPreferBun`)
 * and fall back to this. It covers the subset operad emits and consumes:
 * `[section]`, `[[array]]`, scalar/array values, and `#` comments.
 */

/**
 * Minimal TOML parser — handles the subset we use:
 * - [section] and [[array]] headers
 * - key = "string", key = number, key = bool, key = ["array"]
 * - # comments, blank lines
 */
export function parseTomlMinimal(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let currentSection: Record<string, unknown> = root;
  let currentPath: string[] = [];
  let isArrayTable = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Array table: [[section]]
    const arrayMatch = line.match(/^\[\[([^\]]+)\]\]$/);
    if (arrayMatch) {
      isArrayTable = true;
      currentPath = arrayMatch[1].split(".");
      const newItem: Record<string, unknown> = {};

      // Navigate to parent, creating along the way
      let target = root;
      for (let i = 0; i < currentPath.length - 1; i++) {
        if (!(currentPath[i] in target)) target[currentPath[i]] = {};
        target = target[currentPath[i]] as Record<string, unknown>;
      }

      const key = currentPath[currentPath.length - 1];
      if (!(key in target)) target[key] = [];
      (target[key] as unknown[]).push(newItem);
      currentSection = newItem;
      continue;
    }

    // Table: [section]
    const tableMatch = line.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      isArrayTable = false;
      currentPath = tableMatch[1].split(".");

      // If current array table context and this is a sub-section like [session.env]
      // attach to the last array item
      if (currentPath[0] === "session" && currentPath.length > 1) {
        const sessions = root["session"] as unknown[] | undefined;
        if (sessions && sessions.length > 0) {
          const lastSession = sessions[sessions.length - 1] as Record<string, unknown>;
          const subKey = currentPath.slice(1).join(".");
          if (!(subKey in lastSession)) lastSession[subKey] = {};
          currentSection = lastSession[subKey] as Record<string, unknown>;
          continue;
        }
      }

      // Navigate/create nested path
      let target = root;
      for (const segment of currentPath) {
        if (!(segment in target)) target[segment] = {};
        target = target[segment] as Record<string, unknown>;
      }
      currentSection = target;
      continue;
    }

    // Key = value
    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      currentSection[key] = parseTomlValue(rawValue.trim());
    }
  }

  return root;
}

/** Parse a TOML value (string, number, bool, array) */
export function parseTomlValue(raw: string): unknown {
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Array
  if (raw.startsWith("[")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => parseTomlValue(s.trim()));
  }
  // Number
  const num = Number(raw);
  if (!isNaN(num)) return num;
  // Fallback: treat as string
  return raw;
}

/**
 * Parse TOML using Bun's native parser when present, else the minimal one.
 * Single place for the runtime probe so callers do not each re-implement it.
 */
export function parseTomlPreferBun(content: string): Record<string, unknown> {
  const g = globalThis as Record<string, unknown>;
  const bun = g.Bun as Record<string, unknown> | undefined;
  if (bun && typeof bun.TOML === "object" && bun.TOML !== null) {
    const toml = bun.TOML as { parse: (s: string) => Record<string, unknown> };
    return toml.parse(content);
  }
  return parseTomlMinimal(content);
}
