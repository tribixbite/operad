/**
 * mcp-routes.ts — MCP server CRUD REST API route handlers.
 *
 * Handles add/update/delete/toggle of MCP servers stored in
 * ~/.claude.json and ~/.claude/settings.json.
 *
 * Extracted from RestHandler (rest-handler.ts) as part of domain split.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OrchestratorContext } from "../orchestrator-context.js";

/**
 * McpRoutes — handles POST/PUT/DELETE /api/mcp and POST /api/mcp/:name/toggle.
 *
 * Also exposes readClaudeJson() and settingsJsonPath for the mcp GET list
 * (called inline from the RestHandler dispatch for the GET case).
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

  /** Read ~/.claude.json, returning parsed object or empty default */
  readClaudeJson(): Record<string, unknown> {
    try {
      if (existsSync(this.claudeJsonPath)) {
        return JSON.parse(readFileSync(this.claudeJsonPath, "utf-8")) as Record<string, unknown>;
      }
    } catch { /* fall through */ }
    return {};
  }

  /** Atomic JSON file write: write .tmp then rename */
  private writeJsonFileAtomic(filePath: string, data: unknown): void {
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmp, filePath);
  }

  // ---------------------------------------------------------------------------
  // Public route methods
  // ---------------------------------------------------------------------------

  /** Add a new MCP server to ~/.claude.json */
  cmdMcpAdd(
    serverName: string,
    config: { command: string; args?: string[]; env?: Record<string, string> },
  ): { status: number; data: unknown } {
    try {
      const data = this.readClaudeJson();
      if (!data.mcpServers) data.mcpServers = {};
      const servers = data.mcpServers as Record<string, unknown>;
      if (servers[serverName]) {
        return { status: 409, data: { error: `MCP server '${serverName}' already exists` } };
      }
      servers[serverName] = {
        command: config.command,
        args: config.args ?? [],
        ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
      };
      this.writeJsonFileAtomic(this.claudeJsonPath, data);
      return { status: 200, data: { ok: true, servers: Object.keys(servers) } };
    } catch (err) {
      return { status: 500, data: { error: `Failed to add MCP server: ${err}` } };
    }
  }

  /** Update an existing MCP server in ~/.claude.json */
  cmdMcpUpdate(
    serverName: string,
    config: { command?: string; args?: string[]; env?: Record<string, string> },
  ): { status: number; data: unknown } {
    try {
      const data = this.readClaudeJson();
      const servers = (data.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
      if (!servers[serverName]) {
        return { status: 404, data: { error: `MCP server '${serverName}' not found` } };
      }
      if (config.command !== undefined) servers[serverName].command = config.command;
      if (config.args !== undefined) servers[serverName].args = config.args;
      if (config.env !== undefined) {
        if (Object.keys(config.env).length > 0) {
          servers[serverName].env = config.env;
        } else {
          delete servers[serverName].env;
        }
      }
      this.writeJsonFileAtomic(this.claudeJsonPath, data);
      return { status: 200, data: { ok: true } };
    } catch (err) {
      return { status: 500, data: { error: `Failed to update MCP server: ${err}` } };
    }
  }

  /** Delete an MCP server from ~/.claude.json */
  cmdMcpDelete(serverName: string): { status: number; data: unknown } {
    try {
      const data = this.readClaudeJson();
      const servers = (data.mcpServers ?? {}) as Record<string, unknown>;
      if (!servers[serverName]) {
        return { status: 404, data: { error: `MCP server '${serverName}' not found` } };
      }
      delete servers[serverName];
      this.writeJsonFileAtomic(this.claudeJsonPath, data);
      return { status: 200, data: { ok: true, servers: Object.keys(servers) } };
    } catch (err) {
      return { status: 500, data: { error: `Failed to delete MCP server: ${err}` } };
    }
  }

  /** Toggle MCP server enable/disable in settings.json */
  cmdMcpToggle(serverName: string): { status: number; data: unknown } {
    try {
      let settings: Record<string, unknown> = {};
      if (existsSync(this.settingsJsonPath)) {
        try {
          settings = JSON.parse(readFileSync(this.settingsJsonPath, "utf-8")) as Record<string, unknown>;
        } catch { /* use empty */ }
      }
      const disabled = (settings.disabledMcpServers ?? []) as string[];
      const idx = disabled.indexOf(serverName);
      if (idx >= 0) {
        disabled.splice(idx, 1);
      } else {
        disabled.push(serverName);
      }
      settings.disabledMcpServers = disabled;
      this.writeJsonFileAtomic(this.settingsJsonPath, settings);
      return { status: 200, data: { ok: true, disabled: idx < 0 } };
    } catch (err) {
      return { status: 500, data: { error: `Failed to toggle MCP server: ${err}` } };
    }
  }
}
