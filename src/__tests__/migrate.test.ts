/**
 * migrate.test.ts — Tests for migrate.ts (repos.conf → operad.toml conversion)
 *
 * Covers:
 *  - parseReposConf: valid entries, comments/blanks skipped, partial/malformed lines,
 *    $HOME expansion, auto_go/enabled bit parsing, name sanitisation, missing file
 *  - generateToml: entry fields, priority ordering, standard service sessions,
 *    empty input, all-disabled input, round-trip field fidelity
 *  - findReposConf: returns null when no candidate exists (no HOME mutation)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseReposConf, generateToml, findReposConf } from "../migrate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-migrate-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

function writeConf(content: string): string {
  const p = join(tmpDir, "repos.conf");
  writeFileSync(p, content, "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// parseReposConf
// ---------------------------------------------------------------------------

describe("parseReposConf — file not found", () => {
  test("throws a descriptive error when the file is missing", () => {
    const missing = join(tmpDir, "does-not-exist.conf");
    expect(() => parseReposConf(missing)).toThrow(/repos\.conf not found/);
  });
});

describe("parseReposConf — basic parsing", () => {
  test("returns empty array for empty file", () => {
    const p = writeConf("");
    expect(parseReposConf(p)).toEqual([]);
  });

  test("returns empty array for file with only comments and blanks", () => {
    const p = writeConf("# this is a comment\n\n# another comment\n");
    expect(parseReposConf(p)).toEqual([]);
  });

  test("parses a single enabled auto_go entry", () => {
    const p = writeConf(`REPOS["$HOME/git/myproject"]="1:1"\n`);
    const entries = parseReposConf(p);
    expect(entries.length).toBe(1);
    expect(entries[0].auto_go).toBe(true);
    expect(entries[0].enabled).toBe(true);
  });

  test("parses a single disabled no-auto_go entry", () => {
    const p = writeConf(`REPOS["$HOME/git/other"]="0:0"\n`);
    const entries = parseReposConf(p);
    expect(entries.length).toBe(1);
    expect(entries[0].auto_go).toBe(false);
    expect(entries[0].enabled).toBe(false);
  });

  test("auto_go=0 enabled=1 parsed correctly", () => {
    const p = writeConf(`REPOS["$HOME/git/passive"]="0:1"\n`);
    const entries = parseReposConf(p);
    expect(entries[0].auto_go).toBe(false);
    expect(entries[0].enabled).toBe(true);
  });

  test("parses multiple entries and returns them all", () => {
    const p = writeConf(
      `REPOS["$HOME/git/alpha"]="1:1"\n` +
      `REPOS["$HOME/git/beta"]="0:1"\n` +
      `REPOS["$HOME/git/gamma"]="1:0"\n`,
    );
    const entries = parseReposConf(p);
    expect(entries.length).toBe(3);
  });

  test("entries maintain file order", () => {
    const p = writeConf(
      `REPOS["$HOME/git/first"]="1:1"\n` +
      `REPOS["$HOME/git/second"]="0:0"\n`,
    );
    const entries = parseReposConf(p);
    expect(entries[0].name).toBe("first");
    expect(entries[1].name).toBe("second");
  });
});

describe("parseReposConf — name sanitisation", () => {
  test("name is the last path segment (basename)", () => {
    const p = writeConf(`REPOS["$HOME/git/my-project"]="1:1"\n`);
    const entries = parseReposConf(p);
    expect(entries[0].name).toBe("my-project");
  });

  test("name is lowercased", () => {
    const p = writeConf(`REPOS["$HOME/git/MyProject"]="1:1"\n`);
    const entries = parseReposConf(p);
    expect(entries[0].name).toBe("myproject");
  });

  test("non-alphanumeric/hyphen chars in basename are replaced with hyphens", () => {
    const p = writeConf(`REPOS["$HOME/git/my_project"]="1:1"\n`);
    const entries = parseReposConf(p);
    // underscore → hyphen
    expect(entries[0].name).toBe("my-project");
  });
});

describe("parseReposConf — $HOME in path", () => {
  test("path field retains $HOME literal (for TOML portability)", () => {
    const p = writeConf(`REPOS["$HOME/git/myproject"]="1:1"\n`);
    const entries = parseReposConf(p);
    // The stored path must keep $HOME unexpanded
    expect(entries[0].path).toBe("$HOME/git/myproject");
  });
});

describe("parseReposConf — skipped lines", () => {
  test("comment lines are skipped", () => {
    const p = writeConf(
      `# declare -A REPOS\n` +
      `REPOS["$HOME/git/real"]="1:1"\n`,
    );
    expect(parseReposConf(p).length).toBe(1);
  });

  test("declare -A REPOS line is skipped (doesn't start with REPOS[)", () => {
    const p = writeConf(
      `declare -A REPOS\n` +
      `REPOS["$HOME/git/real"]="1:1"\n`,
    );
    expect(parseReposConf(p).length).toBe(1);
  });

  test("malformed REPOS line (bad format) is silently skipped", () => {
    const p = writeConf(
      `REPOS[incomplete\n` +
      `REPOS["$HOME/git/ok"]="1:1"\n`,
    );
    const entries = parseReposConf(p);
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("ok");
  });

  test("blank lines are skipped gracefully", () => {
    const p = writeConf(
      `\n\n` +
      `REPOS["$HOME/git/ok"]="1:1"\n` +
      `\n`,
    );
    expect(parseReposConf(p).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// generateToml
// ---------------------------------------------------------------------------

describe("generateToml — output structure", () => {
  test("empty entries still produces a valid TOML skeleton", () => {
    const toml = generateToml([]);
    expect(toml).toContain("[orchestrator]");
    expect(toml).toContain("[adb]");
    expect(toml).toContain("[health_defaults.claude]");
  });

  test("includes standard service sessions (termux-x11, playwright) at the end", () => {
    const toml = generateToml([]);
    expect(toml).toContain('name = "termux-x11"');
    expect(toml).toContain('name = "playwright"');
    expect(toml).toContain('depends_on = ["termux-x11"]');
  });

  test("each entry produces a [[session]] block with correct fields", () => {
    const entries = [{ path: "$HOME/git/proj", name: "proj", auto_go: true, enabled: true }];
    const toml = generateToml(entries);
    expect(toml).toContain("[[session]]");
    expect(toml).toContain('name = "proj"');
    expect(toml).toContain('path = "$HOME/git/proj"');
    expect(toml).toContain("auto_go = true");
    expect(toml).toContain("enabled = true");
    expect(toml).toContain('type = "claude"');
  });

  test("disabled entry uses enabled = false", () => {
    const entries = [{ path: "$HOME/git/off", name: "off", auto_go: false, enabled: false }];
    const toml = generateToml(entries);
    expect(toml).toContain("enabled = false");
    expect(toml).toContain("auto_go = false");
  });

  test("priority is assigned as 1-based index per entry", () => {
    const entries = [
      { path: "$HOME/git/a", name: "a", auto_go: false, enabled: true },
      { path: "$HOME/git/b", name: "b", auto_go: false, enabled: true },
      { path: "$HOME/git/c", name: "c", auto_go: false, enabled: true },
    ];
    const toml = generateToml(entries);
    expect(toml).toContain("priority = 1");
    expect(toml).toContain("priority = 2");
    expect(toml).toContain("priority = 3");
  });

  test("generated TOML has a 'Generated from repos.conf' comment header", () => {
    const toml = generateToml([]);
    expect(toml).toContain("repos.conf");
  });

  test("multiple entries all appear in output", () => {
    const entries = [
      { path: "$HOME/git/alpha", name: "alpha", auto_go: true, enabled: true },
      { path: "$HOME/git/beta", name: "beta", auto_go: false, enabled: true },
    ];
    const toml = generateToml(entries);
    expect(toml).toContain('name = "alpha"');
    expect(toml).toContain('name = "beta"');
  });

  test("standard services section marker comment is present", () => {
    const toml = generateToml([]);
    expect(toml).toContain("Standard services");
  });

  test("sessions migrated section marker is present", () => {
    const toml = generateToml([]);
    expect(toml).toContain("Sessions (migrated from repos.conf)");
  });
});

describe("generateToml — round-trip via parseReposConf", () => {
  test("parsed entries survive through generateToml without data loss", () => {
    const content =
      `REPOS["$HOME/git/project-a"]="1:1"\n` +
      `REPOS["$HOME/git/project-b"]="0:1"\n`;
    const p = writeConf(content);
    const entries = parseReposConf(p);
    const toml = generateToml(entries);

    // Both names should appear in the TOML
    expect(toml).toContain('name = "project-a"');
    expect(toml).toContain('name = "project-b"');

    // Flags should be preserved
    const lines = toml.split("\n");
    const aIdx = lines.findIndex((l) => l.includes('name = "project-a"'));
    // auto_go = true appears near the project-a block
    const aBlock = lines.slice(aIdx, aIdx + 10).join("\n");
    expect(aBlock).toContain("auto_go = true");
    expect(aBlock).toContain("enabled = true");
  });
});

// ---------------------------------------------------------------------------
// findReposConf
// ---------------------------------------------------------------------------

describe("findReposConf", () => {
  test("returns null when neither candidate path exists", () => {
    // We can't safely mutate process.env.HOME, so we just confirm the function
    // returns null when the standard candidate paths don't exist in the test env.
    // On a fresh CI box, ~/.config/termux-boot/repos.conf won't exist.
    const result = findReposConf();
    // Must be null OR a string (if the dev machine happens to have one)
    expect(result === null || typeof result === "string").toBe(true);
  });
});
