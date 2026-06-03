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

- **Signed manifests** (sigstore / cosign) — verify the skill bundle before commit. Currently we rely on git commit SHA + `git ls-tree` digest for git+url and the pinned curated index's commit SHA for `operad-curated`. Spec ref: §10.
- **Skill packs** — curated collections that install together as a single unit. Different surface from individual skill install (atomic across N skills). Spec ref: §10.
- **`operad-stream/skills` GitHub repo bootstrap** — local stub exists at `~/git/operad-stream-skills`. Production needs: push to `tribixbite/operad-stream-skills`, bake the production commit SHA into `INDEX_COMMIT_SHA` in `src/skills/providers/operad-curated.ts`, document the contributor flow for proposing additions.

### Tools / autonomy follow-ups

- **Per-tool autonomy bucket history** — currently only the latest `current_bucket` is persisted in `tool_autonomy_caps`. A trail (with timestamps + who promoted it) would help with cognitive replay + post-incident audit.
- **Cross-skill agent name conflicts** — handled for tools/workflows/mcps but the agent path is less exercised; need fixture tests once a second `[[agent]]`-shipping skill exists.

### Verification / quality bar

- **End-to-end dashboard verification with `--enable-skills-preview`**: SkillManagerPanel renders the empty state correctly when preview is off; full install/promote/uninstall flow through the UI has not been pixel-verified.
- **CI fixture against a published `operad-stream/skills` snapshot** — `skills-e2e.test.ts` runs against a synthetic file:// index. Once the production repo exists, a smoke job that fetches the real index every push would catch schema drift early.

---

## Operit-adopted patterns (out-of-scope follow-ups)

The Operit review (commit `4c2b20c`+) ported the DAG workflow engine. Items not adopted from that review:

- **Tool-result streaming over SSE**: Operit streams partial tool output for long-running calls. Our `ToolExecutor` blocks until the command returns. Adopting requires a streaming-aware `ToolResult` plus dashboard consumer.
- **Per-tool retry policy with exponential backoff**: Operit's executor has built-in retries; ours treats retries as the caller's problem. Probably the right call but flagging.

---

## Quality of life

- **`tmx doctor` JSON output**: structured output mode for CI pipelines.
- **Dashboard mobile pass on Memory + Telemetry panels**: SessionTable already got the table-layout fix; the other panels haven't had the same audit.

---

Last updated: 2026-05-21.
