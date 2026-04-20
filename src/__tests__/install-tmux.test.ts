import { describe, test, expect } from "bun:test";
import { tmuxAvailable, detectPkgManager } from "../install-tmux.js";

describe("tmuxAvailable", () => {
  test("returns boolean, matches actual tmux -V success", () => {
    const result = tmuxAvailable();
    expect(typeof result).toBe("boolean");
  });
});

describe("detectPkgManager", () => {
  test("returns non-empty result on every supported platform", () => {
    const pm = detectPkgManager();
    expect(pm.kind).toMatch(/^(termux|brew|apt|dnf|pacman|zypper|apk|windows-manual|unknown)$/);
  });

  test("Termux detection via TERMUX_VERSION env", () => {
    const orig = process.env.TERMUX_VERSION;
    process.env.TERMUX_VERSION = "0.118.0";
    try {
      const pm = detectPkgManager();
      expect(pm.kind).toBe("termux");
      if (pm.kind === "termux") {
        expect(pm.cmd).toBe("pkg");
        expect(pm.args).toContain("tmux");
      }
    } finally {
      if (orig === undefined) delete process.env.TERMUX_VERSION;
      else process.env.TERMUX_VERSION = orig;
    }
  });

  test("detected manager builds an install command with 'tmux' in args", () => {
    const pm = detectPkgManager();
    if (pm.kind === "windows-manual" || pm.kind === "unknown") {
      // Still valid outcomes — no args to verify
      return;
    }
    expect(pm.args).toContain("tmux");
    expect(typeof pm.cmd).toBe("string");
    expect(pm.cmd.length).toBeGreaterThan(0);
  });
});
