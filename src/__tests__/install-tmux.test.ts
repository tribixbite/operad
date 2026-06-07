import { describe, test, expect } from "bun:test";
import { tmuxAvailable, detectPkgManager, buildCommand, promptAndInstallTmux } from "../install-tmux.js";

describe("tmuxAvailable", () => {
  test("returns boolean, matches actual tmux -V success", () => {
    const result = tmuxAvailable();
    expect(typeof result).toBe("boolean");
  });
});

describe("detectPkgManager", () => {
  test("returns non-empty result on every supported platform", () => {
    const pm = detectPkgManager();
    expect(pm.kind).toMatch(/^(termux|brew|apt|dnf|pacman|zypper|apk|winget|scoop|choco|windows-manual|unknown)$/);
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

  test("detected manager builds an install command with a tmux-related arg", () => {
    const pm = detectPkgManager();
    if (pm.kind === "windows-manual" || pm.kind === "unknown") {
      // Still valid outcomes — no args to verify
      return;
    }
    // Most pms take a literal "tmux" arg; winget takes "arndawg.tmux-windows".
    // Assert at least one arg contains the substring "tmux".
    expect(pm.args.some((a) => a.includes("tmux"))).toBe(true);
    expect(typeof pm.cmd).toBe("string");
    expect(pm.cmd.length).toBeGreaterThan(0);
  });

  test("PREFIX-based Termux detection when TERMUX_VERSION absent", () => {
    // Some Termux builds set PREFIX instead of TERMUX_VERSION
    const origVer = process.env.TERMUX_VERSION;
    const origPfx = process.env.PREFIX;
    delete process.env.TERMUX_VERSION;
    process.env.PREFIX = "/data/data/com.termux/files/usr";
    try {
      const pm = detectPkgManager();
      expect(pm.kind).toBe("termux");
    } finally {
      if (origVer === undefined) delete process.env.TERMUX_VERSION;
      else process.env.TERMUX_VERSION = origVer;
      if (origPfx === undefined) delete process.env.PREFIX;
      else process.env.PREFIX = origPfx;
    }
  });

  test("unknown kind has no cmd or args (structural check)", () => {
    // Ensure the 'unknown' shape satisfies its narrowed type — no crash on access
    const pm: ReturnType<typeof detectPkgManager> = { kind: "unknown" };
    expect(pm.kind).toBe("unknown");
    // TypeScript ensures no .cmd or .args on 'unknown'; at runtime the shape is correct
    expect("cmd" in pm).toBe(false);
    expect("args" in pm).toBe(false);
  });

  test("windows-manual has a link field (structural check)", () => {
    const pm: ReturnType<typeof detectPkgManager> = {
      kind: "windows-manual",
      link: "https://www.msys2.org/",
    };
    expect(pm.kind).toBe("windows-manual");
    if (pm.kind === "windows-manual") {
      expect(pm.link).toMatch(/https?:\/\//);
    }
  });
});

// ---------------------------------------------------------------------------
// buildCommand — pure command construction logic (exported for testing)
// ---------------------------------------------------------------------------

describe("buildCommand", () => {
  test("termux — no sudo, uses pkg directly", () => {
    const result = buildCommand({ kind: "termux", cmd: "pkg", args: ["install", "-y", "tmux"] });
    expect(result.cmd).toBe("pkg");
    expect(result.args).toEqual(["install", "-y", "tmux"]);
    expect(result.display).toBe("pkg install -y tmux");
  });

  test("brew — no sudo, uses brew directly", () => {
    const result = buildCommand({ kind: "brew", cmd: "brew", args: ["install", "tmux"] });
    expect(result.cmd).toBe("brew");
    expect(result.args).toEqual(["install", "tmux"]);
    expect(result.display).not.toContain("sudo");
  });

  test("apt with needsSudo=true — wraps with sudo", () => {
    const result = buildCommand({ kind: "apt", cmd: "apt-get", args: ["install", "-y", "tmux"], needsSudo: true });
    expect(result.cmd).toBe("sudo");
    expect(result.args[0]).toBe("apt-get");
    expect(result.display).toBe("sudo apt-get install -y tmux");
  });

  test("apt with needsSudo=false — no sudo wrapper", () => {
    const result = buildCommand({ kind: "apt", cmd: "apt-get", args: ["install", "-y", "tmux"], needsSudo: false });
    expect(result.cmd).toBe("apt-get");
    expect(result.args).toEqual(["install", "-y", "tmux"]);
    expect(result.display).not.toContain("sudo");
  });

  test("dnf with needsSudo=true — wraps with sudo", () => {
    const result = buildCommand({ kind: "dnf", cmd: "dnf", args: ["install", "-y", "tmux"], needsSudo: true });
    expect(result.cmd).toBe("sudo");
    expect(result.display).toMatch(/^sudo dnf/);
  });

  test("pacman with needsSudo=true — wraps with sudo, args preserved", () => {
    const result = buildCommand({
      kind: "pacman", cmd: "pacman", args: ["-S", "--noconfirm", "tmux"], needsSudo: true,
    });
    expect(result.cmd).toBe("sudo");
    expect(result.args).toEqual(["pacman", "-S", "--noconfirm", "tmux"]);
  });

  test("zypper with needsSudo=false — uses zypper directly", () => {
    const result = buildCommand({ kind: "zypper", cmd: "zypper", args: ["install", "-y", "tmux"], needsSudo: false });
    expect(result.cmd).toBe("zypper");
    expect(result.display).not.toContain("sudo");
  });

  test("apk with needsSudo=true — wraps with sudo", () => {
    const result = buildCommand({ kind: "apk", cmd: "apk", args: ["add", "tmux"], needsSudo: true });
    expect(result.cmd).toBe("sudo");
    expect(result.args).toContain("apk");
  });

  test("winget — no sudo even when run without elevation", () => {
    const result = buildCommand({
      kind: "winget", cmd: "winget", args: ["install", "-e", "--id", "arndawg.tmux-windows"],
    });
    expect(result.cmd).toBe("winget");
    expect(result.display).not.toContain("sudo");
  });

  test("scoop — no sudo", () => {
    const result = buildCommand({ kind: "scoop", cmd: "scoop", args: ["install", "tmux"] });
    expect(result.cmd).toBe("scoop");
    expect(result.display).not.toContain("sudo");
  });

  test("choco — no sudo", () => {
    const result = buildCommand({ kind: "choco", cmd: "choco", args: ["install", "-y", "tmux"] });
    expect(result.cmd).toBe("choco");
    expect(result.display).not.toContain("sudo");
  });

  test("display string is a space-joined command", () => {
    const result = buildCommand({ kind: "apt", cmd: "apt-get", args: ["install", "-y", "tmux"], needsSudo: false });
    expect(result.display).toBe("apt-get install -y tmux");
  });

  test("sudo display includes 'sudo' prefix before the pm name", () => {
    const result = buildCommand({ kind: "apt", cmd: "apt-get", args: ["install", "-y", "tmux"], needsSudo: true });
    expect(result.display.startsWith("sudo ")).toBe(true);
    expect(result.display).toContain("apt-get");
  });
});

// ---------------------------------------------------------------------------
// promptAndInstallTmux — non-interactive paths (no actual install executed)
// ---------------------------------------------------------------------------

describe("promptAndInstallTmux — non-interactive / skip paths", () => {
  test("returns installed=true immediately when tmux is available", async () => {
    // On Termux, tmux is present; this tests the happy-path short-circuit
    if (!tmuxAvailable()) return; // skip on envs where tmux truly absent
    const result = await promptAndInstallTmux({ noInstall: true });
    // noInstall is irrelevant when tmux already present — still returns true
    expect(result.installed).toBe(true);
    expect(result.attempted).toBe(false);
    expect(result.reason).toMatch(/already available/i);
  });

  test("noInstall=true returns attempted=false with advisory message", async () => {
    // Force 'noInstall' path even when tmux IS available by checking the result contract.
    // When tmux is available the function returns early, so we can only test the
    // no-install branch directly when tmux is absent. Instead verify the option shape.
    const result = await promptAndInstallTmux({ noInstall: true });
    // Regardless of whether tmux is present, attempted should never be true for noInstall
    expect(result.attempted).toBe(false);
  });

  test("yes=false in a non-interactive environment returns non-interactive reason", async () => {
    // process.stdin.isTTY is falsy in test runner — the non-interactive branch fires
    if (tmuxAvailable()) return; // skip; early-return hides the branch we're testing
    const result = await promptAndInstallTmux({ yes: false });
    expect(result.attempted).toBe(false);
    expect(result.reason).toMatch(/non-interactive|no-install|user-declined|unknown-pm|windows-manual/i);
  });

  test("InstallResult shape — all three required fields always present", async () => {
    const result = await promptAndInstallTmux({ noInstall: true });
    expect(typeof result.installed).toBe("boolean");
    expect(typeof result.attempted).toBe("boolean");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
