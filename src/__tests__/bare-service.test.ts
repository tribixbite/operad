/**
 * bare-service.test.ts — finding a bare (non-tmux) service's process.
 *
 * Found on the live daemon: `x2d` "late-adopted" PID 28305, which was the
 * `termux-x11` service's X server. x2d's launch command starts the X server
 * itself when it is not running, so it CONTAINS "termux-x11" — and the
 * pattern lookup tested for termux-x11 before x2d's own `run_gui.sh`, handing
 * x2d the X server's pattern. Its health check then saw the wrong command
 * line ("expected 'run_gui.sh'") and the two services fought over one PID.
 */

import { describe, test, expect } from "bun:test";
import {
  bareServicePattern,
  pidHeldByOther,
  bareServiceBootDecision,
  parseElapsed,
  pickBareServicePid,
} from "../bare-service.js";

// The commands from the author's config, verbatim in shape.
const X11 = `rm -f $PREFIX/tmp/.X1-lock; termux-x11 :1 -legacy-drawing -xstartup 'sh -c "xfwm4 & exec xfce4-session"'`;
const X2D = `sh -c 'pgrep -f "[c]om[.]termux[.]x11[.]Loader :1" >/dev/null || (termux-x11 :1 -ac &); cd ~/git/x2d && DISPLAY=:1 exec ./run_gui.sh'`;
const LOADER = "/system/bin/app_process -Xnoimage-dex2oat / com.termux.x11.Loader :1 -legacy-drawing";
const GUI = "bash ./run_gui.sh";

describe("bareServicePattern", () => {
  test("a command that merely starts the X server is matched by its own process", () => {
    const p = bareServicePattern(X2D)!;
    expect(p.test(GUI)).toBe(true);
    expect(p.test(LOADER)).toBe(false);
  });

  test("the X server service matches the X server", () => {
    const p = bareServicePattern(X11)!;
    expect(p.test(LOADER)).toBe(true);
    expect(p.test(GUI)).toBe(false);
  });

  test("a configured health process_pattern wins over the heuristics", () => {
    const p = bareServicePattern(X2D, "BambuStudio")!;
    expect(p.test("/opt/x2d/BambuStudio --gl")).toBe(true);
    expect(p.test(GUI)).toBe(false);
  });

  test("a pattern that is not a valid regex is matched literally", () => {
    const p = bareServicePattern("whatever", "foo(bar")!;
    expect(p.test("run foo(bar now")).toBe(true);
  });

  test("playwright's MCP server", () => {
    expect(bareServicePattern("bunx @playwright/mcp --port 8931")!.test("node /x/@playwright/mcp/cli.js")).toBe(true);
  });

  /**
   * Found on the live daemon: `operad start x2d` reported "already running"
   * and adopted PID 26434 — a shell running a status check whose awk script
   * contained "bambu-studio|beambam\\.cli|run_gui". The restart then killed
   * that shell's process group. A heuristic must identify the process by the
   * program it runs, not by text anywhere in its arguments.
   */
  test("a command that only mentions the service's names is not the service", () => {
    const x2d = bareServicePattern(X2D)!;
    for (const bystander of [
      `/usr/bin/bash -c ps -eo pid,args | awk '/bambu-studio|beambam\\.cli|run_gui/ && !/awk/'`,
      "rg -n bambu-studio run_gui.sh",
      "vim /home/u/git/x2d/run_gui.sh",
      "tail -f /home/u/.local/share/tmx/logs/bare-x2d.log",
    ]) {
      expect({ bystander, matched: x2d.test(bystander) }).toEqual({ bystander, matched: false });
    }
    const x11 = bareServicePattern(X11)!;
    expect(x11.test(`pgrep -f com.termux.x11.Loader :1`)).toBe(false);
    expect(x11.test(`sh -c pgrep -f "com.termux.x11.Loader :1" || termux-x11 :1`)).toBe(false);
    const pw = bareServicePattern("bunx @playwright/mcp --port 8931")!;
    expect(pw.test("rg -n playwright.*mcp src/")).toBe(false);
  });

  test("the service's own process forms all match", () => {
    const x2d = bareServicePattern(X2D)!;
    for (const own of [
      "/data/data/com.termux/files/home/git/x2d/bs-bionic/build/src/bambu-studio",
      "/opt/x2d/BambuStudio --gl",
      "bash ./run_gui.sh",
      "/data/data/com.termux/files/usr/bin/bash ./run_gui.sh",
      "sh /home/u/git/x2d/run_gui.sh --debug",
    ]) {
      expect({ own, matched: x2d.test(own) }).toEqual({ own, matched: true });
    }
    expect(bareServicePattern(X11)!.test(LOADER)).toBe(true);
    const pw = bareServicePattern("bunx @playwright/mcp --port 8931")!;
    expect(pw.test("npx @playwright/mcp --port 8931")).toBe(true);
    expect(pw.test("/usr/bin/node /x/node_modules/@playwright/mcp/cli.js --port 8931")).toBe(true);
    expect(pw.test("node /x/mcp-server-playwright/dist/index.js")).toBe(true);
  });

  test("an unrecognised command has no pattern (too loose to guess)", () => {
    expect(bareServicePattern("sleep 3 && DISPLAY=:1 bun foo")).toBeNull();
    expect(bareServicePattern(undefined)).toBeNull();
  });
});

describe("pidHeldByOther", () => {
  test("a PID another session already adopted is not available", () => {
    const adopted = new Map([["termux-x11", 28305]]);
    expect(pidHeldByOther(28305, "x2d", adopted)).toBe(true);
    expect(pidHeldByOther(28305, "termux-x11", adopted)).toBe(false);
    expect(pidHeldByOther(999, "x2d", adopted)).toBe(false);
  });
});

/**
 * Found on the live daemon: a daemon restart left `x2d` "running" in
 * state.json with no process behind it. Boot's stale-state recovery skipped
 * bare services ("tracked via adoptedPids") — but a fresh daemon's
 * adoptedPids is empty, so startSession returned early on "running" and
 * nothing started it until two failed health checks and a restart backoff.
 */
describe("bareServiceBootDecision", () => {
  test("an active service whose process is alive is adopted", () => {
    for (const status of ["running", "degraded", "starting", "stopping"] as const) {
      expect(bareServiceBootDecision(status, 4242)).toEqual({ kind: "adopt", pid: 4242 });
    }
  });

  test("an active service with no process is stale, so boot starts it", () => {
    for (const status of ["running", "degraded", "starting", "stopping"] as const) {
      expect(bareServiceBootDecision(status, null)).toEqual({ kind: "stale" });
    }
  });

  test("a stopped or not-yet-started service is left alone, process or not", () => {
    for (const status of ["stopped", "pending", "waiting", "failed", undefined] as const) {
      expect(bareServiceBootDecision(status, 4242)).toEqual({ kind: "leave" });
      expect(bareServiceBootDecision(status, null)).toEqual({ kind: "leave" });
    }
  });
});

describe("parseElapsed", () => {
  test("reads every ps etime form", () => {
    expect(parseElapsed("04:01")).toBe(241);
    expect(parseElapsed("1:02:03")).toBe(3723);
    expect(parseElapsed("2-06:38:23")).toBe(2 * 86400 + 6 * 3600 + 38 * 60 + 23);
  });

  test("an unreadable value is null", () => {
    expect(parseElapsed("")).toBeNull();
    expect(parseElapsed("soon")).toBeNull();
  });
});

/**
 * Found on the live daemon: boot adopted `x2d` as PID 8978 — a `bash
 * ./run_gui.sh` subshell from its bridge watchdog loop, which died a minute
 * later — instead of PID 29163, the service operad had spawned (run_gui.sh
 * exec's BambuStudio, keeping that PID). Subshells keep the script's
 * cmdline, and the first match in ps's PID order won: PIDs wrap, so a fresh
 * subshell can sort first.
 */
describe("pickBareServicePid", () => {
  const P = bareServicePattern(X2D)!;
  const rows = [
    { pid: 8978, pgid: 29163, elapsedS: 2, args: "/usr/bin/bash ./run_gui.sh" },
    { pid: 29163, pgid: 29163, elapsedS: 241, args: "/x2d/bs-bionic/build/src/bambu-studio" },
    { pid: 29199, pgid: 29163, elapsedS: 241, args: "/usr/bin/bash ./run_gui.sh" },
  ];

  test("prefers the process-group leader over its own subshells", () => {
    expect(pickBareServicePid(rows, P)).toBe(29163);
  });

  test("among equals, prefers the longest-running", () => {
    const loose = [
      { pid: 50, pgid: 50, elapsedS: 900, args: "sh -c some-launcher" }, // live, non-matching leader
      { pid: 100, pgid: 50, elapsedS: 5, args: "bash ./run_gui.sh" },
      { pid: 900, pgid: 50, elapsedS: 500, args: "bash ./run_gui.sh" },
    ];
    expect(pickBareServicePid(loose, P)).toBe(900);
  });

  test("a non-leader is still found when no leader matches (termux-x11's Loader under sh)", () => {
    const x11 = [
      { pid: 10, pgid: 10, elapsedS: 900, args: "sh -c rm -f lock; termux-x11 :1" },
      { pid: 11, pgid: 10, elapsedS: 899, args: LOADER },
    ];
    expect(pickBareServicePid(x11, bareServicePattern(X11)!)).toBe(11);
  });

  test("an orphan whose group leader is gone is not a running service", () => {
    // Seen live: a restart found a watchdog subshell left over from an older
    // x2d group, called x2d "already running" and adopted it; it exited 43 s
    // later and x2d was left stopped.
    const orphaned = [{ pid: 9038, pgid: 29163, elapsedS: 600, args: "/usr/bin/bash ./run_gui.sh" }];
    expect(pickBareServicePid(orphaned, P)).toBeNull();
  });

  test("excluded PIDs (owned by another session) are skipped", () => {
    expect(pickBareServicePid(rows, P, (pid) => pid === 29163)).toBe(29199);
  });

  test("no match is null", () => {
    expect(pickBareServicePid(rows, /nothing-here/)).toBeNull();
  });
});

// Needs POSIX `ps -eo pid,pgid` and process groups; Windows has neither.
describe.skipIf(process.platform === "win32")("findBareServicePid (real ps)", () => {
  test("finds a detached service's group leader, not its subshell", async () => {
    const { spawn } = await import("node:child_process");
    const { findBareServicePid } = await import("../session.js");
    const marker = `operad-bare-pick-${process.pid}-${Date.now()}`;
    // bash keeps its script cmdline in the forked subshell, like run_gui.sh.
    const child = spawn("bash", ["-c", `( sleep 30 ) & sleep 30 # ${marker}`], {
      detached: true,
      stdio: "ignore",
    });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(findBareServicePid(new RegExp(marker))).toBe(child.pid!);
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
  });
});
