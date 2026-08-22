<script lang="ts">
  import { fetchTokenUsage } from "$lib/api";
  import { store } from "$lib/store.svelte";
  import type { TokenRange, TokenRangeSummary, TokenTotals } from "$lib/types";
  import CostChart from "./CostChart.svelte";

  // -- State -------------------------------------------------------------------

  let expanded = $state(false);
  let range = $state<TokenRange>("all");
  let summary = $state<TokenRangeSummary | null>(null);
  let loading = $state(true);
  /**
   * True while a refresh is in flight — drives a subtle busy cue, not a spinner.
   *
   * The in-flight COUNT is deliberately a plain (non-reactive) variable: the
   * loader runs synchronously inside the $effect below, so reading a `$state`
   * counter there (`pending++`) would subscribe the effect to it, and the
   * matching decrement would re-trigger the effect — an unbounded fetch loop
   * that pins the main thread. Only the boolean is reactive, and it is written
   * but never read inside the effect.
   */
  let inflight = 0;
  let busy = $state(false);
  let error = $state<string | null>(null);

  /** Which project rows have their per-session breakdown open (keyed by path). */
  let openProjects = $state<Record<string, boolean>>({});

  const RANGES: Array<{ id: TokenRange; label: string; short: string }> = [
    { id: "all", label: "All time", short: "all time" },
    { id: "week", label: "Week", short: "7 days" },
    { id: "day", label: "Today", short: "today" },
  ];

  // -- Data loading ------------------------------------------------------------

  /**
   * Monotonic request counter. Range switches can overlap (a slow all-time
   * scan resolving after a fast today scan), so only the newest response is
   * allowed to write state.
   */
  let reqSeq = 0;

  async function load(r: TokenRange, signal: AbortSignal): Promise<void> {
    const mine = ++reqSeq;
    inflight++;
    busy = true;
    try {
      const data = await fetchTokenUsage(r, signal);
      if (mine !== reqSeq) return; // superseded by a newer request
      summary = data;
      error = null;
    } catch (e: unknown) {
      // An abort is a deliberate cancellation, not a failure to report.
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (mine !== reqSeq) return;
      error = e instanceof Error ? e.message : "Failed to load token usage";
    } finally {
      inflight = Math.max(0, inflight - 1);
      busy = inflight > 0;
      if (mine === reqSeq) loading = false;
    }
  }

  /**
   * Fetch on mount and whenever the range changes; poll only while the card is
   * open.
   *
   * The previous version polled /api/tokens every 30s unconditionally — even
   * collapsed — and that endpoint re-parsed the entire JSONL corpus on every
   * call (~137MB, 1.1-1.6s) because its result cache was capped at 10 entries
   * against a 28-file working set. Reading `expanded` here makes the poll
   * conditional; the server-side scanner is now incremental, so each refresh
   * only reads bytes appended since the last one.
   */
  $effect(() => {
    // Depends on `range` only: one fetch on mount and one per range change.
    // Toggling the card open/closed must not re-fetch.
    const r = range;
    if (typeof window === "undefined") return;

    const controller = new AbortController();
    void load(r, controller.signal);
    return () => controller.abort();
  });

  $effect(() => {
    // Polling is scoped to the open card, so a collapsed panel costs nothing.
    const r = range;
    const isOpen = expanded;
    if (typeof window === "undefined" || !isOpen) return;

    const controller = new AbortController();
    const timer = setInterval(() => void load(r, controller.signal), 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  });

  // -- Formatting --------------------------------------------------------------

  /** Format a token count with K/M/B suffix */
  function fmtTokens(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  }

  /** Format cost as a dollar string */
  function fmtCost(usd: number): string {
    if (usd === 0) return "$0";
    if (usd < 0.01) return "<$0.01";
    return `$${usd.toFixed(2)}`;
  }

  /** Share of input tokens served from cache */
  function cachePct(t: TokenTotals): number {
    const inputSide = t.input_tokens + t.cache_read_tokens + t.cache_creation_tokens;
    if (inputSide === 0) return 0;
    return Math.round((t.cache_read_tokens / inputSide) * 100);
  }

  /** Short, stable label for a session id */
  function shortId(id: string): string {
    return id.length > 8 ? id.slice(0, 8) : id;
  }

  /** "3m ago" / "2h ago" / "5d ago" for a session's last activity */
  function relTime(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "";
    const min = Math.floor(ms / 60_000);
    if (min < 1) return "now";
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    return `${Math.floor(hr / 24)}d`;
  }

  function toggleProject(path: string): void {
    openProjects = { ...openProjects, [path]: !openProjects[path] };
  }

  // -- Weekly quota ------------------------------------------------------------
  //
  // Quota lives on the SSE daemon payload, not on the range scan: it is a
  // standing budget, so it does not move when the range tabs do. It used to be
  // rendered by CostChart; that component is presentational now, so it belongs
  // here — and without it the plan badge, weekly budget, velocity trend and
  // rolling-window usage appeared nowhere in the dashboard at all.
  //
  // Rendered only when there is something to say. It is fed by the `costs`
  // table, which only the agent/SDK path writes, so an install that never runs
  // agents and sets no quota_weekly_tokens would otherwise get a permanently
  // empty progress bar reading 0 / 0.

  const quota = $derived(store.daemon?.quota ?? null);
  const showQuota = $derived(
    !!quota && (quota.weekly_tokens_used > 0 || quota.weekly_tokens_limit > 0),
  );

  /** Quota level to CSS color variable */
  function levelColor(level: string): string {
    switch (level) {
      case "ok": return "var(--accent-green)";
      case "warning": return "var(--accent-yellow)";
      case "critical": case "exceeded": return "var(--accent-red)";
      default: return "var(--text-muted)";
    }
  }

  /** Velocity trend arrow ("" when stable) */
  function trendArrow(trend: string): string {
    if (trend === "rising") return "↑";
    if (trend === "falling") return "↓";
    return "";
  }

  /** Velocity trend color */
  function trendColor(trend: string): string {
    if (trend === "rising") return "var(--accent-yellow)";
    if (trend === "falling") return "var(--accent-green)";
    return "var(--text-muted)";
  }

  // -- Derived -----------------------------------------------------------------

  const totals = $derived(summary?.totals ?? null);
  const projects = $derived(summary?.projects ?? []);
  const daily = $derived(summary?.daily ?? []);
  const rangeShort = $derived(RANGES.find((r) => r.id === range)?.short ?? "");

  /**
   * Tokens the server could not price (a model with no published rate).
   * Surfaced rather than swallowed: a silently-incomplete total is the class
   * of bug this panel already had once, when one hardcoded rate was applied
   * to every model.
   */
  const unpriced = $derived(totals?.unpriced_tokens ?? 0);
  const unpricedModels = $derived(totals?.unpriced_models ?? []);
  const sessionCount = $derived(projects.reduce((s, p) => s + p.sessions.length, 0));
</script>

<div class="card compact-card" class:expanded>
  <button class="card-header" onclick={() => (expanded = !expanded)} aria-expanded={expanded}>
    <span class="header-left">
      <span class="chevron">{expanded ? "▾" : "▸"}</span>
      <span class="label">Tokens</span>
    </span>
    {#if loading}
      <span class="inline-info dim">…</span>
    {:else if error}
      <span class="inline-info err">error</span>
    {:else if totals}
      <span class="inline-info">
        <span class="inline-stat">{fmtTokens(totals.total_tokens)}<span class="unit">{rangeShort}</span></span>
      </span>
      <span class="badge badge-cost">{fmtCost(totals.cost_usd)}</span>
    {/if}
  </button>

  {#if expanded}
    <div class="card-body" class:busy>
      <!-- Weekly quota — a standing budget, so it sits above the range tabs -->
      {#if quota && showQuota}
        <div class="quota-bar">
          <div class="quota-info">
            {#if quota.plan}
              <span class="plan-badge">Claude {quota.plan}</span>
            {/if}
            {#if quota.weekly_tokens_limit > 0}
              <span class="quota-value" style="color: {levelColor(quota.weekly_level)}">
                {fmtTokens(quota.weekly_tokens_used)} / {fmtTokens(quota.weekly_tokens_limit)}
                ({quota.weekly_pct}%)
              </span>
            {:else}
              <span class="quota-value">{fmtTokens(quota.weekly_tokens_used)} this week</span>
            {/if}
          </div>
          {#if quota.weekly_tokens_limit > 0}
            <div
              class="quota-track"
              role="progressbar"
              aria-label="Weekly token quota"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(quota.weekly_pct, 100)}
            >
              <div
                class="quota-fill"
                style="width: {Math.min(quota.weekly_pct, 100)}%; background: {levelColor(quota.weekly_level)};"
              ></div>
            </div>
          {/if}
          <div class="quota-meta">
            <span>
              {fmtTokens(quota.tokens_per_hour)}/hr
              {#if quota.velocity_trend !== "stable"}
                <span class="trend" style="color: {trendColor(quota.velocity_trend)}">
                  {trendArrow(quota.velocity_trend)}
                </span>
              {/if}
            </span>
            <span>avg {fmtTokens(quota.daily_avg_tokens)}/day</span>
            <span>{fmtTokens(quota.window_tokens_used)} in {quota.window_hours}h window</span>
          </div>
        </div>
      {/if}

      <!-- Range selector -->
      <div class="range-tabs" role="tablist" aria-label="Token usage range">
        {#each RANGES as r (r.id)}
          <button
            class="range-tab"
            class:active={range === r.id}
            role="tab"
            aria-selected={range === r.id}
            onclick={() => (range = r.id)}
          >{r.label}</button>
        {/each}
      </div>

      {#if error}
        <p class="error">{error}</p>
      {:else if !totals || (totals.total_tokens === 0 && totals.turns === 0)}
        <p class="empty">No token usage recorded {range === "all" ? "yet" : `in this range`}</p>
      {:else}
        <!-- Headline stats for the selected range -->
        <div class="stat-grid">
          <div class="stat">
            <span class="stat-value">{fmtTokens(totals.total_tokens)}</span>
            <span class="stat-label">tokens</span>
          </div>
          <div class="stat">
            <span class="stat-value">{totals.turns.toLocaleString()}</span>
            <span class="stat-label">turns</span>
          </div>
          <div class="stat">
            <span class="stat-value cost">{fmtCost(totals.cost_usd)}</span>
            <span class="stat-label" title="List API rates for each model used, including cache read/write multipliers. Not a bill.">est. cost</span>
          </div>
          <div class="stat">
            <span class="stat-value cache">{cachePct(totals)}%</span>
            <span class="stat-label">cached</span>
          </div>
        </div>

        {#if unpriced > 0}
          <p class="unpriced">
            {fmtTokens(unpriced)} tokens excluded from cost — no published rate for
            {unpricedModels.join(", ") || "an unrecognised model"}.
          </p>
        {/if}

        <!-- Daily series (real data, from the JSONL scan) -->
        <CostChart days={daily} title={range === "day" ? "Today" : "Daily tokens"} />

        <!-- Per-project breakdown, expandable to sessions -->
        <table class="token-table">
          <thead>
            <tr>
              <th>Project</th>
              <th class="right">Tokens</th>
              <th class="right">Turns</th>
              <th class="right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {#each projects as project (project.path)}
              <tr class="project-row">
                <td class="name">
                  <button class="disclose" onclick={() => toggleProject(project.path)}>
                    <span class="chevron sm">{openProjects[project.path] ? "▾" : "▸"}</span>
                    <span class="pname">{project.name}</span>
                    {#if project.sessions.length > 1}
                      <span class="count">{project.sessions.length}</span>
                    {/if}
                  </button>
                </td>
                <td class="right nums">{fmtTokens(project.totals.total_tokens)}</td>
                <td class="right nums">{project.totals.turns.toLocaleString()}</td>
                <td class="right nums">{fmtCost(project.totals.cost_usd)}</td>
              </tr>
              {#if openProjects[project.path]}
                {#each project.sessions as session (session.session_id)}
                  <tr class="sub-row">
                    <td class="sub-name">
                      {shortId(session.session_id)}
                      <span class="ago">{relTime(session.last_modified)}</span>
                    </td>
                    <td class="right nums dim">{fmtTokens(session.totals.total_tokens)}</td>
                    <td class="right nums dim">{session.totals.turns.toLocaleString()}</td>
                    <td class="right nums dim">{fmtCost(session.totals.cost_usd)}</td>
                  </tr>
                {/each}
              {/if}
            {/each}
          </tbody>
        </table>

        <div class="foot">
          <span>{projects.length} project{projects.length !== 1 ? "s" : ""} · {sessionCount} session{sessionCount !== 1 ? "s" : ""}</span>
          {#if summary}<span class="scan">scan {summary.scan_ms}ms</span>{/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .compact-card { padding: 0; overflow: hidden; }

  .card-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    background: none;
    border: none;
    color: var(--text-primary);
    font: inherit;
    cursor: pointer;
    text-align: left;
  }
  .card-header:hover { background: var(--bg-tertiary); }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
  }
  .chevron { font-size: 0.625rem; color: var(--text-muted); width: 0.75rem; }
  .chevron.sm { width: 0.625rem; }

  .label {
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .inline-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    justify-content: flex-end;
  }
  .inline-stat {
    font-size: 0.6875rem;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .unit { color: var(--text-muted); margin-left: 3px; font-size: 0.625rem; }
  .dim { color: var(--text-muted); }
  .err { color: var(--accent-red); font-size: 0.625rem; }

  .badge-cost {
    font-size: 0.625rem;
    font-weight: 600;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    background: rgba(88, 166, 255, 0.12);
    color: var(--accent-blue);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .card-body {
    padding: 0 0.75rem 0.75rem;
    transition: opacity 0.15s ease;
  }
  /* Subtle cue that a refresh is in flight — avoids a layout-shifting spinner */
  .card-body.busy { opacity: 0.72; }

  .error { color: var(--accent-red); font-size: 0.6875rem; }
  .empty { color: var(--text-muted); font-size: 0.6875rem; }

  /* -- Weekly quota ---------------------------------------------------------- */

  .quota-bar {
    padding: 0.5rem 0 0.625rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0.5rem;
  }

  .quota-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .plan-badge {
    font-size: 0.5625rem;
    font-weight: 600;
    padding: 0.0625rem 0.375rem;
    border-radius: 3px;
    background: rgba(139, 92, 246, 0.15);
    color: #a78bfa;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  .quota-value {
    font-size: 0.6875rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    margin-left: auto;
  }

  .quota-track {
    height: 4px;
    background: var(--bg-tertiary);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 0.25rem;
  }

  .quota-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .quota-meta {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.5625rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .trend { font-weight: 700; font-size: 0.625rem; }

  /* -- Range selector -------------------------------------------------------- */

  .range-tabs {
    display: flex;
    gap: 2px;
    padding: 2px;
    margin-bottom: 0.625rem;
    background: var(--bg-tertiary);
    border-radius: 6px;
  }

  .range-tab {
    flex: 1;
    padding: 0.3125rem 0.5rem;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.6875rem;
    font-weight: 500;
    cursor: pointer;
    /* Comfortable touch target on mobile without inflating the card */
    min-height: 30px;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .range-tab:hover { color: var(--text-secondary); }
  .range-tab.active {
    background: var(--bg-primary);
    color: var(--accent-blue);
  }

  /* -- Headline stats -------------------------------------------------------- */

  .stat-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.25rem;
    margin-bottom: 0.5rem;
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    padding: 0.375rem 0.25rem;
    background: var(--bg-tertiary);
    border-radius: 4px;
    min-width: 0;
  }

  .stat-value {
    font-size: 0.8125rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
  }
  .stat-value.cost { color: var(--accent-blue); }

  .unpriced {
    font-size: 0.625rem;
    color: var(--accent-yellow);
    margin: 0.25rem 0 0;
    line-height: 1.4;
  }
  .stat-value.cache { color: var(--accent-green); }

  .stat-label {
    font-size: 0.5625rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  /* -- Breakdown table ------------------------------------------------------- */

  .token-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.6875rem;
    table-layout: fixed;
  }
  .token-table th {
    text-align: left;
    font-size: 0.5625rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0 0.25rem 0.375rem;
  }
  .token-table th:first-child { width: 42%; }
  .token-table td {
    padding: 0.25rem;
    border-top: 1px solid var(--border);
  }
  .right { text-align: right; }
  .nums { font-variant-numeric: tabular-nums; }

  .name { padding: 0 !important; }

  .disclose {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    width: 100%;
    padding: 0.3125rem 0.25rem;
    background: none;
    border: none;
    color: var(--accent-blue);
    font: inherit;
    font-size: 0.6875rem;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
    min-height: 28px;
  }
  .disclose:hover { background: var(--bg-tertiary); }

  .pname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    flex-shrink: 0;
    font-size: 0.5rem;
    font-weight: 600;
    padding: 0 0.25rem;
    border-radius: 999px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
  }

  .sub-row td { border-top: none; padding: 0.125rem 0.25rem; }
  .sub-name {
    font-family: "SF Mono", "Cascadia Code", monospace;
    font-size: 0.5625rem;
    color: var(--text-muted);
    padding-left: 1.25rem !important;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ago { margin-left: 0.25rem; opacity: 0.7; }

  /* -- Footer ---------------------------------------------------------------- */

  .foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.5rem;
    padding-top: 0.375rem;
    border-top: 1px solid var(--border);
    font-size: 0.5625rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .scan { opacity: 0.7; }

  /* Narrow phones: drop the turns column rather than let numbers wrap */
  @media (max-width: 360px) {
    .stat-grid { grid-template-columns: repeat(2, 1fr); }
    .token-table th:nth-child(3),
    .token-table td:nth-child(3) { display: none; }
  }
</style>
