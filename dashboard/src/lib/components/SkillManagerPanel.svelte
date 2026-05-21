<script lang="ts">
  /**
   * SkillManagerPanel.svelte — UX for the skill marketplace preview.
   *
   * Three sections:
   *   1. Installed skills — list, expand for details, uninstall.
   *   2. Install — locator input + provider picker.
   *   3. Tool autonomy — per-tool buckets + promotion controls (capped
   *      by source tier; cap-violation errors surface inline).
   *
   * Returns a quiet "Skill marketplace not enabled" empty state when
   * the daemon is running without --enable-skills-preview (fetch
   * returns []). The user can copy the flag instructions from a help
   * link surfaced in that empty state.
   */

  import {
    fetchSkills, installSkill, uninstallSkill, fetchSkillEvents,
    fetchToolAutonomy, setToolAutonomy,
    type SkillSummary, type ToolAutonomyCap, type SkillEvent,
  } from "$lib/api";

  // -- State ----------------------------------------------------------------

  let skills: SkillSummary[] = $state([]);
  let caps: ToolAutonomyCap[] = $state([]);
  let events: SkillEvent[] = $state([]);
  let loading = $state(true);
  let previewEnabled = $state(true);
  let error: string | null = $state(null);
  let expandedSkillId: string | null = $state(null);

  // Install form
  let installLocator = $state("");
  let installProvider: "git+url" | "claude-marketplace" | "mcp-official" | "operad-curated" = $state("git+url");
  let installVersion = $state("latest");
  let installForceOwnership = $state(false);
  let installing = $state(false);
  let installError: string | null = $state(null);
  let installWarnings: string[] = $state([]);

  // Uninstall
  let uninstalling: string | null = $state(null);
  let uninstallError: string | null = $state(null);

  // -- Data loading ---------------------------------------------------------

  async function refresh() {
    loading = true;
    error = null;
    try {
      const [s, c, e] = await Promise.all([
        fetchSkills(),
        fetchToolAutonomy(),
        fetchSkillEvents(30),
      ]);
      skills = s;
      caps = c;
      events = e;
      // The skill marketplace returns 503 → empty arrays from the
      // api helpers. We don't have a clean way to distinguish "off"
      // from "no skills installed yet", so we treat both as
      // "preview off if everything is empty AND no events" — events
      // would survive a session, so an empty events array is the
      // most reliable signal.
      previewEnabled = s.length > 0 || c.length > 0 || e.length > 0
        ? true : await previewEnabledProbe();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  /**
   * Heuristic: an empty installed list + empty events + empty caps
   * usually means the user just hasn't installed anything yet, but
   * could also mean the preview flag is off. Probe via a HEAD on the
   * events endpoint — we'll get 503 with no body when the flag is off.
   */
  async function previewEnabledProbe(): Promise<boolean> {
    try {
      const r = await fetch("/api/skills/events?limit=1");
      return r.status !== 503;
    } catch {
      return false;
    }
  }

  $effect(() => {
    refresh();
  });

  // -- Install --------------------------------------------------------------

  async function handleInstall(acceptCapDowngrade = false) {
    if (!installLocator.trim()) {
      installError = "Locator is required";
      return;
    }
    installing = true;
    installError = null;
    installWarnings = [];
    try {
      const r = await installSkill({
        provider: installProvider,
        locator: installLocator.trim(),
        version: installVersion || undefined,
        force_take_ownership: installForceOwnership,
        accept_cap_downgrade: acceptCapDowngrade,
      });
      installWarnings = r.warnings ?? [];
      installLocator = "";
      installVersion = "latest";
      installForceOwnership = false;
      await refresh();
    } catch (err) {
      const msg = (err as Error).message;
      installError = msg;
      // Re-installing the same (provider, locator) at a stricter tier
      // clamps promoted tools. Offer the retry inline so the user can
      // confirm without retyping the form.
      if (/PROVIDER_TIER_DOWNGRADE/.test(msg) && !acceptCapDowngrade) {
        if (confirm(`${msg}\n\nRetry with --accept-cap-downgrade?`)) {
          await handleInstall(true);
        }
      }
    } finally {
      installing = false;
    }
  }

  async function handleUninstall(id: string, force_revoke = false) {
    if (!confirm(`Uninstall ${id}?${force_revoke ? "\n(Will revoke active leases.)" : ""}`)) return;
    uninstalling = id;
    uninstallError = null;
    try {
      await uninstallSkill(id, { force_revoke });
      await refresh();
    } catch (err) {
      const msg = (err as Error).message;
      uninstallError = msg;
      // If the error is TOOL_HAS_ACTIVE_CONSUMERS, offer the
      // force-revoke retry inline.
      if (/TOOL_HAS_ACTIVE_CONSUMERS/.test(msg) && !force_revoke) {
        if (confirm(`${msg}\n\nRetry with --force-revoke?`)) {
          await handleUninstall(id, true);
        }
      }
    } finally {
      uninstalling = null;
    }
  }

  // -- Autonomy promote ----------------------------------------------------

  let autonomyError: string | null = $state(null);

  async function handlePromote(tool_id: string, bucket: string) {
    autonomyError = null;
    try {
      await setToolAutonomy(tool_id, bucket);
      await refresh();
    } catch (err) {
      autonomyError = (err as Error).message;
    }
  }

  // -- Helpers --------------------------------------------------------------

  function trustColor(tier: string): string {
    switch (tier) {
      case "trusted": return "var(--accent-green)";
      case "community": return "var(--accent-blue)";
      case "escape": return "var(--accent-yellow)";
      default: return "var(--text-muted)";
    }
  }

  function eventTime(epoch: number): string {
    return new Date(epoch * 1000).toLocaleString();
  }

  const BUCKETS = ["observe", "suggest", "supervised", "trusted", "autonomous"];

  function bucketRank(b: string): number {
    return BUCKETS.indexOf(b);
  }
</script>

<div class="skill-manager">
  {#if loading}
    <p class="dim">Loading…</p>
  {:else if !previewEnabled}
    <div class="card empty-state">
      <h3>Skill marketplace not enabled</h3>
      <p>The daemon is running without <code>--enable-skills-preview</code>.</p>
      <p class="dim">To enable, restart the daemon:</p>
      <pre>tmx shutdown
bun ~/git/operad/dist/tmx.js daemon --enable-skills-preview</pre>
      <p class="dim">See <a href="https://github.com/tribixbite/operad/blob/main/docs/skills.md" target="_blank">docs/skills.md</a> for the full marketplace surface.</p>
    </div>
  {:else}
    {#if error}
      <div class="card error-banner">Error: {error}</div>
    {/if}

    <!-- Install form -->
    <section class="card">
      <h3>Install a skill</h3>
      <div class="install-form">
        <select bind:value={installProvider}>
          <option value="git+url">git+url (escape tier)</option>
          <option value="claude-marketplace">claude-marketplace</option>
          <option value="mcp-official">mcp-official (trusted)</option>
          <option value="operad-curated">operad-curated (trusted)</option>
        </select>
        <input
          type="text"
          bind:value={installLocator}
          placeholder={installProvider === "git+url"
            ? "https://github.com/owner/repo"
            : installProvider === "claude-marketplace"
              ? "owner/repo"
              : installProvider === "mcp-official"
                ? "server-id"
                : "owner/skill"}
        />
        <input
          type="text"
          bind:value={installVersion}
          placeholder="version (default: latest)"
          class="version-input"
        />
        <label class="checkbox">
          <input type="checkbox" bind:checked={installForceOwnership} />
          force-take-ownership
        </label>
        <button onclick={handleInstall} disabled={installing || !installLocator.trim()}>
          {installing ? "Installing…" : "Install"}
        </button>
      </div>
      {#if installError}
        <p class="error-line">{installError}</p>
      {/if}
      {#each installWarnings as w}
        <p class="warning-line">⚠ {w}</p>
      {/each}
    </section>

    <!-- Installed skills -->
    <section class="card">
      <h3>Installed ({skills.length})</h3>
      {#if uninstallError}
        <p class="error-line">{uninstallError}</p>
      {/if}
      {#if skills.length === 0}
        <p class="dim">No skills installed yet.</p>
      {:else}
        <table class="skills-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Tier</th>
              <th>Contents</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each skills as s (s.id)}
              <tr onclick={() => (expandedSkillId = expandedSkillId === s.id ? null : s.id)}>
                <td>
                  <span class="skill-name">{s.name}</span>
                  <span class="skill-id dim">{s.id}</span>
                </td>
                <td>
                  <span class="tier-badge" style="color: {trustColor(s.trust_tier)}; border-color: {trustColor(s.trust_tier)}">{s.trust_tier}</span>
                </td>
                <td class="dim">
                  {[
                    (s.tools?.length ?? 0) > 0 ? `${s.tools!.length} tool${s.tools!.length === 1 ? "" : "s"}` : null,
                    (s.workflows?.length ?? 0) > 0 ? `${s.workflows!.length} workflow${s.workflows!.length === 1 ? "" : "s"}` : null,
                    (s.mcps?.length ?? 0) > 0 ? `${s.mcps!.length} mcp${s.mcps!.length === 1 ? "" : "s"}` : null,
                    (s.skill_mds?.length ?? 0) > 0 ? `${s.skill_mds!.length} skill.md` : null,
                  ].filter(Boolean).join(" · ") || "(empty)"}
                </td>
                <td class="actions">
                  <button onclick={(e) => { e.stopPropagation(); handleUninstall(s.id); }} disabled={uninstalling === s.id} class="danger">
                    {uninstalling === s.id ? "…" : "Uninstall"}
                  </button>
                </td>
              </tr>
              {#if expandedSkillId === s.id}
                <tr class="expanded">
                  <td colspan="4">
                    <div class="detail-grid">
                      <div><strong>Source:</strong> <code>{s.source.fetched_url}</code></div>
                      <div><strong>Commit:</strong> <code class="dim">{s.source.fetched_commit_sha ?? "(registry source)"}</code></div>
                      <div><strong>Fetched:</strong> {eventTime(s.source.fetched_at)}</div>
                      {#if s.tools && s.tools.length > 0}
                        <div>
                          <strong>Tools:</strong>
                          <ul>
                            {#each s.tools as t}
                              <li><code>{t.toml.name}</code> <span class="dim">(cap: {t.autonomy_cap})</span></li>
                            {/each}
                          </ul>
                        </div>
                      {/if}
                      {#if s.workflows && s.workflows.length > 0}
                        <div>
                          <strong>Workflows:</strong>
                          <ul>{#each s.workflows as w}<li><code>{w.name}</code></li>{/each}</ul>
                        </div>
                      {/if}
                      {#if s.mcps && s.mcps.length > 0}
                        <div>
                          <strong>MCPs:</strong>
                          <ul>{#each s.mcps as m}<li><code>{m.name}</code> <span class="dim">({m.lifecycle})</span></li>{/each}</ul>
                        </div>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/if}
    </section>

    <!-- Tool autonomy -->
    {#if caps.length > 0}
      <section class="card">
        <h3>Tool autonomy</h3>
        {#if autonomyError}
          <p class="error-line">{autonomyError}</p>
        {/if}
        <table class="autonomy-table">
          <thead>
            <tr><th>Tool</th><th>Current</th><th>Cap</th><th>Promote</th></tr>
          </thead>
          <tbody>
            {#each caps as c (c.tool_id)}
              <tr>
                <td><code>{c.tool_id}</code></td>
                <td><span class="bucket-pill bucket-{c.current_bucket}">{c.current_bucket}</span></td>
                <td><span class="bucket-pill cap">{c.max_bucket}</span></td>
                <td class="promote-buttons">
                  {#each BUCKETS as b}
                    {@const allowed = bucketRank(b) <= bucketRank(c.max_bucket)}
                    {@const current = b === c.current_bucket}
                    <button
                      class:current
                      class:disabled={!allowed}
                      disabled={!allowed || current}
                      onclick={() => handlePromote(c.tool_id, b)}
                      title={allowed ? `Promote to ${b}` : `Cap = ${c.max_bucket}; cannot exceed`}
                    >{b[0]}</button>
                  {/each}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}

    <!-- Recent events -->
    {#if events.length > 0}
      <section class="card">
        <h3>Recent events</h3>
        <ul class="event-list">
          {#each events as ev}
            <li>
              <span class="dim event-time">{eventTime(ev.occurred_at)}</span>
              <span class="event-type event-{ev.event_type}">{ev.event_type}</span>
              <code class="event-id dim">{ev.skill_id}</code>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>

<style>
  .skill-manager :global(.card) { margin-bottom: 0.75rem; padding: 0.75rem 1rem; }
  h3 { margin: 0 0 0.5rem; font-size: 0.9rem; }
  .dim { color: var(--text-muted); font-size: 0.75rem; }
  .error-banner { border-color: var(--accent-red); color: var(--accent-red); }
  .error-line { color: var(--accent-red); font-size: 0.75rem; margin: 0.25rem 0; }
  .warning-line { color: var(--accent-yellow); font-size: 0.75rem; margin: 0.25rem 0; }

  .empty-state h3 { margin: 0 0 0.5rem; }
  .empty-state pre {
    background: var(--bg-primary); padding: 0.5rem; border-radius: 4px;
    font-size: 0.7rem; color: var(--accent-green); margin: 0.5rem 0;
    white-space: pre-wrap; word-break: break-word;
  }
  .empty-state a { color: var(--accent-blue); }

  .install-form {
    display: grid;
    grid-template-columns: auto 1fr auto auto auto;
    gap: 0.375rem;
    align-items: center;
  }
  .install-form select, .install-form input[type="text"] {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .install-form .version-input { width: 8rem; }
  .install-form .checkbox {
    font-size: 0.7rem; color: var(--text-muted);
    display: inline-flex; align-items: center; gap: 0.25rem;
  }
  .install-form button {
    padding: 0.3rem 0.75rem; font-size: 0.75rem;
    background: var(--accent-blue); color: white;
    border: none; border-radius: 4px; cursor: pointer;
  }
  .install-form button:disabled { opacity: 0.5; cursor: not-allowed; }

  .skills-table, .autonomy-table {
    width: 100%; border-collapse: collapse; font-size: 0.75rem;
    table-layout: auto;
  }
  .skills-table th, .autonomy-table th {
    text-align: left; font-weight: 500; color: var(--text-muted);
    text-transform: uppercase; font-size: 0.6875rem; letter-spacing: 0.04em;
    padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--border);
  }
  .skills-table td, .autonomy-table td {
    padding: 0.375rem 0.5rem; border-top: 1px solid var(--border);
    vertical-align: middle;
  }
  .skills-table tbody tr { cursor: pointer; }
  .skills-table tbody tr:hover { background: var(--bg-tertiary); }
  .skill-name { font-weight: 600; }
  .skill-id { display: block; font-family: ui-monospace, monospace; font-size: 0.65rem; }
  .tier-badge {
    border: 1px solid; border-radius: 3px;
    padding: 0.0625rem 0.375rem; font-size: 0.625rem;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .actions { text-align: right; }
  .actions button { padding: 0.25rem 0.5rem; font-size: 0.7rem;
    background: var(--bg-tertiary); color: var(--text-primary);
    border: 1px solid var(--border); border-radius: 4px; cursor: pointer;
  }
  .actions button.danger { border-color: var(--accent-red); color: var(--accent-red); }
  .actions button:hover { background: var(--border); }

  .expanded td { background: var(--bg-primary); padding: 0.75rem 1rem; }
  .detail-grid { display: grid; gap: 0.5rem; font-size: 0.7rem; }
  .detail-grid code { background: var(--bg-tertiary); padding: 0.0625rem 0.25rem; border-radius: 3px; }
  .detail-grid ul { margin: 0.25rem 0 0 1rem; padding: 0; }

  .bucket-pill {
    display: inline-block; padding: 0.0625rem 0.375rem; border-radius: 3px;
    font-size: 0.65rem; font-family: ui-monospace, monospace;
    background: var(--bg-tertiary);
  }
  .bucket-pill.bucket-observe { color: var(--text-muted); }
  .bucket-pill.bucket-suggest { color: var(--accent-blue); }
  .bucket-pill.bucket-supervised { color: var(--accent-cyan); }
  .bucket-pill.bucket-trusted { color: var(--accent-purple); }
  .bucket-pill.bucket-autonomous { color: var(--accent-green); }
  .bucket-pill.cap { border: 1px dashed var(--border); }

  .promote-buttons { display: flex; gap: 0.125rem; }
  .promote-buttons button {
    width: 1.5rem; height: 1.5rem; padding: 0;
    border: 1px solid var(--border); background: var(--bg-tertiary);
    color: var(--text-secondary); border-radius: 3px; cursor: pointer;
    text-transform: uppercase; font-size: 0.625rem; font-weight: 600;
  }
  .promote-buttons button:hover:not(:disabled) {
    background: var(--border); color: var(--text-primary);
  }
  .promote-buttons button.current { background: var(--accent-blue); color: white; border-color: var(--accent-blue); }
  .promote-buttons button.disabled, .promote-buttons button:disabled {
    opacity: 0.3; cursor: not-allowed;
  }

  .event-list { list-style: none; padding: 0; margin: 0; font-size: 0.7rem; }
  .event-list li {
    display: grid; grid-template-columns: 11rem auto 1fr;
    gap: 0.5rem; padding: 0.125rem 0; align-items: center;
  }
  .event-time { font-family: ui-monospace, monospace; }
  .event-type {
    text-transform: uppercase; font-size: 0.6rem; letter-spacing: 0.04em;
    padding: 0.0625rem 0.25rem; border-radius: 3px;
    background: var(--bg-tertiary); color: var(--text-muted);
  }
  .event-type.event-install { color: var(--accent-green); }
  .event-type.event-uninstall { color: var(--accent-red); }
  .event-type.event-error { color: var(--accent-red); }
  .event-id { font-size: 0.65rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
