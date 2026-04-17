# Sprint 1: Gate Agentic Features + In-App Documentation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all autonomous/agentic features opt-in on fresh installs, and add a comprehensive in-app `/help` documentation page covering all features.

**Architecture:** Two-part sprint. Part A flips defaults in `src/types.ts` and `src/agents.ts`. Part B adds a new SvelteKit route `dashboard/src/routes/help/+page.svelte` with tabbed sections covering core features first, agentic layer second. Part C updates the README and switchboard UI.

**Tech Stack:** TypeScript, SvelteKit 2 + Svelte 5 + Tailwind v4 (dashboard), bun runtime. Build: `bun run build` (routes to `node build.cjs`). Typecheck: `bun run typecheck`. Test: `bun test`.

**Spec:** `docs/superpowers/specs/2026-04-17-operad-sprint-design.md` § Sprint 1

---

## Project Context

operad is a cross-platform tmux session orchestrator for Claude Code sessions. Source in `src/`. Dashboard in `dashboard/` (SvelteKit 2 adapter-static → `dashboard/dist/`, served by `src/http.ts`). CLI entry: `src/tmx.ts`. Main daemon: `src/daemon.ts` (6644 lines).

Key files for this sprint:
- `src/types.ts:317` — `defaultSwitchboard()` — flip `cognitive`, `oodaAutoTrigger`, `mindMeld` to `false`
- `src/agents.ts:100` — `getBuiltinAgents()` — flip all 4 agents `enabled: true` → `false`
- `dashboard/src/routes/` — add `help/+page.svelte`
- `dashboard/src/lib/components/SettingsPanel.svelte` — add `?` help links per toggle
- `README.md` — restructure: core daemon leads, agentic is opt-in advanced section

---

## Task 1: Flip agentic defaults to opt-in

**Files:**
- Modify: `src/types.ts` (function `defaultSwitchboard` ~line 317)
- Modify: `src/agents.ts` (function `getBuiltinAgents` ~line 100)

- [ ] **Step 1: Update `defaultSwitchboard()` in `src/types.ts`**

Change lines ~318-327 from:
```ts
export function defaultSwitchboard(): Switchboard {
  return {
    all: true,
    sdkBridge: true,
    cognitive: true,
    oodaAutoTrigger: true,
    memoryInjection: true,
    mindMeld: true,
    agents: {},
  };
}
```
To:
```ts
export function defaultSwitchboard(): Switchboard {
  return {
    all: true,
    sdkBridge: true,        // serves core session/prompt features — on by default
    cognitive: false,       // opt-in: OODA loop timer
    oodaAutoTrigger: false, // opt-in: automatic master-controller runs
    memoryInjection: true,  // serves core prompt history — on by default
    mindMeld: false,        // opt-in: personality injection into OODA prompts
    agents: {},
  };
}
```

- [ ] **Step 2: Update `getBuiltinAgents()` in `src/agents.ts`**

Change all four `enabled: true` entries to `enabled: false`. There are exactly 4 agents: `master-controller` (~line 111), `optimizer` (~line 127), `preference-learner` (~line 143), `ideator` (~line 158). Each has `enabled: true` — change all to `enabled: false`.

- [ ] **Step 3: Typecheck**

```bash
cd ~/git/operad && bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Run tests**

```bash
cd ~/git/operad && bun test
```
Expected: all 29 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/git/operad
git add src/types.ts src/agents.ts
git commit -m "feat(agentic): default all autonomous features to opt-in on fresh installs

cognitive, oodaAutoTrigger, mindMeld default to false in defaultSwitchboard().
All 4 builtin agents default to enabled:false. Existing persisted state unchanged.
sdkBridge and memoryInjection remain true (core session/prompt features, not autonomous).

— claude-sonnet-4-6"
```

---

## Task 2: Add `/help` route to dashboard

**Files:**
- Create: `dashboard/src/routes/help/+page.svelte`
- Modify: `dashboard/src/routes/+layout.svelte` — add Help nav link

- [ ] **Step 1: Read the existing layout to find nav structure**

Read `dashboard/src/routes/+layout.svelte` to understand the nav link pattern.

- [ ] **Step 2: Create `dashboard/src/routes/help/+page.svelte`**

Create the help page with tabbed sections (core features first, agentic as a separate tab with an opt-in callout). Note: the spec suggested a `<details>` collapsible; tabs are used instead for clearer information hierarchy — the agentic tab still starts with a prominent opt-in warning.

Create the help page with the following structure:

```svelte
<script lang="ts">
  let activeTab = $state<'core' | 'agentic'>('core');
  let agenticExpanded = $state(false);
</script>

<svelte:head>
  <title>Help & Docs | operad</title>
</svelte:head>

<div class="max-w-4xl mx-auto p-4 space-y-6">
  <div>
    <h1 class="text-2xl font-bold text-white">operad Documentation</h1>
    <p class="text-zinc-400 mt-1">Cross-platform tmux session orchestrator for Claude Code sessions.</p>
  </div>

  <!-- Tab bar -->
  <div class="flex gap-2 border-b border-zinc-700">
    <button
      class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'core' ? 'text-white border-b-2 border-blue-500' : 'text-zinc-400 hover:text-zinc-200'}"
      onclick={() => activeTab = 'core'}
    >Core Features</button>
    <button
      class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'agentic' ? 'text-white border-b-2 border-purple-500' : 'text-zinc-400 hover:text-zinc-200'}"
      onclick={() => activeTab = 'agentic'}
    >Advanced: Autonomous Layer</button>
  </div>

  {#if activeTab === 'core'}
    <div class="space-y-8 text-zinc-300">

      <!-- Overview -->
      <section id="overview">
        <h2 class="text-xl font-semibold text-white mb-3">Overview</h2>
        <p>operad is a hardened daemon that manages tmux sessions, Claude Code instances, and long-running services across platforms (Linux, macOS, Android/Termux). It boots sessions in dependency order, monitors health, auto-restarts on failure, and provides a web dashboard for visibility and control.</p>
        <p class="mt-2">The agentic autonomous layer (OODA loops, AI agents, scheduling) is a separate opt-in feature — <strong>disabled by default</strong>. Enable it in <a href="/settings#switchboard" class="text-blue-400 hover:underline">Settings → Switchboard</a> when you're ready.</p>
      </section>

      <!-- Session Management -->
      <section id="sessions">
        <h2 class="text-xl font-semibold text-white mb-3">Session Management</h2>
        <p class="mb-2">Sessions are defined in <code class="bg-zinc-800 px-1 rounded">~/.config/operad/operad.toml</code> under <code class="bg-zinc-800 px-1 rounded">[[session]]</code> blocks. The daemon starts them in dependency order on boot.</p>
        <h3 class="text-lg font-medium text-white mt-4 mb-2">Session State Machine</h3>
        <div class="bg-zinc-800 rounded p-3 font-mono text-sm text-zinc-300">
          pending → waiting → starting → running ⇄ degraded → failed<br>
          &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↓<br>
          &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;stopping → stopped
        </div>
        <ul class="mt-3 space-y-1 text-sm list-disc list-inside">
          <li><strong>pending</strong> — waiting for dependencies to reach running</li>
          <li><strong>waiting</strong> — dep wait timed out, retrying</li>
          <li><strong>starting</strong> — tmux window created, process launching</li>
          <li><strong>running</strong> — health checks passing</li>
          <li><strong>degraded</strong> — health checks failing, restart scheduled</li>
          <li><strong>failed</strong> — max restarts exceeded</li>
        </ul>
        <h3 class="text-lg font-medium text-white mt-4 mb-2">Key Config Fields</h3>
        <div class="bg-zinc-800 rounded p-3 font-mono text-sm">
          <pre>[[session]]
name = "my-app"
command = "claude"
cwd = "~/git/my-app"
enabled = true
depends_on = ["another-session"]
priority = 10
max_restarts = 5
restart_delay_ms = 3000</pre>
        </div>
      </section>

      <!-- Health Checks -->
      <section id="health">
        <h2 class="text-xl font-semibold text-white mb-3">Health Checks</h2>
        <p class="mb-2">operad monitors sessions via configurable health checks. A session that fails health checks transitions to <code class="bg-zinc-800 px-1 rounded">degraded</code> and is restarted.</p>
        <h3 class="text-lg font-medium text-white mt-4 mb-2">Check Types</h3>
        <ul class="space-y-1 text-sm list-disc list-inside">
          <li><strong>tmux</strong> — window exists in the tmux session</li>
          <li><strong>process</strong> — PID is alive in the process table</li>
          <li><strong>http</strong> — HTTP endpoint returns 200</li>
          <li><strong>custom</strong> — arbitrary shell command exits 0</li>
        </ul>
        <div class="bg-zinc-800 rounded p-3 font-mono text-sm mt-3">
          <pre>[session.health]
type = "http"
url = "http://localhost:3000/health"
interval_ms = 10000
timeout_ms = 5000</pre>
        </div>
      </section>

      <!-- Dashboard -->
      <section id="dashboard">
        <h2 class="text-xl font-semibold text-white mb-3">Dashboard</h2>
        <p class="mb-2">The web dashboard runs on port <strong>18970</strong> by default. Access at <a href="http://localhost:18970" class="text-blue-400 hover:underline">http://localhost:18970</a>.</p>
        <ul class="space-y-1 text-sm list-disc list-inside">
          <li><strong>Overview</strong> — session status grid, memory/battery, recent activity</li>
          <li><strong>Memory</strong> — system memory pressure, per-process breakdown</li>
          <li><strong>Logs</strong> — real-time log stream with filtering</li>
          <li><strong>Telemetry</strong> — token usage, quota progress, daily/weekly charts</li>
          <li><strong>Settings</strong> — config viewer, switchboard toggles, plans browser</li>
        </ul>
      </section>

      <!-- Config Reference -->
      <section id="config">
        <h2 class="text-xl font-semibold text-white mb-3">Config Reference</h2>
        <p class="mb-2">Config file: <code class="bg-zinc-800 px-1 rounded">~/.config/operad/operad.toml</code></p>
        <div class="bg-zinc-800 rounded p-3 font-mono text-sm">
          <pre>[operad]
port = 18970                    # dashboard port
log_level = "info"              # debug|info|warn|error
state_dir = "~/.local/share/tmx"
quota_weekly_tokens = 1000000   # optional weekly token quota
quota_warning_pct = 80
quota_critical_pct = 95

[[session]]
name = "my-session"
command = "claude"
cwd = "~/git/my-project"
enabled = true</pre>
        </div>
        <p class="mt-2 text-sm text-zinc-400">Run <code class="bg-zinc-800 px-1 rounded">operad doctor</code> to validate your config and check system prerequisites.</p>
      </section>

      <!-- Prompt History -->
      <section id="prompts">
        <h2 class="text-xl font-semibold text-white mb-3">Prompt History</h2>
        <p>operad indexes Claude Code prompt history from <code class="bg-zinc-800 px-1 rounded">~/.claude/projects/</code> JSONL files. View, search, star, and replay prompts from the Overview page.</p>
      </section>

    </div>

  {:else}
    <!-- Agentic layer -->
    <div class="space-y-6">

      <div class="bg-purple-950/40 border border-purple-700/50 rounded-lg p-4">
        <div class="flex items-start gap-3">
          <span class="text-purple-400 text-xl">⚠</span>
          <div>
            <p class="text-purple-200 font-medium">Opt-in. Disabled by default.</p>
            <p class="text-purple-300/80 text-sm mt-1">These features run AI agents autonomously inside your sessions. Enable them in <a href="/settings#switchboard" class="text-purple-300 hover:underline">Settings → Switchboard</a> after reading the docs below. Start with individual agents before enabling auto-trigger.</p>
          </div>
        </div>
      </div>

      <div class="space-y-8 text-zinc-300">

        <!-- Vision -->
        <section id="agentic-overview">
          <h2 class="text-xl font-semibold text-white mb-3">What is the Autonomous Layer?</h2>
          <p>operad's agentic layer is a self-improving orchestrator that works alongside your sessions. Its goals:</p>
          <ul class="mt-2 space-y-1 text-sm list-disc list-inside">
            <li>Ensure large ambitions are decomposed and executed meticulously into polished, hardened apps</li>
            <li>Propose new project ideas and refinements/upgrades to existing projects</li>
            <li>Learn your preferences from notes, personality traits, and chat logs</li>
            <li>As trust is earned, make increasingly autonomous decisions</li>
          </ul>
          <p class="mt-3 text-sm text-zinc-400">The system starts in <strong>observe</strong> mode — it reads but doesn't act. You promote it to <strong>supervised</strong> → <strong>autonomous</strong> as you gain confidence in its behavior. See the Tuning Guide below.</p>
        </section>

        <!-- OODA Loop -->
        <section id="ooda">
          <h2 class="text-xl font-semibold text-white mb-3">OODA Loop & Master Controller</h2>
          <p class="mb-2">The <strong>master-controller</strong> agent runs an OODA loop (Observe → Orient → Decide → Act) on a configurable interval. It:</p>
          <ul class="space-y-1 text-sm list-disc list-inside">
            <li>Observes: reads session states, quota status, recent errors, goal tree</li>
            <li>Orients: evaluates against your goals and strategy</li>
            <li>Decides: selects an action (restart session, run agent, send prompt, update goals)</li>
            <li>Acts: executes via the tool registry or delegates to specialized agents</li>
          </ul>
          <h3 class="text-lg font-medium text-white mt-4 mb-2">Enabling</h3>
          <p class="text-sm">In Settings → Switchboard: enable <strong>Cognitive Timer</strong> first, then <strong>OODA Auto-Trigger</strong> when ready for autonomous runs. The master-controller agent must also be enabled.</p>
          <!-- TODO: document goal tree management UI, how to set/edit goals -->
          <p class="mt-2 text-sm text-zinc-500 italic">TODO: Goal tree management interface — coming soon.</p>
        </section>

        <!-- Agents -->
        <section id="agents">
          <h2 class="text-xl font-semibold text-white mb-3">Agents</h2>
          <p class="mb-3">Four builtin agents, all disabled by default. Enable individually in Settings → Switchboard → Agents.</p>
          <div class="space-y-4">
            <div class="bg-zinc-800 rounded p-3">
              <h4 class="font-medium text-white">master-controller</h4>
              <p class="text-sm text-zinc-400 mt-1">Primary actor. Runs OODA loops, decomposes goals, delegates to other agents, coordinates across sessions. Autonomy level: supervised by default.</p>
            </div>
            <div class="bg-zinc-800 rounded p-3">
              <h4 class="font-medium text-white">optimizer</h4>
              <p class="text-sm text-zinc-400 mt-1">Monitors token quota utilization. Flags high-consumption sessions, recommends consolidation. Read-only (observe + analyze only).</p>
            </div>
            <div class="bg-zinc-800 rounded p-3">
              <h4 class="font-medium text-white">preference-learner</h4>
              <p class="text-sm text-zinc-400 mt-1">Discovers your coding style, framework preferences, and workflow patterns from session history. Feeds into personality profile. Read-only.</p>
            </div>
            <div class="bg-zinc-800 rounded p-3">
              <h4 class="font-medium text-white">ideator</h4>
              <p class="text-sm text-zinc-400 mt-1">Generates architecture alternatives, new project concepts, and "what if" analysis. Read-only. Safe to enable early.</p>
            </div>
          </div>
        </section>

        <!-- Scheduling Engine -->
        <section id="scheduling">
          <h2 class="text-xl font-semibold text-white mb-3">Scheduling Engine</h2>
          <p class="mb-2">Schedule agents or shell commands to run on a cron or interval basis. Schedules persist in SQLite and survive daemon restarts.</p>
          <h3 class="text-lg font-medium text-white mt-4 mb-2">Creating a Schedule</h3>
          <div class="bg-zinc-800 rounded p-3 font-mono text-sm">
            <pre># Via IPC (operad send):
operad send schedule_create '{"name":"daily-opt","agent":"optimizer","cron":"0 9 * * *"}'

# Via REST API:
curl -X POST http://localhost:18970/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{"name":"daily-opt","agent":"optimizer","cron":"0 9 * * *"}'</pre>
          </div>
          <h3 class="text-lg font-medium text-white mt-4 mb-2">How It Works</h3>
          <ol class="space-y-1 text-sm list-decimal list-inside">
            <li>Schedule is stored in SQLite with next-run timestamp</li>
            <li>Daemon checks for due schedules every minute</li>
            <li>When due: runs the agent or command, records result</li>
            <li>Updates next-run based on cron expression or interval</li>
            <li>Auto-disables after N consecutive failures (configurable)</li>
          </ol>
          <!-- TODO: document schedule inspection UI in Settings panel -->
          <p class="mt-2 text-sm text-zinc-500 italic">TODO: Schedule management UI in Settings panel — view history, enable/disable, manual trigger.</p>
        </section>

        <!-- Memory System -->
        <section id="memory-system">
          <h2 class="text-xl font-semibold text-white mb-3">Memory System</h2>
          <p class="mb-2">operad maintains a SQLite-backed memory database. Agents read and write memories. The consolidation engine periodically decays old memories, prunes low-confidence ones, and cross-pollinates insights between agents.</p>
          <h3 class="text-lg font-medium text-white mt-4 mb-2">Feeding the System</h3>
          <ul class="space-y-1 text-sm list-disc list-inside">
            <li><strong>Notes</strong> — write free-form notes in the Memory panel; they're stored as user memories</li>
            <li><strong>Personality traits</strong> — define your preferences in Settings → Mind Meld; injected into OODA prompts</li>
            <li><strong>Chat logs</strong> — the preference-learner agent extracts patterns from Claude session history</li>
          </ul>
          <h3 class="text-lg font-medium text-white mt-4 mb-2">Memory Types</h3>
          <ul class="space-y-1 text-sm list-disc list-inside">
            <li><strong>user</strong> — your preferences and profile</li>
            <li><strong>project</strong> — per-project context and decisions</li>
            <li><strong>agent</strong> — agent learnings and personality</li>
          </ul>
          <!-- TODO: document memory consolidation schedule and tuning params -->
          <p class="mt-2 text-sm text-zinc-500 italic">TODO: Consolidation tuning parameters (decay rate, confidence threshold, merge window).</p>
        </section>

        <!-- Specialization & Roundtable -->
        <section id="specialization">
          <h2 class="text-xl font-semibold text-white mb-3">Specialization & Roundtable</h2>
          <p class="mb-2">Agents can be assigned specializations (frontend, backend, security, etc.). The roundtable protocol gathers consensus from multiple specialized agents before the master-controller acts on a high-stakes decision.</p>
          <!-- TODO: document how to add custom specializations via TOML -->
          <!-- TODO: document roundtable trigger conditions and consensus threshold -->
          <p class="text-sm text-zinc-500 italic">TODO: Custom specialization configuration and roundtable threshold docs — coming soon.</p>
        </section>

        <!-- Tuning Guide -->
        <section id="tuning">
          <h2 class="text-xl font-semibold text-white mb-3">Tuning Guide: Unlocking Autonomy Progressively</h2>
          <p class="mb-3">The autonomy progression model:</p>
          <ol class="space-y-3 text-sm list-decimal list-inside">
            <li><strong>Observe</strong> — Enable preference-learner + ideator. They read your sessions and build a model of your preferences. No actions taken.</li>
            <li><strong>Supervised</strong> — Enable optimizer + cognitive timer. Agents run but require approval for mutative actions. Review their suggestions in the Cognitive panel.</li>
            <li><strong>Auto-trigger</strong> — Enable OODA auto-trigger. Master-controller runs on schedule. Review its decisions in the decision journal.</li>
            <li><strong>Autonomous</strong> — Set master-controller autonomy_level to "autonomous" in TOML. Acts without per-action approval within its allowed_tool_categories.</li>
          </ol>
          <p class="mt-3 text-sm text-zinc-400">Each level unlocks more capability but requires that you've verified the previous level behaves correctly for your setup. The system learns faster when you feed it notes and respond to idea prompts — each interaction updates agent_learnings and agent_personality, making future decisions more aligned.</p>
        </section>

      </div>
    </div>
  {/if}
</div>
```

- [ ] **Step 3: Add Help nav link to `+layout.svelte`**

Read `dashboard/src/routes/+layout.svelte` to find the nav links section. Add a Help link following the same pattern as existing links (e.g., the Settings link). The link should point to `/help`.

- [ ] **Step 4: Build dashboard and verify**

```bash
cd ~/git/operad/dashboard && bun run build
```
Expected: successful build with no errors.

- [ ] **Step 5: Commit**

```bash
cd ~/git/operad
git add dashboard/src/routes/help/ dashboard/src/routes/+layout.svelte
git commit -m "feat(dashboard): add /help documentation page with core + agentic sections

Tabbed layout: Core Features (sessions, health, dashboard, config, prompts) and
Advanced Autonomous Layer (OODA, agents, scheduling, memory, tuning guide).
Agentic section defaults collapsed with opt-in callout. TODO stubs for gaps.

— claude-sonnet-4-6"
```

---

## Task 3: Add `?` help links to SettingsPanel switchboard toggles

**Files:**
- Modify: `dashboard/src/lib/components/SettingsPanel.svelte`

- [ ] **Step 1: Read SettingsPanel.svelte**

Read `dashboard/src/lib/components/SettingsPanel.svelte` to find the switchboard toggle section.

- [ ] **Step 2: Add `?` icon links**

For each switchboard toggle (cognitive, oodaAutoTrigger, mindMeld, sdkBridge, memoryInjection), add a small `?` link that opens `/help#<anchor>`. Also add a top-level notice above the toggles:

```svelte
<div class="mb-4 p-3 bg-zinc-800 rounded text-sm text-zinc-400">
  All autonomous features are disabled on fresh installs. Enable them progressively —
  <a href="/help#agentic-overview" class="text-purple-400 hover:underline">read the docs</a> before enabling.
</div>
```

Each toggle row should have a `?` icon link like:
```svelte
<a href="/help#ooda" class="text-zinc-500 hover:text-zinc-300 ml-1 text-xs" title="Documentation">?</a>
```

Map toggles to anchors:
- `cognitive` → `/help#ooda`
- `oodaAutoTrigger` → `/help#ooda`
- `mindMeld` → `/help#memory-system`
- `sdkBridge` → `/help#sessions`
- `memoryInjection` → `/help#memory-system`

- [ ] **Step 3: Build and verify**

```bash
cd ~/git/operad/dashboard && bun run build
```

- [ ] **Step 4: Commit**

```bash
cd ~/git/operad
git add dashboard/src/lib/components/SettingsPanel.svelte
git commit -m "feat(dashboard): add help links to switchboard toggles and opt-in notice

Each toggle now has a ? link to the relevant /help anchor. Top-level notice
states all autonomous features are disabled on fresh installs.

— claude-sonnet-4-6"
```

---

## Task 4: Restructure README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read current README**

Read `README.md` to understand current structure.

- [ ] **Step 2: Restructure README**

Rewrite to lead with core daemon capabilities. Structure:

```markdown
# operad

Cross-platform tmux session orchestrator for Claude Code sessions.

**What it does:**
- Boot and manage tmux sessions with dependency ordering
- Health checks, auto-restart, and session lifecycle management
- Web dashboard: session status, memory, logs, telemetry, settings
- Prompt history: search, star, and replay Claude prompts
- Battery and memory awareness on Android/Termux

## Quick Start

\`\`\`sh
npm install -g operadic
# Create ~/.config/operad/operad.toml (see Config below)
operad boot
# Dashboard: http://localhost:18970
\`\`\`

Run `operad doctor` to diagnose any setup issues.

## Config

\`\`\`toml
[operad]
port = 18970

[[session]]
name = "my-app"
command = "claude"
cwd = "~/git/my-app"
enabled = true
\`\`\`

## CLI Commands

| Command | Description |
|---------|-------------|
| `operad boot` | Start daemon + all sessions |
| `operad status` | Show all session states |
| `operad start <name>` | Start a specific session |
| `operad stop <name>` | Stop a specific session |
| `operad restart <name>` | Restart a specific session |
| `operad logs` | Stream daemon logs |
| `operad doctor` | Diagnose install issues |
| `operad upgrade` | Rebuild and hot-swap daemon |
| `operad shutdown` | Stop daemon and all sessions |

## Platforms

- **Android/Termux** — primary platform, battery/phantom-budget-aware
- **Linux** — full support
- **macOS** — full support

---

## Advanced: Autonomous Layer

> **Opt-in. Disabled by default.** These features run AI agents autonomously.
> Enable via dashboard Settings → Switchboard after reading the [in-app docs](http://localhost:18970/help#agentic-overview).

operad includes an agentic layer for self-improving orchestration:

- **OODA loop** — periodic Observe→Orient→Decide→Act cycles via master-controller agent
- **Agents** — optimizer, preference-learner, ideator, master-controller
- **Scheduling engine** — cron/interval triggers for agents and commands
- **Memory system** — decay, consolidation, cross-pollination of agent learnings
- **Tuning** — feed notes, personality traits, and chat logs to shape autonomous decisions

See in-app `/help` for full documentation.

## Development

\`\`\`sh
bun install
bun run build       # bundle to dist/tmx.js
bun run typecheck   # TypeScript check
bun test            # unit tests
cd dashboard && bun run build  # build dashboard
\`\`\`
```

- [ ] **Step 3: Commit**

```bash
cd ~/git/operad
git add README.md
git commit -m "docs(readme): restructure — core daemon leads, agentic is opt-in advanced section

60-second quickstart, CLI reference table, platform list. Advanced autonomous
layer clearly separated with opt-in callout and /help link.

— claude-sonnet-4-6"
```

---

## Task 5: Final verification

- [ ] **Step 1: Full build**

```bash
cd ~/git/operad && bun run build && bun run typecheck && bun test
```
Expected: build succeeds, typecheck clean, 29 tests pass.

- [ ] **Step 2: Dashboard build**

```bash
cd ~/git/operad/dashboard && bun run build
```
Expected: no errors.

- [ ] **Step 3: Verify defaults**

```bash
node -e "const {defaultSwitchboard} = require('./dist/tmx.js'); console.log(defaultSwitchboard())" 2>/dev/null || node dist/tmx.js --version
```
If the above doesn't work easily, just verify by reading the source:
```bash
grep -A 10 "function defaultSwitchboard" src/types.ts
```
Expected: `cognitive: false`, `oodaAutoTrigger: false`, `mindMeld: false`.

- [ ] **Step 4: Final commit (if any uncommitted changes)**

```bash
cd ~/git/operad && git status
```
If clean, sprint is complete.
