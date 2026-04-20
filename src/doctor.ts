import { spawnSync } from "child_process";
import { existsSync, accessSync, constants, readFileSync, readdirSync, realpathSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import * as net from "net";
import { detectPlatform, type PlatformId } from "./platform/platform.js";

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

export async function runChecks(opts: RunChecksOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const platform = detectPlatform();
  const platformId: PlatformId = platform.id;

  results.push(checkTmux());
  results.push(checkRuntime());
  results.push(checkConfig(opts.configPath));
  results.push(checkStateDir(platformId));
  results.push(checkDashboard());

  if (!opts.skipSlowChecks) {
    results.push(await checkPort());
  }

  results.push(...checkPlatformSpecific(platformId));
  results.push(await checkDatabase(platformId));

  return results;
}

function checkTmux(): CheckResult {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return {
      name: "tmux",
      status: "fail",
      message: "tmux not found",
      fix: "Install tmux: apt install tmux (Linux) / brew install tmux (macOS) / pkg install tmux (Termux)",
    };
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
      fix: `Create ${path} with at minimum:\n  [operad]\n\n  [[session]]\n  name = "my-session"\n  command = "claude"\n  cwd = "~/git/my-project"`,
    };
  }
  try {
    const content = readFileSync(path, "utf8");
    if (!content.includes("[operad]") && !content.includes("[orchestrator]") && !content.includes("[[session]]")) {
      return {
        name: "config",
        status: "warn",
        message: `Config at ${path} has no [operad] or [[session]] sections`,
        fix: "Add at least [operad] or [[session]] to your config",
      };
    }
    return { name: "config", status: "ok", message: path };
  } catch (err: any) {
    return {
      name: "config",
      status: "fail",
      message: `Config parse error: ${err.message}`,
      fix: "Fix the TOML syntax error in your config file",
    };
  }
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
