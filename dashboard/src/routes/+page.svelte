<script lang="ts">
  import SessionTable from "$lib/components/SessionTable.svelte";
  import MemoryGauge from "$lib/components/MemoryGauge.svelte";
  import BudgetGauge from "$lib/components/BudgetGauge.svelte";
  import BridgeStatus from "$lib/components/BridgeStatus.svelte";
  import AdbStatus from "$lib/components/AdbStatus.svelte";
  import ServiceStatus from "$lib/components/ServiceStatus.svelte";
  import TokenSummary from "$lib/components/TokenSummary.svelte";
  import RecentSessions from "$lib/components/RecentSessions.svelte";
  import PromptLibrary from "$lib/components/PromptLibrary.svelte";
</script>

<svelte:head>
  <title>operad dashboard</title>
</svelte:head>

<!-- Compact status cards -->
<div class="status-strip">
  <MemoryGauge />
  <BudgetGauge />
  <TokenSummary />
  <BridgeStatus />
  <AdbStatus />
  <ServiceStatus />
</div>

<!-- Session table -->
<div class="card mb-4">
  <h2 class="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-3">Sessions</h2>
  <SessionTable />
</div>

<!-- Prompt library -->
<PromptLibrary />

<!-- Recent projects from history -->
<RecentSessions />

<style>
  .status-strip {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-bottom: 0.75rem;
  }
</style>
