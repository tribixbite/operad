/**
 * process-group.test.ts — stopping a bare service stops its whole group.
 *
 * Found on the author's device: stopping `x2d` SIGTERMed its process group,
 * then escalated to SIGKILL on the leader PID only. x2d's camera daemon
 * (`beambam.cli camera`) handles SIGTERM and kept running, orphaned, after
 * every stop — and the next launch reused it.
 */

import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { terminateProcessGroup } from "../process-group.js";

const isPosix = process.platform !== "win32";

/** True while `pid` exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait (bounded) until `cond` holds. */
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe.skipIf(!isPosix)("terminateProcessGroup", () => {
  test("a group member that ignores SIGTERM is killed too", async () => {
    // Leader runs a child that ignores TERM, prints its PID, then waits.
    const leader = spawn("bash", ["-c", "(trap '' TERM; exec sleep 60) & echo $!; wait"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const childPid = await new Promise<number>((resolve) =>
      leader.stdout!.once("data", (d) => resolve(parseInt(String(d), 10))),
    );
    try {
      expect(alive(childPid)).toBe(true);
      await terminateProcessGroup(leader.pid!, 300);
      expect(await until(() => !alive(childPid))).toBe(true);
      expect(await until(() => !alive(leader.pid!))).toBe(true);
    } finally {
      try { process.kill(-leader.pid!, "SIGKILL"); } catch { /* gone */ }
    }
  });

  test("a group whose members all exit on SIGTERM needs no escalation", async () => {
    const leader = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    try {
      await terminateProcessGroup(leader.pid!, 300);
      expect(await until(() => !alive(leader.pid!))).toBe(true);
    } finally {
      try { process.kill(-leader.pid!, "SIGKILL"); } catch { /* gone */ }
    }
  });

  test("a PID that leads no group (e.g. a child of `sh -c`) is still stopped", async () => {
    // Process in the test runner's own group: kill(-pid) has no group to hit.
    const proc = spawn("sleep", ["60"], { stdio: "ignore" });
    try {
      await terminateProcessGroup(proc.pid!, 300);
      expect(await until(() => !alive(proc.pid!))).toBe(true);
    } finally {
      try { proc.kill("SIGKILL"); } catch { /* gone */ }
    }
  });
});
