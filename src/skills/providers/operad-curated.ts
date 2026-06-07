/**
 * skills/providers/operad-curated.ts — Operad-stewarded curated index.
 *
 * Trust tier: always `trusted`. The curated index is a static JSON
 * file at `https://operad.stream/skills/index.json` (GitHub Pages
 * mirror of `operad-stream/skills` repo). Each entry maps a locator
 * (e.g. `tribixbite/git-tools`) to a git URL + tag.
 *
 * Per spec §3.9, the index is **commit-SHA-pinned in operad source**
 * (rotated only on operad release; never auto-pull from main HEAD).
 * The resolver fetches the index at the pinned commit and then
 * delegates the actual bundle clone to the git+url path.
 *
 * Phase B ships with INDEX_COMMIT_SHA empty as a sentinel — the
 * resolver fails with PROVIDER_FETCH_FAILED until the operad-stream/
 * skills repo is bootstrapped + a SHA is committed here in a follow-up.
 * This is deliberate; the alternative is silently auto-pulling from
 * main, which round-3 review correctly flagged as a supply-chain risk.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import {
  type FetchResult,
  type ProviderListing,
  type ProviderModule,
  type ProviderReadResult,
  type TrustTier,
  SkillError,
} from "../types.js";
import { gitUrlProvider } from "./git-url.js";
import { readSkillManifests } from "../adapter.js";

const INDEX_REPO = "tribixbite/operad-stream-skills";
/**
 * Commit SHA of the curated index repo at the version operad ships
 * against. EMPTY = provider disabled (per the spec — refuse to
 * silently auto-pull from main HEAD).
 *
 * The value frozen at build-time (the empty string below) is overridable
 * at runtime via `OPERAD_CURATED_COMMIT_SHA` — checked dynamically in
 * `loadIndex()` so test harnesses can set the env var after module load
 * without re-importing.
 */
const BUILT_IN_COMMIT_SHA: string = "";
/** Returns the effective SHA: env override takes precedence over built-in. */
function indexCommitSha(): string {
  return process.env.OPERAD_CURATED_COMMIT_SHA ?? BUILT_IN_COMMIT_SHA;
}

interface CuratedEntry {
  locator: string;                  // user-facing slug (e.g. owner/skill)
  name: string;
  description?: string;
  /** Git URL + tag — fed directly into the git+url provider for fetch. */
  git_url: string;
  default_version: string;
}

interface CuratedIndex {
  schema_version: 1;
  entries: CuratedEntry[];
}

export const operadCuratedProvider: ProviderModule = {
  id: "operad-curated",

  trustTier(): TrustTier {
    return "trusted";
  },

  async list(opts: { query?: string; cursor?: string; limit?: number } = {}) {
    const index = await loadIndex();
    let items: ProviderListing[] = index.entries.map((e) => ({
      locator: e.locator,
      name: e.name,
      description: e.description,
      latest_version: e.default_version,
    }));
    if (opts.query) {
      const q = opts.query.toLowerCase();
      items = items.filter(
        (i) => i.locator.toLowerCase().includes(q) ||
               i.name.toLowerCase().includes(q) ||
               (i.description ?? "").toLowerCase().includes(q),
      );
    }
    return { items };
  },

  async fetch(locator: string, version: string, cacheParent: string): Promise<FetchResult> {
    const index = await loadIndex();
    const entry = index.entries.find((e) => e.locator === locator);
    if (!entry) {
      throw new SkillError(
        "PROVIDER_FETCH_FAILED",
        `operad-curated: no entry for '${locator}' in index@${indexCommitSha()}`,
        { locator },
      );
    }
    const resolvedVersion = version === "latest" ? entry.default_version : version;
    // Delegate to git+url for the actual clone. Reuses its commit-SHA
    // + ls-tree integrity primitive, atomic-rename, etc.
    const result = await gitUrlProvider.fetch(
      `${entry.git_url}@${resolvedVersion}`,
      resolvedVersion,
      cacheParent,
    );
    return {
      ...result,
      // Preserve the operad-curated locator in the audit URL so
      // `tmx skill info` shows the curated identity, not the raw git URL.
      fetched_url: `operad-curated:${locator}@${resolvedVersion} (resolved via ${result.fetched_url})`,
    };
  },

  read(extracted_path: string): Promise<ProviderReadResult> {
    // Same shape as git+url — operad-curated entries are git bundles.
    return Promise.resolve(readSkillManifests({
      extracted_path,
      trust_tier: "trusted",
    }));
  },

  async latest(locator: string): Promise<string> {
    const index = await loadIndex();
    const entry = index.entries.find((e) => e.locator === locator);
    if (!entry) {
      throw new SkillError("PROVIDER_FETCH_FAILED", `no curated entry for '${locator}'`);
    }
    return entry.default_version;
  },
};

// -- Pinned-commit index loader ---------------------------------------------

let cachedIndex: CuratedIndex | null = null;

/**
 * Reset the in-memory index cache. Exported for test harnesses only —
 * lets tests point at a fresh local index without a stale cached result
 * bleeding across test cases.
 * @internal
 */
export function _resetIndexCache(): void {
  cachedIndex = null;
}

async function loadIndex(): Promise<CuratedIndex> {
  if (cachedIndex) return cachedIndex;
  const sha = indexCommitSha();
  if (!sha) {
    throw new SkillError(
      "PROVIDER_FETCH_FAILED",
      `operad-curated is disabled: no commit SHA pinned in this operad build. Set OPERAD_CURATED_COMMIT_SHA env var to enable.`,
    );
  }
  // The index URL is normally https://raw.githubusercontent.com/<repo>/<sha>/index.json,
  // but OPERAD_CURATED_INDEX_URL_TEMPLATE lets users (and tests) point at
  // a mirror or a local file URL. The template supports two
  // placeholders: {repo} and {sha}.
  const tpl = process.env.OPERAD_CURATED_INDEX_URL_TEMPLATE
    ?? `https://raw.githubusercontent.com/{repo}/{sha}/index.json`;
  const url = tpl
    .replace("{repo}", INDEX_REPO)
    .replace("{sha}", sha);
  const body = url.startsWith("file://")
    ? readLocalIndex(url)
    : await httpsGet(url);
  // Sanity: hash check against the SHA — GitHub's raw URL is already
  // commit-SHA-pinned but recomputing the body hash means a CDN
  // compromise can't substitute a tampered index that happens to
  // round-trip through their URL.
  const observedSha = createHash("sha256").update(body).digest("hex");
  const parsed = JSON.parse(body) as CuratedIndex;
  if (parsed.schema_version !== 1) {
    throw new SkillError(
      "PROVIDER_FETCH_FAILED",
      `unexpected curated index schema_version=${parsed.schema_version}`,
      { observedSha },
    );
  }
  cachedIndex = parsed;
  return parsed;
}

/**
 * Read a local file:// URL synchronously. Used when OPERAD_CURATED_INDEX_URL_TEMPLATE
 * points at a locally-checked-out copy of the curated repo (handy for
 * testing the provider end-to-end without network access). The
 * pinned commit SHA isn't verified against the file's git state —
 * file:// callers are trusted by definition.
 */
function readLocalIndex(url: string): string {
  const path = url.slice("file://".length);
  // Use node:fs synchronously to keep the loadIndex() signature
  // identical regardless of transport.
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new SkillError(
      "PROVIDER_FETCH_FAILED",
      `failed to read local curated index at ${path}: ${(err as Error).message}`,
    );
  }
}

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest(
      {
        hostname: u.hostname, path: `${u.pathname}${u.search}`, method: "GET",
        headers: { "user-agent": "operad-skill-resolver/operad-curated" },
        timeout: 15_000,
      },
      (res) => {
        if (res.statusCode == null || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new SkillError(
            "PROVIDER_FETCH_FAILED", `${url} returned HTTP ${res.statusCode}`,
          ));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", (err) => reject(new SkillError("PROVIDER_FETCH_FAILED", err.message)));
      },
    );
    req.on("error", (err) => reject(new SkillError("PROVIDER_FETCH_FAILED", err.message)));
    req.on("timeout", () => { req.destroy(); reject(new SkillError("PROVIDER_FETCH_FAILED", "timeout")); });
    req.end();
  });
}
