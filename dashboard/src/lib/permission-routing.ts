/**
 * permission-routing.ts — which view answers an SDK permission request, and
 * the queue of agent-run requests waiting for an answer.
 *
 * Requests arrive on WebSocket rooms. A session's room is its session name;
 * a standalone agent run's (OODA, scheduled, manual) is the agent's name.
 * Both are bare names and can collide, so the daemon tags each request with
 * `kind` and `room`, and each view takes only its own:
 *
 *  - ConversationDrawer: requests for the session it is attached to;
 *  - AgentPermissionWatcher: requests from any agent run.
 *
 * Plain TS with no Svelte or `$lib` imports, so the daemon's test suite can
 * exercise it directly.
 */

/** The fields of a `permission_request` message this module reads. */
export interface PermissionRequestLike {
  type: "permission_request";
  id: string;
  /** Present from daemons that tag requests; absent from older ones. */
  kind?: "session" | "agent";
  room?: string;
}

/** True for a request raised by a standalone agent run. */
export function isAgentPermissionRequest<T extends PermissionRequestLike>(
  msg: T,
): msg is T & { kind: "agent"; room: string } {
  return msg.kind === "agent" && typeof msg.room === "string" && msg.room !== "";
}

/**
 * True when the drawer attached to `sessionName` should show `msg`. Untagged
 * requests (an older daemon) only ever came from attached sessions, and
 * the drawer is subscribed to exactly one room, so it keeps them.
 */
export function isSessionPermissionFor(msg: PermissionRequestLike, sessionName: string): boolean {
  if (msg.kind === "agent") return false;
  return msg.room === undefined || msg.room === sessionName;
}

/** The rooms to watch for agent-run requests: every enabled agent's. */
export function agentRoomsToWatch(agents: ReadonlyArray<{ name: string; enabled: boolean }>): string[] {
  return agents.filter((a) => a.enabled).map((a) => a.name);
}

/** How many answered ids to remember for de-duplicating replays. */
const ANSWERED_MEMORY = 200;

/**
 * Agent-run requests waiting for an answer, shown one at a time, oldest
 * first.
 *
 * The same request can arrive twice: live, and again when the socket
 * reconnects and the daemon replays what is outstanding in each re-joined
 * room. Ids already queued, or already answered here, are ignored.
 */
export class PermissionQueue<T extends PermissionRequestLike = PermissionRequestLike> {
  private items: T[] = [];
  private answered: string[] = [];

  /** Queue a request unless it is already queued or was answered here. */
  add(msg: T): void {
    if (this.answered.includes(msg.id)) return;
    if (this.items.some((m) => m.id === msg.id)) return;
    this.items = [...this.items, msg];
  }

  /** Drop a request (answered or timed out) and remember that it was. */
  remove(id: string): void {
    this.items = this.items.filter((m) => m.id !== id);
    this.answered = [...this.answered, id].slice(-ANSWERED_MEMORY);
  }

  /** The request to show now, or null. */
  get current(): T | null {
    return this.items[0] ?? null;
  }

  /** Number of requests waiting. */
  get size(): number {
    return this.items.length;
  }
}
