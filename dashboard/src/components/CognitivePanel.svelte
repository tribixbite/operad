<script lang="ts">
  import {
    fetchCognitiveState, fetchGoals, createGoal, updateGoal,
    fetchDecisions, triggerOoda,
  } from "../lib/api";
  import { connect, on } from "../lib/ws.svelte";
  import type { GoalRecord, DecisionRecord } from "../lib/types";

  // -- State ------------------------------------------------------------------

  let goals: GoalRecord[] = $state([]);
  let decisions: DecisionRecord[] = $state([]);
  let strategy: string = $state("");
  let loading = $state(true);
  let error: string | null = $state(null);
  let actionMsg: string | null = $state(null);

  /** Active tab: goals | decisions | strategy */
  let tab: "goals" | "decisions" | "strategy" = $state("goals");

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
        // Reload after OODA completes to pick up new goals/decisions/strategy
        loadAll();
      }
    });

    return () => { offOoda(); };
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
</style>
