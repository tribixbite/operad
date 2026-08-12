/**
 * persistence-quarantine.test.ts — an unreadable state or registry file must
 * be preserved, not silently destroyed.
 *
 * Both loaders used to log one warning and return an empty/default value. The
 * very next write — which happens within milliseconds of boot — overwrote the
 * original, so restart counts, autostart pins, bound_jsonl_id and every
 * dynamically registered session vanished along with any chance of working
 * out why. Writes here are atomic (temp + rename), so a corrupt file always
 * came from outside operad, which is exactly when the evidence is worth
 * keeping.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../state.js";
import { Registry } from "../registry.js";
import type { Logger } from "../log.js";

const silentLog: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, setVerbose: () => {},
} as unknown as Logger;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "operad-quarantine-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("StateManager preserves an unreadable state file", () => {
  test("unparseable JSON is copied to .corrupt before being replaced", () => {
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, "{not json at all");

    new StateManager(statePath, silentLog);

    const backup = `${statePath}.corrupt`;
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, "utf-8")).toBe("{not json at all");
  });

  test("valid JSON of the wrong shape is preserved too", () => {
    // Parses fine, fails the shape check — the path that returned a fresh
    // state without so much as reading the old sessions.
    const statePath = join(dir, "state.json");
    const original = JSON.stringify({ sessions: "not-an-object" });
    writeFileSync(statePath, original);

    new StateManager(statePath, silentLog);

    expect(readFileSync(`${statePath}.corrupt`, "utf-8")).toBe(original);
  });

  test("a healthy state file is NOT quarantined", () => {
    const statePath = join(dir, "state.json");
    const mgr = new StateManager(statePath, silentLog);
    mgr.flush();

    new StateManager(statePath, silentLog);
    expect(existsSync(`${statePath}.corrupt`)).toBe(false);
  });

  test("a missing state file is not treated as corruption", () => {
    const statePath = join(dir, "state.json");
    new StateManager(statePath, silentLog);
    expect(existsSync(`${statePath}.corrupt`)).toBe(false);
  });
});

describe("Registry preserves an unusable registry file", () => {
  test("a future schema version is preserved rather than erased", () => {
    // Running an older operad against a newer registry hit the same
    // return-empty path, and the next save() wiped every registration.
    const regPath = join(dir, "registry.json");
    const original = JSON.stringify({ version: 999, sessions: [{ name: "keepme" }] });
    writeFileSync(regPath, original);

    const reg = new Registry(regPath, silentLog);
    expect(reg.entries()).toEqual([]);
    expect(readFileSync(`${regPath}.corrupt`, "utf-8")).toBe(original);
  });

  test("unparseable JSON is preserved", () => {
    const regPath = join(dir, "registry.json");
    writeFileSync(regPath, "<<<garbage>>>");

    new Registry(regPath, silentLog);
    expect(readFileSync(`${regPath}.corrupt`, "utf-8")).toBe("<<<garbage>>>");
  });

  test("a healthy registry is NOT quarantined", () => {
    const regPath = join(dir, "registry.json");
    writeFileSync(regPath, JSON.stringify({ version: 1, sessions: [] }));

    new Registry(regPath, silentLog);
    expect(existsSync(`${regPath}.corrupt`)).toBe(false);
  });
});

describe("Registry validates names on load", () => {
  test("an entry whose name would escape a tmux target is dropped", () => {
    // The load path bypasses the validation add() applies at runtime, and the
    // comment claiming names were gated here was simply untrue. Names reach
    // tmux targets and filesystem paths.
    const regPath = join(dir, "registry.json");
    writeFileSync(regPath, JSON.stringify({
      version: 1,
      sessions: [
        { name: "good-one", path: "/tmp/a", type: "claude" },
        { name: "../../etc/passwd", path: "/tmp/b", type: "claude" },
        { name: "has space; rm -rf /", path: "/tmp/c", type: "claude" },
        { name: "", path: "/tmp/d", type: "claude" },
      ],
    }));

    const names = new Registry(regPath, silentLog).entries().map((e) => e.name);
    expect(names).toContain("good-one");
    expect(names).not.toContain("../../etc/passwd");
    expect(names).not.toContain("has space; rm -rf /");
    expect(names.length).toBe(1);
  });

  test("a non-UUID session_id is still stripped", () => {
    // It is interpolated into `claude --resume <id>`.
    const regPath = join(dir, "registry.json");
    writeFileSync(regPath, JSON.stringify({
      version: 1,
      sessions: [{ name: "ok", path: "/tmp/a", type: "claude", session_id: "; rm -rf /" }],
    }));

    expect(new Registry(regPath, silentLog).entries()[0]?.session_id).toBeUndefined();
  });
});
