/**
 * session-tmux.test.ts — agent-session lifecycle against a REAL tmux server.
 *
 * The pure classifier is covered in session-pure.test.ts; this file covers
 * the parts only tmux can answer, because that is where the bugs were:
 *
 *  - `set-option -t '=name' remain-on-exit on` fails on tmux 3.5a ("no such
 *    window" — the session sigil does not resolve for set-option), and the
 *    failure was swallowed, so no session ever kept its dead pane. No unit
 *    test could see that.
 *  - whether the exit recorder really distinguishes `exit` from SIGKILL
 *    once tmux, the wrapper and a login shell are stacked together.
 *
 * Isolation: every tmux call goes to a private server selected with
 * OPERAD_TMUX_SOCKET (tmux `-L`), never the user's real server — the first
 * test asserts that before anything is created. The server is killed in
 * afterAll.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  tmuxServerArgs,
  setExitRecordDir,
  openTmuxSession,
  applyAgentSessionOptions,
  paneLiveness,
  getSessionPanePids,
  type PaneLiveness,
} from "../session.js";

const HAS_TMUX = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const SOCKET = `operad-test-${process.pid}`;

/** Run tmux against the private test server only. */
function t(...args: string[]): string {
  const r = spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf-8", timeout: 5000 });
  return (r.stdout ?? "").trim();
}

/** Poll paneLiveness until it leaves "alive" (or time out). */
async function waitForDeath(name: string, timeoutMs = 8000): Promise<PaneLiveness> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const l = paneLiveness(name);
    if (l.state !== "alive" || Date.now() > deadline) return l;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Wait until the pane's login shell is up, so keys reach a prompt. */
async function waitForShell(name: string): Promise<number> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const [panePid] = getSessionPanePids(name);
    const child = panePid
      ? spawnSync("pgrep", ["-P", String(panePid)], { encoding: "utf-8" }).stdout.trim().split("\n")[0]
      : "";
    if (child) return Number(child);
    if (Date.now() > deadline) throw new Error(`no shell under pane of ${name}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!HAS_TMUX)("agent tmux sessions (isolated server)", () => {
  let dir: string;

  beforeAll(() => {
    process.env.OPERAD_TMUX_SOCKET = SOCKET;
    dir = mkdtempSync(join(tmpdir(), "operad-tmux-"));
    setExitRecordDir(dir);
  });

  afterAll(() => {
    // `kill-server` works by the server SIGTERMing itself, which silently
    // does nothing when the server inherited a blocked signal mask (it does
    // when the suite runs from an agent's sandboxed shell). Fall back to
    // SIGKILL so a run can never leave a server behind.
    // A SIGKILLed server can't unlink its socket, so remove that too.
    const [pidRaw = "", socketPath = ""] = t("list-sessions", "-F", "#{pid}|#{socket_path}").split("\n")[0].split("|");
    const serverPid = Number(pidRaw);
    spawnSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
    if (serverPid > 0) {
      try { process.kill(serverPid, "SIGKILL"); } catch { /* already gone */ }
    }
    if (socketPath) rmSync(socketPath, { force: true });
    delete process.env.OPERAD_TMUX_SOCKET;
    setExitRecordDir(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("every tmux call is pointed at the private server", () => {
    expect(tmuxServerArgs()).toEqual(["-L", SOCKET]);
  });

  test("remain-on-exit is really set on the session's window", () => {
    expect(openTmuxSession("t-opt", undefined, true)).toBe(true);
    applyAgentSessionOptions("t-opt");
    expect(t("show-options", "-w", "-v", "-t", "=t-opt:", "remain-on-exit")).toBe("on");
  });

  test("windows opened later keep their dead pane too", () => {
    t("new-window", "-t", "=t-opt:");
    const rows = t("list-panes", "-s", "-t", "=t-opt", "-F", "#{window_index}|#{remain-on-exit}");
    expect(rows.split("\n").map((r) => r.split("|")[1])).toEqual(["on", "on"]);
  });

  test("getSessionPanePids returns every window's pane, not just the current one", () => {
    // Memory and activity monitoring root a session's process trees here; a
    // window left out was work operad could not see (and could SIGSTOP).
    expect(getSessionPanePids("t-opt").length).toBe(2);
  });

  test("later windows run under the exit recorder as well", () => {
    expect(t("show-options", "-v", "-t", "=t-opt:", "default-command")).toContain("operad-exit-recorder");
  });

  test("typing `exit 3` is read as the user's exit", async () => {
    openTmuxSession("t-exit", undefined, true);
    applyAgentSessionOptions("t-exit");
    await waitForShell("t-exit");
    t("send-keys", "-t", "=t-exit:", "exit 3", "Enter");
    expect(await waitForDeath("t-exit")).toEqual({ state: "exited", status: 3 });
  });

  test("SIGKILL of the shell is read as a crash", async () => {
    openTmuxSession("t-kill", undefined, true);
    applyAgentSessionOptions("t-kill");
    const shell = await waitForShell("t-kill");
    process.kill(shell, "SIGKILL");
    expect(await waitForDeath("t-kill")).toEqual({ state: "killed", status: 137, signal: 9 });
  });

  test("a session operad did not create is adopted: it keeps its dead pane from now on", () => {
    t("new-session", "-d", "-s", "t-legacy");
    applyAgentSessionOptions("t-legacy");
    expect(t("show-options", "-w", "-v", "-t", "=t-legacy:", "remain-on-exit")).toBe("on");
  });

  test("adopting a session creates the record directory its new windows will write to", () => {
    // The recorder only writes into a directory that exists; adoption sets
    // the recorder as default-command, so it must create the directory too.
    const fresh = join(dir, "not-yet-created");
    setExitRecordDir(fresh);
    try {
      t("new-session", "-d", "-s", "t-adopt-dir");
      applyAgentSessionOptions("t-adopt-dir");
      expect(existsSync(fresh)).toBe(true);
    } finally {
      setExitRecordDir(dir);
    }
  });

  test("without a record dir the session is a plain shell (no recorder)", () => {
    setExitRecordDir(null);
    try {
      openTmuxSession("t-plain", undefined, true);
      expect(t("list-panes", "-t", "=t-plain:", "-F", "#{pane_start_command}")).not.toContain("operad-exit-recorder");
    } finally {
      setExitRecordDir(dir);
    }
  });
});
