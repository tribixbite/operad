<script lang="ts">
  import { fetchDailyTokens } from "../lib/api";
  import { store } from "../lib/store.svelte";
  import type { DailyTokens } from "../lib/types";

  // -- Reactive state ----------------------------------------------------------

  let days: DailyTokens[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);

  /** Index of the currently hovered bar (-1 = none) */
  let hoverIdx = $state(-1);

  /** Pixel position of tooltip anchor (relative to chart container) */
  let tooltipX = $state(0);
  let tooltipY = $state(0);

  /** Reference to the SVG element for coordinate mapping */
  let svgEl: SVGSVGElement | undefined = $state(undefined);

  // -- Chart geometry ----------------------------------------------------------

  const CHART_H = 140;
  const PAD_TOP = 16;
  const PAD_BOTTOM = 22;
  const PAD_LEFT = 4;
  const PAD_RIGHT = 4;
  /** Fraction of bar slot used for the bar itself (rest is gap) */
  const BAR_RATIO = 0.7;

  // -- Derived values ----------------------------------------------------------

  /** Maximum daily total across all loaded days (for Y scale) */
  const maxTokens = $derived(
    days.length > 0
      ? Math.max(...days.map((d) => d.total_tokens), 1)
      : 1,
  );

  /** 14-day total tokens */
  const totalTokens = $derived(days.reduce((s, d) => s + d.total_tokens, 0));

  /** Quota data from SSE store */
  const quota = $derived(store.daemon?.quota ?? null);

  // -- Data loading ------------------------------------------------------------

  async function load() {
    try {
      days = await fetchDailyTokens(14);
      error = null;
    } catch (e: any) {
      error = e.message ?? "Failed to load token data";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (typeof window === "undefined") return;
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  });

  // -- Helpers -----------------------------------------------------------------

  /** Format a date string as abbreviated day label ("Apr 9") */
  function fmtDate(iso: string): string {
    const d = new Date(iso);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[d.getMonth()]} ${d.getDate()}`;
  }

  /** Format token count with K/M suffix */
  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  }

  /** Compute bar geometry for a given day index within a known viewBox width */
  function barGeom(idx: number, viewW: number) {
    const usableW = viewW - PAD_LEFT - PAD_RIGHT;
    const slotW = usableW / days.length;
    const barW = Math.max(slotW * BAR_RATIO, 2);
    const x = PAD_LEFT + slotW * idx + (slotW - barW) / 2;
    const usableH = CHART_H - PAD_TOP - PAD_BOTTOM;

    const day = days[idx];
    const totalH = (day.total_tokens / maxTokens) * usableH;
    const inputH = (day.input_tokens / maxTokens) * usableH;
    const outputH = (day.output_tokens / maxTokens) * usableH;

    // Stack bottom-up: output, input
    const barBottom = CHART_H - PAD_BOTTOM;
    const outputY = barBottom - outputH;
    const inputY = outputY - inputH;

    return { x, barW, slotW, inputY, inputH, outputY, outputH, totalH, barBottom };
  }

  /** Handle pointer move over the SVG to position tooltip */
  function onPointerMove(e: PointerEvent) {
    if (!svgEl || days.length === 0) return;
    const rect = svgEl.getBoundingClientRect();
    tooltipX = e.clientX - rect.left;
    tooltipY = e.clientY - rect.top;
  }

  /** Map client X to bar index */
  function idxFromEvent(e: PointerEvent | MouseEvent): number {
    if (!svgEl || days.length === 0) return -1;
    const rect = svgEl.getBoundingClientRect();
    const viewW = rect.width;
    const usableW = viewW - PAD_LEFT - PAD_RIGHT;
    const slotW = usableW / days.length;
    const localX = e.clientX - rect.left - PAD_LEFT;
    const idx = Math.floor(localX / slotW);
    if (idx < 0 || idx >= days.length) return -1;
    return idx;
  }

  /** Quota level to CSS color variable */
  function levelColor(level: string): string {
    switch (level) {
      case "ok": return "var(--accent-green)";
      case "warning": return "var(--accent-yellow)";
      case "critical": case "exceeded": return "var(--accent-red)";
      default: return "var(--text-muted)";
    }
  }
</script>

<div class="card cost-chart-card">
  <!-- Quota status bar (if configured) -->
  {#if quota && quota.weekly_tokens_limit > 0}
    <div class="quota-bar">
      <div class="quota-info">
        <span class="quota-label">Weekly Quota</span>
        <span class="quota-value" style="color: {levelColor(quota.weekly_level)}">
          {fmtTokens(quota.weekly_tokens_used)} / {fmtTokens(quota.weekly_tokens_limit)}
          ({quota.weekly_pct}%)
        </span>
      </div>
      <div class="quota-track">
        <div
          class="quota-fill"
          style="width: {Math.min(quota.weekly_pct, 100)}%; background: {levelColor(quota.weekly_level)};"
        ></div>
      </div>
      <div class="quota-meta">
        <span>{fmtTokens(quota.tokens_per_hour)}/hr</span>
        <span>projected: {fmtTokens(quota.projected_weekly_total)}/week</span>
      </div>
    </div>
  {:else if quota}
    <div class="quota-bar">
      <div class="quota-info">
        <span class="quota-label">This Week</span>
        <span class="quota-value">{fmtTokens(quota.weekly_tokens_used)} tokens</span>
      </div>
      <div class="quota-meta">
        <span>{fmtTokens(quota.tokens_per_hour)}/hr</span>
        <span>{fmtTokens(quota.window_tokens_used)} in last {quota.window_hours}h</span>
      </div>
    </div>
  {/if}

  <div class="card-title">
    <span class="label">Daily Tokens</span>
    {#if !loading && days.length > 0}
      <span class="total-badge">
        {fmtTokens(totalTokens)}
        <span class="unit">{days.length}d</span>
      </span>
    {/if}
  </div>

  {#if loading}
    <div class="placeholder">Loading token data...</div>
  {:else if error}
    <div class="placeholder error-msg">{error}</div>
  {:else if days.length === 0}
    <div class="placeholder">No token data available</div>
  {:else}
    <!-- Chart container -->
    <div
      class="chart-container"
      role="img"
      aria-label="Daily token usage stacked bar chart"
    >
      <svg
        bind:this={svgEl}
        viewBox="0 0 600 {CHART_H}"
        preserveAspectRatio="none"
        width="100%"
        height="{CHART_H}px"
        onpointermove={onPointerMove}
        onpointerleave={() => (hoverIdx = -1)}
      >
        <!-- Y-axis grid lines -->
        {#each [0.25, 0.5, 0.75, 1.0] as frac}
          {@const y = CHART_H - PAD_BOTTOM - (CHART_H - PAD_TOP - PAD_BOTTOM) * frac}
          <line
            x1={PAD_LEFT}
            y1={y}
            x2={600 - PAD_RIGHT}
            y2={y}
            stroke="var(--border)"
            stroke-width="0.5"
            stroke-dasharray="3,3"
          />
        {/each}

        <!-- Bars -->
        {#each days as day, i}
          {@const g = barGeom(i, 600)}
          <!-- Hit area -->
          <rect
            x={PAD_LEFT + g.slotW * i}
            y={PAD_TOP}
            width={g.slotW}
            height={CHART_H - PAD_TOP - PAD_BOTTOM}
            fill="transparent"
            onpointerenter={() => (hoverIdx = i)}
            style="cursor: pointer;"
          />
          <!-- Output (bottom) -->
          {#if g.outputH > 0.2}
            <rect
              x={g.x}
              y={g.outputY}
              width={g.barW}
              height={g.outputH}
              rx="1"
              fill="#22c55e"
              opacity={hoverIdx === i ? 1 : 0.85}
            />
          {/if}
          <!-- Input (top) -->
          {#if g.inputH > 0.2}
            <rect
              x={g.x}
              y={g.inputY}
              width={g.barW}
              height={g.inputH}
              rx="1"
              fill="#58a6ff"
              opacity={hoverIdx === i ? 1 : 0.85}
            />
          {/if}
          <!-- Hover outline -->
          {#if hoverIdx === i && g.totalH > 0.2}
            <rect
              x={g.x - 0.5}
              y={g.inputY - 0.5}
              width={g.barW + 1}
              height={g.outputY + g.outputH - g.inputY + 1}
              rx="1.5"
              fill="none"
              stroke="var(--text-secondary)"
              stroke-width="1"
            />
          {/if}
          <!-- X-axis date labels -->
          {#if days.length <= 14 || i % 2 === 0}
            <text
              x={g.x + g.barW / 2}
              y={CHART_H - 4}
              text-anchor="middle"
              fill="var(--text-muted)"
              font-size="9"
              font-family="inherit"
            >
              {fmtDate(day.date)}
            </text>
          {/if}
        {/each}

        <!-- Y-axis max label -->
        <text
          x={PAD_LEFT + 2}
          y={PAD_TOP - 4}
          fill="var(--text-muted)"
          font-size="8"
          font-family="inherit"
        >
          {fmtTokens(maxTokens)}
        </text>
      </svg>

      <!-- Hover tooltip -->
      {#if hoverIdx >= 0 && hoverIdx < days.length}
        {@const day = days[hoverIdx]}
        <div
          class="tooltip"
          style="left: {tooltipX}px; top: {tooltipY}px;"
        >
          <div class="tooltip-date">{fmtDate(day.date)}</div>
          <div class="tooltip-total">{fmtTokens(day.total_tokens)} tokens</div>
          <div class="tooltip-detail">{day.turns} turn{day.turns !== 1 ? "s" : ""}</div>
          <div class="tooltip-breakdown">
            <span class="tb-input">{fmtTokens(day.input_tokens)} in</span>
            <span class="tb-output">{fmtTokens(day.output_tokens)} out</span>
          </div>
        </div>
      {/if}
    </div>

    <!-- Legend -->
    <div class="legend">
      <span class="legend-item"><span class="swatch swatch-input"></span>Input</span>
      <span class="legend-item"><span class="swatch swatch-output"></span>Output</span>
    </div>

    <!-- Top sessions this week -->
    {#if quota && quota.top_sessions.length > 0}
      <div class="breakdown">
        <div class="breakdown-header">
          <span>Top consumers this week</span>
        </div>
        <table class="breakdown-table">
          <thead>
            <tr>
              <th>Session</th>
              <th class="right">Tokens</th>
              <th class="right">%</th>
            </tr>
          </thead>
          <tbody>
            {#each quota.top_sessions as sess}
              <tr>
                <td class="sess-name">{sess.name}</td>
                <td class="right nums">{fmtTokens(sess.tokens)}</td>
                <td class="right nums">{sess.pct}%</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<style>
  .cost-chart-card {
    padding: 0;
    overflow: hidden;
  }

  /* -- Quota bar ------------------------------------------------------------- */

  .quota-bar {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .quota-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.25rem;
  }

  .quota-label {
    font-size: 0.625rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .quota-value {
    font-size: 0.6875rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
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
    font-size: 0.5625rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* -- Card title ------------------------------------------------------------ */

  .card-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.625rem 0.75rem;
  }

  .label {
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .total-badge {
    font-size: 0.625rem;
    font-weight: 600;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    background: rgba(88, 166, 255, 0.12);
    color: var(--accent-blue);
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .total-badge .unit {
    color: var(--text-muted);
    font-size: 0.5625rem;
    font-weight: 400;
  }

  .placeholder {
    padding: 2rem 0.75rem;
    text-align: center;
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .error-msg {
    color: var(--accent-red);
  }

  /* -- Chart area ---------------------------------------------------------- */

  .chart-container {
    position: relative;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    background: var(--bg-primary);
    touch-action: none;
  }

  .chart-container svg {
    display: block;
  }

  /* -- Tooltip ------------------------------------------------------------- */

  .tooltip {
    position: absolute;
    pointer-events: none;
    transform: translate(-50%, -110%);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.375rem 0.5rem;
    font-size: 0.625rem;
    color: var(--text-primary);
    white-space: nowrap;
    z-index: 10;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }

  .tooltip-date {
    font-weight: 600;
    margin-bottom: 2px;
    color: var(--text-secondary);
  }

  .tooltip-total {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .tooltip-detail {
    color: var(--text-muted);
    font-size: 0.5625rem;
  }

  .tooltip-breakdown {
    display: flex;
    gap: 0.375rem;
    margin-top: 2px;
    font-size: 0.5625rem;
    font-variant-numeric: tabular-nums;
  }

  .tb-input { color: #58a6ff; }
  .tb-output { color: #22c55e; }

  /* -- Legend -------------------------------------------------------------- */

  .legend {
    display: flex;
    gap: 0.75rem;
    padding: 0.375rem 0.75rem;
    justify-content: center;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.5625rem;
    color: var(--text-muted);
  }

  .swatch {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }

  .swatch-input { background: #58a6ff; }
  .swatch-output { background: #22c55e; }

  /* -- Per-session breakdown ----------------------------------------------- */

  .breakdown {
    border-top: 1px solid var(--border);
    padding: 0.5rem 0.75rem;
  }

  .breakdown-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 0.375rem;
  }

  .breakdown-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.625rem;
  }

  .breakdown-table th {
    text-align: left;
    font-size: 0.5625rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0 0.25rem 0.25rem;
  }

  .breakdown-table td {
    padding: 0.1875rem 0.25rem;
    border-top: 1px solid var(--border);
  }

  .right { text-align: right; }
  .nums { font-variant-numeric: tabular-nums; }

  .sess-name {
    font-weight: 500;
    color: var(--accent-blue);
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
