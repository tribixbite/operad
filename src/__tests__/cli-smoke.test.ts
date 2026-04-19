/**
 * Smoke tests for CLI commands — invokes dist/tmx.js as a subprocess
 * and verifies exit codes + stdout contents.
 *
 * Gracefully skips if dist/tmx.js hasn't been built yet.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { spawnSync as spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAEMON_BIN = join(process.cwd(), "dist/tmx.js");

let skipReason: string | null = null;

beforeAll(() => {
  if (!existsSync(DAEMON_BIN)) {
    skipReason = `dist/tmx.js not found — run 'bun run build' first`;
  }
});

describe.skipIf(skipReason !== null)("CLI — operad --version", () => {
  test("exits 0 and prints version string matching package.json", () => {
    const result = spawn("node", [DAEMON_BIN, "--version"], { encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/operad v\d+\.\d+\.\d+/);

    const pkgVer = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version;
    expect(result.stdout).toContain(pkgVer);
  });
});

/** Where `operad init` writes the config — platform-specific.
 *  Mirrors the runInit() logic in src/tmx.ts. */
function expectedConfigPath(tmpHome: string): string {
  if (process.platform === "win32") {
    // init prefers $APPDATA, falls back to USERPROFILE\AppData\Roaming
    return join(tmpHome, "AppData", "Roaming", "operad", "operad.toml");
  }
  return join(tmpHome, ".config", "operad", "operad.toml");
}

/** Cross-platform env override for a synthetic "fresh HOME". */
function freshHomeEnv(tmpHome: string): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return {
      ...process.env,
      USERPROFILE: tmpHome,
      // Force runInit to derive APPDATA from USERPROFILE so output lands inside tmpHome
      APPDATA: join(tmpHome, "AppData", "Roaming"),
      HOME: tmpHome,
    };
  }
  return { ...process.env, HOME: tmpHome };
}

describe.skipIf(skipReason !== null)("CLI — operad init", () => {
  test("creates a valid config on a fresh HOME and exits 0", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "operad-init-smoke-"));
    try {
      const result = spawn("node", [DAEMON_BIN, "init"], {
        encoding: "utf8",
        timeout: 5000,
        env: freshHomeEnv(tmpHome),
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Created/);

      const configPath = expectedConfigPath(tmpHome);
      expect(existsSync(configPath)).toBe(true);

      const body = readFileSync(configPath, "utf8");
      expect(body).toContain("[operad]");
      expect(body).toContain("[[session]]");
    } finally {
      try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  });

  test("is idempotent — second invocation does not overwrite", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "operad-init-idempotent-"));
    try {
      const first = spawn("node", [DAEMON_BIN, "init"], {
        encoding: "utf8",
        timeout: 5000,
        env: freshHomeEnv(tmpHome),
      });
      expect(first.status).toBe(0);

      const configPath = expectedConfigPath(tmpHome);
      const originalSize = readFileSync(configPath, "utf8").length;

      const second = spawn("node", [DAEMON_BIN, "init"], {
        encoding: "utf8",
        timeout: 5000,
        env: freshHomeEnv(tmpHome),
      });
      expect(second.status).toBe(0);
      expect(second.stdout).toMatch(/already exists/i);

      // File unchanged
      expect(readFileSync(configPath, "utf8").length).toBe(originalSize);
    } finally {
      try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  });
});

describe.skipIf(skipReason !== null)("CLI — operad doctor", () => {
  test("runs and emits the expected checklist format", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "operad-doctor-smoke-"));
    try {
      const result = spawn("node", [DAEMON_BIN, "doctor"], {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, HOME: tmpHome },
      });
      // Exit code: 0 if no failures, 1 if failures — both acceptable on different hosts.
      // What matters: the output must look like a checklist.
      expect([0, 1]).toContain(result.status ?? -1);
      // Output should contain at least one of the standard icons
      const output = result.stdout + result.stderr;
      const hasChecklistIcon = /\[OK\]|\[WARN\]|\[FAIL\]/.test(output);
      expect(hasChecklistIcon).toBe(true);
    } finally {
      try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  });
});
