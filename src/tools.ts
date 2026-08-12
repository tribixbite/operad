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

import { spawnSync, exec, execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Async command runners.
 *
 * Every shelling tool used execSync, which blocks the daemon's event loop for
 * the whole call — up to 30s for a TOML tool. HTTP, SSE, WebSocket pings,
 * health checks, IPC and the memory poll all stalled behind a single tool
 * invocation. Every execute() here is already async, so awaiting costs
 * nothing and frees the loop.
 */
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, dirname, basename, extname, sep } from "node:path";
import { homedir } from "node:os";
import type { MemoryDb } from "./memory-db.js";
import type { Logger } from "./log.js";
import type { AutonomyLevel, ProtectedCheckpoints } from "./types.js";

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
  /**
   * Set when the call was refused because the caller's autonomy level does not
   * auto-approve this tool's category (or it is in `protected_tools`). Callers
   * can surface this as "needs approval" rather than a generic failure.
   */
  requiresApproval?: boolean;
  /**
   * Set when a tool lease — not the agent's standing autonomy level — is what
   * allowed this call. Callers charge the lease's execution budget only in
   * that case: spending a capped grant on a call the agent could already make
   * would exhaust it for no reason.
   */
  authorisedByLease?: boolean;
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
/**
 * Single-quote a value for POSIX `sh`.
 *
 * `JSON.stringify` was used for this in several places, which produces a
 * *double*-quoted word — and `sh` still performs `$(…)`, backtick and `$VAR`
 * expansion inside double quotes, so a value of `$(id)` executed. Single
 * quotes suppress every expansion; the only character needing care is the
 * quote itself, closed and reopened around an escaped literal.
 */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Reject a git ref that could be read as an option or smuggle shell syntax.
 * Refs reach `git` as positional arguments, where a leading `-` is parsed as
 * a flag even with no shell in play.
 */
export function isSafeGitRef(ref: string): boolean {
  if (!ref || ref.length > 256) return false;
  if (ref.startsWith("-")) return false;
  return /^[A-Za-z0-9._/~^@{}-]+$/.test(ref) && !ref.includes("..");
}

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
 *
 * Phase C generation discipline:
 *   • The registry holds N >= 1 generation-tagged tool maps. Most of
 *     the time N=1: install/uninstall mutate the only map and the
 *     single live pointer advances.
 *   • Skill install acquires a generation transaction (clone the live
 *     map, apply delta into the clone, atomic-swap the live pointer
 *     on commit). Old generations stay resident as long as a
 *     ConsumerTracker pin references them; the GC sweeper drops
 *     unreferenced generations at the next interval.
 *   • Lookups accept an optional generation arg; default is "live".
 *     Callers that hold a pin pass their snapshotted generation so
 *     mid-flight runs see a stable tool surface across a concurrent
 *     skill install.
 */
export class ToolExecutor {
  /** Generation-keyed shadow maps. `generations.get(currentGen)` is "live". */
  private generations = new Map<number, Map<string, ToolDef>>();
  /** Highest generation ever produced — monotonic; never reused. */
  private currentGen = 0;
  /** Pending uncommitted generations (in-flight beginGenerationTransaction). */
  private pending = new Set<number>();
  private providers: ToolProvider[] = [];
  private db: MemoryDb;
  private log: Logger;

  constructor(db: MemoryDb, log: Logger) {
    this.db = db;
    this.log = log;
    this.generations.set(0, new Map());
    this.registerBuiltinTools();
  }

  /**
   * Direct accessor for the current "live" generation. Used by
   * ConsumerTracker.acquire() to snapshot at pin time.
   */
  getCurrentGeneration(): number {
    return this.currentGen;
  }

  /** All generation ids that still hold a tool map (live + pinned). */
  listGenerations(): number[] {
    return Array.from(this.generations.keys()).sort((a, b) => a - b);
  }

  /**
   * Begin a generation transaction. Clones the live map into a new
   * generation N+1 (or current_max+1 if there are pending ones).
   * Returns the new generation number — caller must call either
   * `commitGeneration(n)` or `abortGeneration(n)`.
   */
  beginGenerationTransaction(): number {
    const newGen = Math.max(this.currentGen, ...this.pending) + 1;
    const liveMap = this.generations.get(this.currentGen)!;
    this.generations.set(newGen, new Map(liveMap));
    this.pending.add(newGen);
    return newGen;
  }

  /** Atomic flip — the new generation becomes "live". */
  commitGeneration(gen: number): void {
    if (!this.pending.has(gen)) {
      throw new Error(`commitGeneration: ${gen} not pending`);
    }
    this.pending.delete(gen);
    this.currentGen = gen;
  }

  /** Discard a pending generation (rollback path). */
  abortGeneration(gen: number): void {
    if (!this.pending.has(gen)) return; // idempotent
    this.pending.delete(gen);
    this.generations.delete(gen);
  }

  /**
   * Garbage-collect a generation map. Caller MUST verify no
   * ConsumerTracker pin references it before calling. Refuses to
   * delete the live generation. Idempotent.
   */
  pruneGeneration(gen: number): boolean {
    if (gen === this.currentGen) return false;
    if (this.pending.has(gen)) return false;
    return this.generations.delete(gen);
  }

  /**
   * Register a tool into the live generation OR into a specific
   * pending generation (passed in `gen`). Builtin registrations
   * at constructor time and provider-driven boot registrations both
   * write to the live (currentGen) map directly; skill installs
   * write into a pending transaction.
   */
  register(tool: ToolDef, gen?: number): void {
    const target = gen ?? this.currentGen;
    const map = this.generations.get(target);
    if (!map) throw new Error(`register: unknown generation ${target}`);
    if (map.has(tool.name)) {
      this.log.warn(`Tool "${tool.name}" already registered (gen ${target}), overwriting`);
    }
    if (!tool.source) tool.source = "builtin";
    map.set(tool.name, tool);
  }

  /**
   * Unregister a tool by name from the live generation or a specific
   * pending one. Used by skill uninstall and rollback paths.
   * Idempotent; returns true if the tool existed in the target gen.
   */
  unregister(name: string, gen?: number): boolean {
    const target = gen ?? this.currentGen;
    const map = this.generations.get(target);
    if (!map) return false;
    return map.delete(name);
  }

  /** Quick existence check at the live (or specified) generation. */
  hasTool(name: string, gen?: number): boolean {
    const map = this.generations.get(gen ?? this.currentGen);
    return map?.has(name) ?? false;
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
   *
   * Phase C: the optional `gen` argument routes the registration
   * into a specific generation map. Boot-time tool config
   * registrations go to the live generation (gen=undefined);
   * skill-installs route to a pending generation so the live map
   * stays unchanged for in-flight consumers until the commit.
   */
  registerTomlTools(tools: TomlToolConfig[], gen?: number): void {
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
            // Substitute {{param}} placeholders in the operator-authored
            // command. The template is theirs, but the VALUES come from a
            // model-emitted ```tool block and are untrusted: `{{file}}` =
            // "/etc/hosts; id" used to run both commands. Each value is now
            // single-quoted, suppressing every form of sh expansion.
            //
            // A single combined pass also fixes two lesser bugs: the key was
            // interpolated into a RegExp unescaped (a param named `a(b` threw
            // SyntaxError), and sequential passes let a value containing
            // `{{other}}` be re-substituted by a later iteration.
            const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const paramKeys = Object.keys(input);
            let cmd = t.command;
            if (paramKeys.length > 0) {
              const placeholder = new RegExp(
                "\\{\\{(" + paramKeys.map(escapeRe).join("|") + ")\\}\\}",
                "g",
              );
              cmd = cmd.replace(placeholder, (_m: string, key: string) =>
                shellQuote(String(input[key])),
              );
            }

            const { stdout } = await execAsync(cmd, {
              encoding: "utf-8",
              timeout: t.timeout_ms ?? 30_000,
              maxBuffer: 1024 * 1024,
            });
            const output = stdout.trim();

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
      }, gen);
    }
  }

  /** Get a tool by name. Defaults to the live generation. */
  getTool(name: string, gen?: number): ToolDef | undefined {
    const map = this.generations.get(gen ?? this.currentGen);
    return map?.get(name);
  }

  /** Get all registered tools at the given generation (default: live). */
  getAllTools(gen?: number): ToolDef[] {
    const map = this.generations.get(gen ?? this.currentGen);
    return map ? Array.from(map.values()) : [];
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
   * Check if a tool is auto-approved at a given autonomy level.
   * Protected tools/files always require approval regardless of level.
   */
  isAutoApproved(
    toolName: string,
    toolCategory: ToolCategory,
    autonomyLevel: AutonomyLevel = "observe",
    protectedCheckpoints?: ProtectedCheckpoints,
  ): boolean {
    // Protected tools always require approval
    if (protectedCheckpoints?.protected_tools?.includes(toolName)) {
      return false;
    }

    // Autonomy level determines category auto-approval scope
    switch (autonomyLevel) {
      case "observe":
        return CATEGORY_LEVEL[toolCategory] <= CATEGORY_LEVEL["observe"];
      case "suggest":
        return CATEGORY_LEVEL[toolCategory] <= CATEGORY_LEVEL["analyze"];
      case "supervised":
        // observe + analyze auto-approved; mutate+ needs approval
        return CATEGORY_LEVEL[toolCategory] <= CATEGORY_LEVEL["analyze"];
      case "trusted":
        // observe + analyze + mutate auto-approved; communicate/orchestrate needs approval
        return CATEGORY_LEVEL[toolCategory] <= CATEGORY_LEVEL["mutate"];
      case "autonomous":
        return true; // everything auto-approved
      default:
        return CATEGORY_LEVEL[toolCategory] <= CATEGORY_LEVEL["observe"];
    }
  }

  /**
   * Execute a tool by name with validated parameters. Logs execution
   * to the audit trail.
   *
   * Phase C: the optional `gen` argument resolves the tool against a
   * specific generation snapshot. Long-running callers (OODA cycles,
   * scheduled runs, workflow runs) snapshot their generation at
   * pin-acquire time and pass it here so a concurrent skill install
   * can't pull the rug. When omitted, defaults to the live generation
   * — appropriate for one-shot REST/IPC tool calls that don't span
   * the install transaction window.
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    ctx: ToolContext,
    gen?: number,
    /**
     * Autonomy context for the caller. Omitted only by trusted internal
     * callers (tests, direct CLI invocation) that are not acting on behalf of
     * an agent.
     */
    approval?: {
      autonomyLevel: AutonomyLevel;
      protectedCheckpoints?: ProtectedCheckpoints;
      /**
       * Does the caller hold an active lease for this tool?
       *
       * A lease is a temporary, goal-scoped, execution-capped grant. It can
       * raise a call above what the agent's standing autonomy level allows —
       * it never lowers it, so wiring this in cannot break a call that
       * already worked. Passed as a callback so tools.ts stays free of a
       * database dependency, and so the lookup only happens when the
       * autonomy gate has actually refused.
       */
      hasLease?: (toolName: string) => boolean;
    },
  ): Promise<ToolResult> {
    const tool = this.getTool(toolName, gen);
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

    // Enforce the autonomy gate.
    //
    // isAutoApproved() existed but was never called from anywhere — grep found
    // only its definition and a unit test. Every tool therefore ran regardless
    // of the agent's declared autonomy level, and `protected_tools` in the
    // config was inert. Worse, the audit row below hardcoded approval: approval ? "auto" : "unchecked",
    // so the forensic trail asserted an approval decision that never happened.
    let authorisedByLease = false;
    if (approval) {
      const allowed = this.isAutoApproved(
        tool.name,
        tool.category,
        approval.autonomyLevel,
        approval.protectedCheckpoints,
      );
      if (!allowed) {
        // A lease is the documented way to grant an agent temporary access
        // above its standing level. Until now nothing consulted one, so the
        // whole lease table was inert: `createToolLease` and `hasActiveLease`
        // had no production callers at all, and the "goal-scoped tool
        // permissions with usage limits" model was declared but unenforced.
        //
        // `protected_tools` is deliberately NOT overridable — that list is an
        // explicit "never without a human", and a lease is not a human.
        const isProtected = approval.protectedCheckpoints?.protected_tools?.includes(tool.name) ?? false;
        authorisedByLease = !isProtected && (approval.hasLease?.(tool.name) ?? false);

        if (!authorisedByLease) {
          return {
            success: false,
            data: null,
            summary:
              `Tool '${tool.name}' (category '${tool.category}') requires approval at `
              + `autonomy level '${approval.autonomyLevel}'`,
            sideEffects: [],
            duration_ms: 0,
            requiresApproval: true,
          };
        }
      }
    }

    const start = Date.now();
    let result: ToolResult;
    let error: string | undefined;

    try {
      // Execute with timeout via AbortSignal
      const timeoutMs = tool.timeout_ms;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      // Merge the caller's signal with the timeout.
      //
      // This used to be `ctx.signal.aborted ? ctx.signal : controller.signal`,
      // which threw outright when a caller omitted `signal`, and otherwise
      // discarded the caller's signal unless it had ALREADY aborted — so a
      // caller could never cancel a running tool. AbortSignal.any propagates
      // whichever fires first; where it is unavailable, fall back to
      // forwarding the caller's abort into our controller.
      const callerSignal = ctx.signal;
      let mergedSignal: AbortSignal;
      if (!callerSignal) {
        mergedSignal = controller.signal;
      } else if (typeof (AbortSignal as { any?: unknown }).any === "function") {
        mergedSignal = (AbortSignal as unknown as {
          any: (s: AbortSignal[]) => AbortSignal;
        }).any([callerSignal, controller.signal]);
      } else {
        if (callerSignal.aborted) controller.abort();
        else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
        mergedSignal = controller.signal;
      }
      const mergedCtx: ToolContext = { ...ctx, signal: mergedSignal };

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
        // Distinguish the three real cases in the forensic trail: the
        // autonomy level allowed it, a lease allowed it, or no check ran
        // because the caller was internal.
        approval: !approval ? "unchecked" : authorisedByLease ? "lease" : "auto",
        error,
      });
    } catch (logErr) {
      this.log.warn(`Failed to log tool execution: ${logErr}`);
    }

    return authorisedByLease ? { ...result, authorisedByLease: true } : result;
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
          // argv arrays: these are fixed commands, so there is no reason to
          // involve a shell at all.
          const [branchRes, statusRes] = await Promise.all([
            execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath, encoding: "utf-8", timeout: 5000 }),
            execFileAsync("git", ["status", "--porcelain"], { cwd: repoPath, encoding: "utf-8", timeout: 5000 }),
          ]);
          const branch = branchRes.stdout.trim();
          const status = statusRes.stdout.trim();
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
        // Clamped at both ends: Math.min alone let -5 and NaN through, which
        // produced a malformed `-NaN` / `--5` git flag.
        const rawCount = typeof input.count === "number" && Number.isFinite(input.count)
          ? Math.trunc(input.count) : 10;
        const count = Math.min(Math.max(rawCount, 1), 50);

        if (!isAllowedPath(repoPath)) {
          return { success: false, data: null, summary: `Path not allowed: ${repoPath}`, sideEffects: [], duration_ms: Date.now() - start };
        }

        try {
          const { stdout: logOut } = await execFileAsync(
            "git",
            ["log", "--oneline", `-${count}`, "--format=%h %s"],
            { cwd: repoPath, encoding: "utf-8", timeout: 5000 },
          );
          const log = logOut.trim();

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
          // argv array, no shell. This used execSync with the pattern wrapped
          // in JSON.stringify (double quotes), which sh still expands — a
          // pattern of `$(id)` executed. grep is category `analyze`, which is
          // auto-approved at every autonomy level, so this was RCE from an
          // ostensibly read-only tool.
          const includes = [
            "*.ts", "*.js", "*.json", "*.md", "*.toml",
            "*.yaml", "*.yml", "*.py", "*.sh",
          ].map((g) => `--include=${g}`);
          const gproc = spawnSync(
            "grep",
            ["-rnI", ...includes, "--", pattern, searchPath],
            { encoding: "utf-8", timeout: 15000, maxBuffer: 1024 * 1024 },
          );
          if (gproc.error) throw gproc.error;
          const allOut = (gproc.stdout ?? "").trim();
          // Replaces the `| head -N` pipe with an in-process slice.
          const lines = allOut ? allOut.split("\n").slice(0, limit) : [];
          const result = lines.join("\n");
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

        // Refs were interpolated into a shell string with no quoting, so
        // `ref2 = "x; rm -rf ~"` executed. Validate, then pass as argv.
        if (!isSafeGitRef(ref1) || !isSafeGitRef(ref2)) {
          return {
            success: false,
            data: null,
            summary: "Invalid git ref (no leading '-', '..', whitespace or shell metacharacters)",
            sideEffects: [],
            duration_ms: Date.now() - start,
          };
        }

        try {
          const dproc = spawnSync(
            "git",
            ["diff", `${ref1}..${ref2}`, "--stat"],
            { cwd: repoPath, encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 1024 },
          );
          if (dproc.error) throw dproc.error;
          const diff = (dproc.stdout ?? "").trim();

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
            // argv form — JSON.stringify only double-quotes, which sh expands.
            const nproc = spawnSync(
              "termux-notification",
              ["--title", title, "--content", content],
              { timeout: 3000, stdio: "ignore" },
            );
            if (nproc.error) throw nproc.error;
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

/**
 * Is `filePath` inside a directory agent tools may touch?
 *
 * The previous rule was "anything under $HOME, minus .ssh/.gnupg/.aws/.kube".
 * That is far too broad for tools an agent can invoke on its own:
 * `file-read` is category `observe`, auto-approved at every autonomy level, so
 * it could read `~/.claude.json` (OAuth token), `~/.npmrc` (registry token),
 * `~/.git-credentials`, `~/.netrc` and `~/.docker/config.json`. `file-write`
 * could append hooks to `~/.claude/settings.json` or a `[[tool]]` block to
 * operad's own config — both of which are arbitrary command execution on the
 * next run.
 *
 * Three separate weaknesses are fixed here:
 *  - prefix matching had no separator boundary, so `/home/user` also matched
 *    `/home/userbackup`;
 *  - comparisons were case-sensitive, so `.SSH` / `.Env` slipped past on
 *    macOS and Windows, whose filesystems are case-insensitive;
 *  - the deny-list named four directories and two files.
 *
 * Symlinks are resolved before the check where the path exists, so a link
 * planted inside an allowed directory cannot point out of it.
 */
export function isAllowedPath(filePath: string): boolean {
  const home = process.env.HOME || homedir();
  const resolved = resolveForPolicy(filePath);

  // Credential and config locations that must never be reachable, even though
  // they sit under an otherwise-allowed root.
  const deniedDirs = [
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".aws"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".gradle"),
    join(home, ".m2"),
    join(home, ".cargo", "credentials"),
    join(home, ".config", "gh"),
    join(home, ".config", "gcloud"),
  ];
  const deniedFiles = [
    // Claude Code's own state and settings. settings.json carries `hooks`,
    // which execute shell commands on the next Claude run.
    join(home, ".claude.json"),
    join(home, ".claude", "settings.json"),
    join(home, ".claude", "settings.local.json"),
    join(home, ".claude", ".credentials.json"),
    // operad's own config defines [[tool]] shell commands.
    join(home, ".config", "operad", "operad.toml"),
    // Shell startup files — writing any of these is persistence.
    join(home, ".bashrc"), join(home, ".bash_profile"), join(home, ".profile"),
    join(home, ".zshrc"), join(home, ".zshenv"), join(home, ".zprofile"),
    join(home, ".npmrc"), join(home, ".netrc"), join(home, ".git-credentials"),
    "/etc/shadow", "/etc/passwd", "/etc/sudoers",
  ];

  if (deniedFiles.some((f) => pathEquals(resolved, f))) return false;
  if (deniedDirs.some((d) => pathEquals(resolved, d) || isUnder(resolved, d))) return false;

  const allowedRoots = [
    join(home, ".claude"),
    join(home, "git"),
    join(home, "projects"),
    join(home, "src"),
    join(home, "work"),
    join(home, ".config", "operad"),
    join(home, ".local", "share", "operad"),
  ];
  if (allowedRoots.some((r) => isUnder(resolved, r))) return true;
  return isUnder(resolved, home);
}

/**
 * Resolve a path for policy decisions, following symlinks when the target
 * exists. A dangling path still resolves lexically so new-file writes work.
 */
function resolveForPolicy(filePath: string): string {
  const abs = resolve(filePath);
  try {
    return realpathSync(abs);
  } catch {
    // Does not exist yet — resolve the deepest existing ancestor so a
    // symlinked parent directory cannot be used to escape.
    try {
      const parent = realpathSync(dirname(abs));
      return join(parent, basename(abs));
    } catch {
      return abs;
    }
  }
}

/** Case-insensitive on platforms whose filesystems are. */
function samePathCase(p: string): string {
  return process.platform === "linux" || process.platform === "android"
    ? p
    : p.toLowerCase();
}

function pathEquals(a: string, b: string): boolean {
  return samePathCase(resolve(a)) === samePathCase(resolve(b));
}

/** Is `child` strictly inside `parent`? Boundary-aware, so /a/b !== /a/bc. */
function isUnder(child: string, parent: string): boolean {
  const c = samePathCase(resolve(child));
  const p = samePathCase(resolve(parent)).replace(/[/\\]+$/, "");
  return c === p || c.startsWith(p + sep);
}

/** Check if a file is protected from agent writes */
export function isProtectedFile(filePath: string): boolean {
  const name = basename(filePath);
  const ext = extname(filePath);
  // Case-folded: on macOS and Windows `.ENV` and `SECRETS.JSON` are the same
  // file, and the previous exact-match list let them straight through.
  const lower = name.toLowerCase();
  const protectedNames = [
    ".env", ".env.local", ".env.production", ".env.development",
    "credentials.json", "secrets.json", "id_rsa", "id_ed25519",
  ];
  const protectedExts = [".pem", ".key", ".p12", ".pfx", ".jks"];

  // Any .env variant (.env.staging, .env.foo) rather than only the listed ones.
  if (lower.startsWith(".env")) return true;
  return protectedNames.includes(lower) || protectedExts.includes(ext.toLowerCase());
}
