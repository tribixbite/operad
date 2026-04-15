<script lang="ts">
  import MemoryGauge from "$lib/components/MemoryGauge.svelte";
  import ProcessManager from "$lib/components/ProcessManager.svelte";
  import MemoryPanel from "$lib/components/MemoryPanel.svelte";
  import RssTable from "$lib/components/RssTable.svelte";
</script>

<svelte:head>
  <title>Memory | operad</title>
</svelte:head>

<div class="mb-4">
  <MemoryGauge />
</div>

<!-- Per-session RSS table -->
<div class="card mb-4" id="session-memory">
  <h2 class="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-3">Session Memory</h2>
  <RssTable />
</div>

<!-- AI persistent memory (cross-session, SQLite + FTS5) -->
<div class="card mb-4">
  <MemoryPanel />
</div>

<!-- Android app process manager -->
<ProcessManager />
