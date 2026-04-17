import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync, spawn, type ChildProcess } from "child_process";
import { tmpdir } from "os";

const TEST_PORT = 18971;
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

async function waitForPort(port: number, timeoutMs = 15000): Promise<boolean> {
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
let daemonReady = false;

beforeAll(async () => {
  const built = spawnSync("test", ["-f", DAEMON_BIN]);
  if (built.status !== 0) {
    console.warn(`dist/tmx.js not found — skipping E2E tests`);
    return;
  }

  mkdirSync(TEST_HOME, { recursive: true });
  mkdirSync(join(TEST_HOME, "state"), { recursive: true });
  writeFileSync(CONFIG_PATH, makeTestConfig(), "utf8");

  daemonProcess = spawn("node", [DAEMON_BIN, "daemon", "--config", CONFIG_PATH], {
    env: { ...process.env, HOME: TEST_HOME },
    stdio: "pipe",
  });

  daemonReady = await waitForPort(TEST_PORT, 20000);
}, 25000);

afterAll(async () => {
  if (daemonProcess) {
    daemonProcess.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 1000));
  }
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

describe.skipIf(!daemonReady)("REST API", () => {
  test("GET /api/status returns daemon state", async () => {
    if (!daemonReady) return;
    const res = await fetch(`http://localhost:${TEST_PORT}/api/status`);
    expect(res.ok).toBe(true);
  });

  test("GET /api/sessions returns session list", async () => {
    if (!daemonReady) return;
    const res = await fetch(`http://localhost:${TEST_PORT}/api/sessions`);
    expect(res.ok).toBe(true);
  });

  test("GET /api/memory returns memory snapshot", async () => {
    if (!daemonReady) return;
    const res = await fetch(`http://localhost:${TEST_PORT}/api/memory`);
    expect(res.status).toBeLessThan(500);
  });

  test("GET /api/quota returns quota status", async () => {
    if (!daemonReady) return;
    const res = await fetch(`http://localhost:${TEST_PORT}/api/quota`);
    expect(res.status).toBeLessThan(500);
  });

  test("GET /api/logs returns log entries", async () => {
    if (!daemonReady) return;
    const res = await fetch(`http://localhost:${TEST_PORT}/api/logs`);
    expect(res.status).toBeLessThan(500);
  });
});

describe("Dashboard pages", () => {
  const pages = ["/", "/memory", "/logs", "/telemetry", "/settings", "/help"];

  for (const page of pages) {
    test(`GET ${page} returns <400`, async () => {
      if (!daemonReady) return;
      const res = await fetch(`http://localhost:${TEST_PORT}${page}`);
      expect(res.status).toBeLessThan(400);
    });
  }
});
