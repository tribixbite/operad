/**
 * customization-routes.ts — Customization REST API route handlers.
 *
 * Handles reading/writing Claude customization data: MCP servers (read-only list),
 * plugins, skills, plans, CLAUDE.md files, hooks, and marketplace data.
 * Also handles individual file read/write for skills and CLAUDE.md files.
 *
 * Extracted from RestHandler (rest-handler.ts) as part of domain split.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import type { OrchestratorContext } from "../orchestrator-context.js";
import type { SessionConfig } from "../types.js";
import { parseRecentProjects } from "../registry.js";

/** File metadata attached to skill/plan/memory/etc. entries. */
interface FileMeta {
  /** mtime in epoch ms, or null if stat failed. */
  modified: number | null;
  /** Size in bytes, or null if stat failed. */
  size: number | null;
}

function statMeta(path: string): FileMeta {
  try {
    const s = statSync(path);
    return { modified: s.mtimeMs, size: s.size };
  } catch {
    return { modified: null, size: null };
  }
}

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
      if (resolved === join(projectDir, "AGENTS.md")) return true; // OpenCode/Codex/Claude cross-compat
      if (resolved.startsWith(join(projectDir, ".claude") + "/")) return true;
    }
    // User-level AGENTS.md at $HOME/AGENTS.md (rare but supported by some tools)
    if (resolved === join(home, "AGENTS.md")) return true;
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

      const skills: Array<{ name: string; path: string; scope: string; source?: string; modified: number | null; size: number | null }> = [];
      const userSkillsDir = join(claudeDir, "skills");
      if (existsSync(userSkillsDir)) {
        try {
          for (const f of readdirSync(userSkillsDir)) {
            if (!f.endsWith(".md")) continue;
            const p = join(userSkillsDir, f);
            skills.push({ name: f.replace(/\.md$/, ""), path: p, scope: "user", ...statMeta(p) });
          }
        } catch { /* skip */ }
      }
      if (projectPath) {
        const projSkillsDir = join(projectPath, ".claude", "skills");
        if (existsSync(projSkillsDir)) {
          try {
            for (const f of readdirSync(projSkillsDir)) {
              if (!f.endsWith(".md")) continue;
              const p = join(projSkillsDir, f);
              skills.push({ name: f.replace(/\.md$/, ""), path: p, scope: "project", ...statMeta(p) });
            }
          } catch { /* skip */ }
        }
      }

      // Helper: scan a directory for .md files and push each as a metadata-tagged
      // entry. Used by plans/commands/agentsMd/memories — the dashboard now displays
      // last-modified and size next to each entry, so every list builder needs the
      // FileMeta. (Skills uses a slightly richer shape with `source` and is built
      // separately above.)
      type FileEntry = { name: string; path: string; scope: string; modified: number | null; size: number | null };
      const scanMdInto = (dir: string, scope: "user" | "project", out: FileEntry[]) => {
        if (!existsSync(dir)) return;
        try {
          for (const f of readdirSync(dir)) {
            if (!f.endsWith(".md")) continue;
            const p = join(dir, f);
            out.push({ name: f.replace(/\.md$/, ""), path: p, scope, ...statMeta(p) });
          }
        } catch { /* skip */ }
      };

      const plans: FileEntry[] = [];
      scanMdInto(join(claudeDir, "plans"), "user", plans);
      if (projectPath) scanMdInto(join(projectPath, ".claude", "plans"), "project", plans);

      // Slash commands — user-defined commands invoked via '/name' in Claude Code.
      //   ~/.claude/commands/*.md          (user-global)
      //   <project>/.claude/commands/*.md  (project-scoped)
      const commands: FileEntry[] = [];
      scanMdInto(join(claudeDir, "commands"), "user", commands);
      if (projectPath) scanMdInto(join(projectPath, ".claude", "commands"), "project", commands);

      // Claude Code subagents — markdown files with frontmatter that define
      // specialised worker agents invocable via the Task tool.
      //   ~/.claude/agents/*.md            (user-global)
      //   <project>/.claude/agents/*.md    (project-scoped)
      const agentsMd: FileEntry[] = [];
      scanMdInto(join(claudeDir, "agents"), "user", agentsMd);
      if (projectPath) scanMdInto(join(projectPath, ".claude", "agents"), "project", agentsMd);

      // AGENTS.md — cross-tool instructions file (https://agents.md). Read by
      // Claude Code, Codex, OpenCode, and others as a standard project context
      // document. Separate entry from CLAUDE.md so the UI can show both.
      //   <project>/AGENTS.md              (project root, cross-tool standard)
      //   ~/AGENTS.md                      (rarely used, but supported by some tools)
      const agentsMdFiles: Array<{
        label: string; path: string; scope: string;
        /** Which tools read this location */
        consumers: string[];
        modified: number | null;
        size: number | null;
      }> = [];
      if (projectPath) {
        const projAgents = join(projectPath, "AGENTS.md");
        if (existsSync(projAgents)) {
          agentsMdFiles.push({
            label: `Project: ${projectPath.split("/").pop() ?? projectPath}`,
            path: projAgents,
            scope: "project",
            consumers: ["Claude Code", "Codex", "OpenCode"],
            ...statMeta(projAgents),
          });
        }
        // Some projects stash a per-project override under ~/.claude/projects/{mangled}/AGENTS.md
        const mangled = "-" + projectPath.replace(/[/.]/g, "-").replace(/^-+/, "");
        const projectOverride = join(claudeDir, "projects", mangled, "AGENTS.md");
        if (existsSync(projectOverride)) {
          agentsMdFiles.push({
            label: `Claude project override`,
            path: projectOverride,
            scope: "claude-project-override",
            consumers: ["Claude Code"],
            ...statMeta(projectOverride),
          });
        }
      }
      const homeAgents = join(process.env.HOME ?? homedir(), "AGENTS.md");
      if (existsSync(homeAgents)) {
        agentsMdFiles.push({
          label: "Home",
          path: homeAgents,
          scope: "user",
          consumers: ["Claude Code", "Codex", "OpenCode"],
          ...statMeta(homeAgents),
        });
      }

      // Memory files come from three places:
      //   ~/.claude/memories/*.md                              — user-authored notes (scope=user)
      //   <project>/.claude/memories/*.md                      — project-authored notes (scope=project)
      //   ~/.claude/projects/{mangled}/memory/*.md             — auto-memory snapshots (scope=auto)
      //                                                          (gotchas.md, MEMORY.md, etc. — written by
      //                                                          Claude per the user's auto-memory hook)
      // All three are surfaced through the same Memories panel; CLAUDE.md keeps only the
      // actual CLAUDE.md files (global + project-root) — no longer the auto-memory mix.
      const memories: FileEntry[] = [];
      scanMdInto(join(claudeDir, "memories"), "user", memories);
      if (projectPath) scanMdInto(join(projectPath, ".claude", "memories"), "project", memories);

      // Auto-memory snapshots — written by the user's auto-memory system per
      // the global CLAUDE.md instructions. When a project is in scope, only
      // that project's snapshots show; classified as scope="project" so the
      // Memories panel routes them to the project tab. Without a project
      // selected, every known project's snapshots load — they show up in the
      // user tab as a flat global dump, prefixed with the project name to
      // keep them disambiguated.
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
                const p = join(memDir, f);
                memories.push({
                  name: mangledProject ? f.replace(/\.md$/, "") : `${projName}/${f.replace(/\.md$/, "")}`,
                  path: p,
                  scope: mangledProject ? "project" : "user",
                  ...statMeta(p),
                });
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }

      const claudeMds: Array<{ label: string; path: string; scope: string; modified: number | null; size: number | null }> = [];
      const globalMd = join(claudeDir, "CLAUDE.md");
      if (existsSync(globalMd)) {
        claudeMds.push({ label: "Global (User)", path: globalMd, scope: "user", ...statMeta(globalMd) });
      }
      if (projectPath) {
        const projMd = join(projectPath, "CLAUDE.md");
        if (existsSync(projMd)) {
          claudeMds.push({ label: `Project: ${projectPath.split("/").pop() ?? projectPath}`, path: projMd, scope: "project", ...statMeta(projMd) });
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
          mcpServers, plugins,
          skills, plans, commands, agentsMd, memories,
          claudeMds, agentsMdFiles,
          hooks,
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

      // Helpers — keep the per-directory scan logic in one place so commands,
      // agents, skills, plans, and memories all share the same ignore rules.
      // Each entry carries modified + size so the dashboard can render mtime
      // and file-size columns in place of the (now icon-collapsed) path.
      const listMd = (dir: string, scope: "user" | "project"): Array<{
        name: string; path: string; scope: "user" | "project";
        modified: number | null; size: number | null;
      }> => {
        if (!existsSync(dir)) return [];
        try {
          return readdirSync(dir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => {
              const p = join(dir, f);
              return { name: f.replace(/\.md$/, ""), path: p, scope, ...statMeta(p) };
            });
        } catch {
          return [];
        }
      };

      const readHooksFrom = (
        settingsJson: Record<string, unknown> | null,
        scope: "user" | "project",
      ): Array<{ event: string; matcher: string; type: string; command: string; timeout?: number; scope: "user" | "project" }> => {
        const out: Array<{ event: string; matcher: string; type: string; command: string; timeout?: number; scope: "user" | "project" }> = [];
        if (!settingsJson) return out;
        const hooksConfig = (settingsJson.hooks ?? {}) as Record<string, Array<{
          matcher?: string;
          hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
        }>>;
        for (const [event, matchers] of Object.entries(hooksConfig)) {
          if (!Array.isArray(matchers)) continue;
          for (const m of matchers) {
            if (!m.hooks || !Array.isArray(m.hooks)) continue;
            for (const h of m.hooks) {
              out.push({ event, matcher: m.matcher ?? "*", type: h.type ?? "command", command: h.command ?? "", timeout: h.timeout, scope });
            }
          }
        }
        return out;
      };

      // --- User-level data ---
      const userSettingsJson = this.readJsonFile(join(claudeDir, "settings.json")) as Record<string, unknown> | null;
      const userHooks = readHooksFrom(userSettingsJson, "user");
      const userSkills = listMd(join(claudeDir, "skills"), "user");
      const userPlans = listMd(join(claudeDir, "plans"), "user");
      const userCommands = listMd(join(claudeDir, "commands"), "user");
      const userAgentsMd = listMd(join(claudeDir, "agents"), "user");
      const userMemories = listMd(join(claudeDir, "memories"), "user");
      const userAgentsMdFiles: Array<{ label: string; path: string; scope: string; consumers: string[]; modified: number | null; size: number | null }> = [];
      const homeAgentsMd = join(process.env.HOME ?? home, "AGENTS.md");
      if (existsSync(homeAgentsMd)) {
        userAgentsMdFiles.push({
          label: "Home",
          path: homeAgentsMd,
          scope: "user",
          consumers: ["Claude Code", "Codex", "OpenCode"],
          ...statMeta(homeAgentsMd),
        });
      }
      const homeClaudeMd = join(claudeDir, "CLAUDE.md");
      const userClaudeMds: Array<{ label: string; path: string; scope: string; modified: number | null; size: number | null }> = [];
      if (existsSync(homeClaudeMd)) {
        userClaudeMds.push({ label: "Global (User)", path: homeClaudeMd, scope: "user", ...statMeta(homeClaudeMd) });
      }

      // --- Per-project data ---
      const historyPath = join(claudeDir, "history.jsonl");
      const recentProjects = parseRecentProjects(historyPath, 1000);

      const seenPaths = new Set<string>();
      const projectEntries: Array<{
        path: string;
        name: string;
        hooks: typeof userHooks;
        skills: typeof userSkills;
        plans: typeof userPlans;
        commands: typeof userCommands;
        agentsMd: typeof userAgentsMd;
        memories: typeof userMemories;
        claudeMd?: { path: string; modified: number | null; size: number | null };
        agentsMdFile?: { path: string; consumers: string[]; modified: number | null; size: number | null };
      }> = [];

      for (const proj of recentProjects) {
        if (!proj.path || seenPaths.has(proj.path)) continue;
        seenPaths.add(proj.path);
        if (!existsSync(proj.path)) continue;

        const projClaudeDir = join(proj.path, ".claude");
        const projSettings = this.readJsonFile(join(projClaudeDir, "settings.json")) as Record<string, unknown> | null;

        const projHooks = readHooksFrom(projSettings, "project");
        const projSkills = listMd(join(projClaudeDir, "skills"), "project");
        const projPlans = listMd(join(projClaudeDir, "plans"), "project");
        const projCommands = listMd(join(projClaudeDir, "commands"), "project");
        const projAgentsMd = listMd(join(projClaudeDir, "agents"), "project");
        const projMemories = listMd(join(projClaudeDir, "memories"), "project");
        // Auto-memory snapshots for this project (~/.claude/projects/{mangled}/memory/*.md).
        // The mangled key is the project path with /., replaced by - and any leading -
        // stripped, mirroring how Claude Code records the project in history.jsonl.
        const mangled = "-" + proj.path.replace(/[/.]/g, "-").replace(/^-+/, "");
        const autoMemDir = join(claudeDir, "projects", mangled, "memory");
        if (existsSync(autoMemDir)) {
          try {
            for (const f of readdirSync(autoMemDir)) {
              if (!f.endsWith(".md")) continue;
              const p = join(autoMemDir, f);
              projMemories.push({
                name: f.replace(/\.md$/, ""),
                path: p,
                // Cast to "project" because the projectEntry type is fixed; the
                // dashboard treats anything in projMemories as project-scope. Auto
                // snapshots do live under each project conceptually.
                scope: "project",
                ...statMeta(p),
              });
            }
          } catch { /* skip */ }
        }

        const projClaudeMdPath = join(proj.path, "CLAUDE.md");
        const projClaudeMd = existsSync(projClaudeMdPath)
          ? { path: projClaudeMdPath, ...statMeta(projClaudeMdPath) }
          : undefined;

        const projAgentsMdPath = join(proj.path, "AGENTS.md");
        const projAgentsMdFile = existsSync(projAgentsMdPath)
          ? { path: projAgentsMdPath, consumers: ["Claude Code", "Codex", "OpenCode"], ...statMeta(projAgentsMdPath) }
          : undefined;

        // Include the project only if it has something interesting.
        const total =
          projHooks.length + projSkills.length + projPlans.length +
          projCommands.length + projAgentsMd.length + projMemories.length +
          (projClaudeMd ? 1 : 0) + (projAgentsMdFile ? 1 : 0);
        if (total === 0) continue;

        projectEntries.push({
          path: proj.path,
          name: proj.name || basename(proj.path),
          hooks: projHooks,
          skills: projSkills,
          plans: projPlans,
          commands: projCommands,
          agentsMd: projAgentsMd,
          memories: projMemories,
          claudeMd: projClaudeMd,
          agentsMdFile: projAgentsMdFile,
        });
      }

      return {
        ok: true,
        data: {
          user: {
            hooks: userHooks,
            skills: userSkills,
            plans: userPlans,
            commands: userCommands,
            agentsMd: userAgentsMd,
            memories: userMemories,
            claudeMds: userClaudeMds,
            agentsMdFiles: userAgentsMdFiles,
          },
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
