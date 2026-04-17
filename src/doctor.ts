import { spawnSync } from "child_process";
import { existsSync, accessSync, constants, readFileSync, readdirSync, realpathSync } from "fs";
import { join, dirname } from "path";
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
  const defaultPath = join(
    process.env.HOME ?? "/",
    ".config/operad/operad.toml"
  );
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

function checkStateDir(_platformId: PlatformId): CheckResult {
  // State dir is always $HOME/.local/share/tmx on all platforms (matching android.ts and memory-db.ts)
  const stateDir = join(process.env.HOME ?? "/", ".local/share/tmx");
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
      fix: `Run: mkdir -p ${stateDir} && chmod 755 ${stateDir}`,
    };
  }
}

function checkDashboard(): CheckResult {
  // Use realpathSync to resolve symlinks (matching tmx.ts pattern); fall back to null if it throws
  let localDist: string | null = null;
  try {
    localDist = join(dirname(realpathSync(__filename)), "../dashboard/dist");
  } catch {
    localDist = null;
  }
  const homeDist = join(process.env.HOME ?? "/", "git/operad/dashboard/dist");
  const dir = (localDist && existsSync(localDist)) ? localDist : existsSync(homeDist) ? homeDist : null;
  if (!dir) {
    return {
      name: "dashboard",
      status: "warn",
      message: "Dashboard dist not found",
      fix: "Run: cd ~/git/operad/dashboard && bun run build",
    };
  }
  try {
    const files = readdirSync(dir);
    if (files.length === 0) {
      return {
        name: "dashboard",
        status: "warn",
        message: "Dashboard dist is empty",
        fix: "Run: cd ~/git/operad/dashboard && bun run build",
      };
    }
    return { name: "dashboard", status: "ok", message: `${dir} (${files.length} files)` };
  } catch {
    return { name: "dashboard", status: "warn", message: "Could not read dashboard dist" };
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
  }

  return results;
}

async function checkDatabase(_platformId: PlatformId): Promise<CheckResult> {
  // Database is always at $HOME/.local/share/operad/memory.db (matching memory-db.ts)
  const dbPath = join(process.env.HOME ?? "/", ".local/share/operad/memory.db");
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
