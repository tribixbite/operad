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
  <h2 class="section-heading">Sessions</h2>
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

  /* Consistent section heading for overview cards */
  .section-heading {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0 0 0.75rem;
    line-height: 1;
  }
</style>
