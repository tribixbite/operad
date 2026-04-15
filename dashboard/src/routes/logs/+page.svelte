<script lang="ts">
  import LogViewer from "$lib/components/LogViewer.svelte";
</script>

<svelte:head>
  <title>Logs | operad</title>
</svelte:head>

<div class="card">
  <h2 class="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-3">Daemon Logs</h2>
  <LogViewer />
</div>
