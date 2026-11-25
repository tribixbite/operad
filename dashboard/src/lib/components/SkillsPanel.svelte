<script lang="ts">
  /**
   * SkillsPanel.svelte — Three-tab view for skill entries of every agent.
   *
   * Tabs:
   *  1. "User"            — user-level and builtin skills: ~/.claude/skills,
   *                         ~/.codex/skills (+ .system), ~/.agents/skills,
   *                         ~/.gemini/config/skills, agy's builtin skills
   *  2. "Current Project" — <project>/.claude/skills and <project>/.agents/skills
   *  3. "All Projects"    — aggregated skills from every known project
   *
   * An agent filter (Claude Code / Codex / agy) applies to every tab. Each tab
   * has a "Download JSON" button that downloads what the tab shows.
   */

  import { AllCustomizationLoader } from "$lib/all-customization.svelte";
  import { shortenHomePath as shortenPath } from "$lib/env.svelte";
  import type { SkillInfo } from "$lib/types";
  import { formatBytes, formatRelativeTime, copyToClipboard } from "$lib/format";

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

  type Agent = NonNullable<SkillInfo["agents"]>[number];
  const AGENTS: Agent[] = ["Claude Code", "Codex", "agy"];
  /** null = every agent. */
  let agentFilter = $state<Agent | null>(null);

  /** Lazily fetched on first visit to the "All Projects" tab. */
  const allProjects = new AllCustomizationLoader();

  type Row = SkillInfo & { projectPath?: string; projectName?: string };

  // -- Derived ----------------------------------------------------------------

  /** Older daemons send no `agents`; everything they list is Claude Code's. */
  function agentsOf(s: SkillInfo): Agent[] {
    return s.agents && s.agents.length > 0 ? s.agents : ["Claude Code"];
  }

  function byAgent<T extends SkillInfo>(list: T[]): T[] {
    return agentFilter ? list.filter(s => agentsOf(s).includes(agentFilter!)) : list;
  }

  const userSkills = $derived(byAgent(skills.filter(s => s.scope === "user" || s.scope === "builtin")));
  const projectSkills = $derived(byAgent(skills.filter(s => s.scope === "project")));

  const allSkills = $derived<Row[]>(
    allProjects.data
      ? byAgent([
          ...allProjects.data.user.skills.map(s => ({ ...s, projectPath: undefined, projectName: "user" })),
          ...allProjects.data.projects.flatMap(p =>
            p.skills.map(s => ({ ...s, projectPath: p.path, projectName: p.name })),
          ),
        ])
      : [],
  );

  /** Per-agent totals across the user + project lists, for the filter chips. */
  const agentCounts = $derived(
    Object.fromEntries(AGENTS.map(a => [a, skills.filter(s => agentsOf(s).includes(a)).length])) as Record<Agent, number>,
  );

  // -- Functions --------------------------------------------------------------

  function selectTab(tab: Tab) {
    activeTab = tab;
    if (tab === "all") allProjects.load();
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

  /** Short CSS-safe key for an agent badge. */
  function agentKey(a: Agent): string {
    return a === "Claude Code" ? "claude" : a.toLowerCase();
  }
</script>

{#snippet skillTable(rows: Row[], showProject: boolean)}
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          {#if showProject}<th>Project</th>{/if}
          <th>Name</th>
          <th>Agents</th>
          <th class="meta-col">Modified</th>
          <th class="meta-col">Size</th>
          <th class="path-col">Path</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as skill (skill.path)}
          <tr>
            {#if showProject}
              <td class="proj-cell muted small" title={skill.projectPath}>{skill.projectName ?? "user"}</td>
            {/if}
            <td>
              {#if onExpand}
                <button class="skill-name-btn" onclick={() => onExpand(skill.path)}>{skill.name}</button>
              {:else}
                <span class="skill-name">{skill.name}</span>
              {/if}
              {#if skill.scope === "builtin"}
                <span class="builtin-tag" title="Shipped with the agent and replaced on update; read-only">builtin</span>
              {/if}
            </td>
            <td class="agents-cell" title={skill.source}>
              {#each agentsOf(skill) as a}
                <span class="agent-badge agent-{agentKey(a)}">{a}</span>
              {/each}
            </td>
            <td class="muted small meta-col">{formatRelativeTime(skill.modified)}</td>
            <td class="muted small meta-col mono">{formatBytes(skill.size)}</td>
            <td class="path-col">
              <button class="path-icon-btn" title={skill.path} onclick={() => copyToClipboard(skill.path)} aria-label="Copy path to clipboard">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="9" height="10" rx="1.2"/><path d="M3 11V3a1 1 0 0 1 1-1h7"/></svg>
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/snippet}

<!-- Agent filter -->
<div class="agent-filter" role="group" aria-label="Filter skills by agent">
  <button class="chip" class:active={agentFilter === null} onclick={() => (agentFilter = null)}>All</button>
  {#each AGENTS as a}
    <button class="chip agent-{agentKey(a)}" class:active={agentFilter === a} onclick={() => (agentFilter = agentFilter === a ? null : a)}>
      {a} <span class="tab-count">{agentCounts[a]}</span>
    </button>
  {/each}
</div>

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
    {#if allProjects.data}
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
      <p class="muted">No user-level skills{agentFilter ? ` for ${agentFilter}` : ""}.</p>
    {:else}
      {@render skillTable(userSkills, false)}
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
      <p class="muted">No skills in {shortenPath(selectedProject)}/.claude/skills or .agents/skills</p>
    {:else}
      {@render skillTable(projectSkills, false)}
    {/if}

  <!-- All Projects tab -->
  {:else if activeTab === "all"}
    <div class="tab-actions">
      <button class="btn-dl" onclick={downloadAllSkills} disabled={allSkills.length === 0 || allProjects.loading}>
        Download JSON
      </button>
    </div>
    {#if allProjects.loading}
      <p class="muted">Loading…</p>
    {:else if allProjects.error}
      <p class="error-msg">{allProjects.error}</p>
    {:else if allSkills.length === 0}
      <p class="muted">No skills found across any known projects.</p>
    {:else}
      {@render skillTable(allSkills, true)}
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
    /* Buttons centre wrapped text by default; long names read better left-aligned. */
    text-align: left;
  }

  .skill-name-btn:hover {
    color: var(--text-primary);
  }

  .skill-name {
    color: var(--text-primary);
  }

  /* Modified / Size columns kept narrow so the screen real estate goes to
     the name column. The path-icon column is the absolute minimum width. */
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

  .agent-filter {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-bottom: 0.625rem;
  }
  .chip {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.75rem;
    /* 32px tall: comfortable touch target */
    min-height: 2rem;
    padding: 0.25rem 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .chip.active {
    border-color: var(--accent-blue);
    color: var(--text-primary);
  }
  .agents-cell {
    white-space: nowrap;
  }
  .agent-badge {
    border-radius: 4px;
    font-size: 0.6875rem;
    padding: 0.0625rem 0.375rem;
    margin-right: 0.25rem;
    border: 1px solid var(--border);
    color: var(--text-muted);
  }
  .agent-badge.agent-claude { color: var(--accent-yellow); border-color: currentColor; }
  .agent-badge.agent-codex  { color: var(--accent-green); border-color: currentColor; }
  .agent-badge.agent-agy    { color: var(--accent-blue); border-color: currentColor; }
  .builtin-tag {
    margin-left: 0.375rem;
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    border: 1px dashed var(--border);
    border-radius: 4px;
    padding: 0 0.25rem;
  }

  .error-msg {
    /* Use design token: was var(--red, ...) */
    color: var(--accent-red);
    font-size: 0.8125rem;
  }
</style>
