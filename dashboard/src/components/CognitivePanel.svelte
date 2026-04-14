<script lang="ts">
  import {
    fetchCognitiveState, fetchGoals, createGoal, updateGoal,
    fetchDecisions, triggerOoda,
    fetchAgentMessages, fetchAgentConversationPairs, sendAgentMessage,
    fetchAgentLearnings, fetchAgentPersonality, fetchAgentDrift,
    fetchDecisionMetrics, fetchAgents,
  } from "../lib/api";
  import { connect, on } from "../lib/ws.svelte";
  import type {
    GoalRecord, DecisionRecord,
    AgentMessage, ConversationPair, PersonalityTrait, AgentLearning, AgentInfo,
  } from "../lib/types";

  // -- State ------------------------------------------------------------------

  let goals: GoalRecord[] = $state([]);
  let decisions: DecisionRecord[] = $state([]);
  let strategy: string = $state("");
  let loading = $state(true);
  let error: string | null = $state(null);
  let actionMsg: string | null = $state(null);

  /** Active tab */
  let tab: "goals" | "decisions" | "strategy" | "messages" | "growth" = $state("goals");

  /** Expanded goal for detail view */
  let expandedGoal: number | null = $state(null);
  /** Expanded decision for rationale view */
  let expandedDecision: number | null = $state(null);

  /** New goal form */
  let showNewGoal = $state(false);
  let newTitle = $state("");
  let newDesc = $state("");
  let newPriority = $state(5);
  let newParentId: number | null = $state(null);

  /** OODA cycle running */
  let oodaRunning = $state(false);

  // -- Messages tab state -----------------------------------------------------

  /** Agent conversation pairs for sidebar */
  let msgPairs: ConversationPair[] = $state([]);
  /** All recent inter-agent messages */
  let allMessages: AgentMessage[] = $state([]);
  /** Selected conversation pair filter */
  let selectedPair: string | null = $state(null);
  /** Filtered messages based on selected pair */
  let filteredMessages = $derived(
    selectedPair
      ? allMessages.filter(m => {
          const [a, b] = selectedPair!.split("|");
          return (m.from_agent === a && m.to_agent === b) ||
                 (m.from_agent === b && m.to_agent === a);
        })
      : allMessages,
  );
  /** User-inject message form */
  let injectFrom = $state("");
  let injectTo = $state("");
  let injectContent = $state("");
  /** Available agent names for inject form dropdowns */
  let agentNames: string[] = $state([]);

  // -- Growth tab state -------------------------------------------------------

  /** Per-agent personality snapshots */
  let personalities: Map<string, PersonalityTrait[]> = $state(new Map());
  /** Per-agent learnings */
  let learnings: Map<string, AgentLearning[]> = $state(new Map());
  /** Per-agent decision metrics */
  let decisionMetrics: Array<{
    agent_name: string;
    avg_score: number | null;
    scored_count: number;
    total_count: number;
    trend: string;
  }> = $state([]);
  /** Selected agent for growth detail */
  let growthAgent: string | null = $state(null);
  /** Derived personality traits for selected growth agent */
  let growthTraits = $derived(growthAgent ? (personalities.get(growthAgent) ?? []) : []);
  /** Derived learnings for selected growth agent */
  let growthLearnings = $derived(growthAgent ? (learnings.get(growthAgent) ?? []) : []);
  /** Derived decision metric for selected growth agent */
  let growthMetric = $derived(growthAgent ? decisionMetrics.find(m => m.agent_name === growthAgent) ?? null : null);
  /** Per-agent personality drift */
  let drifts: Map<string, Array<{ trait_name: string; current: number; previous: number; delta: number; direction: string }>> = $state(new Map());
  /** Derived drift for selected growth agent */
  let growthDrift = $derived(growthAgent ? (drifts.get(growthAgent) ?? []) : []);

  // -- Load data --------------------------------------------------------------

  async function loadAll() {
    loading = true;
    error = null;
    try {
      const [g, d, state] = await Promise.all([
        fetchGoals(),
        fetchDecisions({ limit: 50 }),
        fetchCognitiveState(),
      ]);
      goals = g;
      decisions = d;
      strategy = (state as Record<string, unknown>).strategy as string || "";
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  // Load initial data + subscribe to WS events for live updates
  $effect(() => {
    loadAll();
    connect();

    // Auto-refresh when OODA cycle completes — goals/decisions/strategy may have changed
    const offOoda = on("ooda_status", (msg) => {
      oodaRunning = !!msg.running;
      if (!msg.running) {
        loadAll();
      }
    });

    // Live inter-agent message feed
    const offMsg = on("agent_message", (msg) => {
      const entry: AgentMessage = {
        id: msg.id as number,
        from_agent: msg.from_agent as string,
        to_agent: msg.to_agent as string,
        message_type: msg.message_type as string ?? "info",
        content: msg.content as string,
        metadata: null,
        read_at: null,
        created_at: msg.created_at as number ?? Math.floor(Date.now() / 1000),
      };
      allMessages = [entry, ...allMessages].slice(0, 100);
    });

    return () => { offOoda(); offMsg(); };
  });

  /** Load messages tab data */
  async function loadMessages() {
    try {
      const [msgs, pairs, agents] = await Promise.all([
        fetchAgentMessages(100),
        fetchAgentConversationPairs(),
        fetchAgents(),
      ]);
      allMessages = msgs;
      msgPairs = pairs;
      agentNames = agents.map((a: AgentInfo) => a.name);
    } catch (e) {
      error = String(e);
    }
  }

  /** Load growth tab data for all agents */
  async function loadGrowth() {
    try {
      const [agents, metrics] = await Promise.all([
        fetchAgents(),
        fetchDecisionMetrics(),
      ]);
      agentNames = agents.map((a: AgentInfo) => a.name);
      decisionMetrics = metrics;

      // Load personality + learnings + drift for each agent in parallel
      const pMap = new Map<string, PersonalityTrait[]>();
      const lMap = new Map<string, AgentLearning[]>();
      const dMap = new Map<string, Array<{ trait_name: string; current: number; previous: number; delta: number; direction: string }>>();
      await Promise.all(agents.map(async (a: AgentInfo) => {
        const [p, l, d] = await Promise.all([
          fetchAgentPersonality(a.name),
          fetchAgentLearnings(a.name, 10),
          fetchAgentDrift(a.name),
        ]);
        pMap.set(a.name, p);
        lMap.set(a.name, l);
        dMap.set(a.name, d);
      }));
      personalities = pMap;
      learnings = lMap;
      drifts = dMap;
    } catch (e) {
      error = String(e);
    }
  }

  // Load tab-specific data when tab changes
  $effect(() => {
    if (tab === "messages") loadMessages();
    if (tab === "growth") loadGrowth();
  });

  // -- Goal actions -----------------------------------------------------------

  async function handleCreateGoal() {
    if (!newTitle.trim()) return;
    try {
      await createGoal(newTitle.trim(), {
        description: newDesc.trim() || undefined,
        priority: newPriority,
        parentId: newParentId ?? undefined,
      });
      newTitle = "";
      newDesc = "";
      newPriority = 5;
      newParentId = null;
      showNewGoal = false;
      actionMsg = "Goal created";
      await loadAll();
    } catch (e) {
      error = String(e);
    }
    setTimeout(() => actionMsg = null, 3000);
  }

  async function handleGoalStatus(id: number, status: string) {
    try {
      await updateGoal(id, { status });
      actionMsg = `Goal ${status}`;
      await loadAll();
    } catch (e) {
      error = String(e);
    }
    setTimeout(() => actionMsg = null, 3000);
  }

  async function handleTriggerOoda() {
    oodaRunning = true;
    actionMsg = null;
    try {
      await triggerOoda();
      actionMsg = "OODA cycle triggered";
      await loadAll();
    } catch (e) {
      error = String(e);
    } finally {
      oodaRunning = false;
    }
    setTimeout(() => actionMsg = null, 5000);
  }

  /** Send a user-injected message into the agent bus */
  async function handleInjectMessage() {
    if (!injectFrom || !injectTo || !injectContent.trim()) return;
    try {
      await sendAgentMessage(injectFrom, injectTo, injectContent.trim());
      actionMsg = `Message sent: ${injectFrom} → ${injectTo}`;
      injectContent = "";
      await loadMessages();
    } catch (e) {
      error = String(e);
    }
    setTimeout(() => actionMsg = null, 3000);
  }

  // -- Helpers ----------------------------------------------------------------

  function formatTs(epoch: number): string {
    return new Date(epoch * 1000).toLocaleString();
  }

  function statusColor(s: string): string {
    switch (s) {
      case "active": return "var(--accent-blue)";
      case "completed": return "var(--accent-green)";
      case "failed": return "var(--accent-red)";
      case "paused": return "var(--accent-yellow)";
      case "cancelled": return "var(--text-muted)";
      default: return "var(--text-secondary)";
    }
  }

  function priorityLabel(p: number): string {
    if (p <= 2) return "critical";
    if (p <= 4) return "high";
    if (p <= 6) return "medium";
    if (p <= 8) return "low";
    return "nice-to-have";
  }

  /** Look up decision metric for a given agent */
  function getMetric(name: string) {
    return decisionMetrics.find(m => m.agent_name === name) ?? null;
  }

  function scoreBar(score: number | null): string {
    if (score == null) return "—";
    const pct = Math.round(score * 100);
    return `${pct}%`;
  }

  /** Build a flat tree with indent levels for rendering */
  let goalTree = $derived(buildGoalTree(goals));

  function buildGoalTree(flat: GoalRecord[]): Array<GoalRecord & { depth: number }> {
    const byParent = new Map<number | null, GoalRecord[]>();
    for (const g of flat) {
      const key = g.parent_id;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(g);
    }
    const result: Array<GoalRecord & { depth: number }> = [];
    function walk(parentId: number | null, depth: number) {
      const children = byParent.get(parentId) || [];
      for (const c of children.sort((a, b) => a.priority - b.priority)) {
        result.push({ ...c, depth });
        walk(c.id, depth + 1);
      }
    }
    walk(null, 0);
    return result;
  }
</script>

<div class="cognitive-panel">
  <!-- Header with OODA trigger -->
  <div class="panel-header">
    <div class="tabs">
      <button class="tab" class:active={tab === "goals"} onclick={() => tab = "goals"}>
        Goals ({goals.length})
      </button>
      <button class="tab" class:active={tab === "decisions"} onclick={() => tab = "decisions"}>
        Decisions ({decisions.length})
      </button>
      <button class="tab" class:active={tab === "strategy"} onclick={() => tab = "strategy"}>
        Strategy
      </button>
      <button class="tab" class:active={tab === "messages"} onclick={() => tab = "messages"}>
        Messages
      </button>
      <button class="tab" class:active={tab === "growth"} onclick={() => tab = "growth"}>
        Growth
      </button>
    </div>
    <button
      class="ooda-btn"
      onclick={handleTriggerOoda}
      disabled={oodaRunning}
    >
      {oodaRunning ? "Running..." : "Trigger OODA"}
    </button>
  </div>

  {#if actionMsg}
    <div class="action-msg">{actionMsg}</div>
  {/if}
  {#if error}
    <div class="error-msg">{error}</div>
  {/if}

  {#if loading}
    <div class="loading">Loading cognitive state...</div>
  {:else if tab === "goals"}
    <!-- Goal tree -->
    <div class="goal-section">
      <button class="add-btn" onclick={() => showNewGoal = !showNewGoal}>
        {showNewGoal ? "Cancel" : "+ New Goal"}
      </button>

      {#if showNewGoal}
        <div class="new-goal-form">
          <input
            type="text"
            placeholder="Goal title"
            bind:value={newTitle}
            class="input"
          />
          <textarea
            placeholder="Description (optional)"
            bind:value={newDesc}
            rows="2"
            class="input"
          ></textarea>
          <div class="form-row">
            <label class="form-label">
              Priority
              <select bind:value={newPriority} class="select">
                <option value={1}>1 — Critical</option>
                <option value={3}>3 — High</option>
                <option value={5}>5 — Medium</option>
                <option value={7}>7 — Low</option>
                <option value={9}>9 — Nice-to-have</option>
              </select>
            </label>
            <label class="form-label">
              Parent
              <select bind:value={newParentId} class="select">
                <option value={null}>None (root)</option>
                {#each goals.filter(g => g.status === "active") as g}
                  <option value={g.id}>{g.title}</option>
                {/each}
              </select>
            </label>
          </div>
          <button class="submit-btn" onclick={handleCreateGoal} disabled={!newTitle.trim()}>
            Create Goal
          </button>
        </div>
      {/if}

      {#if goalTree.length === 0}
        <div class="empty">No goals yet. Create one or trigger an OODA cycle.</div>
      {:else}
        <div class="goal-list">
          {#each goalTree as goal}
            <div
              class="goal-row"
              style="padding-left: {goal.depth * 1.25 + 0.5}rem"
              class:expanded={expandedGoal === goal.id}
            >
              <button class="goal-header" onclick={() => expandedGoal = expandedGoal === goal.id ? null : goal.id}>
                <span class="goal-status" style="color: {statusColor(goal.status)}">
                  {goal.status === "active" ? "●" : goal.status === "completed" ? "✓" : goal.status === "failed" ? "✗" : "◯"}
                </span>
                <span class="goal-title">{goal.title}</span>
                <span class="goal-meta">
                  <span class="priority-tag priority-{priorityLabel(goal.priority)}">{priorityLabel(goal.priority)}</span>
                  {#if goal.agent_name}
                    <span class="agent-tag">{goal.agent_name}</span>
                  {/if}
                  {#if goal.children_count > 0}
                    <span class="children-count">{goal.children_count} sub</span>
                  {/if}
                </span>
              </button>

              {#if expandedGoal === goal.id}
                <div class="goal-detail">
                  {#if goal.description}
                    <p class="detail-text">{goal.description}</p>
                  {/if}
                  {#if goal.expected_outcome}
                    <div class="detail-row">
                      <span class="detail-label">Expected:</span>
                      <span>{goal.expected_outcome}</span>
                    </div>
                  {/if}
                  {#if goal.actual_outcome}
                    <div class="detail-row">
                      <span class="detail-label">Actual:</span>
                      <span>{goal.actual_outcome}</span>
                    </div>
                  {/if}
                  {#if goal.success_score != null}
                    <div class="detail-row">
                      <span class="detail-label">Score:</span>
                      <span class="score">{scoreBar(goal.success_score)}</span>
                    </div>
                  {/if}
                  <div class="detail-row">
                    <span class="detail-label">Created:</span>
                    <span>{formatTs(goal.created_at)}</span>
                  </div>
                  <div class="goal-actions">
                    {#if goal.status === "active"}
                      <button class="action-sm complete" onclick={() => handleGoalStatus(goal.id, "completed")}>Complete</button>
                      <button class="action-sm pause" onclick={() => handleGoalStatus(goal.id, "paused")}>Pause</button>
                      <button class="action-sm fail" onclick={() => handleGoalStatus(goal.id, "failed")}>Fail</button>
                    {:else if goal.status === "paused"}
                      <button class="action-sm resume" onclick={() => handleGoalStatus(goal.id, "active")}>Resume</button>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

  {:else if tab === "decisions"}
    <!-- Decision journal -->
    {#if decisions.length === 0}
      <div class="empty">No decisions recorded yet.</div>
    {:else}
      <div class="decision-list">
        {#each decisions as d}
          <div class="decision-row" class:expanded={expandedDecision === d.id}>
            <button class="decision-header" onclick={() => expandedDecision = expandedDecision === d.id ? null : d.id}>
              <div class="decision-main">
                <span class="decision-action">{d.action}</span>
                <span class="decision-meta">
                  <span class="agent-tag">{d.agent_name}</span>
                  {#if d.score != null}
                    <span class="score-badge" class:good={d.score >= 0.7} class:mid={d.score >= 0.4 && d.score < 0.7} class:bad={d.score < 0.4}>
                      {scoreBar(d.score)}
                    </span>
                  {/if}
                  <span class="ts">{formatTs(d.created_at)}</span>
                </span>
              </div>
            </button>

            {#if expandedDecision === d.id}
              <div class="decision-detail">
                <div class="detail-row">
                  <span class="detail-label">Rationale:</span>
                  <span>{d.rationale}</span>
                </div>
                {#if d.alternatives}
                  <div class="detail-row">
                    <span class="detail-label">Alternatives:</span>
                    <span>{d.alternatives}</span>
                  </div>
                {/if}
                {#if d.expected_outcome}
                  <div class="detail-row">
                    <span class="detail-label">Expected:</span>
                    <span>{d.expected_outcome}</span>
                  </div>
                {/if}
                {#if d.actual_outcome}
                  <div class="detail-row">
                    <span class="detail-label">Actual:</span>
                    <span>{d.actual_outcome}</span>
                  </div>
                {/if}
                {#if d.goal_id}
                  <div class="detail-row">
                    <span class="detail-label">Goal:</span>
                    <span>#{d.goal_id}</span>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

  {:else if tab === "strategy"}
    <!-- Strategy viewer -->
    <div class="strategy-section">
      {#if strategy}
        <pre class="strategy-text">{strategy}</pre>
      {:else}
        <div class="empty">No active strategy. The master controller will evolve one during OODA cycles.</div>
      {/if}
    </div>

  {:else if tab === "messages"}
    <!-- Inter-agent message viewer -->
    <div class="messages-section">
      <div class="msg-layout">
        <!-- Pair sidebar -->
        <div class="pair-sidebar">
          <button
            class="pair-item"
            class:active={selectedPair === null}
            onclick={() => selectedPair = null}
          >
            <span class="pair-label">All Messages</span>
            <span class="pair-count">{allMessages.length}</span>
          </button>
          {#each msgPairs as pair}
            {@const key = `${pair.agent1}|${pair.agent2}`}
            <button
              class="pair-item"
              class:active={selectedPair === key}
              onclick={() => selectedPair = key}
            >
              <span class="pair-label">{pair.agent1} / {pair.agent2}</span>
              <span class="pair-count">{pair.message_count}</span>
            </button>
          {/each}
        </div>

        <!-- Message thread -->
        <div class="msg-thread">
          {#if filteredMessages.length === 0}
            <div class="empty">No inter-agent messages yet. Trigger an OODA cycle to generate activity.</div>
          {:else}
            {#each filteredMessages as msg}
              <div class="agent-msg">
                <div class="agent-msg-header">
                  <span class="from-badge">{msg.from_agent}</span>
                  <span class="arrow-icon">→</span>
                  <span class="to-badge">{msg.to_agent}</span>
                  <span class="msg-type-badge">{msg.message_type}</span>
                  <span class="spacer"></span>
                  <span class="ts">{formatTs(msg.created_at)}</span>
                </div>
                <div class="agent-msg-content">{msg.content}</div>
              </div>
            {/each}
          {/if}
        </div>
      </div>

      <!-- Inject message form -->
      <div class="inject-form">
        <select class="select" bind:value={injectFrom}>
          <option value="">From...</option>
          {#each agentNames as name}
            <option value={name}>{name}</option>
          {/each}
          <option value="user">user</option>
        </select>
        <select class="select" bind:value={injectTo}>
          <option value="">To...</option>
          {#each agentNames as name}
            <option value={name}>{name}</option>
          {/each}
        </select>
        <input
          class="input"
          bind:value={injectContent}
          placeholder="Message content..."
          style="flex:1"
        />
        <button
          class="submit-btn"
          onclick={handleInjectMessage}
          disabled={!injectFrom || !injectTo || !injectContent.trim()}
        >
          Send
        </button>
      </div>
    </div>

  {:else if tab === "growth"}
    <!-- Growth: personality, learnings, decision quality -->
    <div class="growth-section">
      <!-- Agent selector row -->
      <div class="growth-agents">
        {#each agentNames as name}
          <button
            class="growth-agent-btn"
            class:active={growthAgent === name}
            onclick={() => growthAgent = growthAgent === name ? null : name}
          >
            <span class="agent-name-sm">{name}</span>
            {#if getMetric(name)}
              <span class="metric-pill" class:improving={getMetric(name)?.trend === "improving"} class:declining={getMetric(name)?.trend === "declining"}>
                {getMetric(name)?.avg_score != null ? `${Math.round(getMetric(name)!.avg_score! * 100)}%` : "—"}
                {#if getMetric(name)?.trend === "improving"}↑{:else if getMetric(name)?.trend === "declining"}↓{/if}
              </span>
            {/if}
          </button>
        {/each}
      </div>

      {#if !growthAgent}
        <!-- Overview: all agents decision metrics -->
        <div class="metrics-grid">
          {#each decisionMetrics as m}
            <div class="metric-card">
              <div class="metric-name">{m.agent_name}</div>
              <div class="metric-stats">
                <span class="metric-score" class:good={m.avg_score != null && m.avg_score >= 0.7} class:mid={m.avg_score != null && m.avg_score >= 0.4 && m.avg_score < 0.7} class:bad={m.avg_score != null && m.avg_score < 0.4}>
                  {m.avg_score != null ? `${Math.round(m.avg_score * 100)}%` : "—"}
                </span>
                <span class="metric-detail">{m.scored_count}/{m.total_count} scored</span>
                <span class="metric-trend" class:improving={m.trend === "improving"} class:declining={m.trend === "declining"}>
                  {m.trend}
                </span>
              </div>
            </div>
          {/each}
          {#if decisionMetrics.length === 0}
            <div class="empty">No decision metrics yet. Run OODA cycles to generate data.</div>
          {/if}
        </div>
      {:else}
        <!-- Agent detail: personality + learnings -->
        <div class="agent-growth-detail">
          <!-- Personality traits -->
          <div class="growth-card">
            <h4 class="growth-card-title">Personality</h4>
            {#if growthTraits.length === 0}
              <div class="empty-sm">No personality traits recorded yet.</div>
            {:else}
              <div class="trait-list">
                {#each growthTraits as t}
                  <div class="trait-row">
                    <span class="trait-name">{t.trait_name}</span>
                    <div class="trait-bar-wrap">
                      <div class="trait-bar" style="width: {Math.round(t.trait_value * 100)}%"></div>
                    </div>
                    <span class="trait-value">{t.trait_value.toFixed(2)}</span>
                    {#each growthDrift.filter(d => d.trait_name === t.trait_name) as d}
                      <span class="drift-indicator" class:up={d.direction === "up"} class:down={d.direction === "down"}>
                        {d.direction === "up" ? "↑" : "↓"}{Math.abs(d.delta).toFixed(2)}
                      </span>
                    {/each}
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Learnings -->
          <div class="growth-card">
            <h4 class="growth-card-title">Knowledge Base</h4>
            {#if growthLearnings.length === 0}
              <div class="empty-sm">No learnings accumulated yet.</div>
            {:else}
              <div class="learning-list">
                {#each growthLearnings as l}
                  <div class="learning-row">
                    <span class="learning-cat" class:insight={l.category === "insight"} class:mistake={l.category === "mistake"} class:pattern={l.category === "pattern"} class:preference={l.category === "preference"}>
                      {l.category}
                    </span>
                    <span class="learning-content">{l.content}</span>
                    <span class="learning-meta">
                      {(l.confidence * 100).toFixed(0)}%
                      {#if l.reinforcement_count > 1}
                        · {l.reinforcement_count}x
                      {/if}
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Decision quality for this agent -->
          {#if growthMetric}
            <div class="growth-card">
              <h4 class="growth-card-title">Decision Quality</h4>
              <div class="quality-summary">
                <span class="quality-score" class:good={growthMetric.avg_score != null && growthMetric.avg_score >= 0.7} class:mid={growthMetric.avg_score != null && growthMetric.avg_score >= 0.4 && growthMetric.avg_score < 0.7} class:bad={growthMetric.avg_score != null && growthMetric.avg_score < 0.4}>
                  {growthMetric.avg_score != null ? `${Math.round(growthMetric.avg_score * 100)}%` : "—"}
                </span>
                <span class="quality-detail">
                  {growthMetric.scored_count} scored / {growthMetric.total_count} total
                </span>
                <span class="quality-trend" class:improving={growthMetric.trend === "improving"} class:declining={growthMetric.trend === "declining"}>
                  {growthMetric.trend}
                </span>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .cognitive-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
  }
  .tab {
    padding: 0.375rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.15s;
  }
  .tab:hover { background: var(--bg-hover); }
  .tab.active {
    background: var(--accent-blue);
    color: white;
    border-color: var(--accent-blue);
  }

  .ooda-btn {
    padding: 0.375rem 0.75rem;
    border: 1px solid rgba(168, 85, 247, 0.4);
    border-radius: 6px;
    background: rgba(168, 85, 247, 0.15);
    color: #c084fc;
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.15s;
  }
  .ooda-btn:hover:not(:disabled) { background: rgba(168, 85, 247, 0.3); }
  .ooda-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .action-msg {
    font-size: 0.75rem;
    color: var(--accent-green);
    padding: 0.25rem 0;
  }
  .error-msg {
    font-size: 0.75rem;
    color: var(--accent-red);
    padding: 0.25rem 0;
  }
  .loading {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.8rem;
    padding: 1rem;
  }
  .empty {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.8rem;
    padding: 2rem 1rem;
  }

  /* -- Goals ---------------------------------------------------------------- */
  .goal-section { display: flex; flex-direction: column; gap: 0.5rem; }
  .add-btn {
    align-self: flex-start;
    padding: 0.3rem 0.6rem;
    border: 1px dashed var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.7rem;
    cursor: pointer;
  }
  .add-btn:hover { border-color: var(--accent-blue); color: var(--accent-blue); }

  .new-goal-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-secondary);
  }
  .input {
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.75rem;
    font-family: inherit;
    resize: vertical;
  }
  .input:focus { outline: none; border-color: var(--accent-blue); }
  .select {
    padding: 0.3rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.7rem;
  }
  .form-row {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .form-label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.65rem;
    color: var(--text-muted);
  }
  .submit-btn {
    align-self: flex-start;
    padding: 0.3rem 0.75rem;
    border: none;
    border-radius: 6px;
    background: var(--accent-blue);
    color: white;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .goal-list { display: flex; flex-direction: column; }
  .goal-row {
    border-bottom: 1px solid var(--border);
  }
  .goal-row:last-child { border-bottom: none; }
  .goal-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.25rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 0.8rem;
    cursor: pointer;
    text-align: left;
  }
  .goal-header:hover { background: var(--bg-hover); }
  .goal-status { font-size: 0.9rem; flex-shrink: 0; }
  .goal-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .goal-meta {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-shrink: 0;
  }
  .priority-tag {
    font-size: 0.6rem;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
  }
  .priority-critical { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
  .priority-high { background: rgba(249, 115, 22, 0.2); color: #f97316; }
  .priority-medium { background: rgba(234, 179, 8, 0.2); color: #eab308; }
  .priority-low { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
  .priority-nice-to-have { background: rgba(100, 116, 139, 0.2); color: #94a3b8; }

  .agent-tag {
    font-size: 0.6rem;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    background: rgba(96, 165, 250, 0.2);
    color: #60a5fa;
  }
  .children-count {
    font-size: 0.6rem;
    color: var(--text-muted);
  }

  .goal-detail {
    padding: 0.5rem 0.75rem 0.75rem;
    font-size: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .detail-text {
    margin: 0;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .detail-row {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    color: var(--text-secondary);
    font-size: 0.7rem;
  }
  .detail-label {
    color: var(--text-muted);
    min-width: 4.5rem;
    flex-shrink: 0;
  }
  .score { font-weight: 600; }

  .goal-actions {
    display: flex;
    gap: 0.3rem;
    margin-top: 0.25rem;
  }
  .action-sm {
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    font-size: 0.65rem;
    cursor: pointer;
  }
  .action-sm.complete { color: var(--accent-green); border-color: rgba(34, 197, 94, 0.3); }
  .action-sm.complete:hover { background: rgba(34, 197, 94, 0.15); }
  .action-sm.pause { color: var(--accent-yellow); border-color: rgba(234, 179, 8, 0.3); }
  .action-sm.pause:hover { background: rgba(234, 179, 8, 0.15); }
  .action-sm.fail { color: var(--accent-red); border-color: rgba(239, 68, 68, 0.3); }
  .action-sm.fail:hover { background: rgba(239, 68, 68, 0.15); }
  .action-sm.resume { color: var(--accent-blue); border-color: rgba(96, 165, 250, 0.3); }
  .action-sm.resume:hover { background: rgba(96, 165, 250, 0.15); }

  /* -- Decisions ------------------------------------------------------------- */
  .decision-list { display: flex; flex-direction: column; }
  .decision-row { border-bottom: 1px solid var(--border); }
  .decision-row:last-child { border-bottom: none; }
  .decision-header {
    display: flex;
    width: 100%;
    padding: 0.5rem 0.25rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
  }
  .decision-header:hover { background: var(--bg-hover); }
  .decision-main {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    width: 100%;
  }
  .decision-action {
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .decision-meta {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .ts { font-size: 0.6rem; color: var(--text-muted); }

  .score-badge {
    font-size: 0.6rem;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-weight: 600;
  }
  .score-badge.good { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
  .score-badge.mid { background: rgba(234, 179, 8, 0.2); color: #eab308; }
  .score-badge.bad { background: rgba(239, 68, 68, 0.2); color: #ef4444; }

  .decision-detail {
    padding: 0.5rem 0.75rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  /* -- Strategy ------------------------------------------------------------- */
  .strategy-section { padding: 0.25rem; }
  .strategy-text {
    margin: 0;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 0.75rem;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 24rem;
    overflow-y: auto;
  }

  /* -- Messages ------------------------------------------------------------- */
  .messages-section { display: flex; flex-direction: column; gap: 0.5rem; }
  .msg-layout {
    display: flex;
    gap: 0.5rem;
    min-height: 200px;
    max-height: 400px;
  }
  .pair-sidebar {
    width: 140px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    border-right: 1px solid var(--border);
    padding-right: 0.5rem;
  }
  .pair-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.3rem 0.4rem;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.65rem;
    cursor: pointer;
    text-align: left;
  }
  .pair-item:hover { background: var(--bg-hover); }
  .pair-item.active { background: var(--accent-blue); color: white; }
  .pair-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pair-count { font-size: 0.55rem; opacity: 0.7; flex-shrink: 0; }

  .msg-thread {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding-right: 0.25rem;
  }
  .agent-msg {
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
  }
  .agent-msg-header {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.65rem;
    margin-bottom: 0.2rem;
  }
  .from-badge {
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    background: rgba(96, 165, 250, 0.2);
    color: #60a5fa;
    font-weight: 600;
    font-size: 0.6rem;
  }
  .to-badge {
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    background: rgba(168, 85, 247, 0.2);
    color: #c084fc;
    font-weight: 600;
    font-size: 0.6rem;
  }
  .arrow-icon { color: var(--text-muted); font-size: 0.6rem; }
  .msg-type-badge {
    font-size: 0.55rem;
    padding: 0.05rem 0.25rem;
    border-radius: 3px;
    background: rgba(156, 163, 175, 0.15);
    color: var(--text-muted);
    text-transform: uppercase;
  }
  .agent-msg-content {
    font-size: 0.75rem;
    color: var(--text-secondary);
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .inject-form {
    display: flex;
    gap: 0.25rem;
    align-items: center;
    padding-top: 0.25rem;
    border-top: 1px solid var(--border);
  }
  .inject-form .select { font-size: 0.65rem; min-width: 0; max-width: 100px; }
  .inject-form .input { font-size: 0.65rem; }
  .inject-form .submit-btn { font-size: 0.65rem; padding: 0.3rem 0.5rem; flex-shrink: 0; }

  /* -- Growth --------------------------------------------------------------- */
  .growth-section { display: flex; flex-direction: column; gap: 0.75rem; }
  .growth-agents {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .growth-agent-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.7rem;
    cursor: pointer;
  }
  .growth-agent-btn:hover { background: var(--bg-hover); }
  .growth-agent-btn.active {
    background: rgba(168, 85, 247, 0.15);
    border-color: rgba(168, 85, 247, 0.4);
    color: #c084fc;
  }
  .agent-name-sm { font-weight: 600; }
  .metric-pill {
    font-size: 0.6rem;
    padding: 0.05rem 0.25rem;
    border-radius: 3px;
    background: rgba(156, 163, 175, 0.15);
    color: var(--text-muted);
  }
  .metric-pill.improving { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
  .metric-pill.declining { background: rgba(239, 68, 68, 0.15); color: #f87171; }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 0.5rem;
  }
  .metric-card {
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
  }
  .metric-name { font-size: 0.75rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.3rem; }
  .metric-stats { display: flex; align-items: center; gap: 0.4rem; font-size: 0.7rem; }
  .metric-score { font-weight: 700; font-size: 0.85rem; }
  .metric-score.good { color: #4ade80; }
  .metric-score.mid { color: #eab308; }
  .metric-score.bad { color: #f87171; }
  .metric-detail { color: var(--text-muted); font-size: 0.6rem; }
  .metric-trend {
    font-size: 0.6rem;
    padding: 0.05rem 0.25rem;
    border-radius: 3px;
    background: rgba(156, 163, 175, 0.15);
    color: var(--text-muted);
    text-transform: uppercase;
  }
  .metric-trend.improving { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
  .metric-trend.declining { background: rgba(239, 68, 68, 0.15); color: #f87171; }

  .agent-growth-detail { display: flex; flex-direction: column; gap: 0.5rem; }
  .growth-card {
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
  }
  .growth-card-title {
    margin: 0 0 0.4rem;
    font-size: 0.75rem;
    color: var(--text-primary);
    font-weight: 600;
  }
  .empty-sm { color: var(--text-muted); font-size: 0.7rem; padding: 0.5rem 0; }

  /* Personality trait bars */
  .trait-list { display: flex; flex-direction: column; gap: 0.3rem; }
  .trait-row { display: flex; align-items: center; gap: 0.4rem; font-size: 0.7rem; }
  .trait-name { width: 100px; color: var(--text-secondary); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex-shrink: 0; }
  .trait-bar-wrap {
    flex: 1;
    height: 6px;
    background: var(--bg-tertiary);
    border-radius: 3px;
    overflow: hidden;
  }
  .trait-bar {
    height: 100%;
    background: linear-gradient(90deg, #6c3fa0, #a855f7);
    border-radius: 3px;
  }
  .trait-value { font-family: monospace; font-size: 0.6rem; color: var(--text-muted); width: 2rem; text-align: right; flex-shrink: 0; }
  .drift-indicator { font-size: 0.55rem; font-weight: 600; flex-shrink: 0; }
  .drift-indicator.up { color: #4ade80; }
  .drift-indicator.down { color: #f87171; }

  /* Learnings */
  .learning-list { display: flex; flex-direction: column; gap: 0.3rem; }
  .learning-row {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    font-size: 0.7rem;
    padding: 0.2rem 0;
    border-bottom: 1px solid var(--border);
  }
  .learning-row:last-child { border-bottom: none; }
  .learning-cat {
    font-size: 0.55rem;
    padding: 0.05rem 0.25rem;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
    flex-shrink: 0;
  }
  .learning-cat.insight { background: rgba(96, 165, 250, 0.2); color: #60a5fa; }
  .learning-cat.mistake { background: rgba(239, 68, 68, 0.2); color: #f87171; }
  .learning-cat.pattern { background: rgba(168, 85, 247, 0.2); color: #c084fc; }
  .learning-cat.preference { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
  .learning-content { flex: 1; color: var(--text-secondary); line-height: 1.3; }
  .learning-meta {
    font-size: 0.6rem;
    color: var(--text-muted);
    font-family: monospace;
    flex-shrink: 0;
  }

  /* Decision quality in growth detail */
  .quality-summary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
  }
  .quality-score { font-weight: 700; font-size: 1rem; }
  .quality-score.good { color: #4ade80; }
  .quality-score.mid { color: #eab308; }
  .quality-score.bad { color: #f87171; }
  .quality-detail { color: var(--text-muted); font-size: 0.7rem; }
  .quality-trend {
    font-size: 0.6rem;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
    background: rgba(156, 163, 175, 0.15);
    color: var(--text-muted);
  }
  .quality-trend.improving { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
  .quality-trend.declining { background: rgba(239, 68, 68, 0.15); color: #f87171; }
</style>
