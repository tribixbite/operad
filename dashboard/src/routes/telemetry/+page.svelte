<script lang="ts">
  import TelemetryViewer from "$lib/components/TelemetryViewer.svelte";
</script>

<svelte:head>
  <title>Telemetry | operad</title>
</svelte:head>

<div class="card">
  <h2 class="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-3">Telemetry Sink</h2>
  <TelemetryViewer />
</div>
