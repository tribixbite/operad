/**
 * skills/providers/claude-marketplace.ts — Reads Anthropic-format
 * `.claude-plugin/marketplace.json` repos as operad skills.
 *
 * Locator forms:
 *   • `owner/repo`                   (uses tag at HEAD)
 *   • `owner/repo@v1.2.3`            (semver pin)
 *   • `owner/repo@commit:<sha>`      (commit pin)
 *
 * The provider delegates the actual clone to git+url (so it
 * inherits the integrity primitive: commit SHA + `git ls-tree`
 * digest) but resolves the GitHub URL itself.
 *
 * Trust tier:
 *   • `anthropics/*`              → `trusted`
 *   • everything else             → `community`
 *
 * §3.4 cross-tier rule: re-installing the SAME locator can shift
 * tier (e.g. `anthropics/skills` → trusted; a fork at
 * `user/skills` → community). The always-more-restrictive cap rule
 * is handled by SkillManager; this provider only reports the tier.
 */

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

export const claudeMarketplaceProvider: ProviderModule = {
  id: "claude-marketplace",

  trustTier(locator: string): TrustTier {
    const owner = locator.split("/")[0]?.toLowerCase();
    return owner === "anthropics" ? "trusted" : "community";
  },

  // Discovery for a federated set of plugin marketplaces would require
  // an aggregator we don't run. v1 returns empty; users find plugins
  // via GitHub search and install with the `owner/repo` form. v1.1
  // will add a discovery path via the GitHub topic-search provider.
  list(): Promise<{ items: ProviderListing[]; next_cursor?: string }> {
    return Promise.resolve({ items: [] });
  },

  async fetch(locator: string, version: string, cacheParent: string): Promise<FetchResult> {
    const { owner, repo } = parseGithubLocator(locator);
    // Build the GitHub HTTPS URL and delegate to git+url.
    const gitLocator = `https://github.com/${owner}/${repo}` +
      (version && version !== "latest" ? `@${version}` : "");
    const result = await gitUrlProvider.fetch(gitLocator, version, cacheParent);
    return {
      ...result,
      fetched_url: `claude-marketplace:${locator}@${result.resolved_version} (resolved to ${result.fetched_url})`,
    };
  },

  read(extracted_path: string): Promise<ProviderReadResult> {
    // Tier is decided per-locator in trustTier(), but at read-time we
    // don't have the locator. SkillManager.install runs trustTier()
    // separately to attach the cap to each tool entry — the adapter
    // here uses "community" as a conservative default for the cap-
    // baked-into-tool-entries flow, then SkillManager.registerInMemory
    // overrides per the actual tier when writing tool_autonomy_caps.
    // We could pass tier through but the adapter shape would need
    // widening — keeping the conservative default is simpler.
    return Promise.resolve(readSkillManifests({
      extracted_path,
      trust_tier: "community",
    }));
  },

  async latest(locator: string): Promise<string> {
    const { owner, repo } = parseGithubLocator(locator);
    return gitUrlProvider.latest(`https://github.com/${owner}/${repo}`);
  },
};

function parseGithubLocator(locator: string): { owner: string; repo: string } {
  const parts = locator.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new SkillError(
      "LOCATOR_MALFORMED",
      `claude-marketplace locator must be owner/repo (got '${locator}')`,
    );
  }
  return { owner: parts[0], repo: parts[1] };
}
