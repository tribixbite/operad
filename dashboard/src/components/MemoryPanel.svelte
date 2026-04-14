<script lang="ts">
  import { fetchMemories, searchMemories, createMemory, deleteMemory, decayMemories } from "../lib/api";
  import type { MemoryRecord, MemoryCategory } from "../lib/types";
  import { store } from "../lib/store.svelte";

  interface Props {
    projectPath?: string;
  }
  let { projectPath: propPath }: Props = $props();

  /** Available project paths from active sessions */
  const availableProjects = $derived.by(() => {
    if (!store.daemon?.sessions) return [];
    return store.daemon.sessions
      .filter((s) => s.path)
      .map((s) => ({ name: s.name, path: s.path! }));
  });

  /** Selected project path (prop overrides selector) */
  let selectedPath = $state(propPath ?? "");

  /** Resolve active path — prop takes priority, then user selection */
  const projectPath = $derived(propPath ?? selectedPath);

  let memories: MemoryRecord[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let searchQuery = $state("");
  let searching = $state(false);

  /** New memory form state */
  let showAddForm = $state(false);
  let newCategory: MemoryCategory = $state("discovery");
  let newContent = $state("");
  let saving = $state(false);

  /** Confirmation for delete */
  let deleteConfirm: number | null = $state(null);

  /** Category display labels and colors */
  const CATEGORY_META: Record<MemoryCategory, { label: string; color: string }> = {
    warning: { label: "Warning", color: "#f85149" },
    convention: { label: "Convention", color: "#58a6ff" },
    decision: { label: "Decision", color: "#a371f7" },
    discovery: { label: "Discovery", color: "#22c55e" },
    user_preference: { label: "Preference", color: "#f0c040" },
  };

  /** Categories ordered for display */
  const CATEGORY_ORDER: MemoryCategory[] = [
    "warning", "convention", "decision", "discovery", "user_preference",
  ];

  /** Group memories by category */
  const groupedMemories = $derived.by(() => {
    const groups = new Map<MemoryCategory, MemoryRecord[]>();
    for (const cat of CATEGORY_ORDER) {
      const items = memories.filter((m) => m.category === cat);
      if (items.length > 0) groups.set(cat, items);
    }
    return groups;
  });

  /** Total memory count */
  const totalCount = $derived(memories.length);

  /** Load memories for the project */
  async function loadMemories() {
    if (!projectPath) {
      loading = false;
      return;
    }
    loading = true;
    error = null;
    try {
      memories = await fetchMemories(projectPath);
    } catch (e: any) {
      error = e.message ?? "Failed to load memories";
    } finally {
      loading = false;
    }
  }

  /** Search memories */
  async function handleSearch() {
    const q = searchQuery.trim();
    if (!q) {
      await loadMemories();
      return;
    }
    searching = true;
    error = null;
    try {
      memories = await searchMemories(projectPath, q);
    } catch (e: any) {
      error = e.message ?? "Search failed";
    } finally {
      searching = false;
    }
  }

  /** Create a new memory */
  async function handleCreate() {
    const content = newContent.trim();
    if (!content) return;
    saving = true;
    try {
      await createMemory(projectPath, newCategory, content);
      newContent = "";
      showAddForm = false;
      await loadMemories();
    } catch (e: any) {
      error = e.message ?? "Failed to create memory";
    } finally {
      saving = false;
    }
  }

  /** Delete a memory */
  async function handleDelete(id: number) {
    try {
      await deleteMemory(id);
      memories = memories.filter((m) => m.id !== id);
      deleteConfirm = null;
    } catch (e: any) {
      error = e.message ?? "Failed to delete memory";
    }
  }

  /** Trigger relevance decay */
  async function handleDecay() {
    try {
      const result = await decayMemories(projectPath);
      if (result.decayed > 0) {
        await loadMemories();
      }
    } catch (e: any) {
      error = e.message ?? "Decay failed";
    }
  }

  /** Format unix timestamp */
  function fmtDate(epoch: number): string {
    return new Date(epoch * 1000).toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
    });
  }

  /** Format relevance score as bar width */
  function scoreWidth(score: number): string {
    return `${Math.min(score / 2.0 * 100, 100)}%`;
  }

  /** Load on mount */
  $effect(() => {
    if (typeof window === "undefined") return;
    loadMemories();
  });
</script>

<div class="memory-panel">
  <div class="memory-header">
    <span class="memory-title">Memories</span>
    <span class="memory-count">{totalCount}</span>
    <div class="memory-actions">
      <button class="btn-sm" onclick={() => (showAddForm = !showAddForm)}>
        {showAddForm ? "Cancel" : "+ Add"}
      </button>
      <button class="btn-sm btn-muted" onclick={handleDecay} title="Decay old memory relevance">
        Decay
      </button>
    </div>
  </div>

  <!-- Project selector (only shown when no projectPath prop) -->
  {#if !propPath}
    <div class="memory-search">
      <select
        class="search-input"
        bind:value={selectedPath}
        onchange={() => { memories = []; loading = true; loadMemories(); }}
      >
        <option value="">Select project...</option>
        {#each availableProjects as proj (proj.path)}
          <option value={proj.path}>{proj.name}</option>
        {/each}
      </select>
    </div>
  {/if}

  <!-- Search bar -->
  <div class="memory-search">
    <input
      type="text"
      class="search-input"
      placeholder="Search memories (FTS5)..."
      bind:value={searchQuery}
      onkeydown={(e) => e.key === "Enter" && handleSearch()}
    />
    <button class="btn-sm" onclick={handleSearch} disabled={searching}>
      {searching ? "..." : "Search"}
    </button>
  </div>

  {#if error}
    <div class="memory-error">{error}</div>
  {/if}

  <!-- Add form -->
  {#if showAddForm}
    <div class="add-form">
      <select class="add-category" bind:value={newCategory}>
        {#each CATEGORY_ORDER as cat}
          <option value={cat}>{CATEGORY_META[cat].label}</option>
        {/each}
      </select>
      <textarea
        class="add-content"
        bind:value={newContent}
        placeholder="Memory content..."
        rows="3"
      ></textarea>
      <button
        class="btn-sm btn-primary"
        onclick={handleCreate}
        disabled={saving || !newContent.trim()}
      >
        {saving ? "Saving..." : "Save Memory"}
      </button>
    </div>
  {/if}

  {#if loading}
    <div class="memory-placeholder">Loading memories...</div>
  {:else if memories.length === 0}
    <div class="memory-placeholder">
      {searchQuery ? "No matches found" : "No memories for this project"}
    </div>
  {:else}
    <!-- Grouped by category -->
    {#each CATEGORY_ORDER as cat}
      {@const items = groupedMemories.get(cat)}
      {#if items && items.length > 0}
        <div class="category-group">
          <div class="category-header">
            <span
              class="category-dot"
              style="background: {CATEGORY_META[cat].color}"
            ></span>
            <span class="category-label">{CATEGORY_META[cat].label}</span>
            <span class="category-count">{items.length}</span>
          </div>
          {#each items as mem (mem.id)}
            <div class="memory-item">
              <div class="memory-content">{mem.content}</div>
              <div class="memory-meta">
                <div class="relevance-bar">
                  <div
                    class="relevance-fill"
                    style="width: {scoreWidth(mem.relevance_score)}; background: {CATEGORY_META[cat].color}"
                  ></div>
                </div>
                <span class="memory-date">{fmtDate(mem.accessed_at)}</span>
                {#if deleteConfirm === mem.id}
                  <button class="btn-xs btn-danger" onclick={() => handleDelete(mem.id)}>Confirm</button>
                  <button class="btn-xs" onclick={() => (deleteConfirm = null)}>Cancel</button>
                {:else}
                  <button class="btn-xs btn-muted" onclick={() => (deleteConfirm = mem.id)}>Delete</button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .memory-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .memory-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .memory-title {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .memory-count {
    font-size: 0.5625rem;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    padding: 0.0625rem 0.3125rem;
    border-radius: 9999px;
  }

  .memory-actions {
    margin-left: auto;
    display: flex;
    gap: 0.25rem;
  }

  .memory-search {
    display: flex;
    gap: 0.25rem;
  }

  .search-input {
    flex: 1;
    font-size: 0.6875rem;
    font-family: inherit;
    padding: 0.3rem 0.5rem;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    outline: none;
  }
  .search-input:focus { border-color: var(--accent-blue); }
  .search-input::placeholder { color: var(--text-muted); }

  .memory-error {
    font-size: 0.6875rem;
    color: var(--accent-red);
    padding: 0.25rem 0.5rem;
    background: rgba(248, 81, 73, 0.08);
    border-radius: 4px;
  }

  .memory-placeholder {
    text-align: center;
    font-size: 0.6875rem;
    color: var(--text-muted);
    padding: 1rem 0;
  }

  /* Add form */
  .add-form {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  .add-category {
    font-size: 0.6875rem;
    font-family: inherit;
    padding: 0.25rem 0.375rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    outline: none;
    width: fit-content;
  }

  .add-content {
    font-size: 0.6875rem;
    font-family: inherit;
    padding: 0.375rem 0.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    outline: none;
    resize: vertical;
    min-height: 3rem;
  }
  .add-content:focus { border-color: var(--accent-blue); }

  /* Category groups */
  .category-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .category-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0;
  }

  .category-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .category-label {
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .category-count {
    font-size: 0.5625rem;
    color: var(--text-muted);
  }

  /* Memory items */
  .memory-item {
    padding: 0.375rem 0.5rem;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
  }

  .memory-content {
    font-size: 0.6875rem;
    color: var(--text-primary);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .memory-meta {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.25rem;
  }

  .relevance-bar {
    width: 3rem;
    height: 3px;
    background: var(--bg-tertiary);
    border-radius: 2px;
    overflow: hidden;
  }

  .relevance-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.2s;
  }

  .memory-date {
    font-size: 0.5625rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* Buttons */
  .btn-sm {
    font-size: 0.625rem;
    font-family: inherit;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .btn-sm:hover { border-color: var(--text-muted); color: var(--text-primary); }
  .btn-sm:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-sm.btn-muted { color: var(--text-muted); }
  .btn-sm.btn-primary {
    background: rgba(88, 166, 255, 0.15);
    border-color: var(--accent-blue);
    color: var(--accent-blue);
  }
  .btn-sm.btn-primary:hover { background: rgba(88, 166, 255, 0.25); }

  .btn-xs {
    font-size: 0.5625rem;
    font-family: inherit;
    padding: 0.1rem 0.3rem;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    cursor: pointer;
  }
  .btn-xs:hover { border-color: var(--text-muted); }
  .btn-xs.btn-danger {
    color: var(--accent-red);
    border-color: var(--accent-red);
  }
  .btn-xs.btn-danger:hover {
    background: rgba(248, 81, 73, 0.15);
  }
  .btn-xs.btn-muted:hover { color: var(--text-secondary); }
</style>
