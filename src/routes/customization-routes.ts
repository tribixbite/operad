/**
 * customization-routes.ts — Customization REST API route handlers.
 *
 * Handles reading/writing Claude customization data: MCP servers (read-only list),
 * plugins, skills, plans, CLAUDE.md files, hooks, and marketplace data.
 * Also handles individual file read/write for skills and CLAUDE.md files.
 *
 * Extracted from RestHandler (rest-handler.ts) as part of domain split.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import type { OrchestratorContext } from "../orchestrator-context.js";
import type { SessionConfig } from "../types.js";
import { parseRecentProjects } from "../registry.js";

/** Regex for env key names that should be redacted in API responses */
const SENSITIVE_ENV_KEYS = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;

/**
 * CustomizationRoutes — handles GET /api/customization, GET/POST /api/customization-file.
 *
 * Constructor takes OrchestratorContext so it can inspect config sessions and
 * the dynamic registry to validate allowed file paths.
 */
export class CustomizationRoutes {
  constructor(private readonly ctx: OrchestratorContext) {}

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Read a JSON file, returning null on any error */
  readJsonFile(path: string): unknown {
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }

  /** Validate that a file path is safe to read/write (under ~/.claude/ or a known project) */
  isAllowedCustomizationPath(filePath: string): boolean {
    const home = homedir();
    const claudeDir = join(home, ".claude");
    const resolved = resolve(filePath);

    if (resolved.startsWith(claudeDir + "/")) return true;

    const knownPaths = this.ctx.config.sessions
      .map((s: SessionConfig) => s.path)
      .filter(Boolean) as string[];
    for (const entry of this.ctx.registry.entries()) {
      if (entry.path) knownPaths.push(entry.path);
    }
    for (const p of knownPaths) {
      const projectDir = resolve(p);
      if (resolved === join(projectDir, "CLAUDE.md")) return true;
      if (resolved.startsWith(join(projectDir, ".claude") + "/")) return true;
    }
    return false;
  }

  /** Redact sensitive env values */
  redactEnv(env: Record<string, string>): Record<string, string> {
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      redacted[k] = SENSITIVE_ENV_KEYS.test(k) ? "***" : v;
    }
    return redacted;
  }

  // ---------------------------------------------------------------------------
  // Public route methods
  // ---------------------------------------------------------------------------

  /** Build full customization response: MCP servers, plugins, skills, plans, CLAUDE.md, hooks, marketplace */
  cmdCustomization(projectPath?: string): { ok: boolean; data?: unknown; error?: string } {
    try {
      const home = homedir();
      const claudeDir = join(home, ".claude");

      const claudeJson = this.readJsonFile(join(home, ".claude.json")) as Record<string, unknown> | null;
      const settingsJson = this.readJsonFile(join(claudeDir, "settings.json")) as Record<string, unknown> | null;
      const installedPluginsJson = this.readJsonFile(join(claudeDir, "plugins", "installed_plugins.json")) as Record<string, unknown> | null;
      const blocklistJson = this.readJsonFile(join(claudeDir, "plugins", "blocklist.json")) as Record<string, unknown> | null;
      const installCountsJson = this.readJsonFile(join(claudeDir, "plugins", "install-counts-cache.json")) as Record<string, unknown> | null;
      const marketplacesJson = this.readJsonFile(join(claudeDir, "plugins", "known_marketplaces.json")) as Record<string, unknown> | null;

      const mcpServers: Array<{
        name: string; scope: string; source: string; command: string;
        args: string[]; env?: Record<string, string>; disabled: boolean;
      }> = [];

      const cjMcps = (claudeJson?.mcpServers ?? {}) as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
      for (const [n, cfg] of Object.entries(cjMcps)) {
        mcpServers.push({
          name: n, scope: "user", source: "claude-json",
          command: cfg.command ?? "", args: cfg.args ?? [],
          env: cfg.env ? this.redactEnv(cfg.env) : undefined,
          disabled: false,
        });
      }

      const sjMcps = ((settingsJson?.mcpServers ?? {}) as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>);
      for (const [n, cfg] of Object.entries(sjMcps)) {
        const existing = mcpServers.find(m => m.name === n);
        if (existing) {
          existing.source = "settings-json";
          existing.command = cfg.command ?? existing.command;
          existing.args = cfg.args ?? existing.args;
          if (cfg.env) existing.env = this.redactEnv(cfg.env);
        } else {
          mcpServers.push({
            name: n, scope: "user", source: "settings-json",
            command: cfg.command ?? "", args: cfg.args ?? [],
            env: cfg.env ? this.redactEnv(cfg.env) : undefined,
            disabled: false,
          });
        }
      }

      if (projectPath && claudeJson?.projects) {
        const projects = claudeJson.projects as Record<string, { disabledMcpServers?: string[]; mcpServers?: Record<string, unknown> }>;
        const projCfg = projects[projectPath];
        if (projCfg?.disabledMcpServers) {
          for (const disabledName of projCfg.disabledMcpServers) {
            const srv = mcpServers.find(m => m.name === disabledName);
            if (srv) srv.disabled = true;
          }
        }
        if (projCfg?.mcpServers) {
          for (const [n, cfg] of Object.entries(projCfg.mcpServers as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>)) {
            mcpServers.push({
              name: n, scope: "project", source: "claude-json",
              command: cfg.command ?? "", args: cfg.args ?? [],
              env: cfg.env ? this.redactEnv(cfg.env) : undefined,
              disabled: false,
            });
          }
        }
      }

      const enabledPlugins = (settingsJson?.enabledPlugins ?? {}) as Record<string, boolean>;
      const blocklist = ((blocklistJson?.plugins ?? []) as Array<{ plugin: string; reason?: string }>);
      const blockMap = new Map(blocklist.map(b => [b.plugin, b.reason ?? "blocked"]));
      const installCounts = ((installCountsJson?.counts ?? []) as Array<{ plugin: string; unique_installs: number }>);
      const countMap = new Map(installCounts.map(c => [c.plugin, c.unique_installs]));

      const plugins: Array<{
        id: string; name: string; description: string; author: string; scope: string;
        enabled: boolean; blocked: boolean; blockReason?: string; version: string;
        installedAt: string; installPath: string; type: string; installs?: number;
      }> = [];

      const installedMap = ((installedPluginsJson?.plugins ?? {}) as Record<string, Array<{
        scope?: string; installPath?: string; version?: string; installedAt?: string;
      }>>);

      for (const [pluginId, entries] of Object.entries(installedMap)) {
        const entry = entries[0];
        if (!entry) continue;
        let pluginName = pluginId.split("@")[0];
        let pluginDesc = "";
        let pluginAuthor = "";
        let pluginType: "native" | "external" = "native";

        if (entry.installPath) {
          const pjPath = join(entry.installPath, ".claude-plugin", "plugin.json");
          const pj = this.readJsonFile(pjPath) as { name?: string; description?: string; author?: { name?: string } } | null;
          if (pj) {
            pluginName = pj.name ?? pluginName;
            pluginDesc = pj.description ?? "";
            pluginAuthor = pj.author?.name ?? "";
          }
          if (existsSync(join(entry.installPath, ".mcp.json"))) {
            pluginType = "external";
          }
        }

        plugins.push({
          id: pluginId, name: pluginName, description: pluginDesc,
          author: pluginAuthor, scope: entry.scope ?? "user",
          enabled: enabledPlugins[pluginId] ?? false,
          blocked: blockMap.has(pluginId),
          blockReason: blockMap.get(pluginId),
          version: entry.version ?? "", installedAt: entry.installedAt ?? "",
          installPath: entry.installPath ?? "", type: pluginType,
          installs: countMap.get(pluginId),
        });
      }

      const skills: Array<{ name: string; path: string; scope: string; source?: string }> = [];
      const userSkillsDir = join(claudeDir, "skills");
      if (existsSync(userSkillsDir)) {
        try {
          for (const f of readdirSync(userSkillsDir)) {
            if (!f.endsWith(".md")) continue;
            skills.push({ name: f.replace(/\.md$/, ""), path: join(userSkillsDir, f), scope: "user" });
          }
        } catch { /* skip */ }
      }
      if (projectPath) {
        const projSkillsDir = join(projectPath, ".claude", "skills");
        if (existsSync(projSkillsDir)) {
          try {
            for (const f of readdirSync(projSkillsDir)) {
              if (!f.endsWith(".md")) continue;
              skills.push({ name: f.replace(/\.md$/, ""), path: join(projSkillsDir, f), scope: "project" });
            }
          } catch { /* skip */ }
        }
      }

      const plans: Array<{ name: string; path: string; scope: string }> = [];
      const userPlansDir = join(claudeDir, "plans");
      if (existsSync(userPlansDir)) {
        try {
          for (const f of readdirSync(userPlansDir)) {
            if (!f.endsWith(".md")) continue;
            plans.push({ name: f.replace(/\.md$/, ""), path: join(userPlansDir, f), scope: "user" });
          }
        } catch { /* skip */ }
      }
      if (projectPath) {
        const projPlansDir = join(projectPath, ".claude", "plans");
        if (existsSync(projPlansDir)) {
          try {
            for (const f of readdirSync(projPlansDir)) {
              if (!f.endsWith(".md")) continue;
              plans.push({ name: f.replace(/\.md$/, ""), path: join(projPlansDir, f), scope: "project" });
            }
          } catch { /* skip */ }
        }
      }

      const claudeMds: Array<{ label: string; path: string; scope: string }> = [];
      const globalMd = join(claudeDir, "CLAUDE.md");
      if (existsSync(globalMd)) {
        claudeMds.push({ label: "Global (User)", path: globalMd, scope: "user" });
      }
      const projectsDir = join(claudeDir, "projects");
      if (existsSync(projectsDir)) {
        try {
          const mangledProject = projectPath
            ? "-" + projectPath.replace(/[/.]/g, "-").replace(/^-+/, "")
            : null;
          for (const d of readdirSync(projectsDir)) {
            if (mangledProject && d !== mangledProject) continue;
            const memDir = join(projectsDir, d, "memory");
            if (!existsSync(memDir)) continue;
            const gitIdx = d.lastIndexOf("-git-");
            const projName = gitIdx >= 0
              ? d.slice(gitIdx + 5)
              : d.split("-").filter(Boolean).pop() ?? d;
            try {
              for (const f of readdirSync(memDir)) {
                if (!f.endsWith(".md")) continue;
                claudeMds.push({ label: `${projName}: ${f.replace(/\.md$/, "")}`, path: join(memDir, f), scope: "memory" });
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
      if (projectPath) {
        const projMd = join(projectPath, "CLAUDE.md");
        if (existsSync(projMd)) {
          claudeMds.push({ label: `Project: ${projectPath.split("/").pop() ?? projectPath}`, path: projMd, scope: "project" });
        }
      }

      const hooks: Array<{ event: string; matcher: string; type: string; command: string; timeout?: number; scope: "user" | "project" }> = [];
      const hooksConfig = (settingsJson?.hooks ?? {}) as Record<string, Array<{
        matcher?: string;
        hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
      }>>;
      for (const [event, matchers] of Object.entries(hooksConfig)) {
        if (!Array.isArray(matchers)) continue;
        for (const m of matchers) {
          if (!m.hooks || !Array.isArray(m.hooks)) continue;
          for (const h of m.hooks) {
            hooks.push({ event, matcher: m.matcher ?? "*", type: h.type ?? "command", command: h.command ?? "", timeout: h.timeout, scope: "user" });
          }
        }
      }

      // Merge project-scoped hooks from <projectPath>/.claude/settings.json
      if (projectPath) {
        const projSettingsPath = join(projectPath, ".claude", "settings.json");
        const projSettings = this.readJsonFile(projSettingsPath) as Record<string, unknown> | null;
        const projHooksConfig = (projSettings?.hooks ?? {}) as Record<string, Array<{
          matcher?: string;
          hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
        }>>;
        for (const [event, matchers] of Object.entries(projHooksConfig)) {
          if (!Array.isArray(matchers)) continue;
          for (const m of matchers) {
            if (!m.hooks || !Array.isArray(m.hooks)) continue;
            for (const h of m.hooks) {
              hooks.push({ event, matcher: m.matcher ?? "*", type: h.type ?? "command", command: h.command ?? "", timeout: h.timeout, scope: "project" });
            }
          }
        }
      }

      const marketplaceSources: Array<{ name: string; repo: string; lastUpdated: string }> = [];
      const marketplacePlugins: Array<{
        id: string; name: string; description: string; author: string;
        marketplace: string; type: string; installed: boolean; enabled: boolean; installs: number;
      }> = [];
      const installedIds = new Set(Object.keys(installedMap));

      if (marketplacesJson) {
        for (const [mktName, mktCfg] of Object.entries(marketplacesJson as Record<string, {
          source?: { repo?: string }; installLocation?: string; lastUpdated?: string;
        }>)) {
          marketplaceSources.push({ name: mktName, repo: mktCfg.source?.repo ?? "", lastUpdated: mktCfg.lastUpdated ?? "" });
          const mktDir = mktCfg.installLocation;
          if (!mktDir || !existsSync(mktDir)) continue;
          for (const [subDir, pluginType] of [["plugins", "native"], ["external_plugins", "external"]] as [string, string][]) {
            const dir = join(mktDir, subDir);
            if (!existsSync(dir)) continue;
            try {
              for (const n of readdirSync(dir)) {
                const pj = this.readJsonFile(join(dir, n, ".claude-plugin", "plugin.json")) as { name?: string; description?: string; author?: { name?: string } } | null;
                if (!pj) continue;
                const pluginId = `${n}@${mktName}`;
                marketplacePlugins.push({
                  id: pluginId, name: pj.name ?? n,
                  description: pj.description ?? "", author: pj.author?.name ?? "",
                  marketplace: mktName, type: pluginType,
                  installed: installedIds.has(pluginId),
                  enabled: enabledPlugins[pluginId] ?? false,
                  installs: countMap.get(pluginId) ?? 0,
                });
              }
            } catch { /* skip */ }
          }
        }
      }
      marketplacePlugins.sort((a, b) => b.installs - a.installs);

      return {
        ok: true,
        data: {
          mcpServers, plugins, skills, plans, claudeMds, hooks,
          marketplace: { sources: marketplaceSources, available: marketplacePlugins },
          projectPath: projectPath ?? undefined,
        },
      };
    } catch (err) {
      return { ok: false, error: `Failed to read customization data: ${err}` };
    }
  }

  /**
   * Enumerate hooks, skills, and plans from EVERY known project (from history.jsonl).
   * Returns a structured response with user-level and per-project entries.
   * Only projects that have at least one hook/skill/plan are included.
   */
  cmdAllProjectsCustomization(): { ok: boolean; data?: unknown; error?: string } {
    try {
      const home = homedir();
      const claudeDir = join(home, ".claude");

      // --- User-level data ---
      const userSettingsJson = this.readJsonFile(join(claudeDir, "settings.json")) as Record<string, unknown> | null;
      const userHooks: Array<{ event: string; matcher: string; type: string; command: string; timeout?: number; scope: "user" | "project" }> = [];
      const userHooksConfig = (userSettingsJson?.hooks ?? {}) as Record<string, Array<{
        matcher?: string;
        hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
      }>>;
      for (const [event, matchers] of Object.entries(userHooksConfig)) {
        if (!Array.isArray(matchers)) continue;
        for (const m of matchers) {
          if (!m.hooks || !Array.isArray(m.hooks)) continue;
          for (const h of m.hooks) {
            userHooks.push({ event, matcher: m.matcher ?? "*", type: h.type ?? "command", command: h.command ?? "", timeout: h.timeout, scope: "user" });
          }
        }
      }

      const userSkills: Array<{ name: string; path: string; scope: "user" | "project"; source?: string }> = [];
      const userSkillsDir = join(claudeDir, "skills");
      if (existsSync(userSkillsDir)) {
        try {
          for (const f of readdirSync(userSkillsDir)) {
            if (!f.endsWith(".md")) continue;
            userSkills.push({ name: f.replace(/\.md$/, ""), path: join(userSkillsDir, f), scope: "user" });
          }
        } catch { /* skip */ }
      }

      const userPlans: Array<{ name: string; path: string; scope: "user" | "project" }> = [];
      const userPlansDir = join(claudeDir, "plans");
      if (existsSync(userPlansDir)) {
        try {
          for (const f of readdirSync(userPlansDir)) {
            if (!f.endsWith(".md")) continue;
            userPlans.push({ name: f.replace(/\.md$/, ""), path: join(userPlansDir, f), scope: "user" });
          }
        } catch { /* skip */ }
      }

      // --- Per-project data ---
      const historyPath = join(claudeDir, "history.jsonl");
      const recentProjects = parseRecentProjects(historyPath, 1000);

      // Deduplicate project paths (history may have the same path multiple times)
      const seenPaths = new Set<string>();
      const projectEntries: Array<{
        path: string;
        name: string;
        hooks: typeof userHooks;
        skills: typeof userSkills;
        plans: typeof userPlans;
      }> = [];

      for (const proj of recentProjects) {
        if (!proj.path || seenPaths.has(proj.path)) continue;
        seenPaths.add(proj.path);
        if (!existsSync(proj.path)) continue;

        const projClaudeDir = join(proj.path, ".claude");
        const projHooks: typeof userHooks = [];
        const projSkills: typeof userSkills = [];
        const projPlans: typeof userPlans = [];

        // Read project settings.json for hooks
        const projSettings = this.readJsonFile(join(projClaudeDir, "settings.json")) as Record<string, unknown> | null;
        if (projSettings) {
          const projHooksConfig = (projSettings.hooks ?? {}) as Record<string, Array<{
            matcher?: string;
            hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
          }>>;
          for (const [event, matchers] of Object.entries(projHooksConfig)) {
            if (!Array.isArray(matchers)) continue;
            for (const m of matchers) {
              if (!m.hooks || !Array.isArray(m.hooks)) continue;
              for (const h of m.hooks) {
                projHooks.push({ event, matcher: m.matcher ?? "*", type: h.type ?? "command", command: h.command ?? "", timeout: h.timeout, scope: "project" });
              }
            }
          }
        }

        // Read project skills
        const projSkillsDir = join(projClaudeDir, "skills");
        if (existsSync(projSkillsDir)) {
          try {
            for (const f of readdirSync(projSkillsDir)) {
              if (!f.endsWith(".md")) continue;
              projSkills.push({ name: f.replace(/\.md$/, ""), path: join(projSkillsDir, f), scope: "project" });
            }
          } catch { /* skip */ }
        }

        // Read project plans
        const projPlansDir = join(projClaudeDir, "plans");
        if (existsSync(projPlansDir)) {
          try {
            for (const f of readdirSync(projPlansDir)) {
              if (!f.endsWith(".md")) continue;
              projPlans.push({ name: f.replace(/\.md$/, ""), path: join(projPlansDir, f), scope: "project" });
            }
          } catch { /* skip */ }
        }

        // Only include projects that have at least one hook/skill/plan
        if (projHooks.length === 0 && projSkills.length === 0 && projPlans.length === 0) continue;

        projectEntries.push({
          path: proj.path,
          name: proj.name || basename(proj.path),
          hooks: projHooks,
          skills: projSkills,
          plans: projPlans,
        });
      }

      return {
        ok: true,
        data: {
          user: { hooks: userHooks, skills: userSkills, plans: userPlans },
          projects: projectEntries,
        },
      };
    } catch (err) {
      return { ok: false, error: `Failed to read all-projects customization: ${err}` };
    }
  }

  /** Read a customization file's content (skills, CLAUDE.md) */
  cmdReadCustomizationFile(filePath: string): { ok: boolean; data?: unknown; error?: string } {
    if (!filePath || !this.isAllowedCustomizationPath(filePath)) {
      return { ok: false, error: "Path not allowed" };
    }
    try {
      const content = readFileSync(filePath, "utf-8");
      return { ok: true, data: { content } };
    } catch (err) {
      return { ok: false, error: `Failed to read file: ${err}` };
    }
  }

  /** Write a customization file's content (only .md files) */
  cmdWriteCustomizationFile(filePath: string, content: string): { ok: boolean; data?: unknown; error?: string } {
    if (!filePath || !this.isAllowedCustomizationPath(filePath)) {
      return { ok: false, error: "Path not allowed" };
    }
    if (!filePath.endsWith(".md")) {
      return { ok: false, error: "Only .md files can be edited" };
    }
    try {
      writeFileSync(filePath, content, "utf-8");
      return { ok: true, data: { written: filePath } };
    } catch (err) {
      return { ok: false, error: `Failed to write file: ${err}` };
    }
  }
}
