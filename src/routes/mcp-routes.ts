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
 * McpRoutes — handles GET/POST/PUT/DELETE /api/mcp and POST /api/mcp/:name/toggle.
 *
 * Every route reads through readJsonObjectFile; GET reports an unreadable
 * file as a 409 naming it, exactly like the writes.
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
   * The 409 every MCP route returns when a config file it depends on is
   * unreadable, unparseable, or the wrong shape. `file` names which one, so
   * the client can tell "~/.claude.json is broken" from "settings.json is
   * broken" without parsing the message.
   */
  private unreadable(file: string, error: string): RouteResult {
    return { status: 409, data: { error, file } };
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
    if (!read.ok) return this.unreadable(path, read.error);
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

  /**
   * GET /api/mcp — list MCP servers from ~/.claude.json with their enabled
   * state from settings.json.
   *
   * Strict, like the write routes: an unreadable / unparseable / wrong-shaped
   * file is a 409 naming it. The list used to fall back to {} (a broken
   * ~/.claude.json looked exactly like "no servers configured") and parse
   * settings.json unguarded (a broken one was a bare 500).
   */
  cmdMcpList(): RouteResult {
    const claude = readJsonObjectFile(this.claudeJsonPath);
    if (!claude.ok) return this.unreadable(this.claudeJsonPath, claude.error);
    const rawServers = claude.obj.mcpServers ?? {};
    if (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers)) {
      return this.unreadable(this.claudeJsonPath, `mcpServers in ${this.claudeJsonPath} is not an object`);
    }

    const settings = readJsonObjectFile(this.settingsJsonPath);
    if (!settings.ok) return this.unreadable(this.settingsJsonPath, settings.error);
    const disabled = settings.obj.disabledMcpServers ?? [];
    if (!Array.isArray(disabled)) {
      return this.unreadable(this.settingsJsonPath, `disabledMcpServers in ${this.settingsJsonPath} is not an array`);
    }

    const servers = Object.entries(rawServers as Record<string, Record<string, unknown> | null>)
      .map(([name, cfg]) => ({
        name,
        command: cfg?.command ?? "",
        args: cfg?.args ?? [],
        env: cfg?.env ?? {},
        enabled: !disabled.includes(name),
        source: "claude-json" as const,
      }));
    return { status: 200, data: { servers } };
  }

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
            return this.unreadable(
              this.settingsJsonPath,
              `disabledMcpServers in ${this.settingsJsonPath} is not an array — refusing to overwrite it`,
            );
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
