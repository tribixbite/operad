<script lang="ts">
  /**
   * AgentPermissionWatcher — answers permission requests from standalone
   * agent runs (OODA cycles, scheduled runs, manual runs), wherever the user
   * is in the dashboard.
   *
   * An agent run's requests go to the agent's WebSocket room, which no other
   * view subscribes to: without this, every tool call needing approval waited
   * out its five-minute timeout and was denied with nobody having been asked.
   * Mounted once in the root layout, it subscribes to every enabled agent's
   * room (so a run that starts later is covered too), and the daemon replays
   * anything already outstanding when it subscribes — a dashboard opened
   * mid-run still gets the prompt. Requests are shown one at a time.
   */
  import PermissionModal from "./PermissionModal.svelte";
  import type { SdkPermissionRequest } from "$lib/types";
  import { connect, subscribe, unsubscribe, on } from "$lib/ws.svelte";
  import { fetchAgents } from "$lib/api";
  import { isAgentPermissionRequest, agentRoomsToWatch, PermissionQueue } from "$lib/permission-routing";

  /**
   * Outstanding agent-run requests; `current` is the one on screen. A plain
   * object — `$state` does not proxy class instances — so `version` is the
   * reactive signal, bumped on every change.
   */
  const queue = new PermissionQueue<SdkPermissionRequest>();
  let version = $state(0);
  const current = $derived.by(() => { void version; return queue.current; });

  /** Rooms this component subscribed to (and must leave on destroy). */
  const rooms = new Set<string>();

  function watch(room: string): void {
    if (rooms.has(room)) return;
    rooms.add(room);
    subscribe(room);
  }

  $effect(() => {
    connect();

    // Every enabled agent's room up front: a request raised before this
    // component knew a run had started is replayed on subscribe.
    fetchAgents()
      .then((agents) => { for (const room of agentRoomsToWatch(agents)) watch(room); })
      .catch(() => { /* not authenticated yet, or daemon down — runs below still subscribe */ });

    const offRun = on("agent_run_update", (msg) => {
      // An agent enabled after load, or one the list fetch missed.
      if (msg.status === "running" && typeof msg.agentName === "string") watch(msg.agentName);
    });
    const offPerm = on("permission_request", (msg) => {
      const req = msg as unknown as SdkPermissionRequest;
      if (!isAgentPermissionRequest(req)) return;
      queue.add(req);
      version++;
    });

    return () => {
      offRun();
      offPerm();
      for (const room of rooms) unsubscribe(room);
      rooms.clear();
    };
  });

  /** The modal answered or timed out: drop it and show the next one. */
  function dismiss(id: string): void {
    queue.remove(id);
    version++;
  }
</script>

{#if current}
  {#key current.id}
    <PermissionModal
      request={current}
      sessionName={current.room ?? ""}
      ondismiss={() => dismiss(current.id)}
    />
  {/key}
{/if}
