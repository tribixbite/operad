/**
 * cognitive.ts — OODA loop engine for the master controller
 *
 * Builds the cognitive context (observations, goals, decisions, inbox,
 * strategy, user profile) and assembles it into a prompt for the master
 * controller agent. Parses structured action blocks from the controller's
 * response and returns them for execution by the daemon.
 */

import type { MemoryDb, QuotaStatus } from "./memory-db.js";
import { computeQuotaStatus } from "./memory-db.js";
import type { TmxState, OrchestratorConfig } from "./types.js";

// -- Types --------------------------------------------------------------------

/** System observation snapshot */
export interface SystemObservation {
  sessions: Array<{ name: string; status: string; activity: string | null; rss_mb: number | null }>;
  memory: { available_mb: number; pressure: string } | null;
  quota: QuotaStatus;
  battery: { pct: number; charging: boolean } | null;
  pending_goals: number;
  unread_messages: number;
}

/** Profile snapshot for prompt injection */
export interface ProfileSnapshot {
  traits: Array<{ content: string; weight: number }>;
  notes: Array<{ content: string; weight: number }>;
  styles: Array<{ content: string; weight: number }>;
  /** Total count of chat_export entries (not included in prompt to save tokens) */
  chat_export_count: number;
}

/** Decision quality trend analysis */
export interface DecisionQualityTrend {
  avg_score: number | null;
  scored_count: number;
  total_count: number;
  trend: "improving" | "declining" | "stable" | "insufficient_data";
}

/** Agent personality trait for prompt injection */
export interface PersonalityTraitSnapshot {
  trait_name: string;
  trait_value: number;
  evidence: string | null;
}

/** Agent learning entry for prompt injection */
export interface LearningEntry {
  category: string;
  content: string;
  confidence: number;
  reinforcement_count: number;
}

/** Full OODA context assembled for the master controller */
export interface OodaContext {
  observations: SystemObservation;
  goals: Record<string, unknown>[];
  decisionHistory: Record<string, unknown>[];
  decisionTrend: DecisionQualityTrend;
  inbox: Record<string, unknown>[];
  strategy: string | null;
  userProfile: ProfileSnapshot;
  /** Master controller's personality traits */
  personality: PersonalityTraitSnapshot[];
  /** Master controller's accumulated learnings */
  agentLearnings: LearningEntry[];
  /** High-confidence insights from other agents */
  sharedInsights: Array<{ agent_name: string; content: string; confidence: number }>;
  /** Personality trait drift over recent window */
  personalityDrift: Array<{ trait_name: string; current_value: number; previous_value: number; delta: number }>;
  /** Pre-formatted tool availability section for prompt injection (from ToolExecutor) */
  availableToolsPrompt?: string;
}

/** Parsed action from master controller response */
export type OodaAction =
  | { type: "goal"; title: string; description?: string; priority?: number; parentId?: number }
  | { type: "decision"; action: string; rationale: string; alternatives?: string; expectedOutcome?: string; goalId?: number }
  | { type: "message"; to: string; messageType: string; content: string }
  | { type: "strategy"; text: string; rationale: string }
  | { type: "schedule"; delayMinutes: number; trigger: string; reason: string }
  | { type: "persistent_schedule"; name: string; cronExpr?: string; intervalMinutes?: number; prompt: string; maxBudgetUsd?: number }
  | { type: "learning"; content: string; category: string; confidence?: number }
  | { type: "personality"; trait: string; value: number; evidence: string }
  | { type: "tool_call"; name: string; params: Record<string, unknown>; id?: string }
  | { type: "tool_sequence"; steps: Array<{ name: string; params: Record<string, unknown> }>; reason: string };

// -- Context assembly ---------------------------------------------------------

/**
 * Build the full OODA context from system state and database.
 * Called before each master controller run.
 */
export function buildOodaContext(
  state: TmxState,
  db: MemoryDb,
  quotaConfig?: Pick<OrchestratorConfig, "quota_weekly_tokens" | "quota_warning_pct" | "quota_critical_pct" | "quota_window_hours">,
): OodaContext {
  // Observe: system state
  const sessions = Object.values(state.sessions).map((s) => ({
    name: s.name,
    status: s.status,
    activity: s.activity,
    rss_mb: s.rss_mb,
  }));

  const qc = quotaConfig ?? { quota_weekly_tokens: 0, quota_warning_pct: 75, quota_critical_pct: 90, quota_window_hours: 5 };
  const quotaData = computeQuotaStatus(db, qc);

  const observations: SystemObservation = {
    sessions,
    memory: state.memory ? {
      available_mb: state.memory.available_mb,
      pressure: state.memory.pressure,
    } : null,
    quota: quotaData,
    battery: state.battery ? {
      pct: state.battery.percentage,
      charging: state.battery.charging,
    } : null,
    pending_goals: (db.getActiveGoals() ?? []).length,
    unread_messages: (db.getUnreadMessages("master-controller") ?? []).length,
  };

  // Orient: goals, decisions, inbox, strategy
  const goals = db.getGoalTree();
  const decisionHistory = db.getRecentDecisions(10, "master-controller");
  const decisionTrend = db.getDecisionQualityTrend("master-controller");
  const inbox = db.getUnreadMessages("master-controller");
  const strategyRecord = db.getActiveStrategy("master-controller");
  const strategy = strategyRecord?.strategy_text as string | null ?? null;

  // User profile
  const userProfile = buildProfileSnapshot(db);

  // Personality + learnings for master controller
  const personality = (db.getPersonalitySnapshot("master-controller") ?? []).map((t: Record<string, unknown>) => ({
    trait_name: t.trait_name as string,
    trait_value: t.trait_value as number,
    evidence: t.evidence as string | null,
  }));
  const agentLearnings = (db.getAgentLearnings("master-controller", 10) ?? []).map((l: Record<string, unknown>) => ({
    category: l.category as string,
    content: l.content as string,
    confidence: l.confidence as number,
    reinforcement_count: l.reinforcement_count as number,
  }));
  const sharedInsights = (db.getSharedInsights("master-controller", 0.7, 5) ?? []).map((s: Record<string, unknown>) => ({
    agent_name: s.agent_name as string,
    content: s.content as string,
    confidence: s.confidence as number,
  }));

  // Personality drift — detect significant trait changes over the past week
  const personalityDrift = db.getPersonalityDrift("master-controller").map((d) => ({
    trait_name: d.trait_name,
    current_value: d.current_value,
    previous_value: d.previous_value,
    delta: d.delta,
  }));

  return { observations, goals, decisionHistory, decisionTrend, inbox, strategy, userProfile, personality, agentLearnings, sharedInsights, personalityDrift };
}

/** Format token count with K/M suffix */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/** Build profile snapshot from user_profile table */
function buildProfileSnapshot(db: MemoryDb): ProfileSnapshot {
  const traits = db.getProfile("trait", 20).map((r) => ({
    content: r.content as string,
    weight: r.weight as number,
  }));
  const notes = db.getProfile("note", 20).map((r) => ({
    content: r.content as string,
    weight: r.weight as number,
  }));
  const styles = db.getProfile("style", 10).map((r) => ({
    content: r.content as string,
    weight: r.weight as number,
  }));
  const chatExports = db.getProfile("chat_export");
  return { traits, notes, styles, chat_export_count: chatExports.length };
}

// -- Prompt building ----------------------------------------------------------

/**
 * Assemble the OODA prompt for the master controller.
 * Sections are ordered by priority: state → goals → decisions → inbox → profile → strategy → actions.
 */
export function buildOodaPrompt(ctx: OodaContext): string {
  const sections: string[] = [];

  // 0. Current time — agents must know when they are
  const now = new Date();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekNumber = getISOWeekNumber(now);
  sections.push("## Current Time\n");
  sections.push(`**UTC**: ${now.toISOString()}`);
  sections.push(`**Local**: ${now.toLocaleString()}`);
  sections.push(`**Day**: ${dayNames[now.getDay()]} | **Week**: ${weekNumber}`);

  // 1. System state
  sections.push("\n## System State\n");
  sections.push(`**Sessions** (${ctx.observations.sessions.length} total):`);
  for (const s of ctx.observations.sessions) {
    const mem = s.rss_mb != null ? ` | ${s.rss_mb}MB` : "";
    const act = s.activity ? ` | ${s.activity}` : "";
    sections.push(`- ${s.name}: ${s.status}${act}${mem}`);
  }

  if (ctx.observations.memory) {
    sections.push(`\n**Memory**: ${ctx.observations.memory.available_mb}MB available (${ctx.observations.memory.pressure})`);
  }
  if (ctx.observations.battery) {
    sections.push(`**Battery**: ${ctx.observations.battery.pct}% ${ctx.observations.battery.charging ? "(charging)" : "(discharging)"}`);
  }
  // Token quota status — plan auto-detected from ~/.claude/.credentials.json
  const q = ctx.observations.quota;
  const trendArrow = q.velocity_trend === "rising" ? " ↑" : q.velocity_trend === "falling" ? " ↓" : "";
  if (q.plan) {
    sections.push(`**Plan**: Claude ${q.plan} (auto-detected)`);
  }
  if (q.weekly_tokens_limit > 0) {
    const levelIcon = q.weekly_level === "ok" ? "OK" : q.weekly_level === "warning" ? "WARNING" : q.weekly_level === "critical" ? "CRITICAL" : "EXCEEDED";
    sections.push(`**Quota**: ${fmtTokens(q.weekly_tokens_used)} / ${fmtTokens(q.weekly_tokens_limit)} tokens this week (${q.weekly_pct}%) [${levelIcon}]`);
  } else {
    sections.push(`**Tokens this week**: ${fmtTokens(q.weekly_tokens_used)} (avg ${fmtTokens(q.daily_avg_tokens)}/day)`);
  }
  sections.push(`**Window**: ${fmtTokens(q.window_tokens_used)} in last ${q.window_hours}h | velocity: ${fmtTokens(q.tokens_per_hour)}/hr${trendArrow}`);
  if (q.top_sessions.length > 0) {
    const topStr = q.top_sessions.slice(0, 3).map(s => `${s.name} (${fmtTokens(s.tokens)}, ${s.pct}%)`).join(", ");
    sections.push(`**Top consumers**: ${topStr}`);
  }
  // Quota guardrail warnings injected into prompt
  if (q.weekly_level === "critical") {
    sections.push(`\n> **QUOTA WARNING**: Weekly token usage is at ${q.weekly_pct}% — conserve tokens. Minimize tool calls, use shorter responses, defer non-essential agent runs.`);
  } else if (q.weekly_level === "exceeded") {
    sections.push(`\n> **QUOTA EXCEEDED**: Weekly limit reached (${q.weekly_pct}%). Only essential observe tools allowed. Do not spawn agents or schedule OODA runs.`);
  }

  // 2. Active goals
  sections.push("\n## Active Goals\n");
  if (ctx.goals.length === 0) {
    sections.push("_No active goals. Consider creating foundational goals._");
  } else {
    for (const g of ctx.goals) {
      const status = g.status as string;
      const priority = g.priority as number;
      const score = g.success_score != null ? ` (score: ${g.success_score})` : "";
      const children = g.children_count as number;
      const childStr = children > 0 ? ` [${children} sub-goals]` : "";
      sections.push(`- [P${priority}] ${g.title} — ${status}${score}${childStr} (id:${g.id})`);
    }
  }

  // 3. Decision journal (last 10)
  sections.push("\n## Decision Journal (recent)\n");
  if (ctx.decisionHistory.length === 0) {
    sections.push("_No decisions recorded yet._");
  } else {
    for (const d of ctx.decisionHistory) {
      const score = d.score != null ? ` → score: ${d.score}` : " → pending evaluation";
      const outcome = d.actual_outcome ? ` | outcome: ${d.actual_outcome}` : "";
      sections.push(`- **${d.action}**: ${d.rationale}${outcome}${score}`);
    }
  }

  // 3b. Decision quality trend
  if (ctx.decisionTrend.trend !== "insufficient_data") {
    const trendArrow = ctx.decisionTrend.trend === "improving" ? " ↑" :
      ctx.decisionTrend.trend === "declining" ? " ↓" : "";
    sections.push(`\n## Decision Quality\n`);
    sections.push(`**Average**: ${ctx.decisionTrend.avg_score?.toFixed(2) ?? "n/a"} (${ctx.decisionTrend.scored_count} scored / ${ctx.decisionTrend.total_count} total) | **Trend**: ${ctx.decisionTrend.trend}${trendArrow}`);
  }

  // 3c. Your personality (with drift indicators when available)
  if (ctx.personality.length > 0) {
    sections.push(`\n## Your Personality\n`);
    // Index drift data by trait name for O(1) lookup
    const driftMap = new Map(ctx.personalityDrift.map((d) => [d.trait_name, d]));
    for (const t of ctx.personality) {
      const drift = driftMap.get(t.trait_name);
      let driftStr = " (stable)";
      if (drift) {
        const arrow = drift.delta > 0 ? "\u2191" : "\u2193";
        const sign = drift.delta > 0 ? "+" : "";
        driftStr = ` (${arrow} from ${drift.previous_value.toFixed(2)}, ${sign}${drift.delta.toFixed(2)})`;
      }
      const evidence = t.evidence ? ` | ${t.evidence}` : "";
      sections.push(`- **${t.trait_name}**: ${t.trait_value.toFixed(2)}${driftStr}${evidence}`);
    }
  }

  // 3d. Your knowledge base
  if (ctx.agentLearnings.length > 0) {
    const catCounts = new Map<string, number>();
    for (const l of ctx.agentLearnings) {
      catCounts.set(l.category, (catCounts.get(l.category) ?? 0) + 1);
    }
    const catSummary = Array.from(catCounts.entries()).map(([k, v]) => `${v} ${k}s`).join(", ");
    sections.push(`\n## Your Knowledge Base (${ctx.agentLearnings.length} learnings: ${catSummary})\n`);
    for (const l of ctx.agentLearnings) {
      const reinforced = l.reinforcement_count > 1 ? `, reinforced ${l.reinforcement_count}x` : "";
      sections.push(`- [${l.category}] ${l.content} (confidence: ${l.confidence.toFixed(2)}${reinforced})`);
    }
  }

  // 3e. Cross-agent insights
  if (ctx.sharedInsights.length > 0) {
    sections.push(`\n## Insights from Other Agents\n`);
    for (const s of ctx.sharedInsights) {
      sections.push(`- [${s.agent_name}] ${s.content} (${s.confidence.toFixed(2)})`);
    }
  }

  // 4. Inbox
  if (ctx.inbox.length > 0) {
    sections.push("\n## Inbox (unread)\n");
    for (const m of ctx.inbox) {
      sections.push(`- From **${m.from_agent}** (${m.message_type}): ${m.content}`);
    }
  }

  // 5. User profile
  if (ctx.userProfile.traits.length > 0 || ctx.userProfile.notes.length > 0) {
    sections.push("\n## User Profile\n");

    if (ctx.userProfile.traits.length > 0) {
      sections.push("**Traits:**");
      for (const t of ctx.userProfile.traits) {
        sections.push(`- ${t.content} (weight: ${t.weight})`);
      }
    }

    if (ctx.userProfile.notes.length > 0) {
      sections.push("\n**Notes/Ideas:**");
      for (const n of ctx.userProfile.notes) {
        sections.push(`- ${n.content}`);
      }
    }

    if (ctx.userProfile.styles.length > 0) {
      sections.push("\n**Communication Style:**");
      for (const s of ctx.userProfile.styles) {
        sections.push(`- ${s.content}`);
      }
    }

    if (ctx.userProfile.chat_export_count > 0) {
      sections.push(`\n_${ctx.userProfile.chat_export_count} chat export segments available for deeper personality analysis._`);
    }
  }

  // 6. Current strategy
  sections.push("\n## Current Strategy\n");
  if (ctx.strategy) {
    sections.push(ctx.strategy);
  } else {
    sections.push("_No strategy defined yet. Use a \\`\\`\\`strategy block to establish your initial strategy._");
  }

  // 7. Available tools (injected by ToolExecutor if provided)
  if (ctx.availableToolsPrompt) {
    sections.push("\n## Available Tools\n");
    sections.push("You can execute tools using \\`\\`\\`tool blocks:");
    sections.push("```tool");
    sections.push("name: <tool-name>");
    sections.push("<param>: <value>");
    sections.push("```");
    sections.push("");
    sections.push(ctx.availableToolsPrompt);
  }

  // 8. Available actions
  sections.push("\n## Available Actions\n");
  sections.push("Use fenced code blocks to emit actions:");
  sections.push("- `goal` — Create or update goals");
  sections.push("- `decision` — Record a decision with rationale");
  sections.push("- `message` — Send message to another agent");
  sections.push("- `strategy` — Evolve your strategy");
  sections.push("- `schedule` — Schedule your next run");
  sections.push("- `learning` — Record something you've learned (persists across runs)");
  sections.push("- `personality` — Update a personality trait based on evidence");
  sections.push("- `persistent_schedule` — Create a recurring schedule (cron or interval, survives restarts)");
  if (ctx.availableToolsPrompt) {
    sections.push("- `tool` — Execute a registered tool (see Available Tools above)");
  }

  return sections.join("\n");
}

// -- Response parsing ---------------------------------------------------------

/**
 * Parse structured action blocks from the master controller's response.
 * Extracts fenced code blocks with known action types.
 */
export function parseOodaResponse(text: string): OodaAction[] {
  const actions: OodaAction[] = [];

  // Match fenced code blocks: ```type\n...\n```
  const blockPattern = /```(goal|decision|message|strategy|schedule|persistent_schedule|learning|personality|tool|tool_sequence)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(text)) !== null) {
    const [, blockType, body] = match;
    const fields = parseBlockFields(body);

    switch (blockType) {
      case "goal":
        if (fields.title) {
          actions.push({
            type: "goal",
            title: fields.title,
            description: fields.description,
            priority: fields.priority ? parseInt(fields.priority, 10) : undefined,
            parentId: fields.parent_id ? parseInt(fields.parent_id, 10) : undefined,
          });
        }
        break;

      case "decision":
        if (fields.action && fields.rationale) {
          actions.push({
            type: "decision",
            action: fields.action,
            rationale: fields.rationale,
            alternatives: fields.alternatives,
            expectedOutcome: fields.expected_outcome,
            goalId: fields.goal_id ? parseInt(fields.goal_id, 10) : undefined,
          });
        }
        break;

      case "message":
        if (fields.to && fields.content) {
          actions.push({
            type: "message",
            to: fields.to,
            messageType: fields.type ?? "info",
            content: fields.content,
          });
        }
        break;

      case "strategy":
        if (fields.text && fields.rationale) {
          actions.push({
            type: "strategy",
            text: fields.text,
            rationale: fields.rationale,
          });
        }
        break;

      case "schedule":
        if (fields.delay_minutes) {
          actions.push({
            type: "schedule",
            delayMinutes: parseInt(fields.delay_minutes, 10),
            trigger: fields.trigger ?? "timer",
            reason: fields.reason ?? "scheduled",
          });
        }
        break;

      case "persistent_schedule":
        if (fields.name && fields.prompt) {
          actions.push({
            type: "persistent_schedule",
            name: fields.name,
            cronExpr: fields.cron ?? fields.cron_expr,
            intervalMinutes: fields.interval_minutes ? parseInt(fields.interval_minutes, 10) : undefined,
            prompt: fields.prompt,
            maxBudgetUsd: fields.max_budget_usd ? parseFloat(fields.max_budget_usd) : undefined,
          });
        }
        break;

      case "learning":
        if (fields.content && fields.category) {
          actions.push({
            type: "learning",
            content: fields.content,
            category: fields.category,
            confidence: fields.confidence ? parseFloat(fields.confidence) : undefined,
          });
        }
        break;

      case "personality":
        if (fields.trait && fields.value) {
          actions.push({
            type: "personality",
            trait: fields.trait,
            value: parseFloat(fields.value),
            evidence: fields.evidence ?? "",
          });
        }
        break;

      case "tool":
        if (fields.name) {
          // Parse all fields except 'name' and 'id' as tool params
          const params: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(fields)) {
            if (k === "name" || k === "id") continue;
            // Try to parse as number or boolean
            if (v === "true") params[k] = true;
            else if (v === "false") params[k] = false;
            else if (/^-?\d+(\.\d+)?$/.test(v)) params[k] = Number(v);
            else params[k] = v;
          }
          actions.push({
            type: "tool_call",
            name: fields.name,
            params,
            id: fields.id,
          });
        }
        break;

      case "tool_sequence": {
        // Parse multiple tool steps separated by "---" or "step:" markers
        const steps: Array<{ name: string; params: Record<string, unknown> }> = [];
        const stepBlocks = body.split(/^---$/m);
        for (const stepBlock of stepBlocks) {
          const stepFields = parseBlockFields(stepBlock);
          if (stepFields.name) {
            const stepParams: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(stepFields)) {
              if (k === "name") continue;
              if (v === "true") stepParams[k] = true;
              else if (v === "false") stepParams[k] = false;
              else if (/^-?\d+(\.\d+)?$/.test(v)) stepParams[k] = Number(v);
              else stepParams[k] = v;
            }
            steps.push({ name: stepFields.name, params: stepParams });
          }
        }
        if (steps.length > 0) {
          actions.push({
            type: "tool_sequence",
            steps,
            reason: fields.reason ?? "multi-step tool execution",
          });
        }
        break;
      }
    }
  }

  return actions;
}

/**
 * Parse key: value fields from a code block body.
 * Supports multi-line values (indented continuation lines).
 */
function parseBlockFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let currentKey = "";
  let currentValue = "";

  for (const line of body.split("\n")) {
    const kvMatch = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (kvMatch) {
      // Save previous field
      if (currentKey) {
        fields[currentKey] = currentValue.trim();
      }
      currentKey = kvMatch[1];
      currentValue = kvMatch[2];
    } else if (currentKey && line.startsWith("  ")) {
      // Continuation line (indented)
      currentValue += "\n" + line.trim();
    }
  }

  // Save last field
  if (currentKey) {
    fields[currentKey] = currentValue.trim();
  }

  return fields;
}

/** ISO 8601 week number */
function getISOWeekNumber(date: Date): number {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}
