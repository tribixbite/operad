/**
 * skills-git-url.test.ts — git+url provider fetch hardening.
 *
 * Real local repositories under the OS temp dir, cloned by path (no
 * network). Covers:
 *  - a failed re-fetch of an already-cached version must not destroy the
 *    live cache dir (it was rmSync'd before the clone was attempted);
 *  - tags without a `v` prefix: the canonical id is `v1.2.3` but the clone
 *    must use the exact tag name ls-remote reported;
 *  - git network calls are async and time-bounded, so a silent remote can
 *    neither freeze the event loop nor hang forever.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitUrlProvider, _setGitTimeoutMs } from "../skills/providers/git-url.js";

/** Run git in `cwd` with a throwaway identity and no signing. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t.co", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** A repo with one commit containing `marker.txt` = `content`, optionally tagged. */
function makeRepo(content: string, tag?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "operad-giturl-repo-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "marker.txt"), content);
  git(dir, "add", "marker.txt");
  git(dir, "commit", "-qm", "init");
  if (tag) git(dir, "tag", tag);
  return dir;
}

const cleanup: string[] = [];
let parent: string;

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), "operad-giturl-cache-"));
  cleanup.push(parent);
});

afterAll(() => {
  for (const d of cleanup) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

afterEach(() => _setGitTimeoutMs(null));

describe("git+url fetch — re-fetching a cached version", () => {
  // fetch() rmSync'd <cacheParent>/<version> BEFORE cloning. When the clone
  // then failed, the live install's files were already gone.
  test("a failed re-fetch leaves the existing version dir intact", async () => {
    const good = makeRepo("v1 content", "v0.1.0");
    cleanup.push(good);
    const first = await gitUrlProvider.fetch(good, "v0.1.0", parent);
    expect(readFileSync(join(first.extracted_path, "marker.txt"), "utf8")).toBe("v1 content");

    // Same cache parent + version, but a repo that has no such tag: the
    // clone fails.
    const untagged = makeRepo("other");
    cleanup.push(untagged);
    await expect(gitUrlProvider.fetch(untagged, "v0.1.0", parent)).rejects.toThrow();

    expect(existsSync(join(first.extracted_path, "marker.txt"))).toBe(true);
    expect(readFileSync(join(first.extracted_path, "marker.txt"), "utf8")).toBe("v1 content");
    // No temp/backup directories left behind next to it.
    expect(readdirSync(parent).filter((n) => n !== "v0.1.0")).toEqual([]);
  }, 30_000);

  test("a successful re-fetch replaces the version dir with the new clone", async () => {
    const p = mkdtempSync(join(tmpdir(), "operad-giturl-cache-"));
    cleanup.push(p);
    const a = makeRepo("A", "v0.2.0");
    const b = makeRepo("B", "v0.2.0");
    cleanup.push(a, b);
    await gitUrlProvider.fetch(a, "v0.2.0", p);
    const second = await gitUrlProvider.fetch(b, "v0.2.0", p);
    expect(readFileSync(join(second.extracted_path, "marker.txt"), "utf8")).toBe("B");
    expect(readdirSync(p)).toEqual(["v0.2.0"]);
  }, 30_000);
});

describe("git+url fetch — tags without a v prefix", () => {
  // canonSemver turned `1.2.3` into `v1.2.3` and that string went straight
  // to `git clone --branch`, which fails for a repo whose tag is `1.2.3`.
  test("latest resolves an un-prefixed tag and clones it", async () => {
    const repo = makeRepo("bare tag", "1.2.3");
    cleanup.push(repo);
    const p = mkdtempSync(join(tmpdir(), "operad-giturl-cache-"));
    cleanup.push(p);
    const r = await gitUrlProvider.fetch(repo, "latest", p);
    expect(r.resolved_version).toBe("v1.2.3");
    expect(readFileSync(join(r.extracted_path, "marker.txt"), "utf8")).toBe("bare tag");
  }, 30_000);

  test("an explicit un-prefixed pin clones the exact tag", async () => {
    const repo = makeRepo("pinned", "2.0.0");
    cleanup.push(repo);
    const p = mkdtempSync(join(tmpdir(), "operad-giturl-cache-"));
    cleanup.push(p);
    const r = await gitUrlProvider.fetch(`${repo}@2.0.0`, "latest", p);
    expect(r.resolved_version).toBe("v2.0.0");
    expect(readFileSync(join(r.extracted_path, "marker.txt"), "utf8")).toBe("pinned");
  }, 30_000);

  test("a v-prefixed pin still matches a v-prefixed tag", async () => {
    const repo = makeRepo("prefixed", "v3.0.0");
    cleanup.push(repo);
    const p = mkdtempSync(join(tmpdir(), "operad-giturl-cache-"));
    cleanup.push(p);
    const r = await gitUrlProvider.fetch(repo, "3.0.0", p);
    expect(r.resolved_version).toBe("v3.0.0");
    expect(readFileSync(join(r.extracted_path, "marker.txt"), "utf8")).toBe("prefixed");
  }, 30_000);
});

describe("git+url — network calls are async and bounded", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    // Accepts connections and never answers: a stalled remote.
    server = createServer(() => { /* hold the socket open, say nothing */ });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  // ls-remote / clone ran through execFileSync with no timeout: a remote that
  // stalls froze the whole daemon (sync call) indefinitely.
  test("ls-remote against a stalled remote times out without blocking the loop", async () => {
    _setGitTimeoutMs(1_500);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const t0 = Date.now();
    try {
      await expect(gitUrlProvider.latest(`http://127.0.0.1:${port}/repo.git`)).rejects.toThrow(/timed out/);
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(ticks).toBeGreaterThan(0);
  }, 20_000);
});
