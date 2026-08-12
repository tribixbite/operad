/**
 * routes-mcp-customization.test.ts — In-process tests for McpRoutes,
 * CustomizationRoutes, and the RestHandler dispatch cases that delegate
 * to them ("mcp", "customization", "customization-file").
 *
 * McpRoutes reads/writes ~/.claude.json and ~/.claude/settings.json via
 * homedir()-based paths. However, McpRoutes does NOT use the
 * _setClaudeJsonHome seam — it builds its own path from homedir(). We
 * therefore only test McpRoutes methods where we can supply a temp dir
 * we control:
 *
 *  - cmdMcpAdd/Update/Delete use `this.claudeJsonPath` → homedir()/.claude.json.
 *    These methods write to the REAL home, so we test their validation/rejection
 *    branches that return early WITHOUT touching the file system (409 collision,
 *    404 not-found), plus a full round-trip against a McpRoutes instance whose
 *    claudeJsonPath getter we override in a subclass pointing at fc.dir.
 *  - readClaudeJson() returns {} on any error — safe to call against a
 *    non-existent or empty path.
 *  - cmdMcpToggle writes settings.json — same per-instance path override used.
 *
 * For CustomizationRoutes the helper methods are purely functional:
 *  - isAllowedCustomizationPath, redactEnv, readJsonFile — no real home I/O.
 *  - cmdReadCustomizationFile / cmdWriteCustomizationFile — driven via a
 *    session path inside fc.dir (which the allow-list accepts).
 *  - cmdCustomization — invoked with a projectPath inside fc.dir; reads
 *    whatever fixtures we wrote; empty-but-valid result verified.
 *  - cmdAllProjectsCustomization — scans history.jsonl; absence is fine,
 *    returns ok:true with empty projects list.
 *
 * RestHandler delegation: MCP and customization dispatch cases are driven
 * via handleDashboardApi the same way rest-handler-core.test.ts works,
 * using a subclassed McpRoutes that redirects I/O to fc.dir.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { McpRoutes } from "../routes/mcp-routes.js";
import { CustomizationRoutes,
  mangleProjectKey,
  projectLabel,
} from "../routes/customization-routes.js";
import { RestHandler } from "../rest-handler.js";
import { ToolEngine } from "../tool-engine.js";
import {
  makeFakeContext,
  fakeAgentEngine,
  type FakeContext,
} from "./helpers/fake-context.js";

// ---------------------------------------------------------------------------
// Subclass McpRoutes to redirect .claude.json / settings.json to fc.dir
// so we never touch the real ~/.claude.json.
// ---------------------------------------------------------------------------

class TempMcpRoutes extends McpRoutes {
  constructor(
    ctx: ConstructorParameters<typeof McpRoutes>[0],
    private readonly tempDir: string,
  ) {
    super(ctx);
  }

  override get claudeJsonPath(): string {
    return join(this.tempDir, ".claude.json");
  }

  override get settingsJsonPath(): string {
    return join(this.tempDir, "settings.json");
  }
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let fc: FakeContext;

beforeEach(async () => {
  fc = await makeFakeContext({
    extraToml: `[[session]]
name = "proj"
type = "claude"
path = "${"/tmp/placeholder"}"
`,
  });
  // patch the session path to fc.dir after creation (the placeholder above
  // just keeps TOML valid; we mutate the loaded config in place)
  if (fc.ctx.config.sessions.length > 0) {
    fc.ctx.config.sessions[0].path = fc.dir;
  }
});

afterEach(() => {
  fc.cleanup();
});

// ---------------------------------------------------------------------------
// McpRoutes.readClaudeJson()
// ---------------------------------------------------------------------------

describe("McpRoutes.readClaudeJson()", () => {
  test("returns {} when file does not exist", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    const result = routes.readClaudeJson();
    expect(result).toEqual({});
  });

  test("returns parsed content when valid JSON file exists", () => {
    writeFileSync(join(fc.dir, ".claude.json"), JSON.stringify({ mcpServers: { "my-tool": { command: "cmd" } } }), "utf-8");
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    const result = routes.readClaudeJson();
    expect((result.mcpServers as Record<string, unknown>)["my-tool"]).toBeDefined();
  });

  test("returns {} when file has invalid JSON", () => {
    writeFileSync(join(fc.dir, ".claude.json"), "{ bad json }", "utf-8");
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    const result = routes.readClaudeJson();
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// McpRoutes.cmdMcpAdd()
// ---------------------------------------------------------------------------

describe("McpRoutes.cmdMcpAdd()", () => {
  test("adds a new server and returns 200 with list of server names", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    const result = routes.cmdMcpAdd("new-tool", { command: "npx", args: ["-y", "@org/tool"] });
    expect(result.status).toBe(200);
    expect((result.data as { ok: boolean }).ok).toBe(true);
    const servers = (result.data as { servers: string[] }).servers;
    expect(servers).toContain("new-tool");
  });

  test("returns 409 when server name already exists", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    routes.cmdMcpAdd("existing-tool", { command: "cmd" });
    const second = routes.cmdMcpAdd("existing-tool", { command: "cmd2" });
    expect(second.status).toBe(409);
    expect((second.data as { error: string }).error).toContain("already exists");
  });

  test("persists mcpServers entry to .claude.json on disk", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    routes.cmdMcpAdd("persist-tool", { command: "run", env: { KEY: "val" } });
    const onDisk = JSON.parse(readFileSync(join(fc.dir, ".claude.json"), "utf-8")) as Record<string, unknown>;
    const entry = (onDisk.mcpServers as Record<string, Record<string, unknown>>)["persist-tool"];
    expect(entry.command).toBe("run");
    expect((entry.env as Record<string, string>).KEY).toBe("val");
  });

  test("omits env key when env is empty object", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    routes.cmdMcpAdd("no-env-tool", { command: "cmd", env: {} });
    const onDisk = JSON.parse(readFileSync(join(fc.dir, ".claude.json"), "utf-8")) as Record<string, unknown>;
    const entry = (onDisk.mcpServers as Record<string, Record<string, unknown>>)["no-env-tool"];
    expect(entry.env).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// McpRoutes.cmdMcpUpdate()
// ---------------------------------------------------------------------------

describe("McpRoutes.cmdMcpUpdate()", () => {
  test("returns 404 when server does not exist", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    const result = routes.cmdMcpUpdate("ghost-tool", { command: "new" });
    expect(result.status).toBe(404);
    expect((result.data as { error: string }).error).toContain("not found");
  });

  test("updates command of an existing server", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    routes.cmdMcpAdd("upd-tool", { command: "old-cmd" });
    const result = routes.cmdMcpUpdate("upd-tool", { command: "new-cmd" });
    expect(result.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(join(fc.dir, ".claude.json"), "utf-8")) as Record<string, unknown>;
    const entry = (onDisk.mcpServers as Record<string, Record<string, unknown>>)["upd-tool"];
    expect(entry.command).toBe("new-cmd");
  });

  test("removes env key when updated with empty env object", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    routes.cmdMcpAdd("env-upd-tool", { command: "cmd", env: { FOO: "bar" } });
    routes.cmdMcpUpdate("env-upd-tool", { env: {} });
    const onDisk = JSON.parse(readFileSync(join(fc.dir, ".claude.json"), "utf-8")) as Record<string, unknown>;
    const entry = (onDisk.mcpServers as Record<string, Record<string, unknown>>)["env-upd-tool"];
    expect(entry.env).toBeUndefined();
  });

  test("updates args array independently", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    routes.cmdMcpAdd("args-tool", { command: "cmd", args: ["old"] });
    routes.cmdMcpUpdate("args-tool", { args: ["new", "--flag"] });
    const onDisk = JSON.parse(readFileSync(join(fc.dir, ".claude.json"), "utf-8")) as Record<string, unknown>;
    const entry = (onDisk.mcpServers as Record<string, Record<string, unknown>>)["args-tool"];
    expect(entry.args).toEqual(["new", "--flag"]);
  });
});

// ---------------------------------------------------------------------------
// McpRoutes.cmdMcpDelete()
// ---------------------------------------------------------------------------

describe("McpRoutes.cmdMcpDelete()", () => {
  test("returns 404 when server does not exist", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    const result = routes.cmdMcpDelete("ghost-tool");
    expect(result.status).toBe(404);
    expect((result.data as { error: string }).error).toContain("not found");
  });

  test("removes an existing server and returns remaining servers list", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    routes.cmdMcpAdd("tool-a", { command: "a" });
    routes.cmdMcpAdd("tool-b", { command: "b" });
    const result = routes.cmdMcpDelete("tool-a");
    expect(result.status).toBe(200);
    const remaining = (result.data as { servers: string[] }).servers;
    expect(remaining).not.toContain("tool-a");
    expect(remaining).toContain("tool-b");
    // also verify disk
    const onDisk = JSON.parse(readFileSync(join(fc.dir, ".claude.json"), "utf-8")) as Record<string, unknown>;
    const servers = onDisk.mcpServers as Record<string, unknown>;
    expect(servers["tool-a"]).toBeUndefined();
    expect(servers["tool-b"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// McpRoutes.cmdMcpToggle()
// ---------------------------------------------------------------------------

describe("McpRoutes.cmdMcpToggle()", () => {
  test("adds server to disabledMcpServers on first toggle (disabled=true)", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    const result = routes.cmdMcpToggle("my-server");
    expect(result.status).toBe(200);
    expect((result.data as { ok: boolean; disabled: boolean }).ok).toBe(true);
    expect((result.data as { disabled: boolean }).disabled).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(fc.dir, "settings.json"), "utf-8")) as Record<string, unknown>;
    expect((onDisk.disabledMcpServers as string[])).toContain("my-server");
  });

  test("removes server from disabledMcpServers on second toggle (disabled=false)", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    routes.cmdMcpToggle("my-server"); // disable
    const result = routes.cmdMcpToggle("my-server"); // re-enable
    expect(result.status).toBe(200);
    expect((result.data as { disabled: boolean }).disabled).toBe(false);
    const onDisk = JSON.parse(readFileSync(join(fc.dir, "settings.json"), "utf-8")) as Record<string, unknown>;
    expect((onDisk.disabledMcpServers as string[])).not.toContain("my-server");
  });

  test("creates settings.json when it does not exist", () => {
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    expect(existsSync(join(fc.dir, "settings.json"))).toBe(false);
    routes.cmdMcpToggle("new-server");
    expect(existsSync(join(fc.dir, "settings.json"))).toBe(true);
  });

  test("preserves existing settings.json fields on toggle", () => {
    writeFileSync(join(fc.dir, "settings.json"), JSON.stringify({ theme: "dark", disabledMcpServers: [] }), "utf-8");
    const routes = new TempMcpRoutes(fc.ctx, fc.dir);
    routes.cmdMcpToggle("srv");
    const onDisk = JSON.parse(readFileSync(join(fc.dir, "settings.json"), "utf-8")) as Record<string, unknown>;
    expect(onDisk.theme).toBe("dark");
  });
});

// ---------------------------------------------------------------------------
// CustomizationRoutes.redactEnv()
// ---------------------------------------------------------------------------

describe("CustomizationRoutes.redactEnv()", () => {
  test("redacts KEY, SECRET, TOKEN, PASSWORD, CREDENTIAL values", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.redactEnv({
      API_KEY: "secret123",
      MY_SECRET: "hidden",
      AUTH_TOKEN: "tok",
      DB_PASSWORD: "p4ss",
      SOME_CREDENTIAL: "cred",
    });
    expect(result.API_KEY).toBe("***");
    expect(result.MY_SECRET).toBe("***");
    expect(result.AUTH_TOKEN).toBe("***");
    expect(result.DB_PASSWORD).toBe("***");
    expect(result.SOME_CREDENTIAL).toBe("***");
  });

  test("preserves non-sensitive env values", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.redactEnv({
      NODE_ENV: "production",
      PORT: "8080",
      LOG_LEVEL: "debug",
    });
    expect(result.NODE_ENV).toBe("production");
    expect(result.PORT).toBe("8080");
    expect(result.LOG_LEVEL).toBe("debug");
  });

  test("returns empty object for empty input", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    expect(routes.redactEnv({})).toEqual({});
  });

  test("is case-insensitive — lowercase 'key' is also redacted", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.redactEnv({ mapkey: "should-be-redacted", normal: "fine" });
    // SENSITIVE_ENV_KEYS = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i
    expect(result.mapkey).toBe("***");
    expect(result.normal).toBe("fine");
  });
});

// ---------------------------------------------------------------------------
// CustomizationRoutes.isAllowedCustomizationPath()
// ---------------------------------------------------------------------------

describe("CustomizationRoutes.isAllowedCustomizationPath()", () => {
  test("allows paths under ~/.claude/ (the Claude Code config dir)", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const allowed = join(homedir(), ".claude", "skills", "my-skill.md");
    expect(routes.isAllowedCustomizationPath(allowed)).toBe(true);
  });

  test("allows CLAUDE.md at a known session project root", () => {
    // fc.dir is set as the path for session "proj" in beforeEach
    const routes = new CustomizationRoutes(fc.ctx);
    const projClaude = join(fc.dir, "CLAUDE.md");
    expect(routes.isAllowedCustomizationPath(projClaude)).toBe(true);
  });

  test("allows AGENTS.md at a known session project root", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const projAgents = join(fc.dir, "AGENTS.md");
    expect(routes.isAllowedCustomizationPath(projAgents)).toBe(true);
  });

  test("allows paths under project .claude/ subdirectory", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const sub = join(fc.dir, ".claude", "skills", "proj-skill.md");
    expect(routes.isAllowedCustomizationPath(sub)).toBe(true);
  });

  test("rejects an arbitrary temp path not under any known project or ~/.claude/", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    expect(routes.isAllowedCustomizationPath("/tmp/evil-file.md")).toBe(false);
  });

  test("rejects root of a known session path (only CLAUDE.md / AGENTS.md are allowed, not the dir itself)", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    // The directory itself is not a permitted file
    expect(routes.isAllowedCustomizationPath(fc.dir)).toBe(false);
  });

  test("rejects empty string", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    expect(routes.isAllowedCustomizationPath("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CustomizationRoutes.readJsonFile()
// ---------------------------------------------------------------------------

describe("CustomizationRoutes.readJsonFile()", () => {
  test("returns null when file does not exist", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.readJsonFile(join(fc.dir, "nonexistent.json"));
    expect(result).toBeNull();
  });

  test("returns parsed object for valid JSON file", () => {
    const p = join(fc.dir, "test.json");
    writeFileSync(p, JSON.stringify({ hello: "world" }), "utf-8");
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.readJsonFile(p) as Record<string, unknown>;
    expect(result.hello).toBe("world");
  });

  test("returns null for malformed JSON", () => {
    const p = join(fc.dir, "bad.json");
    writeFileSync(p, "{ this is not json }", "utf-8");
    const routes = new CustomizationRoutes(fc.ctx);
    expect(routes.readJsonFile(p)).toBeNull();
  });

  test("returns null on permission/access error (graceful no-throw)", () => {
    // Pass a directory path — readFileSync throws EISDIR which should be caught
    const routes = new CustomizationRoutes(fc.ctx);
    expect(routes.readJsonFile(fc.dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CustomizationRoutes.cmdReadCustomizationFile() / cmdWriteCustomizationFile()
// ---------------------------------------------------------------------------

describe("CustomizationRoutes.cmdReadCustomizationFile()", () => {
  test("returns ok:false for an empty path", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.cmdReadCustomizationFile("");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not allowed");
  });

  test("returns ok:false for a disallowed path", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.cmdReadCustomizationFile("/tmp/evil.md");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not allowed");
  });

  test("reads CLAUDE.md from a known project path successfully", () => {
    const claudeMd = join(fc.dir, "CLAUDE.md");
    writeFileSync(claudeMd, "# Test Claude MD\n\nSome content.", "utf-8");
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.cmdReadCustomizationFile(claudeMd);
    expect(result.ok).toBe(true);
    expect((result.data as { content: string }).content).toContain("Test Claude MD");
  });

  test("returns ok:false with error when allowed file doesn't exist", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const missing = join(fc.dir, "CLAUDE.md");
    // don't create the file
    const result = routes.cmdReadCustomizationFile(missing);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to read file");
  });
});

describe("CustomizationRoutes.cmdWriteCustomizationFile()", () => {
  test("returns ok:false for a disallowed path", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.cmdWriteCustomizationFile("/tmp/evil.md", "content");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not allowed");
  });

  test("returns ok:false for a non-.md extension at an allowed path", () => {
    // Create a .json path that's inside the project .claude dir (allowed)
    const routes = new CustomizationRoutes(fc.ctx);
    const notMd = join(fc.dir, ".claude", "settings.json");
    mkdirSync(join(fc.dir, ".claude"), { recursive: true });
    const result = routes.cmdWriteCustomizationFile(notMd, "{}");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Only .md files");
  });

  test("writes CLAUDE.md to an allowed project path and round-trips", () => {
    const claudeMd = join(fc.dir, "CLAUDE.md");
    const routes = new CustomizationRoutes(fc.ctx);
    const writeResult = routes.cmdWriteCustomizationFile(claudeMd, "# Written by test\n");
    expect(writeResult.ok).toBe(true);
    expect((writeResult.data as { written: string }).written).toBe(claudeMd);
    // Round-trip: read back via cmdReadCustomizationFile
    const readResult = routes.cmdReadCustomizationFile(claudeMd);
    expect(readResult.ok).toBe(true);
    expect((readResult.data as { content: string }).content).toBe("# Written by test\n");
  });

  test("writes a skill .md file inside project .claude/skills/", () => {
    mkdirSync(join(fc.dir, ".claude", "skills"), { recursive: true });
    const skillPath = join(fc.dir, ".claude", "skills", "my-skill.md");
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.cmdWriteCustomizationFile(skillPath, "# Skill content\n");
    expect(result.ok).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe("# Skill content\n");
  });
});

// ---------------------------------------------------------------------------
// CustomizationRoutes.cmdCustomization()
// ---------------------------------------------------------------------------

describe("CustomizationRoutes.cmdCustomization()", () => {
  test("returns ok:true with expected data shape (no project path)", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.cmdCustomization();
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Array.isArray(data.mcpServers)).toBe(true);
    expect(Array.isArray(data.plugins)).toBe(true);
    expect(Array.isArray(data.skills)).toBe(true);
    expect(Array.isArray(data.plans)).toBe(true);
    expect(Array.isArray(data.claudeMds)).toBe(true);
    expect(Array.isArray(data.hooks)).toBe(true);
  });

  test("includes CLAUDE.md in claudeMds when it exists at the project path", () => {
    const claudeMd = join(fc.dir, "CLAUDE.md");
    writeFileSync(claudeMd, "# Project CLAUDE.md", "utf-8");
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.cmdCustomization(fc.dir);
    expect(result.ok).toBe(true);
    const claudeMds = (result.data as { claudeMds: Array<{ path: string }> }).claudeMds;
    expect(claudeMds.some((m) => m.path === claudeMd)).toBe(true);
  });

  test("picks up project skills (.md files) from <projectPath>/.claude/skills/", () => {
    const skillsDir = join(fc.dir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "test-skill.md"), "# Test skill", "utf-8");
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.cmdCustomization(fc.dir);
    expect(result.ok).toBe(true);
    const skills = (result.data as { skills: Array<{ name: string; scope: string }> }).skills;
    const projSkill = skills.find((s) => s.name === "test-skill" && s.scope === "project");
    expect(projSkill).toBeDefined();
  });

  test("reflects hooks defined in project settings.json", () => {
    const settingsDir = join(fc.dir, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        },
      }),
      "utf-8",
    );
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.cmdCustomization(fc.dir);
    expect(result.ok).toBe(true);
    const hooks = (result.data as { hooks: Array<{ event: string; command: string; scope: string }> }).hooks;
    const projHook = hooks.find((h) => h.scope === "project" && h.event === "PreToolUse");
    expect(projHook).toBeDefined();
    expect(projHook!.command).toBe("echo hi");
  });

  test("respects disabledMcpServers in project claude.json for the given projectPath", () => {
    // We can't control real ~/.claude.json path in McpRoutes-style here, but
    // cmdCustomization reads via readJsonFile(join(home, '.claude.json')) which
    // hits the REAL home. We verify the path key is returned in projectPath output field.
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.cmdCustomization(fc.dir);
    expect(result.ok).toBe(true);
    expect((result.data as { projectPath?: string }).projectPath).toBe(fc.dir);
  });
});

// ---------------------------------------------------------------------------
// CustomizationRoutes.cmdAllProjectsCustomization()
// ---------------------------------------------------------------------------

describe("CustomizationRoutes.cmdAllProjectsCustomization()", () => {
  test("returns ok:true with user and projects keys", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.cmdAllProjectsCustomization();
    expect(result.ok).toBe(true);
    const data = result.data as { user: unknown; projects: unknown };
    expect(data.user).toBeDefined();
    expect(Array.isArray(data.projects)).toBe(true);
  });

  test("user section has expected subkeys", () => {
    const routes = new CustomizationRoutes(fc.ctx);
    const result = routes.cmdAllProjectsCustomization();
    const user = (result.data as { user: Record<string, unknown> }).user;
    expect(Array.isArray(user.hooks)).toBe(true);
    expect(Array.isArray(user.skills)).toBe(true);
    expect(Array.isArray(user.plans)).toBe(true);
    expect(Array.isArray(user.commands)).toBe(true);
    expect(Array.isArray(user.memories)).toBe(true);
    expect(Array.isArray(user.claudeMds)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RestHandler dispatch — "mcp" case
// ---------------------------------------------------------------------------

describe("RestHandler — GET /api/mcp (list)", () => {
  /** Build a RestHandler with the McpRoutes overridden to point at fc.dir */
  function buildH(): RestHandler {
    const h = new RestHandler(fc.ctx, fakeAgentEngine(), new ToolEngine(fc.ctx));
    // Inject the temp-dir McpRoutes by overriding the private field
    (h as unknown as Record<string, unknown>).mcpRoutes = new TempMcpRoutes(fc.ctx, fc.dir);
    return h;
  }

  test("GET /api/mcp returns 200 with empty servers when .claude.json absent", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi("GET", "/api/mcp", "");
    expect(res.status).toBe(200);
    const servers = (res.data as { servers: unknown[] }).servers;
    expect(Array.isArray(servers)).toBe(true);
  });

  test("GET /api/mcp returns listed servers from .claude.json", async () => {
    writeFileSync(
      join(fc.dir, ".claude.json"),
      JSON.stringify({ mcpServers: { "listed-tool": { command: "run" } } }),
      "utf-8",
    );
    const h = buildH();
    const res = await h.handleDashboardApi("GET", "/api/mcp", "");
    expect(res.status).toBe(200);
    const servers = (res.data as { servers: Array<{ name: string }> }).servers;
    expect(servers.some((s) => s.name === "listed-tool")).toBe(true);
  });

  test("POST /api/mcp with missing name → 400", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi(
      "POST", "/api/mcp", JSON.stringify({ command: "cmd" }),
    );
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("name and command required");
  });

  test("POST /api/mcp adds a server → 200", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi(
      "POST", "/api/mcp",
      JSON.stringify({ name: "rest-tool", command: "run" }),
    );
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(join(fc.dir, ".claude.json"), "utf-8")) as Record<string, unknown>;
    expect((onDisk.mcpServers as Record<string, unknown>)["rest-tool"]).toBeDefined();
  });

  test("POST /api/mcp with invalid JSON → 400", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi("POST", "/api/mcp", "not-json");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("Invalid JSON body");
  });

  test("PUT /api/mcp/<name> updates existing server → 200", async () => {
    const h = buildH();
    // Add first
    await h.handleDashboardApi("POST", "/api/mcp", JSON.stringify({ name: "upd-rest", command: "old" }));
    // Update
    const res = await h.handleDashboardApi(
      "PUT", "/api/mcp/upd-rest",
      JSON.stringify({ command: "new-cmd" }),
    );
    expect(res.status).toBe(200);
  });

  test("PUT /api/mcp/<name> with invalid JSON → 400", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi("PUT", "/api/mcp/some-tool", "bad-json");
    expect(res.status).toBe(400);
  });

  test("DELETE /api/mcp/<name> removes server → 200", async () => {
    const h = buildH();
    await h.handleDashboardApi("POST", "/api/mcp", JSON.stringify({ name: "del-rest", command: "c" }));
    const res = await h.handleDashboardApi("DELETE", "/api/mcp/del-rest", "");
    expect(res.status).toBe(200);
  });

  test("POST /api/mcp/<name>/toggle toggles disabled state → 200", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi("POST", "/api/mcp/my-srv/toggle", "");
    expect(res.status).toBe(200);
    expect((res.data as { ok: boolean }).ok).toBe(true);
  });

  test("GET /api/mcp/<name>/toggle → 405 Method not allowed", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi("GET", "/api/mcp/my-srv/toggle", "");
    expect(res.status).toBe(405);
  });

  test("fallthrough (e.g. PATCH) → 405", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi("PATCH", "/api/mcp", "");
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// RestHandler dispatch — "customization" case
// ---------------------------------------------------------------------------

describe("RestHandler — GET /api/customization", () => {
  function buildH(): RestHandler {
    return new RestHandler(fc.ctx, fakeAgentEngine(), new ToolEngine(fc.ctx));
  }

  test("GET /api/customization returns 200 with ok:true data", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi("GET", "/api/customization", "");
    expect(res.status).toBe(200);
    // resp.ok=true → status 200 + data forwarded
    const d = res.data as Record<string, unknown>;
    expect(Array.isArray(d.mcpServers)).toBe(true);
  });

  test("GET /api/customization/<projectPath> passes the path to cmdCustomization", async () => {
    const h = buildH();
    // URI-encode the path as it would be in real requests
    const encoded = encodeURIComponent(fc.dir);
    const res = await h.handleDashboardApi("GET", `/api/customization/${encoded}`, "");
    expect(res.status).toBe(200);
    const d = res.data as { projectPath?: string };
    expect(d.projectPath).toBe(fc.dir);
  });

  test("GET /api/customization/all-projects returns 200", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi("GET", "/api/customization/all-projects", "");
    expect(res.status).toBe(200);
    const d = res.data as { user: unknown; projects: unknown };
    expect(Array.isArray(d.projects)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RestHandler dispatch — "customization-file" case
// ---------------------------------------------------------------------------

describe("RestHandler — GET/POST /api/customization-file", () => {
  function buildH(): RestHandler {
    return new RestHandler(fc.ctx, fakeAgentEngine(), new ToolEngine(fc.ctx));
  }

  test("GET /api/customization-file with no path segment → 400", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi("GET", "/api/customization-file", "");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("File path required");
  });

  test("GET /api/customization-file/<disallowed-path> → ok:false path not allowed", async () => {
    const h = buildH();
    const encoded = encodeURIComponent("tmp");
    const res = await h.handleDashboardApi("GET", `/api/customization-file/${encoded}`, "");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("not allowed");
  });

  test("GET /api/customization-file reads CLAUDE.md from known project path", async () => {
    const claudeMd = join(fc.dir, "CLAUDE.md");
    writeFileSync(claudeMd, "# From REST", "utf-8");
    const h = buildH();
    // The handler reconstructs the file path as:
    //   segments.slice(1).map(decodeURIComponent).join("/")
    // where segments = pathPart.replace(/^\/api\//, "").split("/").
    //
    // The dashboard (api.ts fetchFileContent) encodes each segment separately:
    // split("/").map(encodeURIComponent).join("/"). For an ABSOLUTE path the
    // leading "/" yields an empty first segment, so the URL is
    // "/api/customization-file//abs/path" and the backend's slice(1).join("/")
    // rebuilds ["","abs","path"].join("/") = "/abs/path" — leading slash
    // preserved. That production round-trip is NOT broken.
    //
    // Here we use the equivalent single-segment form (encodeURIComponent of the
    // whole path, "/"→"%2F"), which decodes back to the same absolute path.
    const encoded = encodeURIComponent(claudeMd); // encodes "/"→"%2F"
    const res = await h.handleDashboardApi("GET", `/api/customization-file/${encoded}`, "");
    expect(res.status).toBe(200);
    expect((res.data as { content: string }).content).toBe("# From REST");
  });

  test("POST /api/customization-file requires path and content in body", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi(
      "POST", "/api/customization-file",
      JSON.stringify({ path: "" }),
    );
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("path and content required");
  });

  test("POST /api/customization-file with invalid JSON → 400", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi("POST", "/api/customization-file", "not-json");
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("Invalid JSON body");
  });

  test("POST /api/customization-file writes CLAUDE.md to allowed project path", async () => {
    const claudeMd = join(fc.dir, "CLAUDE.md");
    const h = buildH();
    const res = await h.handleDashboardApi(
      "POST", "/api/customization-file",
      JSON.stringify({ path: claudeMd, content: "# REST write\n" }),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(claudeMd, "utf-8")).toBe("# REST write\n");
  });

  test("POST /api/customization-file to a disallowed path → ok:false path not allowed", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi(
      "POST", "/api/customization-file",
      JSON.stringify({ path: "/tmp/evil.md", content: "bad" }),
    );
    expect(res.status).toBe(400);
    expect((res.data as { error: string }).error).toContain("not allowed");
  });

  test("DELETE /api/customization-file → 405 Method not allowed", async () => {
    const h = buildH();
    const res = await h.handleDashboardApi("DELETE", "/api/customization-file", "");
    expect(res.status).toBe(405);
  });
});

// -- cross-platform project path handling -----------------------------------
//
// Claude Code keys per-project state as ~/.claude/projects/<mangled>. The
// mangling replaced [/.] only, so on Windows — where every project path is
// C:\Users\me\proj — the separators survived, the computed key never matched
// a real directory, and per-project memories silently resolved to nothing.

describe("mangleProjectKey", () => {
  test("POSIX paths mangle as before", () => {
    expect(mangleProjectKey("/home/u/git/proj")).toBe("-home-u-git-proj");
  });

  test("dots become dashes", () => {
    expect(mangleProjectKey("/home/u/my.proj")).toBe("-home-u-my-proj");
  });

  test("Windows separators and the drive colon are mangled", () => {
    // A colon cannot appear in a Windows directory name, so leaving it would
    // produce a key that can never be opened.
    expect(mangleProjectKey("C:\\Users\\me\\proj")).toBe("-C--Users-me-proj");
  });

  test("the result never contains a colon", () => {
    expect(mangleProjectKey("C:\\a")).not.toContain(":");
  });

  test("leading separators collapse to a single dash", () => {
    expect(mangleProjectKey("///a")).toBe("-a");
  });

  test("the result never contains a path separator", () => {
    for (const p of ["/a/b", "C:\\a\\b", "\\\\server\\share\\x"]) {
      const k = mangleProjectKey(p);
      expect(k).not.toContain("/");
      expect(k).not.toContain("\\");
    }
  });
});

describe("projectLabel", () => {
  test("returns the last POSIX segment", () => {
    expect(projectLabel("/home/u/git/operad")).toBe("operad");
  });

  test("returns the last Windows segment rather than the whole path", () => {
    expect(projectLabel("C:\\Users\\me\\operad")).toBe("operad");
  });

  test("a trailing separator does not produce an empty label", () => {
    expect(projectLabel("/home/u/operad/")).toBe("operad");
    expect(projectLabel("C:\\Users\\me\\operad\\")).toBe("operad");
  });

  test("a bare name is returned unchanged", () => {
    expect(projectLabel("operad")).toBe("operad");
  });
});
