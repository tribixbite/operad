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

import { execSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { ToolContext } from "./tools.js";
import { sendKeys, formatTmuxTarget } from "./session.js";

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
      db: this.ctx.getMemoryDb()!,
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
          // argv array, no shell. JSON.stringify only double-quotes the
          // session name, and sh expands `$(…)` inside double quotes — a name
          // of `$(id > /tmp/pwn)nosuch` executed the payload and then reported
          // failure, so the injection was invisible in the tool output. This
          // is reachable from the `session-output` tool, category `observe`,
          // which is auto-approved at every autonomy level.
          const safeLines = Number.isFinite(lines)
            ? Math.max(1, Math.min(10_000, Math.floor(lines)))
            : 100;
          const proc = spawnSync(
            "tmux",
            ["capture-pane", "-t", formatTmuxTarget(name, true), "-p", "-S", `-${safeLines}`],
            { encoding: "utf-8", timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
          );
          if (proc.error || proc.status !== 0) return null;
          const output = (proc.stdout ?? "").trim();
          return output || null;
        } catch { return null; }
      },
      sendToSession: (name: string, text: string) => {
        sendKeys(name, text);
      },
    };
  }
}
