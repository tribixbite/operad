import { homedir } from "node:os";
import { computeQuotaStatus } from "./memory-db.js";
import {
  buildOodaContext,
  buildOodaPrompt,
  parseOodaResponse,
} from "./cognitive.js";
import { toSdkAgentMap } from "./agents.js";
import type { OrchestratorContext } from "./orchestrator-context.js";

/**
 * AgentEngine — extracted subsystem for agent/cognitive/OODA workflows.
 * Takes an OrchestratorContext at construction — no direct daemon coupling.
 *
 * Full extraction from daemon.ts is incremental; initial shell establishes
 * the injection point. Methods are added as daemon.ts logic is moved over.
 */
export class AgentEngine {
  constructor(private ctx: OrchestratorContext) {}

  /**
   * Check OODA trigger conditions and run master controller if warranted.
   * Called every 60s by cognitiveTimer in Daemon.
   */
  async maybeTriggerOoda(): Promise<void> {
    const { sdkBridge, memoryDb, switchboard, agentConfigs, config, log } = this.ctx;

    // Don't run if SDK is busy or no memory DB
    if (!sdkBridge || !memoryDb) return;
    if (sdkBridge.isAttached || sdkBridge.isBusy) return;

    // Check switchboard — both cognitive and oodaAutoTrigger must be on
    if (!switchboard.cognitive || !switchboard.oodaAutoTrigger) return;

    // Check trigger conditions
    const masterAgent = agentConfigs.find((a) => a.name === "master-controller" && a.enabled);
    if (!masterAgent) return;

    // Quota guardrail: suppress auto-triggers when weekly quota is exceeded
    const quota = computeQuotaStatus(memoryDb, config.orchestrator);
    if (quota.weekly_level === "exceeded") {
      log.debug("OODA auto-trigger suppressed — weekly quota exceeded");
      return;
    }

    // Condition: unread messages waiting >5 min
    const unread = memoryDb.getUnreadMessages("master-controller");
    const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
    const urgentMessages = unread.filter((m) => (m.created_at as number) < fiveMinAgo);

    if (urgentMessages.length > 0) {
      log.info(`OODA trigger: ${urgentMessages.length} unread messages older than 5min`);
      await this.runOodaCycle();
      return;
    }

    // Other triggers can be added here:
    // - Cost threshold exceeded
    // - Memory pressure escalation
    // - Agent run completion (evaluate outcome)
    // Note: timer-based runs use scheduledOodaTimer from ```schedule``` blocks
  }

  /**
   * Run a full OODA cycle — build context, run master controller, parse and
   * execute actions from its response.
   */
  async runOodaCycle(): Promise<void> {
    const { sdkBridge, memoryDb, switchboard, state, config, agentConfigs, log } = this.ctx;

    if (!sdkBridge || !memoryDb) return;
    if (sdkBridge.isAttached) {
      log.debug("OODA cycle skipped — SDK session active");
      return;
    }

    // Check switchboard
    if (!switchboard.oodaAutoTrigger) {
      log.debug("OODA cycle skipped — disabled by switchboard");
      return;
    }

    // Quota circuit breaker: block when exceeded, warn on critical
    const quota = computeQuotaStatus(memoryDb, config.orchestrator);
    if (quota.weekly_level === "exceeded") {
      log.warn(`OODA cycle blocked — weekly quota exceeded (${quota.weekly_pct}%)`);
      this.ctx.broadcast("ooda_status", { running: false, blocked: "quota_exceeded" });
      return;
    }
    if (quota.weekly_level === "critical") {
      log.warn(`OODA cycle running under critical quota (${quota.weekly_pct}%) — consider reducing activity`);
    }

    const daemonState = state.getState();
    const oodaCtx = buildOodaContext(daemonState, memoryDb, config.orchestrator);

    // Strip profile data if mind meld is disabled
    if (!switchboard.mindMeld) {
      oodaCtx.userProfile = { traits: [], notes: [], styles: [], chat_export_count: 0 };
    }

    // Inject available tools for master controller (toolExecutor may not be ready yet)
    const toolExecutor = this.ctx.getToolExecutor();
    if (toolExecutor) {
      const masterAgentForTools = agentConfigs.find((a) => a.name === "master-controller");
      oodaCtx.availableToolsPrompt = toolExecutor.formatToolsForPrompt(
        masterAgentForTools?.allowed_tool_categories,
      );
    }

    const oodaPrompt = buildOodaPrompt(oodaCtx);

    log.info("Running OODA cycle for master-controller");
    this.ctx.broadcast("ooda_status", { running: true });

    try {
      const masterAgent = agentConfigs.find((a) => a.name === "master-controller");
      if (!masterAgent) return;

      const sdkDef = toSdkAgentMap([masterAgent])["master-controller"];
      const cwd = config.sessions.find((s) => s.path)?.path ?? homedir();

      const runId = memoryDb.startAgentRun("master-controller", "ooda-cycle", "standalone");

      const result = await sdkBridge.runStandaloneAgent(
        "master-controller", sdkDef, cwd, oodaPrompt, masterAgent.max_budget_usd,
      );

      memoryDb.completeAgentRun(runId, "completed", {
        sessionId: result.sessionId,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        turns: result.turns,
      });

      // Parse and execute structured OODA actions from response text
      if (result.responseText) {
        const actions = parseOodaResponse(result.responseText);
        if (actions.length > 0) {
          log.info(`OODA: parsed ${actions.length} actions from response`);
          await this.ctx.executeOodaActions(actions);
        }
      }

      log.info(`OODA cycle completed: cost=$${result.costUsd.toFixed(4)}, turns=${result.turns}`);
      this.ctx.broadcast("ooda_status", {
        running: false,
        lastRun: new Date().toISOString(),
        cost: result.costUsd,
      });
    } catch (err) {
      log.error(`OODA cycle failed: ${err}`);
      this.ctx.broadcast("ooda_status", { running: false, error: String(err) });
    }
  }
}
