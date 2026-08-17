import { join } from "node:path";
import { homedir } from "node:os";
import { saveSnapshot, pruneSnapshots } from "./agent-state.js";
import {
  shouldConsolidate,
  runConsolidation,
  getLastConsolidationTime,
  type IdleConditions,
} from "./consolidation.js";
import type { OrchestratorContext } from "./orchestrator-context.js";

/**
 * PersistenceEngine — extracted subsystem for scheduling and state persistence.
 *
 * Handles periodic concerns that sit above StateManager (which owns the
 * state.json read/write primitives) but below the full Daemon:
 *   - Daily agent snapshots (self-deduplicating, called from cognitive timer)
 *   - Memory consolidation during idle periods (maybeConsolidate)
 *
 * Scheduled runs (executeScheduledRun) have since moved to AgentEngine — this
 * note used to say they stayed in Daemon and applied both extractAgentActions
 * and executeOodaActions, which is now doubly wrong: running both on one
 * response applied every learning twice, and that pairing was removed.
 *
 * Extraction is incremental — this class establishes the injection point.
 * Add methods here as Daemon dependencies are disentangled.
 */
export class PersistenceEngine {
  /** ISO date string of the last day snapshots were written (e.g. "2026-04-17") */
  private lastSnapshotDate: string | null = null;

  /**
   * @param ctx          Shared orchestrator dependency context.
   * @param snapshotDir  Base dir for daily agent snapshots. Defaults to the
   *                     real per-user location; tests pass a temp dir so they
   *                     stay hermetic (homedir() can't be redirected via $HOME
   *                     on bun — see testing-gotchas). Mirrors the injectable-
   *                     path pattern used by notifications.ts / prompts.ts.
   */
  constructor(
    private ctx: OrchestratorContext,
    private snapshotDir: string = join(homedir(), ".local", "share", "operad", "snapshots"),
  ) {}

  /**
   * Run daily agent snapshots if they have not yet been taken today.
   * Self-deduplicating: tracks the last run date and skips if already done.
   *
   * Should be called on every cognitive timer tick (~60s cadence).
   * Exported so Daemon can delegate its maybeDailySnapshot() call here.
   */
  maybeDailySnapshot(): void {
    const memoryDb = this.ctx.getMemoryDb();
    const { agentConfigs, log } = this.ctx;
    if (!memoryDb) return;

    const today = new Date().toISOString().slice(0, 10);
    if (this.lastSnapshotDate === today) return;

    const snapshotDir = this.snapshotDir;
    let anySucceeded = false;
    for (const agent of agentConfigs) {
      if (!agent.enabled) continue;
      try {
        saveSnapshot(memoryDb, agent, snapshotDir);
        pruneSnapshots(snapshotDir, agent.name);
        anySucceeded = true;
      } catch (err) {
        log.warn(`Snapshot failed for ${agent.name}: ${err}`);
      }
    }
    // Marked only after something actually landed. This was set before the
    // loop, so a transient failure (disk full, DB locked) burned the whole
    // day's snapshot with no retry until tomorrow.
    if (anySucceeded) this.lastSnapshotDate = today;

    // Same daily cadence: trim the history tables, which otherwise grow
    // without bound (agent_runs keeps full response text, agent_personality
    // inserts a row per trait update, tool_executions grows per call).
    try {
      memoryDb.pruneHistory();
    } catch (err) {
      log.warn(`History prune failed: ${err}`);
    }
    log.info(`Daily agent snapshots saved (${agentConfigs.filter((a) => a.enabled).length} agents)`);
  }

  /**
   * Check whether memory consolidation conditions are met and run it if so.
   *
   * Consolidation is skipped when:
   *   - memoryDb is not initialised
   *   - the system is not sufficiently idle (per shouldConsolidate threshold)
   *   - consolidation ran too recently (per getLastConsolidationTime)
   *
   * Should be called on every cognitive timer tick (~60 s cadence).
   */
  maybeConsolidate(): void {
    const memoryDb = this.ctx.getMemoryDb();
    if (!memoryDb) return;

    const { state, agentConfigs, log, broadcast, getLastActivityEpoch } = this.ctx;
    const systemState = state.getState();
    const now = Math.floor(Date.now() / 1000);
    const idleSeconds = now - getLastActivityEpoch();

    const conditions: IdleConditions = {
      idleSeconds,
      batteryPct: systemState.battery?.percentage ?? 100,
      charging: systemState.battery?.charging ?? true,
      sdkBusy: this.ctx.getSdkBridge()?.isAttached ?? false,
    };

    const lastRun = getLastConsolidationTime(memoryDb);
    if (!shouldConsolidate(conditions, lastRun)) return;

    const agentNames = agentConfigs.filter((a) => a.enabled).map((a) => a.name);
    const result = runConsolidation(memoryDb, agentNames, log);
    broadcast("consolidation", result as unknown as Record<string, unknown>);
  }
}
