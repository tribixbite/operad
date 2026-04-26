<script lang="ts">
  /**
   * AgentsMdPanel.svelte — Cross-tool AGENTS.md compatibility view.
   *
   * AGENTS.md is the cross-tool instructions file read by Claude Code,
   * Codex, OpenCode, and other agents. See https://agents.md
   *
   * Tabs:
   *  1. "User"            — ~/AGENTS.md (if present)
   *  2. "Current Project" — <selectedProject>/AGENTS.md (if present) with consumers badge
   *  3. "All Projects"    — table of projects that have AGENTS.md, with consumers column
   *
   * Each tab has a "Download JSON" button. Clicking a row opens the file
   * via the onExpand callback if provided.
   */

  import { fetchAllCustomization } from "$lib/api";
  import type { AgentsMdFile, AllProjectsCustomizationResponse } from "$lib/types";
  import { formatBytes, formatRelativeTime, copyToClipboard } from "$lib/format";

  // -- Props ------------------------------------------------------------------

  interface Props {
    /** AGENTS.md entries already loaded for the current scope (user + project) */
    agentsMdFiles: AgentsMdFile[];
    /** Currently selected project path (empty = no project) */
    selectedProject?: string;
    /** Basename of selected project (for display) */
    projectName?: string;
    /** Called when user clicks a row to expand/view the file */
    onExpand?: (path: string) => void;
  }

  const { agentsMdFiles, selectedProject = "", projectName = "", onExpand }: Props = $props();

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

  /** User-scoped AGENTS.md entries */
  const userFiles = $derived(agentsMdFiles.filter(f => f.scope === "user"));

  /** Project-scoped AGENTS.md entries */
  const projectFiles = $derived(agentsMdFiles.filter(f => f.scope === "project"));

  /** All AGENTS.md entries across all projects */
  const allFiles = $derived<Array<AgentsMdFile & { projectPath?: string; projectName?: string }>>(
    allData
      ? [
          ...(allData.user.agentsMdFiles ?? []).map(f => ({
            ...f,
            projectPath: undefined,
            projectName: "~/.claude",
          })),
          ...allData.projects.flatMap(p =>
            p.agentsMdFile
              ? [{ ...p.agentsMdFile, projectPath: p.path, projectName: p.name }]
              : [],
          ),
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
    downloadJson(`operad-agents-md-user-${today()}.json`, userFiles);
  }

  function downloadProject() {
    downloadJson(`operad-agents-md-project-${today()}.json`, projectFiles);
  }

  function downloadAll() {
    downloadJson(`operad-agents-md-all-${today()}.json`, allFiles);
  }
</script>

<!-- Info banner -->
<div class="info-banner">
  <span class="info-icon">ℹ</span>
  <span class="info-text">
    AGENTS.md is the cross-tool instructions file read by Claude Code, Codex, OpenCode, and other agents.
    See <a href="https://agents.md" target="_blank" rel="noopener noreferrer" class="info-link">agents.md</a>
  </span>
</div>

<!-- Tab bar -->
<div class="panel-tabs">
  <button
    class="tab-btn"
    class:active={activeTab === "user"}
    onclick={() => selectTab("user")}
  >
    User
    <span class="tab-count">{userFiles.length}</span>
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "project"}
    onclick={() => selectTab("project")}
    disabled={!selectedProject}
    title={selectedProject ? undefined : "Select a project above to see project AGENTS.md"}
  >
    {projectName || "Project"}
    <span class="tab-count">{projectFiles.length}</span>
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "all"}
    onclick={() => selectTab("all")}
  >
    All Projects
    {#if allData}
      <span class="tab-count">{allFiles.length}</span>
    {/if}
  </button>
</div>

<!-- Tab content -->
<div class="tab-body">

  <!-- User tab -->
  {#if activeTab === "user"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadUser} disabled={userFiles.length === 0}>
        Download JSON
      </button>
    </div>
    {#if userFiles.length === 0}
      <p class="muted">No AGENTS.md found at ~/AGENTS.md</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th class="meta-col">Modified</th>
              <th class="meta-col">Size</th>
              <th class="path-col">Path</th>
              <th>Read by</th>
            </tr>
          </thead>
          <tbody>
            {#each userFiles as f}
              <tr class:clickable={!!onExpand} onclick={() => onExpand?.(f.path)}>
                <td class="item-label">{f.label}</td>
                <td class="mono small muted">{shortenPath(f.path)}</td>
                <td>
                  <div class="consumers-row">
                    {#each f.consumers as tool}
                      <span class="consumer-badge">{tool}</span>
                    {/each}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  <!-- Project tab -->
  {:else if activeTab === "project"}
    <div class="tab-actions">
      <span class="tab-subtitle">{selectedProject ? shortenPath(selectedProject) : ""}</span>
      <button class="btn-dl" onclick={downloadProject} disabled={projectFiles.length === 0}>
        Download JSON
      </button>
    </div>
    {#if !selectedProject}
      <p class="muted">Select a project above to see its AGENTS.md</p>
    {:else if projectFiles.length === 0}
      <p class="muted">No AGENTS.md in {shortenPath(selectedProject)}/</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th class="meta-col">Modified</th>
              <th class="meta-col">Size</th>
              <th class="path-col">Path</th>
              <th>Read by</th>
            </tr>
          </thead>
          <tbody>
            {#each projectFiles as f}
              <tr class:clickable={!!onExpand} onclick={() => onExpand?.(f.path)}>
                <td class="item-label">{f.label}</td>
                <td class="mono small muted">{shortenPath(f.path)}</td>
                <td>
                  <div class="consumers-row">
                    {#each f.consumers as tool}
                      <span class="consumer-badge">{tool}</span>
                    {/each}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  <!-- All Projects tab -->
  {:else if activeTab === "all"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadAll} disabled={allFiles.length === 0 || allLoading}>
        Download JSON
      </button>
    </div>
    {#if allLoading}
      <p class="muted">Loading…</p>
    {:else if allError}
      <p class="error-msg">{allError}</p>
    {:else if allFiles.length === 0}
      <p class="muted">No AGENTS.md found across any known projects.</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th class="meta-col">Modified</th>
              <th class="meta-col">Size</th>
              <th class="path-col">Path</th>
              <th>Read by</th>
            </tr>
          </thead>
          <tbody>
            {#each allFiles as f}
              <tr class:clickable={!!onExpand} onclick={() => onExpand?.(f.path)}>
                <td class="proj-cell muted small" title={f.projectPath}>{f.projectName ?? "user"}</td>
                <td class="mono small muted">{shortenPath(f.path)}</td>
                <td>
                  <div class="consumers-row">
                    {#each f.consumers as tool}
                      <span class="consumer-badge">{tool}</span>
                    {/each}
                  </div>
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
  /* Info banner */
  .info-banner {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    background: rgba(88, 166, 255, 0.07);
    border: 1px solid rgba(88, 166, 255, 0.2);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.75rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .info-icon {
    color: var(--accent-blue);
    flex-shrink: 0;
    font-size: 0.875rem;
  }

  .info-text {
    flex: 1;
  }

  .info-link {
    color: var(--accent-blue);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .info-link:hover {
    color: var(--text-primary);
  }

  /* Consumers badges */
  .consumers-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .consumer-badge {
    background: rgba(168, 85, 247, 0.15);
    color: #c084fc;
    border-radius: 9999px;
    font-size: 0.625rem;
    padding: 0.0625rem 0.4rem;
    white-space: nowrap;
    font-weight: 500;
  }

  /* Clickable row */
  .clickable {
    cursor: pointer;
  }

  .clickable:hover {
    background: rgba(88, 166, 255, 0.05);
  }

  /* Item label */
  .item-label {
    font-weight: 500;
    white-space: nowrap;
  }

  /* Panel tabs */
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
