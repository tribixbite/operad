<script lang="ts">
  /**
   * SkillsPanel.svelte — Three-tab view for skill entries.
   *
   * Tabs:
   *  1. "User"            — skills from ~/.claude/skills/
   *  2. "Current Project" — skills from <selectedProject>/.claude/skills/
   *  3. "All Projects"    — aggregated skills from every known project
   *
   * Each tab has a "Download JSON" button that triggers a browser file download.
   */

  import { fetchAllCustomization } from "$lib/api";
  import type { SkillInfo, AllProjectsCustomizationResponse } from "$lib/types";

  // -- Props ------------------------------------------------------------------

  interface Props {
    /** Skills already loaded by SettingsPanel for the current view (user + project) */
    skills: SkillInfo[];
    /** Currently selected project path (empty = no project) */
    selectedProject?: string;
    /** Basename of selected project (for display) */
    projectName?: string;
    /** Called when user clicks a skill name to expand/view it */
    onExpand?: (path: string) => void;
  }

  const { skills, selectedProject = "", projectName = "", onExpand }: Props = $props();

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

  const userSkills = $derived(skills.filter(s => s.scope === "user"));
  const projectSkills = $derived(skills.filter(s => s.scope === "project"));

  const allSkills = $derived<Array<SkillInfo & { projectPath?: string; projectName?: string }>>(
    allData
      ? [
          ...allData.user.skills.map(s => ({ ...s, projectPath: undefined, projectName: "~/.claude" })),
          ...allData.projects.flatMap(p =>
            p.skills.map(s => ({ ...s, projectPath: p.path, projectName: p.name })),
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

  function downloadUserSkills() {
    downloadJson(`operad-skills-user-${today()}.json`, userSkills);
  }

  function downloadProjectSkills() {
    downloadJson(`operad-skills-project-${today()}.json`, projectSkills);
  }

  function downloadAllSkills() {
    downloadJson(`operad-skills-all-${today()}.json`, allSkills);
  }
</script>

<!-- Tab bar -->
<div class="skills-tabs">
  <button
    class="tab-btn"
    class:active={activeTab === "user"}
    onclick={() => selectTab("user")}
  >
    User
    <span class="tab-count">{userSkills.length}</span>
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "project"}
    onclick={() => selectTab("project")}
    disabled={!selectedProject}
    title={selectedProject ? undefined : "Select a project above to see project-level skills"}
  >
    {projectName || "Project"}
    <span class="tab-count">{projectSkills.length}</span>
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "all"}
    onclick={() => selectTab("all")}
  >
    All Projects
    {#if allData}
      <span class="tab-count">{allSkills.length}</span>
    {/if}
  </button>
</div>

<!-- Tab content -->
<div class="tab-body">

  <!-- User tab -->
  {#if activeTab === "user"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadUserSkills} disabled={userSkills.length === 0}>
        Download JSON
      </button>
    </div>
    {#if userSkills.length === 0}
      <p class="muted">No user-level skills in ~/.claude/skills/</p>
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
            {#each userSkills as skill}
              <tr>
                <td>
                  {#if onExpand}
                    <button class="skill-name-btn" onclick={() => onExpand(skill.path)}>{skill.name}</button>
                  {:else}
                    <span class="skill-name">{skill.name}</span>
                  {/if}
                </td>
                <td class="mono small muted">{shortenPath(skill.path)}</td>
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
      <button class="btn-dl" onclick={downloadProjectSkills} disabled={projectSkills.length === 0}>
        Download JSON
      </button>
    </div>
    {#if !selectedProject}
      <p class="muted">Select a project above to see its skills.</p>
    {:else if projectSkills.length === 0}
      <p class="muted">No skills in {shortenPath(selectedProject)}/.claude/skills/</p>
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
            {#each projectSkills as skill}
              <tr>
                <td>
                  {#if onExpand}
                    <button class="skill-name-btn" onclick={() => onExpand(skill.path)}>{skill.name}</button>
                  {:else}
                    <span class="skill-name">{skill.name}</span>
                  {/if}
                </td>
                <td class="mono small muted">{shortenPath(skill.path)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  <!-- All Projects tab -->
  {:else if activeTab === "all"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadAllSkills} disabled={allSkills.length === 0 || allLoading}>
        Download JSON
      </button>
    </div>
    {#if allLoading}
      <p class="muted">Loading…</p>
    {:else if allError}
      <p class="error-msg">{allError}</p>
    {:else if allSkills.length === 0}
      <p class="muted">No skills found across any known projects.</p>
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
            {#each allSkills as skill}
              <tr>
                <td class="proj-cell muted small" title={skill.projectPath}>{skill.projectName ?? "user"}</td>
                <td>
                  {#if onExpand}
                    <button class="skill-name-btn" onclick={() => onExpand(skill.path)}>{skill.name}</button>
                  {:else}
                    <span class="skill-name">{skill.name}</span>
                  {/if}
                </td>
                <td class="mono small muted">{shortenPath(skill.path)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<style>
  .skills-tabs {
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
    /* Minimum py-2 cell padding */
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

  .skill-name-btn {
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

  .skill-name-btn:hover {
    color: var(--text-primary);
  }

  .skill-name {
    color: var(--text-primary);
  }

  .error-msg {
    /* Use design token: was var(--red, ...) */
    color: var(--accent-red);
    font-size: 0.8125rem;
  }
</style>
