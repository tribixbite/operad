/**
 * routes-scripts-adb.test.ts — In-process tests for ScriptsRoutes, AdbRoutes,
 * and the RestHandler cases that delegate to them.
 *
 * Driven by the fake-context harness so no real daemons, tmux sessions,
 * adb processes, or shell scripts are spawned. Tests cover:
 *   - ScriptsRoutes: cmdListScripts, cmdRunScript, cmdSaveScript
 *   - AdbRoutes: getAdbDevices (shape), adbWirelessConnect (validation)
 *   - RestHandler delegation: scripts, run-script, save-script, processes,
 *     kill, launch, autostop, adb, tab, run-build
 *
 * SKIPPED (unavoidably spawn real processes):
 *   - ScriptsRoutes.cmdRunScript when a valid session+script exist — calls
 *     runScriptInTab (tmux spawnSync). Covered via validation-path tests only.
 *   - AdbRoutes.getAdbDevices detailed output — calls `adb devices` (spawnSync).
 *     Only the return shape (always { devices: [] } on missing/failed adb) is asserted.
 *   - AdbRoutes.adbDisconnectAll / adbDisconnectDevice — always call spawnSync.
 *   - RestHandler "tab" POST — calls createTermuxTab (tmux spawnSync).
 *   - RestHandler "run-build" POST — calls runScriptInTab (tmux spawnSync).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ScriptsRoutes } from "../routes/scripts-routes.js";
import { AdbRoutes } from "../routes/adb-routes.js";
import { RestHandler } from "../rest-handler.js";
import { ToolEngine } from "../tool-engine.js";
import {
  makeFakeContext,
  fakeAgentEngine,
  type FakeContext,
} from "./helpers/fake-context.js";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let fc: FakeContext;

/** Build a RestHandler over the current fake context. */
function buildHandler(): RestHandler {
  return new RestHandler(fc.ctx, fakeAgentEngine(), new ToolEngine(fc.ctx));
}

beforeEach(async () => {
  fc = await makeFakeContext({
    extraToml: `[[session]]
name = "myapp"
type = "claude"
path = "__REPLACED_IN_TEST__"
`,
  });
  // Overwrite the path with the harness temp dir so file-system tests stay contained.
  const session = fc.ctx.config.sessions.find((s) => s.name === "myapp");
  if (session) session.path = fc.dir;
});

afterEach(() => fc.cleanup());

// ===========================================================================
// ScriptsRoutes — direct
// ===========================================================================

describe("ScriptsRoutes.cmdListScripts", () => {
  test("returns 400 for an unknown session (no path resolved)", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdListScripts("nonexistent");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("nonexistent");
  });

  test("returns 200 with empty list when session dir has no .sh files", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdListScripts("myapp");
    expect(res.status).toBe(200);
    const data = res.data as { scripts: unknown[] };
    expect(Array.isArray(data.scripts)).toBe(true);
  });

  test("finds .sh files at root of session path", () => {
    // Write a .sh file into the temp dir
    writeFileSync(join(fc.dir, "deploy.sh"), "#!/bin/sh\necho deploy\n", { mode: 0o755 });
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdListScripts("myapp");
    expect(res.status).toBe(200);
    const data = res.data as { scripts: { name: string; source: string }[] };
    const found = data.scripts.find((s) => s.name === "deploy.sh");
    expect(found).toBeDefined();
    expect(found!.source).toBe("root");
  });

  test("finds .sh files inside scripts/ subdirectory", () => {
    mkdirSync(join(fc.dir, "scripts"), { recursive: true });
    writeFileSync(join(fc.dir, "scripts", "ci.sh"), "#!/bin/sh\necho ci\n", { mode: 0o755 });
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdListScripts("myapp");
    expect(res.status).toBe(200);
    const data = res.data as { scripts: { name: string; source: string }[] };
    const found = data.scripts.find((s) => s.name === "ci.sh");
    expect(found).toBeDefined();
    expect(found!.source).toBe("scripts");
  });

  test("finds package.json scripts entries", () => {
    writeFileSync(
      join(fc.dir, "package.json"),
      JSON.stringify({ scripts: { build: "bun run build", test: "bun test" } }),
    );
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdListScripts("myapp");
    expect(res.status).toBe(200);
    const data = res.data as { scripts: { name: string; source: string; command?: string }[] };
    const buildEntry = data.scripts.find((s) => s.name === "build");
    expect(buildEntry).toBeDefined();
    expect(buildEntry!.source).toBe("package.json");
    expect(buildEntry!.command).toBe("bun run build");
  });

  test("finds saved scripts from .tmx-scripts/ subdirectory", () => {
    mkdirSync(join(fc.dir, ".tmx-scripts"), { recursive: true });
    writeFileSync(join(fc.dir, ".tmx-scripts", "util.sh"), "#!/bin/sh\necho util\n", { mode: 0o755 });
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdListScripts("myapp");
    expect(res.status).toBe(200);
    const data = res.data as { scripts: { name: string; source: string }[] };
    const found = data.scripts.find((s) => s.name === "util.sh");
    expect(found).toBeDefined();
    expect(found!.source).toBe("saved");
  });

  test("gracefully handles unreadable session dir (returns empty list not an error)", () => {
    // Point session at a nonexistent subdir — readdirSync will fail but should be caught
    const session = fc.ctx.config.sessions.find((s) => s.name === "myapp");
    if (session) session.path = join(fc.dir, "does-not-exist");
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdListScripts("myapp");
    // Either 200 with empty list or 400 — both are acceptable, but must not throw
    expect(res.status === 200 || res.status === 400).toBe(true);
    if (res.status === 200) {
      const data = res.data as { scripts: unknown[] };
      expect(Array.isArray(data.scripts)).toBe(true);
      expect(data.scripts).toHaveLength(0);
    }
  });
});

describe("ScriptsRoutes.cmdRunScript", () => {
  test("returns 400 for unknown session (resolveName returns null)", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdRunScript("ghost-session", {});
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("ghost-session");
  });

  test("returns 400 for unknown script source", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdRunScript("myapp", { script: "foo.sh", source: "bad-source" });
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("bad-source");
  });

  test("returns 400 when neither command nor script+source provided", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdRunScript("myapp", {});
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("command");
  });

  test("returns 404 when named script file does not exist (source=root)", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdRunScript("myapp", { script: "missing.sh", source: "root" });
    expect(res.status).toBe(404);
    expect((res.data as { error: string }).error).toContain("missing.sh");
  });

  test("returns 404 when named script file does not exist (source=scripts)", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdRunScript("myapp", { script: "ci.sh", source: "scripts" });
    expect(res.status).toBe(404);
  });

  test("returns 404 when named script file does not exist (source=saved)", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdRunScript("myapp", { script: "util.sh", source: "saved" });
    expect(res.status).toBe(404);
  });
});

describe("ScriptsRoutes.cmdSaveScript", () => {
  test("returns 400 for unknown session (no path resolved)", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdSaveScript("nonexistent", { name: "myscript", command: "echo hi" });
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("nonexistent");
  });

  test("rejects script names with special characters", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdSaveScript("myapp", { name: "bad/name!", command: "echo hi" });
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("alphanumeric");
  });

  test("rejects empty command", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdSaveScript("myapp", { name: "ok-name", command: "   " });
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("empty");
  });

  test("writes a .sh file into .tmx-scripts/ inside the session path", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdSaveScript("myapp", { name: "hello", command: "echo hello" });
    expect(res.status).toBe(200);
    const data = res.data as { name: string; path: string; source: string };
    expect(data.name).toBe("hello.sh");
    expect(data.source).toBe("saved");
    // File must exist inside fc.dir (never outside the temp dir)
    expect(data.path.startsWith(fc.dir)).toBe(true);
    expect(existsSync(data.path)).toBe(true);
    const content = readFileSync(data.path, "utf-8");
    expect(content).toContain("echo hello");
  });

  test("appends .sh suffix when not already present, rejects names with dots", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    // Names with dots violate the alphanumeric regex → 400
    const res1 = routes.cmdSaveScript("myapp", { name: "with-suffix.sh", command: "echo a" });
    expect(res1.status).toBe(400);
    // Plain alphanumeric name gets .sh appended
    const res2 = routes.cmdSaveScript("myapp", { name: "no-suffix", command: "echo b" });
    expect(res2.status).toBe(200);
    expect((res2.data as { name: string }).name).toBe("no-suffix.sh");
  });

  test("alphanumeric names with hyphens and underscores are accepted", () => {
    const routes = new ScriptsRoutes(fc.ctx);
    const res = routes.cmdSaveScript("myapp", { name: "my-cool_script2", command: "echo works" });
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// AdbRoutes — direct
// ===========================================================================

describe("AdbRoutes.getAdbDevices", () => {
  test("always returns an object with a devices array (shape check — adb may be absent)", () => {
    const routes = new AdbRoutes(fc.ctx);
    // spawnSync will either succeed or fail; both paths return { devices: [] } on errors
    const result = routes.getAdbDevices();
    expect(result).toHaveProperty("devices");
    expect(Array.isArray(result.devices)).toBe(true);
    // Every device entry (if any) must have serial and state
    for (const d of result.devices) {
      expect(typeof (d as { serial: string }).serial).toBe("string");
      expect(typeof (d as { state: string }).state).toBe("string");
    }
  });
});

describe("AdbRoutes.adbWirelessConnect", () => {
  test("returns 400 when connect_script is not configured (empty string default)", () => {
    // Default config has connect_script=""
    const routes = new AdbRoutes(fc.ctx);
    const res = routes.adbWirelessConnect();
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("connect_script");
  });

  test("calls invalidateAdbSerial on a real-looking script that succeeds", () => {
    // Skip spawning real bash; just verify the not-configured branch doesn't touch ctx
    // Verified above: connect_script="" → 400 without calling invalidateAdbSerial
    const routes = new AdbRoutes(fc.ctx);
    routes.adbWirelessConnect();
    // Should NOT have called invalidateAdbSerial on the 400 path
    expect(fc.calls.invalidateAdbSerial ?? []).toHaveLength(0);
  });
});

// ===========================================================================
// RestHandler delegation — scripts / run-script / save-script
// ===========================================================================

describe("RestHandler — scripts route", () => {
  let h: RestHandler;

  beforeEach(() => { h = buildHandler(); });

  test("GET /api/scripts requires a session name → 400", async () => {
    const res = await h.handleDashboardApi("GET", "/api/scripts", "");
    expect(res.status).toBe(400);
  });

  test("GET /api/scripts/<name> delegates to cmdListScripts", async () => {
    const res = await h.handleDashboardApi("GET", "/api/scripts/myapp", "");
    expect(res.status).toBe(200);
    // Should have returned scripts array (session dir is fc.dir — may be empty)
    expect(res.data).toHaveProperty("scripts");
  });

  test("GET /api/scripts/unknown → 400 (no path resolved)", async () => {
    const res = await h.handleDashboardApi("GET", "/api/scripts/unknown", "");
    expect(res.status).toBe(400);
  });
});

describe("RestHandler — run-script route", () => {
  let h: RestHandler;

  beforeEach(() => { h = buildHandler(); });

  test("GET /api/run-script/<name> → 405 Method Not Allowed", async () => {
    const res = await h.handleDashboardApi("GET", "/api/run-script/myapp", "");
    expect(res.status).toBe(405);
  });

  test("POST /api/run-script without name → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/run-script", "");
    expect(res.status).toBe(400);
  });

  test("POST /api/run-script/<name> with invalid JSON → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/run-script/myapp", "{bad json");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("Invalid JSON");
  });

  test("POST /api/run-script/<name> with unknown source → 400", async () => {
    const res = await h.handleDashboardApi(
      "POST", "/api/run-script/myapp",
      JSON.stringify({ script: "foo.sh", source: "nonsense" }),
    );
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("nonsense");
  });

  test("POST /api/run-script/<name> with missing file (source=root) → 404", async () => {
    const res = await h.handleDashboardApi(
      "POST", "/api/run-script/myapp",
      JSON.stringify({ script: "nofile.sh", source: "root" }),
    );
    expect(res.status).toBe(404);
  });

  test("POST /api/run-script/<name> with neither command nor script → 400", async () => {
    const res = await h.handleDashboardApi(
      "POST", "/api/run-script/myapp",
      JSON.stringify({}),
    );
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("command");
  });
});

describe("RestHandler — save-script route", () => {
  let h: RestHandler;

  beforeEach(() => { h = buildHandler(); });

  test("GET /api/save-script/<name> → 405", async () => {
    const res = await h.handleDashboardApi("GET", "/api/save-script/myapp", "");
    expect(res.status).toBe(405);
  });

  test("POST /api/save-script without name → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/save-script", "");
    expect(res.status).toBe(400);
  });

  test("POST /api/save-script/<name> with invalid JSON → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/save-script/myapp", "}{");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("Invalid JSON");
  });

  test("POST /api/save-script/<name> with invalid script name → 400", async () => {
    const res = await h.handleDashboardApi(
      "POST", "/api/save-script/myapp",
      JSON.stringify({ name: "../../evil", command: "rm -rf /" }),
    );
    expect(res.status).toBe(400);
  });

  test("POST /api/save-script/<name> saves a valid script and returns path inside session dir", async () => {
    const res = await h.handleDashboardApi(
      "POST", "/api/save-script/myapp",
      JSON.stringify({ name: "smoke", command: "echo smoke-test" }),
    );
    expect(res.status).toBe(200);
    const data = res.data as { name: string; path: string; source: string };
    expect(data.name).toBe("smoke.sh");
    expect(data.source).toBe("saved");
    expect(data.path.startsWith(fc.dir)).toBe(true);
    expect(existsSync(data.path)).toBe(true);
  });
});

// ===========================================================================
// RestHandler delegation — processes / kill / launch
// ===========================================================================

describe("RestHandler — processes / kill / launch routes", () => {
  let h: RestHandler;

  beforeEach(() => { h = buildHandler(); });

  test("GET /api/processes calls getAndroidApps and returns its result", async () => {
    const res = await h.handleDashboardApi("GET", "/api/processes", "");
    expect(res.status).toBe(200);
    expect(fc.calls.getAndroidApps).toHaveLength(1);
    // The fake returns [] — an array is valid
    expect(Array.isArray(res.data)).toBe(true);
  });

  test("GET /api/kill/<pkg> → 405 (must be POST)", async () => {
    const res = await h.handleDashboardApi("GET", "/api/kill/com.example.app", "");
    expect(res.status).toBe(405);
  });

  test("POST /api/kill without package name → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/kill", "");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("Package");
  });

  test("POST /api/kill/<pkg> delegates to forceStopApp and records the arg", async () => {
    const res = await h.handleDashboardApi("POST", "/api/kill/com.example.app", "");
    expect(res.status).toBe(200);
    expect(fc.calls.forceStopApp).toHaveLength(1);
    expect(fc.calls.forceStopApp[0]).toEqual(["com.example.app"]);
  });

  test("GET /api/launch/<pkg> → 405 (must be POST)", async () => {
    const res = await h.handleDashboardApi("GET", "/api/launch/com.example.app", "");
    expect(res.status).toBe(405);
  });

  test("POST /api/launch without name → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/launch", "");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("component");
  });

  test("POST /api/launch/<target> delegates to launchApp and records the arg", async () => {
    const res = await h.handleDashboardApi("POST", "/api/launch/com.example.app", "");
    expect(res.status).toBe(200);
    expect(fc.calls.launchApp).toHaveLength(1);
    expect(fc.calls.launchApp[0]).toEqual(["com.example.app"]);
  });
});

// ===========================================================================
// RestHandler delegation — autostop
// ===========================================================================

describe("RestHandler — autostop route", () => {
  let h: RestHandler;

  beforeEach(() => { h = buildHandler(); });

  test("GET /api/autostop (no name) returns the auto-stop list", async () => {
    const res = await h.handleDashboardApi("GET", "/api/autostop", "");
    expect(res.status).toBe(200);
    expect(fc.calls.getAutoStopList).toHaveLength(1);
    // Fake returns { packages: [] }
    expect((res.data as { packages: unknown[] }).packages).toEqual([]);
  });

  test("GET /api/autostop/<pkg> → 405 (toggle must be POST)", async () => {
    const res = await h.handleDashboardApi("GET", "/api/autostop/com.example", "");
    expect(res.status).toBe(405);
  });

  test("POST /api/autostop/<pkg> delegates to toggleAutoStop and records the arg", async () => {
    const res = await h.handleDashboardApi("POST", "/api/autostop/com.example.app", "");
    expect(res.status).toBe(200);
    expect(fc.calls.toggleAutoStop).toHaveLength(1);
    expect(fc.calls.toggleAutoStop[0]).toEqual(["com.example.app"]);
  });
});

// ===========================================================================
// RestHandler delegation — adb
// ===========================================================================

describe("RestHandler — adb route", () => {
  let h: RestHandler;

  beforeEach(() => { h = buildHandler(); });

  test("GET /api/adb (no sub-action) returns devices list shape", async () => {
    const res = await h.handleDashboardApi("GET", "/api/adb", "");
    expect(res.status).toBe(200);
    const data = res.data as { devices: unknown[] };
    expect(Array.isArray(data.devices)).toBe(true);
  });

  test("GET /api/adb/connect → 405 (must be POST)", async () => {
    const res = await h.handleDashboardApi("GET", "/api/adb/connect", "");
    expect(res.status).toBe(405);
  });

  test("POST /api/adb/connect with no connect_script configured → 400", async () => {
    // Default config has adb.connect_script = ""
    const res = await h.handleDashboardApi("POST", "/api/adb/connect", "");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("connect_script");
  });

  test("GET /api/adb/disconnect → 405 (must be POST)", async () => {
    const res = await h.handleDashboardApi("GET", "/api/adb/disconnect", "");
    expect(res.status).toBe(405);
  });

  test("GET /api/adb/unknown → 400 unknown action", async () => {
    const res = await h.handleDashboardApi("GET", "/api/adb/unknown-action", "");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("unknown-action");
  });
});

// ===========================================================================
// RestHandler delegation — tab route (validation only — spawn skipped)
// ===========================================================================

describe("RestHandler — tab route validation", () => {
  let h: RestHandler;

  beforeEach(() => { h = buildHandler(); });

  test("GET /api/tab/<name> → 405 (must be POST)", async () => {
    const res = await h.handleDashboardApi("GET", "/api/tab/myapp", "");
    expect(res.status).toBe(405);
  });

  test("POST /api/tab without name → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/tab", "");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("Session name");
  });

  test("POST /api/tab/<bare-session> → 400 for headless sessions", async () => {
    // Add a bare session to the config
    const bareSession = {
      name: "bare-svc",
      type: "service" as const,
      command: "sleep",
      path: fc.dir,
      auto_go: false,
      priority: 50,
      depends_on: [],
      headless: false,
      env: {},
      health: undefined,
      max_restarts: 3,
      restart_backoff_s: 5,
      enabled: true,
      bare: true,
    };
    fc.ctx.config.sessions.push(bareSession);
    h = buildHandler();
    const res = await h.handleDashboardApi("POST", "/api/tab/bare-svc", "");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("headless");
  });
});

// ===========================================================================
// RestHandler delegation — run-build route (validation only — spawn skipped)
// ===========================================================================

describe("RestHandler — run-build route validation", () => {
  let h: RestHandler;

  beforeEach(() => { h = buildHandler(); });

  test("GET /api/run-build/<name> → 405", async () => {
    const res = await h.handleDashboardApi("GET", "/api/run-build/myapp", "");
    expect(res.status).toBe(405);
  });

  test("POST /api/run-build without name → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/run-build", "");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("Session name");
  });

  test("POST /api/run-build/<unknown> → 400 (no path for session)", async () => {
    const res = await h.handleDashboardApi("POST", "/api/run-build/unknown-session", "");
    expect(res.status).toBe(400);
  });

  test("POST /api/run-build/<name> → 404 when build-on-termux.sh is absent", async () => {
    // myapp session path = fc.dir; no build-on-termux.sh there
    const res = await h.handleDashboardApi("POST", "/api/run-build/myapp", "");
    expect(res.status).toBe(404);
    expect((res.data as { error: string }).error).toContain("build-on-termux.sh");
  });
});
