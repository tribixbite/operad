/**
 * unfreeze.test.ts — `operad unfreeze`: making a session that ignores keys
 * take them again.
 *
 * The pure parsers and the summary are tested directly. unfreezeSession()
 * itself runs against a private tmux server (OPERAD_TMUX_SOCKET → `-L`),
 * never the user's: a pane whose process is SIGSTOPped, in copy mode and
 * with input disabled must come back from all three, and a pane whose
 * program exited must be reported, not "fixed".
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import {
  parsePaneFlags,
  procStateFromStat,
  describeUnfreeze,
  unfreezeSession,
  tmuxServerArgs,
  PANE_FLAGS_FORMAT,
  type UnfreezeReport,
} from "../session.js";
import { silentLog } from "./helpers/fake-context.js";

describe("parsePaneFlags", () => {
  test("reads a live pane in copy mode with input disabled", () => {
    expect(parsePaneFlags("%3|1234|1|1|0")).toEqual({ id: "%3", pid: 1234, inMode: true, inputOff: true, dead: false });
  });

  test("reads a dead pane", () => {
    expect(parsePaneFlags("%0|99|0|0|1")?.dead).toBe(true);
  });

  test("rejects malformed lines", () => {
    expect(parsePaneFlags("")).toBeNull();
    expect(parsePaneFlags("3|1234|0|0|0")).toBeNull(); // no % pane id
    expect(parsePaneFlags("%3|x|0|0|0")).toBeNull();
    expect(parsePaneFlags("%3|1|0|0")).toBeNull();
  });
});

describe("procStateFromStat", () => {
  test("reads the state after the command name", () => {
    expect(procStateFromStat("5563 (bun-termux) T 5526 5563 5524")).toBe("T");
    expect(procStateFromStat("1 (init) S 0 1 1")).toBe("S");
  });

  test("a command name containing spaces and ')' does not shift the field", () => {
    expect(procStateFromStat("42 (a) b) R 1 42 42")).toBe("R");
  });

  test("garbage → null", () => {
    expect(procStateFromStat("no parens here")).toBeNull();
    expect(procStateFromStat("7 (x)")).toBeNull();
  });
});

describe("describeUnfreeze", () => {
  const base: UnfreezeReport = { panes: 1, continued: 0, modesCancelled: 0, inputsEnabled: 0, deadPanes: 0 };

  test("names everything it fixed", () => {
    const msg = describeUnfreeze("ck", { ...base, continued: 29, modesCancelled: 1, inputsEnabled: 1 });
    expect(msg).toContain("continued 29 stopped process(es)");
    expect(msg).toContain("left copy/view mode in 1 pane(s)");
    expect(msg).toContain("re-enabled input in 1 pane(s)");
  });

  test("with nothing stuck it points at the program instead", () => {
    expect(describeUnfreeze("ck", base)).toContain("busy or waiting");
  });

  test("dead panes are reported, with restart as the fix", () => {
    const msg = describeUnfreeze("ck", { ...base, deadPanes: 1 });
    expect(msg).toContain("1 pane(s) have exited");
    expect(msg).not.toContain("busy or waiting");
  });

  test("no panes at all", () => {
    expect(describeUnfreeze("ck", { ...base, panes: 0 })).toBe("No tmux panes found for 'ck'");
  });
});

const HAS_TMUX = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const HAS_PROC = (() => { try { readFileSync("/proc/self/stat"); return true; } catch { return false; } })();
const SOCKET = `operad-unfreeze-test-${process.pid}`;

/** Run tmux against the private test server only. */
function t(...args: string[]): string {
  const r = spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf-8", timeout: 5000 });
  return (r.stdout ?? "").trim();
}

/** State letter of `pid` from /proc. */
function stateOf(pid: number): string | null {
  return procStateFromStat(readFileSync(`/proc/${pid}/stat`, "utf-8"));
}

describe.skipIf(!HAS_TMUX || !HAS_PROC)("unfreezeSession (isolated tmux server)", () => {
  beforeAll(() => {
    process.env.OPERAD_TMUX_SOCKET = SOCKET;
  });

  afterAll(() => {
    // kill-server is a silent no-op when the server inherited a blocked
    // signal mask (it does from an agent's sandboxed shell): SIGKILL it and
    // remove the socket it can then not unlink itself.
    const [pidRaw = "", socketPath = ""] = t("list-sessions", "-F", "#{pid}|#{socket_path}").split("\n")[0].split("|");
    spawnSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
    const serverPid = Number(pidRaw);
    if (serverPid > 0) {
      try { process.kill(serverPid, "SIGKILL"); } catch { /* already gone */ }
    }
    if (socketPath) rmSync(socketPath, { force: true });
    delete process.env.OPERAD_TMUX_SOCKET;
  });

  test("every tmux call is pointed at the private server", () => {
    expect(tmuxServerArgs()).toEqual(["-L", SOCKET]);
  });

  test("continues a stopped pane, leaves copy mode and re-enables input", async () => {
    t("new-session", "-d", "-s", "uf", "-x", "80", "-y", "24", "sleep 600");
    const pid = Number(t("list-panes", "-t", "=uf:", "-F", "#{pane_pid}"));
    expect(pid).toBeGreaterThan(1);

    // Freeze it all three ways.
    process.kill(pid, "SIGSTOP");
    t("copy-mode", "-t", "=uf:");
    t("select-pane", "-d", "-t", "=uf:");
    await new Promise((r) => setTimeout(r, 100));
    expect(stateOf(pid)).toBe("T");
    expect(parsePaneFlags(t("list-panes", "-t", "=uf:", "-F", PANE_FLAGS_FORMAT))).toMatchObject({ inMode: true, inputOff: true });

    const report = unfreezeSession("uf", silentLog());
    expect(report).toMatchObject({ panes: 1, continued: 1, modesCancelled: 1, inputsEnabled: 1, deadPanes: 0 });

    await new Promise((r) => setTimeout(r, 100));
    expect(stateOf(pid)).not.toBe("T");
    expect(parsePaneFlags(t("list-panes", "-t", "=uf:", "-F", PANE_FLAGS_FORMAT))).toMatchObject({ inMode: false, inputOff: false });
  });

  test("a second run finds nothing to fix", () => {
    expect(unfreezeSession("uf", silentLog())).toMatchObject({ panes: 1, continued: 0, modesCancelled: 0, inputsEnabled: 0 });
  });

  test("a pane whose program exited is reported, not touched", async () => {
    // Start with something long-lived so the session exists while
    // remain-on-exit is set, then swap in a program that exits at once.
    t("new-session", "-d", "-s", "uf-dead", "sleep 600");
    t("set-option", "-w", "-t", "=uf-dead:", "remain-on-exit", "on");
    t("respawn-pane", "-k", "-t", "=uf-dead:", "true");
    const deadline = Date.now() + 3000;
    while (t("list-panes", "-t", "=uf-dead:", "-F", "#{pane_dead}") !== "1" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(unfreezeSession("uf-dead", silentLog())).toMatchObject({ panes: 1, deadPanes: 1, continued: 0 });
  });

  test("an unknown session has no panes", () => {
    expect(unfreezeSession("no-such-session", silentLog()).panes).toBe(0);
  });
});
