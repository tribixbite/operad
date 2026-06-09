/**
 * claude-json-extra.test.ts — Complementary tests for src/skills/claude-json.ts.
 *
 * skills.test.ts and skills-providers.test.ts already cover the broad
 * happy-path and collision matrix. This file adds:
 *
 *   • serializeMcpEntry edge cases (args omission, env on HTTP, no-env stdio)
 *   • Multiple simultaneous add + remove in one applyEdits call
 *   • Remove while add is also present (ordering: removes before adds)
 *   • Add + remove the same name in one call (net result: re-add wins)
 *   • SkillError shape emitted for each unique code path in applyEdits
 *   • writeClaudeJson real disk I/O via the _setClaudeJsonHome() override —
 *     redirects path resolution to a temp dir, no node:os mock, no HOME pollution
 *   • writeClaudeJson creates the file when absent
 *   • writeClaudeJson is idempotent (add same entry twice)
 *   • Stale lockfile (mtime > 30 s) is removed and lock is re-acquired
 *   • CLAUDE_JSON_MALFORMED thrown when file is invalid JSON
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// SECTION 1: applyEdits edge cases not covered by existing tests
// ---------------------------------------------------------------------------

// We import applyEdits directly — it is pure (no I/O).
import { applyEdits } from "../skills/claude-json.js";
import { SkillError, type SkillMcpEntry } from "../skills/types.js";
import type { OperadManagedEntry } from "../skills/claude-json.js";

const D1 = "daemon-one";
const D2 = "daemon-two";
const NOW = Math.floor(Date.now() / 1000);

const stdioNoArgs: SkillMcpEntry = { name: "bare-cmd", command: "bare", lifecycle: "config-only" };
const stdioWithArgs: SkillMcpEntry = {
  name: "full-cmd",
  command: "npx",
  args: ["-y", "@org/pkg"],
  lifecycle: "config-only",
};
const httpWithEnv: SkillMcpEntry = {
  name: "exa-env",
  url: "https://exa.test/mcp",
  transport: "http",
  env: { EXA_API_KEY: "key-123" },
  lifecycle: "config-only",
};
const sseNoEnv: SkillMcpEntry = {
  name: "sse-bare",
  url: "https://srv.test/sse",
  transport: "sse",
  lifecycle: "config-only",
};

// ── serializeMcpEntry (via applyEdits round-trip) ────────────────────────────

describe("claude-json applyEdits — serializeMcpEntry edge cases", () => {
  test("stdio entry WITHOUT args: 'args' key must be absent from wire format", () => {
    const result = applyEdits({}, {
      daemon_id: D1,
      add: [{ entry: stdioNoArgs, skill_id: "s:bare@v1" }],
    });
    const wire = (result.mcpServers as Record<string, Record<string, unknown>>)["bare-cmd"];
    expect(wire.command).toBe("bare");
    expect(wire.args).toBeUndefined();
  });

  test("stdio entry WITH args: 'args' key present with correct values", () => {
    const result = applyEdits({}, {
      daemon_id: D1,
      add: [{ entry: stdioWithArgs, skill_id: "s:full@v1" }],
    });
    const wire = (result.mcpServers as Record<string, Record<string, unknown>>)["full-cmd"];
    expect(wire.command).toBe("npx");
    expect(wire.args).toEqual(["-y", "@org/pkg"]);
    expect(wire.type).toBeUndefined();
  });

  test("stdio entry WITH env: env dict preserved, type absent", () => {
    const entryEnv: SkillMcpEntry = {
      name: "env-cmd",
      command: "run",
      env: { FOO: "bar" },
      lifecycle: "config-only",
    };
    const result = applyEdits({}, {
      daemon_id: D1,
      add: [{ entry: entryEnv, skill_id: "s:env-cmd@v1" }],
    });
    const wire = (result.mcpServers as Record<string, Record<string, unknown>>)["env-cmd"];
    expect(wire.env).toEqual({ FOO: "bar" });
    expect(wire.type).toBeUndefined();
  });

  test("stdio entry WITHOUT env: 'env' key must be absent from wire format", () => {
    const result = applyEdits({}, {
      daemon_id: D1,
      add: [{ entry: stdioNoArgs, skill_id: "s:bare@v1" }],
    });
    const wire = (result.mcpServers as Record<string, Record<string, unknown>>)["bare-cmd"];
    expect(wire.env).toBeUndefined();
  });

  test("HTTP entry WITH env: env included alongside type+url", () => {
    const result = applyEdits({}, {
      daemon_id: D1,
      add: [{ entry: httpWithEnv, skill_id: "s:exa-env@v1" }],
    });
    const wire = (result.mcpServers as Record<string, Record<string, unknown>>)["exa-env"];
    expect(wire.type).toBe("http");
    expect(wire.url).toBe("https://exa.test/mcp");
    expect(wire.env).toEqual({ EXA_API_KEY: "key-123" });
    expect(wire.command).toBeUndefined();
  });

  test("SSE entry WITHOUT env: 'env' key must be absent from wire format", () => {
    const result = applyEdits({}, {
      daemon_id: D1,
      add: [{ entry: sseNoEnv, skill_id: "s:sse@v1" }],
    });
    const wire = (result.mcpServers as Record<string, Record<string, unknown>>)["sse-bare"];
    expect(wire.type).toBe("sse");
    expect(wire.env).toBeUndefined();
  });

  test("http transport (not sse): type field is 'http', not 'sse'", () => {
    const httpEntry: SkillMcpEntry = {
      name: "pure-http",
      url: "https://api.test/mcp",
      transport: "http",
      lifecycle: "config-only",
    };
    const result = applyEdits({}, {
      daemon_id: D1,
      add: [{ entry: httpEntry, skill_id: "s:http@v1" }],
    });
    const wire = (result.mcpServers as Record<string, Record<string, unknown>>)["pure-http"];
    expect(wire.type).toBe("http");
  });
});

// ── Multi-operation calls ─────────────────────────────────────────────────────

describe("claude-json applyEdits — multiple adds + removes in one call", () => {
  test("adding two entries in one call: both land in mcpServers + operad_managed", () => {
    const e2: SkillMcpEntry = { name: "tool-b", command: "run-b", lifecycle: "config-only" };
    const result = applyEdits({}, {
      daemon_id: D1,
      add: [
        { entry: stdioNoArgs, skill_id: "s1" },
        { entry: e2, skill_id: "s2" },
      ],
    });
    const servers = result.mcpServers as Record<string, unknown>;
    const managed = result.operad_managed as Record<string, OperadManagedEntry>;
    expect(servers["bare-cmd"]).toBeDefined();
    expect(servers["tool-b"]).toBeDefined();
    expect(managed["bare-cmd"].skill_id).toBe("s1");
    expect(managed["tool-b"].skill_id).toBe("s2");
  });

  test("removing two entries in one call: both gone", () => {
    const pre: Record<string, unknown> = {
      mcpServers: {
        "tool-a": { command: "a" },
        "tool-b": { command: "b" },
        "tool-c": { command: "c" },
      },
      operad_managed: {
        "tool-a": { skill_id: "s1", daemon_id: D1, installed_at: 1 },
        "tool-b": { skill_id: "s2", daemon_id: D1, installed_at: 1 },
      },
    };
    const result = applyEdits(pre, {
      daemon_id: D1,
      remove: ["tool-a", "tool-b"],
    });
    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers["tool-a"]).toBeUndefined();
    expect(servers["tool-b"]).toBeUndefined();
    // User-owned tool-c must survive
    expect(servers["tool-c"]).toBeDefined();
  });

  test("remove then re-add in one call: net result is the entry being present", () => {
    // Scenario: same-name remove + add in one opts. GC runs first (orphan check),
    // then removes, then adds. The entry should exist after.
    const pre: Record<string, unknown> = {
      mcpServers: { "bare-cmd": { command: "old" } },
      operad_managed: { "bare-cmd": { skill_id: "old-sid", daemon_id: D1, installed_at: 1 } },
    };
    const result = applyEdits(pre, {
      daemon_id: D1,
      remove: ["bare-cmd"],
      add: [{ entry: stdioNoArgs, skill_id: "new-sid" }],
    });
    const servers = result.mcpServers as Record<string, unknown>;
    const managed = result.operad_managed as Record<string, OperadManagedEntry>;
    // Entry should exist with the NEW skill_id (add ran after remove)
    expect(servers["bare-cmd"]).toBeDefined();
    expect(managed["bare-cmd"].skill_id).toBe("new-sid");
  });

  test("mixed add + remove of different names in one call", () => {
    const pre: Record<string, unknown> = {
      mcpServers: {
        "old-tool": { command: "old" },
        "keep-tool": { command: "keep" },
      },
      operad_managed: {
        "old-tool": { skill_id: "old-sid", daemon_id: D1, installed_at: 1 },
        "keep-tool": { skill_id: "keep-sid", daemon_id: D1, installed_at: 1 },
      },
    };
    const newEntry: SkillMcpEntry = { name: "new-tool", command: "new", lifecycle: "config-only" };
    const result = applyEdits(pre, {
      daemon_id: D1,
      remove: ["old-tool"],
      add: [{ entry: newEntry, skill_id: "new-sid" }],
    });
    const servers = result.mcpServers as Record<string, unknown>;
    const managed = result.operad_managed as Record<string, OperadManagedEntry>;
    expect(servers["old-tool"]).toBeUndefined();
    expect(servers["keep-tool"]).toBeDefined();
    expect(servers["new-tool"]).toBeDefined();
    expect(managed["new-tool"].skill_id).toBe("new-sid");
    expect(managed["old-tool"]).toBeUndefined();
  });
});

// ── Error detail shapes ───────────────────────────────────────────────────────

describe("claude-json applyEdits — SkillError detail shapes", () => {
  test("MCP_NAME_USER_OWNED error includes the name in detail", () => {
    const pre = { mcpServers: { "my-mcp": { command: "usr" } } };
    let err: SkillError | null = null;
    try {
      applyEdits(pre, { daemon_id: D1, add: [{ entry: stdioNoArgs, skill_id: "x" }] });
    } catch (e) {
      err = e as SkillError;
    }
    // stdioNoArgs.name is "bare-cmd", not "my-mcp" — so this won't throw.
    // We need to test with a colliding name.
    err = null;
    const collidingEntry: SkillMcpEntry = { name: "my-mcp", command: "new", lifecycle: "config-only" };
    try {
      applyEdits(pre, { daemon_id: D1, add: [{ entry: collidingEntry, skill_id: "x" }] });
    } catch (e) {
      err = e as SkillError;
    }
    expect(err).not.toBeNull();
    expect(err!.code).toBe("MCP_NAME_USER_OWNED");
    expect(err!.detail?.name).toBe("my-mcp");
    expect(err!.message).toContain("[MCP_NAME_USER_OWNED]");
    expect(err!.name).toBe("SkillError");
  });

  test("MCP_OWNED_BY_OTHER_DAEMON on add includes all three IDs in detail", () => {
    const pre = {
      mcpServers: { "shared": { command: "x" } },
      operad_managed: { "shared": { skill_id: "s1", daemon_id: D2, installed_at: NOW } },
    };
    const entry: SkillMcpEntry = { name: "shared", command: "y", lifecycle: "config-only" };
    let err: SkillError | null = null;
    try {
      applyEdits(pre, { daemon_id: D1, add: [{ entry, skill_id: "x" }] });
    } catch (e) {
      err = e as SkillError;
    }
    expect(err!.code).toBe("MCP_OWNED_BY_OTHER_DAEMON");
    expect(err!.detail?.name).toBe("shared");
    expect(err!.detail?.owner_daemon_id).toBe(D2);
    expect(err!.detail?.our_daemon_id).toBe(D1);
    expect(err!.message).toContain("[MCP_OWNED_BY_OTHER_DAEMON]");
  });

  test("MCP_OWNED_BY_OTHER_DAEMON on remove includes all three IDs in detail", () => {
    const pre = {
      mcpServers: { "shared": { command: "x" } },
      operad_managed: { "shared": { skill_id: "s1", daemon_id: D2, installed_at: NOW } },
    };
    let err: SkillError | null = null;
    try {
      applyEdits(pre, { daemon_id: D1, remove: ["shared"] });
    } catch (e) {
      err = e as SkillError;
    }
    expect(err!.code).toBe("MCP_OWNED_BY_OTHER_DAEMON");
    expect(err!.detail?.name).toBe("shared");
    expect(err!.detail?.owner_daemon_id).toBe(D2);
    expect(err!.detail?.our_daemon_id).toBe(D1);
  });

  test("SkillError is instanceof Error", () => {
    const e = new SkillError("MCP_NAME_USER_OWNED", "test error", { name: "x" });
    expect(e instanceof Error).toBe(true);
    expect(e instanceof SkillError).toBe(true);
  });

  test("SkillError.message prefixes the code in brackets", () => {
    const e = new SkillError("CLAUDE_JSON_RACED", "concurrent write detected");
    expect(e.message).toBe("[CLAUDE_JSON_RACED] concurrent write detected");
  });

  test("SkillError.detail can be undefined", () => {
    const e = new SkillError("CLAUDE_JSON_MALFORMED", "bad json");
    expect(e.detail).toBeUndefined();
  });
});

// ── Orphan GC — boundary cases ────────────────────────────────────────────────

describe("claude-json applyEdits — orphan GC boundary cases", () => {
  test("multiple orphan entries are ALL removed in one pass", () => {
    const pre: Record<string, unknown> = {
      mcpServers: {},  // user deleted all server entries
      operad_managed: {
        "orphan-a": { skill_id: "s1", daemon_id: D1, installed_at: 1 },
        "orphan-b": { skill_id: "s2", daemon_id: D2, installed_at: 1 },
        "orphan-c": { skill_id: "s3", daemon_id: D1, installed_at: 1 },
      },
    };
    const result = applyEdits(pre, { daemon_id: D1 });
    const managed = result.operad_managed as Record<string, unknown>;
    expect(managed["orphan-a"]).toBeUndefined();
    expect(managed["orphan-b"]).toBeUndefined();
    expect(managed["orphan-c"]).toBeUndefined();
    expect(Object.keys(managed)).toHaveLength(0);
  });

  test("partial orphan: some entries present, some absent — only missing ones are pruned", () => {
    const pre: Record<string, unknown> = {
      mcpServers: {
        "still-here": { command: "cmd" },  // mcpServers entry exists
        // "gone" was manually deleted from mcpServers
      },
      operad_managed: {
        "still-here": { skill_id: "s1", daemon_id: D1, installed_at: 1 },
        "gone":        { skill_id: "s2", daemon_id: D1, installed_at: 1 },
      },
    };
    const result = applyEdits(pre, { daemon_id: D1 });
    const managed = result.operad_managed as Record<string, unknown>;
    expect(managed["still-here"]).toBeDefined();  // kept
    expect(managed["gone"]).toBeUndefined();       // pruned
  });

  test("GC removes orphan even if it belongs to another daemon", () => {
    // §3.5: orphan detection is by mcpServers absence, not ownership.
    // The user deleted mcpServers['foreign'] so we prune the entry
    // regardless of daemon_id.
    const pre: Record<string, unknown> = {
      mcpServers: {},
      operad_managed: {
        "foreign": { skill_id: "s1", daemon_id: D2, installed_at: 1 },
      },
    };
    const result = applyEdits(pre, { daemon_id: D1 });
    const managed = result.operad_managed as Record<string, unknown>;
    expect(managed["foreign"]).toBeUndefined();
  });
});

// ── Immutability contract ─────────────────────────────────────────────────────

describe("claude-json applyEdits — immutability", () => {
  test("deep mcpServers mutation via result does not affect the original input", () => {
    const input: Record<string, unknown> = {
      mcpServers: { existing: { command: "keep" } },
      operad_managed: { existing: { skill_id: "s1", daemon_id: D1, installed_at: 1 } },
    };
    const result = applyEdits(input, { daemon_id: D1, remove: ["existing"] });
    // Original must be unchanged
    const origServers = input.mcpServers as Record<string, unknown>;
    expect(origServers.existing).toBeDefined();
    // Result must reflect the removal
    const newServers = result.mcpServers as Record<string, unknown>;
    expect(newServers.existing).toBeUndefined();
  });

  test("adding to result does not appear in the original", () => {
    const input: Record<string, unknown> = {};
    const result = applyEdits(input, {
      daemon_id: D1,
      add: [{ entry: stdioNoArgs, skill_id: "s1" }],
    });
    expect(input.mcpServers).toBeUndefined();
    expect((result.mcpServers as Record<string, unknown>)["bare-cmd"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SECTION 2: writeClaudeJson — real disk I/O via the home override
//
// We redirect homedir()-based path resolution to a controlled temp dir using
// claude-json's own _setClaudeJsonHome() seam (reset to null in afterEach).
// This avoids process.env.HOME pollution, never touches the real
// ~/.claude.json, and — unlike mock.module("node:os") — cannot leak into
// sibling test files.
// ---------------------------------------------------------------------------

// Redirect ~/.claude.json resolution to a temp dir via claude-json's own home
// override (no node:os mocking — that would leak process-wide across files and
// os.homedir() can't be redirected via $HOME on bun anyway).
import { writeClaudeJson as writeClaudeJsonFn, _setClaudeJsonHome } from "../skills/claude-json.js";

describe("writeClaudeJson — disk integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "operad-cj-write-"));
    _setClaudeJsonHome(tmpDir);
  });

  afterEach(() => {
    _setClaudeJsonHome(null); // restore real path — never leak into sibling files
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates ~/.claude.json when it does not exist", () => {
    const path = join(tmpDir, ".claude.json");
    expect(existsSync(path)).toBe(false);
    writeClaudeJsonFn({ daemon_id: D1 });
    expect(existsSync(path)).toBe(true);
    const contents = JSON.parse(readFileSync(path, "utf8"));
    expect(typeof contents).toBe("object");
  });

  // Windows has no POSIX file-mode bits — Node ignores the `mode` option and
  // statSync reports a fixed ACL-derived mode, so 0o600 is unverifiable there.
  test.skipIf(process.platform === "win32")("creates ~/.claude.json with mode 0o600 (readable only by owner)", () => {
    const path = join(tmpDir, ".claude.json");
    writeClaudeJsonFn({ daemon_id: D1 });
    const { statSync } = require("node:fs");
    const stat = statSync(path);
    // 0o100600 = regular file + 0o600
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("write-then-read round-trips MCP entry correctly", () => {
    const entry: SkillMcpEntry = {
      name: "test-tool",
      command: "echo",
      args: ["hello"],
      lifecycle: "config-only",
    };
    writeClaudeJsonFn({
      daemon_id: D1,
      add: [{ entry, skill_id: "s:test@v1" }],
    });
    const path = join(tmpDir, ".claude.json");
    const readBack = JSON.parse(readFileSync(path, "utf8"));
    const mcp = readBack.mcpServers["test-tool"];
    expect(mcp.command).toBe("echo");
    expect(mcp.args).toEqual(["hello"]);
    const mgr = readBack.operad_managed["test-tool"] as OperadManagedEntry;
    expect(mgr.daemon_id).toBe(D1);
    expect(mgr.skill_id).toBe("s:test@v1");
  });

  test("idempotent: writing the same entry twice leaves one copy (not two)", () => {
    const entry: SkillMcpEntry = {
      name: "idem-tool",
      command: "run",
      lifecycle: "config-only",
    };
    writeClaudeJsonFn({ daemon_id: D1, add: [{ entry, skill_id: "s:v1" }] });
    writeClaudeJsonFn({ daemon_id: D1, add: [{ entry, skill_id: "s:v1" }] });
    const path = join(tmpDir, ".claude.json");
    const readBack = JSON.parse(readFileSync(path, "utf8"));
    const keys = Object.keys(readBack.mcpServers);
    expect(keys.filter((k) => k === "idem-tool")).toHaveLength(1);
  });

  test("add then remove: file ends up with empty mcpServers", () => {
    const entry: SkillMcpEntry = {
      name: "to-remove",
      command: "x",
      lifecycle: "config-only",
    };
    writeClaudeJsonFn({ daemon_id: D1, add: [{ entry, skill_id: "s:x@v1" }] });
    writeClaudeJsonFn({ daemon_id: D1, remove: ["to-remove"] });
    const path = join(tmpDir, ".claude.json");
    const readBack = JSON.parse(readFileSync(path, "utf8"));
    expect(readBack.mcpServers["to-remove"]).toBeUndefined();
    expect(readBack.operad_managed["to-remove"]).toBeUndefined();
  });

  test("malformed JSON throws CLAUDE_JSON_MALFORMED — operad never corrupts a broken file", () => {
    const path = join(tmpDir, ".claude.json");
    writeFileSync(path, "{ this is not json }", { mode: 0o600 });
    let err: SkillError | null = null;
    try {
      writeClaudeJsonFn({ daemon_id: D1 });
    } catch (e) {
      err = e as SkillError;
    }
    expect(err).not.toBeNull();
    expect(err!.code).toBe("CLAUDE_JSON_MALFORMED");
    // File must be UNCHANGED after the error
    expect(readFileSync(path, "utf8")).toBe("{ this is not json }");
  });

  test("pre-existing user keys (e.g. oauthAccount) are preserved across writes", () => {
    const path = join(tmpDir, ".claude.json");
    writeFileSync(
      path,
      JSON.stringify({ oauthAccount: "user-tok", globalSettings: { theme: "dark" } }),
      { mode: 0o600 },
    );
    const entry: SkillMcpEntry = { name: "pres-tool", command: "t", lifecycle: "config-only" };
    writeClaudeJsonFn({ daemon_id: D1, add: [{ entry, skill_id: "s1" }] });
    const readBack = JSON.parse(readFileSync(path, "utf8"));
    expect(readBack.oauthAccount).toBe("user-tok");
    expect(readBack.globalSettings.theme).toBe("dark");
    expect(readBack.mcpServers["pres-tool"]).toBeDefined();
  });
});

// ── Stale lockfile detection ──────────────────────────────────────────────────

describe("claude-json — stale lockfile removed and lock acquired", () => {
  let tmpDir2: string;

  beforeEach(() => {
    tmpDir2 = mkdtempSync(join(tmpdir(), "operad-cj-lock-"));
    _setClaudeJsonHome(tmpDir2);
  });

  afterEach(() => {
    _setClaudeJsonHome(null);
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  test("stale lockfile (mtime > 30s ago) is removed and write proceeds normally", () => {
    // Create a lockfile with an mtime 60 seconds in the past to simulate a
    // crashed previous daemon that never cleaned up.
    const lockFilePath = join(tmpDir2, ".claude.json.lock");
    writeFileSync(lockFilePath, "", { mode: 0o600 });

    // Set mtime 60 seconds in the past (well beyond the 30s stale threshold)
    const pastTime = new Date(Date.now() - 60_000);
    utimesSync(lockFilePath, pastTime, pastTime);

    // Confirm the stale lock exists before the write
    expect(existsSync(lockFilePath)).toBe(true);

    const entry: SkillMcpEntry = { name: "stale-test", command: "x", lifecycle: "config-only" };
    // This must succeed — the stale lock is removed and the write proceeds
    expect(() => writeClaudeJsonFn({
      daemon_id: D1,
      add: [{ entry, skill_id: "s:stale@v1" }],
    })).not.toThrow();

    const path = join(tmpDir2, ".claude.json");
    expect(existsSync(path)).toBe(true);
    const readBack = JSON.parse(readFileSync(path, "utf8"));
    expect(readBack.mcpServers["stale-test"]).toBeDefined();
  });

  test("lock file is cleaned up after successful write", () => {
    const lockFilePath = join(tmpDir2, ".claude.json.lock");
    const entry: SkillMcpEntry = { name: "lock-test", command: "l", lifecycle: "config-only" };
    writeClaudeJsonFn({ daemon_id: D1, add: [{ entry, skill_id: "s:l@v1" }] });
    // Lock file should not persist after a normal write
    expect(existsSync(lockFilePath)).toBe(false);
  });
});
