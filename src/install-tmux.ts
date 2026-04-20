/**
 * install-tmux.ts — interactive tmux installer
 *
 * Detects the platform's package manager and, on a TTY, offers to install
 * tmux via the native command. Non-interactive environments (CI, piped stdin)
 * fall through to printing instructions and returning without running anything.
 *
 * Design notes:
 * - Termux uses `pkg install tmux` and does NOT need sudo.
 * - macOS uses Homebrew (`brew install tmux`); brew does not need sudo.
 * - Linux uses whichever of apt/dnf/pacman/zypper is on PATH. All need sudo
 *   unless running as root. We invoke `sudo <pm> install -y tmux` and let
 *   the OS prompt for a password if passwordless sudo isn't configured.
 * - Windows can't auto-install MSYS2 (multi-GB GUI installer). We print the
 *   link and exit.
 * - Any install attempt is verified by re-running `tmux -V`.
 */

import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Is tmux already callable? */
export function tmuxAvailable(): boolean {
  const result = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 3000 });
  return !result.error && result.status === 0;
}

type PkgManager =
  | { kind: "termux"; cmd: string; args: string[] }
  | { kind: "brew"; cmd: string; args: string[] }
  | { kind: "apt"; cmd: string; args: string[]; needsSudo: boolean }
  | { kind: "dnf"; cmd: string; args: string[]; needsSudo: boolean }
  | { kind: "pacman"; cmd: string; args: string[]; needsSudo: boolean }
  | { kind: "zypper"; cmd: string; args: string[]; needsSudo: boolean }
  | { kind: "apk"; cmd: string; args: string[]; needsSudo: boolean }
  | { kind: "winget"; cmd: string; args: string[] }
  | { kind: "scoop"; cmd: string; args: string[] }
  | { kind: "choco"; cmd: string; args: string[] }
  | { kind: "windows-manual"; link: string }
  | { kind: "unknown" };

/** Does the given binary resolve on PATH? Works on Unix (`which`) + Windows (`where`). */
function commandExists(bin: string): boolean {
  const probe = process.platform === "win32"
    ? spawnSync("where", [bin], { stdio: "ignore", timeout: 3000 })
    : spawnSync("which", [bin], { stdio: "ignore", timeout: 3000 });
  return probe.status === 0;
}

/** Detect the best package manager for this host. */
export function detectPkgManager(): PkgManager {
  // Termux wins even on Linux-the-kernel-says-so
  if (process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux")) {
    return { kind: "termux", cmd: "pkg", args: ["install", "-y", "tmux"] };
  }
  if (process.platform === "win32") {
    // Prefer winget (pre-installed on Windows 10 1809+ / Windows 11).
    // arndawg.tmux-windows is the community native tmux build for Windows.
    if (commandExists("winget")) {
      return { kind: "winget", cmd: "winget", args: ["install", "-e", "--id", "arndawg.tmux-windows"] };
    }
    if (commandExists("scoop")) {
      // Scoop's tmux lives in the "main" bucket as a WSL-style port.
      return { kind: "scoop", cmd: "scoop", args: ["install", "tmux"] };
    }
    if (commandExists("choco")) {
      // Chocolatey's tmux package ships via msys2; install requires admin shell.
      return { kind: "choco", cmd: "choco", args: ["install", "-y", "tmux"] };
    }
    return { kind: "windows-manual", link: "https://www.msys2.org/" };
  }
  if (process.platform === "darwin") {
    return { kind: "brew", cmd: "brew", args: ["install", "tmux"] };
  }
  // Linux-ish — pick first available pm
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const candidates: Array<{
    bin: string;
    kind: "apt" | "dnf" | "pacman" | "zypper" | "apk";
    args: string[];
  }> = [
    { bin: "apt-get", kind: "apt", args: ["install", "-y", "tmux"] },
    { bin: "dnf", kind: "dnf", args: ["install", "-y", "tmux"] },
    { bin: "pacman", kind: "pacman", args: ["-S", "--noconfirm", "tmux"] },
    { bin: "zypper", kind: "zypper", args: ["install", "-y", "tmux"] },
    { bin: "apk", kind: "apk", args: ["add", "tmux"] },
  ];
  for (const c of candidates) {
    if (commandExists(c.bin)) {
      return { kind: c.kind, cmd: c.bin, args: c.args, needsSudo: !isRoot };
    }
  }
  return { kind: "unknown" };
}

/** Is this process attached to an interactive terminal? */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Yes/no prompt — returns true only on affirmative. Default is yes. */
async function confirm(question: string): Promise<boolean> {
  if (!isInteractive()) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });
  if (answer === "" || answer === "y" || answer === "yes") return true;
  return false;
}

/** Build the full command line for a given pkg manager. */
function buildCommand(pm: Exclude<PkgManager, { kind: "windows-manual" } | { kind: "unknown" }>): {
  cmd: string;
  args: string[];
  display: string;
} {
  // Managers that don't need sudo / run their own elevation.
  if (pm.kind === "termux" || pm.kind === "brew" ||
      pm.kind === "winget" || pm.kind === "scoop" || pm.kind === "choco") {
    return { cmd: pm.cmd, args: pm.args, display: `${pm.cmd} ${pm.args.join(" ")}` };
  }
  // Linux managers may need sudo
  if (pm.needsSudo) {
    return { cmd: "sudo", args: [pm.cmd, ...pm.args], display: `sudo ${pm.cmd} ${pm.args.join(" ")}` };
  }
  return { cmd: pm.cmd, args: pm.args, display: `${pm.cmd} ${pm.args.join(" ")}` };
}

export interface InstallResult {
  /** Was tmux callable at the end? */
  installed: boolean;
  /** Human-readable explanation for logs / user output. */
  reason: string;
  /** Did we actually try to install, or only advise? */
  attempted: boolean;
}

export interface InstallOptions {
  /** Skip the prompt and attempt install directly. */
  yes?: boolean;
  /** Skip install even on TTY; only print instructions. */
  noInstall?: boolean;
}

/**
 * Entry point. If tmux is already installed, returns immediately. Otherwise
 * prompts on TTY and runs the install. Guaranteed not to throw.
 */
export async function promptAndInstallTmux(opts: InstallOptions = {}): Promise<InstallResult> {
  if (tmuxAvailable()) {
    return { installed: true, attempted: false, reason: "tmux already available" };
  }

  const pm = detectPkgManager();

  if (pm.kind === "windows-manual") {
    const msg =
      `tmux has no native Windows port. The community path is MSYS2.\n\n` +
      `  1. Install MSYS2 from ${pm.link}\n` +
      `  2. In an MSYS2 shell: pacman -Syu && pacman -S tmux\n` +
      `  3. Add C:\\msys64\\usr\\bin to your Windows PATH\n` +
      `  4. Alternatively, run operad inside WSL (tmux available via apt there).\n`;
    console.log(msg);
    return { installed: false, attempted: false, reason: "windows-manual" };
  }

  if (pm.kind === "unknown") {
    console.log(
      `Could not detect a supported package manager on this host.\n` +
      `Install tmux manually, then re-run operad.\n`,
    );
    return { installed: false, attempted: false, reason: "unknown-pm" };
  }

  const built = buildCommand(pm);

  // Non-interactive: print instructions and bail unless caller forced `yes`
  if (!isInteractive() && !opts.yes) {
    console.log(
      `tmux is not installed. Install it with:\n  ${built.display}\n`,
    );
    return { installed: false, attempted: false, reason: "non-interactive" };
  }

  if (opts.noInstall) {
    console.log(
      `tmux is not installed. Install it with:\n  ${built.display}\n`,
    );
    return { installed: false, attempted: false, reason: "no-install" };
  }

  // Prompt unless explicitly skipped
  if (!opts.yes) {
    const ok = await confirm(`tmux is required but not installed. Install now with '${built.display}'? [Y/n] `);
    if (!ok) {
      return { installed: false, attempted: false, reason: "user-declined" };
    }
  }

  // Inherit stdio so the user sees progress and can type sudo password if prompted
  console.log(`\nRunning: ${built.display}\n`);
  const result = await new Promise<number>((resolve) => {
    const child = spawn(built.cmd, built.args, { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

  if (result !== 0) {
    return {
      installed: false,
      attempted: true,
      reason: `install command exited with code ${result}`,
    };
  }

  // Re-check
  if (tmuxAvailable()) {
    return { installed: true, attempted: true, reason: "installed successfully" };
  }
  return {
    installed: false,
    attempted: true,
    reason: "install reported success but 'tmux -V' still fails — tmux may not be on PATH",
  };
}
