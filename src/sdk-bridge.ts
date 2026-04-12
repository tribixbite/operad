/**
 * sdk-bridge.ts — Bridge between operad daemon and Claude Agent SDK
 *
 * Manages ONE active SDK query at a time (Android memory constraint:
 * ~150-300MB per subprocess). Streams messages over WebSocket to
 * dashboard clients and handles permission callbacks.
 */

import {
  query as sdkQuery,
  listSessions,
  getSessionMessages,
  getSessionInfo,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { detectPlatform } from "./platform/platform.js";
import type { Logger } from "./log.js";

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

/** Active query wrapper */
interface ActiveQuery {
  sessionName: string;
  sessionId: string | undefined;
  cwd: string;
  query: ReturnType<typeof sdkQuery>;
  /** Whether the query is currently processing a prompt */
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
      // Resolve symlinks to get the actual JS file
      try {
        cachedClaudePath = readlinkSync(whichResult);
        return cachedClaudePath;
      } catch {
        // readlink fails if it's not a symlink — use the path directly
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
  private active: ActiveQuery | null = null;
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

  /** Whether there's an active query */
  get isAttached(): boolean {
    return this.active !== null;
  }

  /** Name of the currently attached session */
  get activeSessionName(): string | null {
    return this.active?.sessionName ?? null;
  }

  /** Whether the active query is busy processing a prompt */
  get isBusy(): boolean {
    return this.active?.busy ?? false;
  }

  /**
   * Attach to a session — creates a new SDK query (or resumes an existing one).
   * Only one query can be active at a time (Android memory constraint).
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

    const env = this.platform.cleanEnv();

    const q = sdkQuery({
      prompt: "", // Empty initial prompt — we'll send prompts via send()
      options: {
        cwd,
        // Resume existing session if sessionId provided
        ...(sessionId ? { resume: sessionId } : {}),
        // Load user + project settings for CLAUDE.md etc.
        settingSources: ["user", "project", "local"],
        // Stream partial messages for real-time UI updates
        includePartialMessages: true,
        // Use node on Termux — bun's glibc-runner strips LD_PRELOAD
        executable: "node",
        // Resolve claude path for Termux shebang compatibility
        pathToClaudeCodeExecutable: resolveClaudePath(),
        // Clean env with LD_PRELOAD re-injected
        env,
        // Termux can't sandbox
        sandbox: { enabled: false },
        // Permission callback — routes to WS for dashboard approval
        canUseTool: async (toolName: string, toolInput: unknown) => {
          return this.requestPermission(sessionName, toolName, toolInput);
        },
        // SDK-level config
        ...(this.config.effort ? { effort: this.config.effort } : {}),
        ...(this.config.thinking ? { thinking: this.config.thinking } : {}),
        ...(this.config.maxBudgetUsd ? { maxBudgetUsd: this.config.maxBudgetUsd } : {}),
        ...(this.config.model ? { model: this.config.model } : {}),
        // Don't auto-accept edits — route through permission
        permissionMode: "default",
      },
    });

    // Capture session ID from init message
    let resolvedSessionId = sessionId ?? "";

    // Start consuming messages in background
    this.active = {
      sessionName,
      sessionId: resolvedSessionId,
      cwd,
      query: q,
      busy: false,
    };

    // Consume init messages
    this.consumeMessages(sessionName, q).catch((err) => {
      this.log.error(`SDK stream error for ${sessionName}: ${err}`);
      this.broadcast(sessionName, { type: "error", message: String(err) });
    });

    this.log.info(`SDK attached to session: ${sessionName} (id=${sessionId ?? "new"})`);
    this.broadcast(sessionName, { type: "attached", sessionName, sessionId: resolvedSessionId });

    return { sessionId: resolvedSessionId };
  }

  /**
   * Send a prompt to the active query.
   * The query subprocess stays alive between prompts (~2-3s vs ~12s cold start).
   */
  async send(prompt: string, options?: {
    effort?: "low" | "medium" | "high" | "max";
    thinking?: { type: "adaptive" } | { type: "enabled"; budgetTokens?: number } | { type: "disabled" };
  }): Promise<void> {
    if (!this.active) throw new Error("No active SDK session");
    if (this.active.busy) throw new Error("Query is busy processing");

    const q = this.active.query;
    const sessionName = this.active.sessionName;
    this.active.busy = true;

    this.broadcast(sessionName, { type: "prompt_start", prompt });

    try {
      // Apply per-query options if provided
      if (options?.effort) {
        // TODO: effort can't be changed per-send yet, only per-query
        this.log.debug(`Effort override not yet supported per-send: ${options.effort}`);
      }

      // Stream messages from the SDK
      for await (const msg of q) {
        this.routeMessage(sessionName, msg);

        // Check for result message (query complete for this prompt)
        if (msg.type === "result") {
          break;
        }
      }
    } finally {
      if (this.active) this.active.busy = false;
    }
  }

  /** Interrupt the active query */
  async interrupt(): Promise<void> {
    if (!this.active) return;
    try {
      await this.active.query.interrupt();
      this.broadcast(this.active.sessionName, { type: "interrupted" });
      this.log.info(`SDK query interrupted for ${this.active.sessionName}`);
    } catch (err) {
      this.log.warn(`Interrupt failed: ${err}`);
    }
  }

  /** Detach — close the SDK subprocess */
  async detach(): Promise<void> {
    if (!this.active) return;
    const name = this.active.sessionName;
    try {
      this.active.query.close();
    } catch { /* may already be closed */ }
    this.active = null;

    // Clean up pending permissions
    for (const [id, pending] of this.pendingPermissions) {
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
  async setModel(model: string): Promise<void> {
    if (!this.active) throw new Error("No active SDK session");
    await this.active.query.setModel(model);
    this.log.info(`SDK model changed to: ${model}`);
  }

  // -- Session listing (standalone functions, no active query needed) ----------

  /** List Claude Code sessions, optionally filtered by directory */
  async listAllSessions(dir?: string, limit?: number): Promise<SDKSessionInfo[]> {
    return listSessions({ dir, limit: limit ?? 50 });
  }

  /** Get messages for a specific session */
  async getMessages(sessionId: string) {
    return getSessionMessages(sessionId);
  }

  /** Get metadata for a specific session */
  async getInfo(sessionId: string) {
    return getSessionInfo(sessionId);
  }

  // -- Internal ----------------------------------------------------------------

  /** Consume messages from the query stream and broadcast to WS clients */
  private async consumeMessages(
    sessionName: string,
    q: ReturnType<typeof sdkQuery>,
  ): Promise<void> {
    try {
      for await (const msg of q) {
        this.routeMessage(sessionName, msg);

        // Capture session ID from init message
        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
          if (this.active && this.active.sessionName === sessionName) {
            this.active.sessionId = msg.session_id;
          }
        }
      }
    } catch (err) {
      // Stream ended (normal on detach or when query completes)
      this.log.debug(`SDK stream ended for ${sessionName}: ${err}`);
    }
  }

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
          // Forward select fields based on subtype
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
