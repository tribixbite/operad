/**
 * cognitive.ts — OODA loop engine for the master controller
 *
 * Builds the cognitive context (observations, goals, decisions, inbox,
 * strategy, user profile) and assembles it into a prompt for the master
 * controller agent. Parses structured action blocks from the controller's
 * response and returns them for execution by the daemon.
 */

import type { MemoryDb } from "./memory-db.js";
import type { TmxState } from "./types.js";

// -- Types --------------------------------------------------------------------

/** System observation snapshot */
export interface SystemObservation {
  sessions: Array<{ name: string; status: string; activity: string | null; rss_mb: number | null }>;
  memory: { available_mb: number; pressure: string } | null;
  costs: { today_usd: number; week_usd: number; month_usd: number };
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

/** Full OODA context assembled for the master controller */
export interface OodaContext {
  observations: SystemObservation;
  goals: Record<string, unknown>[];
  decisionHistory: Record<string, unknown>[];
  decisionTrend: DecisionQualityTrend;
  inbox: Record<string, unknown>[];
  strategy: string | null;
  userProfile: ProfileSnapshot;
}

/** Parsed action from master controller response */
export type OodaAction =
  | { type: "goal"; title: string; description?: string; priority?: number; parentId?: number }
  | { type: "decision"; action: string; rationale: string; alternatives?: string; expectedOutcome?: string; goalId?: number }
  | { type: "message"; to: string; messageType: string; content: string }
  | { type: "strategy"; text: string; rationale: string }
  | { type: "schedule"; delayMinutes: number; trigger: string; reason: string }
  | { type: "learning"; content: string; category: string; confidence?: number }
  | { type: "personality"; trait: string; value: number; evidence: string };

// -- Context assembly ---------------------------------------------------------

/**
 * Build the full OODA context from system state and database.
 * Called before each master controller run.
 */
export function buildOodaContext(
  state: TmxState,
  db: MemoryDb,
): OodaContext {
  // Observe: system state
  const sessions = Object.values(state.sessions).map((s) => ({
    name: s.name,
    status: s.status,
    activity: s.activity,
    rss_mb: s.rss_mb,
  }));

  const costData = buildCostObservation(db);

  const observations: SystemObservation = {
    sessions,
    memory: state.memory ? {
      available_mb: state.memory.available_mb,
      pressure: state.memory.pressure,
    } : null,
    costs: costData,
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

  return { observations, goals, decisionHistory, decisionTrend, inbox, strategy, userProfile };
}

/** Build cost observation from recent data */
function buildCostObservation(db: MemoryDb): { today_usd: number; week_usd: number; month_usd: number } {
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const weekAgo = now - 7 * 86400;
  const monthAgo = now - 30 * 86400;

  const todayCosts = db.getAggregateCosts(dayAgo);
  const weekCosts = db.getAggregateCosts(weekAgo);
  const monthCosts = db.getAggregateCosts(monthAgo);

  return {
    today_usd: todayCosts.total_cost_usd,
    week_usd: weekCosts.total_cost_usd,
    month_usd: monthCosts.total_cost_usd,
  };
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
  sections.push(`**Costs**: today=$${ctx.observations.costs.today_usd.toFixed(2)} | week=$${ctx.observations.costs.week_usd.toFixed(2)} | month=$${ctx.observations.costs.month_usd.toFixed(2)}`);

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

  // 7. Available actions
  sections.push("\n## Available Actions\n");
  sections.push("Use fenced code blocks to emit actions:");
  sections.push("- `goal` — Create or update goals");
  sections.push("- `decision` — Record a decision with rationale");
  sections.push("- `message` — Send message to another agent");
  sections.push("- `strategy` — Evolve your strategy");
  sections.push("- `schedule` — Schedule your next run");
  sections.push("- `learning` — Record something you've learned (persists across runs)");
  sections.push("- `personality` — Update a personality trait based on evidence");

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
  const blockPattern = /```(goal|decision|message|strategy|schedule|learning|personality)\s*\n([\s\S]*?)```/g;
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
        if (fields.trait && fields.value && fields.evidence) {
          actions.push({
            type: "personality",
            trait: fields.trait,
            value: parseFloat(fields.value),
            evidence: fields.evidence,
          });
        }
        break;
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
