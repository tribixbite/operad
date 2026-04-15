<script lang="ts">
  import type { SdkPermissionRequest } from "$lib/types";
  import { send } from "$lib/ws.svelte";

  interface Props {
    request: SdkPermissionRequest;
    sessionName: string;
    ondismiss: () => void;
  }
  let { request, sessionName, ondismiss }: Props = $props();

  /** Remaining seconds on the timeout countdown */
  let remainingSec = $state(Math.ceil(request.timeout_ms / 1000));
  let countdownTimer: ReturnType<typeof setInterval> | undefined;

  /** Truncated preview of tool input (max 500 chars) */
  const inputPreview = $derived.by(() => {
    try {
      const raw = typeof request.input === "string"
        ? request.input
        : JSON.stringify(request.input, null, 2);
      return raw.length > 500 ? raw.slice(0, 500) + "..." : raw;
    } catch {
      return String(request.input);
    }
  });

  /** Start countdown timer */
  $effect(() => {
    remainingSec = Math.ceil(request.timeout_ms / 1000);
    countdownTimer = setInterval(() => {
      remainingSec--;
      if (remainingSec <= 0) {
        clearInterval(countdownTimer);
        ondismiss();
      }
    }, 1000);
    return () => {
      if (countdownTimer) clearInterval(countdownTimer);
    };
  });

  /** Respond to the permission request via WS */
  function respond(behavior: "allow" | "deny") {
    send({
      type: "permission_response",
      sessionName,
      id: request.id,
      behavior,
    });
    ondismiss();
  }

  /** Keyboard shortcuts: Enter=Allow, Escape=Deny */
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      respond("allow");
    } else if (e.key === "Escape") {
      e.preventDefault();
      respond("deny");
    }
  }

  /** Format seconds as M:SS */
  function fmtTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="perm-backdrop" onclick={() => respond("deny")}>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="perm-modal" onclick={(e) => e.stopPropagation()}>
    <div class="perm-header">
      <span class="perm-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg></span>
      <span class="perm-title">Permission Request</span>
      <span class="perm-timer" class:perm-timer-warn={remainingSec < 30}>
        {fmtTime(remainingSec)}
      </span>
    </div>

    <div class="perm-body">
      <div class="perm-tool">
        <span class="perm-tool-label">Tool:</span>
        <code class="perm-tool-name">{request.tool}</code>
      </div>

      <div class="perm-input-section">
        <span class="perm-input-label">Input:</span>
        <pre class="perm-input-preview">{inputPreview}</pre>
      </div>
    </div>

    <div class="perm-actions">
      <button class="perm-btn perm-btn-deny" onclick={() => respond("deny")}>
        Deny <kbd>Esc</kbd>
      </button>
      <button class="perm-btn perm-btn-allow" onclick={() => respond("allow")}>
        Allow <kbd>Enter</kbd>
      </button>
    </div>
  </div>
</div>

<style>
  .perm-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fade-in 0.15s ease-out;
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .perm-modal {
    width: min(400px, 90vw);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    animation: scale-in 0.15s ease-out;
  }

  @keyframes scale-in {
    from { transform: scale(0.95); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
  }

  .perm-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  .perm-icon {
    font-size: 1rem;
  }

  .perm-title {
    flex: 1;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .perm-timer {
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    background: var(--bg-tertiary);
  }

  .perm-timer-warn {
    color: var(--accent-yellow, #f0c040);
    background: rgba(240, 192, 64, 0.1);
  }

  .perm-body {
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .perm-tool {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .perm-tool-label {
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .perm-tool-name {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--accent-blue);
    padding: 0.125rem 0.375rem;
    background: rgba(88, 166, 255, 0.1);
    border-radius: 3px;
  }

  .perm-input-section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .perm-input-label {
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .perm-input-preview {
    font-size: 0.625rem;
    color: var(--text-secondary);
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.5rem;
    max-height: 200px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .perm-actions {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border);
    justify-content: flex-end;
  }

  .perm-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.1s, border-color 0.1s;
  }

  .perm-btn kbd {
    font-size: 0.5625rem;
    padding: 0.0625rem 0.25rem;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    font-family: inherit;
  }

  .perm-btn-deny {
    background: var(--bg-tertiary);
    color: var(--text-secondary);
  }

  .perm-btn-deny:hover {
    background: rgba(248, 81, 73, 0.15);
    border-color: var(--accent-red);
    color: var(--accent-red);
  }

  .perm-btn-allow {
    background: rgba(88, 166, 255, 0.15);
    border-color: var(--accent-blue);
    color: var(--accent-blue);
  }

  .perm-btn-allow:hover {
    background: rgba(88, 166, 255, 0.25);
  }
</style>
