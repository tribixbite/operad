/**
 * customization-transfer.ts — export/import of a machine's Claude Code
 * customization layer, for migrating a local environment between machines.
 *
 * Why this exists: the dashboard could already "export" skills and plugins,
 * but neither payload was re-importable.
 *
 *   • The skills export listed absolute *paths* and no file content, so on a
 *     new machine it named files that did not exist.
 *   • The plugins export carried no marketplace source, so a plugin id like
 *     `superpowers@claude-plugins-official` could not be resolved back to the
 *     repo it came from.
 *
 * This module produces a self-contained, versioned bundle that actually round
 * trips, and an importer that applies it.
 *
 * Scope boundary — what import does NOT do: it does not clone plugin
 * repositories or run any installer. Plugin installation belongs to Claude
 * Code. Import registers the *intent* (marketplace sources in
 * known_marketplaces.json plus the enabledPlugins map in settings.json) and
 * Claude Code materialises the plugins on next launch. Fabricating
 * installed_plugins.json entries pointing at install paths that do not exist
 * on the target machine would leave Claude Code with a broken plugin table.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { realpathSync } from "node:fs";

/** Bump only for incompatible changes; importers accept older versions. */
export const BUNDLE_FORMAT_VERSION = 1;
export const BUNDLE_KIND = "operad-customization-bundle";

/** Document collections that live as markdown under ~/.claude/<name>/ */
export const DOC_COLLECTIONS = [
  "skills",
  "commands",
  "agents",
  "plans",
  "memories",
] as const;
export type DocCollection = (typeof DOC_COLLECTIONS)[number];

/**
 * One markdown document.
 *
 * `rel_path` is relative to the collection root and carries the layout, so
 * both supported skill shapes survive a round trip:
 *   flat       → "bun-web-dev.md"
 *   directory  → "brainstorming/SKILL.md"  (plus any sibling reference files)
 */
export interface BundleDocument {
  collection: DocCollection;
  scope: "user" | "project";
  rel_path: string;
  content: string;
}

/** A Claude Code plugin marketplace (source repo → local install location). */
export interface BundleMarketplace {
  name: string;
  /** Verbatim `source` object from known_marketplaces.json. */
  source: Record<string, unknown>;
}

/** An installed plugin, identified as `<plugin>@<marketplace>`. */
export interface BundlePlugin {
  id: string;
  name: string;
  marketplace: string | null;
  version: string;
  enabled: boolean;
  scope: string;
}

/** An MCP server entry from ~/.claude.json / settings.json. */
export interface BundleMcpServer {
  name: string;
  scope: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  disabled: boolean;
}

export interface CustomizationBundle {
  kind: typeof BUNDLE_KIND;
  format_version: number;
  meta: {
    exported_at: string;
    exported_from: string;
    operad_version: string;
  };
  documents: BundleDocument[];
  marketplaces: BundleMarketplace[];
  plugins: BundlePlugin[];
  mcp_servers: BundleMcpServer[];
}

// ── Path safety ─────────────────────────────────────────────────────────────

/**
 * Is `rel` safe to join onto a collection root?
 *
 * Bundle files are untrusted input — a hand-edited or hostile bundle could
 * carry `rel_path: "../../../.ssh/authorized_keys"`. Every component must be
 * an ordinary name: no traversal, no absolute paths, no separators-as-content,
 * no control characters, and (on Windows) no drive letters or reserved names.
 */
export function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.length > 512) return false;
  if (rel.startsWith("/") || rel.startsWith("\\")) return false;
  // Drive-qualified or UNC path (Windows).
  if (/^[a-zA-Z]:/.test(rel)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(rel)) return false;

  const parts = rel.split(/[/\\]/);
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return false;
    // Trailing dots/spaces are stripped by Windows, enabling collisions.
    if (/[. ]$/.test(part)) return false;
  }
  return true;
}

/** Only these extensions are exported/imported as documents. */
const DOC_EXTENSIONS = [".md", ".markdown", ".txt"];

/** Does this filename look like a customization document? */
export function isDocumentFile(name: string): boolean {
  if (name.startsWith(".")) return false;
  const lower = name.toLowerCase();
  return DOC_EXTENSIONS.some((e) => lower.endsWith(e));
}

// ── Collection scanning ─────────────────────────────────────────────────────

/** Directories are walked this deep (skill dirs hold SKILL.md + references/). */
const MAX_COLLECTION_DEPTH = 3;

/**
 * Recursively collect documents under a collection root.
 *
 * Handles both layouts operad has to deal with:
 *   • flat files            ~/.claude/skills/foo.md
 *   • directory bundles     ~/.claude/skills/foo/SKILL.md
 *
 * Symlinked entries are followed (statSync, not lstatSync) because installing
 * a skill library by symlinking a shared directory into ~/.claude/skills is a
 * common setup and those skills are otherwise silently unexportable.
 */
export function collectDocuments(
  root: string,
  collection: DocCollection,
  scope: "user" | "project",
): BundleDocument[] {
  const out: BundleDocument[] = [];
  if (!existsSync(root)) return out;

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > MAX_COLLECTION_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue; // broken symlink or permission error
      }
      if (isDir) {
        walk(abs, rel, depth + 1);
        continue;
      }
      if (!isDocumentFile(name)) continue;
      try {
        out.push({
          collection,
          scope,
          rel_path: rel,
          content: readFileSync(abs, "utf-8"),
        });
      } catch {
        // unreadable file — skip rather than fail the whole export
      }
    }
  };

  walk(root, "", 0);
  return out;
}

// ── Export ──────────────────────────────────────────────────────────────────

export interface ExportSources {
  /** Overrides homedir() — for tests. */
  home?: string;
  /** Optional project whose .claude/ dir is also captured. */
  projectPath?: string;
  operadVersion?: string;
  /** Timestamp for the bundle; defaults to now. */
  now?: Date;
  /** Pre-collected plugin/mcp data from the customization route. */
  plugins?: BundlePlugin[];
  mcpServers?: BundleMcpServer[];
}

/** Read known_marketplaces.json into bundle form. */
export function readMarketplaces(home: string): BundleMarketplace[] {
  const p = join(home, ".claude", "plugins", "known_marketplaces.json");
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<
      string,
      { source?: Record<string, unknown> }
    >;
    return Object.entries(raw)
      .filter(([, v]) => v && typeof v === "object" && v.source)
      .map(([name, v]) => ({ name, source: v.source as Record<string, unknown> }));
  } catch {
    return [];
  }
}

/**
 * Read operad's version from the package.json next to the running bundle.
 *
 * Recorded in the bundle so an import can tell which operad produced it.
 * Uses realpathSync so a symlinked global install (~/.local/bin/operad)
 * resolves to the real package root.
 */
export function resolveOperadVersion(): string {
  const candidates = [
    join(dirname(realpathSync(__filename)), "..", "package.json"),
    join(dirname(__filename), "..", "package.json"),
    join(dirname(__filename), "..", "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return "unknown";
}

/** Build a complete, re-importable bundle of this machine's customization. */
export function buildBundle(opts: ExportSources = {}): CustomizationBundle {
  const home = opts.home ?? homedir();
  const claudeDir = join(home, ".claude");

  const documents: BundleDocument[] = [];
  for (const collection of DOC_COLLECTIONS) {
    documents.push(
      ...collectDocuments(join(claudeDir, collection), collection, "user"),
    );
    if (opts.projectPath) {
      documents.push(
        ...collectDocuments(
          join(opts.projectPath, ".claude", collection),
          collection,
          "project",
        ),
      );
    }
  }

  return {
    kind: BUNDLE_KIND,
    format_version: BUNDLE_FORMAT_VERSION,
    meta: {
      exported_at: (opts.now ?? new Date()).toISOString(),
      exported_from: hostname(),
      operad_version: opts.operadVersion ?? resolveOperadVersion(),
    },
    documents,
    marketplaces: readMarketplaces(home),
    plugins: opts.plugins ?? [],
    mcp_servers: opts.mcpServers ?? [],
  };
}

// ── Import ──────────────────────────────────────────────────────────────────

export interface ImportOptions {
  /** Report what would happen without touching disk. */
  dryRun?: boolean;
  /** Replace files that already exist (default: skip them). */
  overwrite?: boolean;
  /** Restrict to these collections (default: all). */
  collections?: DocCollection[];
  /** Register marketplaces + enabledPlugins (default true). */
  includePlugins?: boolean;
  /**
   * Import MCP server definitions (default false).
   *
   * Exports redact secret-looking env values to "***", so importing blind
   * would overwrite working credentials with a literal "***". Opt-in, and
   * redacted values are dropped with a warning even then.
   */
  includeMcp?: boolean;
  /** Target project for scope:"project" documents. */
  projectPath?: string;
  /** Overrides homedir() — for tests. */
  home?: string;
}

export interface ImportReport {
  written: string[];
  skipped: { path: string; reason: string }[];
  marketplaces_added: string[];
  plugins_enabled: string[];
  mcp_servers_added: string[];
  warnings: string[];
}

/**
 * Validate that a parsed JSON value is a bundle this importer understands.
 * Returns an error string, or null when the value is acceptable.
 */
export function validateBundle(value: unknown): string | null {
  if (!value || typeof value !== "object") return "bundle must be a JSON object";
  const b = value as Partial<CustomizationBundle>;
  if (b.kind !== BUNDLE_KIND) {
    return `unrecognised bundle kind '${String(b.kind)}' (expected '${BUNDLE_KIND}')`;
  }
  if (typeof b.format_version !== "number") {
    return "bundle is missing a numeric format_version";
  }
  if (b.format_version > BUNDLE_FORMAT_VERSION) {
    return `bundle format_version ${b.format_version} is newer than supported ${BUNDLE_FORMAT_VERSION} — upgrade operad`;
  }
  if (b.documents !== undefined && !Array.isArray(b.documents)) {
    return "bundle.documents must be an array";
  }
  return null;
}

/** Merge `entries` into a JSON object file, creating it when absent. */
function mergeJsonFile(
  path: string,
  mutate: (obj: Record<string, unknown>) => void,
  dryRun: boolean,
): void {
  let obj: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      // Must be a plain object. `typeof [] === "object"` is true, and
      // assigning a key to an array is silently dropped by JSON.stringify —
      // the merge would appear to succeed and write nothing.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed file — start from an empty object rather than throwing away
      // the import. The original is overwritten only when not a dry run.
    }
  }
  mutate(obj);
  if (dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, "utf-8");
}

/**
 * Apply a bundle to this machine.
 *
 * Never throws on individual-item problems — every rejected item is recorded
 * in the report so the caller can show exactly what did and did not transfer.
 */
export function importBundle(
  bundle: CustomizationBundle,
  opts: ImportOptions = {},
): ImportReport {
  const home = opts.home ?? homedir();
  const claudeDir = join(home, ".claude");
  const dryRun = opts.dryRun ?? false;
  const overwrite = opts.overwrite ?? false;
  const includePlugins = opts.includePlugins ?? true;
  const includeMcp = opts.includeMcp ?? false;
  const allowed = new Set<DocCollection>(opts.collections ?? DOC_COLLECTIONS);

  const report: ImportReport = {
    written: [],
    skipped: [],
    marketplaces_added: [],
    plugins_enabled: [],
    mcp_servers_added: [],
    warnings: [],
  };

  // -- documents ------------------------------------------------------------
  for (const doc of bundle.documents ?? []) {
    if (!DOC_COLLECTIONS.includes(doc.collection)) {
      report.skipped.push({
        path: String(doc.rel_path),
        reason: `unknown collection '${doc.collection}'`,
      });
      continue;
    }
    if (!allowed.has(doc.collection)) {
      report.skipped.push({
        path: doc.rel_path,
        reason: `collection '${doc.collection}' not selected`,
      });
      continue;
    }
    if (!isSafeRelPath(doc.rel_path)) {
      report.skipped.push({
        path: String(doc.rel_path),
        reason: "unsafe path (traversal or absolute path rejected)",
      });
      continue;
    }
    if (typeof doc.content !== "string") {
      report.skipped.push({ path: doc.rel_path, reason: "missing content" });
      continue;
    }

    let root: string;
    if (doc.scope === "project") {
      if (!opts.projectPath) {
        report.skipped.push({
          path: doc.rel_path,
          reason: "project-scoped document but no target project selected",
        });
        continue;
      }
      root = join(opts.projectPath, ".claude", doc.collection);
    } else {
      root = join(claudeDir, doc.collection);
    }

    const target = join(root, doc.rel_path);
    if (existsSync(target) && !overwrite) {
      report.skipped.push({ path: target, reason: "already exists" });
      continue;
    }
    if (dryRun) {
      report.written.push(target);
      continue;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, doc.content, "utf-8");
      report.written.push(target);
    } catch (err) {
      report.skipped.push({
        path: target,
        reason: `write failed: ${(err as Error).message}`,
      });
    }
  }

  // -- marketplaces + plugin enablement ------------------------------------
  if (includePlugins) {
    const marketplaces = bundle.marketplaces ?? [];
    if (marketplaces.length > 0) {
      const kmPath = join(claudeDir, "plugins", "known_marketplaces.json");
      mergeJsonFile(
        kmPath,
        (obj) => {
          for (const mp of marketplaces) {
            if (!mp?.name || typeof mp.name !== "string") continue;
            // Never trust an exported installLocation — it is an absolute path
            // from the source machine. Point it at this machine's plugin dir
            // and let Claude Code populate it.
            if (obj[mp.name] && !overwrite) continue;
            obj[mp.name] = {
              source: mp.source,
              installLocation: join(claudeDir, "plugins", "marketplaces", mp.name),
            };
            report.marketplaces_added.push(mp.name);
          }
        },
        dryRun,
      );
    }

    const enabled = (bundle.plugins ?? []).filter((p) => p?.id && p.enabled);
    if (enabled.length > 0) {
      const settingsPath = join(claudeDir, "settings.json");
      mergeJsonFile(
        settingsPath,
        (obj) => {
          const map = (obj.enabledPlugins ?? {}) as Record<string, boolean>;
          for (const p of enabled) {
            if (map[p.id] === true && !overwrite) continue;
            map[p.id] = true;
            report.plugins_enabled.push(p.id);
          }
          obj.enabledPlugins = map;
        },
        dryRun,
      );
      report.warnings.push(
        `${enabled.length} plugin(s) marked enabled. Claude Code installs them from their marketplace on next launch — operad does not clone plugin repos.`,
      );
    }
  }

  // -- MCP servers ----------------------------------------------------------
  if (includeMcp) {
    const servers = (bundle.mcp_servers ?? []).filter((s) => s?.name && s.command);
    if (servers.length > 0) {
      const claudeJson = join(home, ".claude.json");
      mergeJsonFile(
        claudeJson,
        (obj) => {
          const map = (obj.mcpServers ?? {}) as Record<string, unknown>;
          for (const s of servers) {
            if (map[s.name] && !overwrite) continue;
            const env: Record<string, string> = {};
            let redacted = 0;
            for (const [k, v] of Object.entries(s.env ?? {})) {
              // The exporter replaces secret-looking values with "***".
              // Writing that through would break the server with a
              // plausible-looking credential.
              if (v === "***") {
                redacted++;
                continue;
              }
              env[k] = v;
            }
            if (redacted > 0) {
              report.warnings.push(
                `MCP server '${s.name}': ${redacted} redacted env value(s) omitted — set them manually.`,
              );
            }
            map[s.name] = {
              command: s.command,
              args: s.args ?? [],
              ...(Object.keys(env).length > 0 ? { env } : {}),
            };
            report.mcp_servers_added.push(s.name);
          }
          obj.mcpServers = map;
        },
        dryRun,
      );
    }
  } else if ((bundle.mcp_servers ?? []).length > 0) {
    report.warnings.push(
      `${bundle.mcp_servers.length} MCP server(s) in the bundle were not imported (enable "include MCP servers" — note that secret env values are redacted at export).`,
    );
  }

  return report;
}
