<script lang="ts">
  import {
    fetchAgents, toggleAgent, runAgent, deleteAgent, createAgent,
    fetchAgentRuns, fetchAgentCosts,
  } from "../lib/api";
  import { connect, on } from "../lib/ws.svelte";
  import type { AgentInfo, AgentRunRecord, AgentCostSummary } from "../lib/types";

  // -- State ------------------------------------------------------------------

  let agents: AgentInfo[] = $state([]);
  let runs: AgentRunRecord[] = $state([]);
  let costs: AgentCostSummary[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let actionMsg: string | null = $state(null);

  /** Which agent is expanded for detail view */
  let expandedAgent: string | null = $state(null);

  /** Tab view: agents | runs | costs */
  let activeTab: "agents" | "runs" | "costs" = $state("agents");

  /** New agent form state */
  let showNewForm = $state(false);
  let newAgent = $state({
    name: "",
    description: "",
    prompt: "",
    effort: "high" as "low" | "medium" | "high" | "max",
    model: "",
    max_turns: 50,
  });

  /** Standalone run prompt input */
  let runPrompt = $state("");
  let runningAgent: string | null = $state(null);

  // -- Loading ----------------------------------------------------------------

  async function loadAll() {
    loading = true;
    error = null;
    try {
      const [a, r, c] = await Promise.all([
        fetchAgents(), fetchAgentRuns({ limit: 20 }), fetchAgentCosts(),
      ]);
      agents = a;
      runs = r;
      costs = c;
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  }

  // Load initial data + subscribe to WS events for live updates
  $effect(() => {
    loadAll();
    connect();

    // Auto-refresh when agent runs complete/fail
    const offRun = on("agent_run_update", (msg) => {
      const status = msg.status as string;
      if (status === "completed" || status === "failed") {
        runningAgent = null;
        loadAll();
      } else if (status === "running") {
        runningAgent = msg.agentName as string;
      }
    });

    return () => { offRun(); };
  });

  // -- Actions ----------------------------------------------------------------

  async function handleToggle(name: string) {
    try {
      const result = await toggleAgent(name);
      actionMsg = `${name} ${result.enabled ? "enabled" : "disabled"}`;
      await loadAll();
    } catch (err) {
      error = String(err);
    }
  }

  async function handleRun(name: string) {
    try {
      runningAgent = name;
      const prompt = runPrompt || "Analyze the current system state and take appropriate action.";
      await runAgent(name, prompt);
      actionMsg = `${name} run started`;
      runPrompt = "";
      setTimeout(() => loadAll(), 2000); // Reload after a brief delay
    } catch (err) {
      error = String(err);
    } finally {
      runningAgent = null;
    }
  }

  async function handleDelete(name: string) {
    try {
      await deleteAgent(name);
      actionMsg = `${name} deleted`;
      await loadAll();
    } catch (err) {
      error = String(err);
    }
  }

  async function handleCreate() {
    if (!newAgent.name || !newAgent.description || !newAgent.prompt) {
      error = "Name, description, and prompt are required";
      return;
    }
    try {
      await createAgent({
        name: newAgent.name,
        description: newAgent.description,
        prompt: newAgent.prompt,
        effort: newAgent.effort,
        model: newAgent.model || undefined,
        max_turns: newAgent.max_turns,
        enabled: true,
      });
      actionMsg = `Agent "${newAgent.name}" created`;
      showNewForm = false;
      newAgent = { name: "", description: "", prompt: "", effort: "high", model: "", max_turns: 50 };
      await loadAll();
    } catch (err) {
      error = String(err);
    }
  }

  function formatTime(epoch: number): string {
    return new Date(epoch * 1000).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  function formatCost(usd: number): string {
    return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  }

  const sourceBadge: Record<string, string> = {
    builtin: "badge-blue",
    toml: "badge-purple",
    project: "badge-green",
    user: "badge-orange",
  };
</script>

<div class="agent-panel">
  <!-- Tab bar -->
  <div class="tabs">
    <button class="tab" class:active={activeTab === "agents"} onclick={() => (activeTab = "agents")}>
      Agents <span class="count">{agents.length}</span>
    </button>
    <button class="tab" class:active={activeTab === "runs"} onclick={() => (activeTab = "runs")}>
      Runs <span class="count">{runs.length}</span>
    </button>
    <button class="tab" class:active={activeTab === "costs"} onclick={() => (activeTab = "costs")}>
      Costs
    </button>
    <button class="btn-new" onclick={() => (showNewForm = !showNewForm)}>
      {showNewForm ? "Cancel" : "+ New"}
    </button>
  </div>

  {#if actionMsg}
    <div class="action-msg" onclick={() => (actionMsg = null)}>{actionMsg}</div>
  {/if}
  {#if error}
    <div class="error-msg" onclick={() => (error = null)}>{error}</div>
  {/if}

  {#if loading}
    <p class="muted">Loading agents...</p>
  {:else if activeTab === "agents"}

    <!-- New agent form -->
    {#if showNewForm}
      <div class="new-form">
        <input class="input" bind:value={newAgent.name} placeholder="agent-name (kebab-case)" />
        <input class="input" bind:value={newAgent.description} placeholder="Description" />
        <textarea class="input textarea" bind:value={newAgent.prompt} placeholder="System prompt..." rows="4"></textarea>
        <div class="form-row">
          <select class="input select" bind:value={newAgent.effort}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="max">Max</option>
          </select>
          <input class="input" bind:value={newAgent.model} placeholder="Model (optional)" style="flex:1" />
          <input class="input" type="number" bind:value={newAgent.max_turns} style="width:60px" />
        </div>
        <button class="btn-primary" onclick={handleCreate}>Create Agent</button>
      </div>
    {/if}

    <!-- Agent list -->
    {#each agents as agent (agent.name)}
      <div class="agent-card" class:disabled={!agent.enabled}>
        <div class="agent-header" onclick={() => expandedAgent = expandedAgent === agent.name ? null : agent.name}>
          <span class="chevron">{expandedAgent === agent.name ? "▾" : "▸"}</span>
          <span class="agent-name">{agent.name}</span>
          <span class="badge {sourceBadge[agent.source] ?? 'badge-gray'}">{agent.source}</span>
          {#if agent.effort}
            <span class="badge badge-dim">{agent.effort}</span>
          {/if}
          <span class="spacer"></span>
          <label class="toggle" onclick={(e: MouseEvent) => e.stopPropagation()}>
            <input type="checkbox" checked={agent.enabled} onchange={() => handleToggle(agent.name)} />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <p class="agent-desc">{agent.description}</p>

        {#if expandedAgent === agent.name}
          <div class="agent-detail">
            <div class="detail-grid">
              {#if agent.model}<div class="detail-label">Model</div><div>{agent.model}</div>{/if}
              {#if agent.max_turns}<div class="detail-label">Max turns</div><div>{agent.max_turns}</div>{/if}
              {#if agent.max_budget_usd}<div class="detail-label">Budget</div><div>${agent.max_budget_usd}</div>{/if}
              {#if agent.memory}<div class="detail-label">Memory</div><div>{agent.memory}</div>{/if}
              {#if agent.permission_mode}<div class="detail-label">Permissions</div><div>{agent.permission_mode}</div>{/if}
              {#if agent.disallowed_tools?.length}<div class="detail-label">Blocked</div><div>{agent.disallowed_tools.join(", ")}</div>{/if}
            </div>

            <details class="prompt-details">
              <summary>System prompt</summary>
              <pre class="prompt-text">{agent.prompt}</pre>
            </details>

            <div class="agent-actions">
              <div class="run-row">
                <input
                  class="input"
                  bind:value={runPrompt}
                  placeholder="Prompt (optional)"
                  style="flex:1"
                />
                <button
                  class="btn-run"
                  disabled={!agent.enabled || runningAgent !== null}
                  onclick={() => handleRun(agent.name)}
                >
                  {runningAgent === agent.name ? "Running..." : "Run"}
                </button>
              </div>
              {#if agent.source !== "builtin"}
                <button class="btn-danger" onclick={() => handleDelete(agent.name)}>Delete</button>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <p class="muted">No agents configured</p>
    {/each}

  {:else if activeTab === "runs"}
    <!-- Run history -->
    {#if runs.length === 0}
      <p class="muted">No agent runs recorded yet</p>
    {:else}
      <div class="run-list">
        {#each runs as run (run.id)}
          <div class="run-card">
            <div class="run-header">
              <span class="agent-name">{run.agent_name}</span>
              <span class="badge" class:badge-green={run.status === "completed"} class:badge-red={run.status === "failed"} class:badge-yellow={run.status === "running"}>
                {run.status}
              </span>
              <span class="spacer"></span>
              <span class="muted">{formatTime(run.started_at)}</span>
            </div>
            <div class="run-stats">
              <span>{formatCost(run.cost_usd)}</span>
              <span class="muted">{run.turns} turns</span>
              <span class="muted">{run.input_tokens + run.output_tokens} tokens</span>
              {#if run.finished_at}
                <span class="muted">{Math.round((run.finished_at - run.started_at))}s</span>
              {/if}
            </div>
            {#if run.error}
              <p class="error-text">{run.error}</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

  {:else if activeTab === "costs"}
    <!-- Per-agent cost summary -->
    {#if costs.length === 0}
      <p class="muted">No cost data yet</p>
    {:else}
      <div class="cost-list">
        {#each costs as cost (cost.agent_name)}
          <div class="cost-card">
            <span class="agent-name">{cost.agent_name}</span>
            <span class="cost-total">{formatCost(cost.total_cost)}</span>
            <span class="muted">{cost.run_count} runs</span>
            <span class="muted">avg {formatCost(cost.avg_cost)}</span>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .agent-panel { display: flex; flex-direction: column; gap: 0.5rem; }

  .tabs {
    display: flex;
    gap: 0.25rem;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    background: none;
    border: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.75rem;
    padding: 0.375rem 0.5rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .tab.active { color: var(--text-primary); border-bottom-color: var(--accent-blue); }
  .tab:hover { color: var(--text-primary); }
  .count { font-size: 0.625rem; opacity: 0.6; }
  .btn-new {
    margin-left: auto;
    background: var(--accent-blue);
    color: #fff;
    border: none;
    font: inherit;
    font-size: 0.6875rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
  }

  .action-msg {
    font-size: 0.6875rem;
    color: var(--accent-green, #4ade80);
    padding: 0.25rem 0.5rem;
    background: rgba(74, 222, 128, 0.1);
    border-radius: 4px;
    cursor: pointer;
  }
  .error-msg {
    font-size: 0.6875rem;
    color: var(--accent-red, #f87171);
    padding: 0.25rem 0.5rem;
    background: rgba(248, 113, 113, 0.1);
    border-radius: 4px;
    cursor: pointer;
  }
  .error-text { color: var(--accent-red, #f87171); font-size: 0.6875rem; margin: 0.25rem 0; }
  .muted { color: var(--text-muted); font-size: 0.6875rem; }

  .agent-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.625rem;
  }
  .agent-card.disabled { opacity: 0.5; }
  .agent-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    cursor: pointer;
  }
  .chevron { font-size: 0.625rem; color: var(--text-muted); width: 0.75rem; flex-shrink: 0; }
  .agent-name { font-size: 0.75rem; font-weight: 600; color: var(--text-primary); }
  .agent-desc {
    font-size: 0.6875rem;
    color: var(--text-muted);
    margin: 0.25rem 0 0 1.125rem;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .spacer { flex: 1; }

  .badge {
    font-size: 0.5625rem;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .badge-blue { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
  .badge-purple { background: rgba(168, 85, 247, 0.2); color: #c084fc; }
  .badge-green { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
  .badge-orange { background: rgba(249, 115, 22, 0.2); color: #fb923c; }
  .badge-red { background: rgba(248, 113, 113, 0.2); color: #f87171; }
  .badge-yellow { background: rgba(250, 204, 21, 0.2); color: #fde047; }
  .badge-gray { background: rgba(156, 163, 175, 0.2); color: #9ca3af; }
  .badge-dim { background: rgba(156, 163, 175, 0.1); color: var(--text-muted); }

  /* Toggle switch */
  .toggle { position: relative; display: inline-block; width: 28px; height: 16px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider {
    position: absolute; inset: 0;
    background: var(--bg-tertiary);
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .toggle-slider::before {
    content: "";
    position: absolute;
    left: 2px; top: 2px;
    width: 12px; height: 12px;
    background: var(--text-muted);
    border-radius: 50%;
    transition: transform 0.2s, background 0.2s;
  }
  .toggle input:checked + .toggle-slider { background: var(--accent-blue); }
  .toggle input:checked + .toggle-slider::before { transform: translateX(12px); background: #fff; }

  .agent-detail { margin-top: 0.5rem; padding-left: 1.125rem; }
  .detail-grid { display: grid; grid-template-columns: auto 1fr; gap: 0.125rem 0.5rem; font-size: 0.6875rem; }
  .detail-label { color: var(--text-muted); }

  .prompt-details { margin-top: 0.375rem; }
  .prompt-details summary {
    font-size: 0.6875rem;
    color: var(--text-muted);
    cursor: pointer;
  }
  .prompt-text {
    font-size: 0.625rem;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    padding: 0.5rem;
    border-radius: 4px;
    max-height: 200px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
    margin-top: 0.25rem;
  }

  .agent-actions { display: flex; flex-direction: column; gap: 0.375rem; margin-top: 0.5rem; }
  .run-row { display: flex; gap: 0.25rem; }
  .btn-run {
    background: var(--accent-green, #22c55e);
    color: #fff;
    border: none;
    font: inherit;
    font-size: 0.6875rem;
    padding: 0.375rem 0.75rem;
    border-radius: 4px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .btn-run:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-danger {
    background: rgba(248, 113, 113, 0.15);
    color: #f87171;
    border: 1px solid rgba(248, 113, 113, 0.3);
    font: inherit;
    font-size: 0.6875rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    align-self: flex-start;
  }
  .btn-primary {
    background: var(--accent-blue);
    color: #fff;
    border: none;
    font: inherit;
    font-size: 0.6875rem;
    padding: 0.375rem 0.75rem;
    border-radius: 4px;
    cursor: pointer;
  }

  .input {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    font: inherit;
    font-size: 0.6875rem;
    padding: 0.375rem 0.5rem;
  }
  .input:focus { outline: none; border-color: var(--accent-blue); }
  .input::placeholder { color: var(--text-muted); }
  .textarea { resize: vertical; font-family: monospace; }
  .select { min-width: 80px; }

  .new-form {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .form-row { display: flex; gap: 0.25rem; }

  .run-list, .cost-list { display: flex; flex-direction: column; gap: 0.375rem; }
  .run-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.625rem;
  }
  .run-header { display: flex; align-items: center; gap: 0.375rem; }
  .run-stats {
    display: flex;
    gap: 0.75rem;
    font-size: 0.6875rem;
    margin-top: 0.25rem;
    padding-left: 0.25rem;
  }

  .cost-card {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.625rem;
    font-size: 0.6875rem;
  }
  .cost-total { font-weight: 600; color: var(--accent-green, #4ade80); }
</style>
