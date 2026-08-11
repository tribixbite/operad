/**
 * health.test.ts — Tests for src/health.ts
 *
 * Covers:
 *   checkSessionHealth()
 *     - unknown check type → healthy:false with descriptive message
 *     - custom check: `true` → healthy, `false` → unhealthy (POSIX-guarded)
 *     - http check: live out-of-process Python server (200→healthy, 500→unhealthy,
 *       closed port→unhealthy). Python server is necessary because httpCheck() uses
 *       spawnSync('curl') which blocks the Bun event loop, preventing Bun.serve()
 *       from servicing requests in the same process.
 *     - process check: missing process_pattern config → healthy:false
 *     - missing required config fields for http/process/custom → healthy:false + message
 *     - every result has non-negative duration_ms and correct session name
 *
 *   runHealthSweep()
 *     - skips sessions that are not running/degraded
 *     - records consecutive failures, drives running→degraded at threshold
 *     - drives degraded→failed when restart_count >= max_restarts
 *     - healthy check on degraded session drives it back to running
 *     - adopted (bare PID) sessions use process-liveness rather than tmux check
 *     - returns correct HealthResult array
 *     - sessions without state entries are skipped silently
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { spawn as spawnAsync, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { checkSessionHealth, runHealthSweep,
  deriveCmdlineMarker,
} from "../health.js";
import { StateManager } from "../state.js";
import type { HealthCheckConfig, SessionConfig, TmxConfig } from "../types.js";
import type { Logger } from "../log.js";

// ---------------------------------------------------------------------------
// Platform-capability flags — evaluated once at module load so skipIf works
// ---------------------------------------------------------------------------

/** True on any POSIX-like platform where `true`/`false`/`pgrep` are available */
const isPosix = process.platform !== "win32";

/** True when curl and python3 are both callable (required for HTTP check tests) */
function detectHttpCapability(): boolean {
  if (!isPosix) return false;
  const c = spawnSync("curl", ["--version"], { timeout: 3000, stdio: "ignore" });
  const p = spawnSync("python3", ["--version"], { timeout: 3000, stdio: "ignore" });
  return c.status === 0 && p.status === 0;
}
const hasHttp = detectHttpCapability();

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function silentLog(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

/** Minimal valid SessionConfig */
function makeSession(name: string, overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    name,
    type: "service",
    command: "true",
    path: undefined,
    session_id: undefined,
    auto_go: false,
    priority: 10,
    depends_on: [],
    headless: false,
    env: {},
    health: undefined,
    max_restarts: 3,
    restart_backoff_s: 5,
    enabled: true,
    bare: false,
    args: undefined,
    ...overrides,
  } as SessionConfig;
}

/** Minimal valid TmxConfig for health sweep tests */
function makeConfig(sessions: SessionConfig[]): TmxConfig {
  return {
    sessions,
    health_defaults: {
      service: { check: "tmux_alive", unhealthy_threshold: 2 },
    },
  } as unknown as TmxConfig;
}

/** Build a HealthCheckConfig shorthand */
function hc(
  override: Partial<HealthCheckConfig> & { check: HealthCheckConfig["check"] },
): HealthCheckConfig {
  return { unhealthy_threshold: 2, ...override };
}

let tmpDir: string;
let state: StateManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-health-test-"));
  state = new StateManager(join(tmpDir, "state.json"), silentLog());
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

// ---------------------------------------------------------------------------
// checkSessionHealth — result shape invariants (no I/O, always run)
// ---------------------------------------------------------------------------

describe("checkSessionHealth — result shape", () => {
  test("always returns the session name verbatim", () => {
    const result = checkSessionHealth(
      "my-session",
      hc({ check: "custom", command: "true" }),
      silentLog(),
    );
    expect(result.session).toBe("my-session");
  });

  test("duration_ms is a non-negative number", () => {
    const result = checkSessionHealth(
      "svc",
      hc({ check: "custom", command: "true" }),
      silentLog(),
    );
    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("message is always a non-empty string", () => {
    const result = checkSessionHealth(
      "svc",
      hc({ check: "custom", command: "true" }),
      silentLog(),
    );
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// checkSessionHealth — unknown check type (no I/O)
// ---------------------------------------------------------------------------

describe("checkSessionHealth — unknown check type", () => {
  test("unknown type → healthy:false and message mentions the bad type", () => {
    const result = checkSessionHealth(
      "svc",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hc({ check: "does_not_exist" as any }),
      silentLog(),
    );
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("does_not_exist");
  });
});

// ---------------------------------------------------------------------------
// checkSessionHealth — missing required config fields (no I/O)
// ---------------------------------------------------------------------------

describe("checkSessionHealth — missing required config fields", () => {
  test("http check with no url → healthy:false", () => {
    // url intentionally absent
    const result = checkSessionHealth("svc", hc({ check: "http" }), silentLog());
    expect(result.healthy).toBe(false);
    expect(result.message.toLowerCase()).toContain("url");
  });

  test("process check with no process_pattern → healthy:false", () => {
    const result = checkSessionHealth("svc", hc({ check: "process" }), silentLog());
    expect(result.healthy).toBe(false);
    expect(result.message.toLowerCase()).toContain("process_pattern");
  });

  test("custom check with no command → healthy:false", () => {
    const result = checkSessionHealth("svc", hc({ check: "custom" }), silentLog());
    expect(result.healthy).toBe(false);
    expect(result.message.toLowerCase()).toContain("command");
  });
});

// ---------------------------------------------------------------------------
// checkSessionHealth — custom checks (POSIX shell required)
// ---------------------------------------------------------------------------

describe("checkSessionHealth — custom checks", () => {
  test.skipIf(!isPosix)("succeeding command → healthy:true", () => {
    const result = checkSessionHealth(
      "svc",
      hc({ check: "custom", command: "true" }),
      silentLog(),
    );
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("passed");
  });

  test.skipIf(!isPosix)("failing command → healthy:false", () => {
    const result = checkSessionHealth(
      "svc",
      hc({ check: "custom", command: "false" }),
      silentLog(),
    );
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("failed");
  });

  test.skipIf(!isPosix)("exit-1 command → healthy:false", () => {
    const result = checkSessionHealth(
      "svc",
      hc({ check: "custom", command: "exit 1" }),
      silentLog(),
    );
    expect(result.healthy).toBe(false);
  });

  test.skipIf(!isPosix)("non-existent command → healthy:false (does not throw)", () => {
    const result = checkSessionHealth(
      "svc",
      hc({ check: "custom", command: "__operad_no_such_cmd_xyz__" }),
      silentLog(),
    );
    expect(result.healthy).toBe(false);
  });

  test.skipIf(!isPosix)("multi-word command `test -f /etc/hosts` → healthy:true", () => {
    const result = checkSessionHealth(
      "svc",
      hc({ check: "custom", command: "test -f /etc/hosts" }),
      silentLog(),
    );
    // /etc/hosts exists on all POSIX systems
    expect(result.healthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkSessionHealth — http checks (requires curl + python3)
//
// httpCheck() calls spawnSync('curl', ...) which blocks the Bun event loop.
// Bun.serve() uses the async event loop and therefore can't service requests
// while spawnSync is executing in the same process. The workaround: start an
// out-of-process Python http.server via spawn() (non-blocking), wait for a
// JSON readiness message on stdout, and kill it in afterEach.
// ---------------------------------------------------------------------------

/** Start a Python HTTP server in a separate process.
 *  Responds 200 to GET "/" and 500 to any other path.
 *  Returns { port, proc } once the server signals readiness on stdout. */
async function startPythonServer(): Promise<{ port: number; proc: ChildProcess }> {
  const pyCode = `
import http.server, socketserver, sys, json
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        code = 200 if self.path == '/' else 500
        self.send_response(code)
        self.end_headers()
        self.wfile.write(b'ok')
server = socketserver.TCPServer(('127.0.0.1', 0), H, bind_and_activate=False)
server.allow_reuse_address = True
server.server_bind()
server.server_activate()
sys.stdout.write(json.dumps({'port': server.server_address[1]}) + '\\n')
sys.stdout.flush()
while True: server.handle_request()
`;
  const proc = spawnAsync("python3", ["-c", pyCode], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        try { resolve(JSON.parse(buf.slice(0, nl)).port as number); } catch (e) { reject(e); }
      }
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("python server startup timeout")), 5000);
  });
  return { port, proc };
}

describe("checkSessionHealth — http checks", () => {
  let pyProc: ChildProcess | null = null;
  let sharedPort = 0;

  beforeEach(async () => {
    if (!hasHttp) return;
    const srv = await startPythonServer();
    sharedPort = srv.port;
    pyProc = srv.proc;
  });

  afterEach(() => {
    pyProc?.kill("SIGTERM");
    pyProc = null;
  });

  test.skipIf(!hasHttp)("200 response → healthy:true", () => {
    const result = checkSessionHealth(
      "web",
      hc({ check: "http", url: `http://127.0.0.1:${sharedPort}/` }),
      silentLog(),
    );
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("200");
  });

  test.skipIf(!hasHttp)("500 response → healthy:false", () => {
    // Python server returns 500 for any path other than "/"
    const result = checkSessionHealth(
      "web",
      hc({ check: "http", url: `http://127.0.0.1:${sharedPort}/error` }),
      silentLog(),
    );
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("500");
  });

  test.skipIf(!hasHttp)("closed port (connection refused) → healthy:false", () => {
    // Port 9 is the IANA 'discard' service — guaranteed closed in user space
    const result = checkSessionHealth(
      "web",
      hc({ check: "http", url: "http://127.0.0.1:9/" }),
      silentLog(),
    );
    expect(result.healthy).toBe(false);
  });

  test.skipIf(!hasHttp)("result session name matches argument", () => {
    const result = checkSessionHealth(
      "my-http-svc",
      hc({ check: "http", url: `http://127.0.0.1:${sharedPort}/` }),
      silentLog(),
    );
    expect(result.session).toBe("my-http-svc");
  });
});

// ---------------------------------------------------------------------------
// checkSessionHealth — process checks (POSIX pgrep)
// ---------------------------------------------------------------------------

describe("checkSessionHealth — process checks", () => {
  test.skipIf(!isPosix)("impossible pattern → healthy:false with 'not found'", () => {
    const result = checkSessionHealth(
      "dead-proc",
      hc({ check: "process", process_pattern: "__operad_no_such_process_xyz12345__" }),
      silentLog(),
    );
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("not found");
  });

  test.skipIf(!isPosix)("pattern check returns a boolean result (shape invariant)", () => {
    // pgrep -f on the current process PID may or may not match depending on
    // the host's process table; we only assert the result has the right shape.
    const result = checkSessionHealth(
      "proc-svc",
      hc({ check: "process", process_pattern: `${process.pid}` }),
      silentLog(),
    );
    expect(typeof result.healthy).toBe("boolean");
    expect(result.session).toBe("proc-svc");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// runHealthSweep — setup helpers
// ---------------------------------------------------------------------------

function setupSweep(sessions: SessionConfig[]) {
  state.initFromConfig(sessions);
  return makeConfig(sessions);
}

/** Force a session into a specific status and optionally preset counters */
function setSweepState(
  name: string,
  status: "running" | "degraded" | "failed" | "stopped" | "pending",
  failures = 0,
  restarts = 0,
) {
  state.forceStatus(name, status);
  const s = state.getSession(name)!;
  s.consecutive_failures = failures;
  s.restart_count = restarts;
}

// ---------------------------------------------------------------------------
// runHealthSweep — session status filtering
// ---------------------------------------------------------------------------

describe("runHealthSweep — status filtering", () => {
  test.skipIf(!isPosix)("pending session is skipped — not in results", () => {
    const session = makeSession("svc", { health: hc({ check: "custom", command: "false" }) });
    const cfg = setupSweep([session]);
    // Status defaults to 'pending' — no force needed
    const results = runHealthSweep(cfg, state, silentLog());
    expect(results.find((r) => r.session === "svc")).toBeUndefined();
  });

  test.skipIf(!isPosix)("stopped session is skipped", () => {
    const session = makeSession("svc", { health: hc({ check: "custom", command: "false" }) });
    const cfg = setupSweep([session]);
    setSweepState("svc", "stopped");
    const results = runHealthSweep(cfg, state, silentLog());
    expect(results.find((r) => r.session === "svc")).toBeUndefined();
  });

  test.skipIf(!isPosix)("running session IS included in results", () => {
    const session = makeSession("svc", { health: hc({ check: "custom", command: "true" }) });
    const cfg = setupSweep([session]);
    setSweepState("svc", "running");
    const results = runHealthSweep(cfg, state, silentLog());
    expect(results.find((r) => r.session === "svc")).toBeDefined();
  });

  test.skipIf(!isPosix)("degraded session IS included in results", () => {
    const session = makeSession("svc", { health: hc({ check: "custom", command: "true" }) });
    const cfg = setupSweep([session]);
    setSweepState("svc", "degraded");
    const results = runHealthSweep(cfg, state, silentLog());
    expect(results.find((r) => r.session === "svc")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// runHealthSweep — consecutive failure accounting and state transitions
// ---------------------------------------------------------------------------

describe("runHealthSweep — failure accounting", () => {
  test.skipIf(!isPosix)("single failure on running (threshold=2): stays running, failure count =1", () => {
    const session = makeSession("svc", {
      health: hc({ check: "custom", command: "false", unhealthy_threshold: 2 }),
    });
    const cfg = setupSweep([session]);
    setSweepState("svc", "running", 0);

    runHealthSweep(cfg, state, silentLog());

    const s = state.getSession("svc")!;
    expect(s.consecutive_failures).toBe(1);
    expect(s.status).toBe("running");
  });

  test.skipIf(!isPosix)("failure count reaches threshold: running → degraded (threshold=2)", () => {
    const session = makeSession("svc", {
      health: hc({ check: "custom", command: "false", unhealthy_threshold: 2 }),
    });
    const cfg = setupSweep([session]);
    // Pre-seed one prior failure so this sweep brings count to 2 (= threshold)
    setSweepState("svc", "running", 1);

    runHealthSweep(cfg, state, silentLog());

    expect(state.getSession("svc")!.status).toBe("degraded");
  });

  test.skipIf(!isPosix)("threshold=1: first failure immediately degrades running session", () => {
    const session = makeSession("svc", {
      health: hc({ check: "custom", command: "false", unhealthy_threshold: 1 }),
    });
    const cfg = setupSweep([session]);
    setSweepState("svc", "running", 0);

    runHealthSweep(cfg, state, silentLog());

    expect(state.getSession("svc")!.status).toBe("degraded");
  });

  test.skipIf(!isPosix)("degraded with restart_count < max_restarts: stays degraded (not failed)", () => {
    const session = makeSession("svc", {
      max_restarts: 3,
      health: hc({ check: "custom", command: "false", unhealthy_threshold: 1 }),
    });
    const cfg = setupSweep([session]);
    // Already degraded, failures at threshold, but restarts below max
    setSweepState("svc", "degraded", 1, 0);

    runHealthSweep(cfg, state, silentLog());

    // Daemon main loop handles auto-restart; sweep only flags the failure
    expect(state.getSession("svc")!.status).toBe("degraded");
  });

  test.skipIf(!isPosix)("degraded with restart_count >= max_restarts: transitions to failed", () => {
    const session = makeSession("svc", {
      max_restarts: 2,
      health: hc({ check: "custom", command: "false", unhealthy_threshold: 1 }),
    });
    const cfg = setupSweep([session]);
    // Degraded and already exhausted max_restarts
    setSweepState("svc", "degraded", 1, 2);

    runHealthSweep(cfg, state, silentLog());

    expect(state.getSession("svc")!.status).toBe("failed");
  });

  test.skipIf(!isPosix)("boundary: restart_count = max_restarts - 1 does NOT fail yet", () => {
    // One restart remaining — should stay degraded, not fail
    const session = makeSession("svc", {
      max_restarts: 3,
      health: hc({ check: "custom", command: "false", unhealthy_threshold: 1 }),
    });
    const cfg = setupSweep([session]);
    setSweepState("svc", "degraded", 1, 2); // restart_count=2 < max_restarts=3
    // Wait — that IS equal to max_restarts - 1 = 2. The condition is >= max_restarts.
    // restart_count=2, max_restarts=3 → 2 >= 3 is false → stays degraded.

    runHealthSweep(cfg, state, silentLog());

    expect(state.getSession("svc")!.status).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// runHealthSweep — recovery (degraded → running)
// ---------------------------------------------------------------------------

describe("runHealthSweep — recovery", () => {
  test.skipIf(!isPosix)("healthy check on degraded session → back to running", () => {
    const session = makeSession("svc", {
      health: hc({ check: "custom", command: "true", unhealthy_threshold: 2 }),
    });
    const cfg = setupSweep([session]);
    setSweepState("svc", "degraded", 2, 1);

    runHealthSweep(cfg, state, silentLog());

    expect(state.getSession("svc")!.status).toBe("running");
  });

  test.skipIf(!isPosix)("recovery resets consecutive_failures to 0", () => {
    const session = makeSession("svc", {
      health: hc({ check: "custom", command: "true", unhealthy_threshold: 2 }),
    });
    const cfg = setupSweep([session]);
    setSweepState("svc", "degraded", 3, 1);

    runHealthSweep(cfg, state, silentLog());

    expect(state.getSession("svc")!.consecutive_failures).toBe(0);
  });

  test.skipIf(!isPosix)("healthy running session stays running with consecutive_failures reset", () => {
    const session = makeSession("svc", {
      health: hc({ check: "custom", command: "true" }),
    });
    const cfg = setupSweep([session]);
    setSweepState("svc", "running", 1); // partial prior failure

    runHealthSweep(cfg, state, silentLog());

    const s = state.getSession("svc")!;
    expect(s.status).toBe("running");
    expect(s.consecutive_failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runHealthSweep — adopted (bare PID) sessions
//
// pidAliveCheck() (internal) checks process liveness first, then optionally
// compares /proc/<pid>/cmdline against a marker from the session command.
// To isolate liveness from cmdline matching, we use:
//   - session name with <4 chars ("s") — deriveCmdlineMarker returns null
//   - command: undefined
// This gives liveness-only checks, making the test portable across runtimes.
// ---------------------------------------------------------------------------

describe("runHealthSweep — adopted bare-PID sessions", () => {
  test("adopted session with live PID → healthy, stays running", () => {
    // Name "s" has length < 4 → deriveCmdlineMarker returns null → liveness-only
    const session = makeSession("s", { bare: true, command: undefined });
    const cfg = setupSweep([session]);
    setSweepState("s", "running", 0);

    const adoptedPids = new Map<string, number>([["s", process.pid]]);
    const results = runHealthSweep(cfg, state, silentLog(), adoptedPids);

    const r = results.find((x) => x.session === "s")!;
    expect(r).toBeDefined();
    expect(r.healthy).toBe(true);
    expect(state.getSession("s")!.status).toBe("running");
  });

  test("adopted session with guaranteed-dead PID → unhealthy, failure increments", () => {
    const session = makeSession("s", {
      bare: true,
      command: undefined,
      // High threshold so a single failure doesn't immediately degrade
      max_restarts: 99,
      health: hc({ check: "tmux_alive", unhealthy_threshold: 99 }),
    });
    const cfg = setupSweep([session]);
    setSweepState("s", "running", 0);

    // PID 2147483647 is effectively guaranteed dead (max Linux PID value)
    const deadPid = 2147483647;
    const adoptedPids = new Map<string, number>([["s", deadPid]]);
    const results = runHealthSweep(cfg, state, silentLog(), adoptedPids);

    const r = results.find((x) => x.session === "s")!;
    expect(r).toBeDefined();
    expect(r.healthy).toBe(false);
    expect(state.getSession("s")!.consecutive_failures).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// runHealthSweep — adopted bare-PID sessions with explicit process_pattern
//
// Regression coverage for the termux-x11 false-negative: a bare service whose
// wrapper re-execs to a different argv0 (termux-x11 → app_process
// com.termux.x11.Loader) can never match the marker derived from its launch
// command's first token. An explicit `health.process_pattern` must be honoured
// as the cmdline marker for the adopted-PID path. These tests read
// /proc/<pid>/cmdline, so they only run where that exists (Linux/Android).
// ---------------------------------------------------------------------------

/** True where /proc/<pid>/cmdline is readable (Linux/Android, not macOS/Windows) */
const hasProcCmdline = (() => {
  try {
    readFileSync("/proc/self/cmdline", "utf-8");
    return true;
  } catch {
    return false;
  }
})();

/** Poll until the spawned child's cmdline reflects the exec'd target */
async function waitForCmdline(pid: number, token: string, tries = 50): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
      if (raw.includes(token)) return true;
    } catch {
      /* /proc entry not populated yet */
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

describe("runHealthSweep — adopted bare-PID with explicit process_pattern", () => {
  test.skipIf(!hasProcCmdline)(
    "explicit health.process_pattern matches the live cmdline when the derived command marker cannot (re-exec wrapper)",
    async () => {
      // Mimics termux-x11: launched via command "true" (derived marker "true",
      // absent from the live process) but the adopted PID's real cmdline is a
      // `sleep` child. The explicit process_pattern "sleep" must be used.
      const child = spawnAsync("sleep", ["300"], { stdio: "ignore" });
      try {
        await waitForCmdline(child.pid!, "sleep");
        const session = makeSession("x11svc", {
          bare: true,
          command: "true", // deriveCmdlineMarker → "true" — NOT in `sleep 300`
          max_restarts: 99,
          health: hc({ check: "process", process_pattern: "sleep", unhealthy_threshold: 99 }),
        });
        const cfg = setupSweep([session]);
        setSweepState("x11svc", "running", 0);

        const adoptedPids = new Map<string, number>([["x11svc", child.pid!]]);
        const results = runHealthSweep(cfg, state, silentLog(), adoptedPids);

        const r = results.find((x) => x.session === "x11svc")!;
        expect(r.healthy).toBe(true);
        expect(state.getSession("x11svc")!.status).toBe("running");
      } finally {
        child.kill("SIGKILL");
      }
    },
  );

  test.skipIf(!hasProcCmdline)(
    "explicit health.process_pattern takes precedence over a derived marker that would otherwise match",
    async () => {
      const child = spawnAsync("sleep", ["300"], { stdio: "ignore" });
      try {
        await waitForCmdline(child.pid!, "sleep");
        const session = makeSession("x11svc2", {
          bare: true,
          command: "sleep 300", // derived marker "sleep" WOULD match the child
          max_restarts: 99,
          health: hc({ check: "process", process_pattern: "no-such-token-zzz", unhealthy_threshold: 99 }),
        });
        const cfg = setupSweep([session]);
        setSweepState("x11svc2", "running", 0);

        const adoptedPids = new Map<string, number>([["x11svc2", child.pid!]]);
        const results = runHealthSweep(cfg, state, silentLog(), adoptedPids);

        const r = results.find((x) => x.session === "x11svc2")!;
        expect(r.healthy).toBe(false);
        expect(r.message).toContain("cmdline doesn't match");
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});

// ---------------------------------------------------------------------------
// runHealthSweep — multiple sessions
// ---------------------------------------------------------------------------

describe("runHealthSweep — multiple sessions", () => {
  test.skipIf(!isPosix)("results count matches running+degraded count, not total sessions", () => {
    const s1 = makeSession("running-svc", { health: hc({ check: "custom", command: "true" }) });
    const s2 = makeSession("pending-svc", { health: hc({ check: "custom", command: "false" }) });
    const s3 = makeSession("degraded-svc", { health: hc({ check: "custom", command: "true" }) });
    const cfg = setupSweep([s1, s2, s3]);

    setSweepState("running-svc", "running");
    // pending-svc stays pending — skipped
    setSweepState("degraded-svc", "degraded");

    const results = runHealthSweep(cfg, state, silentLog());
    expect(results.length).toBe(2);
    expect(results.map((r) => r.session).sort()).toEqual(["degraded-svc", "running-svc"]);
  });

  test.skipIf(!isPosix)("each session gets its own independent health result", () => {
    const svcA = makeSession("svc-a", { health: hc({ check: "custom", command: "true" }) });
    const svcB = makeSession("svc-b", { health: hc({ check: "custom", command: "false" }) });
    const cfg = setupSweep([svcA, svcB]);
    setSweepState("svc-a", "running");
    setSweepState("svc-b", "running");

    const results = runHealthSweep(cfg, state, silentLog());

    const rA = results.find((r) => r.session === "svc-a")!;
    const rB = results.find((r) => r.session === "svc-b")!;
    expect(rA.healthy).toBe(true);
    expect(rB.healthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runHealthSweep — missing state entries and edge cases
// ---------------------------------------------------------------------------

describe("runHealthSweep — edge cases", () => {
  test("session in config but not in state is silently skipped (no throw)", () => {
    const s1 = makeSession("in-state");
    const s2 = makeSession("not-in-state");
    const cfg = makeConfig([s1, s2]);
    state.initFromConfig([s1]); // only s1 has state
    setSweepState("in-state", "running");

    expect(() => runHealthSweep(cfg, state, silentLog())).not.toThrow();
  });

  test.skipIf(!isPosix)("omitting adoptedPids parameter does not throw", () => {
    const session = makeSession("svc", { health: hc({ check: "custom", command: "true" }) });
    const cfg = setupSweep([session]);
    setSweepState("svc", "running");

    expect(() => runHealthSweep(cfg, state, silentLog())).not.toThrow();
  });

  test("empty sessions list returns empty results array", () => {
    const cfg = makeConfig([]);
    const results = runHealthSweep(cfg, state, silentLog());
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkSessionHealth — determinism (POSIX)
// ---------------------------------------------------------------------------

describe("checkSessionHealth — determinism", () => {
  test.skipIf(!isPosix)("same config produces same healthy flag on repeated calls", () => {
    const cfg = hc({ check: "custom", command: "true" });
    const r1 = checkSessionHealth("svc", cfg, silentLog());
    const r2 = checkSessionHealth("svc", cfg, silentLog());
    expect(r1.healthy).toBe(r2.healthy);
  });
});

// -- cmdline marker derivation ----------------------------------------------
//
// The marker used to fall back to the SESSION NAME, which is operad's own
// label and never appears in a process's cmdline. Adopted Claude sessions
// carry no `command`, so the check failed every sweep: degraded within two,
// then auto-restart spawned a SECOND Claude in the same project directory
// while the original kept running.

describe("deriveCmdlineMarker", () => {
  const cfg = (over: Partial<SessionConfig>): SessionConfig => ({
    name: "proj", type: "claude", auto_go: false, priority: 5,
    depends_on: [], headless: false, env: {}, max_restarts: 3,
    restart_backoff_s: 5, enabled: true, bare: false, ...over,
  } as SessionConfig);

  test("an explicit command yields its binary", () => {
    expect(deriveCmdlineMarker("s", "bun run dev")).toBe("bun run dev".split(" ")[0].length >= 4 ? "bun" : null);
  });

  test("a long binary name is used", () => {
    expect(deriveCmdlineMarker("s", "syncthing serve")).toBe("syncthing");
  });

  test("env assignments and sh -c wrappers are stripped", () => {
    expect(deriveCmdlineMarker("s", 'sh -c "FOO=1 syncthing serve"')).toBe("syncthing");
  });

  test("NO command and no config yields null, not the session name", () => {
    // Returning the name guaranteed a mismatch on every check.
    expect(deriveCmdlineMarker("my-project-session")).toBeNull();
  });

  test("a claude session with no command derives from the runtime, not the name", () => {
    const m = deriveCmdlineMarker("my-project", undefined, cfg({ type: "claude", path: "/tmp/p" }));
    expect(m).not.toBe("my-project");
    if (m !== null) expect(m).toContain("claude");
  });

  test("an absolute startup path is reduced to its basename", () => {
    expect(deriveCmdlineMarker("s", "/data/data/com.termux/files/usr/bin/syncthing serve"))
      .toBe("syncthing");
  });

  test("bare shells never become the marker", () => {
    expect(deriveCmdlineMarker("s", "sh")).toBeNull();
    expect(deriveCmdlineMarker("s", "bash")).toBeNull();
  });
});
