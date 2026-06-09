/**
 * android-adb.test.ts — the ADB connect must not freeze the daemon loop.
 *
 * Regression test for the post-reboot "IPC request timed out" on
 * `operad stream`. boot() does `await androidEngine.fixAdb()`, and fixAdb
 * used a synchronous `spawnSync('timeout', [connect_timeout_s, script])`
 * that blocks the daemon's single event loop for the WHOLE connect. After
 * a reboot the stale ADB endpoint stretched that to ~2.5 min, during which
 * the daemon could serve no IPC — so the CLI's 90s `stream` send timed out
 * even though boot ultimately succeeded.
 *
 * This test starts a slow (1s) connect script and asserts a 30ms timer
 * still fires DURING the connect — i.e. the loop stayed free.
 */
import { describe, test, expect } from "bun:test";
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AndroidEngine } from "../android-engine.js";

function makeCtx(connectScript: string): any {
  return {
    config: { adb: { connect_script: connectScript, connect_timeout_s: 10, phantom_fix: false } },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    state: { setAdbFixed() {} },
  };
}

// This verifies AndroidEngine.fixAdb's Termux-specific non-blocking ADB connect
// (the original bug was a synchronous spawnSync freezing the event loop). It
// needs the real Termux $PREFIX sh + the AndroidEngine adb path, so it only
// runs on Android/Termux — off-Termux there's no adb and the script-timing
// assertion is meaningless. Gated to TERMUX_VERSION (skips on all CI runners).
describe.skipIf(!process.env.TERMUX_VERSION)("AndroidEngine.fixAdb — non-blocking connect", () => {
  test("does not block the event loop during the ADB connect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "operad-adb-"));
    const script = join(dir, "connect.sh");
    // Pick a shebang that actually exists on the host: Termux has no working
    // /bin/sh (libtermux-exec rewrites it at exec, not for script shebangs),
    // while CI Linux/macOS has no $PREFIX path. A wrong shebang makes the
    // script fail instantly, fixAdb resolves before the 30ms timer, and the
    // event-loop ordering assertion flips.
    const shebang = process.env.TERMUX_VERSION
      ? "#!/data/data/com.termux/files/usr/bin/sh"
      : "#!/bin/sh";
    writeFileSync(script, `${shebang}\nsleep 1\nexit 0\n`);
    chmodSync(script, 0o755);
    const engine = new AndroidEngine(makeCtx(script));

    const order: string[] = [];
    // Fires 30ms in — well inside the 1s connect. Only reaches the queue if
    // the event loop is NOT frozen by the connect.
    setTimeout(() => order.push("timer"), 30);
    await engine.fixAdb().then(() => order.push("adb"));

    // Loop free → timer fires mid-connect → ["timer","adb"].
    // Loop frozen (old spawnSync) → timer deferred until after fixAdb
    // returns → ["adb","timer"].
    expect(order).toEqual(["timer", "adb"]);

    rmSync(dir, { recursive: true, force: true });
  }, 10000);
});
