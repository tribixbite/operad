<script lang="ts">
  import { fetchApps, forceStopApp, toggleAutoStop, fetchAutoStopList, type AppInfo } from "../lib/api";

  let apps: AppInfo[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let stopping = $state(new Set<string>());
  let toggling = $state(new Set<string>());

  /** Auto-stop management state */
  let autoStopPkgs: string[] = $state([]);
  let removing = $state(new Set<string>());
  let addPkg = $state("");

  async function refresh() {
    try {
      apps = await fetchApps();
      error = null;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  async function handleStop(pkg: string) {
    stopping = new Set([...stopping, pkg]);
    try {
      await forceStopApp(pkg);
      setTimeout(refresh, 800);
    } catch (e) {
      error = `Failed to stop ${pkg}: ${(e as Error).message}`;
    } finally {
      stopping = new Set([...stopping].filter((p) => p !== pkg));
    }
  }

  async function handleToggleAutoStop(pkg: string) {
    toggling = new Set([...toggling, pkg]);
    try {
      const result = await toggleAutoStop(pkg);
      // Update local state without full refresh
      apps = apps.map((a) => a.pkg === pkg ? { ...a, autostop: result.autostop } : a);
      // Sync auto-stop list
      await refreshAutoStop();
    } catch (e) {
      error = `Failed to toggle auto-stop: ${(e as Error).message}`;
    } finally {
      toggling = new Set([...toggling].filter((p) => p !== pkg));
    }
  }

  /** Fetch the persisted auto-stop list */
  async function refreshAutoStop() {
    try {
      const result = await fetchAutoStopList();
      autoStopPkgs = result.packages.sort();
    } catch { /* non-critical */ }
  }

  /** Remove a package from auto-stop list */
  async function removeAutoStop(pkg: string) {
    removing = new Set([...removing, pkg]);
    try {
      await toggleAutoStop(pkg); // toggle off
      autoStopPkgs = autoStopPkgs.filter((p) => p !== pkg);
      // Also update app list if visible
      apps = apps.map((a) => a.pkg === pkg ? { ...a, autostop: false } : a);
    } catch (e) {
      error = `Failed to remove auto-stop: ${(e as Error).message}`;
    } finally {
      removing = new Set([...removing].filter((p) => p !== pkg));
    }
  }

  /** Add a package to auto-stop list */
  async function addAutoStop() {
    const pkg = addPkg.trim();
    if (!pkg) return;
    toggling = new Set([...toggling, pkg]);
    try {
      const result = await toggleAutoStop(pkg);
      if (result.autostop) {
        autoStopPkgs = [...autoStopPkgs, pkg].sort();
        apps = apps.map((a) => a.pkg === pkg ? { ...a, autostop: true } : a);
      }
      addPkg = "";
    } catch (e) {
      error = `Failed to add auto-stop: ${(e as Error).message}`;
    } finally {
      toggling = new Set([...toggling].filter((p) => p !== pkg));
    }
  }

  /** Derive a short label from a package name */
  function pkgLabel(pkg: string): string {
    // Find matching running app label, or extract last meaningful segment
    const app = apps.find((a) => a.pkg === pkg);
    if (app) return app.label;
    const parts = pkg.split(".");
    return parts[parts.length - 1] ?? pkg;
  }

  // Initial load
  $effect(() => {
    if (typeof window === "undefined") return;
    refresh();
    refreshAutoStop();
  });

  let totalRss = $derived(apps.reduce((sum, a) => sum + a.rss_mb, 0));
  let killableApps = $derived(apps.filter((a) => !a.system));
</script>

<div class="card">
  <div class="flex items-center justify-between mb-3">
    <h2 class="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide">Android Apps</h2>
    <div class="flex items-center gap-2">
      {#if totalRss > 0}
        <span class="text-xs text-[var(--text-muted)]">{totalRss}MB</span>
      {/if}
      <button class="btn btn-sm" onclick={refresh}>Refresh</button>
    </div>
  </div>

  {#if loading}
    <p class="text-xs text-[var(--text-muted)]">Loading...</p>
  {:else if error}
    <p class="text-xs text-[var(--accent-red)]">{error}</p>
  {:else if apps.length === 0}
    <p class="text-xs text-[var(--text-muted)]">No apps found (ADB offline?)</p>
  {:else}
    <table class="app-table">
      <tbody>
        {#each apps as app (app.pkg)}
          <tr class="app-row" class:system={app.system}>
            <td class="td-label">
              <div class="app-name">{app.label}</div>
              <div class="app-pkg">{app.pkg}</div>
            </td>
            <td class="td-rss">{app.rss_mb}<span class="unit">MB</span></td>
            <td class="td-action">
              {#if !app.system}
                <div class="action-group">
                  <button
                    class="btn-autostop"
                    class:active={app.autostop}
                    onclick={() => handleToggleAutoStop(app.pkg)}
                    disabled={toggling.has(app.pkg)}
                    title={app.autostop ? "Auto-stop enabled (stops on memory pressure)" : "Enable auto-stop on memory pressure"}
                  >
                    {app.autostop ? "AS" : "as"}
                  </button>
                  <button
                    class="btn btn-sm btn-danger"
                    onclick={() => handleStop(app.pkg)}
                    disabled={stopping.has(app.pkg)}
                  >
                    {stopping.has(app.pkg) ? "..." : "Stop"}
                  </button>
                </div>
              {:else}
                <span class="sys-label">system</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<!-- Auto-Stop Management -->
<div class="card" style="margin-top: 1rem;">
  <div class="flex items-center justify-between mb-3">
    <h2 class="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide">Auto-Stop Rules</h2>
    <span class="text-xs text-[var(--text-muted)]">{autoStopPkgs.length} app{autoStopPkgs.length !== 1 ? "s" : ""}</span>
  </div>

  <p class="as-desc">Apps flagged here are force-stopped automatically during memory pressure.</p>

  {#if autoStopPkgs.length === 0}
    <p class="as-empty">No auto-stop rules configured</p>
  {:else}
    <div class="as-list">
      {#each autoStopPkgs as pkg (pkg)}
        <div class="as-item">
          <div class="as-item-info">
            <span class="as-item-label">{pkgLabel(pkg)}</span>
            <span class="as-item-pkg">{pkg}</span>
          </div>
          <button
            class="as-remove"
            onclick={() => removeAutoStop(pkg)}
            disabled={removing.has(pkg)}
            title="Remove from auto-stop"
          >
            {#if removing.has(pkg)}
              ...
            {:else}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4L12 12M12 4L4 12"/></svg>
            {/if}
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Add by package name -->
  <div class="as-add">
    <input
      type="text"
      class="as-add-input"
      placeholder="com.example.app"
      bind:value={addPkg}
      onkeydown={(e) => e.key === "Enter" && addAutoStop()}
    />
    <button class="btn btn-sm" onclick={addAutoStop} disabled={!addPkg.trim()}>Add</button>
  </div>

  <!-- Quick-add from running apps not yet flagged -->
  {#if killableApps.filter((a) => !a.autostop).length > 0}
    <details class="as-quick">
      <summary class="as-quick-summary">Quick add from running apps</summary>
      <div class="as-quick-list">
        {#each killableApps.filter((a) => !a.autostop) as app (app.pkg)}
          <button
            class="as-quick-item"
            onclick={() => { addPkg = app.pkg; addAutoStop(); }}
            disabled={toggling.has(app.pkg)}
          >
            <span class="as-quick-name">{app.label}</span>
            <span class="as-quick-rss">{app.rss_mb}MB</span>
          </button>
        {/each}
      </div>
    </details>
  {/if}
</div>

<style>
  .app-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }
  .app-row td {
    padding: 0.5rem 0.375rem;
    border-top: 1px solid var(--border);
    vertical-align: middle;
  }
  .app-row:first-child td { border-top: none; }
  .app-row.system { opacity: 0.5; }
  .td-label {
    color: var(--text-primary);
    max-width: 0;
    width: 100%;
  }
  .app-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
  }
  .app-pkg {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-family: monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .td-rss {
    text-align: right;
    color: var(--text-secondary);
    font-size: 0.75rem;
    white-space: nowrap;
    padding-right: 0.75rem !important;
  }
  .unit { color: var(--text-muted); margin-left: 1px; }
  .td-action {
    text-align: right;
    white-space: nowrap;
    width: 6.5rem;
  }
  .action-group {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
  }
  .btn-autostop {
    font-size: 0.625rem;
    font-weight: 700;
    font-family: monospace;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    transition: all 0.15s;
  }
  .btn-autostop:hover {
    border-color: var(--accent-yellow);
    color: var(--accent-yellow);
  }
  .btn-autostop.active {
    background: color-mix(in srgb, var(--accent-yellow) 15%, transparent);
    border-color: var(--accent-yellow);
    color: var(--accent-yellow);
  }
  .btn-autostop:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .sys-label {
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  /* Auto-Stop section */
  .as-desc {
    font-size: 0.6875rem;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }
  .as-empty {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-align: center;
    padding: 0.75rem 0;
  }
  .as-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
  }
  .as-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .as-item-info {
    flex: 1;
    min-width: 0;
  }
  .as-item-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--accent-yellow);
    display: block;
  }
  .as-item-pkg {
    font-size: 0.625rem;
    color: var(--text-muted);
    font-family: monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
  }
  .as-remove {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s;
  }
  .as-remove:hover {
    border-color: var(--accent-red);
    color: var(--accent-red);
    background: rgba(248, 81, 73, 0.1);
  }
  .as-remove:disabled { opacity: 0.4; cursor: default; }
  .as-add {
    display: flex;
    gap: 0.25rem;
    margin-top: 0.5rem;
  }
  .as-add-input {
    flex: 1;
    font-size: 0.6875rem;
    font-family: monospace;
    padding: 0.3rem 0.5rem;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    outline: none;
  }
  .as-add-input:focus { border-color: var(--accent-blue); }
  .as-add-input::placeholder { color: var(--text-muted); }
  .as-quick {
    margin-top: 0.5rem;
  }
  .as-quick-summary {
    font-size: 0.6875rem;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
  }
  .as-quick-summary:hover { color: var(--text-secondary); }
  .as-quick-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.375rem;
  }
  .as-quick-item {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.625rem;
    font-family: inherit;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }
  .as-quick-item:hover {
    border-color: var(--accent-yellow);
    color: var(--accent-yellow);
  }
  .as-quick-item:disabled { opacity: 0.4; cursor: default; }
  .as-quick-name { font-weight: 500; }
  .as-quick-rss { color: var(--text-muted); }
</style>
