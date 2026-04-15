/**
 * tools.ts — Tool Registry & Built-in Tools for agent tool use
 *
 * Agents emit ```tool blocks that the daemon parses and routes here.
 * Tools are categorized by privilege level and scoped per-agent via
 * autonomy levels and category permissions.
 *
 * Design: tools use fenced-block emission (not SDK tool_use) so agents
 * remain model-agnostic — they output text, the daemon parses.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname, basename, extname } from "node:path";
import { homedir } from "node:os";
import type { MemoryDb } from "./memory-db.js";
import type { Logger } from "./log.js";

// -- Types --------------------------------------------------------------------

/** Tool privilege categories — ordered by increasing destructive potential */
export type ToolCategory =
  | "observe"      // read-only: file listing, git status, system info
  | "analyze"      // compute: search, diff, token counting
  | "mutate"       // write: file edit, git commit, memory manipulation
  | "communicate"  // external: HTTP request, notification
  | "orchestrate"; // meta: session start/stop, agent spawn

/** Where a tool comes from — used for filtering and audit */
export type ToolSource =
  | "builtin"      // hardcoded in tools.ts
  | "toml"         // user-defined in operad.toml [[tool]] section
  | "skill"        // from .claude/skills/ with tool frontmatter
  | "plugin"       // npm package export
  | "mcp";         // MCP server tool bridge

/** Tool parameter definition (JSON Schema subset for validation) */
export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
  default?: unknown;
}

/** Context passed to every tool execution */
export interface ToolContext {
  agentName: string;
  cwd: string;
  db: MemoryDb;
  log: Logger;
  signal: AbortSignal;
  /** Session states for system-status and session tools */
  getSessionStates?: () => Record<string, { status: string; activity: string | null; rss_mb: number | null }>;
  /** Send keys to a tmux pane */
  sendToSession?: (name: string, text: string) => void;
  /** Read last N lines from a tmux session */
  captureSessionOutput?: (name: string, lines: number) => string | null;
  /** System memory info */
  getSystemMemory?: () => { available_mb: number; pressure: string } | null;
  /** Battery info */
  getBattery?: () => { pct: number; charging: boolean } | null;
}

/** Result returned from tool execution */
export interface ToolResult {
  success: boolean;
  data: unknown;
  /** Concise summary for agent consumption (max 2000 chars) */
  summary: string;
  /** List of side effects produced (for audit trail) */
  sideEffects: string[];
  duration_ms: number;
}

/** Full tool definition — registered in the executor */
export interface ToolDef {
  name: string;
  description: string;
  category: ToolCategory;
  params: ToolParam[];
  /** Default execution timeout in ms */
  timeout_ms: number;
  /** Whether this tool can run in parallel with others */
  parallelizable: boolean;
  /** The actual implementation */
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  /** Where this tool came from (default: "builtin") */
  source?: ToolSource;
  /** Identifier for external tools — e.g. "mcp:sqlite", "plugin:my-pkg" */
  sourceId?: string;
}

/**
 * ToolProvider — lifecycle interface for external tool sources.
 * Plugins, MCP servers, and skill loaders implement this to register
 * their tools with the ToolExecutor at daemon startup.
 */
export interface ToolProvider {
  /** Provider name (e.g. "mcp:sqlite", "plugin:my-pkg") */
  name: string;
  /** Tool source type */
  source: ToolSource;
  /** Discover and register tools with the executor */
  initialize(executor: ToolExecutor): Promise<void>;
  /** Clean up connections (called on daemon shutdown) */
  shutdown?(): Promise<void>;
}

/**
 * TOML-defined tool config — user-defined tools in operad.toml [[tool]] sections.
 * Executes shell commands with parameter substitution.
 */
export interface TomlToolConfig {
  name: string;
  description: string;
  category?: ToolCategory;
  command: string;
  timeout_ms?: number;
  params?: Array<{ name: string; type?: string; required?: boolean; description?: string }>;
}

/** Category privilege ordering (lower = safer) */
const CATEGORY_LEVEL: Record<ToolCategory, number> = {
  observe: 0,
  analyze: 1,
  mutate: 2,
  communicate: 3,
  orchestrate: 4,
};

// -- ToolExecutor class -------------------------------------------------------

/**
 * Central tool registry and executor.
 * Manages tool registration, validation, permission checking, and execution.
 */
export class ToolExecutor {
  private tools = new Map<string, ToolDef>();
  private providers: ToolProvider[] = [];
  private db: MemoryDb;
  private log: Logger;

  constructor(db: MemoryDb, log: Logger) {
    this.db = db;
    this.log = log;
    this.registerBuiltinTools();
  }

  /** Register a tool definition */
  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) {
      this.log.warn(`Tool "${tool.name}" already registered, overwriting`);
    }
    // Default source to builtin if not specified
    if (!tool.source) tool.source = "builtin";
    this.tools.set(tool.name, tool);
  }

  /**
   * Register a ToolProvider — external tool source with lifecycle management.
   * Calls provider.initialize() which should call executor.register() for each tool.
   */
  async registerProvider(provider: ToolProvider): Promise<void> {
    try {
      await provider.initialize(this);
      this.providers.push(provider);
      const count = this.getToolsBySource(provider.source).length;
      this.log.info(`Tool provider "${provider.name}" registered ${count} tools`);
    } catch (err) {
      this.log.warn(`Tool provider "${provider.name}" failed to initialize: ${err}`);
    }
  }

  /** Shutdown all registered providers (called on daemon shutdown) */
  async shutdownProviders(): Promise<void> {
    for (const provider of this.providers) {
      try {
        await provider.shutdown?.();
      } catch (err) {
        this.log.warn(`Tool provider "${provider.name}" shutdown error: ${err}`);
      }
    }
    this.providers = [];
  }

  /**
   * Register tools from TOML [[tool]] config sections.
   * Each tool is a shell command with parameter substitution.
   */
  registerTomlTools(tools: TomlToolConfig[]): void {
    for (const t of tools) {
      if (!t.name || !t.command) {
        this.log.warn(`TOML tool missing name or command, skipping`);
        continue;
      }

      const params: ToolParam[] = (t.params ?? []).map((p) => ({
        name: p.name,
        type: (p.type as ToolParam["type"]) || "string",
        required: p.required ?? false,
        description: p.description ?? "",
      }));

      this.register({
        name: t.name,
        description: t.description || `User-defined tool: ${t.name}`,
        category: t.category ?? "analyze",
        params,
        timeout_ms: t.timeout_ms ?? 30_000,
        parallelizable: true,
        source: "toml",
        sourceId: `toml:${t.name}`,
        execute: async (input, _ctx) => {
          const start = Date.now();
          try {
            // Substitute {{param}} placeholders in command
            let cmd = t.command;
            for (const [key, value] of Object.entries(input)) {
              cmd = cmd.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
            }

            const output = execSync(cmd, {
              encoding: "utf-8",
              timeout: t.timeout_ms ?? 30_000,
              maxBuffer: 1024 * 1024,
            }).trim();

            return {
              success: true,
              data: { output },
              summary: output.slice(0, 2000),
              sideEffects: [`exec: ${t.name}`],
              duration_ms: Date.now() - start,
            };
          } catch (err: any) {
            return {
              success: false,
              data: null,
              summary: `Command failed: ${err.message ?? err}`.slice(0, 2000),
              sideEffects: [],
              duration_ms: Date.now() - start,
            };
          }
        },
      });
    }
  }

  /** Get a tool by name */
  getTool(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  /** Get all registered tools */
  getAllTools(): ToolDef[] {
    return Array.from(this.tools.values());
  }

  /** Get tools filtered by source */
  getToolsBySource(source: ToolSource): ToolDef[] {
    return this.getAllTools().filter((t) => t.source === source);
  }

  /**
   * Get tools available to a specific agent based on allowed categories and sources.
   * If allowedCategories is empty/undefined, all categories are allowed.
   * If allowedSources is empty/undefined, all sources are allowed.
   */
  getAvailableTools(allowedCategories?: ToolCategory[], allowedSources?: ToolSource[]): ToolDef[] {
    let tools = this.getAllTools();
    if (allowedCategories && allowedCategories.length > 0) {
      const catSet = new Set(allowedCategories);
      tools = tools.filter((t) => catSet.has(t.category));
    }
    if (allowedSources && allowedSources.length > 0) {
      const srcSet = new Set(allowedSources);
      tools = tools.filter((t) => srcSet.has(t.source ?? "builtin"));
    }
    return tools;
  }

  /**
   * Check if a tool category is auto-approved at a given autonomy scope.
   * Returns true if the tool can run without human approval.
   */
  isAutoApproved(toolCategory: ToolCategory, allowedCategories?: ToolCategory[]): boolean {
    if (allowedCategories && allowedCategories.length > 0) {
      return allowedCategories.includes(toolCategory);
    }
    // Default: observe and analyze are always auto-approved
    return CATEGORY_LEVEL[toolCategory] <= CATEGORY_LEVEL["analyze"];
  }

  /**
   * Execute a tool by name with validated parameters.
   * Logs execution to the audit trail.
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        data: null,
        summary: `Unknown tool: ${toolName}`,
        sideEffects: [],
        duration_ms: 0,
      };
    }

    // Validate required params
    const validationError = this.validateParams(tool, params);
    if (validationError) {
      return {
        success: false,
        data: null,
        summary: `Validation error: ${validationError}`,
        sideEffects: [],
        duration_ms: 0,
      };
    }

    const start = Date.now();
    let result: ToolResult;
    let error: string | undefined;

    try {
      // Execute with timeout via AbortSignal
      const timeoutMs = tool.timeout_ms;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      // Merge signals: caller's + timeout
      const mergedCtx: ToolContext = {
        ...ctx,
        signal: ctx.signal.aborted ? ctx.signal : controller.signal,
      };

      try {
        result = await tool.execute(params, mergedCtx);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const duration_ms = Date.now() - start;
      error = String(err);
      result = {
        success: false,
        data: null,
        summary: `Tool execution failed: ${error}`.slice(0, 2000),
        sideEffects: [],
        duration_ms,
      };
    }

    // Log to audit trail
    try {
      this.db.logToolExecution({
        agent_name: ctx.agentName,
        tool_name: toolName,
        tool_category: tool.category,
        params_json: JSON.stringify(params),
        result_success: result.success,
        result_summary: result.summary,
        side_effects: result.sideEffects,
        duration_ms: result.duration_ms || (Date.now() - start),
        approval: "auto",
        error,
      });
    } catch (logErr) {
      this.log.warn(`Failed to log tool execution: ${logErr}`);
    }

    return result;
  }

  /** Validate tool parameters against definition */
  private validateParams(tool: ToolDef, params: Record<string, unknown>): string | null {
    for (const p of tool.params) {
      if (p.required && !(p.name in params)) {
        return `Missing required parameter: ${p.name}`;
      }
      if (p.name in params) {
        const val = params[p.name];
        if (p.type === "string" && typeof val !== "string") {
          return `Parameter "${p.name}" must be a string`;
        }
        if (p.type === "number" && typeof val !== "number") {
          return `Parameter "${p.name}" must be a number`;
        }
        if (p.type === "boolean" && typeof val !== "boolean") {
          return `Parameter "${p.name}" must be a boolean`;
        }
      }
    }
    return null;
  }

  /** Format tool list for injection into OODA prompt */
  formatToolsForPrompt(allowedCategories?: ToolCategory[], allowedSources?: ToolSource[]): string {
    const tools = this.getAvailableTools(allowedCategories, allowedSources);
    if (tools.length === 0) return "_No tools available._";

    const lines: string[] = [];
    const byCategory = new Map<ToolCategory, ToolDef[]>();
    for (const t of tools) {
      const cat = byCategory.get(t.category) ?? [];
      cat.push(t);
      byCategory.set(t.category, cat);
    }

    for (const [cat, catTools] of byCategory) {
      const autoApproved = CATEGORY_LEVEL[cat] <= CATEGORY_LEVEL["analyze"];
      const label = autoApproved ? "" : " (requires approval)";
      lines.push(`**${cat}**${label}:`);
      for (const t of catTools) {
        const paramStr = t.params
          .filter((p) => p.required)
          .map((p) => p.name)
          .join(", ");
        const optParams = t.params
          .filter((p) => !p.required)
          .map((p) => `${p.name}?`)
          .join(", ");
        const allParams = [paramStr, optParams].filter(Boolean).join(", ");
        const srcTag = t.source && t.source !== "builtin" ? ` [${t.source}]` : "";
        lines.push(`- \`${t.name}\`${srcTag}: ${t.description} (params: ${allParams || "none"})`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // -- Built-in tool registration ---------------------------------------------

  private registerBuiltinTools(): void {
    // === OBSERVE tools (read-only, always auto-approved) ===

    this.register({
      name: "system-status",
      description: "Get current system state: sessions, memory, battery, quota",
      category: "observe",
      params: [],
      timeout_ms: 5_000,
      parallelizable: true,
      execute: async (_input, ctx) => {
        const start = Date.now();
        const sessions = ctx.getSessionStates?.() ?? {};
        const memory = ctx.getSystemMemory?.() ?? null;
        const battery = ctx.getBattery?.() ?? null;

        const sessionSummary = Object.entries(sessions)
          .map(([name, s]) => `${name}: ${s.status}${s.activity ? ` (${s.activity})` : ""}${s.rss_mb ? ` ${s.rss_mb}MB` : ""}`)
          .join("\n");

        const data = { sessions, memory, battery };
        const memStr = memory ? `Memory: ${memory.available_mb}MB (${memory.pressure})` : "Memory: unknown";
        const batStr = battery ? `Battery: ${battery.pct}% ${battery.charging ? "charging" : "discharging"}` : "";

        return {
          success: true,
          data,
          summary: `${Object.keys(sessions).length} sessions\n${sessionSummary}\n${memStr}\n${batStr}`.trim().slice(0, 2000),
          sideEffects: [],
          duration_ms: Date.now() - start,
        };
      },
    });

    this.register({
      name: "file-read",
      description: "Read a file's contents (restricted to project dirs and ~/.claude/)",
      category: "observe",
      params: [
        { name: "path", type: "string", required: true, description: "Absolute file path" },
        { name: "lines", type: "string", required: false, description: "Line range e.g. '1-50' or 'last-20'" },
      ],
      timeout_ms: 10_000,
      parallelizable: true,
      execute: async (input, ctx) => {
        const start = Date.now();
        const filePath = resolve(String(input.path));

        // Path safety: restrict to project dirs and ~/.claude/
        if (!isAllowedPath(filePath)) {
          return { success: false, data: null, summary: `Path not allowed: ${filePath}`, sideEffects: [], duration_ms: Date.now() - start };
        }

        if (!existsSync(filePath)) {
          return { success: false, data: null, summary: `File not found: ${filePath}`, sideEffects: [], duration_ms: Date.now() - start };
        }

        try {
          const content = readFileSync(filePath, "utf-8");
          let lines = content.split("\n");
          const lineSpec = input.lines ? String(input.lines) : "";

          if (lineSpec) {
            const lastMatch = lineSpec.match(/^last-(\d+)$/);
            if (lastMatch) {
              const n = parseInt(lastMatch[1], 10);
              lines = lines.slice(-n);
            } else {
              const rangeMatch = lineSpec.match(/^(\d+)-(\d+)$/);
              if (rangeMatch) {
                const from = Math.max(1, parseInt(rangeMatch[1], 10)) - 1;
                const to = parseInt(rangeMatch[2], 10);
                lines = lines.slice(from, to);
              }
            }
          }

          // Cap output to avoid overwhelming the agent
          const maxLines = 200;
          const truncated = lines.length > maxLines;
          const output = truncated ? lines.slice(0, maxLines) : lines;
          const summary = output.join("\n").slice(0, 2000);

          return {
            success: true,
            data: { path: filePath, lineCount: lines.length, truncated },
            summary: truncated ? `${summary}\n... (${lines.length - maxLines} more lines)` : summary,
            sideEffects: [],
            duration_ms: Date.now() - start,
          };
        } catch (err) {
          return { success: false, data: null, summary: `Read failed: ${err}`, sideEffects: [], duration_ms: Date.now() - start };
        }
      },
    });

    this.register({
      name: "file-list",
      description: "List directory contents with depth control",
      category: "observe",
      params: [
        { name: "path", type: "string", required: true, description: "Directory path" },
        { name: "depth", type: "number", required: false, description: "Max depth (default 1)" },
      ],
      timeout_ms: 10_000,
      parallelizable: true,
      execute: async (input, _ctx) => {
        const start = Date.now();
        const dirPath = resolve(String(input.path));

        if (!isAllowedPath(dirPath)) {
          return { success: false, data: null, summary: `Path not allowed: ${dirPath}`, sideEffects: [], duration_ms: Date.now() - start };
        }

        if (!existsSync(dirPath)) {
          return { success: false, data: null, summary: `Directory not found: ${dirPath}`, sideEffects: [], duration_ms: Date.now() - start };
        }

        const maxDepth = typeof input.depth === "number" ? input.depth : 1;
        const entries: string[] = [];

        function walk(dir: string, depth: number): void {
          if (depth > maxDepth) return;
          try {
            const items = readdirSync(dir);
            for (const item of items) {
              // Skip hidden directories and node_modules at depth > 0
              if (item.startsWith(".") || item === "node_modules") continue;
              const full = join(dir, item);
              try {
                const st = statSync(full);
                const rel = full.slice(dirPath.length + 1);
                entries.push(st.isDirectory() ? `${rel}/` : rel);
                if (st.isDirectory() && depth < maxDepth) {
                  walk(full, depth + 1);
                }
              } catch { /* permission denied or broken symlink */ }
            }
          } catch { /* unreadable directory */ }
        }

        walk(dirPath, 1);

        // Cap entries
        const truncated = entries.length > 200;
        const shown = truncated ? entries.slice(0, 200) : entries;

        return {
          success: true,
          data: { path: dirPath, count: entries.length, truncated },
          summary: shown.join("\n").slice(0, 2000) + (truncated ? `\n... (${entries.length - 200} more)` : ""),
          sideEffects: [],
          duration_ms: Date.now() - start,
        };
      },
    });

    this.register({
      name: "git-status",
      description: "Git status for a directory (branch, dirty files, staged changes)",
      category: "observe",
      params: [
        { name: "path", type: "string", required: true, description: "Git repo path" },
      ],
      timeout_ms: 10_000,
      parallelizable: true,
      execute: async (input, _ctx) => {
        const start = Date.now();
        const repoPath = resolve(String(input.path));

        if (!isAllowedPath(repoPath)) {
          return { success: false, data: null, summary: `Path not allowed: ${repoPath}`, sideEffects: [], duration_ms: Date.now() - start };
        }

        try {
          const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath, encoding: "utf-8", timeout: 5000 }).trim();
          const status = execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8", timeout: 5000 }).trim();
          const dirty = status ? status.split("\n") : [];

          return {
            success: true,
            data: { branch, dirty_count: dirty.length, dirty_files: dirty.slice(0, 50) },
            summary: `Branch: ${branch}\nDirty files: ${dirty.length}\n${dirty.slice(0, 20).join("\n")}`.slice(0, 2000),
            sideEffects: [],
            duration_ms: Date.now() - start,
          };
        } catch (err) {
          return { success: false, data: null, summary: `Git status failed: ${err}`, sideEffects: [], duration_ms: Date.now() - start };
        }
      },
    });

    this.register({
      name: "git-log",
      description: "Recent git commits for a repository",
      category: "observe",
      params: [
        { name: "path", type: "string", required: true, description: "Git repo path" },
        { name: "count", type: "number", required: false, description: "Number of commits (default 10)" },
      ],
      timeout_ms: 10_000,
      parallelizable: true,
      execute: async (input, _ctx) => {
        const start = Date.now();
        const repoPath = resolve(String(input.path));
        const count = typeof input.count === "number" ? Math.min(input.count, 50) : 10;

        if (!isAllowedPath(repoPath)) {
          return { success: false, data: null, summary: `Path not allowed: ${repoPath}`, sideEffects: [], duration_ms: Date.now() - start };
        }

        try {
          const log = execSync(
            `git log --oneline -${count} --format="%h %s"`,
            { cwd: repoPath, encoding: "utf-8", timeout: 5000 },
          ).trim();

          return {
            success: true,
            data: { path: repoPath, count },
            summary: log.slice(0, 2000),
            sideEffects: [],
            duration_ms: Date.now() - start,
          };
        } catch (err) {
          return { success: false, data: null, summary: `Git log failed: ${err}`, sideEffects: [], duration_ms: Date.now() - start };
        }
      },
    });

    this.register({
      name: "session-output",
      description: "Read last N lines from a tmux session pane",
      category: "observe",
      params: [
        { name: "name", type: "string", required: true, description: "Session name" },
        { name: "lines", type: "number", required: false, description: "Number of lines (default 50)" },
      ],
      timeout_ms: 5_000,
      parallelizable: true,
      execute: async (input, ctx) => {
        const start = Date.now();
        const name = String(input.name);
        const lines = typeof input.lines === "number" ? Math.min(input.lines, 200) : 50;

        if (!ctx.captureSessionOutput) {
          return { success: false, data: null, summary: "Session output capture not available", sideEffects: [], duration_ms: Date.now() - start };
        }

        const output = ctx.captureSessionOutput(name, lines);
        if (output === null) {
          return { success: false, data: null, summary: `Session "${name}" not found or not accessible`, sideEffects: [], duration_ms: Date.now() - start };
        }

        return {
          success: true,
          data: { name, lines },
          summary: output.slice(0, 2000),
          sideEffects: [],
          duration_ms: Date.now() - start,
        };
      },
    });

    // === ANALYZE tools (compute, always auto-approved) ===

    this.register({
      name: "grep-search",
      description: "Search file contents by pattern across a directory",
      category: "analyze",
      params: [
        { name: "pattern", type: "string", required: true, description: "Search pattern (regex)" },
        { name: "path", type: "string", required: true, description: "Directory to search" },
        { name: "limit", type: "number", required: false, description: "Max results (default 20)" },
      ],
      timeout_ms: 30_000,
      parallelizable: true,
      execute: async (input, _ctx) => {
        const start = Date.now();
        const searchPath = resolve(String(input.path));
        const pattern = String(input.pattern);
        const limit = typeof input.limit === "number" ? Math.min(input.limit, 100) : 20;

        if (!isAllowedPath(searchPath)) {
          return { success: false, data: null, summary: `Path not allowed: ${searchPath}`, sideEffects: [], duration_ms: Date.now() - start };
        }

        try {
          // Use grep with -r, -n, -I (skip binaries), limited output
          const result = execSync(
            `grep -rnI --include='*.ts' --include='*.js' --include='*.json' --include='*.md' --include='*.toml' --include='*.yaml' --include='*.yml' --include='*.py' --include='*.sh' -- ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)} | head -${limit}`,
            { encoding: "utf-8", timeout: 15000, maxBuffer: 1024 * 1024 },
          ).trim();

          const lines = result ? result.split("\n") : [];
          return {
            success: true,
            data: { pattern, path: searchPath, matchCount: lines.length },
            summary: result.slice(0, 2000) || "No matches found",
            sideEffects: [],
            duration_ms: Date.now() - start,
          };
        } catch (err: any) {
          // grep returns exit code 1 for no matches — that's not an error
          if (err.status === 1) {
            return { success: true, data: { pattern, path: searchPath, matchCount: 0 }, summary: "No matches found", sideEffects: [], duration_ms: Date.now() - start };
          }
          return { success: false, data: null, summary: `Search failed: ${err}`, sideEffects: [], duration_ms: Date.now() - start };
        }
      },
    });

    this.register({
      name: "memory-search",
      description: "Full-text search across project memories (FTS5)",
      category: "analyze",
      params: [
        { name: "query", type: "string", required: true, description: "Search query" },
        { name: "project", type: "string", required: false, description: "Filter by project path" },
        { name: "limit", type: "number", required: false, description: "Max results (default 10)" },
      ],
      timeout_ms: 5_000,
      parallelizable: true,
      execute: async (input, ctx) => {
        const start = Date.now();
        const query = String(input.query);
        const limit = typeof input.limit === "number" ? Math.min(input.limit, 50) : 10;
        const project = input.project ? String(input.project) : "*";

        try {
          // searchMemories requires a project path; use "*" for global search
          const results = ctx.db.searchMemories(project, query, limit);
          const summary = results
            .map((r: import("./memory-db.js").MemoryRecord) =>
              `[${r.category}] ${r.content.slice(0, 100)}${r.content.length > 100 ? "..." : ""} (score: ${r.relevance_score})`)
            .join("\n");

          return {
            success: true,
            data: { query, count: results.length },
            summary: summary.slice(0, 2000) || "No memories found",
            sideEffects: [],
            duration_ms: Date.now() - start,
          };
        } catch (err) {
          return { success: false, data: null, summary: `Memory search failed: ${err}`, sideEffects: [], duration_ms: Date.now() - start };
        }
      },
    });

    this.register({
      name: "diff-files",
      description: "Diff between two files or git refs",
      category: "analyze",
      params: [
        { name: "path", type: "string", required: true, description: "Git repo path or file path" },
        { name: "ref1", type: "string", required: false, description: "First git ref (default HEAD~1)" },
        { name: "ref2", type: "string", required: false, description: "Second git ref (default HEAD)" },
      ],
      timeout_ms: 10_000,
      parallelizable: true,
      execute: async (input, _ctx) => {
        const start = Date.now();
        const repoPath = resolve(String(input.path));
        const ref1 = input.ref1 ? String(input.ref1) : "HEAD~1";
        const ref2 = input.ref2 ? String(input.ref2) : "HEAD";

        if (!isAllowedPath(repoPath)) {
          return { success: false, data: null, summary: `Path not allowed: ${repoPath}`, sideEffects: [], duration_ms: Date.now() - start };
        }

        try {
          const diff = execSync(
            `git diff ${ref1}..${ref2} --stat`,
            { cwd: repoPath, encoding: "utf-8", timeout: 5000 },
          ).trim();

          return {
            success: true,
            data: { path: repoPath, ref1, ref2 },
            summary: diff.slice(0, 2000) || "No differences",
            sideEffects: [],
            duration_ms: Date.now() - start,
          };
        } catch (err) {
          return { success: false, data: null, summary: `Diff failed: ${err}`, sideEffects: [], duration_ms: Date.now() - start };
        }
      },
    });

    // === MUTATE tools (write operations, require approval by default) ===

    this.register({
      name: "file-write",
      description: "Write or overwrite a file (creates backup first)",
      category: "mutate",
      params: [
        { name: "path", type: "string", required: true, description: "Absolute file path" },
        { name: "content", type: "string", required: true, description: "File content to write" },
      ],
      timeout_ms: 10_000,
      parallelizable: false,
      execute: async (input, _ctx) => {
        const start = Date.now();
        const filePath = resolve(String(input.path));
        const content = String(input.content);

        if (!isAllowedPath(filePath)) {
          return { success: false, data: null, summary: `Path not allowed: ${filePath}`, sideEffects: [], duration_ms: Date.now() - start };
        }

        // Reject writes to protected files
        if (isProtectedFile(filePath)) {
          return { success: false, data: null, summary: `Protected file: ${basename(filePath)}`, sideEffects: [], duration_ms: Date.now() - start };
        }

        const sideEffects: string[] = [];

        try {
          // Create backup if file exists
          if (existsSync(filePath)) {
            const backupPath = `${filePath}.bak`;
            const existing = readFileSync(filePath, "utf-8");
            writeFileSync(backupPath, existing);
            sideEffects.push(`backup: ${backupPath}`);
          }

          // Ensure directory exists
          const dir = dirname(filePath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
            sideEffects.push(`created directory: ${dir}`);
          }

          writeFileSync(filePath, content);
          sideEffects.push(`wrote: ${filePath} (${content.length} bytes)`);

          return {
            success: true,
            data: { path: filePath, bytes: content.length },
            summary: `Wrote ${content.length} bytes to ${filePath}`,
            sideEffects,
            duration_ms: Date.now() - start,
          };
        } catch (err) {
          return { success: false, data: null, summary: `Write failed: ${err}`, sideEffects, duration_ms: Date.now() - start };
        }
      },
    });

    this.register({
      name: "memory-create",
      description: "Add a memory to a project's knowledge base",
      category: "mutate",
      params: [
        { name: "project", type: "string", required: true, description: "Project path" },
        { name: "content", type: "string", required: true, description: "Memory content" },
        { name: "category", type: "string", required: false, description: "Category: convention|decision|discovery|warning|user_preference (default discovery)" },
      ],
      timeout_ms: 5_000,
      parallelizable: true,
      execute: async (input, ctx) => {
        const start = Date.now();
        const project = String(input.project);
        const content = String(input.content);
        const category = (input.category as string) || "discovery";

        try {
          const id = ctx.db.createMemory(project, category as any, content);
          return {
            success: true,
            data: { id, project, category },
            summary: `Created memory ${id != null ? `#${id}` : "(deduplicated)"} in ${project}: ${content.slice(0, 100)}`,
            sideEffects: id != null ? [`memory_created: ${id}`] : [],
            duration_ms: Date.now() - start,
          };
        } catch (err) {
          return { success: false, data: null, summary: `Memory creation failed: ${err}`, sideEffects: [], duration_ms: Date.now() - start };
        }
      },
    });

    this.register({
      name: "goal-update",
      description: "Update a goal's status, outcome, or score",
      category: "mutate",
      params: [
        { name: "goal_id", type: "number", required: true, description: "Goal ID" },
        { name: "status", type: "string", required: false, description: "New status: active|completed|failed|blocked" },
        { name: "outcome", type: "string", required: false, description: "Actual outcome description" },
        { name: "score", type: "number", required: false, description: "Success score 0.0-1.0" },
      ],
      timeout_ms: 5_000,
      parallelizable: true,
      execute: async (input, ctx) => {
        const start = Date.now();
        const goalId = Number(input.goal_id);

        try {
          ctx.db.updateGoal(goalId, {
            status: input.status as string | undefined,
            actualOutcome: input.outcome as string | undefined,
            successScore: input.score as number | undefined,
          });
          return {
            success: true,
            data: { goal_id: goalId },
            summary: `Updated goal #${goalId}${input.status ? ` → ${input.status}` : ""}${input.score != null ? ` score=${input.score}` : ""}`,
            sideEffects: [`goal_updated: ${goalId}`],
            duration_ms: Date.now() - start,
          };
        } catch (err) {
          return { success: false, data: null, summary: `Goal update failed: ${err}`, sideEffects: [], duration_ms: Date.now() - start };
        }
      },
    });

    // === COMMUNICATE tools (external, require approval by default) ===

    this.register({
      name: "notify",
      description: "Send a system notification via platform abstraction",
      category: "communicate",
      params: [
        { name: "title", type: "string", required: true, description: "Notification title" },
        { name: "content", type: "string", required: true, description: "Notification body" },
      ],
      timeout_ms: 5_000,
      parallelizable: true,
      execute: async (input, ctx) => {
        const start = Date.now();
        const title = String(input.title);
        const content = String(input.content);

        try {
          // Use termux-notification if available, otherwise log-only
          try {
            execSync(`termux-notification --title ${JSON.stringify(title)} --content ${JSON.stringify(content)}`, { timeout: 3000 });
          } catch {
            ctx.log.info(`[notify] ${title}: ${content}`);
          }

          return {
            success: true,
            data: { title, content },
            summary: `Notification sent: ${title}`,
            sideEffects: [`notification: ${title}`],
            duration_ms: Date.now() - start,
          };
        } catch (err) {
          return { success: false, data: null, summary: `Notification failed: ${err}`, sideEffects: [], duration_ms: Date.now() - start };
        }
      },
    });

    // === ORCHESTRATE tools (meta, always require approval) ===

    this.register({
      name: "session-send",
      description: "Send text/keystrokes to a tmux session pane",
      category: "orchestrate",
      params: [
        { name: "name", type: "string", required: true, description: "Session name" },
        { name: "text", type: "string", required: true, description: "Text to send" },
      ],
      timeout_ms: 5_000,
      parallelizable: false,
      execute: async (input, ctx) => {
        const start = Date.now();
        const name = String(input.name);
        const text = String(input.text);

        if (!ctx.sendToSession) {
          return { success: false, data: null, summary: "Session send not available", sideEffects: [], duration_ms: Date.now() - start };
        }

        try {
          ctx.sendToSession(name, text);
          return {
            success: true,
            data: { name, textLength: text.length },
            summary: `Sent ${text.length} chars to session "${name}"`,
            sideEffects: [`session_send: ${name}`],
            duration_ms: Date.now() - start,
          };
        } catch (err) {
          return { success: false, data: null, summary: `Session send failed: ${err}`, sideEffects: [], duration_ms: Date.now() - start };
        }
      },
    });
  }
}

// -- Path safety helpers ------------------------------------------------------

/** Check if a path is within allowed directories (project dirs, ~/.claude/, etc.) */
function isAllowedPath(filePath: string): boolean {
  const home = homedir();
  const allowedPrefixes = [
    join(home, ".claude"),
    join(home, "git"),
    join(home, "projects"),
    join(home, "src"),
    join(home, "work"),
    join(home, ".config", "operad"),
    join(home, ".local", "share", "operad"),
  ];

  // Allow any path under home that's not sensitive
  const sensitivePaths = [
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".aws"),
    join(home, ".kube"),
    "/etc/shadow",
    "/etc/passwd",
  ];

  if (sensitivePaths.some((s) => filePath.startsWith(s))) return false;

  // Must be under home or a project directory
  return filePath.startsWith(home) || allowedPrefixes.some((p) => filePath.startsWith(p));
}

/** Check if a file is protected from agent writes */
function isProtectedFile(filePath: string): boolean {
  const name = basename(filePath);
  const ext = extname(filePath);
  const protectedNames = [".env", ".env.local", ".env.production", "credentials.json", "secrets.json"];
  const protectedExts = [".pem", ".key", ".p12"];

  return protectedNames.includes(name) || protectedExts.includes(ext);
}
