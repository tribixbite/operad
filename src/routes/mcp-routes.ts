/**
 * mcp-routes.ts — MCP server CRUD REST API route handlers.
 *
 * Handles add/update/delete/toggle of MCP servers stored in
 * ~/.claude.json and ~/.claude/settings.json.
 *
 * Extracted from RestHandler (rest-handler.ts) as part of domain split.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { OrchestratorContext } from "../orchestrator-context.js";
import { readJsonObjectFile, writeJsonFileAtomic } from "./customization-transfer.js";

/** Route result envelope, as returned to RestHandler. */
type RouteResult = { status: number; data: unknown };

/**
 * McpRoutes — handles POST/PUT/DELETE /api/mcp and POST /api/mcp/:name/toggle.
 *
 * Also exposes readClaudeJson() and settingsJsonPath for the mcp GET list
 * (called inline from the RestHandler dispatch for the GET case).
 *
 * Every write is read-modify-write of a file Claude Code owns. The read goes
 * through readJsonObjectFile, which reports an unreadable / unparseable /
 * non-object file as an error instead of `{}`; the route then answers 409 and
 * leaves the file byte-identical rather than replacing Claude Code's whole
 * state with a near-empty object.
 */
export class McpRoutes {
  constructor(private readonly ctx: OrchestratorContext) {}

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Path to ~/.claude.json */
  get claudeJsonPath(): string {
    return join(homedir(), ".claude.json");
  }

  /** Path to settings.json (Claude Code settings) */
  get settingsJsonPath(): string {
    return join(homedir(), ".claude", "settings.json");
  }

  /**
   * Read ~/.claude.json for DISPLAY, returning the parsed object or `{}`.
   *
   * Lenient on purpose: the GET list only renders it. Never feed this result
   * back into a write — use {@link updateJsonObject}, which refuses instead.
   */
  readClaudeJson(): Record<string, unknown> {
    const read = readJsonObjectFile(this.claudeJsonPath);
    return read.ok ? read.obj : {};
  }

  /**
   * Read-modify-write a JSON object file.
   *
   * `mutate` either changes the object and returns null (→ the file is
   * written atomically and `onWritten` builds the 200 body), or returns a
   * RouteResult to short-circuit without writing (404 / 409 for a missing or
   * duplicate server). A file that exists but is not a readable JSON object
   * is answered with 409 and never written.
   */
  private updateJsonObject(
    path: string,
    mutate: (obj: Record<string, unknown>) => RouteResult | null,
    onWritten: (obj: Record<string, unknown>) => unknown,
  ): RouteResult {
    const read = readJsonObjectFile(path);
    if (!read.ok) return { status: 409, data: { error: read.error } };
    const early = mutate(read.obj);
    if (early) return early;
    const writeErr = writeJsonFileAtomic(path, read.obj);
    if (writeErr) return { status: 500, data: { error: writeErr } };
    return { status: 200, data: onWritten(read.obj) };
  }

  /**
   * The `mcpServers` map of a parsed ~/.claude.json, created when absent.
   * Throws when it exists but is not an object — assigning a server into an
   * array or string would be silently lost on serialisation.
   */
  private serversOf(data: Record<string, unknown>): Record<string, Record<string, unknown>> {
    if (data.mcpServers === undefined) data.mcpServers = {};
    const servers = data.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      throw new Error("mcpServers in ~/.claude.json is not an object");
    }
    return servers as Record<string, Record<string, unknown>>;
  }

  // ---------------------------------------------------------------------------
  // Public route methods
  // ---------------------------------------------------------------------------

  /** Add a new MCP server to ~/.claude.json */
  cmdMcpAdd(
    serverName: string,
    config: { command: string; args?: string[]; env?: Record<string, string> },
  ): RouteResult {
    try {
      return this.updateJsonObject(
        this.claudeJsonPath,
        (data) => {
          const servers = this.serversOf(data);
          if (servers[serverName]) {
            return { status: 409, data: { error: `MCP server '${serverName}' already exists` } };
          }
          servers[serverName] = {
            command: config.command,
            args: config.args ?? [],
            ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
          };
          return null;
        },
        (data) => ({ ok: true, servers: Object.keys(this.serversOf(data)) }),
      );
    } catch (err) {
      return { status: 500, data: { error: `Failed to add MCP server: ${err}` } };
    }
  }

  /** Update an existing MCP server in ~/.claude.json */
  cmdMcpUpdate(
    serverName: string,
    config: { command?: string; args?: string[]; env?: Record<string, string> },
  ): RouteResult {
    try {
      return this.updateJsonObject(
        this.claudeJsonPath,
        (data) => {
          const server = this.serversOf(data)[serverName];
          if (!server) {
            return { status: 404, data: { error: `MCP server '${serverName}' not found` } };
          }
          if (config.command !== undefined) server.command = config.command;
          if (config.args !== undefined) server.args = config.args;
          if (config.env !== undefined) {
            if (Object.keys(config.env).length > 0) {
              server.env = config.env;
            } else {
              delete server.env;
            }
          }
          return null;
        },
        () => ({ ok: true }),
      );
    } catch (err) {
      return { status: 500, data: { error: `Failed to update MCP server: ${err}` } };
    }
  }

  /** Delete an MCP server from ~/.claude.json */
  cmdMcpDelete(serverName: string): RouteResult {
    try {
      return this.updateJsonObject(
        this.claudeJsonPath,
        (data) => {
          const servers = this.serversOf(data);
          if (!servers[serverName]) {
            return { status: 404, data: { error: `MCP server '${serverName}' not found` } };
          }
          delete servers[serverName];
          return null;
        },
        (data) => ({ ok: true, servers: Object.keys(this.serversOf(data)) }),
      );
    } catch (err) {
      return { status: 500, data: { error: `Failed to delete MCP server: ${err}` } };
    }
  }

  /** Toggle MCP server enable/disable in settings.json */
  cmdMcpToggle(serverName: string): RouteResult {
    try {
      let nowDisabled = false;
      return this.updateJsonObject(
        this.settingsJsonPath,
        (settings) => {
          const raw = settings.disabledMcpServers ?? [];
          if (!Array.isArray(raw)) {
            return {
              status: 409,
              data: { error: `disabledMcpServers in ${this.settingsJsonPath} is not an array — refusing to overwrite it` },
            };
          }
          const disabled = raw as unknown[];
          const idx = disabled.indexOf(serverName);
          if (idx >= 0) {
            disabled.splice(idx, 1);
          } else {
            disabled.push(serverName);
          }
          nowDisabled = idx < 0;
          settings.disabledMcpServers = disabled;
          return null;
        },
        () => ({ ok: true, disabled: nowDisabled }),
      );
    } catch (err) {
      return { status: 500, data: { error: `Failed to toggle MCP server: ${err}` } };
    }
  }
}
