import { join } from "node:path";
import { homedir } from "node:os";
import { saveSnapshot, pruneSnapshots } from "./agent-state.js";
import type { OrchestratorContext } from "./orchestrator-context.js";

/**
 * PersistenceEngine — extracted subsystem for scheduling and state persistence.
 *
 * Handles periodic concerns that sit above StateManager (which owns the
 * state.json read/write primitives) but below the full Daemon:
 *   - Daily agent snapshots (self-deduplicating, called from cognitive timer)
 *
 * Methods not yet extracted (entangled with Daemon private state):
 *   - maybeConsolidate — needs lastUserActivityEpoch; extract after a
 *     getIdleSeconds getter is added to OrchestratorContext (TODO)
 *   - executeScheduledRun — calls extractAgentActions + executeOodaActions,
 *     themselves not yet extracted; stays in Daemon for now (TODO)
 *
 * Extraction is incremental — this class establishes the injection point.
 * Add methods here as Daemon dependencies are disentangled.
 */
export class PersistenceEngine {
  /** ISO date string of the last day snapshots were written (e.g. "2026-04-17") */
  private lastSnapshotDate: string | null = null;

  constructor(private ctx: OrchestratorContext) {}

  /**
   * Run daily agent snapshots if they have not yet been taken today.
   * Self-deduplicating: tracks the last run date and skips if already done.
   *
   * Should be called on every cognitive timer tick (~60s cadence).
   * Exported so Daemon can delegate its maybeDailySnapshot() call here.
   */
  maybeDailySnapshot(): void {
    const { memoryDb, agentConfigs, log } = this.ctx;
    if (!memoryDb) return;

    const today = new Date().toISOString().slice(0, 10);
    if (this.lastSnapshotDate === today) return;
    this.lastSnapshotDate = today;

    const snapshotDir = join(homedir(), ".local", "share", "operad", "snapshots");
    for (const agent of agentConfigs) {
      if (!agent.enabled) continue;
      try {
        saveSnapshot(memoryDb, agent, snapshotDir);
        pruneSnapshots(snapshotDir, agent.name);
      } catch (err) {
        log.warn(`Snapshot failed for ${agent.name}: ${err}`);
      }
    }
    log.info(`Daily agent snapshots saved (${agentConfigs.filter((a) => a.enabled).length} agents)`);
  }
}
