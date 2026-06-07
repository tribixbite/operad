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

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type FetchResult,
  type ProviderListing,
  type ProviderModule,
  type ProviderReadResult,
  type TrustTier,
  SkillError,
} from "../types.js";
import { readSkillManifests } from "../adapter.js";

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
    const { url } = parseLocator(locator, version);
    const resolvedVersion = await resolveVersion(url, version);
    const targetDir = join(cacheParent, resolvedVersion);

    mkdirSync(cacheParent, { recursive: true });

    // If a previous install left this exact version on disk, blow it
    // away — re-install paths (same locator + version, cross-tier,
    // forced re-fetch) all need a clean target. The cache is operad-
    // owned so this is safe; the prior commit SHA was already
    // captured in SQLite if anyone cares.
    if (existsSync(targetDir)) {
      try {
        rmSync(targetDir, { recursive: true, force: true });
      } catch (err) {
        throw new SkillError(
          "PROVIDER_FETCH_FAILED",
          `failed to clear pre-existing cache dir ${targetDir}: ${(err as Error).message}`,
        );
      }
    }

    try {
      // `git clone --depth 1` with the resolved ref. For commit SHAs
      // we need a full-ish clone since shallow + commit SHA isn't
      // universally supported across git versions; use --no-checkout
      // and then a hard reset to the SHA.
      if (resolvedVersion.startsWith("commit:")) {
        const sha = resolvedVersion.slice("commit:".length);
        execFileSync("git", ["clone", "--no-checkout", url, targetDir], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        execFileSync("git", ["-C", targetDir, "checkout", sha], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        // Semver tag — shallow clone of that tag.
        execFileSync(
          "git",
          ["clone", "--depth", "1", "--branch", resolvedVersion, url, targetDir],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
      }
    } catch (err) {
      throw new SkillError(
        "PROVIDER_FETCH_FAILED",
        `git clone failed: ${(err as Error).message}`,
        { url, version: resolvedVersion },
      );
    }

    const commitSha = execFileSync("git", ["-C", targetDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    // Integrity digest: sha256 of `git ls-tree -r <sha>` output. This
    // is bit-stable across git versions (unlike `git archive`).
    const lsTree = execFileSync("git", ["-C", targetDir, "ls-tree", "-r", commitSha], {
      encoding: "utf8",
    });
    const archiveSha = createHash("sha256").update(lsTree).digest("hex");

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
    return resolveVersion(url, "latest");
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
  const atIdx = locator.lastIndexOf("@");
  // We need the '@' to appear AFTER any auth-style '@' in the URL.
  // For https URLs, `lastIndexOf` is fine — the user-info form would
  // also be before the path.
  if (atIdx <= "https://".length) {
    // No version pin.
    return { url: locator, requestedVersion: fallbackVersion };
  }
  return {
    url: locator.slice(0, atIdx),
    requestedVersion: locator.slice(atIdx + 1),
  };
}

/**
 * Resolve a requested version into the canonical form (§3.11).
 * - Semver tags get a `v` prefix added if missing.
 * - `commit:<40>` is left alone after validation.
 * - `latest` resolves via `git ls-remote --tags --sort=-v:refname` →
 *   highest semver tag; if no tags, falls back to `commit:<HEAD-sha>`.
 */
async function resolveVersion(url: string, requested: string): Promise<string> {
  if (requested.startsWith("commit:")) {
    const sha = requested.slice("commit:".length);
    if (!/^[a-f0-9]{40}$/.test(sha)) {
      throw new SkillError(
        "LOCATOR_AMBIGUOUS_SHA",
        `commit SHAs must be the full 40-character form (got ${sha.length} chars)`,
        { sha },
      );
    }
    return requested;
  }

  if (requested !== "latest") {
    // Plain tag — canonicalise: add `v` prefix if it looks like semver
    // without one. Doesn't validate that the tag exists — git clone
    // will fail loudly if it doesn't.
    return canonSemver(requested);
  }

  // requested === "latest": ls-remote to find the highest semver tag.
  try {
    const out = execFileSync(
      "git",
      ["ls-remote", "--tags", "--sort=-v:refname", url],
      { encoding: "utf8" },
    );
    const tagLine = out.split("\n").find((l) => l.includes("refs/tags/"));
    if (tagLine) {
      const tag = tagLine.split("refs/tags/")[1].replace(/\^\{\}$/, "");
      return canonSemver(tag);
    }
    // No tags — fall back to HEAD commit SHA.
    const headOut = execFileSync("git", ["ls-remote", url, "HEAD"], { encoding: "utf8" });
    const sha = headOut.split(/\s+/)[0];
    if (/^[a-f0-9]{40}$/.test(sha)) return `commit:${sha}`;
    throw new Error(`ls-remote returned no usable ref (output: ${out.slice(0, 200)})`);
  } catch (err) {
    throw new SkillError(
      "PROVIDER_FETCH_FAILED",
      `git ls-remote failed for ${url}: ${(err as Error).message}`,
      { url },
    );
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
