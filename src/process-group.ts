/**
 * process-group.ts — stop a detached process and everything in its group.
 *
 * Bare services are spawned detached, so each leads its own process group,
 * and the group is the unit to stop: helpers, watchdog subshells and the
 * programs they run all live in it. SIGTERM goes to the whole group; after
 * the grace period SIGKILL goes to the whole group too. Escalating on the
 * leader alone leaked every member that handles SIGTERM itself — x2d's
 * camera daemon outlived each stop and was reused, orphaned, by the next.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Send `sig` to the process group `pid` leads, or to `pid` alone when it
 * leads no group (e.g. a program running under the `sh -c` operad spawned).
 * Returns false when nothing was there to signal. Signal 0 only probes.
 */
export function signalProcessGroup(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, sig); // negative pid = the whole group
    return true;
  } catch {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false; // already gone
    }
  }
}

/**
 * SIGTERM `pid`'s process group, wait `graceMs`, then SIGKILL whatever of it
 * is left. Signal 0 probes for survivors without disturbing them.
 *
 * The caller must already have checked that `pid` is the process it means
 * (see the stale-PID guard in the daemon's stop path); within the grace
 * period it cannot have been reused, since the kernel does not hand out a
 * PID that is still in use as a process-group id.
 */
export async function terminateProcessGroup(pid: number, graceMs: number): Promise<void> {
  if (!signalProcessGroup(pid, "SIGTERM")) return;
  await sleep(graceMs);
  if (signalProcessGroup(pid, 0)) {
    signalProcessGroup(pid, "SIGKILL");
  }
}
