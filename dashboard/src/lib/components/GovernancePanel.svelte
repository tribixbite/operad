<script lang="ts">
  /**
   * GovernancePanel — surfaces the four agent-governance endpoints that
   * existed daemon-side but had no UI:
   *   - Trust ledger (per-agent score + history of deltas)
   *   - Active tool leases (revocable tokens granting tool access)
   *   - Persistent schedules (cron / interval agent runs)
   *   - Memory consolidation (decay/prune/merge runs + manual trigger)
   *
   * One panel with internal tabs keeps the Settings page footprint small
   * while making the four features browsable and actionable.
   */
  import {
    fetchTrustSummary, fetchTrustDetail,
    fetchLeases, revokeLeases,
    fetchSchedules, createSchedule, setScheduleEnabled, deleteSchedule,
    fetchConsolidation, runConsolidation,
    fetchAgents,
  } from "$lib/api";
  import type {
    TrustSummary, AgentLease, ScheduleRecord, ScheduleInput,
    ConsolidationSummary, AgentInfo,
  } from "$lib/types";

  let tab: "trust" | "leases" | "schedules" | "consolidation" = $state("trust");

  let agents = $state<AgentInfo[]>([]);
  let actionMsg = $state<string | null>(null);
  let actionErr = $state<string | null>(null);

  // -- Trust ------------------------------------------------------------------
  let trust = $state<TrustSummary[]>([]);
  let trustExpanded = $state<string | null>(null);
  let trustDetail = $state<TrustSummary | null>(null);
  let trustLoading = $state(false);

  async function loadTrust() {
    trustLoading = true;
    try { trust = await fetchTrustSummary(); }
    catch (err) { actionErr = `trust load failed: ${(err as Error).message}`; }
    finally { trustLoading = false; }
  }

  async function expandTrust(agent: string) {
    if (trustExpanded === agent) {
      trustExpanded = null;
      trustDetail = null;
      return;
    }
    trustExpanded = agent;
    trustDetail = null;
    try { trustDetail = await fetchTrustDetail(agent); }
    catch (err) { actionErr = `trust detail failed: ${(err as Error).message}`; }
  }

  // -- Leases -----------------------------------------------------------------
  let leasesAgent = $state<string>("");
  let leases = $state<AgentLease[]>([]);
  let leasesLoading = $state(false);

  async function loadLeases(agent: string) {
    leasesAgent = agent;
    leasesLoading = true;
    leases = [];
    try { leases = await fetchLeases(agent); }
    catch (err) { actionErr = `leases failed: ${(err as Error).message}`; }
    finally { leasesLoading = false; }
  }

  async function handleRevokeAll(agent: string) {
    if (!confirm(`Revoke ALL active tool leases for ${agent}?`)) return;
    try {
      const revoked = await revokeLeases(agent);
      actionMsg = `Revoked ${revoked} lease${revoked === 1 ? "" : "s"} for ${agent}`;
      await loadLeases(agent);
    } catch (err) { actionErr = `revoke failed: ${(err as Error).message}`; }
  }

  // -- Schedules --------------------------------------------------------------
  let schedules = $state<ScheduleRecord[]>([]);
  let schedulesLoading = $state(false);
  let showScheduleForm = $state(false);
  let scheduleForm = $state<ScheduleInput>({
    agent_name: "master-controller",
    schedule_name: "",
    prompt: "",
  });
  /** "interval" hides cron_expr input; "cron" hides interval_minutes. */
  let scheduleMode = $state<"interval" | "cron">("interval");
  let intervalMinutes = $state<number>(60);
  let cronExpr = $state<string>("0 * * * *");

  async function loadSchedules() {
    schedulesLoading = true;
    try { schedules = await fetchSchedules(); }
    catch (err) { actionErr = `schedules failed: ${(err as Error).message}`; }
    finally { schedulesLoading = false; }
  }

  async function handleCreateSchedule() {
    if (!scheduleForm.schedule_name || !scheduleForm.prompt) {
      actionErr = "schedule_name and prompt required";
      return;
    }
    const body: ScheduleInput = { ...scheduleForm };
    if (scheduleMode === "interval") body.interval_minutes = intervalMinutes;
    else body.cron_expr = cronExpr;
    try {
      const id = await createSchedule(body);
      actionMsg = `Created schedule #${id}`;
      showScheduleForm = false;
      scheduleForm = { agent_name: "master-controller", schedule_name: "", prompt: "" };
      await loadSchedules();
    } catch (err) { actionErr = `create failed: ${(err as Error).message}`; }
  }

  async function toggleSchedule(s: ScheduleRecord) {
    try {
      await setScheduleEnabled(s.id, !s.enabled);
      await loadSchedules();
    } catch (err) { actionErr = `toggle failed: ${(err as Error).message}`; }
  }

  async function handleDeleteSchedule(s: ScheduleRecord) {
    if (!confirm(`Delete schedule '${s.schedule_name}' for ${s.agent_name}?`)) return;
    try {
      await deleteSchedule(s.schedule_name, s.agent_name);
      actionMsg = `Deleted '${s.schedule_name}'`;
      await loadSchedules();
    } catch (err) { actionErr = `delete failed: ${(err as Error).message}`; }
  }

  // -- Consolidation ----------------------------------------------------------
  let consolidation = $state<ConsolidationSummary | null>(null);
  let consolidationLoading = $state(false);
  let consolidationRunning = $state(false);

  async function loadConsolidation() {
    consolidationLoading = true;
    try { consolidation = await fetchConsolidation(20); }
    catch (err) { actionErr = `consolidation history failed: ${(err as Error).message}`; }
    finally { consolidationLoading = false; }
  }

  async function handleRunConsolidation() {
    if (!confirm("Run consolidation now? Decays and merges agent learnings; may take a moment.")) return;
    consolidationRunning = true;
    try {
      const result = await runConsolidation();
      actionMsg = `Decayed ${result.learnings_decayed}, pruned ${result.learnings_pruned}, ` +
        `merged ${result.learnings_merged}, cross-pollinated ${result.cross_pollinated}`;
      await loadConsolidation();
    } catch (err) { actionErr = `consolidation failed: ${(err as Error).message}`; }
    finally { consolidationRunning = false; }
  }

  // -- Setup ------------------------------------------------------------------
  $effect(() => {
    actionErr = null;
    actionMsg = null;
    if (tab === "trust" && trust.length === 0 && !trustLoading) loadTrust();
    if (tab === "schedules" && schedules.length === 0 && !schedulesLoading) loadSchedules();
    if (tab === "consolidation" && !consolidation && !consolidationLoading) loadConsolidation();
    if (tab === "leases" && agents.length === 0) {
      fetchAgents().then((a) => { agents = a; if (a.length && !leasesAgent) loadLeases(a[0].name); });
    }
  });

  function fmtEpoch(epoch: number | null): string {
    if (!epoch) return "—";
    const d = new Date(epoch * 1000);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function fmtMs(epochMs: number | null | undefined): string {
    if (!epochMs) return "—";
    return new Date(epochMs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
</script>

<div class="governance-panel">
  <div class="tabs">
    <button class="tab" class:active={tab === "trust"} onclick={() => (tab = "trust")}>Trust</button>
    <button class="tab" class:active={tab === "leases"} onclick={() => (tab = "leases")}>Leases</button>
    <button class="tab" class:active={tab === "schedules"} onclick={() => (tab = "schedules")}>Schedules</button>
    <button class="tab" class:active={tab === "consolidation"} onclick={() => (tab = "consolidation")}>Consolidation</button>
  </div>

  {#if actionMsg}<div class="msg-ok">{actionMsg}</div>{/if}
  {#if actionErr}<div class="msg-err">{actionErr}</div>{/if}

  {#if tab === "trust"}
    {#if trustLoading}
      <p class="muted">Loading trust scores…</p>
    {:else if trust.length === 0}
      <p class="muted">No agents reporting trust yet.</p>
    {:else}
      <table class="g-table">
        <thead><tr><th>Agent</th><th>Score</th><th>Recommended</th><th>Current</th><th></th></tr></thead>
        <tbody>
          {#each trust as t (t.agent)}
            <tr>
              <td class="mono">{t.agent}</td>
              <td>{t.score}</td>
              <td>{t.recommended}</td>
              <td class="muted">{t.current ?? "—"}</td>
              <td>
                <button class="btn btn-xs" onclick={() => expandTrust(t.agent)}>
                  {trustExpanded === t.agent ? "Hide" : "History"}
                </button>
              </td>
            </tr>
            {#if trustExpanded === t.agent}
              <tr class="detail-row">
                <td colspan="5">
                  {#if !trustDetail}
                    <p class="muted">Loading…</p>
                  {:else if !trustDetail.history?.length}
                    <p class="muted">No deltas recorded.</p>
                  {:else}
                    <table class="g-table inner">
                      <thead><tr><th>When</th><th>Δ</th><th>Reason</th></tr></thead>
                      <tbody>
                        {#each trustDetail.history as h (h.id)}
                          <tr>
                            <td class="muted">{fmtEpoch(h.created_at)}</td>
                            <td class={h.score_delta >= 0 ? "delta-pos" : "delta-neg"}>{h.score_delta >= 0 ? "+" : ""}{h.score_delta}</td>
                            <td>{h.reason}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  {/if}
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    {/if}
  {:else if tab === "leases"}
    {#if agents.length === 0}
      <p class="muted">Loading agents…</p>
    {:else}
      <div class="agent-picker">
        <label>Agent:</label>
        <select bind:value={leasesAgent} onchange={() => loadLeases(leasesAgent)}>
          {#each agents as a (a.name)}<option value={a.name}>{a.name}</option>{/each}
        </select>
        <button class="btn btn-xs" onclick={() => loadLeases(leasesAgent)} disabled={leasesLoading}>Refresh</button>
        <button class="btn btn-xs btn-danger" onclick={() => handleRevokeAll(leasesAgent)} disabled={!leases.length}>Revoke all</button>
      </div>
      {#if leasesLoading}
        <p class="muted">Loading…</p>
      {:else if leases.length === 0}
        <p class="muted">No active leases for {leasesAgent}.</p>
      {:else}
        <table class="g-table">
          <thead><tr><th>Tool</th><th>Goal</th><th>Used / Max</th><th>Expires</th></tr></thead>
          <tbody>
            {#each leases as l (l.id)}
              <tr>
                <td class="mono">{l.tool_name}</td>
                <td class="muted">{l.goal_id ?? "—"}</td>
                <td>{l.executions_used}{l.max_executions !== null ? ` / ${l.max_executions}` : ""}</td>
                <td class="muted">{l.expires_at !== null ? fmtEpoch(l.expires_at) : "no expiry"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {/if}
  {:else if tab === "schedules"}
    <div class="action-bar">
      <button class="btn btn-sm" onclick={() => loadSchedules()} disabled={schedulesLoading}>Refresh</button>
      <button class="btn btn-sm btn-primary" onclick={() => (showScheduleForm = !showScheduleForm)}>
        {showScheduleForm ? "Cancel" : "+ New schedule"}
      </button>
    </div>
    {#if showScheduleForm}
      <form class="form-card" onsubmit={(e) => { e.preventDefault(); handleCreateSchedule(); }}>
        <label>Agent name <input type="text" bind:value={scheduleForm.agent_name} required /></label>
        <label>Schedule name <input type="text" bind:value={scheduleForm.schedule_name} required placeholder="nightly-review" /></label>
        <label>Prompt <textarea bind:value={scheduleForm.prompt} required rows="3" placeholder="What should the agent do when this fires?"></textarea></label>
        <fieldset class="mode-fieldset">
          <legend>Trigger</legend>
          <label class="inline"><input type="radio" bind:group={scheduleMode} value="interval" /> Every N minutes</label>
          <label class="inline"><input type="radio" bind:group={scheduleMode} value="cron" /> Cron expression</label>
        </fieldset>
        {#if scheduleMode === "interval"}
          <label>Interval (minutes) <input type="number" bind:value={intervalMinutes} min="1" required /></label>
        {:else}
          <label>Cron <input type="text" bind:value={cronExpr} placeholder="0 9 * * 1-5" required /></label>
        {/if}
        <label>Max budget (USD, optional) <input type="number" bind:value={scheduleForm.max_budget_usd} step="0.01" min="0" /></label>
        <button type="submit" class="btn btn-sm btn-primary">Create</button>
      </form>
    {/if}
    {#if schedulesLoading}
      <p class="muted">Loading…</p>
    {:else if schedules.length === 0}
      <p class="muted">No schedules persisted yet.</p>
    {:else}
      <table class="g-table">
        <thead><tr><th>Name</th><th>Agent</th><th>Trigger</th><th>Last run</th><th>Next run</th><th>Runs</th><th>Cost</th><th></th></tr></thead>
        <tbody>
          {#each schedules as s (s.id)}
            <tr class:disabled-row={!s.enabled}>
              <td class="mono">{s.schedule_name}</td>
              <td class="muted">{s.agent_name}</td>
              <td>{s.cron_expr ?? `every ${s.interval_minutes}m`}</td>
              <td class="muted">{fmtEpoch(s.last_run_at)}</td>
              <td class="muted">{fmtEpoch(s.next_run_at)}</td>
              <td>{s.run_count}</td>
              <td>${s.total_cost_usd.toFixed(2)}</td>
              <td>
                <button class="btn btn-xs" onclick={() => toggleSchedule(s)}>{s.enabled ? "Disable" : "Enable"}</button>
                <button class="btn btn-xs btn-danger" onclick={() => handleDeleteSchedule(s)}>Delete</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {:else if tab === "consolidation"}
    <div class="action-bar">
      <button class="btn btn-sm" onclick={() => loadConsolidation()} disabled={consolidationLoading}>Refresh</button>
      <button class="btn btn-sm btn-primary" onclick={() => handleRunConsolidation()} disabled={consolidationRunning}>
        {consolidationRunning ? "Running…" : "Run now"}
      </button>
    </div>
    {#if consolidationLoading}
      <p class="muted">Loading history…</p>
    {:else if !consolidation}
      <p class="muted">—</p>
    {:else}
      <p class="muted">Last run: {fmtMs(consolidation.last_run_at)}</p>
      {#if consolidation.history.length === 0}
        <p class="muted">No consolidation runs recorded.</p>
      {:else}
        <table class="g-table">
          <thead><tr><th>Started</th><th>Duration</th><th>Decayed</th><th>Pruned</th><th>Merged</th><th>Cross-pollinated</th></tr></thead>
          <tbody>
            {#each consolidation.history as r (r.started_at)}
              <tr>
                <td class="muted">{fmtMs(r.started_at)}</td>
                <td>{(r.duration_ms / 1000).toFixed(1)}s</td>
                <td>{r.learnings_decayed}</td>
                <td>{r.learnings_pruned}</td>
                <td>{r.learnings_merged}</td>
                <td>{r.cross_pollinated}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .governance-panel { display: flex; flex-direction: column; gap: 0.5rem; }
  .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border); margin-bottom: 0.5rem; }
  .tab {
    background: none; border: none; padding: 0.375rem 0.75rem; cursor: pointer;
    font-family: inherit; color: var(--text-secondary); font-size: 0.75rem;
    border-bottom: 2px solid transparent;
  }
  .tab.active { color: var(--text-primary); border-bottom-color: var(--accent-blue); }
  .muted { color: var(--text-muted); font-size: 0.75rem; }
  .mono { font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace; }
  .g-table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
  .g-table th, .g-table td { text-align: left; padding: 0.375rem 0.5rem; border-bottom: 1px solid var(--border); }
  .g-table.inner { margin: 0.25rem 0 0.5rem 0.75rem; }
  .detail-row td { background: var(--bg-tertiary); }
  .delta-pos { color: var(--accent-green); }
  .delta-neg { color: var(--accent-red); }
  .disabled-row { opacity: 0.5; }
  .action-bar { display: flex; gap: 0.375rem; margin-bottom: 0.5rem; flex-wrap: wrap; }
  .agent-picker {
    display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }
  .agent-picker label { font-size: 0.75rem; color: var(--text-secondary); }
  .agent-picker select {
    padding: 0.25rem 0.5rem; background: var(--bg-tertiary);
    border: 1px solid var(--border); border-radius: 4px;
    color: var(--text-primary); font-family: inherit; font-size: 0.75rem;
  }
  .form-card {
    display: flex; flex-direction: column; gap: 0.375rem;
    padding: 0.625rem 0.75rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg-tertiary); margin-bottom: 0.5rem;
  }
  .form-card label { display: flex; flex-direction: column; gap: 0.125rem; font-size: 0.6875rem; color: var(--text-secondary); }
  .form-card label.inline { flex-direction: row; align-items: center; gap: 0.25rem; }
  .form-card input, .form-card textarea, .form-card select {
    padding: 0.25rem 0.5rem; background: var(--bg-secondary);
    border: 1px solid var(--border); border-radius: 4px;
    color: var(--text-primary); font-family: inherit; font-size: 0.75rem;
  }
  .form-card textarea { font-family: ui-monospace, 'Cascadia Code', monospace; }
  .mode-fieldset { border: 1px solid var(--border); border-radius: 4px; padding: 0.375rem 0.5rem; }
  .mode-fieldset legend { padding: 0 0.25rem; font-size: 0.6875rem; color: var(--text-muted); }
  .msg-ok { color: var(--accent-green); font-size: 0.75rem; padding: 0.25rem 0; }
  .msg-err { color: var(--accent-red); font-size: 0.75rem; padding: 0.25rem 0; }
  .btn-xs { padding: 0.125rem 0.375rem; font-size: 0.625rem; border-radius: 3px; }
</style>
