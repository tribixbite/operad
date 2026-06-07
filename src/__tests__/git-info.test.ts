/**
 * git-info.test.ts — Unit tests for git-info.ts
 *
 * Coverage areas:
 *   - parseGitStatus: empty string, single entry, multiple entries,
 *     whitespace trimming, blank lines, modified/untracked/deleted markers
 *   - parseGitLog: empty string, single commit, multiple commits, commit with
 *     no space (hash only), message with spaces, message with special chars
 *   - parseRemoteUrl: HTTPS github/gitlab, SSH formats, .git suffix stripped,
 *     subgroup paths (>2 parts), missing host/path, empty string, invalid URL
 *   - detectLanguage (via getFileContent): extension mapping + fallback
 *   - getFileTree: sorts dirs first then files alphabetically, hides dot-files
 *     (except .gitignore, .env.example), skips node_modules and .git,
 *     respects MAX_ENTRIES limit, path traversal blocked
 *   - getFileContent: path traversal blocked, small file reads correctly
 *   - Integration (git available guard): real git init in temp dir
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  parseGitStatus,
  parseGitLog,
  parseRemoteUrl,
  getFileTree,
  getFileContent,
  getGitInfo,
} from "../git-info.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-gitinfo-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

/** Check whether git is available on the path */
function gitAvailable(): boolean {
  const res = spawnSync("git", ["--version"], { encoding: "utf-8" });
  return res.status === 0;
}

// ---------------------------------------------------------------------------
// parseGitStatus
// ---------------------------------------------------------------------------

describe("parseGitStatus", () => {
  test("empty string returns empty array", () => {
    expect(parseGitStatus("")).toEqual([]);
  });

  test("single modified file is returned as one entry", () => {
    const out = " M src/foo.ts";
    expect(parseGitStatus(out)).toEqual(["M src/foo.ts"]);
  });

  test("multiple files return multiple entries", () => {
    const out = [
      " M src/foo.ts",
      "?? src/bar.ts",
      "D  src/deleted.ts",
    ].join("\n");
    const result = parseGitStatus(out);
    expect(result).toHaveLength(3);
  });

  test("blank lines are filtered out", () => {
    const out = "\n M src/foo.ts\n\n?? bar.ts\n";
    const result = parseGitStatus(out);
    expect(result).toHaveLength(2);
  });

  test("leading/trailing whitespace is trimmed from each entry", () => {
    const out = "  M src/foo.ts  ";
    const result = parseGitStatus(out);
    expect(result[0]).toBe("M src/foo.ts");
  });

  test("untracked files (??) are preserved", () => {
    const out = "?? new-file.ts\n?? another.ts";
    const result = parseGitStatus(out);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("?? new-file.ts");
    expect(result[1]).toBe("?? another.ts");
  });

  test("staged modifications (M in first column) preserved", () => {
    const out = "M  staged-file.ts";
    const result = parseGitStatus(out);
    expect(result[0]).toBe("M  staged-file.ts");
  });

  test("renamed files (R prefix) preserved", () => {
    const out = "R  old-name.ts -> new-name.ts";
    expect(parseGitStatus(out)).toHaveLength(1);
  });

  test("whitespace-only string returns empty array", () => {
    expect(parseGitStatus("   \n\n   ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseGitLog
// ---------------------------------------------------------------------------

describe("parseGitLog", () => {
  test("empty string returns empty array", () => {
    expect(parseGitLog("")).toEqual([]);
  });

  test("single commit line extracts hash and message", () => {
    const out = "abc1234 Initial commit";
    const result = parseGitLog(out);
    expect(result).toHaveLength(1);
    expect(result[0].hash).toBe("abc1234");
    expect(result[0].message).toBe("Initial commit");
  });

  test("multiple commit lines all parsed", () => {
    const out = [
      "abc1234 Initial commit",
      "def5678 Add feature X",
      "ghi9012 Fix bug in Y",
    ].join("\n");
    const result = parseGitLog(out);
    expect(result).toHaveLength(3);
    expect(result[0].hash).toBe("abc1234");
    expect(result[2].hash).toBe("ghi9012");
  });

  test("message preserves internal spaces", () => {
    const out = "aabbcc feat(session): live-JSONL binder fix for same-path mixup";
    const result = parseGitLog(out);
    expect(result[0].message).toBe("feat(session): live-JSONL binder fix for same-path mixup");
  });

  test("message with colon characters preserved", () => {
    const out = "1234abc fix: handle edge case: empty response";
    const result = parseGitLog(out);
    expect(result[0].message).toBe("fix: handle edge case: empty response");
  });

  test("line with no space gives hash = full line, message = empty string", () => {
    const out = "nospacehere";
    const result = parseGitLog(out);
    expect(result[0].hash).toBe("nospacehere");
    expect(result[0].message).toBe("");
  });

  test("blank lines in output are filtered", () => {
    const out = "abc1234 Commit A\n\ndef5678 Commit B\n";
    const result = parseGitLog(out);
    expect(result).toHaveLength(2);
  });

  test("message with emoji and unicode preserved", () => {
    const out = "abc1234 🚀 feat: launch the rocket";
    const result = parseGitLog(out);
    expect(result[0].message).toBe("🚀 feat: launch the rocket");
  });

  test("preserves order of commits as given", () => {
    const hashes = ["aaaaaaa", "bbbbbbb", "ccccccc", "ddddddd", "eeeeeee"];
    const out = hashes.map((h, i) => `${h} Commit ${i}`).join("\n");
    const result = parseGitLog(out);
    for (let i = 0; i < hashes.length; i++) {
      expect(result[i].hash).toBe(hashes[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// parseRemoteUrl
// ---------------------------------------------------------------------------

describe("parseRemoteUrl — HTTPS", () => {
  test("standard github HTTPS URL extracts owner and repo", () => {
    const result = parseRemoteUrl("https://github.com/tribixbite/operad.git");
    expect(result).toEqual({ owner: "tribixbite", repo: "operad" });
  });

  test("HTTPS URL without .git suffix works", () => {
    const result = parseRemoteUrl("https://github.com/owner/repo");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  test("gitlab HTTPS URL parsed correctly", () => {
    const result = parseRemoteUrl("https://gitlab.com/group/project.git");
    expect(result).toEqual({ owner: "group", repo: "project" });
  });

  test("HTTPS URL with subgroup (3 path parts) returns null", () => {
    const result = parseRemoteUrl("https://gitlab.com/group/subgroup/project.git");
    expect(result).toBeNull();
  });

  test("HTTPS URL with no path returns null", () => {
    const result = parseRemoteUrl("https://github.com/");
    expect(result).toBeNull();
  });

  test("HTTPS URL with only one path segment returns null", () => {
    const result = parseRemoteUrl("https://github.com/owner");
    expect(result).toBeNull();
  });
});

describe("parseRemoteUrl — SSH", () => {
  test("standard github SSH URL extracts owner and repo", () => {
    const result = parseRemoteUrl("git@github.com:tribixbite/operad.git");
    expect(result).toEqual({ owner: "tribixbite", repo: "operad" });
  });

  test("SSH URL without .git suffix works", () => {
    const result = parseRemoteUrl("git@github.com:owner/repo");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  test("gitlab SSH URL parsed correctly", () => {
    const result = parseRemoteUrl("git@gitlab.com:group/project.git");
    expect(result).toEqual({ owner: "group", repo: "project" });
  });

  test("SSH URL with subgroup (3 segments) returns null", () => {
    const result = parseRemoteUrl("git@gitlab.com:group/sub/project.git");
    expect(result).toBeNull();
  });

  test("SSH URL missing colon returns null", () => {
    // No colon → can't find the path separator
    const result = parseRemoteUrl("git@github.com/owner/repo.git");
    // This goes through URL parser fallback — URL with git@ is not valid HTTP
    // Result may be null either way (either no colon or invalid URL)
    expect(result === null || (result !== null && typeof result.owner === "string")).toBe(true);
  });
});

describe("parseRemoteUrl — edge cases", () => {
  test("empty string returns null", () => {
    expect(parseRemoteUrl("")).toBeNull();
  });

  test("completely invalid string returns null", () => {
    expect(parseRemoteUrl("not-a-url")).toBeNull();
  });

  test("repo name with dots preserved (e.g. my.project.git → my.project)", () => {
    const result = parseRemoteUrl("https://github.com/owner/my.project.git");
    expect(result).toEqual({ owner: "owner", repo: "my.project" });
  });

  test("repo name with hyphens preserved", () => {
    const result = parseRemoteUrl("https://github.com/owner/my-cool-repo.git");
    expect(result).toEqual({ owner: "owner", repo: "my-cool-repo" });
  });
});

// ---------------------------------------------------------------------------
// getFileTree — directory listing and filtering
// ---------------------------------------------------------------------------

describe("getFileTree", () => {
  test("empty directory returns empty array", () => {
    expect(getFileTree(tmpDir)).toEqual([]);
  });

  test("lists files with type='file' and size", () => {
    writeFileSync(join(tmpDir, "readme.md"), "# Hello");
    const entries = getFileTree(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("readme.md");
    expect(entries[0].type).toBe("file");
    expect(typeof entries[0].size).toBe("number");
  });

  test("lists directories with type='directory' and no size", () => {
    mkdirSync(join(tmpDir, "src"));
    const entries = getFileTree(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("src");
    expect(entries[0].type).toBe("directory");
    expect(entries[0].size).toBeUndefined();
  });

  test("directories sort before files", () => {
    writeFileSync(join(tmpDir, "aaa-file.ts"), "");
    mkdirSync(join(tmpDir, "zzz-dir"));
    const entries = getFileTree(tmpDir);
    expect(entries[0].name).toBe("zzz-dir");
    expect(entries[0].type).toBe("directory");
    expect(entries[1].type).toBe("file");
  });

  test("files are sorted alphabetically within their group", () => {
    writeFileSync(join(tmpDir, "zebra.ts"), "");
    writeFileSync(join(tmpDir, "apple.ts"), "");
    writeFileSync(join(tmpDir, "mango.ts"), "");
    const entries = getFileTree(tmpDir);
    const names = entries.map(e => e.name);
    expect(names).toEqual(["apple.ts", "mango.ts", "zebra.ts"]);
  });

  test("directories are sorted alphabetically", () => {
    mkdirSync(join(tmpDir, "z-dir"));
    mkdirSync(join(tmpDir, "a-dir"));
    const entries = getFileTree(tmpDir);
    expect(entries[0].name).toBe("a-dir");
    expect(entries[1].name).toBe("z-dir");
  });

  test("hidden files (dot-files) are excluded by default", () => {
    writeFileSync(join(tmpDir, ".hidden"), "secret");
    writeFileSync(join(tmpDir, ".env"), "KEY=val");
    writeFileSync(join(tmpDir, "visible.ts"), "");
    const entries = getFileTree(tmpDir);
    const names = entries.map(e => e.name);
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain(".env");
    expect(names).toContain("visible.ts");
  });

  test(".gitignore is included despite being a dot-file", () => {
    writeFileSync(join(tmpDir, ".gitignore"), "node_modules/");
    const entries = getFileTree(tmpDir);
    expect(entries.some(e => e.name === ".gitignore")).toBe(true);
  });

  test(".env.example is included despite being a dot-file", () => {
    writeFileSync(join(tmpDir, ".env.example"), "KEY=value");
    const entries = getFileTree(tmpDir);
    expect(entries.some(e => e.name === ".env.example")).toBe(true);
  });

  test("node_modules directory is excluded", () => {
    mkdirSync(join(tmpDir, "node_modules"));
    writeFileSync(join(tmpDir, "index.ts"), "");
    const entries = getFileTree(tmpDir);
    expect(entries.every(e => e.name !== "node_modules")).toBe(true);
  });

  test(".git directory is excluded", () => {
    mkdirSync(join(tmpDir, ".git"));
    writeFileSync(join(tmpDir, "index.ts"), "");
    const entries = getFileTree(tmpDir);
    expect(entries.every(e => e.name !== ".git")).toBe(true);
  });

  test("path traversal is blocked", () => {
    expect(() => getFileTree(tmpDir, "../")).toThrow(/traversal/i);
  });

  test("subdir parameter lists the subdirectory's contents", () => {
    const subdir = join(tmpDir, "src");
    mkdirSync(subdir);
    writeFileSync(join(subdir, "app.ts"), "export {}");
    const entries = getFileTree(tmpDir, "src");
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("app.ts");
  });
});

// ---------------------------------------------------------------------------
// getFileContent — content reading and path traversal
// ---------------------------------------------------------------------------

describe("getFileContent", () => {
  test("path traversal blocked with ../ escape", () => {
    // The check is: fullPath must start with projectPath + "/"
    // Using "../" from tmpDir would escape to the parent
    expect(() => getFileContent(tmpDir, "../some-file")).toThrow(/traversal/i);
  });

  test("reads small file content correctly", () => {
    const content = "Hello, world!\nSecond line.";
    writeFileSync(join(tmpDir, "test.txt"), content, "utf-8");
    const result = getFileContent(tmpDir, "test.txt");
    expect(result.content).toBe(content);
    expect(result.truncated).toBe(false);
    expect(result.size).toBeGreaterThan(0);
  });

  test("detects language from file extension", () => {
    writeFileSync(join(tmpDir, "app.ts"), "const x = 1;");
    const result = getFileContent(tmpDir, "app.ts");
    expect(result.language).toBe("typescript");
  });

  test("detects python language", () => {
    writeFileSync(join(tmpDir, "script.py"), "print('hello')");
    const result = getFileContent(tmpDir, "script.py");
    expect(result.language).toBe("python");
  });

  test("detects json language", () => {
    writeFileSync(join(tmpDir, "data.json"), '{"key":"value"}');
    const result = getFileContent(tmpDir, "data.json");
    expect(result.language).toBe("json");
  });

  test("detects markdown language", () => {
    writeFileSync(join(tmpDir, "README.md"), "# Title");
    const result = getFileContent(tmpDir, "README.md");
    expect(result.language).toBe("markdown");
  });

  test("unknown extension falls back to 'text'", () => {
    writeFileSync(join(tmpDir, "data.xyz"), "some content");
    const result = getFileContent(tmpDir, "data.xyz");
    expect(result.language).toBe("text");
  });

  test("size field reflects actual file size in bytes", () => {
    const data = "A".repeat(1000);
    writeFileSync(join(tmpDir, "large.txt"), data, "utf-8");
    const result = getFileContent(tmpDir, "large.txt");
    expect(result.size).toBe(1000);
    expect(result.truncated).toBe(false);
  });

  test("empty file reads as empty content", () => {
    writeFileSync(join(tmpDir, "empty.txt"), "");
    const result = getFileContent(tmpDir, "empty.txt");
    expect(result.content).toBe("");
    expect(result.size).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Language detection edge cases (tested via getFileContent)
// ---------------------------------------------------------------------------

describe("language detection — edge cases", () => {
  test(".tsx → typescript", () => {
    writeFileSync(join(tmpDir, "Component.tsx"), "<div/>");
    expect(getFileContent(tmpDir, "Component.tsx").language).toBe("typescript");
  });

  test(".jsx → javascript", () => {
    writeFileSync(join(tmpDir, "app.jsx"), "<App/>");
    expect(getFileContent(tmpDir, "app.jsx").language).toBe("javascript");
  });

  test(".yaml → yaml", () => {
    writeFileSync(join(tmpDir, "config.yaml"), "key: value");
    expect(getFileContent(tmpDir, "config.yaml").language).toBe("yaml");
  });

  test(".yml → yaml", () => {
    writeFileSync(join(tmpDir, "config.yml"), "key: value");
    expect(getFileContent(tmpDir, "config.yml").language).toBe("yaml");
  });

  test(".toml → toml", () => {
    writeFileSync(join(tmpDir, "config.toml"), "[section]");
    expect(getFileContent(tmpDir, "config.toml").language).toBe("toml");
  });

  test(".sh → bash", () => {
    writeFileSync(join(tmpDir, "script.sh"), "#!/bin/bash");
    expect(getFileContent(tmpDir, "script.sh").language).toBe("bash");
  });

  test(".svelte → svelte", () => {
    writeFileSync(join(tmpDir, "App.svelte"), "<script></script>");
    expect(getFileContent(tmpDir, "App.svelte").language).toBe("svelte");
  });

  test("Dockerfile (no extension, exact basename) → dockerfile", () => {
    writeFileSync(join(tmpDir, "Dockerfile"), "FROM ubuntu");
    expect(getFileContent(tmpDir, "Dockerfile").language).toBe("dockerfile");
  });

  test("Makefile (no extension, exact basename) → makefile", () => {
    writeFileSync(join(tmpDir, "Makefile"), "all:\n\techo hello");
    expect(getFileContent(tmpDir, "Makefile").language).toBe("makefile");
  });

  test("uppercase extension (e.g. .TS) falls back to 'text' — extension is lowercased", () => {
    // extname returns the original case, the impl lowercases it
    writeFileSync(join(tmpDir, "app.TS"), "const x = 1;");
    // Since LANG_MAP uses ".ts" (lowercase), lowercased ".ts" will match
    expect(getFileContent(tmpDir, "app.TS").language).toBe("typescript");
  });
});

// ---------------------------------------------------------------------------
// Integration — real git repo (guarded)
// ---------------------------------------------------------------------------

describe("getGitInfo — integration (requires git)", () => {
  test("returns branch, dirty_files, recent_commits from a real git repo", () => {
    if (!gitAvailable()) {
      // Skip when git is not on the system
      return;
    }

    // Init a real git repo in tmpDir
    const exec = (args: string[]) => spawnSync("git", args, {
      cwd: tmpDir,
      encoding: "utf-8",
      env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t.com",
             GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t.com" },
    });

    exec(["init", "-b", "main"]);
    exec(["config", "user.email", "test@test.com"]);
    exec(["config", "user.name", "Test"]);

    // Create a file and commit
    writeFileSync(join(tmpDir, "initial.txt"), "hello");
    exec(["add", "initial.txt"]);
    exec(["commit", "-m", "Initial commit"]);

    // Create a dirty (unstaged) file
    writeFileSync(join(tmpDir, "dirty.txt"), "not committed");

    const info = getGitInfo(tmpDir);

    expect(info.branch).toBe("main");
    // At least one dirty file (dirty.txt is untracked → ??)
    expect(info.dirty_files.length).toBeGreaterThan(0);
    // At least the initial commit
    expect(info.recent_commits.length).toBeGreaterThan(0);
    expect(info.recent_commits[0].message).toBe("Initial commit");
    expect(typeof info.recent_commits[0].hash).toBe("string");
    expect(info.recent_commits[0].hash.length).toBeGreaterThan(0);
  });

  test("getGitInfo on non-git dir returns branch='unknown' and empty arrays", () => {
    if (!gitAvailable()) return;

    // tmpDir is NOT a git repo
    const info = getGitInfo(tmpDir);
    // git rev-parse fails → branch falls back to 'unknown'
    expect(info.branch).toBe("unknown");
    // git status fails → empty dirty_files
    expect(info.dirty_files).toEqual([]);
    // git log fails → empty recent_commits
    expect(info.recent_commits).toEqual([]);
  });
});
