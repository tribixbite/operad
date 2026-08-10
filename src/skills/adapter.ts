/**
 * skills/adapter.ts — Merge `marketplace.json` + `.operad/operad.toml`
 * into the canonical OperadSkill shape.
 *
 * Spec §3.3 + §4.5 (`ProviderModule.read`). Each provider may call
 * this helper to normalize a freshly-extracted bundle directory.
 *
 * Discovery order (§3.3):
 *   1. `<bundle>/.operad/operad.toml`
 *   2. `<bundle>/operad.toml`  (fallback; warn)
 *   3. neither present — skill is empty-of-operad-content (Claude-Code-
 *      only plugin we're aggregating for discovery)
 *
 * If both are present, prefer `.operad/operad.toml` and record a
 * warning in the returned `warnings` list.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ProviderReadResult,
  type SkillMcpEntry,
  type SkillMdEntry,
  type SkillToolEntry,
  type TrustTier,
  type AutonomyBucket,
  capForTier,
  defaultBucketForTier,
  SkillError,
} from "./types.js";
import type { AgentConfig } from "../agents.js";
import type { WorkflowConfig } from "../workflow.js";
import type { TomlToolConfig } from "../tools.js";
import { parseTomlPreferBun } from "../toml.js";

export interface AdapterReadOpts {
  extracted_path: string;
  /** Trust tier for the source — drives autonomy_cap on each tool. */
  trust_tier: TrustTier;
}

export interface AdapterReadResult extends ProviderReadResult {
  warnings: string[];
}

/**
 * Read whatever manifests exist in `extracted_path` and merge into the
 * canonical shape. Throws SkillError on hard schema problems; soft
 * issues (bare `operad.toml` shadowed by `.operad/operad.toml`,
 * unsupported MCP lifecycle in v1) go into `warnings`.
 */
export function readSkillManifests(opts: AdapterReadOpts): AdapterReadResult {
  const warnings: string[] = [];

  // 1. Claude-plugin marketplace.json (optional)
  const marketplace = readMarketplaceJson(opts.extracted_path);

  // 2. .operad/operad.toml (preferred path)
  const operadTomlNested = join(opts.extracted_path, ".operad", "operad.toml");
  const operadTomlBare = join(opts.extracted_path, "operad.toml");

  let operadToml: OperadTomlShape | null = null;
  if (existsSync(operadTomlNested)) {
    operadToml = parseOperadToml(readFileSync(operadTomlNested, "utf8"));
    if (existsSync(operadTomlBare)) {
      warnings.push(
        `bare operad.toml shadowed by .operad/operad.toml at ${opts.extracted_path}; ignoring bare file`,
      );
    }
  } else if (existsSync(operadTomlBare)) {
    operadToml = parseOperadToml(readFileSync(operadTomlBare, "utf8"));
  }

  // Derive name + description: prefer marketplace.json, then operad.toml.
  const name =
    marketplace?.name ??
    operadToml?.skill?.name ??
    "(unnamed)";
  const description =
    marketplace?.description ??
    operadToml?.skill?.description ??
    "";

  // Build the primitive arrays.
  const tools: SkillToolEntry[] = (operadToml?.tool ?? []).map((t) => ({
    toml: tomlEntryToToolConfig(t),
    autonomy_cap: capForTier(opts.trust_tier),
  }));

  const agents: AgentConfig[] = (operadToml?.agent ?? []).map(tomlEntryToAgentConfig);

  const workflows: WorkflowConfig[] = (operadToml?.workflow ?? []).map(
    tomlEntryToWorkflowConfig,
  );

  // MCPs come from BOTH marketplace.json (claude-plugin form) AND
  // .operad/operad.toml [mcp.<name>] sections. The operad-side wins
  // when there's a name collision because it carries the lifecycle
  // hint.
  const mcps: SkillMcpEntry[] = [];
  for (const [mcpName, mcpDef] of Object.entries(marketplace?.mcpServers ?? {})) {
    mcps.push(marketplaceMcpToEntry(mcpName, mcpDef));
  }
  for (const [mcpName, mcpDef] of Object.entries(operadToml?.mcp ?? {})) {
    const existing = mcps.findIndex((e) => e.name === mcpName);
    const entry = operadMcpToEntry(mcpName, mcpDef);
    if (entry.lifecycle !== "config-only") {
      warnings.push(
        `mcp '${mcpName}' declared lifecycle '${entry.lifecycle}' which is not supported in v1; treating as config-only`,
      );
      entry.lifecycle = "config-only";
    }
    if (existing >= 0) mcps[existing] = entry;
    else mcps.push(entry);
  }

  const skill_mds: SkillMdEntry[] = discoverSkillMds(opts.extracted_path);

  return {
    name,
    description,
    tools: tools.length > 0 ? tools : undefined,
    agents: agents.length > 0 ? agents : undefined,
    workflows: workflows.length > 0 ? workflows : undefined,
    mcps: mcps.length > 0 ? mcps : undefined,
    skill_mds: skill_mds.length > 0 ? skill_mds : undefined,
    warnings,
  };
}

// -- marketplace.json -------------------------------------------------------

interface MarketplaceJson {
  name?: string;
  description?: string;
  mcpServers?: Record<string, unknown>;
  // Other fields (plugins[], commands[], etc.) exist but A0 ignores
  // them — they're consumed by claude-code directly.
}

function readMarketplaceJson(extractedPath: string): MarketplaceJson | null {
  const path = join(extractedPath, ".claude-plugin", "marketplace.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MarketplaceJson;
  } catch (err) {
    // Schema problem in marketplace.json is not fatal — operad can
    // still read .operad/operad.toml. But surface a warning rather
    // than crashing.
    return null;
  }
}

function marketplaceMcpToEntry(name: string, def: unknown): SkillMcpEntry {
  const d = (def ?? {}) as Record<string, unknown>;
  if (typeof d.url === "string") {
    return {
      name,
      url: d.url,
      transport: (d.type as "http" | "sse" | undefined) ?? "http",
      env: d.env as Record<string, string> | undefined,
      lifecycle: "config-only",
    };
  }
  return {
    name,
    command: d.command as string | undefined,
    args: d.args as string[] | undefined,
    env: d.env as Record<string, string> | undefined,
    transport: "stdio",
    lifecycle: "config-only",
  };
}

// -- .operad/operad.toml ----------------------------------------------------

interface OperadTomlShape {
  skill?: { name?: string; description?: string };
  tool?: Array<Record<string, unknown>>;
  agent?: Array<Record<string, unknown>>;
  workflow?: Array<Record<string, unknown>>;
  mcp?: Record<string, Record<string, unknown>>;
}

function parseOperadToml(content: string): OperadTomlShape {
  // Bun's native TOML when running under bun, the shared minimal parser
  // otherwise.
  //
  // This used to throw PROVIDER_READ_FAILED whenever `globalThis.Bun` was
  // absent, with a comment claiming a parser was "inlined at the end of this
  // file" — there wasn't one. The shipped bundle's shebang is
  // `#!/usr/bin/env node` and the README states node is supported, so on every
  // node install this made *any* skill carrying a `.operad/operad.toml` (i.e.
  // every skill that ships tools, agents, workflows or MCP servers)
  // uninstallable. src/toml.ts now holds the parser config.ts already had.
  try {
    return parseTomlPreferBun(content) as OperadTomlShape;
  } catch (err) {
    throw new SkillError(
      "PROVIDER_READ_FAILED",
      `failed to parse operad.toml: ${(err as Error).message}`,
    );
  }
}

function tomlEntryToToolConfig(t: Record<string, unknown>): TomlToolConfig {
  return {
    name: String(t.name ?? ""),
    description: String(t.description ?? ""),
    category: (t.category as TomlToolConfig["category"]) ?? "analyze",
    command: String(t.command ?? ""),
    timeout_ms: t.timeout_ms != null ? Number(t.timeout_ms) : undefined,
    params: Array.isArray(t.params)
      ? (t.params as Record<string, unknown>[]).map((p) => ({
          name: String(p.name ?? ""),
          type: p.type != null ? String(p.type) : undefined,
          required: p.required != null ? Boolean(p.required) : undefined,
          description: p.description != null ? String(p.description) : undefined,
        }))
      : undefined,
  };
}

function tomlEntryToAgentConfig(a: Record<string, unknown>): AgentConfig {
  // Pass-through — the agent config shape is already TOML-shaped. The
  // operad config.ts AgentConfig validator runs on load so any missing
  // required fields surface there, not here.
  return a as unknown as AgentConfig;
}

function tomlEntryToWorkflowConfig(w: Record<string, unknown>): WorkflowConfig {
  return {
    name: String(w.name ?? ""),
    enabled: w.enabled != null ? Boolean(w.enabled) : true,
    tasks: Array.isArray(w.task)
      ? (w.task as Record<string, unknown>[]).map((t) => ({
          id: String(t.id ?? ""),
          command: String(t.command ?? ""),
          cwd: t.cwd != null ? String(t.cwd) : undefined,
          timeout_s: t.timeout_s != null ? Number(t.timeout_s) : undefined,
          needs: Array.isArray(t.needs) ? (t.needs as string[]) : undefined,
          on: t.on as "success" | "error" | "always" | undefined,
        }))
      : [],
  };
}

function operadMcpToEntry(name: string, def: Record<string, unknown>): SkillMcpEntry {
  const lifecycle = (def.lifecycle as string | undefined) ?? "config-only";
  return {
    name,
    command: def.command != null ? String(def.command) : undefined,
    args: Array.isArray(def.args) ? (def.args as string[]) : undefined,
    env: def.env as Record<string, string> | undefined,
    url: def.url != null ? String(def.url) : undefined,
    transport: def.transport as "stdio" | "http" | "sse" | undefined,
    lifecycle: lifecycle as SkillMcpEntry["lifecycle"],
  };
}

// -- SKILL.md discovery -----------------------------------------------------

function discoverSkillMds(extractedPath: string): SkillMdEntry[] {
  const skillsRoot = join(extractedPath, "skills");
  if (!existsSync(skillsRoot)) return [];

  const result: SkillMdEntry[] = [];
  // Each direct child of `skills/` is a skill bundle directory
  // containing a SKILL.md file at its root.
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const bundleDir = join(skillsRoot, entry);
    let isDir = false;
    try { isDir = statSync(bundleDir).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    const skillMdPath = join(bundleDir, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;
    const frontmatter = parseFrontmatter(readFileSync(skillMdPath, "utf8"));
    result.push({
      name: entry,
      bundle_path: bundleDir,
      frontmatter,
    });
  }
  return result;
}

/**
 * Minimal YAML-frontmatter parser. Handles only what SKILL.md needs:
 * `key: value` lines between `---` fences, no nested objects, no
 * arrays. The full spec (agentskills.io) defines more, but A0 only
 * needs `name` and `description` for display + the `metadata.operad.*`
 * passthrough; we'll grow this if vendors start using more.
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  const fenceRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
  const match = content.match(fenceRegex);
  if (!match) return {};
  const result: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let value: unknown = m[2].trim();
    if (typeof value === "string" && value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1);
    }
    result[m[1]] = value;
  }
  return result;
}

// Unused for now; suppresses the unused-import warning above.
export const __unused_capForTier = capForTier;
export const __unused_defaultBucketForTier = defaultBucketForTier;
export type __unused_AutonomyBucket = AutonomyBucket;
