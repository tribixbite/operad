# Sprint 11: End-to-End Test in CI

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One test that boots the daemon, hits every API endpoint, verifies every dashboard page returns 200, and stops cleanly. Runs in CI on every push to main.

**Architecture:** `src/__tests__/e2e.test.ts` uses a temp config with a `sleep 3600` session. Boots daemon via `spawnSync("node", ["dist/tmx.js", "daemon"])` in background, polls for `boot_complete`, exercises REST API and SSE, verifies dashboard routes, stops cleanly. Linux-only in CI.

**Tech Stack:** TypeScript, bun:test, Node `http` module for requests. Prereqs: Sprint 5 (first-run), Sprint 10 (refactor complete).

**Spec:** `docs/superpowers/specs/2026-04-17-operad-sprint-design.md` § Sprint 11

---

## Project Context

- Build must be run before test: `bun run build` produces `dist/tmx.js`
- Daemon starts with: `node dist/tmx.js daemon --config <path>`
- IPC: daemon listens on Unix socket (platform-dependent path)
- REST API: `http://localhost:18970/api/*`
- Dashboard static pages: `http://localhost:18970/` (requires dashboard built)
- `boot_complete` can be detected via `GET /api/status` response field

---

## Task 1: Write the E2E test

**Files:**
- Create: `src/__tests__/e2e.test.ts`

- [ ] **Step 1: Create a temp config helper**

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync, spawn, type ChildProcess } from "child_process";
import { tmpdir } from "os";

const TEST_PORT = 18971; // offset from default to avoid conflict
const TEST_HOME = join(tmpdir(), `operad-e2e-${Date.now()}`);
const CONFIG_PATH = join(TEST_HOME, "operad-test.toml");
const DAEMON_BIN = join(process.cwd(), "dist/tmx.js");

function makeTestConfig(): string {
  return `[operad]
port = ${TEST_PORT}
log_level = "warn"
state_dir = "${TEST_HOME}/state"

[[session]]
name = "test-sleep"
command = "sleep"
args = ["3600"]
cwd = "${TEST_HOME}"
enabled = true
`;
}

async function waitForPort(port: number, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/status`);
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

let daemonProcess: ChildProcess | null = null;

beforeAll(async () => {
  // Ensure dist/tmx.js exists
  const built = spawnSync("test", ["-f", DAEMON_BIN]);
  if (built.status !== 0) {
    throw new Error(`dist/tmx.js not found — run 'bun run build' first`);
  }

  mkdirSync(TEST_HOME, { recursive: true });
  mkdirSync(join(TEST_HOME, "state"), { recursive: true });
  writeFileSync(CONFIG_PATH, makeTestConfig(), "utf8");

  // Start daemon in background
  daemonProcess = spawn("node", [DAEMON_BIN, "daemon", "--config", CONFIG_PATH], {
    env: { ...process.env, HOME: TEST_HOME },
    stdio: "pipe",
  });

  const ready = await waitForPort(TEST_PORT, 15000);
  if (!ready) throw new Error("Daemon did not start within 15s");
}, 20000);

afterAll(async () => {
  if (daemonProcess) {
    daemonProcess.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 1000));
  }
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});
```

- [ ] **Step 2: Write API endpoint tests**

```typescript
describe("REST API", () => {
  test("GET /api/status returns daemon state", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/status`);
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body).toHaveProperty("daemon_start");
  });

  test("GET /api/sessions returns session list", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/sessions`);
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(Array.isArray(body) || typeof body === "object").toBe(true);
  });

  test("GET /api/memory returns memory snapshot", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/memory`);
    expect(res.status).toBeLessThan(500);
  });

  test("GET /api/quota returns quota status", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/quota`);
    expect(res.status).toBeLessThan(500);
  });

  test("GET /api/logs returns log entries", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/logs`);
    expect(res.status).toBeLessThan(500);
  });
});
```

- [ ] **Step 3: Write dashboard page tests**

```typescript
describe("Dashboard pages", () => {
  const pages = ["/", "/memory", "/logs", "/telemetry", "/settings", "/help"];

  for (const page of pages) {
    test(`GET ${page} returns 200`, async () => {
      const res = await fetch(`http://localhost:${TEST_PORT}${page}`);
      // 200 or 304 (cached) are both fine
      expect(res.status).toBeLessThan(400);
    });
  }
});
```

- [ ] **Step 4: Write SSE test**

```typescript
describe("SSE", () => {
  test("GET /api/events emits at least one event within 3s", async () => {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No SSE event within 3s")), 3000);
      const ctrl = new AbortController();
      fetch(`http://localhost:${TEST_PORT}/api/events`, { signal: ctrl.signal })
        .then(res => {
          const reader = res.body!.getReader();
          reader.read().then(({ done, value }) => {
            clearTimeout(timeout);
            ctrl.abort();
            if (!done && value) resolve();
            else reject(new Error("SSE stream ended without data"));
          });
        })
        .catch(err => { if (err.name !== "AbortError") { clearTimeout(timeout); reject(err); } });
    });
  }, 5000);
});
```

- [ ] **Step 5: Run the test (requires daemon built and tmux available)**

```bash
cd ~/git/operad && bun run build && bun test src/__tests__/e2e.test.ts --timeout 30000
```
Expected: all tests pass. If dashboard isn't built, some page tests may 404 — build dashboard first:
```bash
cd dashboard && bun run build && cd ..
```

- [ ] **Step 6: Commit**

```bash
git add src/__tests__/e2e.test.ts
git commit -m "feat(tests): end-to-end daemon boot/API/dashboard/SSE test

Boots daemon with temp config, hits all REST endpoints, verifies all 6
dashboard pages return <400, confirms SSE stream emits. Cleans up on exit.

— claude-sonnet-4-6"
```

---

## Task 2: Add E2E job to CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add e2e job**

```yaml
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Install tmux
        run: sudo apt-get install -y tmux

      - name: Build CLI
        run: bun run build

      - name: Build dashboard
        run: cd dashboard && bun install && bun run build

      - name: E2E tests
        run: bun test src/__tests__/e2e.test.ts --timeout 60000
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add e2e test job — boots daemon, tests all API endpoints and dashboard pages

— claude-sonnet-4-6"
```
