<script lang="ts">
  /**
   * SessionCard — compact stats row inside the expanded session detail.
   *
   * Trimmed down from the original PID/Restarts/Health/Activity/RSS/
   * Started/Error grid. Everything that's already visible in the
   * SessionTable row header (RSS badge, activity dot colour, restart
   * count via badge state) is no longer duplicated here. PID was
   * always "-" because tmux_pid is null on this state path.
   *
   * Remaining fields: last health check (status + age), uptime_start,
   * and the last_error string (only when present, so the row stays
   * visually quiet for healthy sessions).
   */
  import type { SessionState } from "$lib/types";

  interface Props {
    session: SessionState;
  }

  let { session }: Props = $props();

  function formatStarted(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const now = new Date();
    // Same-day: just the time. Older: month/day + time so users can
    // tell if a "running" session is actually a stale state from days ago.
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return d.toLocaleTimeString();
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString()}`;
  }

  function relativeTime(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso).getTime();
    if (Number.isNaN(d)) return "";
    const diff = Date.now() - d;
    const sec = Math.floor(diff / 1000);
    if (sec < 30) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }
</script>

<div class="session-card-compact">
  <dl>
    <dt>Health</dt>
    <dd>
      {#if session.last_health_check}
        {#if session.consecutive_failures > 0}
          <span class="bad">{session.consecutive_failures} failures</span>
        {:else}
          <span class="good">ok</span>
        {/if}
        <span class="muted">· {relativeTime(session.last_health_check)}</span>
      {:else}
        <span class="muted">never checked</span>
      {/if}
    </dd>

    <dt>Started</dt>
    <dd>{formatStarted(session.uptime_start)}</dd>

    {#if session.last_error}
      <dt>Error</dt>
      <dd class="error">{session.last_error}</dd>
    {/if}
  </dl>
</div>

<style>
  .session-card-compact {
    /*
     * Tight margins (was m-2 ml-6) — the wide left indent caused
     * horizontal overflow on phone viewports because the parent
     * .td-expand has its own padding. Keep the indent visual via a
     * left border instead of margin.
     */
    margin: 0.375rem 0;
    padding: 0.375rem 0.625rem;
    border-left: 2px solid var(--border);
    background: var(--bg-tertiary);
    border-radius: 4px;
    font-size: 0.75rem;
    /* Prevent any descendant from forcing horizontal scroll on the
     * expanded row (long error strings, mostly). */
    max-width: 100%;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.125rem 0.625rem;
    margin: 0;
  }
  dt {
    color: var(--text-muted);
    font-size: 0.6875rem;
  }
  dd {
    margin: 0;
    color: var(--text-primary);
  }
  .good { color: var(--accent-green); }
  .bad { color: var(--accent-red); }
  .muted { color: var(--text-muted); font-size: 0.6875rem; }
  .error {
    color: var(--accent-red);
    font-family: ui-monospace, "Cascadia Code", "Fira Code", monospace;
    font-size: 0.6875rem;
  }
</style>
