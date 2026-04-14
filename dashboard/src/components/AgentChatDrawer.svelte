<script lang="ts">
  import type { AgentChatMessage } from "../lib/types";
  import { connect, send, on, wsState } from "../lib/ws.svelte";
  import { fetchAgentChat, clearAgentChat } from "../lib/api";

  interface Props {
    agentName: string;
    agentDescription: string;
    onclose: () => void;
  }
  let { agentName, agentDescription, onclose }: Props = $props();

  /** Chat messages for display */
  let messages: AgentChatMessage[] = $state([]);
  /** Streaming text buffer */
  let streamText = $state("");
  /** Whether a prompt is currently being processed */
  let sending = $state(false);
  /** Prompt input text */
  let promptText = $state("");
  /** Error message */
  let error: string | null = $state(null);
  /** Scroll container ref */
  let scrollEl: HTMLDivElement | undefined = $state();

  // Load history on mount
  $effect(() => {
    loadHistory();
    connect();
    const cleanups = [
      on("agent_chat_result", handleResult),
      on("agent_chat_error", handleError),
      on("agent_chat_start", handleStart),
    ];
    return () => cleanups.forEach((fn) => fn());
  });

  // Auto-scroll on new messages
  $effect(() => {
    if (messages.length || streamText) {
      setTimeout(() => scrollEl?.scrollTo(0, scrollEl.scrollHeight), 50);
    }
  });

  async function loadHistory() {
    try {
      messages = await fetchAgentChat(agentName, 50);
    } catch (err) {
      error = `Failed to load history: ${err}`;
    }
  }

  function handleStart(msg: Record<string, unknown>) {
    if (msg.agentName !== agentName) return;
    sending = true;
    streamText = "";
  }

  function handleResult(msg: Record<string, unknown>) {
    if (msg.agentName !== agentName) return;
    sending = false;
    streamText = "";
    // Add the assistant message to our display
    const content = msg.content as string ?? "";
    const cost = msg.cost as number ?? 0;
    const tokens = msg.tokens as Record<string, number> ?? {};
    messages = [...messages, {
      id: 0,
      agent_name: agentName,
      role: "assistant",
      content,
      session_id: null,
      thinking: null,
      cost_usd: cost,
      tokens_in: tokens.input ?? null,
      tokens_out: tokens.output ?? null,
      created_at: Math.floor(Date.now() / 1000),
    }];
  }

  function handleError(msg: Record<string, unknown>) {
    if (msg.agentName !== agentName) return;
    sending = false;
    error = msg.message as string ?? "Unknown error";
  }

  function handleSend() {
    const text = promptText.trim();
    if (!text || sending) return;

    // Add user message to display immediately
    messages = [...messages, {
      id: 0,
      agent_name: agentName,
      role: "user",
      content: text,
      session_id: null,
      thinking: null,
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      created_at: Math.floor(Date.now() / 1000),
    }];

    // Send via WS
    send({ type: "agent_chat", agentName, prompt: text });
    promptText = "";
    sending = true;
    error = null;
  }

  async function handleClear() {
    if (!confirm(`Clear all conversation history with ${agentName}?`)) return;
    try {
      await clearAgentChat(agentName);
      messages = [];
    } catch (err) {
      error = `Failed to clear: ${err}`;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function formatTime(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
</script>

<!-- Backdrop -->
<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onclose}></div>

<!-- Drawer -->
<div class="drawer">
  <!-- Header -->
  <div class="header">
    <div class="header-left">
      <button class="close-btn" onclick={onclose}>&times;</button>
      <div class="header-info">
        <h3>{agentName}</h3>
        <span class="desc">{agentDescription.slice(0, 80)}</span>
      </div>
    </div>
    <div class="header-right">
      <button class="clear-btn" onclick={handleClear} title="Clear history">Clear</button>
      <span class="ws-dot" class:connected={wsState.status === "connected"}></span>
    </div>
  </div>

  <!-- Messages -->
  <div class="messages" bind:this={scrollEl}>
    {#if messages.length === 0 && !sending}
      <div class="empty">No conversation yet. Send a message to start chatting with {agentName}.</div>
    {/if}

    {#each messages as msg}
      <div class="msg" class:user={msg.role === "user"} class:assistant={msg.role === "assistant"}>
        <div class="msg-header">
          <span class="role-badge" class:user-badge={msg.role === "user"} class:assistant-badge={msg.role === "assistant"}>
            {msg.role === "user" ? "You" : agentName}
          </span>
          <span class="time">{formatTime(msg.created_at)}</span>
          {#if msg.cost_usd}
            <span class="cost">${msg.cost_usd.toFixed(4)}</span>
          {/if}
        </div>
        <div class="msg-content">{msg.content}</div>
      </div>
    {/each}

    {#if sending}
      <div class="msg assistant">
        <div class="msg-header">
          <span class="role-badge assistant-badge">{agentName}</span>
          <span class="thinking-indicator">thinking...</span>
        </div>
        <div class="msg-content streaming">
          <span class="cursor">&#x2588;</span>
        </div>
      </div>
    {/if}

    {#if error}
      <div class="error-msg">{error}</div>
    {/if}
  </div>

  <!-- Input -->
  <div class="input-area">
    <textarea
      bind:value={promptText}
      placeholder={`Message ${agentName}...`}
      onkeydown={handleKeydown}
      disabled={sending}
      rows="2"
    ></textarea>
    <button class="send-btn" onclick={handleSend} disabled={sending || !promptText.trim()}>
      {sending ? "..." : "Send"}
    </button>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 999;
  }
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(480px, 92vw);
    background: #1a1a2e;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    border-left: 1px solid #333;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #333;
    gap: 0.5rem;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .close-btn {
    background: none;
    border: none;
    color: #aaa;
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0 0.25rem;
  }
  .header-info {
    min-width: 0;
  }
  .header-info h3 {
    margin: 0;
    font-size: 0.95rem;
    color: #e0e0e0;
  }
  .desc {
    font-size: 0.7rem;
    color: #888;
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .clear-btn {
    background: #333;
    border: 1px solid #555;
    color: #aaa;
    font-size: 0.7rem;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
  }
  .clear-btn:hover { background: #444; }
  .ws-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #666;
  }
  .ws-dot.connected { background: #4caf50; }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .empty {
    color: #666;
    text-align: center;
    padding: 2rem 1rem;
    font-size: 0.85rem;
  }
  .msg {
    max-width: 85%;
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
  }
  .msg.user {
    align-self: flex-end;
    background: #2a3a5c;
  }
  .msg.assistant {
    align-self: flex-start;
    background: #2a2a3e;
  }
  .msg-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.25rem;
    font-size: 0.7rem;
  }
  .role-badge {
    font-weight: 600;
    font-size: 0.65rem;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }
  .user-badge { background: #3b5998; color: #c8d6e5; }
  .assistant-badge { background: #6c3fa0; color: #d4c4e8; }
  .time { color: #777; }
  .cost { color: #4caf50; font-family: monospace; }
  .msg-content {
    color: #ddd;
    font-size: 0.85rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .streaming .cursor {
    animation: blink 1s step-end infinite;
    color: #888;
  }
  @keyframes blink {
    50% { opacity: 0; }
  }
  .thinking-indicator {
    color: #a855f7;
    font-style: italic;
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }
  .error-msg {
    color: #ef4444;
    font-size: 0.8rem;
    padding: 0.5rem;
    background: rgba(239, 68, 68, 0.1);
    border-radius: 6px;
  }
  .input-area {
    border-top: 1px solid #333;
    padding: 0.5rem;
    display: flex;
    gap: 0.5rem;
  }
  .input-area textarea {
    flex: 1;
    background: #222;
    border: 1px solid #444;
    color: #ddd;
    padding: 0.5rem;
    border-radius: 6px;
    font-size: 0.85rem;
    resize: none;
    font-family: inherit;
  }
  .input-area textarea:focus {
    outline: none;
    border-color: #6c3fa0;
  }
  .send-btn {
    background: #6c3fa0;
    border: none;
    color: white;
    padding: 0 1rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .send-btn:hover:not(:disabled) { background: #7c4fb0; }
  .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
