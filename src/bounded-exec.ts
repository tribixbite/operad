/**
 * bounded-exec.ts — Run a subprocess with hard bounds on time, output and
 * process lifetime.
 *
 * Shared by agent TOML tools (tools.ts) and the git+url skill provider.
 * Both previously relied on child_process `exec`/`execFileSync`, whose
 * timeout (when there was one) signals only the direct child:
 *  - a shell tool's grandchildren (`sleep 30 & …; wait`, a pipeline, a dev
 *    server) survived as orphans, and under Node the call stayed open until
 *    they released the stdout pipe;
 *  - git's own helpers (upload-pack, remote-https) outlived a killed git,
 *    and execFileSync with no timeout froze the daemon's event loop for as
 *    long as a stalled remote held it.
 *
 * Here the child runs `detached` — the leader of a new process group — and a
 * kill (abort signal, timeout, output overflow) signals the whole group:
 * SIGTERM, then SIGKILL after a grace period. The promise settles only once
 * the group is gone (or the grace expires), so a caller never returns with a
 * live orphan. stdin is /dev/null, so a child that reads stdin gets EOF
 * instead of hanging on a pipe nobody writes.
 *
 * TODO: on Windows `detached` does not create a POSIX process group; only the
 * direct child is killed there (taskkill /T would be needed for the tree).
 */

import { spawn, type ChildProcess } from "node:child_process";

/** Why runBounded killed the process group, if it did. */
export type BoundedKillReason = "abort" | "timeout" | "overflow";

export interface BoundedOptions {
  /** Run `command` through the platform shell instead of exec'ing it with `args`. */
  shell?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Aborting this kills the group (reason "abort"). */
  signal?: AbortSignal;
  /** Wall-clock limit; exceeding it kills the group (reason "timeout"). */
  timeoutMs?: number;
  /** Per-stream byte cap; exceeding it kills the group (reason "overflow"). */
  maxBytes: number;
  /** SIGTERM → SIGKILL grace. Default 500 ms. */
  killGraceMs?: number;
}

export interface BoundedResult {
  /** Exit status; null when the group was killed or the spawn failed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when runBounded killed the group. */
  killed: BoundedKillReason | null;
  /** spawn itself failed (ENOENT, EAGAIN, …). */
  spawnError?: Error;
}

const DEFAULT_KILL_GRACE_MS = 500;

/**
 * Spawn `command` (with `args`, or via the shell when `opts.shell`) and
 * collect its output under the bounds in `opts`. Never rejects: every
 * failure mode is reported in the result.
 */
export function runBounded(command: string, args: readonly string[], opts: BoundedOptions): Promise<BoundedResult> {
  const isWin = process.platform === "win32";
  const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  return new Promise<BoundedResult>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        shell: opts.shell ?? false,
        cwd: opts.cwd,
        env: opts.env,
        detached: !isWin,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      // spawn throws synchronously for some argument errors.
      resolvePromise({ code: null, stdout: "", stderr: "", killed: null, spawnError: e as Error });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let killed: BoundedKillReason | null = null;
    let exitCode: number | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const signalGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (isWin) child.kill(sig);
        else process.kill(-child.pid, sig); // negative pid = the whole group
      } catch { /* group already gone */ }
    };
    const groupAlive = (): boolean => {
      if (isWin || child.pid === undefined) return false;
      try { process.kill(-child.pid, 0); return true; } catch { return false; }
    };
    const finish = (spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise({
        code: killed || spawnError ? null : exitCode,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
        killed,
        spawnError,
      });
    };
    const killGroup = (reason: BoundedKillReason): void => {
      if (killed) return;
      killed = reason;
      signalGroup("SIGTERM");
      graceTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        finish();
      }, graceMs);
    };
    function onAbort(): void { killGroup("abort"); }

    const collect = (chunks: Buffer[], add: (n: number) => number) => (chunk: Buffer): void => {
      if (add(chunk.length) > opts.maxBytes) {
        killGroup("overflow");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on("data", collect(out, (n) => (outBytes += n)));
    child.stderr?.on("data", collect(err, (n) => (errBytes += n)));
    child.on("error", (e) => finish(e));
    child.on("close", (code) => {
      exitCode = code;
      // After a kill, survivors of the first signal may still be in the group
      // (a grandchild that ignores TERM). Let the grace timer SIGKILL them
      // before reporting.
      if (killed && groupAlive()) return;
      finish();
    });

    if (opts.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => killGroup("timeout"), opts.timeoutMs);
    }
    if (opts.signal?.aborted) killGroup("abort");
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
