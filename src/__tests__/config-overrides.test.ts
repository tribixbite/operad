/**
 * config-overrides.test.ts — runtime overlay JSON.
 *
 * Pins the read/patch/save contract. The overlay is what backs the
 * dashboard's Settings forms (SDK defaults, quota knobs) without
 * mutating the user's TOML, so silent regressions here would let the
 * Settings UI lie about persistence.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";

import {
  loadOverrides,
  patchOverrides,
  saveOverrides,
  overridesPathFor,
  type ConfigOverrides,
} from "../config-overrides.js";

let tmp: string;
let stateFile: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "operad-overrides-test-"));
  stateFile = join(tmp, "state.json");
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe("loadOverrides", () => {
  test("missing file returns empty overlay", () => {
    expect(loadOverrides(stateFile)).toEqual({});
  });

  test("malformed JSON returns empty overlay (never throws)", () => {
    writeFileSync(overridesPathFor(stateFile), "{not valid json", "utf8");
    expect(loadOverrides(stateFile)).toEqual({});
  });

  test("valid overlay round-trips fields", () => {
    const o: ConfigOverrides = {
      sdk: { effort: "max", thinking: "enabled", max_budget_usd: 1.5, model: "claude-opus-4-7" },
      quota: { warning_pct: 75, critical_pct: 92, weekly_tokens: 1_000_000 },
    };
    saveOverrides(stateFile, o);
    expect(loadOverrides(stateFile)).toEqual(o);
  });

  test("sanitises bogus fields (drops unknown enum values)", () => {
    writeFileSync(
      overridesPathFor(stateFile),
      JSON.stringify({
        sdk: { effort: "ultra", thinking: "off", max_budget_usd: -5, model: 42 },
        quota: { warning_pct: -1, weekly_tokens: "lots" },
      }),
      "utf8",
    );
    // effort "ultra" is not in the union → dropped
    // thinking "off" → dropped
    // max_budget_usd -5 → dropped (must be ≥ 0)
    // model 42 → dropped (must be string)
    // warning_pct -1 → dropped (must be ≥ 0)
    // weekly_tokens "lots" → dropped (must be number)
    expect(loadOverrides(stateFile)).toEqual({});
  });
});

describe("patchOverrides — shallow merge per sub-object", () => {
  test("first patch creates the file with only the supplied fields", () => {
    patchOverrides(stateFile, { sdk: { effort: "high" } });
    const got = loadOverrides(stateFile);
    expect(got.sdk).toEqual({ effort: "high" });
    expect(got.quota).toBeUndefined();
  });

  test("subsequent patch preserves prior keys in the same sub-object", () => {
    patchOverrides(stateFile, { sdk: { effort: "high", model: "x" } });
    patchOverrides(stateFile, { sdk: { effort: "max" } });
    const got = loadOverrides(stateFile);
    expect(got.sdk).toEqual({ effort: "max", model: "x" });
  });

  test("patches across sub-objects don't bleed into each other", () => {
    patchOverrides(stateFile, { sdk: { effort: "low" } });
    patchOverrides(stateFile, { quota: { warning_pct: 60 } });
    const got = loadOverrides(stateFile);
    expect(got.sdk).toEqual({ effort: "low" });
    expect(got.quota).toEqual({ warning_pct: 60 });
  });

  test("empty sub-objects are stripped from the persisted file", () => {
    saveOverrides(stateFile, { sdk: {} });
    const path = overridesPathFor(stateFile);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    // Sanitiser drops empty sub-objects entirely.
    expect(raw.sdk).toBeUndefined();
  });
});

describe("saveOverrides — atomic write", () => {
  test("creates the parent dir when missing", () => {
    const stateInNewDir = join(tmp, "deep", "nest", "state.json");
    saveOverrides(stateInNewDir, { sdk: { model: "x" } });
    expect(existsSync(overridesPathFor(stateInNewDir))).toBe(true);
  });

  test("temp-file-then-rename leaves no .tmp behind", () => {
    saveOverrides(stateFile, { sdk: { model: "x" } });
    const path = overridesPathFor(stateFile);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
