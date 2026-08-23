<script lang="ts">
  import type { TokenDayBucket } from "$lib/types";

  // -- Props -------------------------------------------------------------------

  interface Props {
    /** Daily buckets to plot, ascending by date. */
    days: TokenDayBucket[];
    /** Heading shown above the chart. */
    title?: string;
  }

  const { days, title = "Daily tokens" }: Props = $props();

  // -- Reactive state ----------------------------------------------------------

  /** Index of the currently hovered bar (-1 = none) */
  let hoverIdx = $state(-1);

  /** Pixel position of tooltip anchor (relative to chart container) */
  let tooltipX = $state(0);
  let tooltipY = $state(0);

  /** Reference to the SVG element for coordinate mapping */
  let svgEl: SVGSVGElement | undefined = $state(undefined);

  // -- Chart geometry ----------------------------------------------------------

  const VIEW_W = 600;
  const CHART_H = 140;
  const PAD_TOP = 16;
  const PAD_BOTTOM = 22;
  const PAD_LEFT = 4;
  const PAD_RIGHT = 4;
  /** Fraction of a bar slot used by the bar itself (the rest is gap) */
  const BAR_RATIO = 0.7;
  /** Keeps a single-day range from rendering one absurdly wide bar */
  const MAX_BAR_W = 44;

  // -- Derived values ----------------------------------------------------------

  /** Largest daily total, used for the Y scale (never 0, to avoid /0) */
  const maxTokens = $derived(
    days.length > 0 ? Math.max(...days.map((d) => d.total_tokens), 1) : 1,
  );

  const totalTokens = $derived(days.reduce((s, d) => s + d.total_tokens, 0));

  /**
   * Show at most ~8 date labels regardless of range length, so a 60-day
   * all-time view doesn't overlap its own axis.
   */
  const labelStride = $derived(Math.max(1, Math.ceil(days.length / 8)));

  // -- Helpers -----------------------------------------------------------------

  /** Format a `YYYY-MM-DD` key as an abbreviated label ("Apr 9") */
  function fmtDate(key: string): string {
    const [y, m, d] = key.split("-").map(Number);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    if (!m || !d) return key;
    return `${months[m - 1]} ${d}`;
  }

  /** Format token count with K/M/B suffix */
  function fmtTokens(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  }

  /**
   * Bar geometry for one day.
   *
   * The stack is ordered cache-read → cache-write → in+out (bottom to top).
   * Cache reads dominate real usage by an order of magnitude, so plotting
   * them as the base makes the remaining work visible rather than crushing
   * it into a sub-pixel sliver at the bottom of the bar.
   */
  function barGeom(idx: number) {
    const usableW = VIEW_W - PAD_LEFT - PAD_RIGHT;
    const slotW = usableW / days.length;
    // The 2px floor keeps a bar visible on a normal-length range, but it must
    // never exceed the slot: the series is zero-filled now, so an all-time
    // view can run to hundreds of days, and a floor wider than the slot makes
    // neighbouring bars overlap and smear into a solid block.
    const barW = Math.min(Math.max(slotW * BAR_RATIO, Math.min(slotW, 2)), MAX_BAR_W);
    const x = PAD_LEFT + slotW * idx + (slotW - barW) / 2;
    const usableH = CHART_H - PAD_TOP - PAD_BOTTOM;

    const day = days[idx];
    const scale = usableH / maxTokens;
    const cacheReadH = day.cache_read_tokens * scale;
    const cacheWriteH = day.cache_creation_tokens * scale;
    const workH = (day.input_tokens + day.output_tokens) * scale;

    const barBottom = CHART_H - PAD_BOTTOM;
    const cacheReadY = barBottom - cacheReadH;
    const cacheWriteY = cacheReadY - cacheWriteH;
    const workY = cacheWriteY - workH;

    return {
      x, barW, slotW, barBottom,
      cacheReadY, cacheReadH,
      cacheWriteY, cacheWriteH,
      workY, workH,
      totalH: cacheReadH + cacheWriteH + workH,
    };
  }

  /**
   * Track the pointer to position the tooltip and select the hovered bar.
   *
   * Hit-testing is done here from the pointer's x offset rather than with a
   * transparent <rect> per day: it keeps the DOM to three shapes per bar and
   * avoids attaching interaction handlers to individual graphic primitives.
   */
  function onPointerMove(e: PointerEvent) {
    if (!svgEl || days.length === 0) return;
    const rect = svgEl.getBoundingClientRect();
    tooltipX = e.clientX - rect.left;
    tooltipY = e.clientY - rect.top;

    // Map client x → bar index using the rendered (not viewBox) width.
    const usableW = rect.width - PAD_LEFT - PAD_RIGHT;
    if (usableW <= 0) return;
    const slotW = usableW / days.length;
    const idx = Math.floor((e.clientX - rect.left - PAD_LEFT) / slotW);
    hoverIdx = idx >= 0 && idx < days.length ? idx : -1;
  }
</script>

<div class="chart-block">
  <div class="chart-head">
    <span class="label">{title}</span>
    {#if days.length > 0}
      <span class="total-badge">
        {fmtTokens(totalTokens)}
        <span class="unit">{days.length}d</span>
      </span>
    {/if}
  </div>

  {#if days.length === 0}
    <div class="placeholder">No usage recorded in this range</div>
  {:else}
    <div class="chart-container">
      <svg
        bind:this={svgEl}
        role="img"
        aria-label="{title}: stacked token usage by day, {days.length} days, {fmtTokens(totalTokens)} total"
        viewBox="0 0 {VIEW_W} {CHART_H}"
        preserveAspectRatio="none"
        width="100%"
        height="{CHART_H}px"
        onpointermove={onPointerMove}
        onpointerleave={() => (hoverIdx = -1)}
      >
        <!-- Y-axis grid lines -->
        {#each [0.25, 0.5, 0.75, 1.0] as frac (frac)}
          {@const y = CHART_H - PAD_BOTTOM - (CHART_H - PAD_TOP - PAD_BOTTOM) * frac}
          <line
            x1={PAD_LEFT} y1={y} x2={VIEW_W - PAD_RIGHT} y2={y}
            stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,3"
          />
        {/each}

        {#each days as day, i (day.date)}
          {@const g = barGeom(i)}
          {#if g.cacheReadH > 0.2}
            <rect x={g.x} y={g.cacheReadY} width={g.barW} height={g.cacheReadH}
              rx="1" fill="#3b6ea5" opacity={hoverIdx === i ? 1 : 0.85} />
          {/if}
          {#if g.cacheWriteH > 0.2}
            <rect x={g.x} y={g.cacheWriteY} width={g.barW} height={g.cacheWriteH}
              rx="1" fill="#a78bfa" opacity={hoverIdx === i ? 1 : 0.85} />
          {/if}
          {#if g.workH > 0.2}
            <rect x={g.x} y={g.workY} width={g.barW} height={g.workH}
              rx="1" fill="#22c55e" opacity={hoverIdx === i ? 1 : 0.85} />
          {/if}
          {#if hoverIdx === i && g.totalH > 0.2}
            <rect
              x={g.x - 0.5} y={g.workY - 0.5}
              width={g.barW + 1} height={g.totalH + 1}
              rx="1.5" fill="none" stroke="var(--text-secondary)" stroke-width="1"
            />
          {/if}
          {#if i % labelStride === 0}
            <!-- Anchor the edge labels inward so they are not clipped by the
                 viewBox (a centred label on the first/last bar overflows). -->
            {@const isFirst = i === 0}
            {@const isLast = i + labelStride >= days.length}
            {@const anchor = isFirst ? "start" : isLast ? "end" : "middle"}
            <text
              x={isFirst ? PAD_LEFT : isLast ? VIEW_W - PAD_RIGHT : g.x + g.barW / 2}
              y={CHART_H - 4}
              text-anchor={anchor} fill="var(--text-muted)"
              font-size="9" font-family="inherit"
            >{fmtDate(day.date)}</text>
          {/if}
        {/each}

        <text x={PAD_LEFT + 2} y={PAD_TOP - 4} fill="var(--text-muted)" font-size="8" font-family="inherit">
          {fmtTokens(maxTokens)}
        </text>
      </svg>

      {#if hoverIdx >= 0 && hoverIdx < days.length}
        {@const day = days[hoverIdx]}
        <div class="tooltip" style="left: {tooltipX}px; top: {tooltipY}px;">
          <div class="tooltip-date">{fmtDate(day.date)}</div>
          <div class="tooltip-total">{fmtTokens(day.total_tokens)} tokens</div>
          <div class="tooltip-detail">
            {day.turns} turn{day.turns !== 1 ? "s" : ""} · ${day.cost_usd.toFixed(2)}
          </div>
          <div class="tooltip-breakdown">
            <span class="tb-work">{fmtTokens(day.input_tokens + day.output_tokens)} in+out</span>
            <span class="tb-write">{fmtTokens(day.cache_creation_tokens)} write</span>
            <span class="tb-read">{fmtTokens(day.cache_read_tokens)} read</span>
          </div>
        </div>
      {/if}
    </div>

    <div class="legend">
      <span class="legend-item"><span class="swatch swatch-work"></span>In + Out</span>
      <span class="legend-item"><span class="swatch swatch-write"></span>Cache write</span>
      <span class="legend-item"><span class="swatch swatch-read"></span>Cache read</span>
    </div>
  {/if}
</div>

<style>
  .chart-block { margin-bottom: 0.5rem; }

  .chart-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.375rem 0 0.375rem;
  }

  .label {
    font-size: 0.625rem;
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
    padding: 1.25rem 0.75rem;
    text-align: center;
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  /* -- Chart area ---------------------------------------------------------- */

  .chart-container {
    position: relative;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    background: var(--bg-primary);
    touch-action: none;
  }

  .chart-container svg { display: block; }

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
    font-variant-numeric: tabular-nums;
  }

  .tooltip-breakdown {
    display: flex;
    gap: 0.375rem;
    margin-top: 2px;
    font-size: 0.5625rem;
    font-variant-numeric: tabular-nums;
  }

  .tb-work { color: #22c55e; }
  .tb-write { color: #a78bfa; }
  .tb-read { color: #3b6ea5; }

  /* -- Legend -------------------------------------------------------------- */

  .legend {
    display: flex;
    gap: 0.75rem;
    padding: 0.375rem 0;
    justify-content: center;
    flex-wrap: wrap;
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

  .swatch-work { background: #22c55e; }
  .swatch-write { background: #a78bfa; }
  .swatch-read { background: #3b6ea5; }
</style>
