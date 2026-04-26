<script lang="ts">
  /**
   * ClaudeMdPanel.svelte — Three-tab view for CLAUDE.md (and memory snapshot) files.
   *
   * Tabs:
   *  1. "User"            — ~/.claude/CLAUDE.md plus per-project memory snapshots
   *                         under ~/.claude/projects/{mangled}/memory/*.md
   *  2. "Current Project" — <selectedProject>/CLAUDE.md (when present)
   *  3. "All Projects"    — global + every project's CLAUDE.md (root-level)
   *
   * Each tab has a "Download JSON" button that triggers a browser file download.
   */

  import { fetchAllCustomization } from "$lib/api";
  import type { ClaudeMdInfo, AllProjectsCustomizationResponse } from "$lib/types";
  import { formatBytes, formatRelativeTime, copyToClipboard } from "$lib/format";

  // -- Props ------------------------------------------------------------------

  interface Props {
    /** ClaudeMd entries already loaded by SettingsPanel for the current view */
    claudeMds: ClaudeMdInfo[];
    /** Currently selected project path (empty = no project) */
    selectedProject?: string;
    /** Basename of selected project (for display) */
    projectName?: string;
    /** Called when user clicks a name to expand/view it */
    onExpand?: (path: string) => void;
  }

  const { claudeMds, selectedProject = "", projectName = "", onExpand }: Props = $props();

  // -- State ------------------------------------------------------------------

  type Tab = "user" | "project" | "all";
  let activeTab = $state<Tab>("user");

  let allData: AllProjectsCustomizationResponse | null = $state(null);
  let allLoading = $state(false);
  let allError: string | null = $state(null);

  const HOME_PREFIX = "/data/data/com.termux/files/home/";
  function shortenPath(p: string): string {
    if (p.startsWith(HOME_PREFIX)) return "~/" + p.slice(HOME_PREFIX.length);
    return p;
  }

  // -- Derived ----------------------------------------------------------------

  // "user" tab: anything that's not the selected project's CLAUDE.md.
  // Includes ~/.claude/CLAUDE.md (scope=user) and memory snapshots (scope=memory).
  const userMds = $derived(claudeMds.filter(m => m.scope !== "project"));
  const projectMds = $derived(claudeMds.filter(m => m.scope === "project"));

  /** All-Projects view: combine user-level CLAUDE.md(s) with each project's root CLAUDE.md. */
  const allMds = $derived<Array<ClaudeMdInfo & { projectPath?: string; projectName?: string }>>(
    allData
      ? [
          ...(allData.user.claudeMds ?? []).map(m => ({
            ...m, projectPath: undefined, projectName: "~/.claude",
          })),
          ...allData.projects
            .filter(p => p.claudeMd)
            .map(p => ({
              label: `Project: ${p.name}`,
              path: p.claudeMd!.path,
              scope: "project" as const,
              projectPath: p.path,
              projectName: p.name,
            })),
        ]
      : [],
  );

  // -- Functions --------------------------------------------------------------

  async function loadAll() {
    if (allData || allLoading) return;
    allLoading = true;
    allError = null;
    try {
      allData = await fetchAllCustomization();
    } catch (e: unknown) {
      allError = e instanceof Error ? e.message : String(e);
    } finally {
      allLoading = false;
    }
  }

  function selectTab(tab: Tab) {
    activeTab = tab;
    if (tab === "all") loadAll();
  }

  function downloadJson(filename: string, payload: unknown) {
    const content = JSON.stringify(payload, null, 2);
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function downloadUser() {
    downloadJson(`operad-claude-md-user-${today()}.json`, userMds);
  }

  function downloadProject() {
    downloadJson(`operad-claude-md-project-${today()}.json`, projectMds);
  }

  function downloadAll() {
    downloadJson(`operad-claude-md-all-${today()}.json`, allMds);
  }
</script>

<!-- Tab bar -->
<div class="panel-tabs">
  <button
    class="tab-btn"
    class:active={activeTab === "user"}
    onclick={() => selectTab("user")}
  >
    User
    <span class="tab-count">{userMds.length}</span>
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "project"}
    onclick={() => selectTab("project")}
    disabled={!selectedProject}
    title={selectedProject ? undefined : "Select a project above to see its CLAUDE.md"}
  >
    {projectName || "Project"}
    <span class="tab-count">{projectMds.length}</span>
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "all"}
    onclick={() => selectTab("all")}
  >
    All Projects
    {#if allData}
      <span class="tab-count">{allMds.length}</span>
    {/if}
  </button>
</div>

<!-- Tab content -->
<div class="tab-body">

  {#if activeTab === "user"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadUser} disabled={userMds.length === 0}>
        Download JSON
      </button>
    </div>
    {#if userMds.length === 0}
      <p class="muted">No user-level CLAUDE.md or memory snapshots</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Scope</th>
              <th class="meta-col">Modified</th>
              <th class="meta-col">Size</th>
              <th class="path-col">Path</th>
            </tr>
          </thead>
          <tbody>
            {#each userMds as md}
              <tr>
                <td>
                  {#if onExpand}
                    <button class="item-name-btn" onclick={() => onExpand(md.path)}>{md.label}</button>
                  {:else}
                    <span class="item-name">{md.label}</span>
                  {/if}
                </td>
                <td>
                  <span class="badge"
                    class:badge-blue={md.scope === "user"}
                    class:badge-yellow={md.scope === "memory"}
                  >{md.scope}</span>
                </td>
                <td class="muted small meta-col">{formatRelativeTime(md.modified)}</td>
                <td class="muted small meta-col mono">{formatBytes(md.size)}</td>
                <td class="path-col">
                  <button class="path-icon-btn" title={md.path} onclick={() => copyToClipboard(md.path)} aria-label="Copy path to clipboard">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="9" height="10" rx="1.2"/><path d="M3 11V3a1 1 0 0 1 1-1h7"/></svg>
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  {:else if activeTab === "project"}
    <div class="tab-actions">
      <span class="tab-subtitle">{selectedProject ? shortenPath(selectedProject) : ""}</span>
      <button class="btn-dl" onclick={downloadProject} disabled={projectMds.length === 0}>
        Download JSON
      </button>
    </div>
    {#if !selectedProject}
      <p class="muted">Select a project above to see its CLAUDE.md.</p>
    {:else if projectMds.length === 0}
      <p class="muted">No CLAUDE.md at {shortenPath(selectedProject)}</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th class="meta-col">Modified</th>
              <th class="meta-col">Size</th>
              <th class="path-col">Path</th>
            </tr>
          </thead>
          <tbody>
            {#each projectMds as md}
              <tr>
                <td>
                  {#if onExpand}
                    <button class="item-name-btn" onclick={() => onExpand(md.path)}>{md.label}</button>
                  {:else}
                    <span class="item-name">{md.label}</span>
                  {/if}
                </td>
                <td class="muted small meta-col">{formatRelativeTime(md.modified)}</td>
                <td class="muted small meta-col mono">{formatBytes(md.size)}</td>
                <td class="path-col">
                  <button class="path-icon-btn" title={md.path} onclick={() => copyToClipboard(md.path)} aria-label="Copy path to clipboard">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="9" height="10" rx="1.2"/><path d="M3 11V3a1 1 0 0 1 1-1h7"/></svg>
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  {:else if activeTab === "all"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadAll} disabled={allMds.length === 0 || allLoading}>
        Download JSON
      </button>
    </div>
    {#if allLoading}
      <p class="muted">Loading…</p>
    {:else if allError}
      <p class="error-msg">{allError}</p>
    {:else if allMds.length === 0}
      <p class="muted">No CLAUDE.md files found across any known projects.</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Label</th>
              <th>Scope</th>
              <th class="meta-col">Modified</th>
              <th class="meta-col">Size</th>
              <th class="path-col">Path</th>
            </tr>
          </thead>
          <tbody>
            {#each allMds as md}
              <tr>
                <td class="proj-cell muted small" title={md.projectPath}>{md.projectName ?? "user"}</td>
                <td>
                  {#if onExpand}
                    <button class="item-name-btn" onclick={() => onExpand(md.path)}>{md.label}</button>
                  {:else}
                    <span class="item-name">{md.label}</span>
                  {/if}
                </td>
                <td>
                  <span class="badge"
                    class:badge-blue={md.scope === "user"}
                    class:badge-dim={md.scope === "project"}
                    class:badge-yellow={md.scope === "memory"}
                  >{md.scope}</span>
                </td>
                <td class="muted small meta-col">{formatRelativeTime(md.modified)}</td>
                <td class="muted small meta-col mono">{formatBytes(md.size)}</td>
                <td class="path-col">
                  <button class="path-icon-btn" title={md.path} onclick={() => copyToClipboard(md.path)} aria-label="Copy path to clipboard">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="9" height="10" rx="1.2"/><path d="M3 11V3a1 1 0 0 1 1-1h7"/></svg>
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<style>
  .panel-tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--border, #333);
    margin-bottom: 0.75rem;
  }

  .tab-btn {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.8125rem;
    padding: 0.5rem 0.875rem;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab-btn:hover:not(:disabled) {
    color: var(--text-primary);
  }

  .tab-btn.active {
    border-bottom-color: var(--accent-blue);
    color: var(--text-primary);
  }

  .tab-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .tab-count {
    background: var(--bg-tertiary);
    border-radius: 9999px;
    font-size: 0.6875rem;
    padding: 0.0625rem 0.375rem;
    line-height: 1.4;
  }

  .tab-body {
    min-height: 60px;
  }

  .tab-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-bottom: 0.6rem;
  }

  .tab-subtitle {
    font-size: 0.75rem;
    font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
    color: var(--text-muted);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .btn-dl {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0.3125rem 0.625rem;
    transition: background 0.15s;
    white-space: nowrap;
  }

  .btn-dl:hover:not(:disabled) {
    background: var(--border);
  }

  .btn-dl:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .table-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }

  thead tr {
    border-bottom: 1px solid var(--border);
  }

  th {
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.5rem 0.625rem;
    text-align: left;
    white-space: nowrap;
  }

  td {
    border-bottom: 1px solid var(--border);
    padding: 0.5rem 0.625rem;
    vertical-align: middle;
  }

  .mono {
    font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
  }

  .small {
    font-size: 0.75rem;
  }

  .muted {
    color: var(--text-muted);
  }

  .proj-cell {
    white-space: nowrap;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item-name-btn {
    background: none;
    border: none;
    color: var(--accent-blue);
    cursor: pointer;
    font-size: inherit;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
    font-family: inherit;
  }

  .item-name-btn:hover {
    color: var(--text-primary);
  }

  .item-name {
    color: var(--text-primary);
  }

  .error-msg {
    color: var(--accent-red);
    font-size: 0.8125rem;
  }

  /* Shared row metadata columns — added by refactor-panels.py */
  .meta-col {
    white-space: nowrap;
    width: 1%;
    text-align: right;
    padding-left: 0.25rem;
  }
  .path-col {
    width: 1.75rem;
    text-align: center;
    padding-left: 0;
    padding-right: 0.25rem;
  }
  .path-icon-btn {
    background: none;
    border: 1px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.1875rem 0.25rem;
    border-radius: 4px;
    line-height: 0;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .path-icon-btn:hover {
    color: var(--accent-blue);
    border-color: var(--border);
    background: var(--bg-tertiary);
  }
  .path-icon-btn:active {
    color: var(--accent-green);
  }
</style>
