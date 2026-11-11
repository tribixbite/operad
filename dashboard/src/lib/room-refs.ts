/**
 * room-refs.ts — reference counts for WebSocket room subscriptions.
 *
 * The ws layer is one socket shared by every component on the page, and
 * more than one component can want the same room (a session drawer and the
 * agent-permission watcher, when an agent shares a session's name). With a
 * plain set, whichever left first unsubscribed the other. Plain TS so the
 * daemon's test suite can exercise it.
 */
export class RoomRefs {
  private counts = new Map<string, number>();

  /** Record a join. True when this is the first holder — send `subscribe`. */
  join(room: string): boolean {
    const n = this.counts.get(room) ?? 0;
    this.counts.set(room, n + 1);
    return n === 0;
  }

  /** Record a leave. True when that was the last holder — send `unsubscribe`. */
  leave(room: string): boolean {
    const n = this.counts.get(room);
    if (n === undefined) return false;
    if (n <= 1) {
      this.counts.delete(room);
      return true;
    }
    this.counts.set(room, n - 1);
    return false;
  }

  /** Rooms with at least one holder (re-joined after a reconnect). */
  rooms(): IterableIterator<string> {
    return this.counts.keys();
  }
}
