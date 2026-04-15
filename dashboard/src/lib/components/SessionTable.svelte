<script lang="ts">
  import {
    startSession, stopSession, restartSession, goSession,
    openTab, closeSession, suspendSession, resumeSession,
    fetchSdkStatus,
  } from "$lib/api";
  import { store, refreshStatus } from "$lib/store.svelte";
  import type { DaemonStatus, SessionState, SdkBridgeStatus } from "$lib/types";
  import SessionCard from "./SessionCard.svelte";
  import ScriptRunner from "./ScriptRunner.svelte";
  import SessionTimeline from "./SessionTimeline.svelte";
  import ConversationDrawer from "./ConversationDrawer.svelte";
  import GitPanel from "./GitPanel.svelte";
  import FileExplorer from "./FileExplorer.svelte";

  let expandedSession: string | null = $state(null);
  let actionError: string | null = $state(null);
  /** Session name for the conversation drawer (null = closed) */
  let drawerSession: string | null = $state(null);
  /** Search filter for sessions */
  let sessionFilter = $state("");
  /** SDK bridge status (which session is LIVE) */
  let sdkStatus: SdkBridgeStatus | null = $state(null);

  /** Poll SDK status periodically */
  $effect(() => {
    if (typeof window === "undefined") return;
    const load = async () => {
      try { sdkStatus = await fetchSdkStatus(); } catch { /* ignore */ }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  });

  /** Derived from shared store — no own SSE/fetch needed */
  const status = $derived<DaemonStatus | null>(store.daemon);
  const error = $derived<string | null>(store.error);
  /** Non-service sessions only — services go to ServiceStatus card */
  const allSessions = $derived(status?.sessions.filter((s) => s.type !== "service") ?? []);

  /** Active = running/degraded/starting/waiting/stopping */
  const ACTIVE_STATUSES = new Set(["running", "degraded", "starting", "waiting", "stopping"]);

  /** Apply search filter then split into active/inactive */
  const filteredSessions = $derived.by(() => {
    if (!sessionFilter) return allSessions;
    const q = sessionFilter.toLowerCase();
    return allSessions.filter((s) => s.name.toLowerCase().includes(q));
  });

  /** Sorted: active sessions first (by name), then inactive (by name) */
  const activeSessions = $derived(
    filteredSessions.filter((s) => ACTIVE_STATUSES.has(s.status)).sort((a, b) => a.name.localeCompare(b.name))
  );
  const inactiveSessions = $derived(
    filteredSessions.filter((s) => !ACTIVE_STATUSES.has(s.status)).sort((a, b) => a.name.localeCompare(b.name))
  );

  /** Only show search when there are enough sessions to warrant filtering */
  const showSearch = $derived(allSessions.length > 5);

  /** Whether the inactive group is expanded */
  let showInactive: boolean = $state(false);

  /** Status dot color class */
  function dotCls(st: string, suspended: boolean): string {
    if (suspended) return "dot-cyan";
    switch (st) {
      case "running": return "dot-green";
      case "degraded": return "dot-yellow";
      case "starting": case "waiting": return "dot-blue";
      case "failed": return "dot-red";
      default: return "dot-dim";
    }
  }

  function toggleExpand(name: string) {
    expandedSession = expandedSession === name ? null : name;
  }

  async function handleAction(e: Event, action: string, name: string) {
    e.stopPropagation();
    actionError = null;
    try {
      switch (action) {
        case "start": await startSession(name); break;
        case "stop": await stopSession(name); break;
        case "restart": await restartSession(name); break;
        case "go": await goSession(name); break;
      }
      await refreshStatus();
    } catch (err) {
      actionError = `${action} failed for ${name}: ${(err as Error).message}`;
    }
  }

  async function handleOpenTab(e: Event, name: string) {
    e.stopPropagation();
    try {
      await openTab(name);
    } catch (err) {
      actionError = `Open tab failed for ${name}: ${(err as Error).message}`;
    }
  }

  async function handleSuspend(e: Event, name: string) {
    e.stopPropagation();
    actionError = null;
    try {
      await suspendSession(name);
      await refreshStatus();
    } catch (err) {
      actionError = `Suspend failed for ${name}: ${(err as Error).message}`;
    }
  }

  async function handleResume(e: Event, name: string) {
    e.stopPropagation();
    actionError = null;
    try {
      await resumeSession(name);
      await refreshStatus();
    } catch (err) {
      actionError = `Resume failed for ${name}: ${(err as Error).message}`;
    }
  }

  async function handleClose(e: Event, name: string) {
    e.stopPropagation();
    actionError = null;
    try {
      await closeSession(name);
      await refreshStatus();
    } catch (err) {
      actionError = `Close failed for ${name}: ${(err as Error).message}`;
    }
  }

  function openDrawer(e: Event, name: string) {
    e.stopPropagation();
    drawerSession = name;
  }

  /** Lock body scroll when drawer is open to prevent background scrolling */
  $effect(() => {
    if (drawerSession) {
      document.body.classList.add("drawer-open");
    } else {
      document.body.classList.remove("drawer-open");
    }
    return () => document.body.classList.remove("drawer-open");
  });
</script>

{#snippet sessionRow(session: SessionState)}
  <tr class="session-row" onclick={() => toggleExpand(session.name)}>
    <td class="td-name">
      <span class="dot {dotCls(session.status, session.suspended)}"></span>
      <button
        class="session-name"
        onclick={(e) => handleOpenTab(e, session.name)}
        title="Open in Termux tab"
      >{session.name}</button>
      {#if session.claude_status === "waiting"}
        <span class="claude-badge waiting" title="Waiting for input">idle</span>
      {:else if session.claude_status === "working"}
        <span class="claude-badge working" title="Actively working">busy</span>
      {/if}
    </td>
    <td class="td-rss">
      {#if session.rss_mb != null}
        {session.rss_mb}<span class="unit">MB</span>
      {/if}
    </td>
    <td class="td-actions" onclick={(e) => e.stopPropagation()}>
      {#if session.type === "claude"}
        {#if sdkStatus?.attached && sdkStatus.sessionName === session.name}
          <span class="live-badge" title="SDK stream active"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="13" r="1.5" fill="currentColor" stroke="none"/><path d="M5 10.5a3.5 3 0 0 1 6 0"/><path d="M2.5 7.5a6 5 0 0 1 11 0"/></svg></span>
        {/if}
        <button class="btn-icon chat" onclick={(e) => openDrawer(e, session.name)} title="Conversation"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3H14V11H9L6 14V11H2Z"/></svg></button>
      {/if}
      {#if session.status === "running" || session.status === "degraded"}
        <button class="btn-icon danger" onclick={(e) => handleAction(e, "stop", session.name)} title="Stop"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg></button>
        <button class="btn-icon" onclick={(e) => handleAction(e, "restart", session.name)} title="Restart"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8A5.5 5.5 0 0 1 12 3.5M13.5 8A5.5 5.5 0 0 1 4 12.5"/><path d="M12 1V4H9M4 15V12H7"/></svg></button>
        {#if session.suspended}
          <button class="btn-icon success" onclick={(e) => handleResume(e, session.name)} title="Resume"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5L13 8L4 13.5Z"/></svg></button>
        {:else}
          <button class="btn-icon success" onclick={(e) => handleAction(e, "go", session.name)} title="Go"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5L13 8L4 13.5Z"/></svg></button>
          <button class="btn-icon muted" onclick={(e) => handleSuspend(e, session.name)} title="Pause"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2.5" width="3.5" height="11" rx="1"/><rect x="9.5" y="2.5" width="3.5" height="11" rx="1"/></svg></button>
        {/if}
      {:else if session.status === "starting" || session.status === "waiting" || session.status === "stopping"}
        <button class="btn-icon danger" onclick={(e) => handleAction(e, "stop", session.name)} title="Stop"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg></button>
      {:else if session.status === "stopped" || session.status === "failed" || session.status === "pending"}
        <button class="btn-icon primary" onclick={(e) => handleAction(e, "start", session.name)} title="Start"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5L13 8L4 13.5Z"/></svg></button>
        <button class="btn-icon danger" onclick={(e) => handleClose(e, session.name)} title="Remove"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4L12 12M12 4L4 12"/></svg></button>
      {/if}
    </td>
  </tr>
  {#if expandedSession === session.name}
    <tr><td colspan="3" class="td-expand">
      {#if session.last_output}
        <pre class="pane-output">{session.last_output}</pre>
      {/if}
      {#if session.path}
        <ScriptRunner sessionName={session.name} sessionPath={session.path} />
      {/if}
      <SessionCard {session} />
      {#if session.type === "claude"}
        <SessionTimeline sessionName={session.name} />
      {/if}
      {#if session.path}
        <GitPanel sessionName={session.name} />
        <FileExplorer sessionName={session.name} />
      {/if}
    </td></tr>
  {/if}
{/snippet}

{#if error}
  <div class="card border-[var(--accent-red)]">
    <p class="text-[var(--accent-red)] text-sm">Failed to connect: {error}</p>
  </div>
{/if}

{#if actionError}
  <div class="card mb-2" style="border: 1px solid var(--accent-red); padding: 0.5rem 0.75rem">
    <p class="text-xs" style="color: var(--accent-red)">{actionError}</p>
  </div>
{/if}

{#if status}
  {#if showSearch}
    <input
      type="text"
      class="session-search"
      placeholder="Filter sessions..."
      bind:value={sessionFilter}
    />
  {/if}
  <table class="session-table">
    <thead>
      <tr>
        <th class="th-name">Session</th>
        <th class="th-rss">RSS</th>
        <th class="th-actions"></th>
      </tr>
    </thead>
    <tbody>
      {#each activeSessions as session (session.name)}
        {@render sessionRow(session)}
      {/each}

      <!-- Collapsed inactive group -->
      {#if inactiveSessions.length > 0}
        <tr class="inactive-divider" onclick={() => (showInactive = !showInactive)}>
          <td colspan="3">
            <span class="inactive-toggle">{showInactive ? "\u25BC" : "\u25B6"}</span>
            <span class="inactive-label">Inactive</span>
            <span class="inactive-count">{inactiveSessions.length}</span>
          </td>
        </tr>
        {#if showInactive}
          {#each inactiveSessions as session (session.name)}
            {@render sessionRow(session)}
          {/each}
        {/if}
      {/if}
    </tbody>
  </table>
{:else if !error}
  <p class="text-[var(--text-muted)] text-sm">Loading...</p>
{/if}

{#if drawerSession}
  <ConversationDrawer
    sessionName={drawerSession}
    onclose={() => drawerSession = null}
  />
{/if}

<style>
  .session-search {
    width: 100%;
    padding: 0.375rem 0.5rem;
    margin-bottom: 0.5rem;
    font-size: 0.75rem;
    font-family: inherit;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    outline: none;
  }
  .session-search::placeholder { color: var(--text-muted); }
  .session-search:focus { border-color: var(--accent-blue); }

  .session-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }
  thead th {
    text-align: left;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0 0.375rem 0.5rem;
  }
  .th-rss { text-align: right; }
  .th-actions { text-align: right; width: 8.5rem; }
  .session-row {
    cursor: pointer;
    transition: background 0.15s;
  }
  .session-row:hover { background: var(--bg-tertiary); }

  .inactive-divider {
    cursor: pointer;
    transition: background 0.15s;
  }
  .inactive-divider:hover { background: var(--bg-tertiary); }
  .inactive-divider td {
    padding: 0.375rem 0.375rem;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.7rem;
  }
  .inactive-toggle {
    display: inline-block;
    width: 1rem;
    text-align: center;
    font-size: 0.6rem;
  }
  .inactive-label {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
  }
  .inactive-count {
    margin-left: 0.25rem;
    background: var(--bg-tertiary);
    border-radius: 9999px;
    padding: 0.0625rem 0.375rem;
    font-size: 0.625rem;
  }
  .session-row td {
    padding: 0.5rem 0.375rem;
    border-top: 1px solid var(--border);
    vertical-align: middle;
  }
  .td-name {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .td-rss {
    text-align: right;
    color: var(--text-secondary);
    font-size: 0.75rem;
    white-space: nowrap;
    /* Prevent width jitter when RSS numbers change (e.g. 96 -> 267 -> 1249) */
    font-variant-numeric: tabular-nums;
    min-width: 4.5rem;
  }
  .unit { color: var(--text-muted); margin-left: 1px; }
  .td-actions {
    text-align: right;
    white-space: nowrap;
  }
  .td-actions :global(.btn-icon) {
    margin-left: 0.25rem;
  }
  .td-expand {
    padding: 0.25rem 0.375rem 0.75rem;
    border-top: none;
    max-height: 70vh;
    overflow-y: auto;
  }
  .session-name {
    font-weight: 600;
    font-size: 0.8125rem;
    color: var(--accent-blue);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: inherit;
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .session-name:hover { text-decoration: underline; }
  .session-name:active { color: var(--accent-purple); }
  /* Claude status badge */
  .claude-badge {
    font-size: 0.5625rem;
    font-weight: 600;
    padding: 0.0625rem 0.3125rem;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }
  .claude-badge.waiting {
    color: var(--accent-yellow);
    background: rgba(245, 158, 11, 0.15);
  }
  .claude-badge.working {
    color: var(--accent-green);
    background: rgba(34, 197, 94, 0.15);
  }
  /* Pane output preview */
  .pane-output {
    font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
    font-size: 0.625rem;
    line-height: 1.4;
    color: var(--text-muted);
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.375rem 0.5rem;
    margin: 0 0 0.5rem;
    white-space: pre-wrap;
    word-break: break-all;
    min-height: 2.5rem;
    max-height: 4.5rem;
    overflow: hidden;
    /* Prevent layout shift when content updates */
    contain: layout style;
  }
  /* LIVE badge — SDK stream indicator (broadcast icon) */
  .live-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.125rem;
    color: var(--text-primary);
    vertical-align: middle;
    opacity: 0.8;
  }
  .live-badge svg { display: block; }
  /* Chat button */
  .td-actions :global(.btn-icon.chat) { color: var(--accent-blue); opacity: 0.6; }
  .td-actions :global(.btn-icon.chat:hover) { opacity: 1; background: rgba(88, 166, 255, 0.1); }
  /* Muted button for pause */
  .td-actions :global(.btn-icon.muted) { color: var(--text-muted); }
  .td-actions :global(.btn-icon.muted:hover) { background: rgba(255, 255, 255, 0.08); }

  /* Mobile compact */
  @media (max-width: 768px) {
    .session-table { font-size: 0.6875rem; }
    thead th { font-size: 0.5625rem; padding: 0 0.25rem 0.375rem; }
    .th-actions { width: 6rem; }
    .session-row td { padding: 0.375rem 0.25rem; }
    .session-name { font-size: 0.6875rem; }
    .td-rss { font-size: 0.625rem; }
    .td-name { gap: 0.375rem; }
    .claude-badge { font-size: 0.5rem; padding: 0.0625rem 0.25rem; }
    .pane-output { font-size: 0.5625rem; max-height: 3.5rem; padding: 0.25rem 0.375rem; }
  }
</style>
