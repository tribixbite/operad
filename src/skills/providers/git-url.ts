/**
 * skills/providers/git-url.ts — Universal escape-hatch provider.
 *
 * Locator forms:
 *   • `https://github.com/owner/repo`           (uses tag at HEAD)
 *   • `https://github.com/owner/repo@v1.2.3`    (pinned semver tag)
 *   • `https://github.com/owner/repo@commit:<40-char-sha>`
 *   • `git@github.com:owner/repo.git`           (ssh — supported)
 *
 * Trust tier: always `escape` (autonomy cap = suggest, default bucket
 * = observe). Even if the URL points to a "trusted" GitHub org, the
 * git+url provider has no curation and the user is opting into a less-
 * trusted source.
 *
 * Spec §3.9 + §3.11 (version canonicalization) + §3.13 (integrity
 * primitives: commit SHA + `git ls-tree -r <sha>` digest).
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type FetchResult,
  type ProviderListing,
  type ProviderModule,
  type ProviderReadResult,
  type TrustTier,
  SkillError,
  versionDirName,
} from "../types.js";
import { readSkillManifests } from "../adapter.js";
import { runBounded } from "../../bounded-exec.js";

/** Wall-clock cap for one git network operation (clone, ls-remote). */
const DEFAULT_GIT_NETWORK_TIMEOUT_MS = 120_000;
/** Cap for local git reads (rev-parse, ls-tree). */
const GIT_LOCAL_TIMEOUT_MS = 30_000;
/** Per-stream output cap for git (ls-tree of a large repo, many tags). */
const GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
let gitNetworkTimeoutMs = DEFAULT_GIT_NETWORK_TIMEOUT_MS;

/**
 * Test-only: shorten the git network timeout (null restores the default).
 * @internal
 */
export function _setGitTimeoutMs(ms: number | null): void {
  gitNetworkTimeoutMs = ms ?? DEFAULT_GIT_NETWORK_TIMEOUT_MS;
}

export const gitUrlProvider: ProviderModule = {
  id: "git+url",

  trustTier(): TrustTier {
    return "escape";
  },

  // No discovery API for arbitrary git URLs. The dashboard search UI
  // (Phase D) skips the git+url provider entirely; user pastes a URL.
  list(): Promise<{ items: ProviderListing[]; next_cursor?: string }> {
    return Promise.resolve({ items: [] });
  },

  async fetch(locator: string, version: string, cacheParent: string): Promise<FetchResult> {
    // Honour a version pinned in the locator itself (`<url>@v1.2.3`). Passing
    // only the `version` argument used to silently install `latest` whenever
    // the caller left it at its default — the dashboard always does — which
    // turned an explicit pin into a silent supply-chain surprise.
    const { url, requestedVersion } = parseLocator(locator, version);
    assertSafeGitUrl(url);
    const effectiveVersion = version === "latest" ? requestedVersion : version;
    const { version: resolvedVersion, ref } = await resolveRef(url, effectiveVersion);

    // resolvedVersion becomes a directory name below, and an existing dir of
    // that name is replaced. Without this guard a version like
    // `../../../../etc` escaped the operad-owned cache.
    assertSafePathComponent(resolvedVersion, "version");
    // The directory name is derived, not the raw version: `commit:<sha>` is a
    // legal POSIX name but an NTFS alternate-data-stream on Windows, where the
    // clone would fail. store.cacheDir() applies the same mapping, so both
    // agree on where the bundle lives.
    const dirName = versionDirName(resolvedVersion);
    const targetDir = join(cacheParent, dirName);

    mkdirSync(cacheParent, { recursive: true });

    // Clone into a private staging dir and move it into place only once the
    // clone and integrity reads succeeded. The previous code rmSync'd
    // targetDir up front — when that version was already installed (a forced
    // re-fetch, a cross-tier re-install) a failed clone deleted the LIVE
    // install's files, and the install rollback then deleted them again.
    const stagingDir = mkdtempSync(join(cacheParent, `.${dirName}.fetch-`));
    let commitSha: string;
    let archiveSha: string;
    try {
      try {
        if (ref.kind === "commit") {
          // Shallow + commit SHA isn't universally supported across git
          // versions; clone without checkout, then check out the SHA.
          await runGit(["clone", "--no-checkout", "--", url, stagingDir], gitNetworkTimeoutMs);
          await runGit(["-C", stagingDir, "checkout", ref.name], gitNetworkTimeoutMs);
        } else {
          // Shallow clone of the EXACT ref ls-remote reported. The canonical
          // version (`v1.2.3`) is an id, not necessarily the tag's name — a
          // repo tagging `1.2.3` has no `v1.2.3` ref to clone.
          await runGit(
            ["clone", "--depth", "1", "--branch", ref.name, "--", url, stagingDir],
            gitNetworkTimeoutMs,
          );
        }
      } catch (err) {
        throw new SkillError(
          "PROVIDER_FETCH_FAILED",
          `git clone failed: ${(err as Error).message}`,
          { url, version: resolvedVersion },
        );
      }

      commitSha = (await runGit(["-C", stagingDir, "rev-parse", "HEAD"], GIT_LOCAL_TIMEOUT_MS)).trim();
      // Integrity digest: sha256 of `git ls-tree -r <sha>` output. This
      // is bit-stable across git versions (unlike `git archive`).
      const lsTree = await runGit(["-C", stagingDir, "ls-tree", "-r", commitSha], GIT_LOCAL_TIMEOUT_MS);
      archiveSha = createHash("sha256").update(lsTree).digest("hex");

      swapIntoPlace(stagingDir, targetDir);
    } catch (err) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
      throw err;
    }

    return {
      extracted_path: targetDir,
      resolved_version: resolvedVersion,
      fetched_url: url,
      fetched_commit_sha: commitSha,
      fetched_archive_sha256: archiveSha,
    };
  },

  read(extractedPath: string): Promise<ProviderReadResult> {
    const result = readSkillManifests({
      extracted_path: extractedPath,
      trust_tier: "escape",
    });
    return Promise.resolve(result);
  },

  async latest(locator: string): Promise<string> {
    const { url } = parseLocator(locator, "latest");
    // Same guard as fetch(). resolveRef shells out to `git ls-remote`,
    // so an unguarded `ext::sh -c ...` locator executes here too. fetch() was
    // hardened but this sibling entry point was not — any future update-check
    // route would have inherited the hole.
    assertSafeGitUrl(url);
    return (await resolveRef(url, "latest")).version;
  },
};

/**
 * Locator parsing. Returns the bare git URL and (if pinned via `@`)
 * the requested version slice.
 *
 * Exported as `_parseLocator` for test-harness use only.
 * @internal
 */
export function _parseLocator(locator: string, fallbackVersion: string): {
  url: string;
  requestedVersion: string;
} {
  return parseLocator(locator, fallbackVersion);
}

/**
 * Git transports operad will clone from.
 *
 * `ext::` and `-`-prefixed locators are the dangerous cases: `ext::sh -c …`
 * makes git execute an arbitrary command, and a locator starting with `-` is
 * consumed by git as an option (`--upload-pack=…`) rather than a URL. Running
 * git with an argv array stops *shell* injection but not *git argument*
 * injection (the `--` before the URL is a second line of defence), so
 * the transport has to be allow-listed. The CLI already did this in
 * `parseSkillLocator`; the REST and IPC paths bypassed it entirely.
 */
const ALLOWED_GIT_URL_PREFIXES = [
  "https://",
  "http://",
  "ssh://",
  "git://",
  "file://",
  "git@",
];

/** Throw unless `url` uses an allow-listed transport (or is a local path). */
export function assertSafeGitUrl(url: string): void {
  if (url.startsWith("-")) {
    throw new SkillError(
      "LOCATOR_MALFORMED",
      `git URL may not start with '-' (would be parsed as a git option): ${url}`,
      { url },
    );
  }
  // Absolute/relative filesystem paths are legitimate — git clones bare local
  // repos, and the test suite relies on it. Windows drive paths (C:\repos\r,
  // C:/repos/r) count too; rejecting them made local installs impossible there.
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) return;
  if (/^[a-zA-Z]:[\\/]/.test(url)) return;
  if (url.startsWith(".\\") || url.startsWith("..\\")) return;

  const ok = ALLOWED_GIT_URL_PREFIXES.some((p) => url.startsWith(p));
  if (!ok) {
    throw new SkillError(
      "LOCATOR_MALFORMED",
      `unsupported git transport in '${url}' — allowed: ${ALLOWED_GIT_URL_PREFIXES.join(", ")}, or a local path`,
      { url },
    );
  }
}

/**
 * Throw unless `value` is safe to use as a single filesystem path component.
 *
 * Rejects empty strings, `.`/`..`, anything containing a path separator, NUL,
 * or control characters. `commit:<sha>` is permitted as a whole because the
 * colon is not a separator on POSIX and the SHA is already regex-validated.
 */
export function assertSafePathComponent(value: string, what: string): void {
  const invalid =
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(value);
  if (invalid) {
    throw new SkillError(
      "LOCATOR_MALFORMED",
      `${what} '${value}' is not a valid path component`,
      { [what]: value },
    );
  }
}

function parseLocator(locator: string, fallbackVersion: string): {
  url: string;
  requestedVersion: string;
} {
  // ssh form: git@host:owner/repo.git — leave the leading `git@` alone.
  // https form: https://host/owner/repo[@version]
  const sshPrefix = locator.startsWith("git@");
  if (sshPrefix) {
    // ssh URLs may not have an @version suffix; if they do, it's after
    // the `.git`. Be conservative: only split on '@' if found AFTER
    // the first colon.
    const colonIdx = locator.indexOf(":");
    const afterColon = locator.slice(colonIdx + 1);
    const atIdx = afterColon.indexOf("@");
    if (atIdx < 0) return { url: locator, requestedVersion: fallbackVersion };
    return {
      url: locator.slice(0, colonIdx + 1) + afterColon.slice(0, atIdx),
      requestedVersion: afterColon.slice(atIdx + 1),
    };
  }
  // A version pin is an '@' in the PATH portion. An '@' inside the authority
  // is user-info (https://user@host/…) and must not be split on.
  //
  // The previous rule compared against the hardcoded length of "https://" (8),
  // which mis-handled shorter schemes ("http://" is 7) and local paths:
  // `/tmp/r@v1` put the '@' at index 6, so the pin was silently swallowed into
  // the URL and the clone failed. Anchoring on the authority boundary — the
  // first '/' after the scheme — handles every form.
  const schemeIdx = locator.indexOf("://");
  let authorityEnd: number;
  if (schemeIdx >= 0) {
    const slash = locator.indexOf("/", schemeIdx + "://".length);
    // No path at all (https://user@host) means any '@' is user-info.
    authorityEnd = slash >= 0 ? slash : locator.length;
  } else {
    // Bare filesystem path — no authority, so any '@' is a pin.
    authorityEnd = -1;
  }
  const atIdx = locator.lastIndexOf("@");
  if (atIdx <= authorityEnd) {
    return { url: locator, requestedVersion: fallbackVersion };
  }
  return {
    url: locator.slice(0, atIdx),
    requestedVersion: locator.slice(atIdx + 1),
  };
}

/** The git ref a resolved version is fetched from. */
interface ResolvedRef {
  /** Canonical version (§3.11): the skill-id and cache-dir component. */
  version: string;
  /** What to clone: a tag/branch name exactly as the remote spells it, or a SHA. */
  ref: { kind: "ref"; name: string } | { kind: "commit"; name: string };
}

/**
 * Resolve a requested version into its canonical form plus the exact ref to
 * clone (§3.11).
 * - `commit:<40>` is validated and cloned by SHA.
 * - `latest` → highest tag by `git ls-remote --sort=-v:refname`; if the repo
 *   has no tags, `commit:<HEAD-sha>`.
 * - Anything else is a pinned tag, matched against the remote's tags with or
 *   without a `v` prefix (then a branch of that exact name). The canonical
 *   version gets a `v` prefix if it looks like semver; the clone uses the
 *   remote's own spelling. canonSemver's output used to be passed straight to
 *   `git clone --branch`, so `1.2.3` became `v1.2.3` and failed against a repo
 *   tagging `1.2.3`.
 */
async function resolveRef(url: string, requested: string): Promise<ResolvedRef> {
  if (requested.startsWith("commit:")) {
    const sha = requested.slice("commit:".length);
    if (!/^[a-f0-9]{40}$/.test(sha)) {
      throw new SkillError(
        "LOCATOR_AMBIGUOUS_SHA",
        `commit SHAs must be the full 40-character form (got ${sha.length} chars)`,
        { sha },
      );
    }
    return { version: requested, ref: { kind: "commit", name: sha } };
  }

  let refs: { tags: string[]; heads: string[] };
  let headSha: string | null = null;
  try {
    refs = parseLsRemote(await runGit(
      ["ls-remote", "--tags", "--heads", "--sort=-v:refname", "--", url],
      gitNetworkTimeoutMs,
    ));
    if (requested === "latest" && refs.tags.length === 0) {
      const headOut = await runGit(["ls-remote", "--", url, "HEAD"], gitNetworkTimeoutMs);
      const sha = headOut.split(/\s+/)[0];
      headSha = /^[a-f0-9]{40}$/.test(sha) ? sha : null;
    }
  } catch (err) {
    throw new SkillError(
      "PROVIDER_FETCH_FAILED",
      `git ls-remote failed for ${url}: ${(err as Error).message}`,
      { url },
    );
  }

  if (requested === "latest") {
    const top = refs.tags[0];
    if (top !== undefined) return { version: canonSemver(top), ref: { kind: "ref", name: top } };
    if (headSha) return { version: `commit:${headSha}`, ref: { kind: "commit", name: headSha } };
    throw new SkillError(
      "PROVIDER_FETCH_FAILED",
      `git ls-remote returned no usable ref for ${url}`,
      { url },
    );
  }

  // Pinned: accept the tag as written, its canonical v-form, or v-stripped.
  const candidates = [...new Set([requested, canonSemver(requested), requested.replace(/^v(?=\d)/, "")])];
  const tag = candidates.find((c) => refs.tags.includes(c));
  if (tag !== undefined) return { version: canonSemver(tag), ref: { kind: "ref", name: tag } };
  if (refs.heads.includes(requested)) return { version: requested, ref: { kind: "ref", name: requested } };
  // Fail here rather than letting `clone --branch` discover it: same error,
  // and no clone (and no half-written staging dir) for a ref that is absent.
  throw new SkillError(
    "PROVIDER_FETCH_FAILED",
    `no tag or branch '${requested}' in ${url}`,
    { url, version: requested },
  );
}

/**
 * Parse `git ls-remote --tags --heads` output into ordered tag and branch
 * names. Peeled `^{}` lines duplicate an annotated tag and are dropped;
 * input order (the `--sort` order) is preserved.
 */
function parseLsRemote(out: string): { tags: string[]; heads: string[] } {
  const tags: string[] = [];
  const heads: string[] = [];
  for (const line of out.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    if (!ref || ref.endsWith("^{}")) continue;
    if (ref.startsWith("refs/tags/")) tags.push(ref.slice("refs/tags/".length));
    else if (ref.startsWith("refs/heads/")) heads.push(ref.slice("refs/heads/".length));
  }
  return { tags, heads };
}

/**
 * Environment for every git call: never prompt. Credential prompts go to the
 * controlling terminal, not stdin, so ignoring stdin alone does not stop a
 * daemon-side `git clone` of a private repo from waiting forever.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    // ssh host-key / passphrase prompts. Respect an operator's own command.
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
}

/**
 * Run git asynchronously with a hard timeout; resolve with stdout or reject
 * with git's stderr. These were execFileSync calls with no timeout — a
 * stalled remote froze the daemon's event loop (every HTTP/IPC/health
 * check) for as long as it stalled. runBounded runs git as its own process
 * group so helpers (remote-https, upload-pack) die with it.
 */
async function runGit(args: string[], timeoutMs: number): Promise<string> {
  // The skills cache path (home + cache dir + repo slug + staging name) plus
  // a repo's own files exceeds Windows' 260-character MAX_PATH, where Git for
  // Windows fails with "Filename too long" unless core.longpaths is on.
  const argv = process.platform === "win32" ? ["-c", "core.longpaths=true", ...args] : args;
  const r = await runBounded("git", argv, { env: gitEnv(), timeoutMs, maxBytes: GIT_MAX_OUTPUT_BYTES });
  // Name the subcommand in errors, skipping a leading `-C <dir>`.
  const what = `git ${args[0] === "-C" ? args[2] : args[0]}`;
  if (r.spawnError) throw new Error(`${what}: ${r.spawnError.message}`);
  if (r.killed === "timeout") throw new Error(`${what} timed out after ${timeoutMs}ms`);
  if (r.killed) throw new Error(`${what} output exceeded ${GIT_MAX_OUTPUT_BYTES} bytes`);
  if (r.code !== 0) throw new Error(`${what} exited ${r.code}: ${r.stderr.trim()}`);
  return r.stdout;
}

/**
 * Move a fully-fetched staging dir to `targetDir`, replacing any previous
 * copy. The old copy is renamed aside first and restored if the final rename
 * fails, so at no point is the version missing because of this function.
 */
function swapIntoPlace(stagingDir: string, targetDir: string): void {
  const backup = existsSync(targetDir) ? `${stagingDir}.old` : null;
  if (backup) renameSync(targetDir, backup);
  try {
    renameSync(stagingDir, targetDir);
  } catch (err) {
    if (backup) {
      try { renameSync(backup, targetDir); } catch { /* left at backup path; reported below */ }
    }
    throw new SkillError(
      "PROVIDER_FETCH_FAILED",
      `failed to move fetched bundle into ${targetDir}: ${(err as Error).message}`,
    );
  }
  if (backup) {
    try { rmSync(backup, { recursive: true, force: true }); } catch { /* stale backup is harmless */ }
  }
}

/**
 * Add a `v` prefix to a bare semver tag if missing. Leaves non-semver
 * tags (e.g. `release-2025-11`) alone.
 *
 * Exported as `_canonSemver` for test-harness use only.
 * @internal
 */
export function _canonSemver(tag: string): string {
  return canonSemver(tag);
}

function canonSemver(tag: string): string {
  if (/^\d+\.\d+\.\d+/.test(tag)) return `v${tag}`;
  return tag;
}
