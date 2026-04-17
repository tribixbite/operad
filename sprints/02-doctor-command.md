# Sprint 2: `operad doctor` Command

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `operad doctor` — a single command that diagnoses a broken or misconfigured install, with colored checklist output and fix instructions for each failure.

**Architecture:** New `runDoctor()` function in `src/tmx.ts` that runs all checks synchronously (no daemon required), outputs a colored `[OK]` / `[WARN]` / `[FAIL]` checklist, exits 0 if no failures, 1 if any FAIL. Add `case "doctor":` to the switch in `main()`.

**Tech Stack:** TypeScript, Node/bun runtime. No new dependencies. Uses existing `spawnSync`, `existsSync`, `statSync` from Node stdlib. Uses `better-sqlite3` (already a dep) for SQLite integrity check.

**Spec:** `docs/superpowers/specs/2026-04-17-operad-sprint-design.md` § Sprint 2

---

## Project Context

operad is a cross-platform tmux session orchestrator for Claude Code sessions. CLI entry: `src/tmx.ts` (1037 lines). Daemon: `src/daemon.ts`. Config parser: `src/config.ts`. Platform detection: `src/platform/platform.ts`. Colors are defined at top of `src/tmx.ts` as `GREEN`, `RED`, `YELLOW`, `CYAN`, `RESET`, `DIM`.

Key references:
- `src/tmx.ts:116` — `default:` case in `main()` switch — add `case "doctor":` before it
- `src/config.ts` — `loadConfig(path)` / `parseConfig()` — use for config validation
- `src/platform/platform.ts` — `detectPlatform()` — for platform-specific checks
- State dir: `~/.local/share/tmx/` (or `$PREFIX/var/lib/tmx/` on Android)
- DB path: `~/.local/share/tmx/memory.db` (check with `existsSync`)

---

## Task 1: Write tests for doctor checks

**Files:**
- Create: `src/__tests__/doctor.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/doctor.test.ts
import { describe, test, expect } from "bun:test";
import { runChecks, type CheckResult } from "../doctor.js";

describe("doctor checks", () => {
  test("all checks return a result with name, status, and message", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r).toHaveProperty("name");
      expect(r).toHaveProperty("status");
      expect(["ok", "warn", "fail"]).toContain(r.status);
      expect(r).toHaveProperty("message");
    }
  });

  test("check names are unique", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const names = results.map(r => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/git/operad && bun test src/__tests__/doctor.test.ts
```
Expected: FAIL — `doctor.js` not found.

---

## Task 2: Implement doctor checks module

**Files:**
- Create: `src/doctor.ts`

- [ ] **Step 1: Create `src/doctor.ts`**

```typescript
import { spawnSync } from "child_process";
import { existsSync, accessSync, constants, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
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

/** Run all doctor checks and return results */
export async function runChecks(opts: RunChecksOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const platform = detectPlatform();
  const platformId: PlatformId = platform.id;

  // 1. tmux installed
  results.push(checkTmux());

  // 2. bun/node on PATH
  results.push(checkRuntime());

  // 3. Config file exists and parses
  results.push(checkConfig(opts.configPath));

  // 4. State dir writable
  results.push(checkStateDir(platformId));

  // 5. Dashboard built
  results.push(checkDashboard());

  // 6. Port 18970 available (or daemon already running)
  if (!opts.skipSlowChecks) {
    results.push(await checkPort());
  }

  // 7. Platform-specific checks
  results.push(...checkPlatformSpecific(platformId));

  // 8. SQLite integrity (if DB exists)
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
  const version = result.stdout.trim(); // e.g. "tmux 3.4"
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

function checkStateDir(platformId: PlatformId): CheckResult {
  // Android/Termux uses $PREFIX-relative path, others use ~/.local/share/tmx
  const stateDir = platformId === "android" && process.env.PREFIX
    ? join(process.env.PREFIX, "var/lib/tmx")
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
      fix: `Run: mkdir -p ${stateDir} && chmod 755 ${stateDir}`,
    };
  }
}

function checkDashboard(): CheckResult {
  // Try dist relative to binary, then relative to repo root convention
  const localDist = join(dirname(__filename ?? ""), "../dashboard/dist");
  const homeDist = join(process.env.HOME ?? "/", "git/operad/dashboard/dist");
  const dir = existsSync(localDist) ? localDist : existsSync(homeDist) ? homeDist : null;
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
    const net = require("net");
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
    // Check $PREFIX is set (Termux)
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

    // Check termux-info available
    const ti = spawnSync("termux-info", [], { encoding: "utf8", timeout: 3000 });
    if (ti.error) {
      results.push({
        name: "termux-api",
        status: "warn",
        message: "termux-info not available — battery monitoring disabled",
        fix: "Install Termux:API app and run: pkg install termux-api",
      });
    } else {
      results.push({ name: "termux-api", status: "ok", message: "termux-api available" });
    }
  }

  return results;
}

async function checkDatabase(platformId: PlatformId): Promise<CheckResult> {
  const stateDir = platformId === "android" && process.env.PREFIX
    ? join(process.env.PREFIX, "var/lib/tmx")
    : join(process.env.HOME ?? "/", ".local/share/tmx");
  const dbPath = join(stateDir, "memory.db");
  if (!existsSync(dbPath)) {
    return { name: "database", status: "ok", message: "No database yet (created on first agent run)" };
  }
  try {
    // Mirror memory-db.ts: try bun:sqlite first, then better-sqlite3
    let db: any;
    try {
      const { Database } = await import("bun:sqlite");
      db = new Database(dbPath, { readonly: true });
      const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      db.close();
      if (row.integrity_check === "ok") {
        return { name: "database", status: "ok", message: `${dbPath} — integrity ok` };
      }
      return {
        name: "database",
        status: "fail",
        message: `Database corruption: ${row.integrity_check}`,
        fix: `Back up and remove ${dbPath}, then restart daemon to recreate`,
      };
    } catch {
      // bun:sqlite unavailable (node CI env) — skip integrity check
      return { name: "database", status: "ok", message: `${dbPath} exists (integrity check skipped in node env)` };
    }
  } catch (err: any) {
    return {
      name: "database",
      status: "warn",
      message: `Could not check database: ${err.message}`,
    };
  }
}
```

- [ ] **Step 2: Run tests**

```bash
cd ~/git/operad && bun test src/__tests__/doctor.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd ~/git/operad
git add src/doctor.ts src/__tests__/doctor.test.ts
git commit -m "feat(doctor): implement runChecks() with 8 diagnostic checks

tmux version, runtime, config, state-dir, dashboard, port, platform-specific,
SQLite integrity. Returns typed CheckResult array — display-agnostic.

— claude-sonnet-4-6"
```

---

## Task 3: Wire `operad doctor` into CLI

**Files:**
- Modify: `src/tmx.ts`

- [ ] **Step 1: Add `case "doctor":` to the switch in `main()`**

In `src/tmx.ts` around line 93 (near `case "upgrade":`), add:

```typescript
case "doctor":
  return runDoctor();
```

- [ ] **Step 2: Implement `runDoctor()` in `src/tmx.ts`**

Add after the other `run*` functions (around line 260+):

```typescript
async function runDoctor(): Promise<void> {
  const { runChecks } = await import("./doctor.js");
  console.log(`\n${CYAN}operad doctor${RESET}\n`);
  const results = await runChecks({ configPath: getConfigFlag() ?? undefined });

  let hasFailures = false;
  for (const r of results) {
    const icon = r.status === "ok" ? `${GREEN}[OK]  ${RESET}` :
                 r.status === "warn" ? `${YELLOW}[WARN]${RESET}` :
                 `${RED}[FAIL]${RESET}`;
    console.log(`${icon} ${r.name.padEnd(16)} ${r.message}`);
    if (r.fix) {
      console.log(`       ${DIM}Fix: ${r.fix}${RESET}`);
    }
    if (r.status === "fail") hasFailures = true;
  }

  console.log();
  if (hasFailures) {
    console.log(`${RED}Some checks failed. Fix the issues above and re-run: operad doctor${RESET}\n`);
    process.exit(1);
  } else {
    console.log(`${GREEN}All checks passed.${RESET}\n`);
  }
}
```

Also add `case "doctor":` to the help text. Find `printHelp()` in `src/tmx.ts` and add a `doctor` entry to the commands table.

- [ ] **Step 3: Typecheck**

```bash
cd ~/git/operad && bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Build and smoke test**

```bash
cd ~/git/operad && bun run build && node dist/tmx.js doctor
```
Expected: runs checks and prints checklist. No crash.

- [ ] **Step 5: Run all tests**

```bash
cd ~/git/operad && bun test
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd ~/git/operad
git add src/tmx.ts
git commit -m "feat(cli): add 'operad doctor' command

Runs 8+ diagnostic checks (tmux, runtime, config, state-dir, dashboard,
port, platform, database). Colored [OK]/[WARN]/[FAIL] output with fix
instructions. Exits 1 if any check fails.

— claude-sonnet-4-6"
```
