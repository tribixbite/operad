<script lang="ts">
  import { fetchSwitchboard, updateSwitchboard } from "$lib/api";
  import { connect, on, send, wsState } from "$lib/ws.svelte";
  import type { Switchboard } from "$lib/types";

  // -- State ------------------------------------------------------------------

  let sw: Switchboard | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);

  /** OODA cycle status pushed via WS */
  let oodaRunning = $state(false);
  let oodaLastRun: string | null = $state(null);
  let oodaLastCost: number | null = $state(null);

  /** Active agent runs tracked via WS */
  let activeRuns: Record<string, { status: string; cost?: number; error?: string }> = $state({});

  /** Agent names known from switchboard */
  let agentNames = $derived(sw ? Object.keys(sw.agents) : []);

  // -- Subsystem descriptors for rendering ------------------------------------

  interface SubsystemDef {
    key: keyof Switchboard;
    label: string;
    description: string;
  }

  const subsystems: SubsystemDef[] = [
    { key: "sdkBridge",       label: "SDK Bridge",       description: "Claude Agent SDK streaming and session management" },
    { key: "cognitive",       label: "Cognitive Timer",   description: "Periodic OODA trigger condition checks (60s interval)" },
    { key: "oodaAutoTrigger", label: "OODA Auto-Trigger", description: "Automatic master controller runs when conditions met" },
    { key: "memoryInjection", label: "Memory Injection",  description: "Inject project memories into SDK queries" },
    { key: "mindMeld",        label: "Mind Meld",         description: "Inject user profile/personality into OODA prompts" },
  ];

  // -- Load initial state via REST, then stream updates via WS ----------------

  async function loadInitial() {
    loading = true;
    error = null;
    try {
      sw = await fetchSwitchboard();
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  // Connect WS and subscribe to switchboard events
  $effect(() => {
    loadInitial();
    connect();

    // Stream switchboard state updates
    const offSw = on("switchboard_update", (msg) => {
      const { type: _, ...rest } = msg;
      sw = rest as unknown as Switchboard;
    });

    // Stream OODA cycle status
    const offOoda = on("ooda_status", (msg) => {
      oodaRunning = !!msg.running;
      if (msg.lastRun) oodaLastRun = msg.lastRun as string;
      if (msg.cost != null) oodaLastCost = msg.cost as number;
      if (msg.error) error = msg.error as string;
    });

    // Stream agent run updates
    const offRun = on("agent_run_update", (msg) => {
      const name = msg.agentName as string;
      if (name) {
        activeRuns[name] = {
          status: msg.status as string,
          cost: msg.cost as number | undefined,
          error: msg.error as string | undefined,
        };
      }
    });

    return () => { offSw(); offOoda(); offRun(); };
  });

  // -- Toggle handlers --------------------------------------------------------

  async function toggleAll() {
    if (!sw) return;
    try {
      sw = await updateSwitchboard({ all: !sw.all });
    } catch (e) {
      error = String(e);
    }
  }

  async function toggleSubsystem(key: keyof Switchboard) {
    if (!sw) return;
    try {
      sw = await updateSwitchboard({ [key]: !sw[key] } as Partial<Switchboard>);
    } catch (e) {
      error = String(e);
    }
  }

  async function toggleAgent(name: string) {
    if (!sw) return;
    const current = sw.agents[name] !== false;
    try {
      sw = await updateSwitchboard({ agents: { ...sw.agents, [name]: !current } });
    } catch (e) {
      error = String(e);
    }
  }

  /** Check if a subsystem is effectively enabled (respects master switch) */
  function isEffective(key: keyof Switchboard): boolean {
    if (!sw) return false;
    if (!sw.all) return false;
    return !!sw[key];
  }

  /** Check if an agent is effectively enabled */
  function isAgentEffective(name: string): boolean {
    if (!sw) return false;
    if (!sw.all) return false;
    return sw.agents[name] !== false;
  }
</script>

<div class="switchboard">
  {#if loading}
    <div class="loading">Loading switchboard...</div>
  {:else if error && !sw}
    <div class="error-msg">{error}</div>
  {:else if sw}
    <!-- Master switch -->
    <div class="master-row">
      <button class="master-toggle" class:on={sw.all} onclick={toggleAll}>
        <span class="toggle-indicator" class:on={sw.all}>{sw.all ? "ON" : "OFF"}</span>
        <span class="master-label">All Systems</span>
      </button>
      <span class="master-hint">Master kill-switch for all autonomous subsystems</span>
    </div>

    {#if error}
      <div class="error-msg">{error}</div>
    {/if}

    <!-- Subsystems -->
    <div class="section-title">Subsystems</div>
    <div class="toggle-grid">
      {#each subsystems as sub}
        <div class="toggle-row" class:disabled={!sw.all}>
          <button
            class="toggle-btn"
            class:on={isEffective(sub.key)}
            disabled={!sw.all}
            onclick={() => toggleSubsystem(sub.key)}
          >
            <span class="toggle-dot" class:on={isEffective(sub.key)}></span>
          </button>
          <div class="toggle-info">
            <span class="toggle-label">{sub.label}</span>
            <span class="toggle-desc">{sub.description}</span>
          </div>
          {#if sub.key === "oodaAutoTrigger" && oodaRunning}
            <span class="status-badge running">running</span>
          {:else if sub.key === "oodaAutoTrigger" && oodaLastRun}
            <span class="status-badge idle" title="Last: {oodaLastRun}">
              {oodaLastCost != null ? `$${oodaLastCost.toFixed(4)}` : "idle"}
            </span>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Agents -->
    {#if agentNames.length > 0}
      <div class="section-title">Agents</div>
      <div class="toggle-grid">
        {#each agentNames as name}
          <div class="toggle-row" class:disabled={!sw.all}>
            <button
              class="toggle-btn"
              class:on={isAgentEffective(name)}
              disabled={!sw.all}
              onclick={() => toggleAgent(name)}
            >
              <span class="toggle-dot" class:on={isAgentEffective(name)}></span>
            </button>
            <div class="toggle-info">
              <span class="toggle-label">{name}</span>
              {#if activeRuns[name]}
                <span class="toggle-desc status-{activeRuns[name].status}">
                  {activeRuns[name].status}
                  {#if activeRuns[name].cost != null}
                    — ${activeRuns[name].cost!.toFixed(4)}
                  {/if}
                  {#if activeRuns[name].error}
                    — {activeRuns[name].error}
                  {/if}
                </span>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- WS connection indicator -->
    <div class="ws-status">
      <span class="ws-dot" class:connected={wsState.status === "connected"}></span>
      <span class="ws-label">WS {wsState.status}</span>
    </div>
  {/if}
</div>

<style>
  .switchboard {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .loading, .error-msg {
    font-size: 0.75rem;
    padding: 0.5rem;
  }
  .loading { color: var(--text-muted); text-align: center; }
  .error-msg { color: var(--accent-red); }

  /* Master toggle */
  .master-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-secondary);
  }
  .master-toggle {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--text-primary);
    font-size: 1rem;
    font-weight: 600;
  }
  .toggle-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 3rem;
    height: 1.5rem;
    border-radius: 0.75rem;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    transition: all 0.2s;
    background: rgba(239, 68, 68, 0.25);
    color: #ef4444;
  }
  .toggle-indicator.on {
    background: rgba(34, 197, 94, 0.25);
    color: #22c55e;
  }
  .master-label { font-size: 0.9rem; }
  .master-hint { font-size: 0.65rem; color: var(--text-muted); }

  /* Section titles */
  .section-title {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 0.25rem;
  }

  /* Toggle grid */
  .toggle-grid {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.25rem;
    border-radius: 6px;
    transition: opacity 0.15s;
  }
  .toggle-row:hover { background: var(--bg-hover); }
  .toggle-row.disabled { opacity: 0.4; }

  /* Toggle button */
  .toggle-btn {
    flex-shrink: 0;
    width: 2rem;
    height: 1.125rem;
    border-radius: 0.5625rem;
    border: none;
    padding: 0.125rem;
    cursor: pointer;
    background: rgba(100, 116, 139, 0.3);
    transition: background 0.2s;
    display: flex;
    align-items: center;
  }
  .toggle-btn.on { background: rgba(34, 197, 94, 0.4); }
  .toggle-btn:disabled { cursor: not-allowed; }

  .toggle-dot {
    width: 0.875rem;
    height: 0.875rem;
    border-radius: 50%;
    background: var(--text-muted);
    transition: all 0.2s;
    transform: translateX(0);
  }
  .toggle-dot.on {
    background: #22c55e;
    transform: translateX(0.875rem);
  }

  .toggle-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
    flex: 1;
  }
  .toggle-label {
    font-size: 0.75rem;
    color: var(--text-primary);
    font-weight: 500;
  }
  .toggle-desc {
    font-size: 0.6rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Status badges */
  .status-badge {
    flex-shrink: 0;
    font-size: 0.55rem;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .status-badge.running {
    background: rgba(96, 165, 250, 0.2);
    color: #60a5fa;
    animation: pulse 1.5s ease-in-out infinite;
  }
  .status-badge.idle {
    background: rgba(100, 116, 139, 0.2);
    color: #94a3b8;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* Agent run status colors */
  .status-running { color: var(--accent-blue); }
  .status-completed { color: var(--accent-green); }
  .status-failed { color: var(--accent-red); }

  /* WS status */
  .ws-status {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--border);
  }
  .ws-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    background: var(--accent-red);
    transition: background 0.3s;
  }
  .ws-dot.connected { background: var(--accent-green); }
  .ws-label { font-size: 0.6rem; color: var(--text-muted); }
</style>
