<script lang="ts">
  /**
   * PlansPanel.svelte — Three-tab view for plan files (~/.claude/plans/*.md
   * and <project>/.claude/plans/*.md).
   *
   * Tabs:
   *  1. "User"            — plans from ~/.claude/plans/
   *  2. "Current Project" — plans from <selectedProject>/.claude/plans/
   *  3. "All Projects"    — aggregated plans from every known project
   *
   * Each tab has a "Download JSON" button that triggers a browser file download.
   */

  import { fetchAllCustomization } from "$lib/api";
  import type { PlanInfo, AllProjectsCustomizationResponse } from "$lib/types";

  // -- Props ------------------------------------------------------------------

  interface Props {
    /** Plan entries already loaded by SettingsPanel for the current view */
    plans: PlanInfo[];
    /** Currently selected project path (empty = no project) */
    selectedProject?: string;
    /** Basename of selected project (for display) */
    projectName?: string;
    /** Called when user clicks a name to expand/view it */
    onExpand?: (path: string) => void;
  }

  const { plans, selectedProject = "", projectName = "", onExpand }: Props = $props();

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

  const userPlans = $derived(plans.filter(p => p.scope === "user"));
  const projectPlans = $derived(plans.filter(p => p.scope === "project"));

  const allPlans = $derived<Array<PlanInfo & { projectPath?: string; projectName?: string }>>(
    allData
      ? [
          ...allData.user.plans.map(p => ({ ...p, projectPath: undefined, projectName: "~/.claude" })),
          ...allData.projects.flatMap(proj =>
            proj.plans.map(p => ({ ...p, projectPath: proj.path, projectName: proj.name })),
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
    downloadJson(`operad-plans-user-${today()}.json`, userPlans);
  }

  function downloadProject() {
    downloadJson(`operad-plans-project-${today()}.json`, projectPlans);
  }

  function downloadAll() {
    downloadJson(`operad-plans-all-${today()}.json`, allPlans);
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
    <span class="tab-count">{userPlans.length}</span>
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "project"}
    onclick={() => selectTab("project")}
    disabled={!selectedProject}
    title={selectedProject ? undefined : "Select a project above to see project-level plans"}
  >
    {projectName || "Project"}
    <span class="tab-count">{projectPlans.length}</span>
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "all"}
    onclick={() => selectTab("all")}
  >
    All Projects
    {#if allData}
      <span class="tab-count">{allPlans.length}</span>
    {/if}
  </button>
</div>

<!-- Tab content -->
<div class="tab-body">

  {#if activeTab === "user"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadUser} disabled={userPlans.length === 0}>
        Download JSON
      </button>
    </div>
    {#if userPlans.length === 0}
      <p class="muted">No user-level plans in ~/.claude/plans/</p>
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
            {#each userPlans as plan}
              <tr>
                <td>
                  {#if onExpand}
                    <button class="item-name-btn" onclick={() => onExpand(plan.path)}>{plan.name}</button>
                  {:else}
                    <span class="item-name">{plan.name}</span>
                  {/if}
                </td>
                <td class="mono small muted">{shortenPath(plan.path)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  {:else if activeTab === "project"}
    <div class="tab-actions">
      <span class="tab-subtitle">{selectedProject ? shortenPath(selectedProject) : ""}</span>
      <button class="btn-dl" onclick={downloadProject} disabled={projectPlans.length === 0}>
        Download JSON
      </button>
    </div>
    {#if !selectedProject}
      <p class="muted">Select a project above to see its plans.</p>
    {:else if projectPlans.length === 0}
      <p class="muted">No plans in {shortenPath(selectedProject)}/.claude/plans/</p>
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
            {#each projectPlans as plan}
              <tr>
                <td>
                  {#if onExpand}
                    <button class="item-name-btn" onclick={() => onExpand(plan.path)}>{plan.name}</button>
                  {:else}
                    <span class="item-name">{plan.name}</span>
                  {/if}
                </td>
                <td class="mono small muted">{shortenPath(plan.path)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  {:else if activeTab === "all"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadAll} disabled={allPlans.length === 0 || allLoading}>
        Download JSON
      </button>
    </div>
    {#if allLoading}
      <p class="muted">Loading…</p>
    {:else if allError}
      <p class="error-msg">{allError}</p>
    {:else if allPlans.length === 0}
      <p class="muted">No plans found across any known projects.</p>
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
            {#each allPlans as plan}
              <tr>
                <td class="proj-cell muted small" title={plan.projectPath}>{plan.projectName ?? "user"}</td>
                <td>
                  {#if onExpand}
                    <button class="item-name-btn" onclick={() => onExpand(plan.path)}>{plan.name}</button>
                  {:else}
                    <span class="item-name">{plan.name}</span>
                  {/if}
                </td>
                <td class="mono small muted">{shortenPath(plan.path)}</td>
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
