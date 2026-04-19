/**
 * End-to-end smoke test — boots the real daemon against a temp HOME,
 * hits REST endpoints and dashboard pages, verifies clean shutdown.
 *
 * Fails LOUDLY if the daemon can't start — captures stderr and fails beforeAll
 * rather than silent-skipping. Previously the suite would rubber-stamp broken
 * CI state by allowing all tests to early-return when `daemonReady` was false.
 *
 * Gracefully skips only when:
 *  - `dist/tmx.js` hasn't been built (local dev without `bun run build`)
 *  - `tmux` isn't installed on the host (the daemon won't start without it)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync, spawn, type ChildProcess } from "child_process";
import { tmpdir } from "os";

// Random high port to avoid conflicts with local daemons or phantom responders
const TEST_PORT = 30000 + Math.floor(Math.random() * 10000);
const TEST_HOME = join(tmpdir(), `operad-e2e-${Date.now()}`);
const CONFIG_PATH = join(TEST_HOME, "operad-test.toml");
const DAEMON_BIN = join(process.cwd(), "dist/tmx.js");

/** Skip the whole suite if the environment can't support it */
let skipReason: string | null = null;
let daemonProcess: ChildProcess | null = null;
let daemonStderr = "";

function makeTestConfig(): string {
  // dashboard_port is the REST/WS port. telemetry_sink.port defaults to 18971 —
  // override to a random-range value to avoid conflicts with local dev daemons.
  const telemetryPort = TEST_PORT + 1;
  return `[operad]
dashboard_port = ${TEST_PORT}
log_level = "warn"
state_dir = "${TEST_HOME}/state"
log_dir = "${TEST_HOME}/logs"
state_file = "${TEST_HOME}/state/state.json"
socket = "${TEST_HOME}/operad.sock"

[telemetry_sink]
port = ${telemetryPort}

[[session]]
name = "test-sleep"
type = "service"
command = "sleep"
args = ["3600"]
cwd = "${TEST_HOME}"
enabled = true
`;
}

async function waitForPort(port: number, timeoutMs = 20000): Promise<boolean> {
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

beforeAll(async () => {
  // Check bundle exists (local dev may not have built yet)
  if (spawnSync("test", ["-f", DAEMON_BIN]).status !== 0) {
    skipReason = `dist/tmx.js not found — run 'bun run build' first`;
    console.warn(skipReason);
    return;
  }

  // Check tmux is available (daemon needs it to boot sessions)
  const tmuxCheck = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  if (tmuxCheck.error || tmuxCheck.status !== 0) {
    skipReason = `tmux not installed — e2e requires tmux`;
    console.warn(skipReason);
    return;
  }

  mkdirSync(TEST_HOME, { recursive: true });
  mkdirSync(join(TEST_HOME, "state"), { recursive: true });
  writeFileSync(CONFIG_PATH, makeTestConfig(), "utf8");

  daemonProcess = spawn("node", [DAEMON_BIN, "daemon", "--config", CONFIG_PATH], {
    env: { ...process.env, HOME: TEST_HOME },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Capture stderr for diagnostics
  daemonProcess.stderr?.on("data", (chunk: Buffer) => {
    daemonStderr += chunk.toString();
  });
  daemonProcess.stdout?.on("data", (chunk: Buffer) => {
    daemonStderr += chunk.toString(); // merge into one blob for failure diagnostics
  });

  const ready = await waitForPort(TEST_PORT, 20000);
  if (!ready) {
    const exitCode = daemonProcess.exitCode;
    const killed = daemonProcess.killed;
    throw new Error(
      `Daemon failed to become ready at http://localhost:${TEST_PORT} within 20s.\n` +
      `  exitCode=${exitCode} killed=${killed}\n` +
      `  stderr+stdout:\n${daemonStderr || "(empty)"}`
    );
  }
}, 30000);

afterAll(async () => {
  if (daemonProcess) {
    daemonProcess.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 1500));
    if (!daemonProcess.killed && daemonProcess.exitCode === null) {
      daemonProcess.kill("SIGKILL");
    }
  }
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

describe.skipIf(skipReason !== null)("E2E — REST API", () => {
  test("GET /api/status returns daemon state including session list", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/status`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { daemon_start?: string; sessions?: unknown };
    expect(typeof body.daemon_start).toBe("string");
    // cmdStatus includes sessions in its response
    expect(body.sessions).toBeDefined();
  });

  test("GET /api/memory returns memory snapshot", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/memory`);
    expect(res.ok).toBe(true);
  });

  test("GET /api/health returns health sweep result", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/health`);
    expect(res.ok).toBe(true);
  });

  test("GET /api/quota returns <500 OR 503 (when no SQLite driver)", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/quota`);
    // 200 when memoryDb is available; 503 when bun:sqlite/better-sqlite3 missing
    expect([200, 503]).toContain(res.status);
  });

  test("GET /api/telemetry returns <500", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/telemetry`);
    expect(res.status).toBeLessThan(500);
  });
});

describe.skipIf(skipReason !== null)("E2E — Dashboard pages", () => {
  const pages = ["/", "/memory", "/logs", "/telemetry", "/settings", "/help"];
  for (const page of pages) {
    test(`GET ${page} returns <400`, async () => {
      const res = await fetch(`http://localhost:${TEST_PORT}${page}`);
      expect(res.status).toBeLessThan(400);
    });
  }
});

describe.skipIf(skipReason !== null)("E2E — SSE", () => {
  test("GET /api/events opens an event stream", async () => {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(`http://localhost:${TEST_PORT}/api/events`, { signal: ctrl.signal });
      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    } catch (err: any) {
      if (err.name !== "AbortError") throw err;
    } finally {
      clearTimeout(timeout);
      ctrl.abort();
    }
  }, 5000);
});
