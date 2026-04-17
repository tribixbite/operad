/**
 * tool-engine.ts — Daemon-side coordination layer for the tool subsystem.
 *
 * The ToolExecutor in src/tools.ts owns the registry and execution logic.
 * ToolEngine provides daemon-side helpers (context builders, lifecycle hooks)
 * that depend on runtime session/memory state.
 *
 * Extraction notes:
 * - buildToolContext() moved here from Daemon; thin delegation stub retained there.
 * - Daemon still holds toolExecutor (initialized in start()) and exposes it
 *   through OrchestratorContext.getToolExecutor().
 * - Future tool-lifecycle hooks (e.g. lease expiry, audit flushing) belong here.
 */

import { execSync } from "node:child_process";
import { homedir } from "node:os";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { ToolContext } from "./tools.js";
import { sendKeys } from "./session.js";

export class ToolEngine {
  constructor(private ctx: OrchestratorContext) {}

  /**
   * Build a ToolContext for a specific agent with live session/system accessors.
   * Extracted from Daemon.buildToolContext.
   *
   * @param agentName - Name of the agent that will consume this context.
   */
  buildToolContext(agentName: string): ToolContext {
    const state = this.ctx.state.getState();
    return {
      agentName,
      // Use the first configured session path as cwd, falling back to $HOME
      cwd: this.ctx.config.sessions.find((s) => s.path)?.path ?? homedir(),
      // memoryDb is guaranteed non-null when agents are running (start() ensures it)
      db: this.ctx.memoryDb!,
      log: this.ctx.log,
      signal: new AbortController().signal,
      getSessionStates: () => {
        const result: Record<string, { status: string; activity: string | null; rss_mb: number | null }> = {};
        for (const [name, s] of Object.entries(state.sessions)) {
          result[name] = { status: s.status, activity: s.activity, rss_mb: s.rss_mb };
        }
        return result;
      },
      getSystemMemory: () =>
        state.memory
          ? { available_mb: state.memory.available_mb, pressure: state.memory.pressure }
          : null,
      getBattery: () =>
        state.battery
          ? { pct: state.battery.percentage, charging: state.battery.charging }
          : null,
      captureSessionOutput: (name: string, lines: number) => {
        try {
          const output = execSync(
            `tmux capture-pane -t ${JSON.stringify(name)} -p -S -${lines}`,
            { encoding: "utf-8", timeout: 3000 },
          ).trim();
          return output || null;
        } catch { return null; }
      },
      sendToSession: (name: string, text: string) => {
        sendKeys(name, text);
      },
    };
  }
}
