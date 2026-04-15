<script lang="ts">
  import {
    fetchProfile, addProfileNote, addProfileTrait, addChatExport,
    fetchProfilePreview, updateProfileEntry, deleteProfileEntry,
  } from "$lib/api";
  import type { ProfileEntry, ProfilePreview } from "$lib/types";

  // -- State ------------------------------------------------------------------

  let entries: ProfileEntry[] = $state([]);
  let preview: ProfilePreview | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);
  let actionMsg: string | null = $state(null);

  /** Active tab: notes | traits | exports | preview */
  let activeTab: "notes" | "traits" | "exports" | "preview" = $state("notes");

  /** New entry input states */
  let newNote = $state("");
  let newNoteTags = $state("");
  let newTrait = $state("");
  let newTraitWeight = $state(3.0);
  let chatExportText = $state("");
  let chatExportSource = $state("");

  /** Editing state */
  let editingId: number | null = $state(null);
  let editContent = $state("");
  let editWeight = $state(1.0);

  // -- Derived ----------------------------------------------------------------

  let noteEntries = $derived(entries.filter((e) => e.category === "note"));
  let traitEntries = $derived(entries.filter((e) => e.category === "trait" || e.category === "style" || e.category === "preference"));
  let exportEntries = $derived(entries.filter((e) => e.category === "chat_export"));

  // -- Loading ----------------------------------------------------------------

  async function loadAll() {
    loading = true;
    error = null;
    try {
      const [e, p] = await Promise.all([fetchProfile(), fetchProfilePreview()]);
      entries = e;
      preview = p;
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  }

  $effect(() => { loadAll(); });

  // -- Actions ----------------------------------------------------------------

  async function handleAddNote() {
    if (!newNote.trim()) return;
    try {
      const tags = newNoteTags ? newNoteTags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
      await addProfileNote(newNote, { tags });
      actionMsg = "Note added";
      newNote = "";
      newNoteTags = "";
      await loadAll();
    } catch (err) {
      error = String(err);
    }
  }

  async function handleAddTrait() {
    if (!newTrait.trim()) return;
    try {
      await addProfileTrait(newTrait, newTraitWeight);
      actionMsg = "Trait added";
      newTrait = "";
      newTraitWeight = 3.0;
      await loadAll();
    } catch (err) {
      error = String(err);
    }
  }

  async function handleUploadExport() {
    if (!chatExportText.trim()) return;
    try {
      const result = await addChatExport(chatExportText, chatExportSource || "paste");
      actionMsg = `Ingested ${result.chunks} chunks (${result.saved} new)`;
      chatExportText = "";
      chatExportSource = "";
      await loadAll();
    } catch (err) {
      error = String(err);
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteProfileEntry(id);
      actionMsg = "Entry deleted";
      await loadAll();
    } catch (err) {
      error = String(err);
    }
  }

  async function handleSaveEdit() {
    if (editingId === null) return;
    try {
      await updateProfileEntry(editingId, { content: editContent, weight: editWeight });
      actionMsg = "Entry updated";
      editingId = null;
      await loadAll();
    } catch (err) {
      error = String(err);
    }
  }

  function startEdit(entry: ProfileEntry) {
    editingId = entry.id;
    editContent = entry.content;
    editWeight = entry.weight;
  }

  function formatTime(epoch: number): string {
    return new Date(epoch * 1000).toLocaleDateString(undefined, {
      month: "short", day: "numeric",
    });
  }

  function categoryLabel(cat: string): string {
    const labels: Record<string, string> = {
      note: "Note", trait: "Trait", style: "Style",
      preference: "Preference", chat_export: "Export",
    };
    return labels[cat] ?? cat;
  }
</script>

<div class="mind-meld">
  <!-- Tab bar -->
  <div class="tabs">
    <button class="tab" class:active={activeTab === "notes"} onclick={() => (activeTab = "notes")}>
      Notes <span class="count">{noteEntries.length}</span>
    </button>
    <button class="tab" class:active={activeTab === "traits"} onclick={() => (activeTab = "traits")}>
      Traits <span class="count">{traitEntries.length}</span>
    </button>
    <button class="tab" class:active={activeTab === "exports"} onclick={() => (activeTab = "exports")}>
      Exports <span class="count">{exportEntries.length}</span>
    </button>
    <button class="tab" class:active={activeTab === "preview"} onclick={() => (activeTab = "preview")}>
      Preview
    </button>
  </div>

  {#if actionMsg}
    <div class="action-msg" onclick={() => (actionMsg = null)}>{actionMsg}</div>
  {/if}
  {#if error}
    <div class="error-msg" onclick={() => (error = null)}>{error}</div>
  {/if}

  {#if loading}
    <p class="muted">Loading profile...</p>

  {:else if activeTab === "notes"}
    <!-- Add note form -->
    <div class="add-form">
      <textarea class="input textarea" bind:value={newNote} placeholder="Add a note, idea, or bullet point..." rows="3"></textarea>
      <div class="form-row">
        <input class="input" bind:value={newNoteTags} placeholder="Tags (comma-separated)" style="flex:1" />
        <button class="btn-primary" onclick={handleAddNote} disabled={!newNote.trim()}>Add Note</button>
      </div>
    </div>

    <!-- Note list -->
    {#each noteEntries as entry (entry.id)}
      <div class="entry-card">
        {#if editingId === entry.id}
          <textarea class="input textarea" bind:value={editContent} rows="3"></textarea>
          <div class="form-row">
            <label class="weight-label">Weight:
              <input class="input" type="number" bind:value={editWeight} step="0.5" min="0.1" max="5" style="width:60px" />
            </label>
            <span class="spacer"></span>
            <button class="btn-sm" onclick={() => (editingId = null)}>Cancel</button>
            <button class="btn-primary btn-sm-p" onclick={handleSaveEdit}>Save</button>
          </div>
        {:else}
          <div class="entry-header">
            <span class="entry-content">{entry.content}</span>
            <span class="weight-badge">w:{entry.weight}</span>
          </div>
          <div class="entry-footer">
            {#if entry.tags}
              {#each JSON.parse(entry.tags) as tag}
                <span class="tag">{tag}</span>
              {/each}
            {/if}
            <span class="muted">{formatTime(entry.created_at)}</span>
            <span class="spacer"></span>
            <button class="btn-ghost" onclick={() => startEdit(entry)}>Edit</button>
            <button class="btn-ghost btn-ghost-red" onclick={() => handleDelete(entry.id)}>Del</button>
          </div>
        {/if}
      </div>
    {:else}
      <p class="muted">No notes yet. Add ideas, architectural visions, or bullet point thoughts.</p>
    {/each}

  {:else if activeTab === "traits"}
    <!-- Add trait form -->
    <div class="add-form">
      <input class="input" bind:value={newTrait} placeholder="e.g. &quot;I prefer terse, direct communication&quot;" />
      <div class="form-row">
        <label class="weight-label">Weight:
          <input class="input" type="number" bind:value={newTraitWeight} step="0.5" min="0.5" max="5" style="width:60px" />
        </label>
        <span class="spacer"></span>
        <button class="btn-primary" onclick={handleAddTrait} disabled={!newTrait.trim()}>Add Trait</button>
      </div>
    </div>

    <!-- Trait list -->
    {#each traitEntries as entry (entry.id)}
      <div class="entry-card">
        {#if editingId === entry.id}
          <input class="input" bind:value={editContent} />
          <div class="form-row">
            <label class="weight-label">Weight:
              <input class="input" type="number" bind:value={editWeight} step="0.5" min="0.1" max="5" style="width:60px" />
            </label>
            <span class="spacer"></span>
            <button class="btn-sm" onclick={() => (editingId = null)}>Cancel</button>
            <button class="btn-primary btn-sm-p" onclick={handleSaveEdit}>Save</button>
          </div>
        {:else}
          <div class="entry-header">
            <span class="badge badge-cat">{categoryLabel(entry.category)}</span>
            <span class="entry-content">{entry.content}</span>
            <span class="weight-badge">w:{entry.weight}</span>
          </div>
          <div class="entry-footer">
            <span class="muted">{formatTime(entry.created_at)}</span>
            <span class="spacer"></span>
            <button class="btn-ghost" onclick={() => startEdit(entry)}>Edit</button>
            <button class="btn-ghost btn-ghost-red" onclick={() => handleDelete(entry.id)}>Del</button>
          </div>
        {/if}
      </div>
    {:else}
      <p class="muted">No traits defined. Declare your preferences and personality.</p>
    {/each}

  {:else if activeTab === "exports"}
    <!-- Chat export upload -->
    <div class="add-form">
      <textarea class="input textarea" bind:value={chatExportText} placeholder="Paste chat export text here..." rows="6"></textarea>
      <div class="form-row">
        <input class="input" bind:value={chatExportSource} placeholder="Source label (optional)" style="flex:1" />
        <button class="btn-primary" onclick={handleUploadExport} disabled={!chatExportText.trim()}>Ingest</button>
      </div>
    </div>

    <p class="muted">{exportEntries.length} chat export segments stored (weight: 0.5 each)</p>

    <!-- Show recent exports -->
    {#each exportEntries.slice(0, 10) as entry (entry.id)}
      <div class="entry-card export-card">
        <div class="entry-header">
          <span class="entry-content export-preview">{entry.content.slice(0, 120)}...</span>
          <span class="spacer"></span>
          <button class="btn-ghost btn-ghost-red" onclick={() => handleDelete(entry.id)}>Del</button>
        </div>
      </div>
    {/each}
    {#if exportEntries.length > 10}
      <p class="muted">...and {exportEntries.length - 10} more segments</p>
    {/if}

  {:else if activeTab === "preview"}
    <!-- Profile preview -->
    {#if preview}
      <div class="preview-stats">
        <span class="stat">Traits: {preview.counts.traits}</span>
        <span class="stat">Notes: {preview.counts.notes}</span>
        <span class="stat">Styles: {preview.counts.styles}</span>
        <span class="stat">Exports: {preview.counts.chat_exports}</span>
      </div>
      <div class="preview-box">
        <pre class="preview-text">{preview.preview}</pre>
      </div>
      <p class="muted">This is what the master controller sees about you.</p>
    {:else}
      <p class="muted">No profile data to preview</p>
    {/if}
  {/if}
</div>

<style>
  .mind-meld { display: flex; flex-direction: column; gap: 0.5rem; }

  .tabs {
    display: flex;
    gap: 0.25rem;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    background: none;
    border: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.75rem;
    padding: 0.375rem 0.5rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .tab.active { color: var(--text-primary); border-bottom-color: var(--accent-blue); }
  .tab:hover { color: var(--text-primary); }
  .count { font-size: 0.625rem; opacity: 0.6; }

  .action-msg {
    font-size: 0.6875rem;
    color: var(--accent-green, #4ade80);
    padding: 0.25rem 0.5rem;
    background: rgba(74, 222, 128, 0.1);
    border-radius: 4px;
    cursor: pointer;
  }
  .error-msg {
    font-size: 0.6875rem;
    color: var(--accent-red, #f87171);
    padding: 0.25rem 0.5rem;
    background: rgba(248, 113, 113, 0.1);
    border-radius: 4px;
    cursor: pointer;
  }
  .muted { color: var(--text-muted); font-size: 0.6875rem; }

  .input {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    font: inherit;
    font-size: 0.6875rem;
    padding: 0.375rem 0.5rem;
    width: 100%;
    box-sizing: border-box;
  }
  .input:focus { outline: none; border-color: var(--accent-blue); }
  .input::placeholder { color: var(--text-muted); }
  .textarea { resize: vertical; font-family: monospace; }

  .add-form {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .form-row { display: flex; gap: 0.25rem; align-items: center; }
  .spacer { flex: 1; }

  .btn-primary {
    background: var(--accent-blue);
    color: #fff;
    border: none;
    font: inherit;
    font-size: 0.6875rem;
    padding: 0.375rem 0.75rem;
    border-radius: 4px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-sm-p { padding: 0.25rem 0.5rem; }
  .btn-sm {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font: inherit;
    font-size: 0.6875rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
  }
  .btn-ghost {
    background: none;
    border: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.625rem;
    padding: 0.125rem 0.25rem;
    cursor: pointer;
  }
  .btn-ghost:hover { color: var(--text-primary); }
  .btn-ghost-red:hover { color: #f87171; }

  .weight-label {
    font-size: 0.6875rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .entry-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.625rem;
  }
  .entry-header {
    display: flex;
    align-items: flex-start;
    gap: 0.375rem;
  }
  .entry-content {
    font-size: 0.6875rem;
    color: var(--text-primary);
    flex: 1;
    line-height: 1.4;
  }
  .entry-footer {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.25rem;
    flex-wrap: wrap;
  }

  .weight-badge {
    font-size: 0.5625rem;
    color: var(--accent-blue);
    background: rgba(59, 130, 246, 0.1);
    padding: 0.125rem 0.25rem;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .badge-cat {
    font-size: 0.5625rem;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    background: rgba(168, 85, 247, 0.2);
    color: #c084fc;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    flex-shrink: 0;
  }

  .tag {
    font-size: 0.5625rem;
    padding: 0.0625rem 0.25rem;
    border-radius: 3px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
  }

  .export-card { opacity: 0.7; }
  .export-preview {
    font-family: monospace;
    font-size: 0.625rem;
    color: var(--text-muted);
  }

  .preview-stats {
    display: flex;
    gap: 0.75rem;
    font-size: 0.6875rem;
    padding: 0.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .stat { color: var(--text-secondary); }
  .stat::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent-blue); margin-right: 0.25rem; vertical-align: middle; }

  .preview-box {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    max-height: 400px;
    overflow-y: auto;
  }
  .preview-text {
    font-size: 0.6875rem;
    color: var(--text-primary);
    padding: 0.75rem;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
    margin: 0;
  }
</style>
