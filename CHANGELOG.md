# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed — "all time" was neither all of the usage nor all of the time

Three independent gaps, all in the same direction: the widest range in the
Tokens panel under-reported what it claimed to cover.

- **Subagent transcripts were never read.** `resolveJsonlFiles` listed only the
  top level of a project's `~/.claude/projects` directory, but the turns of any
  subagent a session dispatched live one level down, in
  `<session-id>/subagents/**` — and workflow runs nest another level, under
  `subagents/workflows/wf_<id>/`. That is 460 files and 144 MB against 162 MB
  at the top level on the author's machine: **2.93B tokens and ~$3,500 of real,
  separately billed spend**, roughly 30% on top of the reported total. Verified
  against the parent transcripts before counting it — 201 subagent entry uuids,
  **zero** of them present in the parent — so this was uncounted usage, not
  double counting.

  Subagent turns now fold into the row of the session that dispatched them: a
  subagent is part of that session's work, not a session of its own. One gets
  its own row only when its parent transcript is gone, so its tokens are still
  counted rather than dropped.

- **Only projects with a running session were counted.** A range labelled "all
  time" that loses a project the moment its session stops does not mean that.
  `/api/token-usage` now defaults to every project directory on disk;
  `?scope=live` restores the old behaviour, and `/api/tokens` keeps `live` as
  its default because it is defined as the aggregate over running sessions.

  Each project's real path comes from the `cwd` its transcripts record.
  Un-mangling the directory name cannot work: `manglePath` maps every
  non-alphanumeric character to `-`, so `git/Unexpected-Keyboard` and
  `git/Unexpected/Keyboard` are indistinguishable afterwards. A directory whose
  path cannot be recovered is skipped rather than guessed at.

- **The daily series had no gaps because it had no silent days.** Only days
  with activity produced a bucket, and the chart lays bars out by index — so a
  quiet week was not drawn as a gap, it was not drawn at all. On the author's
  data an Apr 17 → Aug 23 span (129 days, 21 gaps, the longest 11 days) drew as
  60 evenly-spaced bars that read as 60 consecutive days. The series is now
  zero-filled across its span, so the x-axis is a real time axis and the "129d"
  badge counts calendar days. Leading and trailing silence is still trimmed —
  the range never extends past what was recorded — and `CostChart`'s minimum
  bar width no longer exceeds its slot, which would smear a dense series into a
  solid block.

Measured end to end on the author's corpus: **9.66B tokens / $9,705 before,
12.69B / $13,291 after**, reconciling with a brute-force scan of all 495
transcripts.

### Fixed — the Tokens panel could not be opened, and its totals were inflated

- **One project was listed once per session pointing at it.** `/api/tokens`
  and `/api/token-usage` built their project list by iterating sessions, but
  the scan behind each row reads the whole JSONL corpus of a *directory*.
  Several operad sessions routinely share one working directory —
  `mergeRegistrySessions()` folds ad-hoc registry entries into
  `config.sessions` deduplicating on NAME only — so a repo worked on under
  three names produced three identical rows. Only the registry loop
  deduplicated, and after the merge it is the config loop that sees the
  duplicates.

  Two consequences, both visible on the author's install: the grand total
  counted those transcripts three times over (**14.61B tokens / $16,851
  reported against 9.66B / $9,705 actually used**), and the repeated `path`
  values made Svelte throw `each_key_duplicate` on the panel's keyed
  `{#each}` — which aborts the render of the whole overview page, so the
  Tokens card would not expand and the page stopped responding.

  Rows are now keyed by normalised project path, and labelled with the
  directory's own name instead of whichever session happened to sort first
  (which had a scratch session name showing against a repo).

### Fixed — `operad upgrade` reported a restart failure that had not happened

- **The wait was shorter than the watchdog's poll interval.** Upgrade shuts
  the daemon down and lets the watchdog restart it, then waited 20s — but
  headless supervision polls once a minute, so an upgrade run at the wrong
  point in that cycle printed *"Watchdog didn't restart daemon within 20s"*
  while the restart was still pending, and the daemon came back unattended
  moments later.

  Upgrade now signals the watchdog to re-check immediately and waits up to 90s
  — one full poll interval plus startup — so the slow path still succeeds
  rather than being declared broken.

- **The wake signal is SIGWINCH, whose default action is to be ignored.** The
  sender cannot know whether the watchdog it found predates the handler (a
  long-lived one keeps running the script bash parsed at launch, so an updated
  file on disk proves nothing), and an unhandled SIGUSR1 would have killed the
  one process able to restart the daemon. Verified both ways on device.

- **The watchdog's poll sleep is now interruptible at all.** It ran
  `sleep 60` in the foreground, and bash defers a trap until the foreground
  command finishes — so the script also ignored SIGTERM for up to a minute
  (measured: 19s to die on this device). Backgrounding the sleep and waiting
  on it with the `wait` builtin makes both the wake signal and shutdown
  prompt.

- **`pgrep -f watchdog.sh` matched processes that were not watchdogs** — the
  shell running that very pgrep, an editor with the file open. Candidate pids
  are now confirmed by matching an argv *element*, mirroring the check
  `watchdog.sh` already made of its own siblings.

### Fixed — token costs were 57% too high

- **One hardcoded rate was applied to every model.** `PRICING` in
  `claude-session.ts` held `{input: 15, output: 75, cache_read: 1.5,
  cache_creation: 18.75}` — Claude 3 Opus / Opus 4-era rates — and every cost
  in the dashboard, the daily chart and `/api/token-usage` was computed from
  it regardless of which model produced the tokens. Opus 5 is $5/$25, so its
  figures read 3× high; Haiku 4.5 is $1/$5, so its output read 15× high.

  Rates are now per model, resolved from the `model` field each JSONL entry
  already carries, with dated snapshots (`claude-haiku-4-5-20251001`) pricing
  as their alias.

- **Cache writes ignored their TTL.** Cache pricing is a multiple of a model's
  input rate — 0.1× read, **1.25× for a 5-minute write, 2× for a 1-hour
  write** — and the code charged every write at 1.25×. Claude Code records the
  split under `usage.cache_creation`, and on the author's corpus **89% of all
  cache-creation tokens are 1-hour writes**, so the dominant path was
  under-counted by 37.5% while everything else was over-counted.

  Measured across 492 real transcripts: the old figure was **$29,564.42**, the
  corrected one is **$12,843.34** — 56.6% too high.

- **A model with no published rate is now reported, not guessed at.** Its
  tokens are excluded from the cost and surfaced as `unpriced_tokens` /
  `unpriced_models`, with the panel saying so, rather than being charged some
  other model's rate. The cost stat is labelled "est. cost": it is list API
  rates applied to recorded usage, not a bill.

### Removed

- Five dashboard API wrappers with no remaining consumers after the Tokens
  rework — `fetchTokens`, `fetchDailyTokens`, `fetchWindowTokens`,
  `fetchQuotaStatus`, `fetchSdkCosts`. The REST endpoints they called are
  unchanged; only the dead client code is gone.

### Fixed — three defects found by running the above, not trusting it

- **The watchdog could not invoke operad at all unless Termux:Boot started it.**
  `dist/tmx.js` carries `#!/usr/bin/env node` and Termux has no `/usr/bin/env`.
  The exec shim rewrites that at `execve` time, but only when it was
  `LD_PRELOAD`ed into the process *doing* the exec — and the dynamic linker
  reads `LD_PRELOAD` once, at process start. So the `export LD_PRELOAD` at the
  top of `watchdog.sh` never applied to its own `execve`, only to
  grandchildren; the comment claiming otherwise has been corrected.

  It worked from Termux:Boot solely because the login environment had already
  loaded the shim into bash. Once `operad stream` began spawning the watchdog,
  every invocation exited 126, `daemon_alive` read that as "daemon dead", and
  the loop retried `Starting operad stream...` forever against a daemon that
  was alive throughout. A startup probe now falls back to naming the
  interpreter (`node`, then `bun`), logs which form it used, and exits 1 if
  neither works.

- **The wake-lock check reported "held" forever once a lock had ever existed.**
  `dumpsys power` prints the active `Wake Locks: size=N` block and, far below,
  a wake-lock *event history* that retains the tag for days after release. Both
  the shell check and `android.ts` matched the whole output, so they saw a
  three-day-old history line and answered "held" — which would have defeated
  the re-acquire mechanism entirely. Both now scan only the active block.

- **`trap 'rm -f "$PIDFILE"' EXIT INT TERM` made the watchdog ignore SIGTERM.**
  A trap replaces the default action, and a handler that does not exit returns
  to the loop — so the process survived `kill` while deleting its own pidfile,
  losing the single-instance fast path and becoming killable only by SIGKILL.
  The handler re-raises with itself removed now.

- Steady-state log noise removed: the loop wrote two lines per poll regardless
  of state, which is what grew this log to 692 KB of nothing and made the real
  outage hard to see. It logs state changes plus a half-hourly heartbeat.

### Fixed — supervision was blind for 933 minutes and nothing said so

- **The wake lock silently stopped being held, and the daemon never noticed.**
  `WakeLockManager.acquire()` gated on a private `held` flag that latched: set
  true on the first successful acquire and never cleared. `termux-wake-lock`
  exits 0 as soon as the intent reaches TermuxService, so a zero exit says
  nothing about whether the lock was taken or kept. When it later went away
  with the service, `acquire()` early-returned on the stale flag forever after
  and `operad status` kept printing `wake: held`.

  Measured on the author's device: `dumpsys power` listed exactly **one** wake
  lock, belonging to Google Messages, while the daemon had claimed to hold one
  for over a day. `com.termux` is in the Doze whitelist, so Doze was not the
  cause — there simply was no lock.

  The consequence was not cosmetic. Without a wake lock the CPU suspends, and
  `sleep` counts `CLOCK_MONOTONIC`, which does not advance across suspend — so
  the daemon's timers and `watchdog.sh`'s poll loop froze **together**. The
  watchdog was never killed; it is the same process throughout. Its 60-second
  poll became 5-10 minutes, worst case 5h43m. Over three days: **60 gaps
  totalling 933 minutes** in which a dead daemon would not have been noticed,
  with the daemon confirmed silent in 17 of 18 sampled windows.

  Now: `Platform.isWakeLockHeld()` asks the OS (Android via `dumpsys power`,
  Linux/macOS via the liveness of the inhibitor child they spawn), `isHeld()`
  reports that rather than an intention, and the health timer calls a new
  `verify()` that re-acquires a dropped lock and logs that it did. `null` means
  "cannot determine" and is never treated as "gone", so a platform without a
  check does not re-acquire in a loop.

- **`watchdog.sh` now holds a wake lock itself.** The supervisor cannot depend
  on the daemon for the conditions it needs to supervise — the daemon is the
  thing that might be dead. Acquire-only, never released.

- **The watchdog reports its own suspend gaps.** It measures wall-clock across
  each poll and logs the overshoot, which is precisely the interval during
  which a dead daemon would have gone unnoticed. That failure was previously
  invisible: the log looked healthy, just sparse.

### Changed — the dashboard's Tokens panel is interactive

- **The Tokens card now has an All time / Week / Today selector**, headline
  stats for the selected range, a daily chart, and a per-project breakdown that
  expands to individual sessions. Backed by a new
  `GET /api/token-usage?range=all|week|day`, which shares its collection step
  with `/api/tokens` so the two cannot drift.

  Deliberately built on the JSONL scan rather than the SQLite aggregates
  (`getDailyTokens`, `getWindowTokens`, `computeQuotaStatus`). Those read the
  `costs` table, which only the agent/SDK path writes — on an install that runs
  no agents it is empty, and the old expanded view rendered "No token data
  available" permanently as a result.

### Fixed — the Tokens panel was expensive and mostly empty

- **`/api/tokens` re-parsed the entire JSONL corpus on every call.** The result
  cache held 10 entries against a 28-file / 137 MB working set, so it thrashed
  100%: five consecutive identical requests measured 1.284 s, 1.578 s, 1.221 s,
  1.100 s and 1.075 s — a working cache serves the last four in milliseconds.
  Requests to `/api/status` sampled during a scan spiked from 2–4 ms to 260 ms.

  The scanner is now incremental. Claude's logs are append-only, so a grown
  file is parsed as "cached state + the appended bytes"; a shrunk one falls
  back to a full rescan. Measured against the same corpus: cold 806 ms, then
  2 ms and 1 ms. A 46.5 MB file costs 187 ms cold and 1 ms after one appended
  line, with the delta exact. Concurrent callers share one in-flight scan.

- **The panel polled every 30 s even while collapsed**, so the cost above was
  paid continuously in the background. Polling is now scoped to the open card.

- **The weekly quota display had disappeared from the dashboard entirely** —
  plan badge, weekly budget bar, velocity trend, rolling-window usage. It lived
  in `CostChart`, which became a presentational component. Restored to the
  Tokens card, and now rendered only when there is a configured limit or
  recorded usage, so an install with neither gets no dead 0 / 0 bar.

### Added

- **`operad stream` now starts the supervision watchdog when none is running.**
  The dependency only ever ran one way: the watchdog starts `operad stream`,
  but nothing started the watchdog. So when it died — or, on the author's
  device, when it had never been able to invoke the binary at all — an
  OOM-killed daemon simply stayed dead, silently, until somebody noticed.

  Guarded against the obvious hazard: watchdog.sh exports `OPERAD_WATCHDOG=1`
  before running `operad stream`, so the two cannot spawn each other without
  end. Opt out with `--no-watchdog` or `[operad] auto_watchdog = false`.
  Skipped on Windows. Verified end to end: `SIGKILL` the daemon, and the
  watchdog restarts it at its next poll (42 s measured).

### Fixed — the watchdog only worked on the author's machine

- **`watchdog.sh` hardcoded the binary as `$HOME/.local/bin/tmx`** — the
  author's dev symlink. The package's `bin` entry is named `operad` and lands
  wherever the package manager puts it, so on every install but that one the
  path did not exist: `daemon_alive` exited 127 and read as "daemon is dead",
  then `"$TMX" stream` exited 127 too, and the retry loop span on that forever.
  Harmless while nothing started the watchdog automatically — but `operad
  stream` now does, so the previous release would have left an orphaned
  looping process behind on every install that is not this one.

  The binary is resolved properly now: `$OPERAD_BIN` (which `operad stream`
  sets to the exact bundle that spawned the watchdog), then `operad` or `tmx`
  on `PATH`, then the legacy symlink, then `dist/tmx.js` beside the script.
  When none of those exist the watchdog logs why and **exits 1** instead of
  retrying something no retry can fix — the same principle the backoff was
  added for.

- **The single-instance guard silently passed on any system without `/proc`.**
  It read `/proc/$pid/cmdline` via `mapfile -d`, so on macOS — no `/proc`, and
  bash 3.2 has no `mapfile -d` — every check returned "not a watchdog" and the
  unmatched `/proc/[0-9]*` glob was tested as a literal string. The guard was
  therefore inert exactly where it was needed, and with `operad stream`
  spawning one, each invocation would have stacked another watchdog. Process
  inspection now falls back to `ps`, the scan is skipped rather than run
  against a literal glob, and neither path needs bash 4.4.

- **`daemon_alive` treated a missing `timeout(1)` as a dead daemon.** Stock
  macOS ships neither `timeout` nor `gtimeout`; the resulting 127 meant the
  watchdog would restart a daemon that was never down, on every poll. It now
  detects `timeout`/`gtimeout` and runs the check unbounded (with a log line)
  when neither is present, and `rotate_log` falls back to BSD `stat -f %z` so
  the log actually rotates there.

- **The watchdog log went to the Android path on every platform.** `operad
  stream` passes `$OPERAD_LOG_DIR` from the platform layer, so the log lands
  where `operad logs` looks for it instead of in a directory nothing reads.

- Removed a dead `SOCKET` variable, and stopped logging "attaching tmux" on the
  headless path, where it was written every poll and was never true.

### Fixed — the build could disable the watchdog

- **`dist/tmx.js` was not built executable.** It carries a
  `#!/usr/bin/env node` shebang and is the package's `bin` entry, but
  `build.cjs` never set the bit — esbuild does not, and npm only applies it to
  `bin` targets at install time, so a git checkout got whatever the umask
  allowed. Invoking a non-executable file fails with exit 126.

  `watchdog.sh` calls the binary to decide whether to restart a dead daemon,
  so a rebuild could silently disable the one mechanism that brings operad
  back after an OOM kill. It did: this machine's `watchdog.log` recorded
  **1,036,045 consecutive exit-126 retries** — roughly two months of retrying
  every five seconds, growing the log to 144 MB — while the daemon stayed
  down. The build now chmods the output, `verify-package.mjs` fails CI if the
  bit is missing, and the watchdog repairs it before retrying.
- **`watchdog.sh` retried forever at a fixed interval with no log cap.** A
  failure retrying could never fix therefore ran indefinitely. Retries now
  back off geometrically (5 s → 5 min) and the log rotates at 5 MB.
- **The watchdog could run twice at once.** Two instances both poll, both
  decide the daemon is dead at the same moment, and both run `operad stream`;
  that happened on this device. A pidfile alone could not detect it — an
  instance started before the guard existed is invisible to one — so the check
  also scans `/proc` for a sibling, matching an actual script argument rather
  than any command line that merely mentions the path.
- **`operad upgrade` reported success while leaving nothing running.** Finding
  no daemon, it printed a dimmed "nothing to restart" and exited 0 — so an
  upgrade against a daemon that had already been killed looked clean. It now
  says so plainly and names the command to start one.

### Added

- **Tool leases do something.** `createToolLease` and `hasActiveLease` had no
  production callers, so the table stayed permanently empty and the
  "goal-scoped tool permissions with usage limits" model existed only on
  paper — while `incrementLeaseUsage` was called on every tool execution,
  charging a budget nothing had granted. A lease now lets through a call the
  agent's standing `autonomy_level` would otherwise send for approval. It
  never narrows anything, so no call that worked before can start failing,
  and it cannot override `protected_tools`. The budget is charged only when
  the lease was the deciding authority, and the audit row records which
  authority allowed the call. `POST /api/leases/:agent` grants one; it
  requires `max_executions` or `ttl_seconds`, because an unbounded grant is
  what `autonomy_level` is for.

### Fixed

- **OODA cycles could run concurrently.** Three paths call `runOodaCycle` and
  none shared a guard, so two could enter at once: both built context, both
  inserted a run row, and the second was recorded as a failed run. The real
  loss was upstream — the trigger path marks its messages read *before*
  starting, so a cycle that lost the race consumed the trigger and the
  messages were never acted on, and a scheduled cycle simply vanished. Cycles
  now refuse re-entry before touching any state, the trigger checks first,
  and a scheduled cycle re-arms instead of disappearing.
- **Roundtables bypassed the quota circuit breaker.** They are the most
  expensive operation in the system — one paid run per participant, each
  reading every prior contribution, so cost is quadratic in the list — and
  were the only agent path with no quota check, so an agent whose own cycles
  were being blocked could still spend freely. Now blocked at `exceeded`.
  Participants are deduplicated and capped, the carried transcript is
  bounded, and `agents` is validated as an array of strings (a bare string
  made the engine iterate its characters).
- **Scheduled runs applied every learning twice.** They called both action
  appliers on the same response. `addLearning` dedupes by content hash, so
  the repeat did not duplicate the row — it reinforced it, so every
  scheduled-run learning was born pre-reinforced with inflated confidence and
  outranked identical learnings from other paths in
  `reinforcement_count * confidence` ordering. Merging the two appliers also
  means an OODA-cycle learning finally reinforces a matching specialization,
  which had existed in only one of the copies.
- **Chat history replay depended on undefined ordering.**
  `getConversationHistory` ordered by a whole-second timestamp alone, so every
  message of one turn tied and only happened to come out right; the caller
  then dropped "the last row" assuming it was the turn just appended. Ordering
  now has an id tiebreak and the caller excludes by id.
- **Retention now covers the last unbounded tables.** `consolidation_runs`
  (the fastest grower in practice — it ticks on a timer whether or not there
  is anything to consolidate), `costs`, and `agent_conversations`, the last by
  most-recent-N-per-agent rather than by age. `agent_trust_ledger` could not
  be pruned naively — `getTrustScore` sums the whole ledger, so an age-based
  delete would have silently demoted every agent as history aged out — so its
  pre-cutoff rows are folded into one compaction row per agent that preserves
  the sum exactly.

## [0.5.1] - 2026-08-12

A reliability release. Two independent audits — one of the transport and
persistence layers, one of the SQLite schema — plus an analysis of a live
daemon log covering 2300 hours of uptime. The log turned out to be the richest
source: several of the fixes below are for behaviour that had been broken
continuously for months without ever surfacing as an error the user would see.

### Fixed — remotely triggerable crashes

- **Two unauthenticated, single-packet ways to kill the daemon.** Both were
  evaluated before any token check and neither call site was inside a `try`,
  and the process installed no `uncaughtException` handler — so either killed
  the supervisor outright, orphaning every managed session and dropping the
  restart timers and adopted PIDs held only in memory.

      GET / HTTP/1.1\r\nHost:\r\n\r\n        → TypeError: Invalid URL
      GET /ws  +  Cookie: operad_token=%     → URIError: URI malformed

  `new URL()` rejects Host values Node's own HTTP parser accepts (empty,
  `a b`, a bare `]`), and `decodeURIComponent` throws on any malformed
  percent-encoding. The cookie path is worse than it looks: it decodes every
  cookie set for the host, including ones written by unrelated apps on the
  same loopback address, so it could also fire by accident. Request URLs are
  now built by a parser that cannot throw, undecodable cookie values are kept
  raw, the whole WebSocket upgrade listener is guarded, and an
  `uncaughtException`/`unhandledRejection` handler logs and keeps the daemon
  alive as defence in depth.

### Fixed — silently broken since before 0.5.0

- **Claude readiness detection never matched anything.** The patterns are
  `$`-anchored with no `m` flag but are tested against a whole multi-line pane
  capture, so `$` could only match the very end of the capture — and the TUI
  always draws a footer and blank lines below its input row. The current
  prompt glyph is also `❯`, not `>`. Captures from three live, idle sessions
  matched zero patterns; the daemon log shows 288 readiness timeouts against 7
  successes. Every Claude session start burned the full 60 s, and `auto_go`
  never fired at all, because `sendGoToSession` skips the send unless
  readiness is positively detected. The same `$`-without-`m` mistake is fixed
  in the OpenCode and Codex adapters.
- **A doomed `SIGCONT` retried every five seconds for seventy days.** The
  auto-resume sweep cleared `auto_suspended` only when the signal succeeded,
  which cannot happen once the session's processes are gone. One dead session
  produced 5453 warnings.
- **Health checks derived markers that could never match.** The cmdline marker
  was the first token of the startup command, so a guard-style line —
  `sh -c 'pgrep -f … || (…); cd … && exec ./run_gui.sh'` — yielded `pgrep`, a
  process that has already exited. A second config yielded `DISPLAY=:1`,
  because env-stripping ran once, before preamble-stripping. Both sessions
  were reported degraded, and restart-eligible, on every sweep while being
  perfectly healthy: 542 failures in the log. Derivation now prefers an `exec`
  target, walks the command list skipping transient steps, and returns "no
  marker" rather than one that cannot match.

### Fixed — security

- **`SameSite=Strict` does not isolate localhost, and the comment claiming it
  did was wrong.** Cookies are not port-scoped, and per RFC 6265bis the "site"
  for localhost or a bare IP excludes the port — so a page served from
  `http://localhost:3000`, i.e. any other dev server the user runs, is
  same-site with the dashboard and the browser attaches the session cookie.
  Nothing else stopped it: Origin was consulted only to decide whether to emit
  CORS headers, and almost every route parses its body regardless of
  Content-Type, so a CORS-simple request needs no preflight.
  `POST /api/send/<session>` injects arbitrary keystrokes into a live Claude
  session. Cookie-authenticated requests are now checked against the origin
  the request arrived on, port included; header and query tokens are not,
  since a cross-origin page cannot read them.
- **The IPC socket was world-connectable on Linux and macOS.** `listen()`
  applies the process umask, giving mode 0755 under the desktop default. The
  IPC surface is unauthenticated by design and includes `stop`, `shutdown`,
  `create` and `send`. Now `chmod 0600`. Termux was safe only by accident of
  Android's per-app umask.
- **The dashboard token was written in cleartext to a world-readable log.**
  `tmx.jsonl` is created by `appendFileSync` with no mode, so it is 0644 under
  a desktop umask; the tokenised URL also went to `daemon-stderr.log` and came
  back out of `GET /api/logs`. The URL is no longer logged, and both the log
  and `trace.log` are created 0600.
- **A symlink inside a project escaped the file-access gate.** Containment was
  a purely textual comparison, so a link pointing at `~/.ssh/id_rsa` passed
  and was then followed by `readFileSync`. Real paths are now resolved on both
  sides first.
- **Open redirect on the token handshake.** An absolute-form request target
  gave `url.pathname` a leading `//`, and `Location: //evil.example.com/` is a
  protocol-relative URL the browser follows off-origin.
- **A wrong `Authorization: Bearer` shadowed a valid session cookie**, so any
  proxy or browser extension injecting an Authorization header 401'd the whole
  dashboard. Every credential a request carries is now tried.
- **Unhandled errors returned `String(err)` to the client**, leaking absolute
  paths, SQL text and stack messages. The detail goes to the log.
- **`switchboard_update` merged the entire WebSocket message as a patch**, so
  any key a client invented was persisted as switchboard state.

### Fixed — data integrity

- **A failed schema creation left a permanently broken database.** `init()`
  ran roughly sixty DDL statements with no transaction, so a failure partway
  through — a SQLite build without FTS5, `SQLITE_BUSY`, a full disk — left
  half the tables present with no rollback. The caller logs one warning and
  sets `memoryDb = null`, disabling the entire memory, agent, tools, schedule,
  skills and workflow subsystem for the daemon's lifetime; the partial schema
  then made every subsequent boot fail identically. Now one transaction.
- **No `busy_timeout` was set**, so with WAL a second writer got `SQLITE_BUSY`
  immediately instead of waiting. `operad upgrade` restarts the daemon in
  place, so overlapping writers are a real scenario, and the hot write paths
  have no `try`/`catch`. Set to 5 s.
- **Corrupt `state.json` and `registry.json` were destroyed, not preserved.**
  Both loaders logged a warning, returned a default, and the next write —
  milliseconds later — overwrote the original, taking restart counts,
  autostart pins, `bound_jsonl_id` and every dynamically registered session
  with it. Writes here are atomic, so corruption always came from outside
  operad, which is exactly when the evidence matters. Both now copy to a
  `.corrupt` sibling first. The registry's version-mismatch branch hit the
  same path, so running an older operad against a newer registry wiped it.
- **The registry never validated session names on load**, despite a comment
  claiming it did. That is the one path bypassing `add()`'s runtime checks,
  and names reach tmux targets and filesystem paths.
- **IPC corrupted non-ASCII text.** Each TCP chunk was decoded independently,
  so a multi-byte UTF-8 sequence split across a chunk boundary silently became
  U+FFFD — `operad send` with any non-ASCII payload was at risk. Both server
  and client now use a `StringDecoder`.
- **`decaySpecializations` reset the clock it filtered on**, so a stale entry
  decayed exactly once and every later pass was a no-op. This install had 167
  consolidation runs, nearly all of them doing nothing.
- **A skill shipping a tool named `%` disabled every scheduled agent run.**
  Three `LIKE` patterns interpolated caller-supplied text with no `ESCAPE`.
- **Per-agent spend was under-reported.** The cost summary filtered to
  `status='completed'`, dropping runs that failed after the model had already
  produced output — cost that `completeAgentRun` deliberately preserves.
- **Tool-lease usage was charged to the wrong lease.** The selection ordered
  by `created_at DESC` with no budget filter, so a newer unscoped lease
  absorbed the charges while the capped lease stayed at zero and never
  exhausted.

### Fixed — platform and correctness

- **Static file serving was completely broken on Windows.** Containment
  compared against a hardcoded `/` prefix while `resolve()` emits `\`, so
  every asset failed the check and was rewritten to `index.html`: the
  dashboard served its own HTML shell in place of its JavaScript and CSS and
  rendered blank.
- **The database directory was a hardcoded POSIX path.** On Windows the
  database was created under `C:\Users\<u>\.local\share\operad\`, which
  nothing else on that platform looks at, so `tmx doctor` reported "No
  database yet" permanently. Both now resolve through a new
  `Platform.defaultDataDir()`.
- **PATCH request bodies were never read**, so toggling a schedule, toggling a
  workflow and saving config overrides were all dead from the browser (500,
  405 and 400 respectively). The unit tests missed it by calling the API
  handler directly and bypassing the transport.
- **`isRunning()` reported a live daemon dead.** Its HTTP fallback tested
  `resp.ok`, and a token-gated daemon answers 401 — precisely the
  socket-missing-but-alive case the fallback exists for. A false "dead"
  invites the watchdog to start a second daemon. The notification's Pause and
  Stop buttons and `operad fix-socket` were also silently unauthenticated, and
  the built-in no-dashboard status page called `/api` with no credential at
  all.
- **`?limit=notanumber` returned the entire buffer.** `Number()` gave NaN and
  `slice(-NaN)` degrades to `slice(0)`; `?limit=-5` skipped the first five
  records instead of limiting. Sixteen call sites now share a validating
  parser, and `days`, `goal_id`, `from` and `to` get the same treatment.
- **`trace.log` grew without bound** — 16 MB on this install — and
  `readTimeline` reads the whole file on every timeline request. Now rotated
  at 2 MB. `readTail` also parsed every entry in a 5 MB log to return the last
  100; the unfiltered path now parses only the tail.
- **The WebSocket server and its keepalive interval leaked on every listen
  retry.** Both were created before `listen()` could fail, so an EADDRINUSE
  retry orphaned them — and a live interval keeps the event loop referenced,
  so a daemon whose dashboard never bound would not exit on its own.
- IPC connections had no idle timeout, the 1 MB guard ran before framing (so
  one large write of many valid messages was dropped wholesale), and `stop()`
  never destroyed live connections, so `close()` could not complete.

### Fixed — carried from the previous round

- **The dashboard showed no explanation when it was locked.** The API became
  token-gated in 0.5.0 but the client had no notion of it: static assets are
  unauthenticated by design, so a browser that had not completed the handshake
  loaded the page and then 401'd on every request, rendering a wall of generic
  "HTTP 401" errors. It looked broken rather than locked. There is now an
  authentication screen naming `operad token`, with a field to paste one.
- **The Android status notification opened the dashboard without a token**, so
  its own Dashboard button led to that same wall of errors. The URL now carries
  the token and goes through the normal handshake.
- **ADB operations targeted the wrong phone.** `isLocalAdbDevice()` answered
  "yes" whenever exactly one device was online — "single device: must be this
  device". That is untrue: a phone running operad in Termux with one other
  handset attached over wireless debugging has exactly one ADB device, and it
  is the other one. Confirmed on the author's setup, where operad runs on an
  SM-S938U1 while the sole ADB device is a Saga — so the phantom-process fix
  was being applied to, and the process list read from, a different phone.

  Identity is now established by comparing `/proc/sys/kernel/random/boot_id`,
  which is world-readable (unlike `ro.serialno`, empty to unprivileged callers
  since Android 10, and `/proc/uptime`, denied to apps) and unique per boot per
  machine. The check fails **closed**: if identity cannot be established the
  answer is no, because acting on an unknown device is worse than skipping the
  optimisation.

  `GET /api/processes` now returns `{ apps, adb }` rather than a bare array, so
  the UI can say which device it is talking to. When the target is not this
  machine the app list is empty and the panel explains why instead of showing
  another phone's processes with a working kill button beside each row.

## [0.5.0] - 2026-08-12

A security and correctness release. Four independent audits covered the skill
marketplace, the agent/cognitive subsystem, workflow/tools/scheduling, and
session lifecycle/monitoring; this is the result of working the findings in
severity order.

### Breaking

- **The dashboard API now requires a token and binds `127.0.0.1`.** Run
  `operad token` for the URL. Set `[operad] bind = "0.0.0.0"` to expose it on
  the network — still token-gated. The wildcard CORS header is gone; use
  `[operad] allowed_origins` if a foreign browser origin genuinely needs access.
- **Workflow `needs: [a, b]` now means AND, not OR.** A node with several
  incoming edges runs only when all of them fire. Set `join: "any"` on the node
  for the old fan-in behaviour. The previous reading meant a deploy node ran
  after its test dependency had failed.
- **`adb.enabled` now defaults to the platform's ADB capability** rather than
  `true` everywhere. Set it explicitly to drive a phone from a desktop.
- **`GET /api/customization-file` serves only `.md`/`.markdown`/`.txt`**, and
  `POST /api/customization/import` requires `Content-Type: application/json`.
- **A project's `.claude/agents/*.json` no longer replaces a builtin or enables
  it implicitly** — it merges, and only an explicit `enabled` changes the flag.
- **Agent-state import rejects `mode: "replace"`** instead of silently merging.
- Snapshot filenames now carry a time (`YYYY-MM-DDTHHMMSS`). Existing
  date-only files are still readable.

### Security

- Dashboard API authentication (Jupyter-style token → `SameSite=Strict`
  cookie), loopback default bind, origin allowlist, and a gated WebSocket
  upgrade — previously an unauthenticated side door onto the same command
  surface.
- Shell injection closed in `grep-search`, `diff-files`, `notify` and the tmux
  capture. `JSON.stringify` produces *double* quotes, and sh still expands
  `$( )`, backticks and `$VAR` inside those. The first two are `analyze` and
  the tmux one is `observe` — all auto-approved at every autonomy level, so an
  ostensibly read-only tool was arbitrary code execution.
- The autonomy gate is now enforced. `isAutoApproved` existed and was never
  called from anywhere, so `allowed_tool_categories`, `autonomy_level` and
  `protected_tools` only affected what the prompt advertised.
- `isAllowedPath` no longer admits the whole home directory. `file-read`
  (auto-approved everywhere) could read `~/.claude.json`, `~/.npmrc`,
  `~/.netrc` and `~/.git-credentials`; `file-write` could append hooks to
  `~/.claude/settings.json` or a `[[tool]]` block to operad's own config.
- Package names reaching `adb shell` are validated — the remote argv is
  re-parsed by the device's shell, so argv separation locally is not enough.
- ADB app control asserts a local target; with a second phone attached,
  memory pressure force-stopped apps on it.

### Fixed — destructive behaviour

- `operad cleanup` ran `pkill -9 -f` with patterns guessed from the session
  command, including `chromium.*--type=` and `xfce4-session` — killing every
  Chromium renderer or the whole desktop. Patterns are now opt-in per session
  and each PID is signalled individually so the daemon can exclude itself.
- The boot sweep killed the user's `crond`. It counted `[crond]` zombies and
  ran `pkill -9 crond`; a zombie cannot be signalled, so the only thing it
  could kill was the live daemon. Removed.
- A failed memory or battery read no longer reads as an emergency. Missing
  fields defaulted to 0 — "no memory left" and "flat battery" — which SIGSTOPped
  every idle session on a 5s timer with no recovery, and turned off wifi and
  mobile data.
- Memory shedding skips sessions with an attached tmux client and never
  suspends a tree containing the daemon itself.
- Adopted PIDs are verified before signalling; a stale entry could
  `SIGTERM` an unrelated process group after PID reuse.

### Fixed — correctness

- Cron day-of-month/day-of-week now follows POSIX. `0 9 * * 1` fired *every
  day*, so weekly agent schedules burned 7× the tokens.
- Scheduled runs are no longer re-entered while still executing, transient
  deferrals (SDK busy, quota) no longer count toward auto-disable, and
  `upsert` returns the right id.
- Workflow task timeouts work: tasks run in their own process group and the
  promise settles on the timeout instead of waiting for pipes a backgrounded
  grandchild holds open.
- A duplicate workflow edge no longer deadlocks its target while the run
  reports success.
- Auto-restart timers are cancellable and re-validate before firing; they were
  killing sessions the user had just started.
- Adopted agent sessions no longer fail health on every sweep and spawn a
  second agent in the same directory.
- Snapshots are restorable (`POST /api/agents/<name>/restore`), no longer
  overwrite same-day copies, and `pruneSnapshots` no longer deletes files it
  did not create.
- Agent-state import replays strategies oldest-first (the active one was the
  oldest), dedupes on re-import, and honours `prefer_import`.
- Tool execution no longer blocks the daemon's event loop.
- History tables are pruned on a daily cadence; none had any retention.

### Added

- `operad token`, `POST /api/agents/<name>/restore`, `GET /api/env`,
  `GET /api/skills/search` (+ `skill.search` IPC and `operad skill search`).
- Environment migration: `GET /api/customization/export` /
  `POST /api/customization/import` carry document content and marketplace
  sources, with a "Migrate environment" section in Settings.

### Platform

- Windows: project-path keys mangle `\` and the drive colon, so per-project
  memories resolve; the two marketplace suites now run there instead of being
  skipped.
- macOS/Windows: process liveness goes through the platform layer. `/proc`
  checks always answered "dead", so adopted sessions flapped permanently.
- Off-Android hosts no longer run a doomed ADB connect script on every boot.

## [0.4.9] - 2026-08-10

### Fixed — skill marketplace hardening

- **GC leaked uninstalled skills forever.** The retain floor (keep the 3 most
  recent versions per provider+locator) counted tombstoned rows, so a skill
  whose versions were *all* uninstalled was fully protected: never marked,
  never swept, cache dir and DB row retained indefinitely. Four such rows were
  found on a real machine. Tombstones no longer consume retain slots; the floor
  still protects the newest live versions.
- **GC pin gate never fired after an uninstall.** Pass-2 reached
  `skill_generation_refs` through `skill_active_version`, which
  `markUninstalled` deletes — so the subquery returned nothing, `NOT EXISTS`
  was trivially true, and the cache dir was deleted while consumers still held
  live pins on that generation. The generation is now recorded on the `skills`
  row (new `skills.generation` column, migrated automatically) and survives
  tombstoning.
- **GC could delete a cache dir Claude Code was using, on Windows.** The
  settings.json reference check hardcoded `cacheDir + "/"`, so on Windows —
  where both sides use backslashes — it never matched. Both sides are now
  resolved and separator-normalised.
- **`operad-curated` integrity check did nothing.** The response digest was
  computed and then only embedded in an error message, never compared, while
  the module comment claimed it stopped a CDN substituting a tampered index. It
  could not have worked as written: the pinned value is a *git commit* SHA, not
  a body hash. `OPERAD_CURATED_INDEX_SHA256` now pins the exact sha256 and is
  enforced (constant-time), and the comments describe the real guarantee.
- **`mcp-official` treated an overridden registry as trusted.** Setting
  `OPERAD_MCP_OFFICIAL_REGISTRY_BASE_URL` disables the hostname guard and the
  SPKI pin, yet `trustTier()` still returned `"trusted"` — so any host could
  become a trusted-tier install source, at the highest autonomy ceiling. An
  override that does not point at the official host now yields `"escape"`. The
  unpinned-TLS fallback finally emits the warning the module header promised,
  and an overridden base URL must still use https.
- **Node installs could not use any skill shipping `operad.toml`.** The parser
  was gated behind `globalThis.Bun`, with a comment claiming a fallback was
  "inlined at the end of this file" — there wasn't one. The published bundle's
  shebang is `#!/usr/bin/env node`, so on node every skill carrying tools,
  agents, workflows or MCP servers failed to install. The minimal TOML parser
  is now shared via `src/toml.ts`.
- **A failed install could block every tool call until restart.**
  `installInProgress` was set ~65 lines above its `try`/`finally`, so a throw
  from `trustTier()`, `getActive()`, `beginGenerationTransaction()` and others
  skipped the reset and latched `TOOL_BLOCKED_BY_ACTIVE_INSTALL` permanently.
  The flag now lives in a thin wrapper around the install body.

## [0.4.8] - 2026-08-07

### Fixed — first run on a clean machine (Ubuntu/WSL)
- **`operad init` generated an invalid config.** The template emitted
  `command`/`cwd`, but the parser requires `type`/`path`, so the first
  `operad boot` died with `session[0]: 'path' is required for type
  'claude'`. It also used two `[operad]` keys that do not exist (`port`,
  `log_level`). The generated config is now session-free — a fresh install
  boots on the first try — with a commented example showing the real
  schema.
- **`operad doctor` green-lit configs the daemon would reject.** The
  `config` check only looked for a section header. It now runs the same
  parser and validator the daemon runs at boot, and reports each error with
  the correct key names.
- **The published npm tarball contained no dashboard.** `dashboard/dist/`
  was listed in `package.json#files`, but the publish workflow only built
  the esbuild CLI bundle, so `operadic@0.4.7` shipped **6 files** and every
  install reported "Dashboard dist not bundled". The workflow now builds
  the dashboard and `scripts/verify-package.mjs` hard-gates publishing on
  tarball completeness (**52 files**). CI runs the same check per PR, and
  the fresh-install job asserts the globally installed package has a
  dashboard.
- **WSL is detected by `operad doctor`** — reports WSL1's unreliable
  `/proc` process accounting, a missing `notify-send` (notifications
  silently no-op), and the WSL2 NAT that makes the reported LAN address
  unreachable from other devices, with the `netsh portproxy` fix.
- **CLI colour output respects TTY/`NO_COLOR`/`FORCE_COLOR`.** Redirecting
  or piping (`operad doctor > out.txt`) no longer embeds ANSI escapes.

### Security
- **Arbitrary file read via `GET /api/customization-file`.** The read path
  had no extension filter while the write path did, so anything under
  `~/.claude/` was readable — including `.credentials.json` (the Claude
  OAuth token), `settings.json`, and `history.jsonl`. Because the dashboard
  binds `0.0.0.0` with `Access-Control-Allow-Origin: *` and no auth, any
  LAN host or visited web page could exfiltrate those credentials. Reads
  are now restricted to `.md`/`.markdown`/`.txt` and dotfiles are refused.
- **Path traversal + arbitrary recursive delete in the skill installer.**
  `version` flowed unvalidated into `join(cacheParent, version)`, which is
  `rmSync`'d recursively before cloning, so `../../../../etc` escaped the
  cache and deleted the target *before* the clone failed. Now validated as
  a single path component.
- **Git argument injection in the skill installer.** The locator was passed
  as a positional `git` argument with no scheme check, allowing the `ext::`
  transport (arbitrary command execution) and `-`-prefixed option
  injection. The transport allow-list is now enforced at the provider
  boundary that REST and IPC both use, not just in the CLI helper.
- **Version pins were silently ignored.** `<url>@v1.2.3` installed `latest`
  whenever the caller passed the default version — which the dashboard
  always does.

### Added
- **Environment migration between machines.** `GET
  /api/customization/export` builds a versioned, self-contained bundle of
  skills, commands, agents, plans and memories **with file content**, plus
  plugin marketplace sources and MCP server entries. `POST
  /api/customization/import` applies it, with `dry_run`, `overwrite`,
  per-collection selection and a per-item report. Settings gains a
  "Migrate environment" section driving both. The previous per-section
  exports emitted file *paths* only and had no importer at all, so they
  could not migrate anything. Import registers plugins for Claude Code to
  install rather than cloning repos itself, rewrites `installLocation` to
  local paths, and drops redacted (`***`) MCP secrets instead of writing
  them as credentials.
- **Skill marketplace is enabled by default** via `[skills] enabled` in
  `operad.toml`. It was previously gated behind `--enable-skills-preview`,
  a flag `operad stream` never forwarded to the daemon it spawns — making
  the feature unreachable through every normal boot path.
- **Directory-form skills are now visible.** The scanner only matched flat
  `*.md`, missing the `<name>/SKILL.md` layout used by plugin-installed and
  symlinked skills — roughly half the skills on a typical setup were absent
  from the UI and from exports.
- Skill marketplace and environment-migration REST endpoints are now
  documented in `docs/api.md` (the `/api/skills*` and `/api/tool-autonomy`
  routes were previously undocumented).
- **Autostart pins (⭐) for sessions.** Each session row in the dashboard
  gets a star toggle that pins/unpins it for auto-boot. The choice is
  persisted in `state.json` (`autostart_overrides`) and applied over the
  recency/TOML-resolved `enabled` flag on the next daemon boot, so the
  autostart set is now an explicit, trackable handle instead of being
  inferred from recency — fixing the "120 inactive projects all look the
  same" confusion. New `SessionState.autostart` wire field,
  `POST /api/autostart/<name> { enabled }` REST route, `autostart` IPC
  command, and `operad autostart <name> [on|off]` CLI. Closing a session
  clears its pin.
- **Prompt Library: tap to expand.** In the home-page library, tapping a
  prompt row now expands its clamped two-line preview to the full text
  (and tap again to collapse) — no need to open the conversation just to
  read a long prompt.
- **Roadmap doc** — `docs/roadmap.md` enumerates every v1.1+ skill
  marketplace deferral with spec back-references (IPC/REST/CLI gaps,
  provider queue, deferred MCP lifecycle modes, supply-chain hardening,
  Operit-pattern follow-ups, dashboard mobile-pass list).
- **`tmx skill events [--limit=<n>]`** — CLI mirror of the existing
  `GET /api/skills/events` REST endpoint, exposes the install/update/
  uninstall timeline including `autonomy_clamp` cascade entries.
- **Dashboard cap-downgrade retry path** — `SkillManagerPanel` now
  catches `PROVIDER_TIER_DOWNGRADE` on install and offers an inline
  retry with `accept_cap_downgrade`, matching the existing
  `TOOL_HAS_ACTIVE_CONSUMERS` retry UX on uninstall. `installSkill()`
  API gains the `accept_cap_downgrade` option.

### Fixed
- **Test-suite hardening surfaced and fixed several real defects** while
  raising coverage from ~50% to ~70% lines (279 → ~1700 tests):
  - `memory-db.deleteExpired()` returned an inflated count — the `memories_fts`
    sync trigger makes bun:sqlite report the FTS5 shadow-table cascade
    (one deleted memory → ~7 changes). Now returns the true logical count.
  - `memory-db.getSessionCosts` / `getDecisionQualityTrend` ordered only by
    `created_at`, which is non-deterministic for same-second rows; added
    `id` tiebreakers so "most recent first" and the trend split are stable.
  - `tools.isAllowedPath()` resolved home via `os.homedir()`, which caches its
    first value process-wide and ignores later `$HOME` changes; now reads
    `$HOME` (homedir fallback) so the path gate honours a relocated home.
  - `telemetry-sink` SDK inference: the `/OneCollector` path rule was
    unreachable (path is lower-cased before matching) and the general aria
    host rule shadowed the specific `self.events.data.microsoft.com`
    OneCollector rule; rules reordered/lower-cased so both classify correctly.
- **Scripts run from the dashboard no longer fail with `/usr/bin/env: bad
  interpreter` (gradle exit 126).** A build script launched from the
  dashboard "Run script" tab (e.g. cleverkeys `build-on-termux.sh`) died
  dashboard "Run script" tab (e.g. cleverkeys `build-on-termux.sh`) died
  with `./gradlew: /usr/bin/env: bad interpreter: No such file or directory`,
  while the same script run from an interactive Termux shell succeeded. Root
  cause: the TermuxService execute intent runs the generated wrapper WITHOUT
  Termux's default `LD_PRELOAD`, so `libtermux-exec.so`'s `/usr/bin/env →
  $PREFIX/bin/env` shebang rewriting was absent and the Android kernel can't
  resolve `/usr/bin/env`. The wrapper (`buildRunTabWrapper`, Android) now
  re-exec's itself once with `LD_PRELOAD` set (guarded by `_TMX_LD_REEXEC`),
  so the re-exec'd copy starts with libtermux-exec.so loaded — restoring
  shebang rewriting for the target script's own `#!/usr/bin/env …` line AND
  every descendant (the `./gradlew` grandchild). Covers ad-hoc commands,
  `package.json`, root/scripts/saved sources alike. Regression +
  end-to-end-validated in `run-tab-wrapper.test.ts`.
- **`operad stream` no longer reports a spurious "IPC request timed out"
  after a reboot.** Root cause: `AndroidEngine.fixAdb()` ran the ADB
  connect via synchronous `spawnSync`, freezing the daemon's single event
  loop for the entire connect. After a reboot the stale ADB endpoint
  stretched that to ~2.5 minutes, during which the daemon could serve no
  IPC — so the CLI's 90s `stream` send timed out even though boot
  succeeded. The connect now runs via async `spawn` (bounded by the same
  `timeout` wrapper + a SIGKILL backstop), keeping the loop responsive so
  IPC and `operad status` work throughout the connect. Regression test in
  `android-adb.test.ts` asserts the loop isn't blocked during a slow
  connect.
- **Session action buttons no longer wrap to a second line.** The autostart
  ★ pin moved out of the action cluster to the right edge of the name cell,
  so the lifecycle buttons (stop / restart / go / pause …) stay on one row.
- **Prompt Library "open" now shows the conversation for any project —
  even ones with no running session — and scrolls to the prompt.** The
  viewer loads history directly by project path + `session_id` (new
  `?path=` mode on `/api/conversation`) instead of spawning a session,
  then pages back to the anchored prompt and highlights it. The drawer's
  prompt input is roomier (multi-line, scrollable) and supports slash
  commands; when the project has a live session it sends there, otherwise
  it shows a read-only "start this project to reply" hint instead of a
  dead input.
- **Prompt Library "open" arrow targets the right conversation.** The
  open-conversation arrow now passes the prompt's originating Claude
  `session_id` through to the conversation viewer, so it loads the exact
  historical conversation the prompt came from instead of the project's
  most-recently-active one.
- **Two operad sessions sharing a project path no longer cross-load
  conversations.** A live-JSONL binder runs each monitoring poll: for any
  project with 2+ running claude sessions it pairs each session to the
  distinct conversation it created (resumed sessions → their resume id;
  fresh `cc` sessions → the conversation that began at/after the session
  started, matched in start order). The binding is sticky, persisted in
  `state.json` (`bound_jsonl_id`), and surfaced as `SessionState.session_id`
  so the conversation drawer opens each session's own conversation — even
  two fresh `cc` instances of the same project. Lone sessions stay unbound
  and follow the project's most-recent conversation as before.
- **Sessions table separators align.** The `Session` and actions cells no
  longer set `display:flex` directly on the `<td>` (which dropped the cell
  out of table-row height sync and stepped the collapsed border-top);
  the flex layout moved to inner wrappers so every row's horizontal rule
  is a single straight line.
- **No more dead `--resume` on a missing conversation.** The Claude
  runtime adapter now verifies the bound `session_id`'s JSONL exists on
  disk before emitting `claude --resume <id>`; a stale id (resumed on
  another machine, pruned history) falls back to a fresh `cc` instead of
  leaving the pane at a "No conversation found" error.
- **REST `POST /api/skills/install`** now plumbs `accept_cap_downgrade`
  through to `SkillManager.install`, so the dashboard and other REST
  callers can recover from `PROVIDER_TIER_DOWNGRADE`. Previously the
  field was silently dropped. Status codes broadened to 409 for the
  full set of recoverable gating refusals
  (`TOOL_HAS_ACTIVE_CONSUMERS`, `TOOL_NAME_CONFLICT`,
  `WORKFLOW_NAME_CONFLICT`, `AGENT_NAME_CONFLICT`,
  `MCP_NAME_USER_OWNED`, `MCP_OWNED_BY_OTHER_DAEMON`,
  `PROVIDER_TIER_DOWNGRADE`, `AUTONOMY_CAP_VIOLATION`) so clients can
  distinguish retry-with-flag from "your payload is wrong".

- **Skill marketplace Phase C — concurrent installs via generation
  discipline.** The coarse `INSTALL_BLOCKED_BY_ACTIVE_CONSUMER` gate
  is replaced by per-generation shadow tool maps. When an OODA cycle
  / scheduled run / workflow / REST call holds a ConsumerTracker
  pin, the install transaction creates generation N+1 in parallel,
  atomically swaps the live pointer on commit, and leaves generation
  N resident until the pin releases. The background GC sweeper drops
  unreferenced generations + their tool maps on the next interval.
  ToolExecutor gains beginGenerationTransaction / commitGeneration /
  abortGeneration / pruneGeneration; ConsumerTracker.acquire() returns
  a PinHandle carrying the snapshotted generation; long-running
  callers pass `pin.generation` to `toolExecutor.execute(..., gen)`
  so concurrent installs don't tear the registry under their run.
  Cross-tier re-install rule: stricter tier clamps the cap + requires
  `--accept-cap-downgrade` if any tool's current bucket would exceed
  the new cap; cascade is recorded under
  `skill_events.detail.kind = autonomy_clamp`. New typed errors:
  `PROVIDER_TIER_DOWNGRADE`. `OPERAD_CURATED_INDEX_URL_TEMPLATE` env
  var lets mirrors / local file paths replace the GitHub raw URL.
  4 crash-injection tests added in `skills-crash.test.ts` validate
  the §3.15 5-store rollback contract under fault injection at
  fetch + read; 263 tests total (was 256). End-user docs in
  `docs/skills.md` updated with the new concurrent-install
  guarantee.

- **Skill / plugin marketplace (preview)** — multi-source aggregator
  for installing bundles of tools, agents, workflows, MCP servers, and
  SKILL.md context. Four day-1 providers: `git+url` (escape tier),
  `claude-marketplace` (`anthropics/*` → trusted, others → community),
  `mcp-official` (trusted; HTTPS to `registry.modelcontextprotocol.io`
  with optional SPKI pin), `operad-curated` (trusted; commit-SHA-pinned
  static index, disabled-by-default until a known-good SHA is committed).
  Authors publish a Claude-Code plugin repo with an optional
  `.operad/operad.toml` sidecar — the adapter merges them. Per-tool
  autonomy caps enforce a source-tier ceiling
  (`AUTONOMY_CAP_VIOLATION` on over-promotion). Uninstall runs a lease
  cascade against tool_leases + agent_schedules
  (`TOOL_HAS_ACTIVE_CONSUMERS`, `--force-revoke` to override). Install
  gates on a daemon-wide ConsumerTracker (OODA cycles, scheduled runs,
  workflow runs all acquire pins). Five-store install transaction
  (SQLite + cache + `~/.claude.json` + `~/.claude/settings.json` +
  in-memory registries) with reverse-order rollback on partial
  failure. Behind `--enable-skills-preview` daemon flag in this
  release; promoted to default-on after the dashboard panel + docs
  ship. New CLI: `tmx skill add|remove|list|info`,
  `tmx tool autonomy list|set`. New REST: `/api/skills`,
  `/api/skills/install`, `/api/skills/<id>/uninstall`,
  `/api/skills/events`, `/api/tool-autonomy`. 53 new tests (251 total
  was 206). Full design spec at
  `docs/superpowers/specs/2026-05-20-skill-marketplace-design.md`;
  end-user docs at `docs/skills.md`.
- **Workflow DAG engine** — new `[[workflow]]` TOML section defines DAG task pipelines (`[[workflow.task]]` entries with `id`, `command`, optional `cwd` / `timeout_s` / `needs` / `on`). Engine implements adjacency-list + in-degree topology with DFS cycle detection and Kahn's-algorithm execution; edge `on` semantics (`success` default, `error`, `always`) gate downstream nodes with skip-propagation. Three new SQLite tables (`agent_workflows`, `agent_workflow_runs`, `agent_workflow_run_nodes`) persist definitions + run history. REST: `GET / POST / DELETE / PATCH /api/workflows[/<name>]`, `POST /api/workflows/<name>/run`, `GET /api/workflows/<name>/runs`. Default `TaskRunner` is `child_process.spawn` with timeout + abort signal; the interface is pluggable so tests inject deterministic fakes. Algorithm adopted (in spirit) from Operit's `core/workflow/WorkflowExecutor.kt`, trimmed to operad's needs — ConditionNode/LogicNode/ExtractNode deferred (operad workflows feed shell commands which already branch via exit-code edges). 15 new tests in `src/__tests__/workflow.test.ts`.
- **Doctor: `git`, `adb`, `sqlite` probes** — `operad doctor` now warns if `git` is missing (branch/commit display will be empty), fails if `[adb] enabled = true` in config but `adb` isn't on PATH (would otherwise hang boot for `connect_timeout_s`), and fails if no SQLite driver is loadable (bun:sqlite when running under bun, otherwise better-sqlite3, otherwise tells you to install bun or rebuild better-sqlite3). The sqlite probe is dual-runtime aware — if doctor runs under node but bun is on PATH, it knows the daemon will spawn under bun and reports OK.
- **Termux:API circuit breaker logs** — when 3 consecutive `termux-api` calls time out the breaker opens for 30 s and silently dropped calls. It now logs a structured `warn` line on open ("dropping all termux-api calls until service recovers") and an `info` line on close ("service responsive again"). Throttled to once per minute so a sustained outage doesn't spam logs.
- **Off-Android `/api/bridge` fast-fail** — every CFC bridge endpoint now returns HTTP 501 with a useful explanation when operad isn't on Termux/Android, pointing users at the Claude for Chrome extension instead of letting the binary search fumble through Termux-shaped paths. Dashboard surfaces the remediation hint inline in the CFC card.
- **Multi-runtime support** — `[[session]] type` now accepts `"opencode"` and `"codex"` alongside `"claude"`. New `SessionRuntime` adapter interface in `src/runtimes/runtime.ts` defines the shape (id, label, startup command, ready patterns, optional timeout/poll override); claude/opencode/codex adapters live next to it. Lifecycle code in `session.ts` dispatches via `getRuntime(type)`, so adding a fourth agent is purely an adapter file. Gemini CLI is intentionally not supported — its stateless one-shot model doesn't fit operad's persistent-session orchestration. 13 new tests in `runtimes.test.ts` pin the adapter contract and per-runtime startup-command semantics.
- **Doctor: per-runtime binary probes** — when `operad.toml` references `type = "opencode"` or `type = "codex"` for any session, doctor now probes `<bin> --version` and emits a fail with platform-specific install hint when the binary's not on PATH. Mirrors the adb probe so first-run users see a clear actionable error instead of a silent boot failure when their agent CLI isn't installed.
- **Dashboard runtime badge** — session rows render an inline `OPENCODE` / `CODEX` chip next to the session name when those runtimes are in use. Subtle accent colours (purple for OpenCode, cyan for Codex). Hidden on the default Claude case so the row stays uncluttered.
- **Config overrides JSON overlay** — new `config-overrides.json` overlay at `<state_dir>/` lets the dashboard's Settings form persist SDK Defaults (effort/thinking/max_budget/model) and quota thresholds without touching the user's TOML. Atomic write via temp-file-then-rename. New `GET /api/config-overrides` and `PATCH /api/config-overrides` endpoints; daemon merges the overlay into SdkBridge config at boot. Settings → SDK Streaming gains a Save button + status line; ten new tests in `config-overrides.test.ts` lock the contract.
- **Multi-runtime config tests** — `config-state.test.ts` extended with parser-level tests covering opencode/codex types, missing-path rejection for agent runtimes, and unknown-type rejection.
- **Memory promotion** (Kai-inspired) — agent context now pins a separate "Core Knowledge" section above the rotating Accumulated Knowledge list. `MemoryDb.getCoreAgentLearnings()` returns the top-N learnings ranked by `reinforcement_count × confidence` with hard floors (default ≥ 3 reinforcements AND ≥ 0.7 confidence). Promoted ids are skipped from the regular list to avoid duplication.
- **Governance dashboard panel** (`GovernancePanel.svelte`) — new Settings section 11 surfaces four agent-governance endpoints that previously had no UI: per-agent **Trust** scores + ledger history, active **Tool Leases** with revoke-all, persistent **Schedules** CRUD (cron + interval, enable/disable, delete), **Consolidation** runs with last-run timestamp + run-now button.
- **Plans aggregation panel** (`PlansPanel.svelte`) — User / Current Project / All Projects tabs with JSON download, mirroring the existing Skills/Hooks/Commands/Subagents/Memories layout. Closes the gap where project-scoped plans were not visible across projects.
- **CLAUDE.md aggregation panel** (`ClaudeMdPanel.svelte`) — same three-tab structure. Memory snapshots (under `~/.claude/projects/{mangled}/memory/*.md`) keep the existing `memory` badge.
- **Agent run output persistence** — `agent_runs` table extended with `prompt`, `response_text`, `thinking_text` columns (idempotent migration via `PRAGMA table_info` introspection). Standalone runs, chat, OODA cycles, roundtables, and scheduled runs all now persist what the agent actually said. New `GET /api/agents/runs/{id}` endpoint returns the full body; the list endpoint serves a 280-char `response_preview` plus `has_more_response` / `has_thinking` flags to keep payloads bounded.
- **Agent panel runs tab** — clicking a run reveals the full prompt (collapsed by default), response text, optional thinking text behind a toggle, and any error. Existing runs from before the migration show as "No response text captured (run may pre-date v0.4.8)".
- **Inactive-session sort + grouping** (`SessionTable.svelte`) — inactive sessions split into **Registered** (defined in `operad.toml`) and **Ad-hoc** subsections, with Registered always on top. New chronological/alphabetical sort toggle (chronological default — recently-active sessions float to the top via `uptime_start` desc, `last_health_check` fallback). Backend now emits `from_config: boolean` per session; older daemons that omit it fall through to the Ad-hoc bucket.
- **`tmx open --new` + GUI "Open another instance"** — Recent Projects rows gain a `+` button next to running/registered entries that posts `?new=1` to `/api/open/<path>`. Default Open button now reuses any existing entry for the same path.
- **`tmx dedupe [--dry-run]` + GUI Dedupe** — collapses duplicate registry/config entries that share a path. Live tmux sessions are never torn down — only stale duplicates are removed. Dashboard exposes a two-step preview-then-apply flow.
- **`launch_package` session field + dashboard launch button** — TOML `[[session]]` blocks can declare an Android package. Session row gains a launch icon that fires the user-facing activity via ADB monkey (preferred) with `am start -n <pkg>/.MainActivity` fallback.
- **Date column + copy-session_id button** in Recent Projects rows.
- **159 tests** (was 87) — new `session-commands.test.ts` (cmdOpen reuse + dedupe + force_new) and `state-transitions.test.ts` (auto-generated coverage of every legal/illegal pair in `VALID_TRANSITIONS`).

### Fixed
- **Governance → Consolidation history showed "undefined" in every count column.** `getConsolidationHistory()` did `SELECT *` on the persisted `consolidation_runs` table (which uses the legacy column names `learnings_reviewed` / `syntheses_created`) and cast the rows as the modern `ConsolidationResult` interface (`learnings_decayed` / `cross_pollinated`). The cast lied silently. Now the read path explicitly remaps legacy → modern, mirroring the inverse mapping the INSERT path has done since v0.4.4. Regression test pinned in `consolidation.test.ts` so the column drift can't recur.
- **MCP and Plugins "Download JSON" buttons rendered the literal text `\u2913`** instead of the ⤓ glyph. Svelte mustaches `{...}` evaluate JS escapes, but bare HTML text content does not — the two earliest header buttons used the unwrapped form. Replaced with the literal character.
- **SessionCard slim**: the expanded session detail's PID/Restarts/Health/Activity/RSS/Started/Error grid duplicated almost everything already shown in the row header (RSS, activity dot, restart count) and the PID column was always "—" because tmux_pid is null on this state path. Trimmed to Health + Started, with Error appearing only when present. Wrapped in a tighter card to stop long error strings overflowing on phones.
- **Action button column clipped on phone viewports.** With the recent 44 px touch-target bump, six action icons no longer fit the desktop-sized 8.5 rem actions column. `.td-actions` is now `display:flex; flex-wrap:wrap; justify-content:flex-end` and the mobile media query drops the column to width:auto, so 6+ buttons reflow to a second line instead of clipping past the table edge. The `.td-expand` cell also gains `max-width:100%; overflow-x:hidden; box-sizing:border-box` plus a `:global(>*)` rule so child components can't punch out the cell width.
- **tmux `=name` exact-match targets** — every `tmux -t <name>` call across `session.ts`, `memory.ts`, `platform/android.ts`, `rest-handler.ts`, and the TermuxService attach script now uses tmux's `=name` exact-match sigil. Without it, `has-session -t foo` matched `foo-2`, which (a) made `sessionExists` lie when suffixed siblings existed, (b) silently routed `kill-session`/`send-keys` to the wrong session, and (c) made `tmx dedupe` misclassify dead canonical entries as live conflicts. 15 call sites fixed; names are validated `[a-z0-9-]+` so prefixing `=` is always safe.
- **`session_id` shell-injection hardening** — registry entries are user-modifiable on disk; the `session_id` field used to be interpolated raw into `claude --resume <id>` over `tmux send-keys`. Now strict UUID-validated on registry load AND at the consumption site. `isValidSessionId()` exported for future call sites.
- **Bare-session `pidAliveCheck` cmdline match** — PIDs are recycled on busy systems; `kill(pid,0)` alone kept dead bare services looking healthy after their PID had been reused. Each check now also reads `/proc/<pid>/cmdline` and demands a marker token derived from the session's spawn command. Best-effort — non-Linux platforms quietly fall back to liveness-only.
- **Touch targets ≥ 44 px on phone viewports** (`@media (max-width: 640px)` in `app.css`). SessionTable rows pack 6–7 icon buttons each; at 28 px they were untappable on a finger pointer.
- **`tmx upgrade` on npm/bun installs** detects the install path and shows ONE matching upgrade command instead of dumping both.

### Deferred
- **SDK + quota config knobs in Settings** — the SDK Defaults form already exists in the dashboard but its `bind:value` targets a `$state` object with no save endpoint, and there's no daemon-side config-mutation surface (TOML writer or runtime override layer). Persisting these from the UI needs that mutation surface designed first; reopen when it lands.

## [0.4.7] — 2026-04-20

Customization aggregation extended beyond hooks and skills. Adds slash commands, subagent definitions, memories, and the cross-tool `AGENTS.md` file (Claude Code + Codex + OpenCode compat). Every type supports User / Current Project / All Projects tabs with JSON download.

### Added
- **Slash commands** (`.claude/commands/*.md`) — new `CommandsPanel.svelte` with User / Current Project / All Projects tabs.
- **Subagent markdown files** (`.claude/agents/*.md`) — new `SubagentsPanel.svelte` for Claude Code's agent registry files.
- **Memories** (`.claude/memories/*.md`) — new `MemoriesPanel.svelte` for user-authored context notes.
- **`AGENTS.md` cross-tool compat** — new `AgentsMdPanel.svelte` with a `consumers` badge row showing which tools read each file (Claude Code, Codex, OpenCode). Subtle info banner links to [agents.md](https://agents.md).
- **Backend**: `/api/customization` response extended with `commands[]`, `agentsMd[]`, `memories[]`, `agentsMdFiles[]`. `/api/customization/all-projects` response extended with the same fields in `user` + per-`projects[]` entries.
- **`$HOME/AGENTS.md`** and **`<project>/AGENTS.md`** added to the file-read/write allowlist.
- **`docs/customization.md`** — new doc explaining what operad scans, where each file lives, and which tools consume it.
- **`docs/api.md` § Customization** rewritten with complete response shapes.

### Notes on OpenCode + Codex
operad surfaces `AGENTS.md` as a first-class cross-tool file — read by Claude Code, Codex, and OpenCode alike. Operad itself still runs tmux sessions; the new view is about making the user's multi-tool config visible in one place. Future work: start sessions targeted at `codex` / `opencode` runtimes and route to the correct tool's config paths on boot.

## [0.4.6] — 2026-04-20

This release focuses on bundle size, real fresh-install proof, runtime hardening, and a hooks/skills aggregation view in the dashboard.

### Added
- **`operad watch`** — live session status in the terminal. Polls the daemon once per second in an alt-screen buffer with color-coded state, uptime, RSS, activity, restart count. Ctrl+C restores the main screen and exits.
- **Dashboard Hooks panel** (`HooksPanel.svelte`) — three tabs (User / Current Project / All Projects), tables with event / matcher / command / timeout columns, and a per-tab "Download JSON" button. Fixes "per-project hooks don't display" and gives a way to export hooks.
- **Dashboard Skills panel** (`SkillsPanel.svelte`) — same three-tab structure for skills.
- **`/api/customization/all-projects`** — new endpoint returning hooks + skills + plans aggregated across every known project (enumerated from Claude's `history.jsonl` via `parseRecentProjects`).
- **Platform-aware `checkTmux()` fix message** — Windows users now see `operad install-tmux` and winget guidance instead of apt/brew/pkg text.
- **CI job `fresh-install-ubuntu`** — removes tmux, installs operadic from packed tarball (simulating `npm i -g operadic`), runs `operad install-tmux -y`, asserts `tmux -V` works, then runs `operad init` + `operad doctor`. First real proof the install story works on a truly fresh machine.
- **CI job `fresh-install-windows`** — asserts `operad install-tmux` (non-interactive path) and `operad doctor` both emit winget guidance.
- **IPC fuzz tests** (`src/__tests__/ipc-fuzz.test.ts`) — 10 scenarios covering malformed JSON, partial messages, binary garbage, concatenated messages, unicode. Confirms the existing 1 MB buffer cap holds.

### Changed
- **Bundle size**: `dist/tmx.js` reduced from **692 KB → 369 KB (-47%)** via esbuild minification with `keepNames: true` (stack traces stay readable).
- **`@anthropic-ai/claude-agent-sdk` moved** from `dependencies` to `optionalDependencies`. Already external in the bundle; this removes the install footprint for users who don't use agentic features.
- **Dashboard visual polish** — consistent typography scale, restored mono font on paths/previews, better spacing in SettingsPanel tables, design-token cleanup in HooksPanel + SkillsPanel. No feature changes.
- **GitHub Actions**: `actions/checkout@v4 → v5`, `actions/setup-node@v4 → v5` across all workflows. Removes the Node.js 20 deprecation warning.

### Fixed
- **SSE backpressure**: slow clients with >1 MB of buffered output now get dropped via `res.destroy()` instead of leaking memory. Max 50 concurrent SSE clients (new connections over cap get 503).
- **`operad doctor` on Windows with `FAIL tmux`** now mentions winget (`arndawg.tmux-windows`) and routes to `operad install-tmux`.

## [0.4.5] — 2026-04-20

### Added
- **Windows tmux install via winget** — `operad install-tmux` and `operad init` now prefer `winget install -e --id arndawg.tmux-windows` on Windows 10 1809+ / Windows 11 (where winget is pre-installed). Falls back to `scoop` then `choco` if on PATH, then MSYS2 manual instructions if no package manager is found.
- **Claude for Chrome extension check** in `operad doctor` on Linux/macOS/Windows — heuristically detects a Chromium-based browser (Chrome, Chromium, Edge, Brave) and surfaces the [extension install URL](https://chromewebstore.google.com/detail/claude-for-chrome/mhlfhmbeohhnidmkdpjmaflpcnhfchck). Warns if no browser detected. This is the desktop equivalent of the Android CFC bridge.

### Changed
- Windows `doctor.ts` tmux-missing fix message now recommends `winget install -e --id arndawg.tmux-windows` when winget is present, before falling back to MSYS2.
- `docs/cfc-bridge.md` now documents the desktop (Chrome extension) path alongside the Android (bridge + Edge Canary) path.

## [0.4.4] — 2026-04-19

### Added
- **`operad install-tmux`** — new CLI command. Detects the platform's package manager (`pkg` on Termux, `brew` on macOS, `apt`/`dnf`/`pacman`/`zypper`/`apk` on Linux) and runs the install with `sudo` when needed. Prompts on TTY; falls through to printed instructions on non-interactive invocations. Windows routes to the MSYS2 install page.
- **`operad init` now offers to install tmux** after writing the config. Keeps the fresh-install flow to a single prompt.
- **`operad boot`/`stream` offers install before forking the daemon** — if tmux is missing and stdin is a TTY, prompts with the platform's package manager command; declines or non-TTY fall through to a clean error.
- 4 new unit tests for pkg-manager detection + availability check.

### Changed
- `operad init` help line clarifies the new flow (config → tmux prompt → run doctor/boot).

## [0.4.3] — 2026-04-19

### Fixed (P0)
- **Daemon silently boots with no tmux**: `Daemon.preflight()` now hard-fails with a multi-platform install hint (`apt`/`brew`/`pkg`/MSYS2). Previously the daemon would start, sessions would silently never boot, and the dashboard looked healthy.
- **`TMUX_BIN` frozen at module load**: Resolved on first call instead — fixes wrong path when tmux is installed late on PATH (MSYS2 on Windows, late Termux pkgs).
- **`operad doctor` dashboard fallback** pointed at `~/git/operad/dashboard/dist` (a developer's local checkout). Removed; npm-installed users now get the correct fix instruction (`bun add -g operadic@latest`).

### Fixed (P1)
- **`bunx operadic` (no args)** now prints help instead of `Daemon not running. Start with: operad stream`.
- **`operad init` template** uses Windows-friendly paths (`%APPDATA%\operad` config dir on Windows; `pathJoin` for the `cwd` example).
- **`operad upgrade`** refuses cleanly on npm installs (no `build.cjs`) with a hint to use `bun add -g operadic@latest` instead of crashing.
- **`migrate.ts`** generated config no longer hardcodes `~/git/termux-tools/tools/adb-wireless-connect.sh` for `connect_script` (was a developer-specific path); empty default now.
- **`/api/bridge` 404 on missing claude-chrome-android**: Previously wrote a startup script pointing at a non-existent file and silently failed via TermuxService intent. Now returns `{ status: 404, fix: "bun add -g claude-chrome-android" }` immediately.
- **Windows `notify()` PowerShell injection** via session-name interpolation. Title and content now passed via env vars (`OPERAD_NOTIFY_TITLE`/`OPERAD_NOTIFY_CONTENT`) — no string interpolation in the heredoc.
- **`isTmuxServerAlive()` swallowed ENOENT**: now writes a stderr diagnostic so a missing tmux is visible.
- **OrchestratorContext.memoryDb / sdkBridge** captured by value at constructor time when both were `null`. Engines reading them post-init saw stale `null`. Converted to lazy getters (`getMemoryDb()` / `getSdkBridge()`); all 6 consumer files updated.

### Added
- **`operad doctor`**: two new Android-only checks
  - `cfc-bridge` — searches global bun + npm install paths for `claude-chrome-android`; warns with install command when missing
  - `edge-canary` — `pm list packages com.microsoft.emmx.canary`; warns with install hint when missing
- **`peerDependenciesMeta`** declares `claude-chrome-android` as an optional peer so `bun i -g operadic` surfaces it
- **`docs/cfc-bridge.md`** — explains what CFC is, install paths, Edge Canary requirements, troubleshooting

### Changed
- **`scripts/fix-android-binaries.mjs`** silent on non-Android (was logging confusing `[fix-android-binaries] Not on Android, skipping.` during every `npm install` on Linux/Mac/Windows)
- Postinstall tries `bun add` before `npm install` for the android-arm64 esbuild binary

## [0.4.2] — 2026-04-19

### Fixed
- **npm publish workflow ENEEDAUTH** — `setup-node@v4` was writing an empty `_authToken=` line to `.npmrc` whenever the (unset) `NPM_TOKEN` secret was referenced. This blocked OIDC trusted-publisher auth. Removed the env var; OIDC now works.
- **Workflow npm version too old for OIDC** — bumped runner to node 24 which ships npm ≥ 11.5.1. Node 22 ships npm 10.x which silently falls back to token auth.
- **README missing from npm tarball** — `package.json` `files` array now explicitly includes `README.md`, `CHANGELOG.md`, `LICENSE`.

## [0.4.1] — 2026-04-19

### Fixed
- **Daemon boot crash**: `loadAutoStopList()` was called in the `Daemon` constructor before `androidEngine` was instantiated, causing "Cannot read properties of undefined (reading 'loadAutoStopList')" on every boot. v0.4.0 users hitting this should upgrade. Discovered by newly-robust e2e test.
- **E2E test silent false-positives**: `src/__tests__/e2e.test.ts` previously used `describe.skipIf(!daemonReady)` + per-test `if (!daemonReady) return` which made every test "pass" when the daemon couldn't start. It now throws in `beforeAll` with full stderr capture if the daemon isn't ready within 20s. Uses a random high-range port and an explicit hermetic config.

### Added
- 30+ new unit tests across three files:
  - `session-resolver.test.ts` — fuzzy name matching, path resolution
  - `config-state.test.ts` — `validateConfig` error shape, `migrateState` idempotency
  - `cli-smoke.test.ts` — `operad --version/init/doctor` exit codes + output format

## [0.4.0] — 2026-04-19

### Added
- `operad doctor` command — diagnoses install issues with colored checklist
- `operad init` command — generates minimal config on fresh install
- `operad switchboard reset` command — resets autonomous feature toggles to new opt-in defaults
- `/help` documentation page in dashboard (core features + agentic layer docs)
- Help links on Switchboard toggles pointing to `/help` anchors
- End-to-end CI test (boots daemon, exercises REST endpoints + dashboard pages)
- First-run CI smoke job (`operad init` + `operad doctor` on fresh HOME)
- API-drift CI check — fails PRs that modify `src/http.ts`/`src/ipc.ts`/`src/rest-handler.ts` without updating `docs/api.md`
- Full REST/SSE/IPC API documentation (`docs/api.md`)
- Full config reference (`docs/config.md`)
- Windows platform support (experimental) — `WindowsPlatform` using `%LOCALAPPDATA%\operad` for state/logs/socket; process info via `tasklist`; battery via WMI; requires MSYS2 tmux or WSL. See `docs/windows.md`.

### Changed
- **BREAKING DEFAULT**: Autonomous features (`cognitive`, `oodaAutoTrigger`, `mindMeld`) now default `false` on fresh installs; all 4 builtin agents default `enabled: false`. Existing installs preserve their settings; a one-time notice on first boot after upgrade explains the change.
- Config validation now prints structured errors with fix instructions and exits 1 on failure
- README restructured: core daemon leads, agentic is opt-in advanced section
- **Architecture: daemon.ts split from 6,523 lines → 1,480 lines (-77%)** across 12 focused modules:
  - `rest-handler.ts` (REST API dispatch) + `src/routes/` (customization, mcp, scripts, adb route handlers)
  - `ipc-handler.ts` (IPC command routing)
  - `ws-handler.ts` (WebSocket message dispatch)
  - `agent-engine.ts` (OODA loop + agent chat + executeOodaActions + scheduled runs)
  - `session-commands.ts` (20 cmd\* IPC command handlers)
  - `android-engine.ts` (ADB + phantom-process fix + auto-stop list + app mgmt)
  - `monitoring-engine.ts` (memory/battery polling + SSE push + status notification)
  - `persistence.ts` (memory consolidation + daily snapshots)
  - `tool-engine.ts` (ToolContext builder)
  - `session-resolver.ts` (pure name/path/open-target resolution + boot-session selection)
  - `orchestrator-context.ts` (shared DI interface, now split into 6 documented sub-interfaces)

### Fixed
- Silent catch blocks in daemon.ts audited — 28 blocks now either have justification comments or emit structured `log.warn`/`log.error`
- `operad doctor`: state dir path corrected to `$HOME/.local/share/tmx` on Android (was mistakenly `$PREFIX/var/lib/tmx`)
- `operad doctor`: Termux probe switched from `termux-info` (always present) to `termux-battery-status` (actually from `termux-api` package)
- `checkDashboard()` uses `realpathSync(__filename)` matching symlink resolution pattern in `tmx.ts`
- SessionController's `restartDelayMs` option was accepted but never applied — now enforced between stop+start in health-failure handling
- Switchboard reference drift: `ctx.switchboard` replaced with `ctx.getSwitchboard()` getter so engines see current state after `updateSwitchboard` replaces the object
- `restartCount` now resets to 0 after a successful restart (was monotone — could mark long-running sessions failed after N successful recoveries over hours)
- State-machine transitions enforced via `VALID_TRANSITIONS` table; invalid transitions log warnings instead of silently succeeding

### Removed
- Dead-infrastructure: `src/session-controller.ts` and its 11 tests. The class was extracted with a design that couldn't cleanly integrate with production. `VALID_TRANSITIONS` in `types.ts` is the real state-machine contract.

## [0.3.0] — 2026-04-15

### Added
- SvelteKit 2 dashboard (migrated from Astro 5)
- Plans management in Settings (view/edit .claude/plans/ files)
- Unit test suite (bun test) — deps, cognitive parser, consolidation
- CHANGELOG.md

### Changed
- Dashboard framework: Astro 5 + Svelte 5 → SvelteKit 2 + Svelte 5
- Adapter-static output to `dist/` (unchanged serving path)

## [0.2.0] — 2026-03-01

### Added
- Platform abstraction layer (Android/Linux/macOS)
- Token quota management (weekly limits, velocity tracking)
- Agentic AI system: 4 built-in agents with OODA cognitive loop
- Agent chat with replay-based multi-turn conversations
- Goal trees, decision journal, strategy versioning
- Memory consolidation engine (decay, prune, merge, cross-pollinate)
- Tool registry with autonomy levels and trust calibration
- Persistent scheduling engine (cron/interval, SQLite-backed)
- Agent state export/import with daily snapshots
- Specialization registry and roundtable protocol
- MCP server management (CRUD via dashboard)
- Plugin marketplace integration
- Conversation viewer with live streaming
- Session timeline events
- Prompt history with search and starring
- Telemetry sink monitoring
- Process manager (Android app kill/force-stop)
- Switchboard for subsystem enable/disable
- Mind meld user profile system
- Cognitive panel (goals, decisions, strategy, messages, growth)

### Changed
- Config section renamed from `[orchestrator]` to `[operad]` (backwards compatible)
- CLI renamed from `tmx` to `operad`

## [0.1.0] — 2025-12-01

### Added
- Initial release
- tmux session orchestration
- TOML configuration with env var expansion
- Health checks and auto-restart
- Web dashboard (Astro + Svelte)
- System memory monitoring
- Battery awareness
- Dependency-ordered boot
