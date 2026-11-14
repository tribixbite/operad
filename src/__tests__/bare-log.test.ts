/**
 * bare-log.test.ts — bare (non-tmux) services keep their output.
 *
 * Found on the author's device: the `x2d` service exited ~16 s after every
 * launch for days with nothing anywhere to say why, because spawnBareProcess
 * ran it with `stdio: "ignore"`. The cause was one line on stderr —
 * `CANNOT LINK EXECUTABLE … libavcodec.so.61 not found` — after an ffmpeg
 * upgrade. A bare service's stdout/stderr now go to `bare-<name>.log` in the
 * daemon's log directory.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnBareProcess, bareLogPath, BARE_LOG_MAX_BYTES } from "../session.js";
import { Logger } from "../log.js";
import type { SessionConfig } from "../types.js";

let dir: string;
let log: Logger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "operad-bare-log-"));
  log = new Logger(join(dir, "daemon-logs"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal bare service config running `command` in the temp dir. */
function service(name: string, command: string): SessionConfig {
  return { name, command, path: dir, bare: true } as SessionConfig;
}

/** Wait until `pid` has exited (bounded). */
async function waitExit(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`pid ${pid} still running`);
}

describe("bare service output", () => {
  test("stdout and stderr land in bare-<name>.log in the log directory", async () => {
    const pid = spawnBareProcess(service("svc", "echo out-line; echo err-line >&2"), log, dir);
    expect(pid).not.toBeNull();
    await waitExit(pid!);
    const text = readFileSync(join(dir, "bare-svc.log"), "utf8");
    expect(text).toContain("out-line");
    expect(text).toContain("err-line");
  });

  test("each start is appended after a header naming the service and command", async () => {
    const first = spawnBareProcess(service("svc", "echo run-one"), log, dir);
    await waitExit(first!);
    const second = spawnBareProcess(service("svc", "echo run-two"), log, dir);
    await waitExit(second!);
    const text = readFileSync(join(dir, "bare-svc.log"), "utf8");
    expect(text.indexOf("run-one")).toBeGreaterThan(-1);
    expect(text.indexOf("run-two")).toBeGreaterThan(text.indexOf("run-one"));
    expect(text).toMatch(/=== .* start svc: echo run-two/);
  });

  test("a log over the cap is rotated to .1 before the next start", async () => {
    const path = join(dir, "bare-svc.log");
    writeFileSync(path, "x".repeat(BARE_LOG_MAX_BYTES + 1));
    const pid = spawnBareProcess(service("svc", "echo fresh"), log, dir);
    await waitExit(pid!);
    expect(readFileSync(`${path}.1`, "utf8").length).toBe(BARE_LOG_MAX_BYTES + 1);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("fresh");
    expect(text.length).toBeLessThan(1000);
  });

  test("without a log directory the output is discarded, as before", async () => {
    const pid = spawnBareProcess(service("svc", "echo nowhere"), log);
    expect(pid).not.toBeNull();
    await waitExit(pid!);
    expect(existsSync(join(dir, "bare-svc.log"))).toBe(false);
  });
});

describe("bareLogPath", () => {
  test("keeps a file name inside the directory whatever the session is called", () => {
    expect(bareLogPath("/logs", "termux-x11")).toBe("/logs/bare-termux-x11.log");
    expect(bareLogPath("/logs", "../etc/x")).toBe("/logs/bare-.._etc_x.log");
  });
});
