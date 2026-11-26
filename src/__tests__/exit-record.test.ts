/**
 * exit-record.test.ts — the shell-exit recorder that lets operad tell a
 * person typing `exit` from Android's low-memory killer.
 *
 * tmux 3.5a under Termux leaves `pane_dead_status` / `pane_dead_signal`
 * empty, so tmux cannot answer "how did this pane's shell end". operad runs
 * agent shells under a tiny POSIX-sh wrapper that writes the shell's exit
 * status to a per-pane record file instead; these tests pin the pieces of
 * that contract that do not need a tmux server.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  EXIT_RECORDER_MARKER,
  buildRecorderArgv,
  buildRecorderCommand,
  exitRecordKey,
  readExitRecord,
  interpretRecordedStatus,
  pruneStaleExitRecords,
  exitRecordDirFor,
} from "../exit-record.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "operad-exit-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("buildRecorderArgv", () => {
  test("runs the shell as a login shell under sh, tagged with the marker", () => {
    const argv = buildRecorderArgv(dir, "/usr/bin/bash");
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("-c");
    // $0 of the sh script is the marker, so `ps` and `#{pane_start_command}`
    // both show which panes carry a recorder.
    expect(argv[3]).toBe(EXIT_RECORDER_MARKER);
    expect(argv.slice(4)).toEqual([dir, "/usr/bin/bash", "-l"]);
  });

  test("the script writes the shell's real exit status, keyed by server pid and pane", () => {
    // Run the wrapper exactly as tmux would, with the TMUX / TMUX_PANE
    // variables tmux exports into every pane.
    const argv = buildRecorderArgv(dir, "sh");
    const r = spawnSync(argv[0], [...argv.slice(1, -1), "-c", "exit 3"], {
      env: { ...process.env, TMUX: "/sock/default,4436,4", TMUX_PANE: "%5" },
    });
    expect(r.status).toBe(0);
    expect(readExitRecord(dir, exitRecordKey("4436", "%5"))).toBe(3);
  });

  test("a shell killed by SIGKILL is recorded as 128+9", () => {
    const argv = buildRecorderArgv(dir, "sh");
    const r = spawnSync(argv[0], [...argv.slice(1, -1), "-c", "kill -9 $$"], {
      env: { ...process.env, TMUX: "/sock/default,77,0", TMUX_PANE: "%0" },
    });
    expect(r.status).toBe(0);
    expect(readExitRecord(dir, exitRecordKey("77", "%0"))).toBe(137);
  });

  test("while the shell runs, the record says `running`", () => {
    const argv = buildRecorderArgv(dir, "sh");
    const key = exitRecordKey("55", "%1");
    const r = spawnSync(argv[0], [...argv.slice(1, -1), "-c", `cat "${dir}/${key}"`], {
      env: { ...process.env, TMUX: "/sock/default,55,0", TMUX_PANE: "%1" },
      encoding: "utf-8",
    });
    expect(r.stdout.trim()).toBe("running");
    expect(readExitRecord(dir, key)).toBe(0);
  });

  test("outside tmux (no TMUX_PANE) nothing is written", () => {
    const argv = buildRecorderArgv(dir, "sh");
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    spawnSync(argv[0], [...argv.slice(1, -1), "-c", "exit 0"], { env });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("buildRecorderCommand", () => {
  test("is the argv as one shell-quoted string, safe for paths with spaces and quotes", () => {
    const odd = join(dir, "it's a dir");
    const cmd = buildRecorderCommand(odd, "/bin/sh");
    expect(cmd).toContain(EXIT_RECORDER_MARKER);
    // Round-trip: a POSIX shell splitting the string yields the argv back.
    // NUL-separated, because the script word itself contains newlines.
    const echoed = spawnSync("sh", ["-c", `set -- ${cmd}; printf '%s\\0' "$@"`], { encoding: "utf-8" });
    expect(echoed.stdout.split("\0").slice(0, -1)).toEqual(buildRecorderArgv(odd, "/bin/sh"));
  });
});

describe("exitRecordKey", () => {
  test("joins server pid and the numeric pane id", () => {
    expect(exitRecordKey("4436", "%5")).toBe("4436-5");
  });

  test("rejects anything that is not a plain number, so it can't name a path", () => {
    expect(exitRecordKey("../x", "%5")).toBeNull();
    expect(exitRecordKey("4436", "%5/..")).toBeNull();
    expect(exitRecordKey("", "%5")).toBeNull();
  });
});

describe("readExitRecord", () => {
  test("missing file → null", () => {
    expect(readExitRecord(dir, "1-1")).toBeNull();
  });

  test("parses the status written by the wrapper", () => {
    writeFileSync(join(dir, "1-2"), "137\n");
    expect(readExitRecord(dir, "1-2")).toBe(137);
  });

  test("a record still saying `running` is returned as such", () => {
    // Written by the wrapper when the shell starts; only overwritten when it
    // ends. Seeing it on a dead pane means the wrapper itself was killed.
    writeFileSync(join(dir, "1-4"), "running\n");
    expect(readExitRecord(dir, "1-4")).toBe("running");
  });

  test("garbage → null rather than a guessed status", () => {
    writeFileSync(join(dir, "1-3"), "oops\n");
    expect(readExitRecord(dir, "1-3")).toBeNull();
  });

  test("a null key → null", () => {
    expect(readExitRecord(dir, null)).toBeNull();
  });
});

describe("interpretRecordedStatus", () => {
  test("ordinary exit statuses are exits, whatever the code", () => {
    expect(interpretRecordedStatus(0)).toEqual({ state: "exited", status: 0 });
    expect(interpretRecordedStatus(3)).toEqual({ state: "exited", status: 3 });
  });

  test("SIGKILL (lmkd) is a kill", () => {
    expect(interpretRecordedStatus(137)).toEqual({ state: "killed", status: 137, signal: 9 });
  });

  test("other fatal signals are kills", () => {
    expect(interpretRecordedStatus(143)).toEqual({ state: "killed", status: 143, signal: 15 });
    expect(interpretRecordedStatus(139)).toEqual({ state: "killed", status: 139, signal: 11 });
  });

  test("SIGINT is the person at the keyboard, not a crash", () => {
    // `exit` after a Ctrl-C'd command returns 130; reading that as a kill
    // would reopen a session the user just closed.
    expect(interpretRecordedStatus(130)).toEqual({ state: "exited", status: 130 });
  });
});

describe("pruneStaleExitRecords", () => {
  test("drops records from other tmux servers, keeps the current server's", () => {
    writeFileSync(join(dir, "100-1"), "0\n");
    writeFileSync(join(dir, "100-2"), "0\n");
    writeFileSync(join(dir, "200-1"), "137\n");
    writeFileSync(join(dir, "unrelated.txt"), "x");
    pruneStaleExitRecords(dir, "200");
    expect(readdirSync(dir).sort()).toEqual(["200-1", "unrelated.txt"]);
  });

  test("a missing directory is not an error", () => {
    expect(() => pruneStaleExitRecords(join(dir, "nope"), "1")).not.toThrow();
    expect(existsSync(join(dir, "nope"))).toBe(false);
  });
});

describe("exitRecordDirFor", () => {
  test("lives beside the daemon's state file", () => {
    // join(), not a literal: the separator is the platform's (a backslash on Windows).
    expect(exitRecordDirFor("/home/u/.local/share/tmx/state.json")).toBe(join("/home/u/.local/share/tmx", "exits"));
  });
});
