<script lang="ts">
  import {
    startSession, stopSession, restartSession, goSession,
    openTab, closeSession, suspendSession, resumeSession,
    fetchSdkStatus, launchApp, forceCleanupSession, setSessionAutostart,
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
  /** Bound Claude session_id for the drawer — disambiguates same-path sessions */
  let drawerSessionId: string | null = $state(null);
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

  /** Inactive sort mode — chronological keeps recent activity first; alphabetical sorts by name. */
  type InactiveSort = "chrono" | "alpha";
  let inactiveSort: InactiveSort = $state("chrono");

  /** Active sessions sorted alphabetically (small set; chronological isn't useful here). */
  const activeSessions = $derived(
    filteredSessions.filter((s) => ACTIVE_STATUSES.has(s.status)).sort((a, b) => a.name.localeCompare(b.name))
  );

  /**
   * Inactive sort key — chronological prefers uptime_start (last running window)
   * then last_health_check. Newer first. Sessions with no timestamps fall to the
   * bottom of the chronological view but stay sorted by name within that bucket.
   */
  function chronoKey(s: SessionState): number {
    const t = s.uptime_start ?? s.last_health_check;
    return t ? Date.parse(t) : 0;
  }

  function sortInactive(arr: SessionState[]): SessionState[] {
    if (inactiveSort === "alpha") {
      return [...arr].sort((a, b) => a.name.localeCompare(b.name));
    }
    return [...arr].sort((a, b) => {
      const diff = chronoKey(b) - chronoKey(a);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
  }

  /**
   * Inactive sessions split into Registered (config-defined) and Ad-hoc
   * (discovered or transient). Registered always renders first. The wire
   * field `from_config` is added by session-commands.ts; older daemons may
   * omit it, in which case everything falls into the Ad-hoc bucket.
   */
  const inactiveAll = $derived(filteredSessions.filter((s) => !ACTIVE_STATUSES.has(s.status)));
  const registeredInactive = $derived(sortInactive(inactiveAll.filter((s) => s.from_config === true)));
  const adhocInactive = $derived(sortInactive(inactiveAll.filter((s) => s.from_config !== true)));
  const inactiveTotal = $derived(registeredInactive.length + adhocInactive.length);

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

  /**
   * Click handler for the session-name button.
   *
   * Sessions with a `launch_package` (e.g. x2d → com.termux.x11, the
   * BambuStudio GUI surfaced through the termux-x11 viewer) get the
   * viewer launched on tap — the user's intent is "show me the screen
   * for this session", not "open a Termux tab" (those sessions are
   * bare and have no tmux pane to switch to anyway).
   *
   * Everything else (claude/opencode/codex tmux sessions) keeps the
   * existing behaviour: open a Termux tab attached to the tmux pane.
   */
  async function handleOpenTab(e: Event, name: string, launchPackage: string | null | undefined) {
    e.stopPropagation();
    if (launchPackage) {
      // Bring the viewer activity to the foreground via the same code
      // path the dedicated 🚀 launch icon uses. ADB monkey preferred,
      // am start -n fallback — see android-engine.launchApp.
      try {
        await launchApp(launchPackage);
      } catch (err) {
        actionError = `Launch ${launchPackage} failed: ${(err as Error).message}`;
      }
      return;
    }
    try {
      await openTab(name);
    } catch (err) {
      actionError = `Open tab failed for ${name}: ${(err as Error).message}`;
    }
  }

  /**
   * Launch the Android app associated with a session (e.g. termux-x11
   * viewer). The package comes from the session's TOML `launch_package`
   * — backend resolves it to an actual launcher activity via ADB monkey
   * with a fallback to `am start -n <pkg>/.MainActivity`.
   */
  async function handleLaunchApp(e: Event, name: string, target: string) {
    e.stopPropagation();
    actionError = null;
    try {
      await launchApp(target);
    } catch (err) {
      actionError = `Launch ${target} failed for ${name}: ${(err as Error).message}`;
    }
  }

  /**
   * Force-kill any orphan processes left over from a crashed bare
   * service. Confirms first because pkill -9 can be destructive — but
   * the wider sweep is the whole point: tracked-PID stop can't reach
   * orphans whose parent died with the X server.
   */
  async function handleForceCleanup(e: Event, name: string) {
    e.stopPropagation();
    if (!confirm(`Force-kill all orphan processes for '${name}'? This may also affect related apps still running on the same display (e.g. BambuStudio if cleaning up termux-x11).`)) return;
    actionError = null;
    try {
      const result = await forceCleanupSession(name);
      const totals = result.sweep.filter(s => s.killed > 0).map(s => `${s.pattern}: ${s.killed}`).join(", ");
      actionError = result.total_killed > 0
        ? `Cleaned up ${result.total_killed} process${result.total_killed === 1 ? "" : "es"} (${totals})`
        : "No orphan processes found";
      await refreshStatus();
    } catch (err) {
      actionError = `Cleanup failed for ${name}: ${(err as Error).message}`;
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

  /**
   * Toggle a session's ⭐ autostart pin. Optimistic — flips the local
   * flag immediately, persists via REST, and reverts on failure. The
   * persisted pin makes the session auto-boot (or not) on the next daemon
   * start, giving the user an explicit handle on the autostart set rather
   * than guessing from recency.
   */
  async function handleToggleAutostart(e: Event, session: SessionState) {
    e.stopPropagation();
    actionError = null;
    const next = !session.autostart;
    try {
      await setSessionAutostart(session.name, next);
      await refreshStatus();
    } catch (err) {
      actionError = `Autostart toggle failed for ${session.name}: ${(err as Error).message}`;
    }
  }

  function openDrawer(e: Event, session: SessionState) {
    e.stopPropagation();
    drawerSession = session.name;
    // Pass the session's bound Claude session_id (when known) so the
    // drawer opens THIS session's conversation rather than the project's
    // most-recent one — the fix for two same-path sessions colliding.
    drawerSessionId = session.session_id ?? null;
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
      <!--
        Inner flex wrapper. The flex layout lives here, NOT on the <td>:
        a `display:flex` table-cell drops out of the table's row-height
        sync and its collapsed border-top renders at a different y than
        the sibling cells, stepping the horizontal separator. Keeping the
        <td> a real table-cell (vertical-align:middle) keeps every row's
        separator a single straight line.
      -->
      <div class="name-wrap">
        <span class="dot {dotCls(session.status, session.suspended)}"></span>
        <button
          class="session-name"
          onclick={(e) => handleOpenTab(e, session.name, session.launch_package)}
          title={session.launch_package
            ? `Show ${session.name} on screen (launches ${session.launch_package})`
            : "Open in Termux tab"}
        >{session.name}</button>
        <!--
          Runtime badge — only shown for non-claude agents so the row stays
          uncluttered on the dominant case. session.type is one of
          claude / opencode / codex / daemon / service; we hide it for
          claude (default) and for daemon/service (which aren't agent
          runtimes, the user already knows from the lack of a chat icon).
        -->
        {#if session.type === "opencode" || session.type === "codex"}
          <span class="runtime-badge {session.type}" title={`${session.type} runtime`}>{session.type}</span>
        {/if}
        {#if session.claude_status === "waiting"}
          <span class="claude-badge waiting" title="Waiting for input">idle</span>
        {:else if session.claude_status === "working"}
          <span class="claude-badge working" title="Actively working">busy</span>
        {/if}
        <!--
          Autostart pin (⭐). Lives at the right edge of the name cell —
          NOT in the action cluster — so the lifecycle buttons (stop /
          restart / go / pause …) stay on a single line instead of
          wrapping. Filled = this session auto-boots; outline = it won't.
          Persisted, so it's the explicit handle on "which projects start
          themselves".
        -->
        <button
          class="star-pin"
          class:pinned={session.autostart}
          onclick={(e) => handleToggleAutostart(e, session)}
          title={session.autostart ? "Autostart on (tap to unpin)" : "Autostart off (tap to pin)"}
          aria-label={session.autostart ? "Unpin from autostart" : "Pin to autostart"}
          aria-pressed={session.autostart}
        >{session.autostart ? "★" : "☆"}</button>
      </div>
    </td>
    <td class="td-rss">
      {#if session.rss_mb != null}
        {session.rss_mb}<span class="unit">MB</span>
      {/if}
    </td>
    <td class="td-actions" onclick={(e) => e.stopPropagation()}>
      <div class="actions-wrap">
      {#if session.launch_package}
        <button
          class="btn-icon launch"
          onclick={(e) => handleLaunchApp(e, session.name, session.launch_package!)}
          title={`Launch app (${session.launch_package})`}
          aria-label="Launch associated Android app"
        ><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2H14V7"/><path d="M14 2L8 8"/><path d="M13 9V13.5C13 13.78 12.78 14 12.5 14H2.5C2.22 14 2 13.78 2 13.5V3.5C2 3.22 2.22 3 2.5 3H7"/></svg></button>
      {/if}
      {#if session.type === "claude"}
        {#if sdkStatus?.attached && sdkStatus.sessionName === session.name}
          <span class="live-badge" title="SDK stream active"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="13" r="1.5" fill="currentColor" stroke="none"/><path d="M5 10.5a3.5 3 0 0 1 6 0"/><path d="M2.5 7.5a6 5 0 0 1 11 0"/></svg></span>
        {/if}
        <button class="btn-icon chat" onclick={(e) => openDrawer(e, session)} title="Conversation"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3H14V11H9L6 14V11H2Z"/></svg></button>
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
        <!--
          "Cleave broken" — force-kill orphan processes for this session.
          The motivating case: termux-x11 dies but BambuStudio is left
          orphaned spinning CPU, reparented to init. Normal stop only
          touches tracked PIDs; this hits every keyword pattern the
          daemon knows for the session's command (see
          session-commands.cmdForceCleanup), so reparented orphans
          finally get reaped.
        -->
        <button
          class="btn-icon danger"
          onclick={(e) => handleForceCleanup(e, session.name)}
          title="Force-kill orphan processes for this session"
          aria-label="Force cleanup"
        ><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12L7 8L3 4"/><path d="M9 12L13 8L9 4"/></svg></button>
        <button class="btn-icon danger" onclick={(e) => handleClose(e, session.name)} title="Remove"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4L12 12M12 4L4 12"/></svg></button>
      {/if}
      </div>
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

      <!-- Collapsed inactive group, split into Registered / Ad-hoc subsections -->
      {#if inactiveTotal > 0}
        <tr class="inactive-divider" onclick={() => (showInactive = !showInactive)}>
          <td colspan="3">
            <span class="inactive-toggle">{showInactive ? "\u25BC" : "\u25B6"}</span>
            <span class="inactive-label">Inactive</span>
            <span class="inactive-count">{inactiveTotal}</span>
            {#if showInactive}
              <span class="sort-controls" onclick={(e) => e.stopPropagation()} role="group" aria-label="Inactive sort">
                <button
                  class="sort-btn"
                  class:sort-active={inactiveSort === "chrono"}
                  onclick={() => (inactiveSort = "chrono")}
                  title="Sort by recent activity (uptime_start desc)"
                >recent</button>
                <button
                  class="sort-btn"
                  class:sort-active={inactiveSort === "alpha"}
                  onclick={() => (inactiveSort = "alpha")}
                  title="Sort alphabetically"
                >a–z</button>
              </span>
            {/if}
          </td>
        </tr>
        {#if showInactive}
          {#if registeredInactive.length > 0}
            <tr class="subgroup-divider">
              <td colspan="3">
                <span class="subgroup-label">Registered</span>
                <span class="subgroup-count">{registeredInactive.length}</span>
                <span class="subgroup-hint">defined in operad.toml</span>
              </td>
            </tr>
            {#each registeredInactive as session (session.name)}
              {@render sessionRow(session)}
            {/each}
          {/if}
          {#if adhocInactive.length > 0}
            <tr class="subgroup-divider">
              <td colspan="3">
                <span class="subgroup-label">Ad-hoc</span>
                <span class="subgroup-count">{adhocInactive.length}</span>
                <span class="subgroup-hint">discovered / transient</span>
              </td>
            </tr>
            {#each adhocInactive as session (session.name)}
              {@render sessionRow(session)}
            {/each}
          {/if}
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
    initialSessionId={drawerSessionId}
    onclose={() => { drawerSession = null; drawerSessionId = null; }}
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
    /*
     * Lock column widths to the th hints. With the default `auto`
     * algorithm, a wide child of the expanded-row td (colspan=3, hosts
     * ScriptRunner with long monospaced commands) grows ALL three
     * columns proportionally — pushing every row's action cell past
     * the viewport edge and clipping the rightmost play button.
     * `fixed` layout forces the table to honour 100 % of its parent
     * and the declared th widths; content inside cells then wraps or
     * gets clipped by per-cell `overflow-x: hidden`, never the table.
     */
    table-layout: fixed;
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
  /*
   * Column widths — must add to ≤100 % of the table for `table-layout:
   * fixed` to leave the name column some breathing room. At mobile
   * (14 px html font), 4.5 rem = 63 px (4 char-wide RSS + unit) and
   * 8.5 rem = 119 px (5 × 21 px buttons + 4 × 3.5 px gap). Total non-
   * name = 182 px → on a 360-css-px viewport that leaves ~150 px for
   * the session name + dot + badge, which fits the longest configured
   * names with ellipsis.
   */
  .th-rss { text-align: right; width: 4.5rem; }
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
  .sort-controls {
    margin-left: 0.5rem;
    display: inline-flex;
    gap: 2px;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }
  .sort-btn {
    background: var(--bg-secondary);
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font: inherit;
    font-size: 0.625rem;
    padding: 0.125rem 0.4375rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    transition: background 0.15s, color 0.15s;
  }
  .sort-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .sort-btn.sort-active {
    background: var(--accent-blue);
    color: #fff;
  }

  .subgroup-divider td {
    padding: 0.25rem 0.375rem 0.25rem 1.625rem;
    border-top: 1px dashed var(--border);
    color: var(--text-muted);
    font-size: 0.625rem;
    background: var(--bg-secondary);
  }
  .subgroup-label {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .subgroup-count {
    margin-left: 0.25rem;
    background: var(--bg-tertiary);
    border-radius: 9999px;
    padding: 0.0625rem 0.375rem;
  }
  .subgroup-hint {
    margin-left: 0.5rem;
    color: var(--text-muted);
    font-style: italic;
  }
  .session-row td {
    padding: 0.5rem 0.375rem;
    border-top: 1px solid var(--border);
    vertical-align: middle;
  }
  .td-name {
    /* Real table-cell (not flex) so its collapsed border-top stays on the
     * same baseline as the RSS/actions cells. Flex lives on .name-wrap. */
    vertical-align: middle;
  }
  .name-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
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
    /* Stays a real table-cell; the flex row lives on .actions-wrap so the
     * cell's border-top aligns with the other columns. */
    vertical-align: middle;
  }
  .actions-wrap {
    /*
     * Display the action buttons as a flex row that wraps when too
     * many icons crowd the cell — crucial on phone viewports where 6
     * 44 px tap targets exceed the column's 8.5 rem column hint and
     * used to clip past the table's right edge. Wrapping below the
     * primary actions keeps every tap target reachable without
     * forcing horizontal scroll.
     */
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.25rem;
    align-items: center;
  }
  /* Drop the legacy margin-left now that gap handles spacing. */
  .actions-wrap :global(.btn-icon) { margin-left: 0; }
  .td-expand {
    padding: 0.25rem 0.375rem 0.75rem;
    border-top: none;
    max-height: 70vh;
    overflow-y: auto;
    /*
     * Hard-cap horizontal overflow. Without this, a long pane-output
     * line, file-explorer entry, or unwrapped error string forces the
     * whole table into horizontal scroll on phone viewports — which
     * makes the header-row action buttons look clipped at the right.
     * Children that genuinely need scroll (FileExplorer's grid) declare
     * their own overflow-x:auto, which still works under the parent cap.
     */
    max-width: 100%;
    overflow-x: hidden;
    box-sizing: border-box;
  }
  /* Force every direct child of the expand cell to stay inside the cell
   * width. Scoped via :global() because Svelte component CSS is scoped
   * to the component by default and these are children rendered by
   * other components (ScriptRunner, FileExplorer, etc). */
  .td-expand :global(> *) {
    max-width: 100%;
    box-sizing: border-box;
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
  /* Allow the name to shrink/ellipsize so the trailing ★ pin stays in view. */
  .name-wrap .session-name { min-width: 0; flex-shrink: 1; }
  /*
   * Runtime badge — inline tag identifying non-claude agents. Hidden
   * on the default claude case so the row stays uncluttered. Per-
   * runtime accent colours pick up the landing page's branding.
   */
  .runtime-badge {
    font-size: 0.5625rem;
    padding: 0.0625rem 0.3125rem;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-left: 0.25rem;
    font-weight: 500;
    line-height: 1.2;
    flex-shrink: 0;
  }
  .runtime-badge.opencode {
    color: var(--accent-purple);
    background: rgba(188, 140, 255, 0.12);
    border: 1px solid rgba(188, 140, 255, 0.3);
  }
  .runtime-badge.codex {
    color: var(--accent-cyan, #22d3ee);
    background: rgba(34, 211, 238, 0.12);
    border: 1px solid rgba(34, 211, 238, 0.3);
  }
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
  /* Launch-app button — shown for sessions with a launch_package */
  .td-actions :global(.btn-icon.launch) { color: var(--accent-cyan, #58a6ff); opacity: 0.75; }
  .td-actions :global(.btn-icon.launch:hover) { opacity: 1; background: rgba(88, 166, 255, 0.12); }
  /* Muted button for pause */
  .td-actions :global(.btn-icon.muted) { color: var(--text-muted); }
  .td-actions :global(.btn-icon.muted:hover) { background: rgba(255, 255, 255, 0.08); }
  /*
   * Autostart pin (★) — sits at the right edge of the name cell
   * (margin-left:auto pushes it past the name/badges, just left of the
   * RSS column). Keeping it out of the action cluster is what stops the
   * lifecycle buttons wrapping to a second line.
   */
  .star-pin {
    margin-left: auto;
    flex-shrink: 0;
    width: 1.5rem;
    height: 1.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    background: none;
    border-radius: 4px;
    color: var(--text-muted);
    opacity: 0.55;
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.15s, opacity 0.15s, background 0.15s;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  .star-pin:hover { opacity: 1; color: var(--accent-yellow); background: rgba(210, 153, 34, 0.12); }
  .star-pin.pinned { color: var(--accent-yellow); opacity: 1; }

  /* Mobile compact */
  @media (max-width: 768px) {
    /*
     * Mobile session row — restored to the pre-touch-target-bump
     * single-line layout that the user preferred. With ~21 px buttons
     * (1.5 rem at 14 px html font, set in app.css's 768 px rule), all
     * 5 actions plus name + RSS fit comfortably in one row at 411 px
     * viewport.
     *
     * The earlier table-layout-fixed / 2-line-grid experiments tried
     * to "fix" alignment that wasn't actually broken at this button
     * size — they were fixing a problem the larger 36/44 px buttons
     * created. Kept simple now: tighter font sizes, narrower actions
     * column hint, and let the table flow naturally.
     */
    .session-table { font-size: 0.6875rem; }
    thead th { font-size: 0.5625rem; padding: 0 0.25rem 0.375rem; }
    /*
     * Mobile column hints. 5 × 21 px buttons + 4 × 2 px gap
     * (`.td-actions` gap tightened to 0.125 rem on mobile below) +
     * 8 px cell padding = 121 px. Pad to 124 px so a 6th button (e.g.
     * launch_package) wraps cleanly. Combined with the global
     * .card overflow guard, the table can no longer push past the
     * viewport — earlier 140 px setting was 1 px over because the
     * name column also had room to grow.
     */
    .th-rss { width: 3rem; }
    .th-actions { width: 124px; }
    .actions-wrap { gap: 0.125rem; }
    .session-row td { padding: 0.375rem 0.25rem; }
    .session-name { font-size: 0.6875rem; }
    .td-rss { font-size: 0.625rem; }
    .td-name { gap: 0.375rem; }
    .claude-badge { font-size: 0.5rem; padding: 0.0625rem 0.25rem; }
    .pane-output { font-size: 0.5625rem; max-height: 3.5rem; padding: 0.25rem 0.375rem; }
  }
</style>
