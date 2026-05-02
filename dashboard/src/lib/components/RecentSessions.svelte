<script lang="ts">
  import { fetchRecent, openSession, registerProjects, cloneRepo, createProject, dedupeSessions } from "$lib/api";
  import { refreshStatus } from "$lib/store.svelte";
  import { copyToClipboard } from "$lib/format";
  import type { RecentProject, DedupeResult } from "$lib/types";

  let expanded = $state(false);
  let projects = $state<RecentProject[]>([]);
  let search = $state("");
  let loading = $state(false);
  let error = $state<string | null>(null);
  let actionMsg = $state<string | null>(null);

  /** Which inline form is active */
  let activeForm = $state<"clone" | "create" | null>(null);
  let formValue = $state("");
  let formBusy = $state(false);

  /**
   * Two-step dedupe state: clicking the button runs a dry-run and stashes the
   * preview here; the user then either Apply (commit) or dismisses.
   */
  let dedupePlan = $state<DedupeResult | null>(null);
  let dedupeBusy = $state(false);

  /** Relative time string (e.g. "2h ago", "3d ago") */
  function timeAgo(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  /**
   * Absolute calendar date — "May 2", "Apr 26", "2025-12-04" if last year.
   * Pairs with the relative timeAgo so every row shows both at a glance.
   */
  function shortDate(iso: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const now = new Date();
    if (d.getFullYear() !== now.getFullYear()) return d.toISOString().slice(0, 10);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  /** Truncate path for display */
  function shortPath(path: string): string {
    const home = "/data/data/com.termux/files/home/";
    if (path.startsWith(home)) return "~/" + path.slice(home.length);
    return path;
  }

  /** Status badge color */
  function statusCls(st: RecentProject["status"]): string {
    switch (st) {
      case "running": return "badge-green";
      case "registered": return "badge-blue";
      case "config": return "badge-purple";
      default: return "badge-dim";
    }
  }

  /** Filter projects by search term */
  const filtered = $derived(
    projects.filter((p) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
    })
  );

  async function loadRecent() {
    loading = true;
    error = null;
    try {
      projects = await fetchRecent();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function handleOpen(e: Event, project: RecentProject) {
    e.stopPropagation();
    actionMsg = null;
    try {
      await openSession(project.path);
      actionMsg = `Starting ${project.name}...`;
      await refreshStatus();
      await loadRecent();
    } catch (err) {
      actionMsg = `Failed: ${(err as Error).message}`;
    }
  }

  /**
   * Copy the Claude session_id to the clipboard so the user can resume the
   * conversation manually with `claude --resume <id>`. Falls back to showing
   * the id inline when the project has no session_id recorded yet.
   */
  async function handleCopyId(e: Event, project: RecentProject) {
    e.stopPropagation();
    const id = project.session_id;
    if (!id) {
      actionMsg = `${project.name}: no session_id recorded yet`;
      return;
    }
    const ok = await copyToClipboard(id);
    actionMsg = ok ? `Copied session_id ${id.slice(0, 8)}…` : `Copy failed (${id})`;
  }

  /**
   * Spawn an additional instance of an already-tracked project.
   *
   * The default Open button reuses an existing session for the same path; this
   * handler explicitly opts into multi-instance creation (daemon registers a
   * fresh `<name>-N` entry alongside the running one).
   */
  async function handleOpenNew(e: Event, project: RecentProject) {
    e.stopPropagation();
    actionMsg = null;
    try {
      await openSession(project.path, { forceNew: true });
      actionMsg = `Spawning new instance of ${project.name}...`;
      await refreshStatus();
      await loadRecent();
    } catch (err) {
      actionMsg = `Failed: ${(err as Error).message}`;
    }
  }

  /**
   * Step 1 of dedupe: ask the daemon for a dry-run plan and stash it for
   * preview. Showing the plan before mutating state lets the user spot
   * unexpected removals (e.g. a project they actually wanted under a
   * non-canonical name).
   */
  async function handleDedupePreview() {
    actionMsg = null;
    dedupeBusy = true;
    try {
      const plan = await dedupeSessions({ dryRun: true });
      dedupePlan = plan;
      if (plan.groups_with_duplicates === 0) {
        actionMsg = "No duplicates found";
        dedupePlan = null;
      }
    } catch (err) {
      actionMsg = `Dedupe preview failed: ${(err as Error).message}`;
    } finally {
      dedupeBusy = false;
    }
  }

  /** Step 2 of dedupe: commit the previewed plan. */
  async function handleDedupeApply() {
    if (!dedupePlan) return;
    dedupeBusy = true;
    try {
      const applied = await dedupeSessions();
      actionMsg = `Removed ${applied.removed_total} duplicate entr${applied.removed_total === 1 ? "y" : "ies"}` +
        (applied.conflict_total > 0 ? ` (${applied.conflict_total} live conflict${applied.conflict_total === 1 ? "" : "s"} preserved)` : "");
      dedupePlan = null;
      await refreshStatus();
      await loadRecent();
    } catch (err) {
      actionMsg = `Dedupe failed: ${(err as Error).message}`;
    } finally {
      dedupeBusy = false;
    }
  }

  function dismissDedupe() {
    dedupePlan = null;
  }

  async function handleScan() {
    actionMsg = null;
    formBusy = true;
    const prevCount = projects.length;
    try {
      const result = await registerProjects();
      await loadRecent();
      const newCount = projects.length - prevCount;
      if (result.registered.length > 0) {
        actionMsg = `Registered ${result.registered.length} new project${result.registered.length === 1 ? "" : "s"}`;
        if (result.skipped > 0) actionMsg += ` (${result.skipped} already known)`;
      } else {
        actionMsg = "No new projects found";
        if (result.skipped > 0) actionMsg += ` (${result.skipped} already registered)`;
      }
    } catch (err) {
      actionMsg = `Scan failed: ${(err as Error).message}`;
    } finally {
      formBusy = false;
    }
  }

  async function handleFormSubmit() {
    if (!formValue.trim()) return;
    formBusy = true;
    actionMsg = null;
    try {
      if (activeForm === "clone") {
        const result = await cloneRepo(formValue.trim());
        actionMsg = `Cloned → ${result.name}`;
      } else if (activeForm === "create") {
        const result = await createProject(formValue.trim());
        actionMsg = `Created → ${result.name}`;
      }
      formValue = "";
      activeForm = null;
      await loadRecent();
    } catch (err) {
      actionMsg = `Failed: ${(err as Error).message}`;
    } finally {
      formBusy = false;
    }
  }

  function toggleForm(type: "clone" | "create") {
    if (activeForm === type) {
      activeForm = null;
      formValue = "";
    } else {
      activeForm = type;
      formValue = "";
    }
  }

  function toggle() {
    expanded = !expanded;
    if (expanded && projects.length === 0) {
      loadRecent();
    }
  }
</script>

<div class="card mb-4">
  <button class="panel-header" onclick={toggle}>
    <h2 class="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide">
      Recent Projects
    </h2>
    <span class="chevron" class:open={expanded}><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" stroke="none"><path d="M6 3L12 8L6 13Z"/></svg></span>
  </button>

  {#if expanded}
    <div class="panel-body">
      <!-- Action bar: Scan / Clone / New / Dedupe -->
      <div class="action-bar">
        <button class="btn btn-sm" onclick={handleScan} disabled={formBusy} title="Scan ~/git and register all projects">
          Scan
        </button>
        <button class="btn btn-sm" class:active={activeForm === "clone"} onclick={() => toggleForm("clone")} title="Clone a git repo">
          Clone
        </button>
        <button class="btn btn-sm" class:active={activeForm === "create"} onclick={() => toggleForm("create")} title="Create new project">
          New
        </button>
        <button
          class="btn btn-sm"
          onclick={handleDedupePreview}
          disabled={dedupeBusy || !!dedupePlan}
          title="Preview cleanup of duplicate registry entries that share a path"
        >Dedupe</button>
      </div>

      <!-- Inline form for clone/create -->
      {#if activeForm}
        <form class="inline-form" onsubmit={(e) => { e.preventDefault(); handleFormSubmit(); }}>
          <input
            type="text"
            class="search-input"
            placeholder={activeForm === "clone" ? "https://github.com/user/repo" : "project-name"}
            bind:value={formValue}
            disabled={formBusy}
          />
          <button class="btn btn-sm btn-primary" type="submit" disabled={formBusy || !formValue.trim()}>
            {activeForm === "clone" ? "Clone" : "Create"}
          </button>
        </form>
      {/if}

      {#if dedupePlan}
        <div class="dedupe-preview">
          <div class="dedupe-summary">
            <strong>Dedupe preview:</strong>
            {dedupePlan.removed_total} entr{dedupePlan.removed_total === 1 ? "y" : "ies"} to remove
            {#if dedupePlan.conflict_total > 0}
              · {dedupePlan.conflict_total} live conflict{dedupePlan.conflict_total === 1 ? "" : "s"} (kept)
            {/if}
            across {dedupePlan.groups_with_duplicates} project{dedupePlan.groups_with_duplicates === 1 ? "" : "s"}
          </div>
          <ul class="dedupe-list">
            {#each dedupePlan.plans as plan (plan.path)}
              <li>
                <div class="dedupe-path">{shortPath(plan.path)}</div>
                <div class="dedupe-detail">
                  <span class="dedupe-keep">keep <code>{plan.kept}</code></span>
                  <span class="dedupe-reason">— {plan.kept_reason}</span>
                </div>
                {#if plan.removed.length > 0}
                  <div class="dedupe-detail">
                    <span class="dedupe-remove">remove</span>
                    {#each plan.removed as r (r)}
                      <code class="dedupe-name">{r}</code>
                    {/each}
                  </div>
                {/if}
                {#if plan.conflicts.length > 0}
                  <div class="dedupe-detail">
                    <span class="dedupe-conflict">live (kept)</span>
                    {#each plan.conflicts as c (c)}
                      <code class="dedupe-name dedupe-name-conflict">{c}</code>
                    {/each}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
          <div class="dedupe-actions">
            <button class="btn btn-sm" onclick={dismissDedupe} disabled={dedupeBusy}>Cancel</button>
            <button
              class="btn btn-sm btn-primary"
              onclick={handleDedupeApply}
              disabled={dedupeBusy || dedupePlan.removed_total === 0}
            >Apply</button>
          </div>
        </div>
      {/if}

      {#if actionMsg}
        <div class="action-msg">{actionMsg}</div>
      {/if}

      <input
        type="text"
        class="search-input"
        placeholder="Filter by name or path..."
        bind:value={search}
      />

      {#if loading}
        <p class="text-xs text-[var(--text-muted)] mt-2">Loading...</p>
      {:else if error}
        <p class="text-xs text-[var(--accent-red)] mt-2">{error}</p>
      {:else if filtered.length === 0}
        <p class="text-xs text-[var(--text-muted)] mt-2">No recent projects found</p>
      {:else}
        <div class="recent-list">
          {#each filtered as project (project.path + project.session_id)}
            <div class="recent-item">
              <div class="recent-info">
                <span class="recent-name">{project.name}</span>
                <span class="badge {statusCls(project.status)}">{project.status}</span>
                <span
                  class="recent-date"
                  title={new Date(project.last_active).toISOString()}
                >{shortDate(project.last_active)}</span>
                <span class="recent-time">· {timeAgo(project.last_active)}</span>
              </div>
              <div class="recent-path">{shortPath(project.path)}</div>
              <div class="recent-actions">
                <button
                  class="btn-icon muted"
                  onclick={(e) => handleCopyId(e, project)}
                  title={project.session_id ? `Copy session_id (${project.session_id})` : "No session_id yet"}
                  aria-label="Copy session_id"
                  disabled={!project.session_id}
                ><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" stroke="none"><path d="M4.75 1A1.75 1.75 0 0 0 3 2.75v8.5A1.75 1.75 0 0 0 4.75 13H6v1.25A1.75 1.75 0 0 0 7.75 16h6A1.75 1.75 0 0 0 15.5 14.25v-8.5A1.75 1.75 0 0 0 13.75 4H12.5V2.75A1.75 1.75 0 0 0 10.75 1zM4.5 2.75A.25.25 0 0 1 4.75 2.5h6A.25.25 0 0 1 11 2.75v8.5a.25.25 0 0 1-.25.25H4.75a.25.25 0 0 1-.25-.25zM12.5 5.5h1.25a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25h-6a.25.25 0 0 1-.25-.25V13h3A1.75 1.75 0 0 0 12.5 11.25z"/></svg></button>
                {#if project.status !== "running"}
                  <button
                    class="btn-icon primary"
                    onclick={(e) => handleOpen(e, project)}
                    title="Open session (reuses existing entry for this path)"
                  ><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" stroke="none"><path d="M4 2.5L13 8L4 13.5Z"/></svg></button>
                {:else}
                  <span class="dot dot-green"></span>
                {/if}
                {#if project.status === "running" || project.status === "registered" || project.status === "config"}
                  <button
                    class="btn-icon"
                    onclick={(e) => handleOpenNew(e, project)}
                    title="Open another instance (registers a parallel session)"
                    aria-label="Open another instance"
                  ><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" stroke="none"><path d="M8.5 1.5h-1V7H2v1h5.5v5.5h1V8H14V7H8.5z"/></svg></button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: inherit;
    color: inherit;
  }
  .chevron {
    font-size: 0.75rem;
    color: var(--text-muted);
    transition: transform 0.15s;
  }
  .chevron.open { transform: rotate(90deg); }
  .panel-body { margin-top: 0.75rem; }

  .action-bar {
    display: flex;
    gap: 0.375rem;
    margin-bottom: 0.5rem;
  }
  .action-bar :global(.btn.active) {
    border-color: var(--accent-blue);
    color: var(--accent-blue);
  }

  .inline-form {
    display: flex;
    gap: 0.375rem;
    margin-bottom: 0.5rem;
  }
  .inline-form .search-input { flex: 1; }

  .search-input {
    width: 100%;
    padding: 0.375rem 0.5rem;
    font-size: 0.75rem;
    font-family: inherit;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    outline: none;
  }
  .search-input::placeholder { color: var(--text-muted); }
  .search-input:focus { border-color: var(--accent-blue); }

  .dedupe-preview {
    margin: 0.5rem 0;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-tertiary);
    font-size: 0.6875rem;
  }
  .dedupe-summary {
    color: var(--text-primary);
    margin-bottom: 0.5rem;
  }
  .dedupe-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 18rem;
    overflow-y: auto;
  }
  .dedupe-list li {
    border-left: 2px solid var(--border);
    padding-left: 0.5rem;
  }
  .dedupe-path {
    font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
    color: var(--text-secondary);
    margin-bottom: 0.125rem;
  }
  .dedupe-detail {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    align-items: baseline;
    margin-top: 0.125rem;
    color: var(--text-muted);
  }
  .dedupe-keep { color: var(--accent-green); font-weight: 600; }
  .dedupe-remove { color: var(--accent-red); font-weight: 600; }
  .dedupe-conflict { color: var(--accent-amber, #d29922); font-weight: 600; }
  .dedupe-reason { font-style: italic; }
  .dedupe-name {
    font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    padding: 0 0.25rem;
    border-radius: 3px;
    color: var(--text-primary);
  }
  .dedupe-name-conflict { border-color: var(--accent-amber, #d29922); }
  .dedupe-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.375rem;
    margin-top: 0.5rem;
  }

  .recent-list {
    margin-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .recent-item {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    gap: 0 0.5rem;
    /* Increased py: was 0.375rem — minimum py-2 for touch */
    padding: 0.5rem 0.25rem;
    border-top: 1px solid var(--border);
    align-items: center;
  }
  .recent-info {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
  }
  .recent-name {
    font-weight: 600;
    /* Bumped from 0.75rem */
    font-size: 0.8125rem;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .recent-time {
    /* Bumped from 0.625rem */
    font-size: 0.6875rem;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .recent-date {
    font-size: 0.6875rem;
    color: var(--text-secondary);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .btn-icon.muted {
    color: var(--text-muted);
  }
  .btn-icon.muted:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .recent-path {
    /* Bumped from 0.625rem; mono for paths */
    font-size: 0.6875rem;
    font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
    color: var(--text-muted);
    grid-column: 1;
    grid-row: 2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .recent-actions {
    grid-column: 2;
    grid-row: 1 / 3;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .badge {
    /* Bumped from 0.5rem — was sub-caption tiny */
    font-size: 0.625rem;
    padding: 0.125rem 0.3125rem;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .badge-green { background: rgba(63, 185, 80, 0.15); color: var(--accent-green); }
  .badge-blue { background: rgba(88, 166, 255, 0.15); color: var(--accent-blue); }
  .badge-purple { background: rgba(188, 140, 255, 0.15); color: var(--accent-purple); }
  .badge-dim { background: rgba(110, 118, 129, 0.15); color: var(--text-muted); }

  .action-msg {
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin-bottom: 0.5rem;
    padding: 0.3125rem 0.625rem;
    background: var(--bg-tertiary);
    border-radius: 4px;
    line-height: 1.4;
  }
</style>
