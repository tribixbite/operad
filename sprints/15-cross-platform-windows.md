# Sprint 15: Cross-Platform Audit + Windows Support

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit `src/platform/` for any hidden POSIX assumptions in consumers, add `src/platform/windows.ts`, wire Windows into `detectPlatform()`, and add a Windows CI smoke job. Document the tmux-on-Windows story.

**Architecture:** operad already has platform abstraction at `src/platform/platform.ts` with concrete implementations for `android`, `linux`, `darwin`. This sprint adds `windows`. Key platform differences: paths (backslashes, `%USERPROFILE%`), process info (no `/proc`, use `wmic`/PowerShell), IPC (no Unix sockets on native Windows — use named pipes or TCP localhost).

**Tech Stack:** TypeScript strict mode. On Windows, tmux requires MSYS2/Cygwin/WSL — we document the install path; we don't ship tmux.

**Spec:** New cross-platform phase after Sprint 14.

---

## Background: tmux on Windows

There is **no first-class native Windows port of tmux**. Real options:

1. **MSYS2** — ships a tmux package (`pacman -S tmux`). Runs under MSYS2's POSIX shim. Sockets are Unix domain sockets over MSYS2 emulation.
2. **Cygwin** — similar, tmux package available. Heavier install.
3. **WSL2** — native tmux inside the Linux subsystem. operad in WSL is effectively "Linux".
4. **Windows ConPTY** + a custom multiplexer — large undertaking, out of scope.

operad's Windows story: user must have tmux available (MSYS2 recommended). We detect tmux via `where tmux` / `tmux -V`. If missing, `operad doctor` instructs the user to install MSYS2. We do NOT implement a tmux shim.

IPC on Windows: native Node supports Unix sockets on modern Windows (10+) but named pipes are more idiomatic (`\\.\pipe\operad`). We'll use Unix sockets with a path like `C:\Users\X\AppData\Local\operad\operad.sock` which Node.js handles.

---

## Task 1: Audit consumers for POSIX leakage

**Files:**
- Audit all `src/*.ts` for direct POSIX usage

- [ ] **Step 1: Grep for hardcoded `/proc`, `/tmp`, `~`, Unix-only commands**

```bash
grep -rn "\"/proc\|\"/tmp/\|'/proc\|'/tmp/" src/ --include "*.ts" | grep -v platform/
grep -rn "\bspawnSync(\"termux\|\bspawnSync(\"apt\|\bspawnSync(\"brew\|\bspawnSync(\"ps\b" src/ --include "*.ts" | grep -v platform/
grep -rn "homedir()\|process.env.HOME\|\\\$HOME" src/ --include "*.ts" | head -30
```

- [ ] **Step 2: For each leak, move to platform abstraction**

Any consumer that hardcodes a POSIX path or command must either:
- Use `platform.defaultStatePath()`, `platform.defaultLogDir()`, etc. (existing)
- Use a new method on the Platform interface for Windows (add as needed)

Example fixes:
- Hardcoded `/tmp/operad.sock` → use `platform.defaultSocketPath()`
- `process.env.HOME` → use `homedir()` from `node:os` (already cross-platform)
- `spawnSync("ps", ...)` → use `platform.listProcesses()` abstraction

- [ ] **Step 3: Commit audit fixes**

```bash
git add src/
git commit -m "refactor(platform): move remaining POSIX leaks behind platform abstraction

Consumers now use platform.* methods uniformly. Prepares for Windows support.

— claude-sonnet-4-6"
```

---

## Task 2: Extend PlatformId + Platform interface

**Files:**
- Modify: `src/platform/platform.ts`

- [ ] **Step 1: Add `windows` to `PlatformId`**

```typescript
export type PlatformId = "android" | "linux" | "darwin" | "windows";
```

- [ ] **Step 2: Update `detectPlatform()`**

Current detection logic:
```typescript
// existing: TERMUX_VERSION → android; process.platform === "darwin" → darwin; else → linux
```

New logic:
```typescript
export function detectPlatform(): Platform {
  if (process.env.TERMUX_VERSION) return new AndroidPlatform();
  if (process.platform === "darwin") return new DarwinPlatform();
  if (process.platform === "win32") return new WindowsPlatform();
  return new LinuxPlatform();
}
```

- [ ] **Step 3: Add any missing methods to the Platform interface**

If existing consumers call something like `platform.getProcessList()` that's only implemented for POSIX, add stubs or make them optional.

---

## Task 3: Create `src/platform/windows.ts`

**Files:**
- Create: `src/platform/windows.ts`

- [ ] **Step 1: Implement WindowsPlatform class**

Follow the shape of `src/platform/linux.ts` and `src/platform/darwin.ts`.

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Platform } from "./platform.js";

export class WindowsPlatform implements Platform {
  readonly id = "windows" as const;

  defaultStatePath(): string {
    const appData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(appData, "operad", "state.json");
  }

  defaultLogDir(): string {
    const appData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(appData, "operad", "logs");
  }

  defaultSocketPath(): string {
    // Use Unix socket path under AppData — Node.js supports this on Windows 10+
    const appData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(appData, "operad", "operad.sock");
  }

  // Process-listing via wmic (deprecated in latest Windows but still present)
  // or PowerShell Get-Process. Prefer tasklist for simplicity.
  getProcessInfo(pid: number): ProcessInfo | null {
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (result.status !== 0 || !result.stdout) return null;
    // Parse CSV: "name","pid","session","session#","memusage"
    const fields = result.stdout.split(",").map(s => s.trim().replace(/^"|"$/g, ""));
    if (fields.length < 2) return null;
    return {
      name: fields[0],
      pid,
      memKb: parseInt(fields[4]?.replace(/[^\d]/g, "") ?? "0", 10) || 0,
    };
  }

  // Stub out methods that don't apply on Windows
  getBatteryStatus(): BatterySnapshot | null {
    // Windows doesn't have termux-battery-status. Could use WMI BatteryStatus,
    // but for a dev workstation this is low-value. Return null.
    return null;
  }

  hasWakeLock(): boolean {
    return false; // No Android-style wake locks on Windows
  }

  acquireWakeLock(): void {
    // No-op on Windows
  }

  releaseWakeLock(): void {
    // No-op on Windows
  }

  // Any other methods required by the Platform interface — stub with reasonable defaults
}
```

Check `src/platform/platform.ts` for the exact interface shape — implement ALL methods, using no-op/null for Windows-irrelevant ones.

- [ ] **Step 2: Typecheck**

```bash
cd ~/git/operad && bun run typecheck
```

Resolve any missing methods.

- [ ] **Step 3: Commit**

```bash
git add src/platform/platform.ts src/platform/windows.ts
git commit -m "feat(platform): add Windows platform implementation

WindowsPlatform implements Platform interface. Uses AppData\\Local\\operad
for state/logs/socket. Process info via tasklist. Battery/wake-lock stubbed.

— claude-sonnet-4-6"
```

---

## Task 4: Update `operad doctor` for Windows

**Files:**
- Modify: `src/doctor.ts`

- [ ] **Step 1: Add Windows branch to `checkPlatformSpecific`**

```typescript
function checkPlatformSpecific(platformId: PlatformId): CheckResult[] {
  const results: CheckResult[] = [];

  if (platformId === "android") { /* existing */ }

  if (platformId === "windows") {
    // Check that tmux is available (via MSYS2, Cygwin, or WSL)
    const tmux = spawnSync("where", ["tmux"], { encoding: "utf8" });
    if (tmux.status !== 0 || !tmux.stdout.trim()) {
      results.push({
        name: "tmux-windows",
        status: "fail",
        message: "tmux not found in PATH",
        fix: "Install MSYS2 from https://www.msys2.org and run: pacman -S tmux. Ensure MSYS2's bin dir is in PATH.",
      });
    } else {
      results.push({ name: "tmux-windows", status: "ok", message: `tmux at ${tmux.stdout.trim().split("\n")[0]}` });
    }
  }

  return results;
}
```

- [ ] **Step 2: Update checkStateDir for Windows paths**

The current implementation uses `$HOME/.local/share/tmx`. On Windows, use `%LOCALAPPDATA%\operad`:

```typescript
function checkStateDir(platformId: PlatformId): CheckResult {
  const stateDir = platformId === "windows"
    ? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local"), "operad")
    : join(process.env.HOME ?? "/", ".local/share/tmx");
  // ...rest unchanged
}
```

Similarly for `checkDatabase`.

- [ ] **Step 3: Commit**

```bash
git add src/doctor.ts
git commit -m "feat(doctor): add Windows-specific checks for tmux and AppData paths

— claude-sonnet-4-6"
```

---

## Task 5: Windows CI smoke job

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add windows-latest to build matrix**

Find the existing `build` job's matrix. Add `windows-latest`:

```yaml
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
```

If the existing matrix uses `fail-fast: false`, keep that. If it doesn't, add it so a Windows failure doesn't tank the other jobs.

- [ ] **Step 2: Guard Unix-specific steps**

Any steps that run `chmod`, `sudo apt-get`, etc. won't work on Windows. Guard with `if: runner.os != 'Windows'`.

- [ ] **Step 3: Add Windows-only tmux install step (optional — may be complex)**

Windows GitHub runners don't have tmux by default. Options:
- (a) Install MSYS2 via `choco install msys2` + `pacman -S tmux`
- (b) Skip tmux-dependent tests on Windows and just run typecheck + build

Pragmatic choice: (b) for Sprint 15. Typecheck and bundle-build must succeed on Windows; full e2e can run on Linux only.

```yaml
      - name: Typecheck and build (cross-platform sanity)
        run: |
          bun run typecheck
          bun run build
```

Skip the e2e step on Windows (add `if: runner.os != 'Windows'`).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add windows-latest to build matrix

Typecheck + build must pass on Windows. Tmux-dependent e2e tests skipped
on Windows (tmux requires separate MSYS2 install per user).

— claude-sonnet-4-6"
```

---

## Task 6: Document Windows installation

**Files:**
- Modify: `README.md`
- Modify: `docs/config.md` or a new `docs/windows.md`

- [ ] **Step 1: Add Windows section to README**

Under the "Platforms" heading:

```markdown
## Platforms

- **Android/Termux** — primary platform, battery/phantom-budget-aware
- **Linux** — full support
- **macOS** — full support
- **Windows** — experimental. Requires [MSYS2](https://www.msys2.org) with `tmux` installed. See [docs/windows.md](docs/windows.md).
```

- [ ] **Step 2: Create `docs/windows.md`**

```markdown
# operad on Windows

Windows support is experimental. operad runs on native Windows (not just WSL), but tmux itself has no first-class Windows port — you must install tmux via MSYS2.

## Prerequisites

1. Install [MSYS2](https://www.msys2.org) (Windows 10+ recommended).
2. Open an MSYS2 shell and install tmux:
   ```
   pacman -Syu
   pacman -S tmux
   ```
3. Add MSYS2's `usr/bin` to your Windows `PATH` so `tmux` is callable from PowerShell/cmd.
4. Install [bun](https://bun.sh) or [Node.js](https://nodejs.org).

## Installation

```powershell
npm install -g operadic
operad init
operad doctor
operad boot
```

Dashboard: `http://localhost:18970`

## Paths

- Config: `%USERPROFILE%\.config\operad\operad.toml`
- State: `%LOCALAPPDATA%\operad\state.json`
- Logs: `%LOCALAPPDATA%\operad\logs\`
- IPC socket: `%LOCALAPPDATA%\operad\operad.sock` (Unix socket — Windows 10+ supports these natively)

## Known Limitations

- **No battery monitoring** — Windows doesn't expose a unified battery API from Node.js.
- **No wake lock** — Windows has no Android-style wake lock concept.
- **No phantom-process budget** — that's Android-specific.
- **Limited process introspection** — uses `tasklist` which provides less detail than `/proc`.

## Troubleshooting

Run `operad doctor` first. It checks:
- tmux in PATH
- bun/node in PATH
- Config file exists
- State dir writable

If tmux isn't found, confirm MSYS2's `usr/bin` is in `PATH`:
```powershell
where.exe tmux
```

## WSL Alternative

If native Windows has issues, install operad inside WSL2 — it runs as a standard Linux install. Dashboard is accessible from Windows at `http://localhost:18970`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/windows.md
git commit -m "docs(windows): add Windows installation guide

Explains MSYS2 tmux prerequisite, AppData paths, known limitations,
and WSL alternative. README platforms table updated.

— claude-sonnet-4-6"
```

---

## Task 7: Final verification

- [ ] **Step 1: Build still works on current platform**

```bash
cd ~/git/operad && bun run typecheck && bun test && bun run build
node dist/tmx.js doctor | head -15
```

- [ ] **Step 2: CI should now run the windows-latest matrix entry**

Push branch and watch `gh run list` / `gh run watch` (after user gives push permission). Expected: Windows typecheck + build step passes, tmux-dependent e2e skipped.

- [ ] **Step 3: Update CHANGELOG**

Add to `[Unreleased]` section:
```markdown
### Added
- Windows platform support (experimental — requires MSYS2 tmux)
- Cross-platform audit: all POSIX leaks moved behind Platform abstraction
```

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): document Windows support + cross-platform audit

— claude-sonnet-4-6"
```
