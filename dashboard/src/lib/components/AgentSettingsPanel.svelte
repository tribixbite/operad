<script lang="ts">
  /**
   * AgentSettingsPanel.svelte — agent settings that are easy to miss until
   * they cost something, above all Claude Code's transcript retention.
   *
   * Claude Code rows (~/.claude/settings.json) are editable through the
   * daemon's allow-listed /api/agent-settings route; every other key in the
   * file is preserved. Codex rows (~/.codex/config.toml) are read-only:
   * rewriting hand-written TOML would drop its comments.
   */

  import { onMount } from "svelte";
  import { fetchAgentSettings, saveAgentSetting, type AgentSettings, type AgentSettingRow } from "$lib/api";
  import { shortenHomePath as shortenPath } from "$lib/env.svelte";
  import { formatRelativeTime } from "$lib/format";

  let data = $state<AgentSettings | null>(null);
  let loadError = $state<string | null>(null);
  /** Row key → the value typed into its editor (string form). */
  let drafts = $state<Record<string, string>>({});
  /** Key being saved, for the button state. */
  let saving = $state<string | null>(null);
  /** Last save outcome per key. */
  let feedback = $state<Record<string, { ok: boolean; text: string }>>({});

  async function load() {
    try {
      data = await fetchAgentSettings();
      loadError = null;
      drafts = Object.fromEntries(data.claude.settings.map(r => [r.key, r.isSet ? String(r.value) : ""]));
    } catch (e) {
      loadError = (e as Error).message;
    }
  }

  onMount(load);

  function show(v: unknown): string {
    if (v === null || v === undefined) return "—";
    return String(v);
  }

  /** Label for the unset choice: the agent's default, or "unset" when it has none fixed. */
  function defaultLabel(r: AgentSettingRow): string {
    return r.default === null ? "unset" : `default (${String(r.default)})`;
  }

  /** Draft differs from what is on disk. */
  function dirty(r: AgentSettingRow): boolean {
    return (drafts[r.key] ?? "") !== (r.isSet ? String(r.value) : "");
  }

  async function save(r: AgentSettingRow, value: unknown) {
    saving = r.key;
    try {
      await saveAgentSetting(r.key, value);
      feedback[r.key] = { ok: true, text: `Saved — applies on ${r.appliesOn}` };
      await load();
    } catch (e) {
      feedback[r.key] = { ok: false, text: (e as Error).message };
    } finally {
      saving = null;
    }
  }

  function formatDate(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  const retention = $derived(data?.claude.retention ?? null);
</script>

{#if loadError}
  <p class="error-msg">Could not load agent settings: {loadError}</p>
{:else if !data}
  <p class="muted">Loading…</p>
{:else}
  {#if retention}
    <!-- What the retention period means for the transcripts on disk right now. -->
    <div class="retention" class:warn={retention.overdue > 0 || retention.periodDays <= 30}>
      <div class="retention-head">
        Transcripts are deleted after <strong>{retention.periodDays} days</strong> without activity
        {#if !data.claude.settings.find(s => s.key === "cleanupPeriodDays")?.isSet}<span class="muted">(Claude Code default)</span>{/if}
      </div>
      <div class="retention-body muted">
        {retention.sessions} session transcript{retention.sessions === 1 ? "" : "s"} across {retention.projects} project{retention.projects === 1 ? "" : "s"}.
        {#if retention.oldest}
          Oldest last active {formatRelativeTime(retention.oldest.modified)};
          {#if retention.oldest.deletesAt <= Date.now()}
            it is already past the period.
          {:else}
            it becomes deletable {formatDate(retention.oldest.deletesAt)}.
          {/if}
        {/if}
        {#if retention.overdue > 0}
          <strong class="overdue">{retention.overdue} will be deleted the next time Claude Code starts.</strong>
        {/if}
      </div>
    </div>
  {/if}

  <h4 class="group-title">Claude Code <span class="muted path" title={data.claude.path}>{shortenPath(data.claude.path)}</span></h4>
  {#if data.claude.parseError}
    <p class="error-msg">settings.json does not parse ({data.claude.parseError}); editing is disabled until it is fixed.</p>
  {/if}
  <div class="rows">
    {#each data.claude.settings as r (r.key)}
      <div class="row">
        <div class="row-text">
          <div class="row-label">{r.label} <code class="key">{r.key}</code></div>
          <div class="row-desc muted">{r.description}</div>
          {#if feedback[r.key]}
            <div class="row-feedback" class:bad={!feedback[r.key].ok}>{feedback[r.key].text}</div>
          {/if}
        </div>
        <div class="row-edit">
          {#if r.type === "enum" || r.type === "bool"}
            <select
              bind:value={drafts[r.key]}
              disabled={!!data.claude.parseError || saving === r.key}
              aria-label={r.label}
            >
              <option value="">{defaultLabel(r)}</option>
              {#each (r.type === "bool" ? ["true", "false"] : r.options ?? []) as o}
                <option value={o}>{o}</option>
              {/each}
            </select>
          {:else}
            <input
              type={r.type === "int" ? "number" : "text"}
              min={r.min}
              step={r.type === "int" ? 1 : undefined}
              inputmode={r.type === "int" ? "numeric" : undefined}
              placeholder={defaultLabel(r)}
              bind:value={drafts[r.key]}
              disabled={!!data.claude.parseError || saving === r.key}
              aria-label={r.label}
            />
          {/if}
          <button
            class="btn btn-sm btn-primary"
            disabled={!dirty(r) || !!data.claude.parseError || saving === r.key}
            onclick={() => save(r, drafts[r.key] === "" ? null : drafts[r.key])}
          >{saving === r.key ? "Saving…" : "Save"}</button>
        </div>
      </div>
    {/each}
  </div>

  <h4 class="group-title">Codex <span class="muted path" title={data.codex.path}>{shortenPath(data.codex.path)}</span> <span class="ro">read-only</span></h4>
  <div class="rows">
    {#each data.codex.settings as r (r.key)}
      <div class="row">
        <div class="row-text">
          <div class="row-label">{r.label} <code class="key">{r.key}</code></div>
          <div class="row-desc muted">{r.description}</div>
        </div>
        <div class="row-value mono">
          {#if r.isSet}{show(r.value)}{:else}<span class="muted">{defaultLabel(r)}</span>{/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .retention {
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent-green);
    border-radius: 6px;
    padding: 0.625rem 0.75rem;
    margin-bottom: 0.875rem;
    background: var(--bg-tertiary);
  }
  .retention.warn { border-left-color: var(--accent-yellow); }
  .retention-head { font-size: 0.875rem; color: var(--text-primary); margin-bottom: 0.25rem; }
  .retention-body { font-size: 0.8125rem; line-height: 1.5; }
  .overdue { color: var(--accent-yellow); display: block; margin-top: 0.25rem; }

  .group-title {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin: 0.75rem 0 0.375rem;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
  }
  .group-title .path { text-transform: none; letter-spacing: 0; font-size: 0.75rem; overflow-wrap: anywhere; }
  .ro {
    font-size: 0.625rem;
    border: 1px dashed var(--border);
    border-radius: 4px;
    padding: 0 0.25rem;
  }

  .rows { display: flex; flex-direction: column; }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }
  .row-text { flex: 1 1 16rem; min-width: 0; }
  .row-label { font-size: 0.8125rem; color: var(--text-primary); }
  .key { font-size: 0.6875rem; color: var(--text-muted); margin-left: 0.25rem; overflow-wrap: anywhere; }
  .row-desc { font-size: 0.75rem; line-height: 1.45; margin-top: 0.125rem; }
  .row-feedback { font-size: 0.75rem; color: var(--accent-green); margin-top: 0.25rem; }
  .row-feedback.bad { color: var(--accent-red); }
  .row-edit { display: flex; gap: 0.375rem; align-items: center; flex: 0 1 auto; }
  .row-edit input, .row-edit select {
    background: var(--bg-primary, var(--bg-secondary));
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 0.8125rem;
    /* 36px: touch-friendly */
    min-height: 2.25rem;
    padding: 0.25rem 0.5rem;
    width: 11rem;
    max-width: 100%;
  }
  .row-edit .btn { min-height: 2.25rem; }
  .row-edit .btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .row-value { font-size: 0.8125rem; color: var(--text-primary); }
  .mono { font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace; }
  .muted { color: var(--text-muted); }
  .error-msg { color: var(--accent-red); font-size: 0.8125rem; }
</style>
