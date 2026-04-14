/**
 * sdk-bridge.ts — Bridge between operad daemon and Claude Agent SDK
 *
 * Uses the V2 session API (unstable_v2_createSession / unstable_v2_resumeSession)
 * for persistent sessions that support multiple prompts without the empty-text-block
 * cache_control bug that affects the v1 query() API.
 *
 * Manages ONE active SDK session at a time (Android memory constraint:
 * ~150-300MB per subprocess). Streams messages over WebSocket to
 * dashboard clients and handles permission callbacks.
 */

/**
 * SDK imports are LAZY — loaded on first use via getSdk().
 * This prevents the daemon from crashing at startup when
 * @anthropic-ai/claude-agent-sdk is not installed.
 */
import { existsSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { detectPlatform } from "./platform/platform.js";
import type { Logger } from "./log.js";

/** Cached lazy SDK module */
let _sdk: typeof import("@anthropic-ai/claude-agent-sdk") | null = null;

/** Lazy-load the Claude Agent SDK (throws descriptive error if not installed) */
async function getSdk() {
  if (_sdk) return _sdk;
  try {
    _sdk = await import("@anthropic-ai/claude-agent-sdk");
    return _sdk;
  } catch (err) {
    throw new Error(
      `@anthropic-ai/claude-agent-sdk not installed. Run: bun add @anthropic-ai/claude-agent-sdk\n${err}`,
    );
  }
}

/** SDK message type (re-exported for consumers that reference it) */
type SDKMessage = any;
type SDKResultMessage = any;
type SDKSessionInfo = any;

/** Broadcast callback — sends a message to all WS clients subscribed to a session room */
export type BroadcastFn = (sessionName: string, data: unknown) => void;

/** SDK permission result type (matches @anthropic-ai/claude-agent-sdk PermissionResult) */
type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** Permission request pending resolution */
interface PendingPermission {
  id: string;
  resolve: (result: PermissionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Active V2 session wrapper */
interface ActiveSession {
  sessionName: string;
  /** Claude Code session UUID */
  sessionId: string;
  cwd: string;
  /** V2 session object — has .send(), .stream(), .close(), .sessionId */
  session: any;
  /** Whether a prompt is currently being processed */
  busy: boolean;
}

/** SDK bridge configuration */
export interface SdkBridgeConfig {
  /** Default effort level for queries */
  effort?: "low" | "medium" | "high" | "max";
  /** Default thinking config */
  thinking?: { type: "adaptive" } | { type: "enabled"; budgetTokens?: number } | { type: "disabled" };
  /** Max budget per query in USD */
  maxBudgetUsd?: number;
  /** Model override (default: SDK default) */
  model?: string;
  /** Permission timeout in ms (default: 5 minutes) */
  permissionTimeoutMs?: number;
  /** Agent definitions to inject into SDK sessions (SDK AgentDefinition map) */
  agents?: Record<string, Record<string, unknown>>;
}

/** Resolved path to the Claude Code executable */
let cachedClaudePath: string | null = null;

/**
 * Resolve the Claude Code executable path.
 * On Termux, #!/usr/bin/env node shebangs don't work, so we resolve
 * the actual JS file path and pass it to the SDK with executable: 'node'.
 */
function resolveClaudePath(): string {
  if (cachedClaudePath) return cachedClaudePath;

  try {
    // Try which first
    const whichResult = execSync("which claude", { encoding: "utf-8" }).trim();
    if (whichResult) {
      // Resolve ALL symlinks to get the absolute JS file path
      // readlinkSync only follows one level and may return a relative path
      try {
        cachedClaudePath = realpathSync(whichResult);
        return cachedClaudePath;
      } catch {
        cachedClaudePath = whichResult;
        return cachedClaudePath;
      }
    }
  } catch { /* which not found */ }

  // Fallback: common locations
  const candidates = [
    join(process.env.HOME ?? "", ".bun/bin/claude"),
    join(process.env.HOME ?? "", ".npm/bin/claude"),
    "/usr/local/bin/claude",
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      cachedClaudePath = p;
      return cachedClaudePath;
    }
  }

  // Last resort: let the SDK find it
  return "claude";
}

export class SdkBridge {
  private active: ActiveSession | null = null;
  private pendingPermissions = new Map<string, PendingPermission>();
  private permissionIdCounter = 0;
  private log: Logger;
  private broadcast: BroadcastFn;
  private config: SdkBridgeConfig;
  private platform = detectPlatform();

  constructor(log: Logger, broadcast: BroadcastFn, config?: SdkBridgeConfig) {
    this.log = log;
    this.broadcast = broadcast;
    this.config = config ?? {};
  }

  /** Whether there's an active session */
  get isAttached(): boolean {
    return this.active !== null;
  }

  /** Name of the currently attached session */
  get activeSessionName(): string | null {
    return this.active?.sessionName ?? null;
  }

  /** Whether the active session is busy processing a prompt */
  get isBusy(): boolean {
    return this.active?.busy ?? false;
  }

  /**
   * Build shared session options for V2 create/resume calls.
   * Centralizes Termux-specific config (executable, path, env, sandbox).
   */
  private buildSessionOptions(cwd: string): Record<string, unknown> {
    const env = this.platform.cleanEnv();
    const opts: Record<string, unknown> = {
      cwd,
      settingSources: ["user", "project", "local"],
      executable: "node",
      pathToClaudeCodeExecutable: resolveClaudePath(),
      env,
      sandbox: { enabled: false },
      canUseTool: async (toolName: string, toolInput: unknown) => {
        return this.requestPermission(this.active?.sessionName ?? "unknown", toolName, toolInput);
      },
      permissionMode: "default",
    };
    if (this.config.effort) opts.effort = this.config.effort;
    if (this.config.thinking) opts.thinking = this.config.thinking;
    if (this.config.maxBudgetUsd) opts.maxBudgetUsd = this.config.maxBudgetUsd;
    if (this.config.model) opts.model = this.config.model;
    // Inject agent definitions — agents is not on SDKSessionOptions type but
    // works via the same `as any` cast used for cwd, settingSources, etc.
    if (this.config.agents && Object.keys(this.config.agents).length > 0) {
      opts.agents = this.config.agents;
    }
    return opts;
  }

  /**
   * Attach to a session — creates a new V2 session or resumes an existing one.
   * Only one session can be active at a time (Android memory constraint).
   */
  async attach(
    sessionName: string,
    sessionId: string | undefined,
    cwd: string,
  ): Promise<{ sessionId: string }> {
    // Detach existing session first
    if (this.active) {
      await this.detach();
    }

    const sdk = await getSdk();
    // Cast to any — SDKSessionOptions requires model but it defaults internally
    const opts = this.buildSessionOptions(cwd) as any;

    // V2 API: create or resume a persistent session
    let session: any;
    if (sessionId) {
      session = sdk.unstable_v2_resumeSession(sessionId, opts);
    } else {
      session = sdk.unstable_v2_createSession(opts);
    }

    // V2 session ID is only available after first message exchange;
    // use provided sessionId or empty string until resolved by a prompt
    let resolvedSessionId = sessionId ?? "";
    try {
      resolvedSessionId = session.sessionId ?? resolvedSessionId;
    } catch {
      // .sessionId getter may throw before messages are received
    }

    this.active = {
      sessionName,
      sessionId: resolvedSessionId,
      cwd,
      session,
      busy: false,
    };

    this.log.info(`SDK attached to session: ${sessionName} (id=${resolvedSessionId || "new"})`);
    this.broadcast(sessionName, { type: "attached", sessionName, sessionId: resolvedSessionId });

    return { sessionId: resolvedSessionId };
  }

  /**
   * Send a prompt to the active V2 session.
   * Streams messages to WS clients in real time, then returns the result.
   * The subprocess stays alive between prompts (~2-3s vs ~12s cold start).
   */
  async send(prompt: string, options?: {
    effort?: "low" | "medium" | "high" | "max";
    thinking?: { type: "adaptive" } | { type: "enabled"; budgetTokens?: number } | { type: "disabled" };
  }): Promise<void> {
    if (!this.active) throw new Error("No active SDK session");
    if (this.active.busy) throw new Error("Query is busy processing");

    const { session, sessionName } = this.active;
    this.active.busy = true;

    this.broadcast(sessionName, { type: "prompt_start", prompt });

    try {
      // Send the prompt — this starts the Claude subprocess processing
      await session.send(prompt);

      // Stream messages from the session until we get a result
      for await (const msg of session.stream()) {
        this.routeMessage(sessionName, msg);

        // Capture session ID from init message
        if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
          if (this.active) {
            this.active.sessionId = msg.session_id;
          }
        }

        // Result message means this prompt is done
        if (msg.type === "result") {
          break;
        }
      }
    } catch (err) {
      this.log.error(`SDK send error for ${sessionName}: ${err}`);
      this.broadcast(sessionName, { type: "error", message: String(err) });
    } finally {
      if (this.active) this.active.busy = false;
    }
  }

  /** Interrupt the active session */
  async interrupt(): Promise<void> {
    if (!this.active) return;
    // V2 sessions don't have an explicit interrupt() — close and re-attach
    this.log.info(`SDK interrupt requested for ${this.active.sessionName}`);
    const { sessionName, sessionId, cwd } = this.active;
    await this.detach();
    // Re-attach to resume the session for future prompts
    await this.attach(sessionName, sessionId, cwd);
    this.broadcast(sessionName, { type: "interrupted" });
  }

  /** Detach — close the SDK subprocess */
  async detach(): Promise<void> {
    if (!this.active) return;
    const name = this.active.sessionName;
    try {
      this.active.session.close();
    } catch { /* may already be closed */ }
    this.active = null;

    // Clean up pending permissions
    for (const [, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: "deny", message: "Session detached" });
    }
    this.pendingPermissions.clear();

    this.broadcast(name, { type: "detached", sessionName: name });
    this.log.info(`SDK detached from session: ${name}`);
  }

  /** Resolve a pending permission request */
  resolvePermission(permissionId: string, behavior: "allow" | "deny"): boolean {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(permissionId);
    if (behavior === "allow") {
      pending.resolve({ behavior: "allow" });
    } else {
      pending.resolve({ behavior: "deny", message: "Denied by dashboard user" });
    }
    return true;
  }

  /** Change model at runtime */
  async setModel(_model: string): Promise<void> {
    // V2 sessions don't expose setModel — log for now
    this.log.info(`SDK model change requested: ${_model} (not supported in V2 API)`);
  }

  /**
   * Update agent definitions. Takes effect on the NEXT attach() call —
   * does NOT affect currently running sessions.
   */
  updateAgents(agents: Record<string, Record<string, unknown>>): void {
    this.config.agents = agents;
    this.log.info(`SDK agents updated: ${Object.keys(agents).join(", ") || "(none)"}`);
  }

  /**
   * Run a standalone agent — creates a V2 session with the agent's config,
   * sends the initial prompt, streams results, and returns cost data.
   * Fails if there's already an active session (single-session constraint).
   */
  async runStandaloneAgent(
    agentName: string,
    agentDef: Record<string, unknown>,
    cwd: string,
    prompt: string,
    maxBudgetUsd?: number,
  ): Promise<{ sessionId: string; costUsd: number; inputTokens: number; outputTokens: number; turns: number }> {
    if (this.active) {
      throw new Error("Cannot run standalone agent — SDK session already active");
    }

    const sdk = await getSdk();
    const opts = this.buildSessionOptions(cwd) as any;

    // For standalone runs, the agent IS the session — set its prompt as system prompt
    // and apply max_budget_usd at the session level (not on AgentDefinition)
    if (maxBudgetUsd) opts.maxBudgetUsd = maxBudgetUsd;

    // Override with agent-specific settings
    if (agentDef.model) opts.model = agentDef.model;
    if (agentDef.effort) opts.effort = agentDef.effort;
    if (agentDef.permissionMode) opts.permissionMode = agentDef.permissionMode;
    if (agentDef.maxTurns) opts.maxTurns = agentDef.maxTurns;

    const session = sdk.unstable_v2_createSession(opts);

    let resolvedSessionId = "";
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let turns = 0;

    try {
      // Prepend agent system prompt to user prompt
      const fullPrompt = agentDef.prompt
        ? `${agentDef.prompt}\n\n---\n\n${prompt}`
        : prompt;

      await session.send(fullPrompt);

      for await (const msg of session.stream()) {
        this.broadcast(agentName, msg);

        if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
          resolvedSessionId = msg.session_id;
        }

        if (msg.type === "result") {
          costUsd = msg.total_cost_usd ?? 0;
          inputTokens = msg.usage?.input_tokens ?? 0;
          outputTokens = msg.usage?.output_tokens ?? 0;
          turns = msg.num_turns ?? 0;
          break;
        }
      }
    } finally {
      try { session.close(); } catch { /* already closed */ }
    }

    return { sessionId: resolvedSessionId, costUsd, inputTokens, outputTokens, turns };
  }

  // -- Session listing (standalone functions, no active session needed) --------

  /** List Claude Code sessions, optionally filtered by directory */
  async listAllSessions(dir?: string, limit?: number): Promise<SDKSessionInfo[]> {
    const sdk = await getSdk();
    return sdk.listSessions({ dir, limit: limit ?? 50 });
  }

  /** Get messages for a specific session */
  async getMessages(sessionId: string) {
    const sdk = await getSdk();
    return sdk.getSessionMessages(sessionId);
  }

  /** Get metadata for a specific session */
  async getInfo(sessionId: string) {
    const sdk = await getSdk();
    return sdk.getSessionInfo(sessionId);
  }

  // -- Internal ----------------------------------------------------------------

  /** Route an SDK message to the appropriate WS broadcast format */
  private routeMessage(sessionName: string, msg: SDKMessage): void {
    switch (msg.type) {
      case "assistant":
        // Full or partial assistant message
        this.broadcast(sessionName, {
          type: "assistant",
          uuid: msg.uuid,
          session_id: msg.session_id,
          message: msg.message,
          parent_tool_use_id: "parent_tool_use_id" in msg ? msg.parent_tool_use_id : null,
        });
        break;

      case "result": {
        // Query complete — includes cost and token data
        const result = msg as SDKResultMessage;
        this.broadcast(sessionName, {
          type: "result",
          subtype: result.subtype,
          session_id: result.session_id,
          duration_ms: result.duration_ms,
          num_turns: result.num_turns,
          total_cost_usd: result.total_cost_usd,
          usage: result.usage,
          model_usage: "modelUsage" in result ? result.modelUsage : undefined,
          result_text: "result" in result ? result.result : undefined,
          is_error: result.is_error,
        });
        break;
      }

      case "system":
        // Init, status, compaction boundary, etc.
        this.broadcast(sessionName, {
          type: "system",
          subtype: "subtype" in msg ? msg.subtype : "unknown",
          session_id: msg.session_id,
          ...("tools" in msg ? { tools: msg.tools } : {}),
          ...("model" in msg ? { model: msg.model } : {}),
          ...("claude_code_version" in msg ? { version: msg.claude_code_version } : {}),
        });
        break;

      default:
        // Forward other message types as-is (rate_limit, task_notification, etc.)
        this.broadcast(sessionName, msg);
        break;
    }
  }

  /**
   * Request permission from dashboard WS clients.
   * Sends a permission_request message and waits for a permission_response.
   * Times out after permissionTimeoutMs (default 5 minutes) → deny.
   */
  private requestPermission(
    sessionName: string,
    toolName: string,
    toolInput: unknown,
  ): Promise<PermissionResult> {
    const id = `perm_${++this.permissionIdCounter}_${Date.now()}`;
    const timeoutMs = this.config.permissionTimeoutMs ?? 5 * 60 * 1000;

    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(id);
        this.log.warn(`Permission timeout for ${toolName} (${id})`);
        resolve({ behavior: "deny", message: "Permission request timed out" });
      }, timeoutMs);

      this.pendingPermissions.set(id, { id, resolve, timer });

      // Broadcast permission request to all session room subscribers
      this.broadcast(sessionName, {
        type: "permission_request",
        id,
        tool: toolName,
        input: toolInput,
        timeout_ms: timeoutMs,
      });
    });
  }
}
