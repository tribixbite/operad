<script lang="ts">
  /**
   * HooksPanel.svelte — Three-tab view for hook entries.
   *
   * Tabs:
   *  1. "User"            — hooks from ~/.claude/settings.json
   *  2. "Current Project" — hooks from <selectedProject>/.claude/settings.json
   *  3. "All Projects"    — aggregated hooks from every known project
   *
   * Each tab has a "Download JSON" button that triggers a browser file download.
   */

  import { fetchAllCustomization } from "$lib/api";
  import type { HookInfo, AllProjectsCustomizationResponse } from "$lib/types";

  // -- Props ------------------------------------------------------------------

  interface Props {
    /** Hooks already loaded by SettingsPanel for the current view (user + project) */
    hooks: HookInfo[];
    /** Currently selected project path (empty = no project) */
    selectedProject?: string;
    /** Basename of selected project (for display) */
    projectName?: string;
  }

  const { hooks, selectedProject = "", projectName = "" }: Props = $props();

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

  /** User-scoped hooks from the parent-loaded data */
  const userHooks = $derived(hooks.filter(h => !h.scope || h.scope === "user"));

  /** Project-scoped hooks from the parent-loaded data */
  const projectHooks = $derived(hooks.filter(h => h.scope === "project"));

  /** All hooks flattened from all-projects response with project path annotation */
  const allHooks = $derived<Array<HookInfo & { projectPath?: string; projectName?: string }>>(
    allData
      ? [
          ...allData.user.hooks.map(h => ({ ...h, projectPath: undefined, projectName: "~/.claude" })),
          ...allData.projects.flatMap(p =>
            p.hooks.map(h => ({ ...h, projectPath: p.path, projectName: p.name })),
          ),
        ]
      : [],
  );

  // -- Functions --------------------------------------------------------------

  /** Load all-projects data (lazy — only when tab is selected) */
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

  /** Trigger a JSON file download with given filename and data */
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

  /** Today's date string for filenames */
  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function downloadUserHooks() {
    downloadJson(`operad-hooks-user-${today()}.json`, userHooks);
  }

  function downloadProjectHooks() {
    downloadJson(`operad-hooks-project-${today()}.json`, projectHooks);
  }

  function downloadAllHooks() {
    downloadJson(`operad-hooks-all-${today()}.json`, allHooks);
  }
</script>

<!-- Tab bar -->
<div class="hooks-tabs">
  <button
    class="tab-btn"
    class:active={activeTab === "user"}
    onclick={() => selectTab("user")}
  >
    User
    <span class="tab-count">{userHooks.length}</span>
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "project"}
    onclick={() => selectTab("project")}
    disabled={!selectedProject}
    title={selectedProject ? undefined : "Select a project above to see project-level hooks"}
  >
    {projectName || "Project"}
    <span class="tab-count">{projectHooks.length}</span>
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "all"}
    onclick={() => selectTab("all")}
  >
    All Projects
    {#if allData}
      <span class="tab-count">{allHooks.length}</span>
    {/if}
  </button>
</div>

<!-- Tab content -->
<div class="tab-body">

  <!-- User tab -->
  {#if activeTab === "user"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadUserHooks} disabled={userHooks.length === 0}>
        Download JSON
      </button>
    </div>
    {#if userHooks.length === 0}
      <p class="muted">No user-level hooks configured in ~/.claude/settings.json</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Matcher</th>
              <th>Command</th>
              <th>Timeout</th>
            </tr>
          </thead>
          <tbody>
            {#each userHooks as hook}
              <tr>
                <td class="event-cell">{hook.event}</td>
                <td class="mono small">{hook.matcher}</td>
                <td class="mono small cmd-cell" title={hook.command}>{shortenPath(hook.command)}</td>
                <td class="muted">{hook.timeout ? `${hook.timeout}s` : "-"}</td>
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
      <button class="btn-dl" onclick={downloadProjectHooks} disabled={projectHooks.length === 0}>
        Download JSON
      </button>
    </div>
    {#if !selectedProject}
      <p class="muted">Select a project above to see its hooks.</p>
    {:else if projectHooks.length === 0}
      <p class="muted">No hooks in {shortenPath(selectedProject)}/.claude/settings.json</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Matcher</th>
              <th>Command</th>
              <th>Timeout</th>
            </tr>
          </thead>
          <tbody>
            {#each projectHooks as hook}
              <tr>
                <td class="event-cell">{hook.event}</td>
                <td class="mono small">{hook.matcher}</td>
                <td class="mono small cmd-cell" title={hook.command}>{shortenPath(hook.command)}</td>
                <td class="muted">{hook.timeout ? `${hook.timeout}s` : "-"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  <!-- All Projects tab -->
  {:else if activeTab === "all"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadAllHooks} disabled={allHooks.length === 0 || allLoading}>
        Download JSON
      </button>
    </div>
    {#if allLoading}
      <p class="muted">Loading…</p>
    {:else if allError}
      <p class="error-msg">{allError}</p>
    {:else if allHooks.length === 0}
      <p class="muted">No hooks found across any known projects.</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Event</th>
              <th>Matcher</th>
              <th>Command</th>
              <th>Timeout</th>
            </tr>
          </thead>
          <tbody>
            {#each allHooks as hook}
              <tr>
                <td class="proj-cell muted small" title={hook.projectPath}>{hook.projectName ?? "user"}</td>
                <td class="event-cell">{hook.event}</td>
                <td class="mono small">{hook.matcher}</td>
                <td class="mono small cmd-cell" title={hook.command}>{shortenPath(hook.command)}</td>
                <td class="muted">{hook.timeout ? `${hook.timeout}s` : "-"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<style>
  .hooks-tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--border, #333);
    margin-bottom: 0.75rem;
  }

  .tab-btn {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted, #888);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.4rem 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab-btn:hover:not(:disabled) {
    color: var(--text, #e2e8f0);
  }

  .tab-btn.active {
    border-bottom-color: var(--accent, #60a5fa);
    color: var(--text, #e2e8f0);
  }

  .tab-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .tab-count {
    background: var(--surface2, #2d3748);
    border-radius: 9999px;
    font-size: 0.7rem;
    padding: 0 0.35rem;
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
    font-size: 0.72rem;
    color: var(--text-muted, #888);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .btn-dl {
    background: var(--surface2, #2d3748);
    border: 1px solid var(--border, #333);
    border-radius: 4px;
    color: var(--text, #e2e8f0);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0.25rem 0.6rem;
    transition: background 0.15s;
    white-space: nowrap;
  }

  .btn-dl:hover:not(:disabled) {
    background: var(--surface3, #374151);
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
    font-size: 0.78rem;
  }

  thead tr {
    border-bottom: 1px solid var(--border, #333);
  }

  th {
    color: var(--text-muted, #888);
    font-weight: 500;
    padding: 0.3rem 0.5rem;
    text-align: left;
    white-space: nowrap;
  }

  td {
    border-bottom: 1px solid var(--border-subtle, #1e2533);
    padding: 0.3rem 0.5rem;
    vertical-align: middle;
  }

  .mono {
    font-family: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
  }

  .small {
    font-size: 0.72rem;
  }

  .muted {
    color: var(--text-muted, #888);
  }

  .event-cell {
    white-space: nowrap;
    font-weight: 500;
  }

  .cmd-cell {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .proj-cell {
    white-space: nowrap;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .error-msg {
    color: var(--red, #f87171);
    font-size: 0.8rem;
  }
</style>
