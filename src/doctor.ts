import { spawnSync } from "child_process";
import { existsSync, accessSync, constants, readFileSync, readdirSync, realpathSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import * as net from "net";
import { detectPlatform, type PlatformId } from "./platform/platform.js";
import { validateConfigFile } from "./config.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

export interface RunChecksOptions {
  configPath?: string;
  skipSlowChecks?: boolean;
}

// ── Pure helpers (exported for testing) ───────────────────────────────────

/** Severity rank used by worstStatus — higher = worse. */
const STATUS_RANK: Record<CheckStatus, number> = { ok: 0, warn: 1, fail: 2 };

/**
 * Return the worst status across an array of results.
 * An empty array returns "ok" (nothing checked = nothing broken).
 */
export function worstStatus(results: CheckResult[]): CheckStatus {
  let worst: CheckStatus = "ok";
  for (const r of results) {
    if (STATUS_RANK[r.status] > STATUS_RANK[worst]) {
      worst = r.status;
      if (worst === "fail") break; // can't get worse
    }
  }
  return worst;
}

/**
 * Produce a one-line human-readable summary of a set of check results,
 * e.g. "3 ok, 1 warn, 0 fail" with a trailing overall-status word.
 */
export function summaryLine(results: CheckResult[]): string {
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const r of results) counts[r.status]++;
  const overall = worstStatus(results);
  return `${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail — ${overall}`;
}

/**
 * Parse whether `[adb] enabled = true` appears in a TOML config string.
 * Exported so the parsing logic can be unit-tested independently of the FS.
 */
export function parseAdbEnabled(text: string): boolean {
  const adbBlock = text.match(/\[adb\][^[]*?enabled\s*=\s*(true|false)/i);
  if (!adbBlock) return false;
  return adbBlock[1].toLowerCase() === "true";
}

/**
 * Extract the set of unique runtime type ids referenced by `type = "<id>"`
 * lines in a TOML config string. Exported for unit testing.
 */
export function parseRuntimeTypes(text: string): Set<string> {
  const types = new Set<string>();
  const re = /^\s*type\s*=\s*"([a-z]+)"/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) types.add(m[1].toLowerCase());
  return types;
}

/**
 * Classify the content of a config file as ok / warn.
 * Returns an "ok" CheckResult when the content contains a recognised section
 * header, "warn" when the content looks empty/unrecognised.
 *
 * Exported so the content-classification branch can be tested without writing
 * a real TOML parser or hitting the filesystem.
 */
export function classifyConfigContent(path: string, content: string): CheckResult {
  if (!content.includes("[operad]") && !content.includes("[orchestrator]") && !content.includes("[[session]]")) {
    return {
      name: "config",
      status: "warn",
      message: `Config at ${path} has no [operad] or [[session]] sections`,
      fix: "Add at least [operad] or [[session]] to your config",
    };
  }
  return { name: "config", status: "ok", message: path };
}

export async function runChecks(opts: RunChecksOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const platform = detectPlatform();
  const platformId: PlatformId = platform.id;

  results.push(checkTmux());
  results.push(checkRuntime());
  results.push(checkConfig(opts.configPath));
  results.push(checkStateDir(platformId));
  results.push(checkDashboard());
  results.push(checkGit());
  results.push(checkAdbBinary(opts.configPath));
  results.push(...checkAgentRuntimes(opts.configPath));
  results.push(await checkSqliteDriver());

  if (!opts.skipSlowChecks) {
    results.push(await checkPort());
  }

  results.push(...checkPlatformSpecific(platformId));
  results.push(await checkDatabase(platformId));
  results.push(...checkSkillMarketplace());

  return results;
}

/**
 * Probe `git --version`. Operad's session paths are usually inside git
 * repos, and `src/git-info.ts` shells out to `git` for the dashboard's
 * branch/commit display. Missing git doesn't break the daemon outright,
 * so this is a `warn`, not `fail`.
 */
function checkGit(): CheckResult {
  const result = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 3000 });
  if (result.error || result.status !== 0) {
    let fix: string;
    if (process.platform === "win32") {
      fix = "winget install --id Git.Git -e";
    } else if (process.platform === "darwin") {
      fix = "brew install git    # or: xcode-select --install";
    } else if (process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux")) {
      fix = "pkg install git";
    } else {
      fix = "sudo apt install git    # or: sudo dnf install git / sudo pacman -S git";
    }
    return {
      name: "git",
      status: "warn",
      message: "git not on PATH — branch/commit display will be empty",
      fix,
    };
  }
  return { name: "git", status: "ok", message: result.stdout.trim().split("\n")[0] };
}

/**
 * Probe the `adb` binary if the user has `[adb] enabled = true` in their
 * config. Without this check, missing adb at boot causes a 50 s connect
 * timeout (configured by `connect_timeout_s`) before the daemon gives
 * up and continues — long enough that users assume the daemon hung.
 *
 * Reads the config file directly (avoids the full TOML loader) since
 * doctor is meant to run before boot.
 */
function checkAdbBinary(configPath?: string): CheckResult {
  const defaultPath =
    process.platform === "win32"
      ? join(
          process.env.APPDATA ??
            join(process.env.USERPROFILE ?? homedir(), "AppData", "Roaming"),
          "operad",
          "operad.toml",
        )
      : join(process.env.HOME ?? homedir(), ".config", "operad", "operad.toml");
  const path = configPath ?? defaultPath;
  // If config doesn't exist yet, [adb] enabled defaults to false on
  // non-Android — skip the probe with an OK so doctor doesn't false-fail.
  let adbEnabled = false;
  if (existsSync(path)) {
    try {
      const text = readFileSync(path, "utf8");
      // parseAdbEnabled matches `enabled = true/false` inside the [adb] section.
      // Doctor is best-effort here — the real source of truth is config.ts at boot.
      adbEnabled = parseAdbEnabled(text);
    } catch { /* ignore — defaults to disabled */ }
  }
  if (!adbEnabled) {
    return { name: "adb", status: "ok", message: "[adb] not enabled — skipped" };
  }
  const result = spawnSync("adb", ["version"], { encoding: "utf8", timeout: 3000 });
  if (result.error || result.status !== 0) {
    let fix: string;
    if (process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux")) {
      fix = "pkg install android-tools    # or disable: set adb.enabled = false in operad.toml";
    } else if (process.platform === "darwin") {
      fix = "brew install android-platform-tools    # or disable: set adb.enabled = false";
    } else if (process.platform === "win32") {
      fix = "winget install -e --id Google.PlatformTools    # or disable: set adb.enabled = false";
    } else {
      fix = "sudo apt install adb    # or: sudo dnf install android-tools / disable in operad.toml";
    }
    return {
      name: "adb",
      status: "fail",
      message: "[adb] enabled in config but `adb` not on PATH — boot will hang for connect_timeout_s",
      fix,
    };
  }
  return { name: "adb", status: "ok", message: result.stdout.trim().split("\n")[0] };
}

/**
 * For each agent runtime referenced by the config (claude / opencode /
 * codex), probe whether its binary is on PATH. Without this check, a
 * `[[session]] type = "opencode"` with no `opencode` installed would
 * boot fine and only fail when the agent first tries to start in
 * tmux — by which point the user is debugging tmux capture-pane
 * output. claude is special-cased: the binary may live as `cc`
 * (the user's shell alias) so we treat absence as a warn rather than
 * fail, since the SDK-spawn path also exists.
 *
 * Returns one CheckResult per *referenced* runtime. Runtimes with no
 * sessions are skipped — no point fussing about codex if the user
 * doesn't use it.
 */
function checkAgentRuntimes(configPath?: string): CheckResult[] {
  const defaultPath =
    process.platform === "win32"
      ? join(
          process.env.APPDATA ??
            join(process.env.USERPROFILE ?? homedir(), "AppData", "Roaming"),
          "operad",
          "operad.toml",
        )
      : join(process.env.HOME ?? homedir(), ".config", "operad", "operad.toml");
  const path = configPath ?? defaultPath;
  if (!existsSync(path)) return [];

  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { return []; }

  // Tolerant scan: every `type = "<id>"` line. The TOML parser is the real
  // source of truth at boot; here we just discover which runtimes are
  // referenced so we know which probes to run.
  const types = parseRuntimeTypes(text);

  // Map runtime → (binary name, install hints per platform). claude's
  // binary path is intentionally omitted — the SDK bridge handles it.
  type Probe = {
    id: string;
    bin: string;
    label: string;
    severity: "fail" | "warn";
    hints: { termux: string; mac: string; win: string; linux: string };
  };
  const probes: Probe[] = [
    {
      id: "opencode", bin: "opencode", label: "OpenCode CLI",
      severity: "fail",
      hints: {
        termux: "pkg install bun  # then: bun add -g opencode-ai@latest",
        mac:    "brew install opencode  # or: bun add -g opencode-ai@latest",
        win:    "winget install opencode  # or: bun add -g opencode-ai@latest",
        linux:  "bun add -g opencode-ai@latest  # or: npm i -g opencode-ai@latest",
      },
    },
    {
      id: "codex", bin: "codex", label: "OpenAI Codex CLI",
      severity: "fail",
      hints: {
        termux: "bun add -g @openai/codex@latest",
        mac:    "brew install --cask codex  # or: bun add -g @openai/codex@latest",
        win:    "winget install OpenAI.Codex  # or: bun add -g @openai/codex@latest",
        linux:  "bun add -g @openai/codex@latest  # or: npm i -g @openai/codex@latest",
      },
    },
    {
      id: "claude", bin: "claude", label: "Claude Code CLI",
      severity: "warn",
      hints: {
        termux: "bun add -g @anthropic-ai/claude-code  # or rely on the `cc` alias / SDK bridge",
        mac:    "brew install claude  # or: bun add -g @anthropic-ai/claude-code",
        win:    "winget install Anthropic.Claude  # or: bun add -g @anthropic-ai/claude-code",
        linux:  "bun add -g @anthropic-ai/claude-code  # or: npm i -g @anthropic-ai/claude-code",
      },
    },
  ];

  const results: CheckResult[] = [];
  for (const p of probes) {
    if (!types.has(p.id)) continue;
    const r = spawnSync(p.bin, ["--version"], { encoding: "utf8", timeout: 3000 });
    if (!r.error && r.status === 0) {
      results.push({
        name: `runtime:${p.id}`,
        status: "ok",
        message: `${p.label} → ${(r.stdout || r.stderr || "").trim().split("\n")[0]}`,
      });
      continue;
    }
    let fix: string;
    if (process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux")) fix = p.hints.termux;
    else if (process.platform === "darwin") fix = p.hints.mac;
    else if (process.platform === "win32") fix = p.hints.win;
    else fix = p.hints.linux;
    results.push({
      name: `runtime:${p.id}`,
      status: p.severity,
      message: `Config references type="${p.id}" but \`${p.bin}\` is not on PATH — sessions will fail to start`,
      fix,
    });
  }
  return results;
}

/**
 * Probe the SQLite driver before the agent subsystem tries to use it.
 * memory-db.ts prefers `bun:sqlite` (zero-dep, built into bun) and
 * falls back to `better-sqlite3` on node. better-sqlite3 is a native
 * module that needs a C toolchain; on Termux+node specifically it's a
 * common first-run wall.
 */
async function checkSqliteDriver(): Promise<CheckResult> {
  // The daemon launches under bun whenever a bun binary is resolvable
  // (see resolveBunPath in tmx.ts). bun:sqlite is built-in there, so we
  // only have to verify a SQLite driver exists when the daemon will run
  // under node. Doctor itself uses the npm shebang `#!/usr/bin/env node`,
  // so checking globalThis.Bun in doctor lies on the common case where
  // node runs doctor but bun runs the daemon.
  // 1) Running under bun → bun:sqlite is built-in.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    try {
      await import("bun:sqlite");
      return { name: "sqlite", status: "ok", message: "bun:sqlite (built-in)" };
    } catch {
      /* extremely unusual; fall through to fallback probe */
    }
  }
  // 2) Doctor under node, but bun is on PATH → daemon will spawn under
  //    bun and use bun:sqlite. Treat as OK.
  const bunCheck = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 3000 });
  if (!bunCheck.error && bunCheck.status === 0) {
    return {
      name: "sqlite",
      status: "ok",
      message: `bun ${bunCheck.stdout.trim()} on PATH — daemon will use bun:sqlite`,
    };
  }
  // 3) No bun → daemon will run under node and needs better-sqlite3.
  try {
    // @ts-expect-error — optional dependency, may not be installed.
    await import("better-sqlite3");
    return { name: "sqlite", status: "ok", message: "better-sqlite3 native module loaded" };
  } catch (err) {
    const onTermux = process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux");
    let fix: string;
    if (onTermux) {
      fix =
        "On Termux the supported runtime is bun (bun:sqlite is built-in). Install: pkg install bun\n" +
        "  Or, to stay on node: pkg install build-essential && bun install   (compiles better-sqlite3)";
    } else {
      fix = "bun install    # operad ships better-sqlite3 as an optional dep — re-run install in repo root";
    }
    return {
      name: "sqlite",
      status: "fail",
      message: `No SQLite driver loadable — agent subsystem will crash on first use (${(err as Error).message})`,
      fix,
    };
  }
}

function checkTmux(): CheckResult {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    // Platform-aware install guidance. The daemon preflight and
    // `operad install-tmux` use the same detection order.
    let fix: string;
    if (process.platform === "win32") {
      fix =
        "Run: operad install-tmux   (uses winget install -e --id arndawg.tmux-windows)\n" +
        "       or manually: winget install -e --id arndawg.tmux-windows";
    } else if (process.platform === "darwin") {
      fix = "Run: operad install-tmux   (or manually: brew install tmux)";
    } else if (process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux")) {
      fix = "Run: operad install-tmux   (or manually: pkg install tmux)";
    } else {
      fix =
        "Run: operad install-tmux   (detects apt/dnf/pacman/zypper/apk)\n" +
        "       or manually: sudo apt install tmux  /  sudo dnf install tmux  /  sudo pacman -S tmux";
    }
    return { name: "tmux", status: "fail", message: "tmux not found", fix };
  }
  const version = result.stdout.trim();
  const match = version.match(/tmux (\d+)\.(\d+)/);
  if (match) {
    const [, major, minor] = match.map(Number);
    if (major < 3 || (major === 3 && minor < 2)) {
      return {
        name: "tmux",
        status: "warn",
        message: `${version} — operad works best with tmux ≥ 3.2`,
        fix: "Upgrade tmux to 3.2 or later",
      };
    }
  }
  return { name: "tmux", status: "ok", message: version };
}

function checkRuntime(): CheckResult {
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (!bun.error && bun.status === 0) {
    return { name: "runtime", status: "ok", message: `bun ${bun.stdout.trim()}` };
  }
  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  if (!node.error && node.status === 0) {
    return { name: "runtime", status: "ok", message: `node ${node.stdout.trim()} (bun preferred)` };
  }
  return {
    name: "runtime",
    status: "fail",
    message: "Neither bun nor node found on PATH",
    fix: "Install bun: https://bun.sh or node: https://nodejs.org",
  };
}

function checkConfig(configPath?: string): CheckResult {
  // On Windows, prefer %APPDATA%\operad\operad.toml; on POSIX use $HOME/.config/operad/operad.toml
  const defaultPath =
    process.platform === "win32"
      ? join(
          process.env.APPDATA ??
            join(process.env.USERPROFILE ?? homedir(), "AppData", "Roaming"),
          "operad",
          "operad.toml",
        )
      : join(process.env.HOME ?? homedir(), ".config", "operad", "operad.toml");
  const path = configPath ?? defaultPath;
  if (!existsSync(path)) {
    return {
      name: "config",
      status: "warn",
      message: `Config not found at ${path}`,
      fix: `Run 'operad init', or create ${path} with at minimum:\n  [operad]\n\n  [[session]]\n  name = "my-session"\n  type = "claude"\n  path = "~/git/my-project"`,
    };
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err: any) {
    return {
      name: "config",
      status: "fail",
      message: `Config unreadable: ${err.message}`,
      fix: "Check file permissions on your config file",
    };
  }

  // Shape check first (missing sections is a warn, not a hard failure).
  const classified = classifyConfigContent(path, content);
  if (classified.status !== "ok") return classified;

  // Then run the SAME parser+validator the daemon uses at boot. Without this
  // the check only proved the file exists and has a section header, so a
  // config the daemon rejects (e.g. a session missing `path`) reported OK
  // here and then failed at `operad boot` with no prior warning.
  const errors = validateConfigFile(path);
  if (errors.length > 0) {
    return {
      name: "config",
      status: "fail",
      message: `Config invalid (${errors.length} error${errors.length === 1 ? "" : "s"}): ${errors.join("; ")}`,
      fix:
        `Edit ${path} to fix the errors above. Session keys are ` +
        `name/type/path (not command/cwd) — 'path' is required for ` +
        `type claude|opencode|codex|daemon, 'command' for type service.`,
    };
  }
  return classified;
}

function checkStateDir(platformId: PlatformId): CheckResult {
  // On Windows, state lives under %LOCALAPPDATA%\operad; on POSIX platforms under $HOME/.local/share/tmx
  const stateDir =
    platformId === "windows"
      ? join(
          process.env.LOCALAPPDATA ??
            join(process.env.USERPROFILE ?? homedir(), "AppData", "Local"),
          "operad",
        )
      : join(process.env.HOME ?? "/", ".local/share/tmx");
  try {
    if (!existsSync(stateDir)) {
      return { name: "state-dir", status: "warn", message: `State dir not found: ${stateDir} (will be created on first boot)` };
    }
    accessSync(stateDir, constants.W_OK);
    return { name: "state-dir", status: "ok", message: stateDir };
  } catch {
    return {
      name: "state-dir",
      status: "fail",
      message: `State dir not writable: ${stateDir}`,
      fix:
        platformId === "windows"
          ? `Run in PowerShell: mkdir "${stateDir}"`
          : `Run: mkdir -p ${stateDir} && chmod 755 ${stateDir}`,
    };
  }
}

/** Detect whether this install came from npm (dashboard pre-bundled) or a git
 *  checkout (dashboard built locally). The fix instruction differs. */
function isNpmInstall(): boolean {
  try {
    const binPath = realpathSync(__filename);
    return binPath.includes(`${"node_modules"}/operadic/`);
  } catch {
    return false;
  }
}

function checkDashboard(): CheckResult {
  // Resolve dashboard/dist relative to the bundle location only — no
  // hardcoded ~/git/operad fallback (that path is dev-specific and confuses
  // npm-installed users).
  let dir: string | null = null;
  try {
    const candidate = join(dirname(realpathSync(__filename)), "../dashboard/dist");
    if (existsSync(candidate)) dir = candidate;
  } catch { /* unresolvable */ }

  const fromNpm = isNpmInstall();
  const fix = fromNpm
    ? "Reinstall: bun add -g operadic@latest  (or npm i -g operadic@latest)"
    : "Run: cd dashboard && bun install && bun run build";

  if (!dir) {
    return {
      name: "dashboard",
      status: "warn",
      message: "Dashboard dist not bundled",
      fix,
    };
  }
  try {
    const files = readdirSync(dir);
    if (files.length === 0) {
      return { name: "dashboard", status: "warn", message: "Dashboard dist is empty", fix };
    }
    return { name: "dashboard", status: "ok", message: `${dir} (${files.length} files)` };
  } catch {
    return { name: "dashboard", status: "warn", message: "Could not read dashboard dist", fix };
  }
}

async function checkPort(): Promise<CheckResult> {
  const port = 18970;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve({ name: "port", status: "ok", message: `Port ${port} in use — daemon may already be running` });
      } else {
        resolve({ name: "port", status: "warn", message: `Port ${port} check failed: ${err.message}` });
      }
    });
    server.once("listening", () => {
      server.close();
      resolve({ name: "port", status: "ok", message: `Port ${port} available` });
    });
    server.listen(port, "127.0.0.1");
  });
}

/** What we could determine about a Windows Subsystem for Linux host. */
export interface WslInfo {
  isWsl: boolean;
  /** 1 or 2 when determinable, null otherwise. */
  version: 1 | 2 | null;
  /** Distro name from WSL_DISTRO_NAME, when exported. */
  distro: string | null;
}

/**
 * Detect whether this Linux host is actually WSL.
 *
 * WSL kernels always carry a Microsoft marker in the kernel release string;
 * WSL2 uses a "-microsoft-standard-WSL2" suffix while WSL1 reports
 * "-Microsoft". `WSL_INTEROP` is only set under WSL2. Env vars alone are not
 * enough (they are absent in some login shells and sudo strips them), so the
 * kernel string is the primary signal.
 *
 * Exported for testing — the /proc read is the only impure part.
 */
export function detectWsl(osRelease?: string): WslInfo {
  let release = osRelease;
  if (release === undefined) {
    try {
      release = readFileSync("/proc/sys/kernel/osrelease", "utf8");
    } catch {
      release = "";
    }
  }
  const lower = release.toLowerCase();
  const isWsl = lower.includes("microsoft") || Boolean(process.env.WSL_DISTRO_NAME);
  if (!isWsl) return { isWsl: false, version: null, distro: null };

  let version: 1 | 2 | null = null;
  if (lower.includes("wsl2")) version = 2;
  else if (lower.includes("microsoft")) version = 1;
  // WSL_INTEROP is WSL2-only and wins over a stale/odd kernel string.
  if (process.env.WSL_INTEROP) version = 2;

  return {
    isWsl: true,
    version,
    distro: process.env.WSL_DISTRO_NAME ?? null,
  };
}

/**
 * WSL-specific advisories. None of these are failures — operad works on WSL —
 * but each is a behaviour difference that otherwise looks like a bug:
 *
 *  - WSL1 lacks a real Linux kernel, so /proc/PID accounting used for
 *    per-session CPU and memory shedding is unreliable.
 *  - `notify-send` is usually absent (no desktop session), so every
 *    notification silently no-ops.
 *  - WSL2 runs in a NAT'd VM: the dashboard is reachable from Windows at
 *    localhost, but the `ip route` address operad prints for LAN access is
 *    the VM's internal 172.x address, unreachable from other devices.
 */
function checkWslEnvironment(wsl: WslInfo): CheckResult[] {
  const results: CheckResult[] = [];
  const label = [
    wsl.version ? `WSL${wsl.version}` : "WSL",
    wsl.distro ? `(${wsl.distro})` : null,
  ].filter(Boolean).join(" ");

  if (wsl.version === 1) {
    results.push({
      name: "wsl",
      status: "warn",
      message: `${label} detected — WSL1 has no real Linux kernel; /proc process accounting is unreliable`,
      fix:
        "Upgrade to WSL2 for accurate memory/CPU monitoring:\n" +
        "  (in PowerShell)  wsl --set-version <distro> 2",
    });
  } else {
    results.push({ name: "wsl", status: "ok", message: `${label} detected` });
  }

  // Notifications: notify-send comes from libnotify-bin and is absent on a
  // default WSL install, so status alerts vanish with no error.
  const notify = spawnSync("which", ["notify-send"], { stdio: "ignore", timeout: 3000 });
  if (notify.status !== 0) {
    results.push({
      name: "wsl-notifications",
      status: "warn",
      message: "notify-send not found — desktop notifications will be silently skipped",
      fix: "Install: sudo apt-get install -y libnotify-bin  (needs WSLg or an X server to display)",
    });
  } else {
    results.push({ name: "wsl-notifications", status: "ok", message: "notify-send available" });
  }

  // LAN reachability: warn only for WSL2, where the NAT is real. WSL1 shares
  // the Windows network stack, so its address is the host's.
  if (wsl.version !== 1) {
    results.push({
      name: "wsl-network",
      status: "ok",
      message:
        "Dashboard reachable from Windows at http://localhost:18970 " +
        "(WSL2 NAT means the LAN IP operad reports is VM-internal)",
      fix:
        "To reach the dashboard from other devices on your network, forward the port from Windows:\n" +
        "  netsh interface portproxy add v4tov4 listenport=18970 listenaddress=0.0.0.0 \\\n" +
        "    connectport=18970 connectaddress=$(hostname -I | awk '{print $1}')",
    });
  }

  return results;
}

function checkPlatformSpecific(platformId: PlatformId): CheckResult[] {
  const results: CheckResult[] = [];

  if (platformId === "android") {
    if (!process.env.PREFIX) {
      results.push({
        name: "termux-prefix",
        status: "fail",
        message: "$PREFIX not set — is this running inside Termux?",
        fix: "Run operad inside a Termux shell",
      });
    } else {
      results.push({ name: "termux-prefix", status: "ok", message: `$PREFIX = ${process.env.PREFIX}` });
    }

    // termux-battery-status (from termux-api package) is what battery monitoring actually uses
    const ti = spawnSync("termux-battery-status", [], { encoding: "utf8", timeout: 3000 });
    if (ti.error || ti.status !== 0) {
      results.push({
        name: "termux-api",
        status: "warn",
        message: "termux-battery-status not available — battery monitoring disabled",
        fix: "Install Termux:API app from F-Droid and run: pkg install termux-api",
      });
    } else {
      results.push({ name: "termux-api", status: "ok", message: "termux-api available" });
    }

    // CFC bridge (claude-chrome-android) — optional, enables /api/bridge + memory-pressure GC nudge
    results.push(checkCfcBridge());

    // Patched Edge Canary — used for opening the dashboard from the status notification
    results.push(checkEdgeCanary());

    // Termux:Boot symlink — only this path produces a daemon in com.termux.boot's
    // cgroup (the property that lets sessions survive Termux app death). See
    // docs/persistence.md.
    results.push(checkBootHook());

    // Process protections — read live state vs what applyPhantomFix tries to set.
    results.push(...checkAndroidProtections());
  }

  if (platformId === "linux") {
    // WSL presents as ordinary Linux, so operad runs there unmodified — but a
    // few host-integration features silently no-op and the dashboard's LAN
    // address is wrong. Surface that instead of letting users discover it.
    const wsl = detectWsl();
    if (wsl.isWsl) results.push(...checkWslEnvironment(wsl));
  }

  // Claude for Chrome extension — desktop equivalent of the Android CFC bridge.
  // Extensions live inside a Chrome profile and can't be reliably detected
  // from the OS, so this is an info-level row pointing at the install URL
  // when a Chromium-based browser is detected on PATH.
  if (platformId === "linux" || platformId === "darwin" || platformId === "windows") {
    results.push(checkClaudeForChromeExtension(platformId));
  }

  if (platformId === "windows") {
    // Check that tmux is on PATH (required for session management).
    const tmuxCheck = spawnSync("where", ["tmux"], { encoding: "utf8", timeout: 3000 });
    if (tmuxCheck.error || tmuxCheck.status !== 0) {
      // Prefer winget (preinstalled on Win10 1809+ / Win11). Fall back to MSYS2.
      const wingetCheck = spawnSync("where", ["winget"], { stdio: "ignore", timeout: 3000 });
      const fix = wingetCheck.status === 0
        ? "Install via winget:  winget install -e --id arndawg.tmux-windows\n" +
          "  (Or run:  operad install-tmux)"
        : "Install via MSYS2: https://msys2.org → `pacman -S tmux` → add C:\\msys64\\usr\\bin to PATH.\n" +
          "  Alternatively run inside WSL, or install winget and re-run `operad install-tmux`.";
      results.push({ name: "tmux-windows", status: "warn", message: "tmux not found on PATH", fix });
    } else {
      results.push({
        name: "tmux-windows",
        status: "ok",
        message: `tmux found: ${tmuxCheck.stdout.trim()}`,
      });
    }

    // Check PowerShell availability (used for notifications and battery queries)
    const psCheck = spawnSync("where", ["powershell"], { encoding: "utf8", timeout: 3000 });
    if (psCheck.error || psCheck.status !== 0) {
      results.push({
        name: "powershell",
        status: "warn",
        message: "powershell not found — notifications and battery monitoring disabled",
        fix: "PowerShell is bundled with Windows 7+. Check that it is on your PATH.",
      });
    } else {
      results.push({ name: "powershell", status: "ok", message: "powershell available" });
    }
  }

  return results;
}

async function checkDatabase(platformId: PlatformId): Promise<CheckResult> {
  // Database path depends on platform: Windows uses %LOCALAPPDATA%\operad\; others use $HOME/.local/share/operad/
  const dbPath =
    platformId === "windows"
      ? join(
          process.env.LOCALAPPDATA ??
            join(process.env.USERPROFILE ?? homedir(), "AppData", "Local"),
          "operad",
          "memory.db",
        )
      : join(process.env.HOME ?? "/", ".local/share/operad/memory.db");
  if (!existsSync(dbPath)) {
    return { name: "database", status: "ok", message: "No database yet (created on first agent run)" };
  }
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | null;
    db.close();
    if (!row || row.integrity_check === "ok") {
      return { name: "database", status: "ok", message: `${dbPath} — integrity ok` };
    }
    return {
      name: "database",
      status: "fail",
      message: `Database corruption: ${row.integrity_check}`,
      fix: `Back up and remove ${dbPath}, then restart daemon to recreate`,
    };
  } catch {
    return { name: "database", status: "ok", message: `${dbPath} exists (integrity check skipped in node env)` };
  }
}

/** CFC bridge (claude-chrome-android) — Android-only, optional. Enables
 *  /api/bridge + memory-pressure GC nudge for the Edge Canary CDP host. */
function checkCfcBridge(): CheckResult {
  const home = process.env.HOME ?? "/";
  const candidates = [
    join(home, ".bun/install/global/node_modules/claude-chrome-android/dist/cli.js"),
    join(home, ".npm/lib/node_modules/claude-chrome-android/dist/cli.js"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found) {
    return { name: "cfc-bridge", status: "ok", message: `claude-chrome-android at ${found}` };
  }
  return {
    name: "cfc-bridge",
    status: "warn",
    message: "CFC bridge (claude-chrome-android) not installed — /api/bridge will return 404",
    fix:
      "Install: bun add -g claude-chrome-android  (or npm i -g claude-chrome-android)\n" +
      "Then run: operad bridge start  (or call POST http://localhost:18970/api/bridge)",
  };
}

/** Claude for Chrome extension — desktop equivalent of the Android CFC bridge.
 *  We can't detect an installed extension from outside the browser profile,
 *  so this is a heuristic: if a Chromium-based browser is on PATH, surface
 *  the install URL as an `ok`-with-hint row. If no browser is detected,
 *  report `warn` with browser install suggestions too. */
function checkClaudeForChromeExtension(platformId: PlatformId): CheckResult {
  const EXT_URL =
    "https://chromewebstore.google.com/detail/claude-for-chrome/mhlfhmbeohhnidmkdpjmaflpcnhfchck";
  // Candidate browser binaries per platform
  const candidates: string[] =
    platformId === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Arc.app/Contents/MacOS/Arc",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
      : platformId === "windows"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/microsoft-edge",
          "/usr/bin/brave-browser",
          "/opt/google/chrome/chrome",
        ];

  const hasBrowser =
    candidates.some((p) => existsSync(p)) ||
    // PATH-based fallback
    ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser", "chrome"]
      .some((bin) => {
        const probe = platformId === "windows"
          ? spawnSync("where", [bin], { stdio: "ignore", timeout: 2000 })
          : spawnSync("which", [bin], { stdio: "ignore", timeout: 2000 });
        return probe.status === 0;
      });

  if (!hasBrowser) {
    return {
      name: "claude-for-chrome",
      status: "warn",
      message: "No Chromium-based browser detected — Claude for Chrome extension install won't work",
      fix:
        "Install Chrome/Chromium/Edge/Brave, then install the extension:\n" +
        `  ${EXT_URL}`,
    };
  }
  // Browser present — surface the extension as an info-level nudge
  return {
    name: "claude-for-chrome",
    status: "ok",
    message: "Browser detected — install extension manually if desired",
    fix: `Claude for Chrome extension: ${EXT_URL}`,
  };
}

/** Patched Edge Canary on Android — used to open the dashboard from the
 *  status notification and as the CDP target for the CFC bridge. */
function checkEdgeCanary(): CheckResult {
  // pm list packages com.microsoft.emmx.canary returns a line if installed
  const result = spawnSync("pm", ["list", "packages", "com.microsoft.emmx.canary"], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (result.error || result.status !== 0 || !result.stdout?.includes("com.microsoft.emmx.canary")) {
    return {
      name: "edge-canary",
      status: "warn",
      message: "Microsoft Edge Canary not installed — dashboard quick-open & CFC bridge target unavailable",
      fix:
        "Install Microsoft Edge Canary from the Play Store. For CFC bridge use, " +
        "you also need a build with --remote-debugging-port flag enabled.",
    };
  }
  return { name: "edge-canary", status: "ok", message: "com.microsoft.emmx.canary installed" };
}

/**
 * Termux:Boot hook — `~/.termux/boot/startup.sh` is the only path that places
 * the daemon in com.termux.boot's cgroup (separate from com.termux's). Without
 * a working hook, sessions can't survive Termux app death; manual `tmx stream`
 * spawns the daemon as a child of com.termux. See docs/persistence.md.
 *
 * Reports info-level state — does not fail the doctor run, since users may
 * intentionally avoid the boot hook (per project history, the user does).
 */
function checkBootHook(): CheckResult {
  const hookPath = join(homedir(), ".termux", "boot", "startup.sh");
  if (!existsSync(hookPath)) {
    return {
      name: "termux-boot-hook",
      status: "warn",
      message: "~/.termux/boot/startup.sh not present — sessions will not survive Termux app death",
      fix:
        "Install Termux:Boot APK from F-Droid, then create the hook:\n" +
        "  ln -sf ~/git/operad/watchdog.sh ~/.termux/boot/startup.sh\n" +
        "  (effective on next phone reboot — the daemon must be spawned by\n" +
        "   com.termux.boot to land in its own cgroup; see docs/persistence.md)",
    };
  }
  try {
    const resolved = realpathSync(hookPath);
    if (!existsSync(resolved)) {
      return {
        name: "termux-boot-hook",
        status: "fail",
        message: `~/.termux/boot/startup.sh is a broken symlink (target does not exist: ${resolved})`,
        fix: "ln -sfn ~/git/operad/watchdog.sh ~/.termux/boot/startup.sh",
      };
    }
    try {
      accessSync(resolved, constants.X_OK);
    } catch {
      return {
        name: "termux-boot-hook",
        status: "warn",
        message: `Boot hook target ${resolved} is not executable`,
        fix: `chmod +x ${resolved}`,
      };
    }
    return {
      name: "termux-boot-hook",
      status: "ok",
      message: `${hookPath} → ${resolved}`,
    };
  } catch (err) {
    return {
      name: "termux-boot-hook",
      status: "warn",
      message: `Could not resolve ~/.termux/boot/startup.sh: ${(err as Error).message}`,
    };
  }
}

/**
 * Read the live state of the 7 ADB-driven Android process protections that
 * `applyPhantomFix` is supposed to apply. Reports actual vs. expected per
 * layer so the user knows which ones are silently no-op on this device.
 *
 * The most common reason for silent no-op on modern Android: writing
 * /proc/<termux_pid>/oom_score_adj from `adb shell` requires the calling uid
 * to own the target process, which is no longer granted to the shell uid on
 * Android 14+. Operad logs this at warn but only via the daemon log; doctor
 * surfaces it interactively.
 */
function checkAndroidProtections(): CheckResult[] {
  const results: CheckResult[] = [];
  const adbCheck = spawnSync("adb", ["get-state"], { encoding: "utf8", timeout: 5000 });
  const adbReady = !adbCheck.error && adbCheck.status === 0 && /device/.test(adbCheck.stdout);
  if (!adbReady) {
    results.push({
      name: "android-protections",
      status: "warn",
      message: "ADB not connected — cannot verify protection state",
      fix: "Connect ADB (wireless debugging or USB) and re-run; operad's applyPhantomFix runs on boot via fixAdb",
    });
    return results;
  }

  // 1. Phantom process limit
  {
    const r = spawnSync("adb", ["shell", "device_config", "get", "activity_manager", "max_phantom_processes"], {
      encoding: "utf8", timeout: 5000,
    });
    const value = (r.stdout ?? "").trim();
    if (value === "2147483647") {
      results.push({ name: "phantom-limit", status: "ok", message: `max_phantom_processes=${value}` });
    } else {
      results.push({
        name: "phantom-limit",
        status: "warn",
        message: `max_phantom_processes=${value || "unset"} (expected 2147483647)`,
        fix: "Run `tmx boot` to reapply, or: adb shell device_config put activity_manager max_phantom_processes 2147483647",
      });
    }
  }

  // 2. Doze whitelist
  {
    const r = spawnSync("adb", ["shell", "cmd", "deviceidle", "whitelist"], {
      encoding: "utf8", timeout: 5000,
    });
    const whitelisted = (r.stdout ?? "").includes(",com.termux,") ||
      /,com\.termux,/.test(r.stdout ?? "") ||
      /\bcom\.termux\b,\d+/.test(r.stdout ?? "");
    if (whitelisted) {
      results.push({ name: "doze-whitelist", status: "ok", message: "com.termux is doze-whitelisted" });
    } else {
      results.push({
        name: "doze-whitelist",
        status: "warn",
        message: "com.termux NOT in doze whitelist",
        fix: "adb shell cmd deviceidle whitelist +com.termux",
      });
    }
  }

  // 3. com.termux oom_score_adj. Avoid `sh -c "...|..."` because adb-shell's
  // sh doesn't always pipe cleanly across the wire — call pidof directly and
  // pick the first whitespace-separated token client-side.
  {
    const pidR = spawnSync("adb", ["shell", "pidof", "com.termux"], {
      encoding: "utf8", timeout: 5000,
    });
    const pid = (pidR.stdout ?? "").trim().split(/\s+/)[0];
    if (!/^\d+$/.test(pid)) {
      results.push({
        name: "oom-score-adj",
        status: "warn",
        message: "com.termux not running — cannot read oom_score_adj",
      });
    } else {
      const adjR = spawnSync("adb", ["shell", "cat", `/proc/${pid}/oom_score_adj`], {
        encoding: "utf8", timeout: 5000,
      });
      const adj = parseInt((adjR.stdout ?? "").trim(), 10);
      if (Number.isFinite(adj) && adj <= -100) {
        results.push({ name: "oom-score-adj", status: "ok", message: `com.termux/${pid} oom_score_adj=${adj}` });
      } else {
        results.push({
          name: "oom-score-adj",
          status: "warn",
          message: `com.termux/${pid} oom_score_adj=${Number.isFinite(adj) ? adj : "unreadable"} (expected ≤ -100)`,
          fix:
            "On Android 14+ the adb-shell uid usually can't write another app's oom_score_adj.\n" +
            "  Try: adb shell \"echo -200 > /proc/" + pid + "/oom_score_adj\"\n" +
            "  If it returns 'Permission denied', this protection layer is non-functional on this device.",
        });
      }
    }
  }

  // 4. RUN_ANY_IN_BACKGROUND appop
  {
    const r = spawnSync("adb", ["shell", "cmd", "appops", "get", "com.termux", "RUN_ANY_IN_BACKGROUND"], {
      encoding: "utf8", timeout: 5000,
    });
    const out = (r.stdout ?? "").trim();
    if (/allow/i.test(out)) {
      results.push({ name: "run-in-bg", status: "ok", message: "com.termux RUN_ANY_IN_BACKGROUND=allow" });
    } else {
      results.push({
        name: "run-in-bg",
        status: "warn",
        message: `com.termux RUN_ANY_IN_BACKGROUND=${out || "unknown"}`,
        fix: "adb shell cmd appops set com.termux RUN_ANY_IN_BACKGROUND allow",
      });
    }
  }

  return results;
}

// ── Skill marketplace probes ──────────────────────────────────────────────
//
// All probes here are `warn` not `fail`: the marketplace is a preview
// surface gated behind --enable-skills-preview, so a broken state
// shouldn't block daemon boot. Surfacing the issue early lets users
// fix it before they hit it at install time.

function checkSkillMarketplace(): CheckResult[] {
  const results: CheckResult[] = [];
  results.push(checkClaudeJsonConsistency());
  results.push(checkDaemonIdLocation());
  results.push(checkClaudeCodeForSkillMds());
  return results;
}

/**
 * Validate the `operad_managed` array in ~/.claude.json against the
 * mcpServers map: every operad_managed name should have a matching
 * mcpServers entry. Orphans are GC'd on next install, but a doctor
 * warning surfaces the drift early.
 */
function checkClaudeJsonConsistency(): CheckResult {
  const path = join(homedir(), ".claude.json");
  if (!existsSync(path)) {
    return {
      name: "skills.claude_json",
      status: "ok",
      message: "~/.claude.json absent (will be created on first MCP install)",
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const mcpServers = (parsed.mcpServers as Record<string, unknown>) ?? {};
    const operadManaged = (parsed.operad_managed as Record<string, unknown>) ?? {};
    const orphans: string[] = [];
    for (const name of Object.keys(operadManaged)) {
      if (!(name in mcpServers)) orphans.push(name);
    }
    if (orphans.length === 0) {
      const count = Object.keys(operadManaged).length;
      return {
        name: "skills.claude_json",
        status: "ok",
        message: `~/.claude.json clean (${count} operad-managed entries)`,
      };
    }
    return {
      name: "skills.claude_json",
      status: "warn",
      message: `~/.claude.json has ${orphans.length} orphan operad_managed entries: ${orphans.join(", ")}`,
      fix: "These will be GC'd on the next skill install. To clean immediately, run any `tmx skill add` / `tmx skill remove` command.",
    };
  } catch (err) {
    return {
      name: "skills.claude_json",
      status: "warn",
      message: `~/.claude.json parse failed: ${(err as Error).message}`,
      fix: "Fix the JSON manually. operad refuses to touch a malformed claude.json (CLAUDE_JSON_MALFORMED).",
    };
  }
}

/**
 * Confirm the daemon_id is provisioned at a per-machine path, not in
 * a sync-prone location. The skills/daemon-id.ts precedence is
 * $XDG_RUNTIME_DIR → $PREFIX/var/lib (Termux) → ~/.local/share
 * fallback. The fallback is exactly what Syncthing syncs by default.
 */
function checkDaemonIdLocation(): CheckResult {
  const xdg = process.env.XDG_RUNTIME_DIR;
  const prefix = process.env.PREFIX;
  const candidates = [
    xdg && xdg.startsWith("/") ? join(xdg, "operad", "daemon-id") : null,
    prefix && prefix.includes("com.termux") ? join(prefix, "var", "lib", "operad", "daemon-id") : null,
    join(homedir(), ".local", "share", "operad", "daemon-id"),
  ].filter(Boolean) as string[];

  const existing = candidates.find((p) => existsSync(p));
  if (!existing) {
    return {
      name: "skills.daemon_id",
      status: "ok",
      message: "daemon-id not yet provisioned (will be created on first SkillManager boot)",
    };
  }
  const isSyncFallback = existing.startsWith(join(homedir(), ".local", "share"));
  if (!isSyncFallback) {
    return {
      name: "skills.daemon_id",
      status: "ok",
      message: `daemon-id at ${existing} (per-machine, safe)`,
    };
  }
  return {
    name: "skills.daemon_id",
    status: "warn",
    message: `daemon-id stored at ${existing} — this path syncs by default under most dotfile tools`,
    fix: "Add 'operad/daemon-id' to your Syncthing / chezmoi / Mutagen exclusion list to prevent two-daemon ownership conflicts in ~/.claude.json. Alternatively, set $XDG_RUNTIME_DIR or run inside Termux for an automatically per-machine path.",
  };
}

/**
 * If skills with SKILL.md bundles are installed, verify that the
 * Claude Code version on PATH is >= 2.0 (the threshold at which the
 * `skills` array in ~/.claude/settings.json is supported per the
 * spec §3.8).
 */
function checkClaudeCodeForSkillMds(): CheckResult {
  // Cheap heuristic: if ~/.claude/settings.json has skills[], assume
  // someone is using the feature. Probe for `claude --version`.
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    return {
      name: "skills.claude_code_skill_md",
      status: "ok",
      message: "No ~/.claude/settings.json yet — SKILL.md delivery untested",
    };
  }
  let hasSkillMds = false;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    hasSkillMds = Array.isArray(parsed.skills) && (parsed.skills as unknown[]).length > 0;
  } catch {
    // Don't surface malformed settings here; checkClaudeJsonConsistency
    // already covers the broader theme.
  }
  if (!hasSkillMds) {
    return {
      name: "skills.claude_code_skill_md",
      status: "ok",
      message: "No SKILL.md bundles registered — version check skipped",
    };
  }
  const result = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 3000 });
  if (result.error || result.status !== 0) {
    return {
      name: "skills.claude_code_skill_md",
      status: "warn",
      message: "claude CLI not on PATH but SKILL.md bundles are registered — Claude Code won't see them",
      fix: "Install Claude Code: npm i -g @anthropic-ai/claude-code (>= 2.0).",
    };
  }
  // Parse the version line; expects "X.Y.Z" or similar.
  const stdout = (result.stdout ?? "").toString();
  const versionMatch = stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!versionMatch) {
    return {
      name: "skills.claude_code_skill_md",
      status: "warn",
      message: `claude --version returned unparseable output: ${stdout.trim().slice(0, 80)}`,
    };
  }
  const major = parseInt(versionMatch[1], 10);
  if (major < 2) {
    return {
      name: "skills.claude_code_skill_md",
      status: "warn",
      message: `Claude Code v${major}.${versionMatch[2]}.${versionMatch[3]} < 2.0; SKILL.md skills[] field not supported`,
      fix: "Upgrade Claude Code: npm i -g @anthropic-ai/claude-code@latest",
    };
  }
  return {
    name: "skills.claude_code_skill_md",
    status: "ok",
    message: `Claude Code v${major}.${versionMatch[2]}.${versionMatch[3]} supports SKILL.md delivery`,
  };
}
