/**
 * agent-settings.test.ts — the allow-listed agent settings the dashboard shows
 * and edits (Claude Code settings.json), transcript-retention reporting, and
 * the read-only Codex values.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CLAUDE_SETTINGS,
  describeClaudeSettings,
  validateSettingValue,
  applyClaudeSetting,
  transcriptRetention,
  describeCodexSettings,
} from "../agent-settings.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "operad-agent-settings-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const spec = (key: string) => {
  const s = CLAUDE_SETTINGS.find((x) => x.key === key);
  if (!s) throw new Error(`no spec ${key}`);
  return s;
};

describe("describeClaudeSettings", () => {
  test("reports set values and falls back to the default for unset ones", () => {
    const rows = describeClaudeSettings({ cleanupPeriodDays: 365, permissions: { defaultMode: "auto" } });
    const by = new Map(rows.map((r) => [r.key, r]));
    expect(by.get("cleanupPeriodDays")).toMatchObject({ value: 365, isSet: true, default: 30 });
    expect(by.get("permissions.defaultMode")).toMatchObject({ value: "auto", isSet: true });
    expect(by.get("alwaysThinkingEnabled")).toMatchObject({ isSet: false, value: null });
  });

  test("handles a missing settings file (null) as all-unset", () => {
    expect(describeClaudeSettings(null).every((r) => !r.isSet)).toBe(true);
  });
});

describe("validateSettingValue", () => {
  test("cleanupPeriodDays takes a whole number of days, at least 1", () => {
    expect(validateSettingValue(spec("cleanupPeriodDays"), 90)).toEqual({ ok: true, value: 90 });
    expect(validateSettingValue(spec("cleanupPeriodDays"), "120")).toEqual({ ok: true, value: 120 });
    // 0 makes Claude Code stop keeping transcripts at all: never set it from a form.
    expect(validateSettingValue(spec("cleanupPeriodDays"), 0).ok).toBe(false);
    expect(validateSettingValue(spec("cleanupPeriodDays"), 1.5).ok).toBe(false);
    expect(validateSettingValue(spec("cleanupPeriodDays"), "abc").ok).toBe(false);
  });

  test("enums accept only their listed options", () => {
    expect(validateSettingValue(spec("effortLevel"), "high")).toEqual({ ok: true, value: "high" });
    expect(validateSettingValue(spec("effortLevel"), "turbo").ok).toBe(false);
  });

  test("booleans accept true/false and their string forms", () => {
    expect(validateSettingValue(spec("alwaysThinkingEnabled"), "false")).toEqual({ ok: true, value: false });
    expect(validateSettingValue(spec("alwaysThinkingEnabled"), "yes").ok).toBe(false);
  });
});

describe("applyClaudeSetting", () => {
  test("sets one key and leaves every other key untouched", () => {
    const p = join(dir, "settings.json");
    const original = { cleanupPeriodDays: 30, hooks: { PreToolUse: [{ matcher: "Read" }] }, permissions: { defaultMode: "auto", allow: ["Bash(ls)"] } };
    writeFileSync(p, JSON.stringify(original, null, 2));
    const r = applyClaudeSetting(p, "cleanupPeriodDays", 365);
    expect(r.ok).toBe(true);
    const after = JSON.parse(readFileSync(p, "utf-8"));
    expect(after).toEqual({ ...original, cleanupPeriodDays: 365 });
  });

  test("writes a nested key without dropping its siblings", () => {
    const p = join(dir, "settings.json");
    writeFileSync(p, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    expect(applyClaudeSetting(p, "permissions.defaultMode", "plan").ok).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf-8")).permissions).toEqual({ allow: ["Bash(ls)"], defaultMode: "plan" });
  });

  test("null removes the key so Claude Code uses its default", () => {
    const p = join(dir, "settings.json");
    writeFileSync(p, JSON.stringify({ cleanupPeriodDays: 365, model: "opus" }));
    expect(applyClaudeSetting(p, "cleanupPeriodDays", null).ok).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ model: "opus" });
  });

  test("refuses keys outside the allow-list", () => {
    const p = join(dir, "settings.json");
    writeFileSync(p, "{}");
    const r = applyClaudeSetting(p, "hooks", { x: 1 });
    expect(r.ok).toBe(false);
    expect(readFileSync(p, "utf-8")).toBe("{}");
  });

  test("refuses to rewrite a settings file it cannot parse", () => {
    const p = join(dir, "settings.json");
    writeFileSync(p, "{ not json");
    expect(applyClaudeSetting(p, "cleanupPeriodDays", 60).ok).toBe(false);
    expect(readFileSync(p, "utf-8")).toBe("{ not json");
  });

  test("creates the file when it does not exist", () => {
    const p = join(dir, "sub", "settings.json");
    expect(applyClaudeSetting(p, "cleanupPeriodDays", 45).ok).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ cleanupPeriodDays: 45 });
  });

  test("leaves no temp file behind", () => {
    const p = join(dir, "settings.json");
    writeFileSync(p, "{}");
    applyClaudeSetting(p, "cleanupPeriodDays", 45);
    expect(existsSync(`${p}.operad-tmp`)).toBe(false);
  });
});

describe("transcriptRetention", () => {
  const DAY = 86_400_000;

  test("finds the least recently active transcript and when it is due for deletion", () => {
    const projects = join(dir, "projects");
    mkdirSync(join(projects, "-a"), { recursive: true });
    mkdirSync(join(projects, "-b", "uuid1", "subagents"), { recursive: true });
    const now = Date.UTC(2026, 10, 25);
    const old = join(projects, "-a", "s1.jsonl");
    const recent = join(projects, "-b", "s2.jsonl");
    writeFileSync(old, "{}\n");
    writeFileSync(recent, "{}\n");
    // A subagent transcript is not a session: it must not count.
    writeFileSync(join(projects, "-b", "uuid1", "subagents", "agent.jsonl"), "{}\n");
    utimesSync(old, new Date(now - 100 * DAY), new Date(now - 100 * DAY));
    utimesSync(recent, new Date(now - DAY), new Date(now - DAY));

    const r = transcriptRetention(projects, 365, now);
    expect(r.sessions).toBe(2);
    expect(r.projects).toBe(2);
    expect(r.oldest?.path).toBe(old);
    expect(r.oldest?.deletesAt).toBe(now - 100 * DAY + 365 * DAY);
    expect(r.overdue).toBe(0);
  });

  test("counts transcripts already past the period as overdue (deleted at the next Claude start)", () => {
    const projects = join(dir, "projects");
    mkdirSync(join(projects, "-a"), { recursive: true });
    const now = Date.UTC(2026, 10, 25);
    const f = join(projects, "-a", "s.jsonl");
    writeFileSync(f, "{}\n");
    utimesSync(f, new Date(now - 40 * DAY), new Date(now - 40 * DAY));
    expect(transcriptRetention(projects, 30, now).overdue).toBe(1);
  });

  test("an absent projects dir reports zero sessions", () => {
    const r = transcriptRetention(join(dir, "nope"), 30, Date.now());
    expect(r).toMatchObject({ sessions: 0, projects: 0, oldest: null, overdue: 0 });
  });
});

describe("describeCodexSettings", () => {
  test("reads model, reasoning effort and history persistence from config.toml", () => {
    const p = join(dir, "config.toml");
    writeFileSync(p, 'model = "gpt-x"\nmodel_reasoning_effort = "medium"\n[history]\npersistence = "none"\n');
    const by = new Map(describeCodexSettings(p).map((r) => [r.key, r]));
    expect(by.get("model")?.value).toBe("gpt-x");
    expect(by.get("model_reasoning_effort")?.value).toBe("medium");
    expect(by.get("history.persistence")).toMatchObject({ value: "none", isSet: true });
  });

  test("missing keys report unset with the documented default", () => {
    const p = join(dir, "config.toml");
    writeFileSync(p, 'model = "gpt-x"\n');
    const by = new Map(describeCodexSettings(p).map((r) => [r.key, r]));
    expect(by.get("history.persistence")).toMatchObject({ isSet: false, default: "save-all" });
  });

  test("an absent config file yields all-unset rows", () => {
    expect(describeCodexSettings(join(dir, "none.toml")).every((r) => !r.isSet)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REST: GET/POST /api/agent-settings
// ---------------------------------------------------------------------------

import { RestHandler } from "../rest-handler.js";
import { ToolEngine } from "../tool-engine.js";
import { makeFakeContext, fakeAgentEngine, type FakeContext } from "./helpers/fake-context.js";

describe("RestHandler /api/agent-settings", () => {
  let fc: FakeContext;
  let h: RestHandler;
  beforeEach(async () => {
    fc = await makeFakeContext();
    h = new RestHandler(fc.ctx, fakeAgentEngine(), new ToolEngine(fc.ctx));
    // Point the route at a scratch home so nothing touches the real ~/.claude.
    h.agentSettingsHome = dir;
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 365, hooks: {} }));
  });
  afterEach(() => fc.cleanup());

  test("GET reports Claude settings, retention and Codex values", async () => {
    const res = await h.handleDashboardApi("GET", "/api/agent-settings", "");
    expect(res.status).toBe(200);
    const d = res.data as {
      claude: { path: string; settings: Array<{ key: string; value: unknown }>; retention: { periodDays: number } };
      codex: { path: string; settings: unknown[] };
    };
    expect(d.claude.path).toBe(join(dir, ".claude", "settings.json"));
    expect(d.claude.settings.find((s) => s.key === "cleanupPeriodDays")?.value).toBe(365);
    expect(d.claude.retention.periodDays).toBe(365);
    expect(Array.isArray(d.codex.settings)).toBe(true);
  });

  test("retention uses the default 30 days when cleanupPeriodDays is unset", async () => {
    writeFileSync(join(dir, ".claude", "settings.json"), "{}");
    const res = await h.handleDashboardApi("GET", "/api/agent-settings", "");
    expect((res.data as { claude: { retention: { periodDays: number } } }).claude.retention.periodDays).toBe(30);
  });

  test("POST writes an allow-listed key", async () => {
    const res = await h.handleDashboardApi("POST", "/api/agent-settings", JSON.stringify({ key: "cleanupPeriodDays", value: 90 }));
    expect(res.status).toBe(200);
    const after = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
    expect(after).toEqual({ cleanupPeriodDays: 90, hooks: {} });
  });

  test("POST rejects an invalid value or a key outside the allow-list with 400", async () => {
    expect((await h.handleDashboardApi("POST", "/api/agent-settings", JSON.stringify({ key: "cleanupPeriodDays", value: 0 }))).status).toBe(400);
    expect((await h.handleDashboardApi("POST", "/api/agent-settings", JSON.stringify({ key: "hooks", value: {} }))).status).toBe(400);
    expect((await h.handleDashboardApi("POST", "/api/agent-settings", "not json")).status).toBe(400);
  });
});
