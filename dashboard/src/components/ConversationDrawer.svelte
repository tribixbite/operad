<script lang="ts">
  import ConversationViewer from "./ConversationViewer.svelte";
  import PermissionModal from "./PermissionModal.svelte";
  import type { SdkPermissionRequest, SdkAssistantMessage, SdkResultMessage } from "../lib/types";
  import { connect, subscribe, unsubscribe, send, on, wsState } from "../lib/ws.svelte";
  import { sdkAttach, sdkDetach } from "../lib/api";
  import { store } from "../lib/store.svelte";

  interface Props {
    sessionName: string;
    onclose: () => void;
  }
  let { sessionName, onclose }: Props = $props();

  /** Whether live SDK streaming is enabled */
  let liveMode = $state(false);
  /** Whether the SDK is currently attached for this session */
  let sdkAttached = $state(false);
  /** Streaming text buffer for live mode */
  let streamText = $state("");
  /** Active permission request (shown as modal) */
  let pendingPermission: SdkPermissionRequest | null = $state(null);
  /** Prompt input text */
  let promptText = $state("");
  /** Whether a prompt is currently being processed */
  let sending = $state(false);
  /** Live stream messages for display */
  let liveMessages: Array<{ role: string; content: string; timestamp: number }> = $state([]);
  /** Error message from SDK operations */
  let liveError: string | null = $state(null);
  /** Cleanup functions for WS handlers */
  let cleanupFns: Array<() => void> = [];

  /** Resolve session path from daemon state */
  const sessionPath = $derived(() => {
    const session = store.daemon?.sessions.find((s) => s.name === sessionName);
    return session?.path ?? null;
  });

  /** Toggle live mode on/off */
  async function toggleLive() {
    if (liveMode) {
      await detachLive();
    } else {
      await attachLive();
    }
  }

  /** Attach SDK and start streaming */
  async function attachLive() {
    const path = sessionPath();
    if (!path) {
      liveError = "Session has no project path";
      return;
    }

    liveError = null;
    liveMessages = [];
    streamText = "";

    // Connect WS if not already connected
    if (wsState.status !== "connected") {
      connect();
    }

    // Subscribe to session room
    subscribe(sessionName);

    // Register WS message handlers
    cleanupFns.push(
      on("assistant", (msg) => {
        const m = msg as unknown as SdkAssistantMessage;
        if (!m.message?.content) return;
        // Extract text from content blocks
        for (const block of m.message.content) {
          if (block.type === "text" && block.text) {
            streamText = block.text;
          }
        }
      }),
      on("permission_request", (msg) => {
        pendingPermission = msg as unknown as SdkPermissionRequest;
      }),
      on("result", (msg) => {
        const r = msg as unknown as SdkResultMessage;
        // Finalize the current stream text as a message
        if (streamText) {
          liveMessages = [...liveMessages, {
            role: "assistant",
            content: streamText,
            timestamp: Date.now(),
          }];
          streamText = "";
        }
        sending = false;
        // Show cost info
        if (r.total_cost_usd > 0) {
          liveMessages = [...liveMessages, {
            role: "system",
            content: `Cost: $${r.total_cost_usd.toFixed(4)} | ${r.num_turns} turns | ${(r.duration_ms / 1000).toFixed(1)}s`,
            timestamp: Date.now(),
          }];
        }
      }),
      on("error", (msg) => {
        const e = msg as { type: string; message: string };
        liveError = e.message;
        sending = false;
      }),
      on("prompt_start", (msg) => {
        const p = msg as { type: string; prompt: string };
        liveMessages = [...liveMessages, {
          role: "user",
          content: p.prompt,
          timestamp: Date.now(),
        }];
      }),
      on("attached", () => {
        sdkAttached = true;
      }),
      on("detached", () => {
        sdkAttached = false;
      }),
    );

    // Attach SDK bridge via REST
    try {
      await sdkAttach(sessionName, { cwd: path });
      liveMode = true;
      sdkAttached = true;
    } catch (err: any) {
      liveError = err.message ?? "Failed to attach SDK";
      cleanupHandlers();
    }
  }

  /** Detach SDK and stop streaming */
  async function detachLive() {
    try {
      await sdkDetach(sessionName);
    } catch { /* may already be detached */ }
    unsubscribe(sessionName);
    cleanupHandlers();
    liveMode = false;
    sdkAttached = false;
    sending = false;
  }

  /** Clean up WS handlers */
  function cleanupHandlers() {
    for (const fn of cleanupFns) fn();
    cleanupFns = [];
  }

  /** Send prompt via WS */
  function handleSendPrompt() {
    const text = promptText.trim();
    if (!text || sending || !sdkAttached) return;

    send({
      type: "prompt",
      sessionName,
      prompt: text,
    });
    promptText = "";
    sending = true;
    streamText = "";
  }

  /** Handle Enter key in prompt input */
  function handlePromptKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendPrompt();
    }
  }

  /** Close on Escape key (only if no permission modal) */
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && !pendingPermission) onclose();
  }

  /** Close on backdrop click */
  function handleBackdrop(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains("drawer-backdrop")) {
      onclose();
    }
  }

  /** Cleanup on destroy */
  $effect(() => {
    return () => {
      if (liveMode) {
        detachLive();
      }
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Permission modal (floats above everything) -->
{#if pendingPermission}
  <PermissionModal
    request={pendingPermission}
    {sessionName}
    ondismiss={() => (pendingPermission = null)}
  />
{/if}

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="drawer-backdrop" onclick={handleBackdrop}>
  <div class="drawer-panel">
    <div class="drawer-header">
      <h3 class="drawer-title">{sessionName}</h3>
      <div class="drawer-controls">
        <!-- Live mode toggle -->
        <button
          class="live-toggle"
          class:live-active={liveMode}
          onclick={toggleLive}
          title={liveMode ? "Disconnect SDK stream" : "Connect SDK stream"}
        >
          <span class="live-dot" class:live-dot-on={liveMode && sdkAttached}></span>
          {liveMode ? "LIVE" : "Live"}
        </button>
        <button class="drawer-close" onclick={onclose} title="Close (Esc)">&times;</button>
      </div>
    </div>

    <div class="drawer-body">
      {#if liveMode}
        <!-- Live streaming view -->
        <div class="live-container">
          {#if liveError}
            <div class="live-error">{liveError}</div>
          {/if}

          <div class="live-messages">
            {#each liveMessages as msg (msg.timestamp)}
              <div class="live-msg live-msg-{msg.role}">
                <span class="live-msg-role">{msg.role}</span>
                <div class="live-msg-content">{msg.content}</div>
              </div>
            {/each}

            <!-- Streaming text (partial, in progress) -->
            {#if streamText}
              <div class="live-msg live-msg-assistant live-msg-streaming">
                <span class="live-msg-role">assistant</span>
                <div class="live-msg-content">{streamText}</div>
                <span class="streaming-indicator"></span>
              </div>
            {/if}

            {#if sending && !streamText}
              <div class="live-thinking">Thinking...</div>
            {/if}
          </div>

          <!-- Prompt input -->
          <div class="live-prompt">
            <textarea
              class="prompt-input"
              bind:value={promptText}
              onkeydown={handlePromptKeydown}
              placeholder={sending ? "Processing..." : "Send a prompt..."}
              disabled={sending || !sdkAttached}
              rows="2"
            ></textarea>
            <button
              class="prompt-send"
              onclick={handleSendPrompt}
              disabled={sending || !promptText.trim() || !sdkAttached}
              title="Send (Enter)"
            >
              &#x25B6;
            </button>
          </div>
        </div>
      {:else}
        <!-- Historical conversation viewer (existing) -->
        <ConversationViewer {sessionName} />
      {/if}
    </div>
  </div>
</div>

<style>
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 100;
    display: flex;
    justify-content: flex-end;
  }
  .drawer-panel {
    width: min(480px, 92vw);
    height: 100%;
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    animation: slide-in 0.2s ease-out;
    box-shadow: -4px 0 16px rgba(0, 0, 0, 0.3);
  }
  @keyframes slide-in {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }
  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.625rem 0.75rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .drawer-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }
  .drawer-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .drawer-close {
    width: 1.5rem;
    height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.125rem;
    cursor: pointer;
    border-radius: 4px;
    font-family: inherit;
  }
  .drawer-close:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .drawer-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* -- Live mode toggle ---------------------------------------------------- */
  .live-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    font-size: 0.6875rem;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .live-toggle:hover {
    border-color: var(--text-muted);
    color: var(--text-secondary);
  }
  .live-active {
    border-color: #22c55e;
    color: #22c55e;
    background: rgba(34, 197, 94, 0.1);
  }
  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .live-dot-on {
    background: #22c55e;
    box-shadow: 0 0 4px #22c55e;
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* -- Live container ------------------------------------------------------ */
  .live-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .live-error {
    padding: 0.5rem 0.75rem;
    background: rgba(248, 81, 73, 0.1);
    color: var(--accent-red);
    font-size: 0.6875rem;
    border-bottom: 1px solid var(--border);
  }

  .live-messages {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .live-msg {
    padding: 0.5rem 0.625rem;
    border-radius: 6px;
    font-size: 0.75rem;
    line-height: 1.5;
  }

  .live-msg-role {
    display: block;
    font-size: 0.5625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.25rem;
  }

  .live-msg-content {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .live-msg-user {
    background: rgba(88, 166, 255, 0.08);
    border: 1px solid rgba(88, 166, 255, 0.15);
  }
  .live-msg-user .live-msg-role { color: var(--accent-blue); }

  .live-msg-assistant {
    background: var(--bg-primary);
    border: 1px solid var(--border);
  }
  .live-msg-assistant .live-msg-role { color: #22c55e; }

  .live-msg-system {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    font-size: 0.625rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .live-msg-system .live-msg-role { color: var(--text-muted); }

  .live-msg-streaming {
    border-color: rgba(34, 197, 94, 0.3);
  }

  .streaming-indicator {
    display: inline-block;
    width: 4px;
    height: 12px;
    background: #22c55e;
    border-radius: 1px;
    animation: blink 0.8s infinite;
    vertical-align: text-bottom;
    margin-left: 2px;
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  .live-thinking {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.6875rem;
    padding: 0.5rem;
    animation: pulse 1.5s infinite;
  }

  /* -- Prompt input -------------------------------------------------------- */
  .live-prompt {
    display: flex;
    gap: 0.375rem;
    padding: 0.5rem 0.625rem;
    border-top: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-shrink: 0;
  }

  .prompt-input {
    flex: 1;
    resize: none;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 0.375rem 0.5rem;
    font-size: 0.75rem;
    color: var(--text-primary);
    font-family: inherit;
    line-height: 1.4;
  }
  .prompt-input:focus {
    outline: none;
    border-color: var(--accent-blue);
  }
  .prompt-input:disabled {
    opacity: 0.5;
  }
  .prompt-input::placeholder {
    color: var(--text-muted);
  }

  .prompt-send {
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(88, 166, 255, 0.15);
    border: 1px solid var(--accent-blue);
    border-radius: 5px;
    color: var(--accent-blue);
    font-size: 0.75rem;
    cursor: pointer;
    align-self: flex-end;
    font-family: inherit;
    transition: background 0.1s;
  }
  .prompt-send:hover:not(:disabled) {
    background: rgba(88, 166, 255, 0.25);
  }
  .prompt-send:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Mobile: full width */
  @media (max-width: 480px) {
    .drawer-panel { width: 100vw; }
  }
</style>
