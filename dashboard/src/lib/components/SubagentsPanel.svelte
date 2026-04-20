<script lang="ts">
  /**
   * SubagentsPanel.svelte — Three-tab view for .claude/agents/*.md entries.
   *
   * Title: "Subagents (.claude/agents/*.md)"
   *
   * Tabs:
   *  1. "User"            — agents from ~/.claude/agents/
   *  2. "Current Project" — agents from <selectedProject>/.claude/agents/
   *  3. "All Projects"    — aggregated agents from every known project
   *
   * Each tab has a "Download JSON" button that triggers a browser file download.
   */

  import { fetchAllCustomization } from "$lib/api";
  import type { AgentMdInfo, AllProjectsCustomizationResponse } from "$lib/types";

  // -- Props ------------------------------------------------------------------

  interface Props {
    /** Subagent entries already loaded by SettingsPanel for the current view */
    agentsMd: AgentMdInfo[];
    /** Currently selected project path (empty = no project) */
    selectedProject?: string;
    /** Basename of selected project (for display) */
    projectName?: string;
    /** Called when user clicks a name to expand/view it */
    onExpand?: (path: string) => void;
  }

  const { agentsMd, selectedProject = "", projectName = "", onExpand }: Props = $props();

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

  const userAgents = $derived(agentsMd.filter(a => a.scope === "user"));
  const projectAgents = $derived(agentsMd.filter(a => a.scope === "project"));

  const allAgents = $derived<Array<AgentMdInfo & { projectPath?: string; projectName?: string }>>(
    allData
      ? [
          ...(allData.user.agentsMd ?? []).map(a => ({ ...a, projectPath: undefined, projectName: "~/.claude" })),
          ...allData.projects.flatMap(p =>
            (p.agentsMd ?? []).map(a => ({ ...a, projectPath: p.path, projectName: p.name })),
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
    downloadJson(`operad-subagents-user-${today()}.json`, userAgents);
  }

  function downloadProject() {
    downloadJson(`operad-subagents-project-${today()}.json`, projectAgents);
  }

  function downloadAll() {
    downloadJson(`operad-subagents-all-${today()}.json`, allAgents);
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
    <span class="tab-count">{userAgents.length}</span>
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "project"}
    onclick={() => selectTab("project")}
    disabled={!selectedProject}
    title={selectedProject ? undefined : "Select a project above to see project-level subagents"}
  >
    {projectName || "Project"}
    <span class="tab-count">{projectAgents.length}</span>
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "all"}
    onclick={() => selectTab("all")}
  >
    All Projects
    {#if allData}
      <span class="tab-count">{allAgents.length}</span>
    {/if}
  </button>
</div>

<!-- Tab content -->
<div class="tab-body">

  <!-- User tab -->
  {#if activeTab === "user"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadUser} disabled={userAgents.length === 0}>
        Download JSON
      </button>
    </div>
    {#if userAgents.length === 0}
      <p class="muted">No user-level subagents in ~/.claude/agents/</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {#each userAgents as agent}
              <tr>
                <td>
                  {#if onExpand}
                    <button class="item-name-btn" onclick={() => onExpand(agent.path)}>{agent.name}</button>
                  {:else}
                    <span class="item-name">{agent.name}</span>
                  {/if}
                </td>
                <td class="mono small muted">{shortenPath(agent.path)}</td>
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
      <button class="btn-dl" onclick={downloadProject} disabled={projectAgents.length === 0}>
        Download JSON
      </button>
    </div>
    {#if !selectedProject}
      <p class="muted">Select a project above to see its subagents.</p>
    {:else if projectAgents.length === 0}
      <p class="muted">No subagents in {shortenPath(selectedProject)}/.claude/agents/</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {#each projectAgents as agent}
              <tr>
                <td>
                  {#if onExpand}
                    <button class="item-name-btn" onclick={() => onExpand(agent.path)}>{agent.name}</button>
                  {:else}
                    <span class="item-name">{agent.name}</span>
                  {/if}
                </td>
                <td class="mono small muted">{shortenPath(agent.path)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  <!-- All Projects tab -->
  {:else if activeTab === "all"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadAll} disabled={allAgents.length === 0 || allLoading}>
        Download JSON
      </button>
    </div>
    {#if allLoading}
      <p class="muted">Loading…</p>
    {:else if allError}
      <p class="error-msg">{allError}</p>
    {:else if allAgents.length === 0}
      <p class="muted">No subagents found across any known projects.</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Name</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {#each allAgents as agent}
              <tr>
                <td class="proj-cell muted small" title={agent.projectPath}>{agent.projectName ?? "user"}</td>
                <td>
                  {#if onExpand}
                    <button class="item-name-btn" onclick={() => onExpand(agent.path)}>{agent.name}</button>
                  {:else}
                    <span class="item-name">{agent.name}</span>
                  {/if}
                </td>
                <td class="mono small muted">{shortenPath(agent.path)}</td>
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
</style>
