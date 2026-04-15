<script lang="ts">
  import { SseClient, fetchMemory } from "$lib/api";
  import type { DaemonStatus } from "$lib/types";

  /** Per-session RSS row data */
  interface RssRow {
    name: string;
    rss_mb: number;
    activity: string | null;
  }

  let rows: RssRow[] = $state([]);
  let totalRss = $state(0);
  let error: string | null = $state(null);
  let loading = $state(true);

  async function loadTable() {
    try {
      const data = await fetchMemory();
      const sessions = data.sessions
        .filter((s) => s.rss_mb !== null)
        .sort((a, b) => (b.rss_mb ?? 0) - (a.rss_mb ?? 0));

      rows = sessions.map((s) => ({
        name: s.name,
        rss_mb: s.rss_mb ?? 0,
        activity: s.activity,
      }));
      totalRss = rows.reduce((sum, r) => sum + r.rss_mb, 0);
      error = null;
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  function actColor(activity: string | null): string {
    if (activity === "active") return "var(--accent-green)";
    if (activity === "idle") return "var(--accent-yellow)";
    return "var(--text-muted)";
  }

  $effect(() => {
    loadTable();
    const sse = new SseClient();
    sse.on<DaemonStatus>("state", () => loadTable());
    return () => sse.close();
  });
</script>

{#if loading}
  <p class="text-xs" style="color: var(--text-muted)">Loading...</p>
{:else if error}
  <p class="text-xs" style="color: var(--accent-red)">Error: {error}</p>
{:else if rows.length === 0}
  <p class="text-xs" style="color: var(--text-muted)">No session memory data</p>
{:else}
  <table class="w-full text-sm">
    <thead>
      <tr class="text-left text-xs" style="color: var(--text-muted)">
        <th class="pb-2 pr-4">Session</th>
        <th class="pb-2 pr-4">RSS</th>
        <th class="pb-2">Activity</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.name)}
        <tr style="border-top: 1px solid var(--border)">
          <td class="py-1.5 pr-4">{row.name}</td>
          <td class="py-1.5 pr-4" style="color: var(--text-secondary)">{row.rss_mb}MB</td>
          <td class="py-1.5" style="color: {actColor(row.activity)}">{row.activity ?? "-"}</td>
        </tr>
      {/each}
      <tr style="border-top: 1px solid var(--border)">
        <td class="py-1.5 pr-4 font-medium" style="color: var(--text-muted)">Total</td>
        <td class="py-1.5 pr-4 font-medium" style="color: var(--text-secondary)">{totalRss}MB</td>
        <td></td>
      </tr>
    </tbody>
  </table>
{/if}
