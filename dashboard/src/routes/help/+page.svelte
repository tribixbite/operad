<script lang="ts">
  let activeTab = $state<'core' | 'agentic'>('core');
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

      <section id="overview">
        <h2 class="text-xl font-semibold text-white mb-3">Overview</h2>
        <p>operad is a hardened daemon that manages tmux sessions, Claude Code instances, and long-running services across platforms (Linux, macOS, Android/Termux). It boots sessions in dependency order, monitors health, auto-restarts on failure, and provides a web dashboard for visibility and control.</p>
        <p class="mt-2">The agentic autonomous layer (OODA loops, AI agents, scheduling) is a separate opt-in feature — <strong>disabled by default</strong>. Enable it in <a href="/settings#switchboard" class="text-blue-400 hover:underline">Settings → Switchboard</a> when you're ready.</p>
      </section>

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

      <section id="dashboard">
        <h2 class="text-xl font-semibold text-white mb-3">Dashboard</h2>
        <p class="mb-2">The web dashboard runs on port <strong>18970</strong> by default.</p>
        <ul class="space-y-1 text-sm list-disc list-inside">
          <li><strong>Overview</strong> — session status grid, memory/battery, recent activity</li>
          <li><strong>Memory</strong> — system memory pressure, per-process breakdown</li>
          <li><strong>Logs</strong> — real-time log stream with filtering</li>
          <li><strong>Telemetry</strong> — token usage, quota progress, daily/weekly charts</li>
          <li><strong>Settings</strong> — config viewer, switchboard toggles, plans browser</li>
        </ul>
      </section>

      <section id="config">
        <h2 class="text-xl font-semibold text-white mb-3">Config Reference</h2>
        <p class="mb-2">Config file: <code class="bg-zinc-800 px-1 rounded">~/.config/operad/operad.toml</code></p>
        <div class="bg-zinc-800 rounded p-3 font-mono text-sm">
          <pre>[operad]
port = 18970
log_level = "info"
state_dir = "~/.local/share/tmx"
quota_weekly_tokens = 1000000
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

      <section id="prompts">
        <h2 class="text-xl font-semibold text-white mb-3">Prompt History</h2>
        <p>operad indexes Claude Code prompt history from <code class="bg-zinc-800 px-1 rounded">~/.claude/projects/</code> JSONL files. View, search, star, and replay prompts from the Overview page.</p>
      </section>

    </div>

  {:else}
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

        <section id="agentic-overview">
          <h2 class="text-xl font-semibold text-white mb-3">What is the Autonomous Layer?</h2>
          <p>operad's agentic layer is a self-improving orchestrator that works alongside your sessions. Its goals:</p>
          <ul class="mt-2 space-y-1 text-sm list-disc list-inside">
            <li>Ensure large ambitions are decomposed and executed meticulously into polished, hardened apps</li>
            <li>Propose new project ideas and refinements/upgrades to existing projects</li>
            <li>Learn your preferences from notes, personality traits, and chat logs</li>
            <li>As trust is earned, make increasingly autonomous decisions</li>
          </ul>
          <p class="mt-3 text-sm text-zinc-400">The system starts in <strong>observe</strong> mode — it reads but doesn't act. You promote it to <strong>supervised</strong> → <strong>autonomous</strong> as you gain confidence in its behavior.</p>
        </section>

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
        </section>

        <section id="agents">
          <h2 class="text-xl font-semibold text-white mb-3">Agents</h2>
          <p class="mb-3">Four builtin agents, all disabled by default. Enable individually in Settings → Switchboard → Agents.</p>
          <div class="space-y-4">
            <div class="bg-zinc-800 rounded p-3">
              <h4 class="font-medium text-white">master-controller</h4>
              <p class="text-sm text-zinc-400 mt-1">Primary actor. Runs OODA loops, decomposes goals, delegates to other agents, coordinates across sessions.</p>
            </div>
            <div class="bg-zinc-800 rounded p-3">
              <h4 class="font-medium text-white">optimizer</h4>
              <p class="text-sm text-zinc-400 mt-1">Monitors token quota utilization. Flags high-consumption sessions, recommends consolidation. Read-only.</p>
            </div>
            <div class="bg-zinc-800 rounded p-3">
              <h4 class="font-medium text-white">preference-learner</h4>
              <p class="text-sm text-zinc-400 mt-1">Discovers your coding style, framework preferences, and workflow patterns from session history. Read-only.</p>
            </div>
            <div class="bg-zinc-800 rounded p-3">
              <h4 class="font-medium text-white">ideator</h4>
              <p class="text-sm text-zinc-400 mt-1">Generates architecture alternatives, new project concepts, and "what if" analysis. Read-only. Safe to enable early.</p>
            </div>
          </div>
        </section>

        <section id="scheduling">
          <h2 class="text-xl font-semibold text-white mb-3">Scheduling Engine</h2>
          <p class="mb-2">Schedule agents or shell commands to run on a cron or interval basis. Schedules persist in SQLite and survive daemon restarts.</p>
          <div class="bg-zinc-800 rounded p-3 font-mono text-sm">
            <pre>curl -X POST http://localhost:18970/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{{"name":"daily-opt","agent":"optimizer","cron":"0 9 * * *"}}'</pre>
          </div>
        </section>

        <section id="memory-system">
          <h2 class="text-xl font-semibold text-white mb-3">Memory System</h2>
          <p class="mb-2">operad maintains a SQLite-backed memory database. Agents read and write memories. The consolidation engine periodically decays old memories, prunes low-confidence ones, and cross-pollinates insights between agents.</p>
          <h3 class="text-lg font-medium text-white mt-4 mb-2">Memory Types</h3>
          <ul class="space-y-1 text-sm list-disc list-inside">
            <li><strong>user</strong> — your preferences and profile</li>
            <li><strong>project</strong> — per-project context and decisions</li>
            <li><strong>agent</strong> — agent learnings and personality</li>
          </ul>
        </section>

        <section id="tuning">
          <h2 class="text-xl font-semibold text-white mb-3">Tuning Guide: Unlocking Autonomy Progressively</h2>
          <ol class="space-y-3 text-sm list-decimal list-inside">
            <li><strong>Observe</strong> — Enable preference-learner + ideator. They read your sessions and build a model of your preferences. No actions taken.</li>
            <li><strong>Supervised</strong> — Enable optimizer + cognitive timer. Agents run but require approval for mutative actions.</li>
            <li><strong>Auto-trigger</strong> — Enable OODA auto-trigger. Master-controller runs on schedule.</li>
            <li><strong>Autonomous</strong> — Set master-controller autonomy_level to "autonomous" in TOML.</li>
          </ol>
        </section>

      </div>
    </div>
  {/if}
</div>
