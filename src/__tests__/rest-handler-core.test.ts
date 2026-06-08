/**
 * rest-handler-core.test.ts — In-process tests for RestHandler.handleDashboardApi,
 * covering the session-lifecycle delegation routes, method/param validation,
 * switchboard, config-overrides, telemetry, and the dispatch envelope
 * (404 unknown endpoint / 500 on thrown delegate).
 *
 * RestHandler routes the first path segment to an OrchestratorContext callback
 * and wraps the IpcResponse into `{ status, data }`. We drive it with the fake
 * context (helpers/fake-context.ts) so the routing/validation logic runs
 * in-process — the e2e subprocess daemon can't move coverage here.
 *
 * Sibling files cover the db-backed read routes, the android/scripts/adb
 * routes, the MCP/customization routes, and memory-injector.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RestHandler } from "../rest-handler.js";
import { ToolEngine } from "../tool-engine.js";
import {
  makeFakeContext,
  fakeAgentEngine,
  type FakeContext,
} from "./helpers/fake-context.js";

let fc: FakeContext;
let h: RestHandler;

/** Build a RestHandler over the current fake context. */
function build(): RestHandler {
  return new RestHandler(fc.ctx, fakeAgentEngine(), new ToolEngine(fc.ctx));
}

beforeEach(async () => {
  fc = await makeFakeContext({
    extraToml: `[[session]]
name = "sleepy"
type = "service"
command = "sleep"
path = "/work/sleepy"
`,
  });
  h = build();
});
afterEach(() => fc.cleanup());

describe("RestHandler — GET delegation routes", () => {
  test("GET /api/status delegates to cmdStatus and returns 200", async () => {
    const res = await h.handleDashboardApi("GET", "/api/status", "");
    expect(res.status).toBe(200);
    expect(fc.calls.cmdStatus).toHaveLength(1);
  });

  test("GET /api/status/<name> passes the decoded session name", async () => {
    await h.handleDashboardApi("GET", "/api/status/sleepy", "");
    expect(fc.calls.cmdStatus).toEqual([["sleepy"]]);
  });

  test("GET /api/memory + /api/health delegate", async () => {
    expect((await h.handleDashboardApi("GET", "/api/memory", "")).status).toBe(200);
    expect((await h.handleDashboardApi("GET", "/api/health", "")).status).toBe(200);
    expect(fc.calls.cmdMemory).toHaveLength(1);
    expect(fc.calls.cmdHealth).toHaveLength(1);
  });

  test("GET /api/recent delegates with a default count of 20", async () => {
    await h.handleDashboardApi("GET", "/api/recent", "");
    expect(fc.calls.cmdRecent).toEqual([[20]]);
  });
});

describe("RestHandler — telemetry route", () => {
  test("returns an empty envelope when no telemetry sink is wired", async () => {
    const res = await h.handleDashboardApi("GET", "/api/telemetry", "");
    expect(res.status).toBe(200);
    expect((res.data as { records: unknown[] }).records).toEqual([]);
  });

  test("reads from the sink when present, honouring limit + sdk filter", async () => {
    fc.cleanup();
    const seen: unknown[] = [];
    fc = await makeFakeContext({
      telemetrySink: {
        getRecent: (limit: number, sdk?: string) => { seen.push([limit, sdk]); return [{ id: 1 }]; },
        getStats: () => ({ total: 1, per_hour: 0, by_sdk: {}, started_at: "" }),
      },
    });
    h = build();
    const res = await h.handleDashboardApi("GET", "/api/telemetry?limit=5&sdk=aria", "");
    expect(res.status).toBe(200);
    expect((res.data as { records: unknown[] }).records).toEqual([{ id: 1 }]);
    expect(seen).toEqual([[5, "aria"]]);
  });
});

describe("RestHandler — POST lifecycle routes require POST", () => {
  const postRoutes = [
    "start", "stop", "restart", "close", "cleanup", "dedupe", "fix-socket",
    "suspend", "resume", "suspend-others", "suspend-all", "resume-all",
    "register", "clone", "create", "open",
  ];
  for (const r of postRoutes) {
    test(`GET /api/${r} → 405 Method not allowed`, async () => {
      const res = await h.handleDashboardApi("GET", `/api/${r}/sleepy`, "");
      expect(res.status).toBe(405);
    });
  }
});

describe("RestHandler — POST lifecycle delegation", () => {
  test("POST /api/start/<name> delegates to cmdStart", async () => {
    const res = await h.handleDashboardApi("POST", "/api/start/sleepy", "");
    expect(res.status).toBe(200);
    expect(fc.calls.cmdStart).toEqual([["sleepy"]]);
  });

  test("POST /api/stop and /api/restart delegate", async () => {
    await h.handleDashboardApi("POST", "/api/stop/sleepy", "");
    await h.handleDashboardApi("POST", "/api/restart/sleepy", "");
    expect(fc.calls.cmdStop).toEqual([["sleepy"]]);
    expect(fc.calls.cmdRestart).toEqual([["sleepy"]]);
  });

  test("POST /api/close requires a name → 400 when absent", async () => {
    const res = await h.handleDashboardApi("POST", "/api/close", "");
    expect(res.status).toBe(400);
  });

  test("POST /api/close/<name> delegates to cmdForceCleanup-free path", async () => {
    await h.handleDashboardApi("POST", "/api/close/sleepy", "");
    expect(fc.calls.cmdClose).toEqual([["sleepy"]]);
  });

  test("POST /api/cleanup/<name> delegates to cmdForceCleanup", async () => {
    await h.handleDashboardApi("POST", "/api/cleanup/sleepy", "");
    expect(fc.calls.cmdForceCleanup).toEqual([["sleepy"]]);
  });

  test("POST /api/dedupe?dry=1 passes dryRun=true", async () => {
    await h.handleDashboardApi("POST", "/api/dedupe?dry=1", "");
    expect(fc.calls.cmdDedupe).toEqual([[true]]);
  });

  test("POST /api/dedupe (no query) passes dryRun=false", async () => {
    await h.handleDashboardApi("POST", "/api/dedupe", "");
    expect(fc.calls.cmdDedupe).toEqual([[false]]);
  });

  test("POST /api/fix-socket calls ensureSocket and returns ok", async () => {
    const res = await h.handleDashboardApi("POST", "/api/fix-socket", "");
    expect(res.status).toBe(200);
    expect(fc.calls.ensureSocket).toHaveLength(1);
  });

  test("suspend family delegates with the session name", async () => {
    await h.handleDashboardApi("POST", "/api/suspend/sleepy", "");
    await h.handleDashboardApi("POST", "/api/resume/sleepy", "");
    await h.handleDashboardApi("POST", "/api/suspend-others/sleepy", "");
    await h.handleDashboardApi("POST", "/api/suspend-all", "");
    await h.handleDashboardApi("POST", "/api/resume-all", "");
    expect(fc.calls.cmdSuspend).toEqual([["sleepy"]]);
    expect(fc.calls.cmdResume).toEqual([["sleepy"]]);
    expect(fc.calls.cmdSuspendOthers).toEqual([["sleepy"]]);
    expect(fc.calls.cmdSuspendAll).toHaveLength(1);
    expect(fc.calls.cmdResumeAll).toHaveLength(1);
  });
});

describe("RestHandler — open route", () => {
  test("POST /api/open requires a path/name → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/open", "");
    expect(res.status).toBe(400);
  });

  test("POST /api/open/<name> defaults force_new=false", async () => {
    await h.handleDashboardApi("POST", "/api/open/myproj", "");
    expect(fc.calls.cmdOpen).toEqual([["myproj", undefined, false, 50, false]]);
  });

  test("POST /api/open/<name>?new=1 opts into a fresh instance", async () => {
    await h.handleDashboardApi("POST", "/api/open/myproj?new=1", "");
    expect(fc.calls.cmdOpen[0][4]).toBe(true);
  });

  test("POST /api/open/<name> with body force_new=true opts in", async () => {
    await h.handleDashboardApi("POST", "/api/open/myproj", JSON.stringify({ force_new: true }));
    expect(fc.calls.cmdOpen[0][4]).toBe(true);
  });
});

describe("RestHandler — autostart / send / go validation", () => {
  test("POST /api/autostart/<name> parses enabled flag", async () => {
    await h.handleDashboardApi("POST", "/api/autostart/sleepy", JSON.stringify({ enabled: false }));
    expect(fc.calls.cmdSetAutostart).toEqual([["sleepy", false]]);
  });

  test("POST /api/autostart with invalid JSON → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/autostart/sleepy", "{not json");
    expect(res.status).toBe(400);
  });

  test("POST /api/autostart defaults enabled=true when key omitted", async () => {
    await h.handleDashboardApi("POST", "/api/autostart/sleepy", JSON.stringify({}));
    expect(fc.calls.cmdSetAutostart).toEqual([["sleepy", true]]);
  });

  test("POST /api/send requires name", async () => {
    const res = await h.handleDashboardApi("POST", "/api/send", JSON.stringify({ text: "hi" }));
    expect(res.status).toBe(400);
  });

  test("POST /api/send delegates parsed text to cmdSend", async () => {
    await h.handleDashboardApi("POST", "/api/send/sleepy", JSON.stringify({ text: "go" }));
    expect(fc.calls.cmdSend).toEqual([["sleepy", "go"]]);
  });

  test("POST /api/send with invalid JSON → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/send/sleepy", "}{");
    expect(res.status).toBe(400);
  });

  test("POST /api/go requires a name → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/go", "");
    expect(res.status).toBe(400);
  });

  test("POST /api/go with unknown session → 400 Unknown session", async () => {
    const res = await h.handleDashboardApi("POST", "/api/go/does-not-exist", "");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("Unknown session");
  });
});

describe("RestHandler — clone / create / register validation", () => {
  test("POST /api/clone without body → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/clone", "");
    expect(res.status).toBe(400);
  });

  test("POST /api/clone with url delegates to cmdClone", async () => {
    await h.handleDashboardApi("POST", "/api/clone", JSON.stringify({ url: "git@x", name: "c" }));
    expect(fc.calls.cmdClone).toEqual([["git@x", "c"]]);
  });

  test("POST /api/clone with body missing url → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/clone", JSON.stringify({ name: "x" }));
    expect(res.status).toBe(400);
  });

  test("POST /api/create requires a name → 400", async () => {
    const res = await h.handleDashboardApi("POST", "/api/create", "");
    expect(res.status).toBe(400);
  });

  test("POST /api/create/<name> delegates to cmdCreate", async () => {
    await h.handleDashboardApi("POST", "/api/create/newproj", "");
    expect(fc.calls.cmdCreate).toEqual([["newproj"]]);
  });

  test("POST /api/register passes the optional scan path", async () => {
    await h.handleDashboardApi("POST", "/api/register", JSON.stringify({ path: "/scan/here" }));
    expect(fc.calls.cmdRegister).toEqual([["/scan/here"]]);
  });

  test("POST /api/register with non-JSON body falls back to default (undefined)", async () => {
    await h.handleDashboardApi("POST", "/api/register", "not-json");
    expect(fc.calls.cmdRegister).toEqual([[undefined]]);
  });
});

describe("RestHandler — switchboard route", () => {
  test("GET returns the current switchboard", async () => {
    const res = await h.handleDashboardApi("GET", "/api/switchboard", "");
    expect(res.status).toBe(200);
    expect((res.data as { all: boolean }).all).toBe(true);
  });

  test("PUT merges the patch and echoes the updated board", async () => {
    const res = await h.handleDashboardApi("PUT", "/api/switchboard", JSON.stringify({ cognitive: true }));
    expect(res.status).toBe(200);
    expect(fc.switchboard.cognitive).toBe(true);
  });

  test("PUT with invalid JSON → 400", async () => {
    const res = await h.handleDashboardApi("PUT", "/api/switchboard", "nope");
    expect(res.status).toBe(400);
  });

  test("DELETE → 405", async () => {
    const res = await h.handleDashboardApi("DELETE", "/api/switchboard", "");
    expect(res.status).toBe(405);
  });
});

describe("RestHandler — config-overrides route", () => {
  test("GET returns the (empty) overlay", async () => {
    const res = await h.handleDashboardApi("GET", "/api/config-overrides", "");
    expect(res.status).toBe(200);
    expect(typeof res.data).toBe("object");
  });

  test("PATCH persists a shallow merge and reports applies_on=daemon_restart", async () => {
    const res = await h.handleDashboardApi(
      "PATCH",
      "/api/config-overrides",
      JSON.stringify({ quota: { weekly_tokens: 999 } }),
    );
    expect(res.status).toBe(200);
    expect((res.data as { applies_on: string }).applies_on).toBe("daemon_restart");
    // round-trips via GET (overlay is allow-listed to nested sdk/quota shapes)
    const get = await h.handleDashboardApi("GET", "/api/config-overrides", "");
    expect((get.data as { quota?: { weekly_tokens?: number } }).quota?.weekly_tokens).toBe(999);
  });

  test("PATCH with invalid JSON → 400", async () => {
    const res = await h.handleDashboardApi("PATCH", "/api/config-overrides", "{bad");
    expect(res.status).toBe(400);
  });

  test("DELETE → 405", async () => {
    const res = await h.handleDashboardApi("DELETE", "/api/config-overrides", "");
    expect(res.status).toBe(405);
  });
});

describe("RestHandler — dispatch envelope", () => {
  test("unknown endpoint → 404 with the command name", async () => {
    const res = await h.handleDashboardApi("GET", "/api/totally-unknown", "");
    expect(res.status).toBe(404);
    expect((res.data as { error: string }).error).toContain("totally-unknown");
  });

  test("a thrown delegate is caught and surfaced as 500", async () => {
    fc.cleanup();
    fc = await makeFakeContext({
      overrides: {
        cmdStatus: () => { throw new Error("kaboom"); },
      },
    });
    h = build();
    const res = await h.handleDashboardApi("GET", "/api/status", "");
    expect(res.status).toBe(500);
    expect((res.data as { error: string }).error).toContain("kaboom");
  });

  test("ok:false delegate response maps to 400 with the error", async () => {
    fc.cleanup();
    fc = await makeFakeContext({
      cmdResponses: { cmdStatus: { ok: false, error: "no such session" } },
    });
    h = build();
    const res = await h.handleDashboardApi("GET", "/api/status", "");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toBe("no such session");
  });
});
