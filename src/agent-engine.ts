import { homedir } from "node:os";
import { computeQuotaStatus } from "./memory-db.js";
import {
  buildOodaContext,
  buildOodaPrompt,
  parseOodaResponse,
  type OodaAction,
} from "./cognitive.js";
import { loadAgents, toSdkAgentMap } from "./agents.js";
import type { ScheduleRecord } from "./schedule.js";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type WebSocket from "ws";

/**
 * AgentEngine — extracted subsystem for agent/cognitive/OODA workflows.
 * Takes an OrchestratorContext at construction — no direct daemon coupling.
 *
 * Full extraction from daemon.ts is incremental; initial shell establishes
 * the injection point. Methods are added as daemon.ts logic is moved over.
 */
export class AgentEngine {
  /** Timer handle for the next scheduled OODA run (set by schedule action blocks). */
  private scheduledOodaTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: OrchestratorContext) {}

  /**
   * Clear any pending scheduled OODA timer. Called during daemon shutdown.
   */
  clearScheduledOodaTimer(): void {
    if (this.scheduledOodaTimer) {
      clearTimeout(this.scheduledOodaTimer);
      this.scheduledOodaTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Agent config lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Reload agent configs from TOML and project .claude/agents/ directories.
   * Mutates ctx.agentConfigs in-place (splice + push) so all existing
   * references (closures, ctx fields) stay valid.
   * Also updates SDK bridge with the filtered enabled-agent map.
   */
  reloadAgents(): void {
    const { config, log } = this.ctx;
    const projectPaths = config.sessions
      .filter((s) => s.path)
      .map((s) => s.path!);
    const freshConfigs = loadAgents(config.agents ?? [], projectPaths);

    // Mutate in-place to keep all existing references valid
    this.ctx.agentConfigs.splice(0, this.ctx.agentConfigs.length, ...freshConfigs);

    // Ensure all known agents appear in switchboard (default: true = follow agent.enabled)
    const switchboard = this.ctx.getSwitchboard();
    for (const agent of this.ctx.agentConfigs) {
      if (!(agent.name in switchboard.agents)) {
        switchboard.agents[agent.name] = true;
      }
    }

    // Apply switchboard overrides: master switch + per-agent toggles
    const enabledAgents = this.ctx.agentConfigs.filter((a) => this.ctx.isAgentEnabled(a.name));
    const sdkBridgeForAgents = this.ctx.getSdkBridge();
    if (sdkBridgeForAgents) {
      sdkBridgeForAgents.updateAgents(toSdkAgentMap(enabledAgents));
    }

    // Seed default specializations for builtin agents (idempotent — upsert won't overwrite)
    this.seedSpecializations();

    log.info(`Reloaded agents: ${enabledAgents.length} enabled`);
  }

  /**
   * Seed default specializations for builtin agents (upsert is idempotent).
   * Called automatically by reloadAgents().
   */
  seedSpecializations(): void {
    const memoryDb = this.ctx.getMemoryDb();
    if (!memoryDb) return;

    const defaults: Record<string, string[]> = {
      "optimizer": ["performance", "resource-management", "token-efficiency"],
      "preference-learner": ["user-preferences", "coding-style", "communication"],
      "ideator": ["architecture", "creative-solutions", "exploration"],
      "master-controller": ["orchestration", "planning", "delegation"],
    };

    for (const [agent, domains] of Object.entries(defaults)) {
      // Only seed if agent is actually loaded
      if (!this.ctx.agentConfigs.some((a) => a.name === agent)) continue;
      for (const domain of domains) {
        try {
          // upsert with low confidence — will be reinforced by actual evidence
          memoryDb.upsertSpecialization(agent, domain, 0.5, "builtin default");
        } catch {
          // Table may not exist during first migration — silently skip
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // OODA cycle methods
  // ---------------------------------------------------------------------------

  /**
   * Check OODA trigger conditions and run master controller if warranted.
   * Called every 60s by cognitiveTimer in Daemon.
   */
  async maybeTriggerOoda(): Promise<void> {
    const { agentConfigs, config, log } = this.ctx;
    const sdkBridge = this.ctx.getSdkBridge();
    const memoryDb = this.ctx.getMemoryDb();

    // Don't run if SDK is busy or no memory DB
    if (!sdkBridge || !memoryDb) return;
    if (sdkBridge.isAttached || sdkBridge.isBusy) return;

    // Check switchboard — both cognitive and oodaAutoTrigger must be on
    const switchboard = this.ctx.getSwitchboard();
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
      // Mark them read BEFORE the cycle, not after.
      //
      // markMessagesRead had no production caller at all, so the inbox never
      // drained: one message made the 60s cognitive timer fire a full paid SDK
      // cycle forever. It self-fed too — getUnreadMessages matches to_agent
      // '*', which the master controller's own broadcast blocks produce — and
      // every unread message's full text is injected into the prompt, so the
      // prompt grew without bound alongside the spend.
      //
      // Marking first (rather than in a finally) means a cycle that throws
      // does not re-trigger on the same messages; they are still readable in
      // the history, and a genuinely new message re-arms the trigger.
      memoryDb.markMessagesRead(
        urgentMessages
          .map((m) => m.id as number)
          .filter((id) => typeof id === "number"),
      );
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
   *
   * Phase A2: acquires an `agent_cycle` consumer pin for the duration of
   * the cycle so the skill install gate (§3.7) doesn't race a registry
   * mutation against a cycle that's about to call a tool. Pin released
   * in finally — leaks would permanently block installs until daemon
   * restart, see ConsumerTracker stale-pin warning.
   */
  async runOodaCycle(): Promise<void> {
    const { state, config, agentConfigs, log } = this.ctx;
    const sdkBridge = this.ctx.getSdkBridge();
    const memoryDb = this.ctx.getMemoryDb();

    if (!sdkBridge || !memoryDb) return;
    if (sdkBridge.isAttached) {
      log.debug("OODA cycle skipped — SDK session active");
      return;
    }

    // Check switchboard
    const switchboard = this.ctx.getSwitchboard();
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

    // Phase A2 consumer pin — released in finally below. The
    // returned handle carries the snapshotted ToolExecutor generation
    // (Phase C); we don't currently route it through the SDK-driven
    // OODA path because the SDK owns its own tool invocation, but
    // future direct toolExecutor.execute calls in this method should
    // pass `pin.generation` as the trailing arg to honour the
    // snapshot.
    const pin = this.ctx.getConsumerTracker().acquire("agent_cycle");
    const releasePin = pin.release;

    // Hoisted so the catch can finalise the row; it was declared inside the
    // try, which is why the error path could never close it out.
    let runId = 0;

    try {
      const masterAgent = agentConfigs.find((a) => a.name === "master-controller");
      if (!masterAgent) return;

      const sdkDef = toSdkAgentMap([masterAgent])["master-controller"];
      const cwd = config.sessions.find((s) => s.path)?.path ?? homedir();

      runId = memoryDb.startAgentRun("master-controller", "ooda-cycle", "standalone", oodaPrompt);

      const result = await sdkBridge.runStandaloneAgent(
        "master-controller", sdkDef, cwd, oodaPrompt, masterAgent.max_budget_usd,
      );

      memoryDb.completeAgentRun(runId, "completed", {
        sessionId: result.sessionId,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        turns: result.turns,
        responseText: result.responseText,
        thinkingText: result.thinkingText || undefined,
      });

      // Parse and execute structured OODA actions from response text
      if (result.responseText) {
        const actions = parseOodaResponse(result.responseText);
        if (actions.length > 0) {
          log.info(`OODA: parsed ${actions.length} actions from response`);
          await this.executeOodaActions(actions);
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
      // Close the run row out. startAgentRun inserted it as 'running', and
      // nothing here completed it on the error path — so any throw from
      // runStandaloneAgent (SDK missing, bridge busy, budget abort) left the
      // row 'running' forever, with no startup reconciliation anywhere. They
      // accumulated in the dashboard indefinitely.
      if (runId) {
        try {
          memoryDb.completeAgentRun(runId, "failed", { error: String(err) });
        } catch (dbErr) {
          log.warn(`Could not finalise OODA run ${runId}: ${dbErr}`);
        }
      }
      this.ctx.broadcast("ooda_status", { running: false, error: String(err) });
    } finally {
      releasePin();
    }
  }

  // ---------------------------------------------------------------------------
  // OODA action dispatcher
  // ---------------------------------------------------------------------------

  /**
   * Execute parsed OODA actions from master controller response.
   * Called after parseOodaResponse() returns structured actions.
   * Moved here from Daemon so the OODA loop is fully self-contained in AgentEngine.
   */
  /**
   * Apply the actions parsed out of an agent response.
   *
   * `actingAgent` is the agent the actions belong to. It used to be hardcoded
   * to "master-controller" throughout, which meant a scheduled run of any
   * other agent had its tool calls, trust deltas, goals, decisions, messages,
   * strategy changes and learnings all attributed to — and authorised as —
   * master-controller. A read-only `optimizer` schedule could therefore run
   * mutate tools, and a ```strategy``` block from any scheduled agent
   * overwrote master-controller's active strategy.
   */
  async executeOodaActions(
    actions: OodaAction[],
    actingAgent = "master-controller",
  ): Promise<void> {
    const { agentConfigs, config, log } = this.ctx;
    const memoryDb = this.ctx.getMemoryDb();
    if (!memoryDb) return;

    // Per-run tool call budget tracking
    const actor = agentConfigs.find((a) => a.name === actingAgent);
    const maxToolCalls = actor?.max_tool_calls_per_run ?? 20;
    let toolCallCount = 0;
    // The gate that decides whether a tool runs unattended. Falls back to the
    // most restrictive level when the agent has no explicit setting.
    const actorAutonomy = actor?.autonomy_level ?? "observe";

    // Quota-level tool restriction: when critical/exceeded, block non-observe tools
    const quotaLevel = computeQuotaStatus(memoryDb, config.orchestrator).weekly_level;
    const quotaRestrictTools = quotaLevel === "exceeded" || quotaLevel === "critical";

    for (const action of actions) {
      try {
        switch (action.type) {
          case "goal":
            memoryDb.createGoal(action.title, {
              description: action.description,
              parentId: action.parentId,
              priority: action.priority,
              agentName: actingAgent,
            });
            log.info(`OODA: created goal "${action.title}"`);
            break;

          case "decision":
            memoryDb.recordDecision(actingAgent, action.action, action.rationale, {
              goalId: action.goalId,
              alternatives: action.alternatives ? [action.alternatives] : undefined,
              expectedOutcome: action.expectedOutcome,
            });
            log.info(`OODA: recorded decision "${action.action}"`);
            break;

          case "message": {
            const msgId = memoryDb.sendAgentMessage(actingAgent, action.to, action.content, {
              messageType: action.messageType,
            });
            // Broadcast to dashboard for real-time message viewer
            this.ctx.broadcast("agent_message", {
              id: msgId, from_agent: actingAgent, to_agent: action.to,
              message_type: action.messageType, content: action.content,
              created_at: Math.floor(Date.now() / 1000),
            });
            log.info(`OODA: sent message to ${action.to}`);
            break;
          }

          case "strategy":
            memoryDb.evolveStrategy(actingAgent, action.text, action.rationale);
            log.info(`OODA: evolved strategy`);
            break;

          case "learning":
            memoryDb.addLearning(actingAgent, action.category, action.content, {
              confidence: action.confidence,
            });
            log.info(`OODA: learned [${action.category}] ${action.content.slice(0, 60)}`);
            break;

          case "personality":
            memoryDb.setPersonalityTrait(actingAgent, action.trait, action.value, action.evidence);
            log.info(`OODA: personality ${action.trait}=${action.value}`);
            break;

          case "schedule": {
            // Schedule next OODA run — timer owned by AgentEngine
            if (this.scheduledOodaTimer) clearTimeout(this.scheduledOodaTimer);
            const delayMs = action.delayMinutes * 60 * 1000;
            this.scheduledOodaTimer = setTimeout(() => {
              this.runOodaCycle().catch((err) => {
                log.warn(`Scheduled OODA cycle failed: ${err}`);
              });
            }, delayMs);
            log.info(`OODA: scheduled next run in ${action.delayMinutes}min (${action.reason})`);
            break;
          }

          case "tool_call": {
            const toolExecutor = this.ctx.getToolExecutor();
            if (!toolExecutor || !memoryDb) break;
            // Enforce per-run tool call budget
            if (toolCallCount >= maxToolCalls) {
              log.warn(`OODA: tool call budget exhausted (${maxToolCalls}), skipping ${action.name}`);
              break;
            }
            // Quota restriction: only observe tools when critical/exceeded
            if (quotaRestrictTools) {
              const toolDef = toolExecutor.getTool(action.name);
              if (toolDef && toolDef.category !== "observe") {
                log.warn(`OODA: tool ${action.name} (${toolDef.category}) blocked — quota ${quotaLevel}`);
                break;
              }
            }
            const toolEngine = this.ctx.getToolEngine();
            const toolCtx = toolEngine
              ? toolEngine.buildToolContext(actingAgent)
              : null;
            if (!toolCtx) break;
            const result = await toolExecutor.execute(action.name, action.params, toolCtx, undefined, {
              autonomyLevel: actorAutonomy,
              protectedCheckpoints: config.orchestrator.protected_checkpoints,
              hasLease: (name) => memoryDb.hasActiveLease(actingAgent, name),
            });
            toolCallCount++;
            log.info(`OODA: tool ${action.name} [${toolCallCount}/${maxToolCalls}] → ${result.success ? "ok" : "fail"}: ${result.summary.slice(0, 80)}`);
            // Trust calibration: success → +2, failure → -5
            memoryDb.recordTrustDelta(
              actingAgent,
              result.success ? 2 : -5,
              `tool ${action.name}: ${result.success ? "success" : "failed"}`,
            );
            // Charge the lease only when a lease is what allowed the call.
            // Charging unconditionally spent a capped grant on calls the
            // agent's own autonomy level already permitted, exhausting it for
            // no reason.
            if (result.authorisedByLease) {
              memoryDb.incrementLeaseUsage(actingAgent, action.name);
            }
            // Broadcast tool result to dashboard
            this.ctx.broadcast("tool_result", {
              agent: actingAgent, tool: action.name,
              success: result.success, summary: result.summary,
              duration_ms: result.duration_ms,
            });
            break;
          }

          case "tool_sequence": {
            const toolExecutor = this.ctx.getToolExecutor();
            if (!toolExecutor || !memoryDb) break;
            const toolEngine = this.ctx.getToolEngine();
            const toolCtx = toolEngine
              ? toolEngine.buildToolContext(actingAgent)
              : null;
            if (!toolCtx) break;
            log.info(`OODA: executing tool sequence (${action.steps.length} steps): ${action.reason}`);
            for (const step of action.steps) {
              // Enforce per-run tool call budget across sequences
              if (toolCallCount >= maxToolCalls) {
                log.warn(`OODA: tool call budget exhausted (${maxToolCalls}), aborting sequence at ${step.name}`);
                break;
              }
              // Quota restriction: only observe tools when critical/exceeded
              if (quotaRestrictTools) {
                const stepDef = toolExecutor.getTool(step.name);
                if (stepDef && stepDef.category !== "observe") {
                  log.warn(`OODA: seq step ${step.name} (${stepDef.category}) blocked — quota ${quotaLevel}`);
                  continue; // skip this step but continue sequence
                }
              }
              const result = await toolExecutor.execute(step.name, step.params, toolCtx, undefined, {
                autonomyLevel: actorAutonomy,
                protectedCheckpoints: config.orchestrator.protected_checkpoints,
                hasLease: (name) => memoryDb.hasActiveLease(actingAgent, name),
              });
              toolCallCount++;
              log.info(`OODA: seq step ${step.name} [${toolCallCount}/${maxToolCalls}] → ${result.success ? "ok" : "fail"}`);
              // Trust calibration for sequence steps
              memoryDb.recordTrustDelta(
                actingAgent,
                result.success ? 2 : -5,
                `seq ${step.name}: ${result.success ? "success" : "failed"}`,
              );
              if (result.authorisedByLease) {
                memoryDb.incrementLeaseUsage(actingAgent, step.name);
              }
              if (!result.success) {
                log.warn(`OODA: tool sequence aborted at ${step.name}: ${result.summary}`);
                break;
              }
            }
            break;
          }

          case "persistent_schedule": {
            const id = this.ctx.upsertSchedule({
              agentName: actingAgent,
              scheduleName: action.name,
              cronExpr: action.cronExpr,
              intervalMinutes: action.intervalMinutes,
              prompt: action.prompt,
              maxBudgetUsd: action.maxBudgetUsd,
              createdBy: "agent",
            });
            if (id >= 0) {
              log.info(`OODA: created persistent schedule "${action.name}"`);
            } else {
              log.warn(`OODA: persistent_schedule "${action.name}" dropped — ScheduleEngine not ready`);
            }
            break;
          }

          case "roundtable": {
            log.info(`OODA: convening roundtable on "${action.topic}" with [${action.agents.join(", ")}]`);
            // Run async — don't block remaining OODA actions
            this.executeRoundtable(action.topic, action.agents, action.context).catch((err) => {
              log.warn(`Roundtable failed: ${err}`);
            });
            break;
          }
        }
      } catch (err) {
        log.warn(`OODA action failed (${action.type}): ${err}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Agent context & action helpers
  // ---------------------------------------------------------------------------

  /**
   * Build rich context for any agent run: datetime, past decisions, learnings, personality.
   * Prepended to agent prompts for contextual awareness and self-reflection.
   */
  buildAgentContext(agentName: string): string {
    const memoryDb = this.ctx.getMemoryDb();
    if (!memoryDb) return "";

    const parts: string[] = [];

    // Current datetime
    const now = new Date();
    parts.push(`## Current Time\n${now.toISOString()} (${now.toLocaleString()})`);

    // Personality snapshot — who you are
    const personality = memoryDb.getPersonalitySnapshot(agentName);
    if (personality.length > 0) {
      parts.push("## Your Personality Profile");
      for (const t of personality) {
        parts.push(`- ${t.trait_name}: ${t.trait_value.toFixed(2)}${t.evidence ? ` — ${t.evidence}` : ""}`);
      }
    }

    // Core knowledge — learnings that have graduated via repeated reinforcement.
    // These are pinned: separate from the rotating Accumulated Knowledge list
    // so heavily-validated facts don't fight for slot space with newer entries.
    // Borrowed from Kai's MemoryStore.getPromotionCandidates pattern — once a
    // memory crosses the reinforcement threshold it stops competing in the
    // confidence-DESC ordering and gets its own header.
    const core = memoryDb.getCoreAgentLearnings(agentName, 5);
    const corePinnedIds = new Set(core.map((c) => c.id));
    if (core.length > 0) {
      parts.push("## Core Knowledge (promoted via reinforcement)");
      for (const c of core) {
        const conf = c.confidence.toFixed(2);
        parts.push(`- [${c.category}] ${c.content} (confidence: ${conf}, reinforced ${c.reinforcement_count}x)`);
      }
    }

    // Accumulated learnings — what you know. Skip ids already pinned above so
    // the agent doesn't see the same fact twice.
    const learnings = memoryDb.getAgentLearnings(agentName, 10);
    const fresh = learnings.filter((l) => !corePinnedIds.has(l.id as number));
    if (fresh.length > 0) {
      parts.push("## Your Accumulated Knowledge");
      for (const l of fresh) {
        const conf = (l.confidence as number).toFixed(2);
        const reinforced = (l.reinforcement_count as number) > 1 ? ` (reinforced ${l.reinforcement_count}x)` : "";
        parts.push(`- [${l.category}] ${l.content} (confidence: ${conf}${reinforced})`);
      }
    }

    // Active strategy
    const strategy = memoryDb.getActiveStrategy(agentName);
    if (strategy) {
      parts.push(`## Your Current Strategy (v${strategy.version})\n${strategy.strategy_text}`);
    }

    // Recent scored decisions — self-reflection on past performance
    const decisions = memoryDb.getRecentDecisions(5, agentName);
    const scored = decisions.filter((d) => d.score != null);
    if (scored.length > 0) {
      parts.push("## Your Recent Decision Outcomes");
      for (const d of scored) {
        const outcome = d.actual_outcome ? ` | ${d.actual_outcome}` : "";
        parts.push(`- ${d.action}: score=${d.score}${outcome}`);
      }
    }

    // Decision quality trend
    const trend = memoryDb.getDecisionQualityTrend(agentName);
    if (trend.trend !== "insufficient_data") {
      const arrow = trend.trend === "improving" ? " ↑" : trend.trend === "declining" ? " ↓" : "";
      parts.push(`\n**Decision trend**: ${trend.trend}${arrow} (avg ${trend.avg_score?.toFixed(2)})`);
    }

    // Cross-agent insights — wisdom from other agents
    const shared = memoryDb.getSharedInsights(agentName, 0.7, 5);
    if (shared.length > 0) {
      parts.push("## Insights from Other Agents");
      for (const s of shared) {
        parts.push(`- [${s.agent_name}] ${s.content} (confidence: ${(s.confidence as number).toFixed(2)})`);
      }
    }

    // Domain specializations — what you're good at
    try {
      const specs = memoryDb.getSpecializations(agentName);
      if (specs.length > 0) {
        parts.push("## Your Specializations");
        for (const s of specs) {
          const reinforced = s.reinforcement_count > 0 ? ` (reinforced ${s.reinforcement_count}x)` : "";
          parts.push(`- ${s.domain}: ${s.confidence.toFixed(2)}${reinforced}`);
        }
      }
    } catch { /* table may not exist yet */ }

    return parts.join("\n");
  }

  /**
   * Extract learning and personality action blocks from agent response text.
   * Used after agent chat responses and standalone runs.
   */
  extractAgentActions(agentName: string, responseText: string): void {
    const { log } = this.ctx;
    const memoryDb = this.ctx.getMemoryDb();
    if (!memoryDb || !responseText) return;
    const actions = parseOodaResponse(responseText);
    for (const action of actions) {
      // Per-action isolation. This loop runs INSIDE the caller's try, after
      // the run has already been recorded as successful, so a throw here used
      // to be caught by the caller's `catch` and turned into
      // completeAgentRun(runId, "failed", …) — erasing the output the user
      // paid for. A malformed block from the model must not invalidate the
      // run, and must not stop the remaining blocks from applying.
      try {
      if (action.type === "learning") {
        memoryDb.addLearning(agentName, action.category, action.content, {
          confidence: action.confidence,
        });
        log.info(`Agent ${agentName} learned: [${action.category}] ${action.content.slice(0, 60)}`);

        // Auto-reinforce specialization matching the learning category
        try {
          const specs = memoryDb.getSpecializations(agentName);
          const match = specs.find((s) => s.domain === action.category);
          if (match) {
            memoryDb.upsertSpecialization(
              agentName, action.category, action.confidence ?? 0.6,
              `reinforced by learning: ${action.content.slice(0, 40)}`,
            );
          }
        } catch { /* specialization table may not exist yet */ }
      } else if (action.type === "personality") {
        memoryDb.setPersonalityTrait(agentName, action.trait, action.value, action.evidence);
        log.info(`Agent ${agentName} personality: ${action.trait}=${action.value}`);
      }
      } catch (err) {
        log.warn(
          `Agent ${agentName}: skipping malformed '${action.type}' block — `
          + `${(err as Error).message}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Agent run methods
  // ---------------------------------------------------------------------------

  /**
   * Handle a standalone (non-chat) agent run triggered from WS or REST API.
   * Enriches the prompt with agent context and tracks the run in DB.
   */
  async handleStandaloneAgentRun(agentName: string, prompt: string): Promise<Record<string, unknown>> {
    const { agentConfigs, config, log } = this.ctx;
    const sdkBridge = this.ctx.getSdkBridge();
    const memoryDb = this.ctx.getMemoryDb();
    if (!sdkBridge) throw new Error("SDK bridge not initialized");
    if (!this.ctx.getSwitchboard().all || !this.ctx.getSwitchboard().sdkBridge) throw new Error("SDK bridge disabled by switchboard");
    if (sdkBridge.isAttached) throw new Error("Cannot run agent — SDK session already active");

    const agent = agentConfigs.find((a) => a.name === agentName);
    if (!agent) throw new Error(`Agent not found: ${agentName}`);
    if (!this.ctx.isAgentEnabled(agentName)) throw new Error(`Agent is disabled: ${agentName}`);

    // Resolve cwd: use first session path or home directory
    const cwd = config.sessions.find((s) => s.path)?.path ?? homedir();
    const sdkDef = toSdkAgentMap([agent])[agentName];

    // Inject agent context: datetime, past decisions, learnings, personality
    const contextPrefix = this.buildAgentContext(agentName);
    const enrichedPrompt = contextPrefix ? `${contextPrefix}\n\n---\n\n${prompt}` : prompt;

    // Track the run in DB — store the user-supplied prompt (not the enriched
    // version) so the dashboard shows what was requested, not the framing.
    const runId = memoryDb?.startAgentRun(agentName, "standalone", "standalone", prompt) ?? 0;

    log.info(`Starting standalone agent run: ${agentName} (runId=${runId})`);
    this.ctx.broadcast("agent_run_update", { agentName, runId, status: "running" });

    try {
      const result = await sdkBridge.runStandaloneAgent(
        agentName, sdkDef, cwd, enrichedPrompt, agent.max_budget_usd,
      );

      if (memoryDb && runId > 0) {
        memoryDb.completeAgentRun(runId, "completed", {
          sessionId: result.sessionId,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          turns: result.turns,
          responseText: result.responseText,
          thinkingText: result.thinkingText || undefined,
        });
      }

      // Extract learnings and personality updates from response
      this.extractAgentActions(agentName, result.responseText);

      log.info(`Agent run completed: ${agentName} cost=$${result.costUsd.toFixed(4)}`);
      this.ctx.broadcast("agent_run_update", { agentName, runId, status: "completed", cost: result.costUsd });
      return { ok: true, runId, ...result };
    } catch (err) {
      if (memoryDb && runId > 0) {
        memoryDb.completeAgentRun(runId, "failed", { error: String(err) });
      }
      log.error(`Agent run failed: ${agentName}: ${err}`);
      this.ctx.broadcast("agent_run_update", { agentName, runId, status: "failed", error: String(err) });
      throw err;
    }
  }

  /**
   * Handle a persistent chat conversation with a specific agent.
   * Replays conversation history for multi-turn context.
   */
  async handleAgentChat(agentName: string, userPrompt: string, ws: WebSocket): Promise<void> {
    const { agentConfigs, config, log } = this.ctx;
    const sdkBridge = this.ctx.getSdkBridge();
    const memoryDb = this.ctx.getMemoryDb();
    if (!sdkBridge) throw new Error("SDK bridge not initialized");
    if (!memoryDb) throw new Error("Memory DB not initialized");
    if (sdkBridge.isAttached || sdkBridge.isBusy) throw new Error("SDK bridge busy — try again shortly");
    // Track user activity for idle detection (consolidation)
    this.ctx.updateLastActivityEpoch();

    const agent = agentConfigs.find((a) => a.name === agentName);
    if (!agent) throw new Error(`Agent not found: ${agentName}`);

    // Save user message to conversation history
    memoryDb.appendConversation(agentName, "user", userPrompt);

    // Build the full prompt with context
    const agentContext = this.buildAgentContext(agentName);
    const history = memoryDb.getConversationHistory(agentName, 20);

    // Replay conversation history for multi-turn context
    const historyText = history.slice(0, -1).map((m) => { // exclude the message we just appended
      const role = (m.role as string).toUpperCase();
      return `[${role}]: ${m.content}`;
    }).join("\n\n");

    const promptParts: string[] = [agent.prompt];
    if (agentContext) promptParts.push(agentContext);
    if (historyText) promptParts.push(`## Conversation History\n${historyText}`);

    // Self-improvement instructions already included in agent prompt (agents.ts)
    promptParts.push(`## Current Message\n${userPrompt}`);

    const fullPrompt = promptParts.join("\n\n---\n\n");

    // Resolve cwd and run
    const cwd = config.sessions.find((s) => s.path)?.path ?? homedir();
    const sdkDef = toSdkAgentMap([agent])[agentName];
    // Persist the raw user prompt (without history/context framing) so the
    // dashboard can show "what the user said" without leaking system context.
    const runId = memoryDb.startAgentRun(agentName, "chat", "manual", userPrompt);

    ws.send(JSON.stringify({ type: "agent_chat_start", agentName }));
    this.ctx.broadcast("agent_run_update", { agentName, runId, status: "running" });

    try {
      // Streaming callback — forward intermediate text chunks to WS client
      const onStream = (data: { text: string; thinking: string }) => {
        try {
          ws.send(JSON.stringify({ type: "agent_chat_stream", agentName, text: data.text, thinking: data.thinking }));
        } catch { /* ws may have closed */ }
      };

      const result = await sdkBridge.runStandaloneAgent(
        agentName, sdkDef, cwd, fullPrompt, agent.max_budget_usd, onStream,
      );

      // Save assistant response (including thinking text)
      memoryDb.appendConversation(agentName, "assistant", result.responseText, {
        sessionId: result.sessionId,
        thinking: result.thinkingText || undefined,
        costUsd: result.costUsd,
        tokensIn: result.inputTokens,
        tokensOut: result.outputTokens,
      });

      // Extract learnings and personality updates from response
      this.extractAgentActions(agentName, result.responseText);

      // Complete run tracking — also stash response/thinking text so the dashboard
      // Runs tab can show what the agent actually said (not just metadata).
      memoryDb.completeAgentRun(runId, "completed", {
        sessionId: result.sessionId,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        turns: result.turns,
        responseText: result.responseText,
        thinkingText: result.thinkingText || undefined,
      });

      try {
        ws.send(JSON.stringify({
          type: "agent_chat_result",
          agentName,
          content: result.responseText,
          thinking: result.thinkingText || null,
          cost: result.costUsd,
          tokens: { input: result.inputTokens, output: result.outputTokens },
        }));
      } catch { /* ws may have closed during the run */ }
      this.ctx.broadcast("agent_run_update", { agentName, runId, status: "completed", cost: result.costUsd });

    } catch (err) {
      log.error("Agent run failed", { agent: agentName, runId, err: String(err) });
      memoryDb.completeAgentRun(runId, "failed", { error: String(err) });
      this.ctx.broadcast("agent_run_update", { agentName, runId, status: "failed", error: String(err) });
      throw err;
    }
  }

  /**
   * Execute a roundtable discussion — sequential multi-agent consultation on a topic.
   * Each agent sees the accumulated transcript from prior agents and contributes
   * from their specialization. Result is sent to master-controller as an inbox message.
   */
  async executeRoundtable(
    topic: string, agentNames: string[], context?: string,
  ): Promise<{ transcript: string; contributions: Array<{ agent: string; response: string }> }> {
    const { agentConfigs, config, log } = this.ctx;
    const sdkBridge = this.ctx.getSdkBridge();
    const memoryDb = this.ctx.getMemoryDb();
    if (!sdkBridge || !memoryDb) throw new Error("SDK bridge or DB not ready");
    if (sdkBridge.isAttached) throw new Error("SDK session already active");

    const contributions: Array<{ agent: string; response: string }> = [];
    let transcript = "";
    const cwd = config.sessions.find((s) => s.path)?.path ?? homedir();

    this.ctx.broadcast("roundtable_status", { running: true, topic, agents: agentNames });

    for (const agentName of agentNames) {
      const agent = agentConfigs.find((a) => a.name === agentName);
      if (!agent) {
        log.warn(`Roundtable: agent "${agentName}" not found, skipping`);
        continue;
      }
      if (!this.ctx.isAgentEnabled(agentName)) {
        log.warn(`Roundtable: agent "${agentName}" disabled, skipping`);
        continue;
      }
      // Wait for SDK to be free between agents
      if (sdkBridge.isBusy) {
        log.debug(`Roundtable: waiting for SDK bridge to free up for ${agentName}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        if (sdkBridge.isBusy) {
          log.warn(`Roundtable: SDK still busy, skipping ${agentName}`);
          continue;
        }
      }

      // Build specialization context for this agent
      let specContext = "";
      try {
        const specs = memoryDb.getSpecializations(agentName);
        if (specs.length > 0) {
          specContext = specs.map((s) => `${s.domain} (${s.confidence.toFixed(2)})`).join(", ");
        }
      } catch { /* table may not exist */ }

      // Assemble roundtable prompt for this participant
      const agentContext = this.buildAgentContext(agentName);
      const otherAgents = agentNames.filter((a) => a !== agentName);
      const promptParts: string[] = [];

      if (agentContext) promptParts.push(agentContext);

      promptParts.push("## Roundtable Discussion\n");
      promptParts.push(`**Topic**: ${topic}`);
      if (specContext) {
        promptParts.push(`**Your Role**: You are contributing as a specialist in ${specContext}.`);
      }
      promptParts.push(`**Other Participants**: ${otherAgents.join(", ") || "none"}`);
      if (context) promptParts.push(`\n${context}`);

      if (transcript) {
        promptParts.push("\n### Prior Contributions\n");
        promptParts.push(transcript);
      }

      promptParts.push("\n### Your Turn");
      promptParts.push("Provide your analysis of this topic from your area of expertise.");
      promptParts.push("Be specific, cite evidence from your knowledge base where relevant.");
      promptParts.push("Keep your response focused — 2-4 key points max.\n");
      promptParts.push("You may use `learning` and `personality` blocks to capture new insights.");

      const fullPrompt = promptParts.join("\n");
      const sdkDef = toSdkAgentMap([agent])[agentName];
      // Save the topic (not the full constructed prompt) — keeps the runs view scannable.
      const runId = memoryDb.startAgentRun(agentName, `roundtable:${topic.slice(0, 50)}`, "standalone", topic);

      try {
        const result = await sdkBridge.runStandaloneAgent(
          agentName, sdkDef, cwd, fullPrompt, agent.max_budget_usd,
        );

        memoryDb.completeAgentRun(runId, "completed", {
          sessionId: result.sessionId,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          turns: result.turns,
          responseText: result.responseText,
          thinkingText: result.thinkingText || undefined,
        });

        // Extract learnings from roundtable response
        this.extractAgentActions(agentName, result.responseText);

        // Append to transcript
        const contribution = result.responseText.trim();
        contributions.push({ agent: agentName, response: contribution });
        transcript += `**${agentName}**:\n${contribution}\n\n`;

        log.info(`Roundtable: ${agentName} contributed (${result.costUsd.toFixed(4)} USD)`);
      } catch (err) {
        memoryDb.completeAgentRun(runId, "failed", { error: String(err) });
        log.warn(`Roundtable: ${agentName} failed: ${err}`);
        contributions.push({ agent: agentName, response: `[Error: ${String(err)}]` });
      }
    }

    // Deliver consolidated transcript to master-controller as inbox message
    if (contributions.length > 0) {
      const summaryContent = `## Roundtable Summary: ${topic}\n\n${transcript}`;
      memoryDb.sendAgentMessage("roundtable", "master-controller", summaryContent, {
        messageType: "roundtable_summary",
      });

      // Record as a decision
      memoryDb.recordDecision(
        "master-controller",
        `Convened roundtable on: ${topic}`,
        `${contributions.length} agents contributed: ${contributions.map((c) => c.agent).join(", ")}`,
      );

      this.ctx.broadcast("agent_message", {
        from_agent: "roundtable",
        to_agent: "master-controller",
        message_type: "roundtable_summary",
        content: summaryContent.slice(0, 500),
        created_at: Math.floor(Date.now() / 1000),
      });
    }

    this.ctx.broadcast("roundtable_status", {
      running: false, topic, agents: agentNames,
      contributions: contributions.length,
    });

    return { transcript, contributions };
  }

  // ---------------------------------------------------------------------------
  // Scheduled agent runs
  // ---------------------------------------------------------------------------

  /**
   * Execute a scheduled agent run. Called by ScheduleEngine when a schedule fires.
   * Returns success/failure and cost for schedule bookkeeping.
   *
   * Phase A2: acquires a `scheduled_run` consumer pin so the install
   * gate (§3.7) blocks while a scheduled run is in flight, matching
   * the behaviour for OODA cycles.
   */
  async executeScheduledRun(schedule: ScheduleRecord): Promise<{ success: boolean; costUsd?: number; deferred?: boolean }> {
    const { agentConfigs, config, log } = this.ctx;
    const sdkBridge = this.ctx.getSdkBridge();
    const memoryDb = this.ctx.getMemoryDb();
    // Missing subsystems and a busy bridge are transient, not failures. Three
    // consecutive polls in either state used to auto-disable the schedule
    // permanently — so attaching to a session for 90s killed a nightly job.
    if (!sdkBridge || !memoryDb) return { success: false, deferred: true };
    if (sdkBridge.isAttached || sdkBridge.isBusy) {
      log.debug(`Scheduled run "${schedule.schedule_name}" deferred — SDK busy`);
      return { success: false, deferred: true };
    }

    const pin = this.ctx.getConsumerTracker().acquire(
      "scheduled_run", String(schedule.id),
    );
    try {
      return await this._executeScheduledRunInner(schedule);
    } finally {
      pin.release();
    }
  }

  private async _executeScheduledRunInner(schedule: ScheduleRecord): Promise<{ success: boolean; costUsd?: number; deferred?: boolean }> {
    const { agentConfigs, config, log } = this.ctx;
    const sdkBridge = this.ctx.getSdkBridge();
    const memoryDb = this.ctx.getMemoryDb();
    if (!sdkBridge || !memoryDb) return { success: false, deferred: true };

    // Quota check: don't run if exceeded. Also transient — the window rolls
    // over — so it must not burn down the failure budget.
    const quota = computeQuotaStatus(memoryDb, config.orchestrator);
    if (quota.weekly_level === "exceeded") {
      log.warn(`Scheduled run "${schedule.schedule_name}" blocked — quota exceeded`);
      return { success: false, deferred: true };
    }

    const agent = agentConfigs.find((a) => a.name === schedule.agent_name && a.enabled);
    if (!agent) {
      log.warn(`Scheduled run "${schedule.schedule_name}" — agent "${schedule.agent_name}" not found/enabled`);
      return { success: false };
    }

    const sdkDef = toSdkAgentMap([agent])[schedule.agent_name];
    const cwd = config.sessions.find((s) => s.path)?.path ?? homedir();
    const budget = schedule.max_budget_usd ?? agent.max_budget_usd;
    const runId = memoryDb.startAgentRun(
      schedule.agent_name, `schedule:${schedule.schedule_name}`, "standalone", schedule.prompt,
    );

    try {
      const result = await sdkBridge.runStandaloneAgent(
        schedule.agent_name, sdkDef, cwd, schedule.prompt, budget,
      );

      memoryDb.completeAgentRun(runId, "completed", {
        sessionId: result.sessionId,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        turns: result.turns,
        responseText: result.responseText,
        thinkingText: result.thinkingText || undefined,
      });

      // Parse and execute any actions from the response
      if (result.responseText) {
        const actions = parseOodaResponse(result.responseText);
        if (actions.length > 0) {
          // Attribute to the scheduled agent, not master-controller.
          await this.executeOodaActions(actions, schedule.agent_name);
        }
        this.extractAgentActions(schedule.agent_name, result.responseText);
      }

      // Trust reward for successful scheduled run
      memoryDb.recordTrustDelta(schedule.agent_name, 10, `scheduled run "${schedule.schedule_name}" completed`);

      log.info(`Scheduled run "${schedule.schedule_name}" completed: cost=$${result.costUsd.toFixed(4)}`);
      return { success: true, costUsd: result.costUsd };
    } catch (err) {
      memoryDb.completeAgentRun(runId, "failed", { error: String(err) });
      memoryDb.recordTrustDelta(schedule.agent_name, -15, `scheduled run "${schedule.schedule_name}" failed: ${err}`);
      log.warn(`Scheduled run "${schedule.schedule_name}" failed: ${err}`);
      return { success: false };
    }
  }
}
