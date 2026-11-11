/**
 * conversation-pin.ts — keep a running session's conversation id current.
 *
 * For runtimes that can locate their own conversations (agy, Codex — see
 * runtimes/conversations.ts), the monitoring poll asks every so often which
 * conversation the session is on and records it, so a restart resumes that
 * exact conversation instead of "the project's most recent".
 *
 * Two rules keep the answer honest:
 *
 *  - Only conversations written at or after the moment the agent was first
 *    seen running in the pane (less a small slack for detection lag) count.
 *    A conversation this run never touched is never claimed.
 *  - Lookups are throttled per session. The poll runs every few seconds and
 *    each lookup reads another tool's index; the id changes rarely.
 */

import type { SessionRuntime } from "./runtimes/runtime.js";

/**
 * How far before "first seen" a conversation write may be and still count.
 * Runtime detection lags the agent's start by up to two polls (~10 s), and
 * a resumed conversation is written as it loads, so a small window is
 * needed for the first write not to predate the anchor.
 */
export const PIN_SINCE_SLACK_MS = 30_000;

/** Default minimum time between lookups for one session. */
const DEFAULT_PIN_INTERVAL_MS = 60_000;

/** The part of a runtime the pinner uses. */
type Locator = Pick<SessionRuntime, "latestConversationId">;

export class ConversationPinner {
  /** session → when its agent was first seen running (ms). */
  private firstSeen = new Map<string, number>();
  /** session → when it was last looked up (ms). */
  private lastLookup = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly intervalMs: number = DEFAULT_PIN_INTERVAL_MS,
  ) {}

  /**
   * Called once per poll for a session.
   *
   * @param runtime  the session's runtime while its agent is running in the
   *                 pane, or null when it isn't (pane at a shell, another
   *                 tool running) — which ends the current run's anchor.
   * @param path     the session's project directory.
   * @param current  the conversation id already recorded.
   * @returns a conversation id to record, or null for "no change".
   */
  observe(name: string, runtime: Locator | null, path: string | undefined, current: string | undefined): string | null {
    if (runtime === null) {
      this.forget(name);
      return null;
    }
    if (!runtime.latestConversationId || !path) return null;

    const now = this.now();
    let first = this.firstSeen.get(name);
    if (first === undefined) {
      first = now;
      this.firstSeen.set(name, first);
    }
    const last = this.lastLookup.get(name);
    if (last !== undefined && now - last < this.intervalMs) return null;
    this.lastLookup.set(name, now);

    const id = runtime.latestConversationId(path, first - PIN_SINCE_SLACK_MS);
    return id !== null && id !== current ? id : null;
  }

  /** Drop all state for a session (stopped, removed, or switched runtime). */
  forget(name: string): void {
    this.firstSeen.delete(name);
    this.lastLookup.delete(name);
  }
}
