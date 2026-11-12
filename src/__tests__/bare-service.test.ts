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
import { bareServicePattern, pidHeldByOther } from "../bare-service.js";

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
