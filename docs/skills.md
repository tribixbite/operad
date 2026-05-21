# Skill / plugin marketplace

> **Status:** preview. Enable per-daemon with `--enable-skills-preview`. See
> `docs/superpowers/specs/2026-05-20-skill-marketplace-design.md` for the
> full design spec.

`operad` runs a multi-source plugin aggregator modelled on Obtainium —
skills are bundles of tools, agents, workflows, MCP servers, and
SKILL.md context that the daemon installs into its in-memory
registries + `~/.claude.json` + `~/.claude/settings.json` without a
restart. Trust is graded by source; per-tool autonomy caps enforce
the ceiling.

## Day-1 providers

| Provider | Locator example | Trust tier |
|---|---|---|
| `git+url` | `https://github.com/owner/repo@v1.0.0` | `escape` |
| `claude-marketplace` | `claude-marketplace:wshobson/agents` (community) or `claude-marketplace:anthropics/skills` (trusted) | `community` / `trusted` |
| `mcp-official` | `mcp-official:exa-search` | `trusted` |
| `operad-curated` | `operad-curated:tribixbite/git-tools` | `trusted` (disabled by default — see env vars below) |

## CLI

```sh
tmx skill add <locator>                          # install
tmx skill add <locator> --force-take-ownership   # claim a hand-written MCP entry
tmx skill remove <skill-id> [--force-revoke]     # uninstall (with lease cascade)
tmx skill list [--provider=<p>]                  # list installed
tmx skill info <skill-id>                        # full manifest

tmx tool autonomy list                           # per-tool caps + current bucket
tmx tool autonomy set <tool-id> <bucket>         # promote (capped by source tier)
```

Buckets, low → high: `observe < suggest < supervised < trusted <
autonomous`. The cap is the maximum bucket the user can promote a
tool to; the default current bucket at install is the tier-defined
default (`observe` for escape, `suggest` for community/trusted).

## REST

```
GET    /api/skills                          list installed
GET    /api/skills/<id>                     full manifest
POST   /api/skills/install                  { provider, locator, version?,
                                              force_take_ownership? }
POST   /api/skills/<id>/uninstall           { force_revoke? }
GET    /api/skills/events                   recent install/update/uninstall events

GET    /api/tool-autonomy                   list per-tool caps + buckets
POST   /api/tool-autonomy                   { tool_id, bucket }
```

All endpoints return 503 when the daemon was started without
`--enable-skills-preview`. Install + uninstall return 409 when a
gating condition fires (`INSTALL_BLOCKED_BY_ACTIVE_CONSUMER`,
`TOOL_HAS_ACTIVE_CONSUMERS`, `AUTONOMY_CAP_VIOLATION`).

## Author workflow

A skill repo is a Claude-Code plugin repo + an optional
`.operad/operad.toml`. operad's adapter merges the two; authors who
only target Claude Code can skip the operad file.

```
my-plugin/
  .claude-plugin/marketplace.json    # claude-plugin native, unchanged
  plugin.json                        # claude-plugin per-plugin manifest
  skills/
    my-skill/SKILL.md                # Agent Skills (Anthropic standard)
    my-skill/scripts/...
  commands/                          # claude-plugin commands
  agents/                            # claude-plugin subagents
  .operad/
    operad.toml                      # operad-specific tools/agents/workflows/mcps
```

`.operad/operad.toml` schema:

```toml
[skill]
name = "rust-quality"
description = "rustfmt + clippy + cargo-test workflow + tool"

[[tool]]
name = "rust_clippy"
description = "Run clippy on the current crate"
command = "cargo clippy --message-format=json"
  [[tool.params]]
  name = "extra_args"
  type = "string"
  required = false

[[workflow]]
name = "rust-quality-gate"
  [[workflow.task]]
  id = "fmt"
  command = "cargo fmt --check"
  [[workflow.task]]
  id = "clippy"
  command = "cargo clippy --deny warnings"
  needs = ["fmt"]
  [[workflow.task]]
  id = "test"
  command = "cargo test"
  needs = ["clippy"]

[mcp.exa-search]
url = "https://exa.test/mcp"
transport = "http"
lifecycle = "config-only"
```

Publishing checklist:

1. Repo on GitHub. Tag releases with semver (`v1.0.0`).
2. Optional: PR to `operad-stream/skills` to be listed in the
   `operad-curated` provider.

## Trust tiers

| Tier | Triggers | Install prompt | Default bucket | Cap |
|---|---|---|---|---|
| `trusted` | `claude-marketplace:anthropics/*`, `mcp-official:*`, `operad-curated:*` | none | suggest | autonomous |
| `community` | `claude-marketplace:*` (any other owner) | manifest preview + y/n | suggest | autonomous |
| `escape` | `git+url:*`, local file paths, ssh URLs | full diff + y/n | observe | suggest |

Tools never silently exceed their tier's cap. A `tmx tool autonomy
set <id> autonomous` against an escape-tier tool returns
`AUTONOMY_CAP_VIOLATION`.

## Failure modes

| Code | What happened |
|---|---|
| `INSTALL_BLOCKED_BY_ACTIVE_CONSUMER` | An OODA cycle, scheduled run, or workflow run is in flight. Wait for it to finish, then retry. |
| `TOOL_HAS_ACTIVE_CONSUMERS` | Agents hold leases on tools this skill owns. Pass `--force-revoke` to clear them. |
| `TOOL_NAME_CONFLICT` / `WORKFLOW_NAME_CONFLICT` | Another skill (or built-in) already owns the name. Rename in your fork or uninstall the conflict. |
| `AUTONOMY_CAP_VIOLATION` | Promotion target exceeds the source-tier cap. |
| `MCP_NAME_USER_OWNED` | The MCP name already exists in `~/.claude.json` and operad doesn't own it. Pass `--force-take-ownership` if intended. |
| `MCP_OWNED_BY_OTHER_DAEMON` | A different operad daemon (different `daemon_id`) installed it. Resolve manually. |
| `CLAUDE_JSON_MALFORMED` / `CLAUDE_JSON_RACED` | `~/.claude.json` is broken or was rewritten mid-install. Fix the file or close the conflicting client, then retry. |
| `PROVIDER_FETCH_FAILED` | Network / git / registry error. Detail in `data`. |

## Env vars

| Variable | Purpose |
|---|---|
| `OPERAD_MCP_OFFICIAL_SPKI_PINS` | Comma-separated base64 SPKI hashes for the MCP registry. Empty string disables the pin; unset falls through to standard TLS verification with a warning. |
| `OPERAD_CURATED_COMMIT_SHA` | Pinned commit SHA of `operad-stream/skills` index repo. Empty (default) disables the `operad-curated` provider. |

## What's not in v1 (deferred)

- `smithery`, `github-topic`, `awesome-list`, `tessl`,
  `huggingface-spaces` providers
- Cross-tier always-more-restrictive cap downgrade UX
  (`--accept-cap-downgrade`)
- `tmx skill search` across providers
- `tmx skill update <id>` (per-skill update; bulk `--all` cut)
- `--check` on `tmx skill list`
- Auto-update on a schedule
- Generation pinning + two-phase cache GC tombstone (Phase C)
- Dashboard `SkillManager.svelte` panel
- `proxied` and `gateway` MCP lifecycle modes

See the design spec for the full deferred list and rationale.
