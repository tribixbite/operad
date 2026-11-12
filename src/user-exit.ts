/**
 * user-exit.ts — retire sessions whose shell the user exited.
 *
 * The health check reports `user_exited` when every pane of an agent
 * session is dead and the exit recorder (or tmux) says the shell ended on
 * its own rather than being killed. Such a session must not be answered
 * with a restart: it is stopped, unstarred, and its project recorded as
 * closed so the next boot does not reopen it either.
 *
 * Split out of the daemon so the state handling is testable against a real
 * StateManager; the daemon supplies the side effects.
 */

import { resolve } from "node:path";
import type { HealthResult, SessionConfig } from "./types.js";
import type { StateManager } from "./state.js";
import type { Logger } from "./log.js";
import { getRuntime } from "./runtimes/index.js";

/** Side effects the daemon performs when retiring a session. */
export interface UserExitDeps {
  state: StateManager;
  log: Logger;
  /** Cancel any pending scheduled restart. */
  cancelRestart: (name: string) => void;
  /** Reap the tmux session (its dead panes). */
  stopSession: (name: string) => void;
  /** Drop activity-tracking state. */
  forgetActivity: (name: string) => void;
  /** Tell the user (dashboard notification). */
  notify: (name: string) => void;
}

/**
 * Retire every session in `results` that the user exited. Runs BEFORE the
 * restart loop in each health sweep, so an exit is never answered with a
 * restart.
 */
export function retireUserExits(
  results: readonly HealthResult[],
  sessions: readonly SessionConfig[],
  respectManualExit: boolean,
  deps: UserExitDeps,
): void {
  if (!respectManualExit) return;
  const { state, log } = deps;

  for (const result of results) {
    if (result.healthy || !result.user_exited) continue;

    const session = sessions.find((c) => c.name === result.session);
    if (!session || !getRuntime(session.type)) continue;

    const s = state.getSession(session.name);
    if (!s || s.suspended) continue;
    // Already retired by an earlier sweep — don't re-log every sweep.
    if (s.status === "stopped" || s.status === "failed") continue;

    deps.cancelRestart(session.name);
    // Reap the dead pane `remain-on-exit` kept for us, so the session
    // doesn't linger in tmux as a corpse.
    deps.stopSession(session.name);
    // Through `stopping`: a session the sweep already marked `degraded` (any
    // failure threshold of 1) cannot go straight to `stopped`, and a refused
    // transition left it degraded — so the restart loop that runs next
    // restarted the session the user had just closed.
    const retired = state.transition(session.name, "stopping")
      && state.transition(session.name, "stopped", "Exited by user");
    if (!retired) {
      log.error(
        `Could not retire exited session '${session.name}' from '${state.getSession(session.name)?.status}'`,
        { session: session.name },
      );
    }
    deps.forgetActivity(session.name);

    // Unstar: an explicit exit is an explicit "not this one".
    state.setAutostartOverride(session.name, false);
    if (session.path) state.recordManualClose(resolve(session.path));

    log.info(
      `Session '${session.name}' was exited (${result.message}) — not restarting; ` +
      `unstarred and excluded from auto-boot until you open it again`,
      { session: session.name },
    );
    deps.notify(session.name);
  }
}
