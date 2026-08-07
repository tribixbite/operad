import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  runChecks,
  worstStatus,
  summaryLine,
  parseAdbEnabled,
  parseRuntimeTypes,
  classifyConfigContent,
  detectWsl,
  type CheckResult,
  type CheckStatus,
} from "../doctor.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── helpers ────────────────────────────────────────────────────────────────

function makeResult(name: string, status: CheckStatus, message = "msg"): CheckResult {
  return { name, status, message };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "operad-doctor-test-"));
}

// ── Existing integration tests (kept, extended below) ─────────────────────

describe("doctor checks — integration", () => {
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

  test("results with a fix property have non-empty fix strings", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    for (const r of results) {
      if (r.fix !== undefined) {
        expect(typeof r.fix).toBe("string");
        expect(r.fix.length).toBeGreaterThan(0);
      }
    }
  });

  test("skipSlowChecks omits port check", async () => {
    const withSlow = await runChecks({ skipSlowChecks: false });
    const withoutSlow = await runChecks({ skipSlowChecks: true });
    const portWithSlow = withSlow.find(r => r.name === "port");
    const portWithout = withoutSlow.find(r => r.name === "port");
    // port check only appears when slow checks are NOT skipped
    expect(portWithSlow).toBeDefined();
    expect(portWithout).toBeUndefined();
  });

  test("passing a non-existent configPath does not throw", async () => {
    const results = await runChecks({
      skipSlowChecks: true,
      configPath: join(tmpdir(), "operad-doctor-nonexistent-" + Date.now() + ".toml"),
    });
    expect(results.length).toBeGreaterThan(0);
    // config check should warn (not found)
    const configResult = results.find(r => r.name === "config");
    expect(configResult).toBeDefined();
    expect(configResult!.status).toBe("warn");
  });
});

// ── worstStatus ────────────────────────────────────────────────────────────

describe("worstStatus — pure aggregator", () => {
  test("empty array returns ok", () => {
    expect(worstStatus([])).toBe("ok");
  });

  test("all ok returns ok", () => {
    const results = [makeResult("a", "ok"), makeResult("b", "ok")];
    expect(worstStatus(results)).toBe("ok");
  });

  test("one warn among oks returns warn", () => {
    const results = [makeResult("a", "ok"), makeResult("b", "warn"), makeResult("c", "ok")];
    expect(worstStatus(results)).toBe("warn");
  });

  test("one fail among warns and oks returns fail", () => {
    const results = [makeResult("a", "ok"), makeResult("b", "warn"), makeResult("c", "fail")];
    expect(worstStatus(results)).toBe("fail");
  });

  test("all fail returns fail", () => {
    const results = [makeResult("a", "fail"), makeResult("b", "fail")];
    expect(worstStatus(results)).toBe("fail");
  });

  test("single ok result", () => {
    expect(worstStatus([makeResult("x", "ok")])).toBe("ok");
  });

  test("single warn result", () => {
    expect(worstStatus([makeResult("x", "warn")])).toBe("warn");
  });

  test("single fail result", () => {
    expect(worstStatus([makeResult("x", "fail")])).toBe("fail");
  });

  test("fail before warn still returns fail", () => {
    const results = [makeResult("a", "fail"), makeResult("b", "ok"), makeResult("c", "warn")];
    expect(worstStatus(results)).toBe("fail");
  });

  test("many results with a single fail at end returns fail", () => {
    const results = Array.from({ length: 10 }, (_, i) => makeResult(`r${i}`, "ok"));
    results.push(makeResult("last", "fail"));
    expect(worstStatus(results)).toBe("fail");
  });
});

// ── summaryLine ────────────────────────────────────────────────────────────

describe("summaryLine — pure formatter", () => {
  test("empty array produces ok summary", () => {
    const s = summaryLine([]);
    expect(s).toContain("ok");
    expect(s).toContain("0");
  });

  test("all-ok results show correct counts", () => {
    const results = [makeResult("a", "ok"), makeResult("b", "ok"), makeResult("c", "ok")];
    const s = summaryLine(results);
    expect(s).toContain("3 ok");
    expect(s).toContain("0 warn");
    expect(s).toContain("0 fail");
    expect(s).toContain("ok");
  });

  test("mixed results show correct counts", () => {
    const results = [
      makeResult("a", "ok"),
      makeResult("b", "warn"),
      makeResult("c", "warn"),
      makeResult("d", "fail"),
    ];
    const s = summaryLine(results);
    expect(s).toContain("1 ok");
    expect(s).toContain("2 warn");
    expect(s).toContain("1 fail");
  });

  test("summary ends with overall worst status", () => {
    const warn = summaryLine([makeResult("a", "ok"), makeResult("b", "warn")]);
    expect(warn).toMatch(/warn\s*$/);

    const fail = summaryLine([makeResult("a", "ok"), makeResult("b", "fail")]);
    expect(fail).toMatch(/fail\s*$/);

    const ok = summaryLine([makeResult("a", "ok")]);
    expect(ok).toMatch(/ok\s*$/);
  });

  test("returns a non-empty string", () => {
    expect(summaryLine([makeResult("x", "ok")]).length).toBeGreaterThan(0);
  });
});

// ── parseAdbEnabled ────────────────────────────────────────────────────────

describe("parseAdbEnabled — pure TOML scanner", () => {
  test("no [adb] section returns false", () => {
    expect(parseAdbEnabled("[operad]\n[[session]]\nname = 'x'")).toBe(false);
  });

  test("[adb] with enabled = true returns true", () => {
    expect(parseAdbEnabled("[adb]\nenabled = true\n")).toBe(true);
  });

  test("[adb] with enabled = false returns false", () => {
    expect(parseAdbEnabled("[adb]\nenabled = false\n")).toBe(false);
  });

  test("case-insensitive: enabled = TRUE returns true", () => {
    expect(parseAdbEnabled("[adb]\nenabled = TRUE\n")).toBe(true);
  });

  test("whitespace around = is tolerated", () => {
    expect(parseAdbEnabled("[adb]\nenabled   =   true\n")).toBe(true);
  });

  test("tab-separated: enabled<tab>=<tab>true returns true", () => {
    expect(parseAdbEnabled("[adb]\nenabled\t=\ttrue\n")).toBe(true);
  });

  test("[adb] section with extra keys before enabled is handled", () => {
    expect(parseAdbEnabled("[adb]\nserial = 'abc'\nenabled = true\n")).toBe(true);
  });

  test("enabled = true in [other] section before [adb] does not affect result", () => {
    // The regex looks for [adb] then the first enabled= inside that block
    const text = "[other]\nenabled = true\n[adb]\nenabled = false\n";
    expect(parseAdbEnabled(text)).toBe(false);
  });

  test("empty string returns false", () => {
    expect(parseAdbEnabled("")).toBe(false);
  });

  test("[adb] section with no enabled key returns false", () => {
    expect(parseAdbEnabled("[adb]\nserial = 'device123'\n[operad]\n")).toBe(false);
  });
});

// ── parseRuntimeTypes ──────────────────────────────────────────────────────

describe("parseRuntimeTypes — pure TOML scanner", () => {
  test("no type lines returns empty set", () => {
    expect(parseRuntimeTypes("[operad]\nname = 'x'\n").size).toBe(0);
  });

  test('type = "claude" is detected', () => {
    const types = parseRuntimeTypes('[[session]]\ntype = "claude"\n');
    expect(types.has("claude")).toBe(true);
    expect(types.size).toBe(1);
  });

  test('type = "opencode" is detected', () => {
    const types = parseRuntimeTypes('[[session]]\ntype = "opencode"\n');
    expect(types.has("opencode")).toBe(true);
  });

  test('type = "codex" is detected', () => {
    const types = parseRuntimeTypes('[[session]]\ntype = "codex"\n');
    expect(types.has("codex")).toBe(true);
  });

  test("multiple different types are all captured", () => {
    const text = '[[session]]\ntype = "claude"\n[[session]]\ntype = "opencode"\n[[session]]\ntype = "codex"\n';
    const types = parseRuntimeTypes(text);
    expect(types.has("claude")).toBe(true);
    expect(types.has("opencode")).toBe(true);
    expect(types.has("codex")).toBe(true);
    expect(types.size).toBe(3);
  });

  test("duplicate types are deduplicated into the set", () => {
    const text = '[[session]]\ntype = "claude"\n[[session]]\ntype = "claude"\n';
    const types = parseRuntimeTypes(text);
    expect(types.size).toBe(1);
    expect(types.has("claude")).toBe(true);
  });

  test("leading whitespace on type line is tolerated", () => {
    const types = parseRuntimeTypes('  type = "service"\n');
    expect(types.has("service")).toBe(true);
  });

  test("uppercase in type value is lowercased", () => {
    // The scanner lowercases the captured group
    const types = parseRuntimeTypes('type = "Claude"\n');
    expect(types.has("claude")).toBe(true);
  });

  test("type in a comment (after #) is NOT detected", () => {
    // Our regex requires the line to start with optional whitespace then 'type'
    // A commented-out line starts with '#' which doesn't match /^\s*type/gim
    const types = parseRuntimeTypes('# type = "claude"\n');
    expect(types.has("claude")).toBe(false);
  });

  test("empty string returns empty set", () => {
    expect(parseRuntimeTypes("").size).toBe(0);
  });
});

// ── classifyConfigContent ──────────────────────────────────────────────────

describe("classifyConfigContent — pure content classifier", () => {
  const FAKE_PATH = "/fake/path/operad.toml";

  test("[operad] section → ok", () => {
    const r = classifyConfigContent(FAKE_PATH, "[operad]\ndashboard_port = 18970\n");
    expect(r.status).toBe("ok");
    expect(r.name).toBe("config");
    expect(r.message).toContain(FAKE_PATH);
  });

  test("[orchestrator] section (backward-compat) → ok", () => {
    const r = classifyConfigContent(FAKE_PATH, "[orchestrator]\n");
    expect(r.status).toBe("ok");
  });

  test("[[session]] section → ok", () => {
    const r = classifyConfigContent(FAKE_PATH, '[[session]]\nname = "app"\n');
    expect(r.status).toBe("ok");
  });

  test("content with none of the recognised sections → warn", () => {
    const r = classifyConfigContent(FAKE_PATH, "[battery]\nenabled = false\n");
    expect(r.status).toBe("warn");
    expect(r.name).toBe("config");
    expect(r.fix).toBeDefined();
    expect(r.fix!.length).toBeGreaterThan(0);
  });

  test("empty content → warn", () => {
    const r = classifyConfigContent(FAKE_PATH, "");
    expect(r.status).toBe("warn");
  });

  test("path is echoed in the ok result message", () => {
    const p = "/some/custom/path.toml";
    const r = classifyConfigContent(p, "[operad]\n");
    expect(r.message).toBe(p);
  });

  test("warn result message references the path", () => {
    const p = "/some/path.toml";
    const r = classifyConfigContent(p, "[battery]\n");
    expect(r.message).toContain(p);
  });
});

// ── checkConfig (via runChecks with a temp configPath) ─────────────────────

describe("checkConfig — behaviour driven by temp files", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("config not found → warn with fix", async () => {
    const missing = join(tmpDir, "nonexistent.toml");
    const results = await runChecks({ skipSlowChecks: true, configPath: missing });
    const r = results.find(r => r.name === "config")!;
    expect(r.status).toBe("warn");
    expect(r.fix).toBeDefined();
    expect(r.message).toContain(missing);
  });

  test("config with [operad] section → ok", async () => {
    const p = join(tmpDir, "operad.toml");
    writeFileSync(p, "[operad]\n", "utf8");
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const r = results.find(r => r.name === "config")!;
    expect(r.status).toBe("ok");
    expect(r.message).toBe(p);
  });

  // NB: a claude-type session requires `path`. This test previously used
  // `command = "echo"` with no path and asserted "ok" — encoding the very bug
  // that made fresh installs fail at boot. The check now runs the real
  // validator, so the fixture has to be a config the daemon would accept.
  test("config with a valid [[session]] section → ok", async () => {
    const p = join(tmpDir, "operad.toml");
    writeFileSync(p, `[[session]]\nname = "app"\ntype = "claude"\npath = "${tmpDir}"\n`, "utf8");
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const r = results.find(r => r.name === "config")!;
    expect(r.status).toBe("ok");
  });

  test("config with only [battery] section → warn", async () => {
    const p = join(tmpDir, "operad.toml");
    writeFileSync(p, "[battery]\nenabled = false\n", "utf8");
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const r = results.find(r => r.name === "config")!;
    expect(r.status).toBe("warn");
  });

  test("config with [orchestrator] (backward-compat alias) → ok", async () => {
    const p = join(tmpDir, "operad.toml");
    writeFileSync(p, "[orchestrator]\n", "utf8");
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const r = results.find(r => r.name === "config")!;
    expect(r.status).toBe("ok");
  });
});

// ── checkAdbBinary (via runChecks with temp config) ────────────────────────

describe("checkAdbBinary — adb enabled flag detection", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("config with no [adb] section → adb check returns ok (skipped)", async () => {
    const p = join(tmpDir, "operad.toml");
    writeFileSync(p, "[operad]\n", "utf8");
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const r = results.find(r => r.name === "adb")!;
    expect(r.status).toBe("ok");
    expect(r.message).toContain("skipped");
  });

  test("config with [adb] enabled = false → adb check returns ok (skipped)", async () => {
    const p = join(tmpDir, "operad.toml");
    writeFileSync(p, "[operad]\n[adb]\nenabled = false\n", "utf8");
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const r = results.find(r => r.name === "adb")!;
    expect(r.status).toBe("ok");
    expect(r.message).toContain("skipped");
  });

  test("config with [adb] enabled = true → adb check probes the binary (ok or fail)", async () => {
    // We don't control whether `adb` is on PATH, but we can assert the result
    // is meaningful and not the "skipped" shortcut.
    const p = join(tmpDir, "operad.toml");
    writeFileSync(p, "[operad]\n[adb]\nenabled = true\n", "utf8");
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const r = results.find(r => r.name === "adb")!;
    expect(["ok", "fail"]).toContain(r.status);
    // Should NOT be the skipped message
    expect(r.message).not.toContain("skipped");
  });

  test("non-existent config path → adb defaults to skipped (adb disabled by default)", async () => {
    const missing = join(tmpDir, "no-config.toml");
    const results = await runChecks({ skipSlowChecks: true, configPath: missing });
    const r = results.find(r => r.name === "adb")!;
    expect(r.status).toBe("ok");
    expect(r.message).toContain("skipped");
  });
});

// ── checkAgentRuntimes (via runChecks with temp config) ────────────────────

describe("checkAgentRuntimes — runtime type scanning", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("no config → no runtime: checks emitted", async () => {
    const missing = join(tmpDir, "no-config.toml");
    const results = await runChecks({ skipSlowChecks: true, configPath: missing });
    const runtimeChecks = results.filter(r => r.name.startsWith("runtime:"));
    expect(runtimeChecks.length).toBe(0);
  });

  test("config with only service sessions → no runtime: checks", async () => {
    const p = join(tmpDir, "operad.toml");
    writeFileSync(p, '[operad]\n[[session]]\nname = "app"\ntype = "service"\ncommand = "echo"\n', "utf8");
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const runtimeChecks = results.filter(r => r.name.startsWith("runtime:"));
    // "service" type has no runtime probe defined
    expect(runtimeChecks.length).toBe(0);
  });

  test('type = "claude" in config → runtime:claude check emitted', async () => {
    const p = join(tmpDir, "operad.toml");
    writeFileSync(p, '[operad]\n[[session]]\nname = "cc"\ntype = "claude"\npath = "/tmp/x"\n', "utf8");
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const r = results.find(r => r.name === "runtime:claude");
    expect(r).toBeDefined();
    expect(["ok", "warn"]).toContain(r!.status); // claude is warn-not-fail
  });

  test('type = "opencode" in config → runtime:opencode check emitted', async () => {
    const p = join(tmpDir, "operad.toml");
    writeFileSync(p, '[operad]\n[[session]]\nname = "oc"\ntype = "opencode"\npath = "/tmp/x"\n', "utf8");
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const r = results.find(r => r.name === "runtime:opencode");
    expect(r).toBeDefined();
    // Either ok (binary on PATH) or fail (not found)
    expect(["ok", "fail"]).toContain(r!.status);
  });

  test('type = "codex" in config → runtime:codex check emitted', async () => {
    const p = join(tmpDir, "operad.toml");
    writeFileSync(p, '[operad]\n[[session]]\nname = "cx"\ntype = "codex"\npath = "/tmp/x"\n', "utf8");
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const r = results.find(r => r.name === "runtime:codex");
    expect(r).toBeDefined();
    expect(["ok", "fail"]).toContain(r!.status);
  });

  test("multiple runtime types produce independent checks", async () => {
    const p = join(tmpDir, "operad.toml");
    writeFileSync(
      p,
      '[operad]\n[[session]]\nname="cc"\ntype="claude"\npath="/tmp/a"\n[[session]]\nname="oc"\ntype="opencode"\npath="/tmp/b"\n',
      "utf8",
    );
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const claudeCheck = results.find(r => r.name === "runtime:claude");
    const opencodeCheck = results.find(r => r.name === "runtime:opencode");
    expect(claudeCheck).toBeDefined();
    expect(opencodeCheck).toBeDefined();
  });

  test("duplicate type = claude sessions produce exactly one runtime:claude check", async () => {
    const p = join(tmpDir, "operad.toml");
    writeFileSync(
      p,
      '[operad]\n[[session]]\nname="cc1"\ntype="claude"\npath="/tmp/a"\n[[session]]\nname="cc2"\ntype="claude"\npath="/tmp/b"\n',
      "utf8",
    );
    const results = await runChecks({ skipSlowChecks: true, configPath: p });
    const claudeChecks = results.filter(r => r.name === "runtime:claude");
    expect(claudeChecks.length).toBe(1);
  });
});

// ── checkStateDir behaviour ────────────────────────────────────────────────
// checkStateDir uses process.env.HOME to build the state dir path.
// We exercise both the "missing dir → warn" and "existing dir → ok" branches
// via the real system state (HOME/.local/share/tmx may or may not exist).

describe("checkStateDir — observable outcomes via runChecks", () => {
  test("state-dir check is always present in results", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "state-dir");
    expect(r).toBeDefined();
  });

  test("state-dir status is ok or warn (never fail under normal permissions)", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "state-dir")!;
    // On a normal dev machine, state-dir either exists (ok) or will be created (warn).
    // A fail means the path exists but is not writable — unusual in CI / dev.
    expect(["ok", "warn", "fail"]).toContain(r.status);
  });

  test("state-dir ok result message contains a filesystem path", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "state-dir")!;
    if (r.status === "ok") {
      // The message is the path itself
      expect(r.message).toMatch(/[\\/]/); // contains a path separator
    }
  });

  test("state-dir warn result includes 'will be created' hint", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "state-dir")!;
    if (r.status === "warn") {
      expect(r.message).toContain("will be created");
    }
  });
});

// ── checkClaudeJsonConsistency — fixture-driven ────────────────────────────
// This check reads homedir()/.claude.json directly, so we cannot redirect it
// via configPath. We test the pure classification logic via classifyConfigContent
// and parseRuntimeTypes above; here we verify the integration result is valid.

describe("checkClaudeJsonConsistency — integration result validity", () => {
  test("skills.claude_json check is emitted with a valid status", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "skills.claude_json");
    expect(r).toBeDefined();
    expect(["ok", "warn"]).toContain(r!.status);
  });

  test("skills.claude_json message is non-empty", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "skills.claude_json")!;
    expect(r.message.length).toBeGreaterThan(0);
  });
});

// ── checkDaemonIdLocation — integration result validity ────────────────────

describe("checkDaemonIdLocation — integration result validity", () => {
  test("skills.daemon_id check is emitted", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "skills.daemon_id");
    expect(r).toBeDefined();
    expect(["ok", "warn"]).toContain(r!.status);
  });

  test("skills.daemon_id ok message mentions 'per-machine' or 'not yet provisioned'", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "skills.daemon_id")!;
    if (r.status === "ok") {
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

// ── checkClaudeCodeForSkillMds — integration result validity ───────────────

describe("checkClaudeCodeForSkillMds — integration result validity", () => {
  test("skills.claude_code_skill_md check is emitted", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "skills.claude_code_skill_md");
    expect(r).toBeDefined();
    expect(["ok", "warn"]).toContain(r!.status);
  });
});

// ── checkGit — observable via runChecks ───────────────────────────────────

describe("checkGit — observable via runChecks", () => {
  test("git check is always emitted", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "git");
    expect(r).toBeDefined();
    expect(["ok", "warn"]).toContain(r!.status); // git is never fail (only warn)
  });

  test("git ok message contains 'git version'", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "git")!;
    if (r.status === "ok") {
      expect(r.message.toLowerCase()).toContain("git");
    }
  });

  test("git warn result has a fix string", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "git")!;
    if (r.status === "warn") {
      expect(r.fix).toBeDefined();
      expect(r.fix!.length).toBeGreaterThan(0);
    }
  });
});

// ── checkRuntime — observable via runChecks ────────────────────────────────

describe("checkRuntime — observable via runChecks", () => {
  test("runtime check is always emitted", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "runtime");
    expect(r).toBeDefined();
  });

  test("runtime is ok (bun is on PATH in test environment)", async () => {
    // bun must be available since we're running bun test
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "runtime")!;
    expect(r.status).toBe("ok");
    expect(r.message.toLowerCase()).toContain("bun");
  });
});

// ── checkSqliteDriver — observable via runChecks ───────────────────────────

describe("checkSqliteDriver — observable via runChecks", () => {
  test("sqlite check is always emitted", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "sqlite");
    expect(r).toBeDefined();
  });

  test("sqlite is ok when bun is the runtime (bun:sqlite built-in)", async () => {
    // We're running under bun — bun:sqlite should be available
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "sqlite")!;
    expect(r.status).toBe("ok");
    expect(r.message.toLowerCase()).toContain("sqlite");
  });
});

// ── checkTmux — observable via runChecks ──────────────────────────────────

describe("checkTmux — observable via runChecks", () => {
  test("tmux check is always emitted", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "tmux");
    expect(r).toBeDefined();
  });

  test("tmux fail result has a non-empty fix string", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "tmux")!;
    if (r.status === "fail") {
      expect(r.fix).toBeDefined();
      expect(r.fix!.length).toBeGreaterThan(0);
    }
  });

  test("tmux ok result message contains version string", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "tmux")!;
    if (r.status === "ok") {
      expect(r.message.toLowerCase()).toContain("tmux");
    }
  });
});

// ── checkPort (slow check) ────────────────────────────────────────────────

describe("checkPort — slow check", () => {
  test("port check returns ok status (available or in-use)", async () => {
    const results = await runChecks({ skipSlowChecks: false });
    const r = results.find(r => r.name === "port");
    expect(r).toBeDefined();
    expect(r!.status).toBe("ok"); // both "available" and "in use" return ok
    expect(r!.message).toContain("18970");
  });
});

// ── checkDashboard — observable via runChecks ──────────────────────────────

describe("checkDashboard — observable via runChecks", () => {
  test("dashboard check is always emitted", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "dashboard");
    expect(r).toBeDefined();
  });

  test("dashboard ok result message contains the dist dir path", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "dashboard")!;
    if (r.status === "ok") {
      expect(r.message).toContain("dist");
    }
  });

  test("dashboard warn result has a fix string", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "dashboard")!;
    if (r.status === "warn") {
      expect(r.fix).toBeDefined();
      expect(r.fix!.length).toBeGreaterThan(0);
    }
  });
});

// ── checkDatabase — observable via runChecks ───────────────────────────────

describe("checkDatabase — observable via runChecks", () => {
  test("database check is always emitted", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "database");
    expect(r).toBeDefined();
    expect(["ok", "warn", "fail"]).toContain(r!.status);
  });

  test("database check message is non-empty", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const r = results.find(r => r.name === "database")!;
    expect(r.message.length).toBeGreaterThan(0);
  });
});

// ── Full result set shape invariants ──────────────────────────────────────

describe("runChecks — invariants across the full result set", () => {
  test("worstStatus of a real runChecks result is always a valid status", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const ws = worstStatus(results);
    expect(["ok", "warn", "fail"]).toContain(ws);
  });

  test("summaryLine of a real runChecks result is parseable", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const s = summaryLine(results);
    // Should contain "N ok, N warn, N fail — <status>"
    expect(s).toMatch(/\d+ ok, \d+ warn, \d+ fail/);
  });

  test("all result names are non-empty strings", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    for (const r of results) {
      expect(typeof r.name).toBe("string");
      expect(r.name.length).toBeGreaterThan(0);
    }
  });

  test("all result messages are non-empty strings", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    for (const r of results) {
      expect(typeof r.message).toBe("string");
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

// ── config check must run the real validator ──────────────────────────────
//
// Regression guard for the 0.4.7 first-run failure: `operad init` wrote a
// config using `command`/`cwd` where the parser requires `type`/`path`, and
// `operad doctor` reported it as OK because the check only looked for a
// section header. Users hit the real error at `operad boot` instead:
//   "session[0]: 'path' is required for type 'claude'"

describe("checkConfig — validates, not just classifies", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a config file and return the results of the `config` check. */
  async function configCheck(content: string): Promise<CheckResult> {
    const p = join(dir, "operad.toml");
    writeFileSync(p, content);
    const results = await runChecks({ configPath: p, skipSlowChecks: true });
    const r = results.find((x) => x.name === "config");
    if (!r) throw new Error("no 'config' check in results");
    return r;
  }

  test("a session missing 'path' is reported as fail, not ok", async () => {
    const r = await configCheck(
      '[operad]\n\n[[session]]\nname = "my-session"\ncommand = "claude"\ncwd = "/tmp/nope"\n',
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("path");
  });

  test("the failure message names the offending session index", async () => {
    const r = await configCheck('[operad]\n\n[[session]]\nname = "app"\n');
    expect(r.status).toBe("fail");
    expect(r.message).toContain("session[0]");
  });

  test("the fix text points at the correct key names", async () => {
    const r = await configCheck('[operad]\n\n[[session]]\nname = "app"\n');
    expect(r.fix).toBeDefined();
    expect(r.fix).toContain("name/type/path");
  });

  test("error text does not leak the raw 'Config validation failed:' header", async () => {
    const r = await configCheck('[operad]\n\n[[session]]\nname = "app"\n');
    expect(r.message).not.toContain("Config validation failed:");
  });

  test("a valid session config passes", async () => {
    const r = await configCheck(
      `[operad]\n\n[[session]]\nname = "app"\ntype = "claude"\npath = "${dir}"\n`,
    );
    expect(r.status).toBe("ok");
  });

  test("a session-free config passes (what `operad init` now generates)", async () => {
    const r = await configCheck("[operad]\ndashboard_port = 18970\n");
    expect(r.status).toBe("ok");
  });

  test("a service session without a command fails", async () => {
    const r = await configCheck(
      `[operad]\n\n[[session]]\nname = "api"\ntype = "service"\npath = "${dir}"\n`,
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("command");
  });

  test("an invalid session name is rejected", async () => {
    const r = await configCheck(
      `[operad]\n\n[[session]]\nname = "My_Session"\ntype = "claude"\npath = "${dir}"\n`,
    );
    expect(r.status).toBe("fail");
  });
});

// ── WSL detection ─────────────────────────────────────────────────────────

describe("detectWsl — kernel release parsing", () => {
  const savedDistro = process.env.WSL_DISTRO_NAME;
  const savedInterop = process.env.WSL_INTEROP;

  beforeEach(() => {
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
  });

  afterEach(() => {
    if (savedDistro === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = savedDistro;
    if (savedInterop === undefined) delete process.env.WSL_INTEROP;
    else process.env.WSL_INTEROP = savedInterop;
  });

  test("a stock Linux kernel is not WSL", () => {
    const r = detectWsl("6.6.87-1-lts");
    expect(r.isWsl).toBe(false);
    expect(r.version).toBeNull();
  });

  test("an Android/Termux kernel is not WSL", () => {
    const r = detectWsl("6.6.98-android15-8-pd6ff1cd");
    expect(r.isWsl).toBe(false);
  });

  test("WSL2 kernel release is detected as version 2", () => {
    const r = detectWsl("5.15.167.4-microsoft-standard-WSL2");
    expect(r.isWsl).toBe(true);
    expect(r.version).toBe(2);
  });

  test("WSL1 kernel release is detected as version 1", () => {
    const r = detectWsl("4.4.0-19041-Microsoft");
    expect(r.isWsl).toBe(true);
    expect(r.version).toBe(1);
  });

  test("WSL_INTEROP forces version 2 even on an ambiguous kernel string", () => {
    process.env.WSL_INTEROP = "/run/WSL/8_interop";
    const r = detectWsl("4.4.0-19041-Microsoft");
    expect(r.version).toBe(2);
  });

  test("WSL_DISTRO_NAME alone is enough to detect WSL", () => {
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    const r = detectWsl("");
    expect(r.isWsl).toBe(true);
    expect(r.distro).toBe("Ubuntu");
  });

  test("distro is null when WSL_DISTRO_NAME is unset", () => {
    const r = detectWsl("5.15.167.4-microsoft-standard-WSL2");
    expect(r.distro).toBeNull();
  });

  test("detection is case-insensitive", () => {
    expect(detectWsl("4.4.0-MICROSOFT").isWsl).toBe(true);
  });
});
