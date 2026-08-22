# Roadmap

Tracks work consciously deferred out of shipped milestones. Anything not on
this list is either done or untracked. Items here are not commitments to a
date — they're a queue of known-shape work waiting for someone to need it
enough to land it.

Pointers to the source-of-truth specs are inline so a future contributor can
read the original design rationale before implementing.

---

## Skill / plugin marketplace (v1.1+)

Design spec: [`docs/superpowers/specs/2026-05-20-skill-marketplace-design.md`](superpowers/specs/2026-05-20-skill-marketplace-design.md).
v1 user-facing docs: [`docs/skills.md`](skills.md).

### IPC / REST / CLI gaps left in v1

| Surface | What's missing | Spec ref |
|---|---|---|
| `skill.update <id>` | per-skill update path (re-fetch latest, diff, re-register) | §5.1, §10 |
| `skill.enable <id>` / `skill.disable <id>` | flip the `enabled` flag, partially unregister/register tools and workflows without dropping the cache or settings entries | §5.1 |
| `skill.search` | cross-provider search with stable ranking | §5.1, §10 |
| `tmx skill list --check` | "is upstream newer than installed?" probe | §10, §2 |
| Bulk `--all` operations | update/enable/disable across many skills in one command | §10 |
| Auto-update on a schedule | cron-driven `update --all` | §10 |

Enable / disable in particular has a clean implementation path — `SkillStore.setEnabled` already exists; the work is the partial register/unregister against `ToolExecutor` and `WorkflowEngine` plus the matching settings.json / claude.json updates. Update has to think harder about "tools that disappeared between versions" + active leases.

### Providers deferred past v1

Trust tier in parentheses.

| Provider | Notes | Spec ref |
|---|---|---|
| `smithery` (community) | needs auth, rate-limit, cache, debounce; non-trivial backend | §10 |
| `github-topic` (per-result trust UX) | aggregates repos tagged `claude-code-plugin`; trust tier has to be decided per-result | §10 |
| `awesome-list` (community/escape) | parse curated `awesome-*` lists into a flat catalogue | §10 |
| `huggingface-spaces` | filter HF spaces that expose MCP endpoints | §10 |
| `tessl` | dependent on Tessl shipping a public JSON API | §10, §2 |

The provider interface in `src/skills/providers/git-url.ts` is the reference shape — all new providers should slot in alongside it without touching `SkillManager`.

### MCP lifecycle modes deferred past v1

| Mode | Why deferred | Spec ref |
|---|---|---|
| `proxied` | requires a real stdio multiplexer; HTTP shim breaks sampling/elicitation/roots | §10, §2 |
| `gateway` | round-3 review cut this to avoid silently redefining the enum value once a real gateway exists | §10, §2 |
| `task-gateway` | depends on MCP Tasks primitive (June 2026 spec) | §10, §2 |

The `McpLifecycle` enum is intentionally single-value (`"config-only"`) in v1 — adding a second variant is the trigger for the round-3 design discussion to reopen.

### Hardening / supply chain

**Closed in 0.4.9** (previously listed here):

- ~~GC retain-floor counted tombstoned rows~~ — a skill with ≤ `retain_per_pair`
  uninstalled versions was permanently protected, so its cache dir and DB row
  leaked forever. Tombstones no longer consume retain slots.
- ~~GC pin gate reached `skill_generation_refs` through `skill_active_version`~~,
  which `markUninstalled` deletes — so pass-2 deleted cache dirs while consumers
  still held live pins. The generation is now recorded on the `skills` row and
  survives tombstoning.
- ~~GC settings.json reference check hardcoded `/`~~ — never matched on Windows,
  so the sweeper could delete a cache dir Claude Code was loading from.
- ~~`operad-curated` integrity check was a no-op~~ — the digest was computed and
  only embedded in an error message, never compared, while the comment claimed
  CDN-tamper protection.
- ~~Node builds could not install any skill shipping `operad.toml`~~ — the parser
  was behind a `globalThis.Bun` check although the bundle's shebang is `node`.
- ~~`installInProgress` could latch forever~~ — set ~65 lines above its
  try/finally, so an early throw blocked all tool calls until daemon restart.


- **Signed manifests** (sigstore / cosign) — verify the skill bundle before commit. Currently we rely on git commit SHA + `git ls-tree` digest for git+url, and for `operad-curated` the pinned commit SHA plus an optional exact body digest via `OPERAD_CURATED_INDEX_SHA256`. Spec ref: §10.
- **Bake production SPKI pins for `mcp-official`** — `SPKI_PINS` is still empty in source, so the registry connection is TLS-only unless an operator sets `OPERAD_MCP_OFFICIAL_SPKI_PINS`. The unpinned fallback now emits a one-shot process warning instead of being silent, and overriding the registry base URL downgrades the provider to the `escape` trust tier, but a committed production pin is still the goal.
- **Skill packs** — curated collections that install together as a single unit. Different surface from individual skill install (atomic across N skills). Spec ref: §10.
- **`operad-stream/skills` GitHub repo bootstrap** — local stub exists at `~/git/operad-stream-skills`. Production needs: push to `tribixbite/operad-stream-skills`, bake the production commit SHA into `INDEX_COMMIT_SHA` in `src/skills/providers/operad-curated.ts`, document the contributor flow for proposing additions.

### Tools / autonomy follow-ups

- **Per-tool autonomy bucket history** — currently only the latest `current_bucket` is persisted in `tool_autonomy_caps`. A trail (with timestamps + who promoted it) would help with cognitive replay + post-incident audit.
- **Cross-skill agent name conflicts** — handled for tools/workflows/mcps but the agent path is less exercised; need fixture tests once a second `[[agent]]`-shipping skill exists.

### Verification / quality bar

- **End-to-end dashboard verification of the skill marketplace**: SkillManagerPanel renders the empty state correctly when the surface is disabled, and the REST layer is verified against a live daemon; the full install/promote/uninstall flow through the UI has not been pixel-verified.
- **CI fixture against a published `operad-stream/skills` snapshot** — `skills-e2e.test.ts` runs against a synthetic file:// index. Once the production repo exists, a smoke job that fetches the real index every push would catch schema drift early.

---

## Operit-adopted patterns (out-of-scope follow-ups)

The Operit review (commit `4c2b20c`+) ported the DAG workflow engine. Items not adopted from that review:

- **Tool-result streaming over SSE**: Operit streams partial tool output for long-running calls. Our `ToolExecutor` blocks until the command returns. Adopting requires a streaming-aware `ToolResult` plus dashboard consumer.
- **Per-tool retry policy with exponential backoff**: Operit's executor has built-in retries; ours treats retries as the caller's problem. Probably the right call but flagging.

---

## Deferred from the 2026-08 resilience + token work

- **`termux-job-scheduler` as the supervision floor.** `watchdog.sh` now holds
  its own wake lock and reports suspend overshoot, which fixed the observed
  outage (60 gaps / 933 blind minutes over three days → zero in the 25 h after).
  But it is still a userspace `sleep` loop: if the wake lock is ever taken away
  by something re-acquiring cannot beat, the loop stops polling again. Android's
  JobScheduler (via `termux-job-scheduler`) is suspend-proof by construction and
  is the escalation. Trigger to implement: repeated `SUSPENDED` lines in
  `watchdog.log` despite the lock being held. See `docs/persistence.md`.

- **Rates for legacy models.** `MODEL_RATES` in `claude-session.ts` covers the
  models with currently published pricing. Anything else — Opus 4.5, Sonnet 4.5,
  Opus 4.1, the retired 3.x line — is deliberately reported as
  `unpriced_tokens` rather than charged a guessed rate. A corpus with heavy
  legacy usage will therefore show a cost lower than reality, flagged in the UI.
  Filling those in needs a source for historical list prices, not recall.

- **Cost is list price, not spend.** `cost_usd` ignores subscription plans,
  batch (50%) discounts, and the `service_tier` field the transcripts already
  carry. Every entry observed so far is `standard`, so nothing is mispriced
  today, but a batch-heavy workload would read high.

- **Dashboard type debt.** `bunx svelte-check` reports 58 errors across 27
  files, all pre-existing and unrelated to any single feature — mostly
  `Property 'x' does not exist on type 'never'` from untyped store access.
  Worth a dedicated pass rather than opportunistic fixes.

## Quality of life

- **`tmx doctor` JSON output**: structured output mode for CI pipelines.
- **Dashboard mobile pass on Memory + Telemetry panels**: SessionTable already got the table-layout fix; the other panels haven't had the same audit.

---

Last updated: 2026-08-22.
