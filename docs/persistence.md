# Crash Resilience on Termux/Android

How operad keeps tmux sessions running continuously on a device whose OS is
actively trying to stop them.

There are **two independent failure domains**, and surviving one says nothing
about surviving the other:

| Domain | What kills you | What saves you |
| ------ | -------------- | -------------- |
| **App death** — Android reaps `com.termux` | `ActivityManager` `kill -9`s every PID in the app's cgroup | Being in a *different* app's cgroup ([The model](#the-model)) |
| **Process death** — lmkd/OOM kills the daemon itself | Memory pressure; the daemon is a fat Node process | Something noticing and restarting it ([The supervision loop](#the-supervision-loop)) |

The first is structural: get it right once at install time and it holds. The
second is a live control loop, and a control loop can fail *silently* — which
is the harder problem, and the one most of the second half of this page is
about. It can also be killed outright by the same pressure that killed what it
was watching, in which case nothing is left running to notice
([When the watchdog goes too](#when-the-watchdog-goes-too)).

> **Each section states what has actually been observed on real hardware.**
> Every "this happened" here is measured, not hypothesised; the numbers come
> from the author's Samsung device.

## The model

This section corrects the older "PPid:1 = independence" framing. The actual
load-bearing property is **which APK's process spawns the daemon**, because
that determines its Android app cgroup. PPid:1 detachment alone is not enough
on Android 12+.

Android places every process spawned by an app into a unified cgroup:

```
/sys/fs/cgroup/apps/uid_<UID>/pid_<APP_LAUNCH_PID>/cgroup.procs
```

Two facts about this:

1. **Two APKs that share a UID get separate cgroups**, keyed on each APK's own
   launch PID. `com.termux` (PID X) and `com.termux.boot` (PID Y) live in
   `pid_X` and `pid_Y` respectively, even though both run as `u0_a364`.
2. **When `ActivityManager` reaps an app**, it iterates that app's
   `cgroup.procs` file and `kill -9`s every PID listed. Reparenting to init
   (PPid=1) does not move a process out of the cgroup.
3. **But the cgroup outlives the app process that created it.** That sweep is
   what an app *kill command* does — a force-stop, a package kill — not what a
   routine cached-process or lmkd kill does. `com.termux.boot` exists only to
   run its `BootReceiver` and goes empty immediately afterwards: measured here,
   it exec'd the watchdog at 19:50:58 and was itself killed six seconds later
   (`reason=13 (OTHER KILLS BY SYSTEM) subreason=3 (TOO MANY EMPTY PROCS)`).
   The daemon it had started ran for another **7 d 17 h**. So the spawn-root
   APK does not need to stay alive — which is the only reason booting from a
   receiver works at all.

Detached children with PPid=1 still appear in the launch cgroup of the app
that spawned them. So if `com.termux` spawns the daemon, the daemon dies with
`com.termux`. If `com.termux.boot` spawns it, the daemon survives `com.termux`
death untouched, because nothing reaps `pid_<termux.boot launch PID>`.

## What survives Termux death — and what doesn't

| Daemon spawn-root              | Survives `com.termux` death? |
| ------------------------------ | ---------------------------- |
| `com.termux.boot` (BootReceiver via `Runtime.exec`) | **Yes**       |
| `com.termux` shell (`operad stream` typed in a tab)  | No            |
| `com.termux.tasker` Termux:Tasker plugin            | No (delegates back to `com.termux` RunCommandService) |
| `com.termux.widget` Termux:Widget shortcut          | No (same delegation)          |
| `am startservice → com.termux/.app.RunCommandService` | No (runs in `com.termux`)   |

**Only Termux:Boot escapes**, because its `BootReceiver` calls
`Runtime.getRuntime().exec()` from inside its own process — which means script
children inherit `com.termux.boot`'s cgroup. Every other entry point ultimately
runs scripts inside `com.termux`'s `RunCommandService`.

## The bootstrap chain

```
device boot  →  BOOT_COMPLETED broadcast  →  com.termux.boot/.BootReceiver
                                                  │
                                              Runtime.exec(~/.termux/boot/startup.sh)
                                                  │   (in com.termux.boot's cgroup)
                                                  ▼
                                            watchdog.sh loop
                                                  │
                                              operad stream
                                                  │
                                              spawn(daemon, { detached: true }); child.unref()
                                                  │   (PPid=1, but still in com.termux.boot's cgroup)
                                                  ▼
                                              daemon  →  tmux server  →  Claude sessions
```

Once the daemon is running in `com.termux.boot`'s cgroup it stays there
until that cgroup is torn down. `com.termux` can be killed and relaunched
by Android any number of times; the daemon and tmux are unaffected. Reopening
a Termux terminal tab does an `attach` to the existing tmux server.

## What breaks the chain

- **The boot symlink (`~/.termux/boot/startup.sh`) is missing or dead.**
  `BootReceiver` runs but has nothing to exec, so no daemon ever lands in
  the right cgroup. Manual `operad stream` from a Termux shell will then put the
  daemon in `com.termux`'s cgroup, where it dies with the app on the next
  Termux crash.
- **The daemon process tree in `com.termux.boot`'s cgroup is fully terminated**
  (e.g., a phone reboot, an overzealous memory sweep, or a `pkill -f watchdog`).
  After that point only the next BOOT_COMPLETED broadcast can re-create the
  process tree in the right cgroup; `operad stream` from a terminal cannot.

  And that broadcast cannot be faked without root — it is a protected
  broadcast, so `am broadcast -a android.intent.action.BOOT_COMPLETED` fails
  with `SecurityException: Permission Denial … uid=2000`. A tree rebuilt from a
  terminal therefore runs in `com.termux`'s cgroup, exposed to **both** failure
  domains, until the next reboot. Worth knowing before deciding whether a
  restart is "fixed".

If you find sessions are no longer surviving Termux crashes, check:

```sh
readlink -f ~/.termux/boot/startup.sh                         # must point at a real script
cat /proc/$(pidof -s com.termux)/cgroup | rg apps             # note the pid_<X>
cat /proc/$(pgrep -f 'tmx.js daemon')/cgroup | rg apps        # if pid_<X> matches above, the daemon will die with Termux
```

A daemon in the same `pid_X` bucket as `com.termux` is a daemon that won't
survive the next app death.

## Defensive layers (still useful, but secondary)

Even with the right spawn-root, operad applies a stack of ADB-driven
protections to reduce the rate at which `com.termux` itself gets killed.
These are applied by `applyPhantomFix()` in `src/android-engine.ts` during
boot, via `fixAdb`:

1. **Phantom process killer disabled.** Android 12+ kills background processes
   when an app exceeds 32 children. `device_config put activity_manager
   max_phantom_processes 2147483647` neutralises the limit.
2. **Doze whitelist** for `com.termux` and `com.microsoft.emmx.canary`.
   `cmd deviceidle whitelist +<pkg>`.
3. **Active standby bucket** via `am set-standby-bucket <pkg> ACTIVE`.
4. **Background run permission** via
   `cmd appops set <pkg> RUN_ANY_IN_BACKGROUND allow`.
5. **OOM score adjustment** writing `-200` to `/proc/<termux_pid>/oom_score_adj`.
   On Android 14+ the adb shell uid no longer has permission to write another
   app's `oom_score_adj`; this command silently fails on those builds. Use
   `operad doctor` to verify whether the value actually took. Measured on
   Android 17 / One UI 9 (SDK 37, `S938U1UEUCDZIF`): still rejected — the value
   reads back as `200`, so **this layer is inert on current builds**.
6. **Set-inactive false** via `cmd activity set-inactive <pkg> false`.

`operad doctor` reads all six back from the device. It resolves an ADB serial
and passes `-s` explicitly: a bare `adb shell` fails with "more than one
device/emulator" as soon as a second target is attached, and the gate in front
of these checks used to fail the same way and report *"ADB not connected"* —
skipping every one of them while eight devices were connected and the local one
was reachable over loopback. It also confirms the target is *this* device by
comparing `/proc/sys/kernel/random/boot_id`, and skips rather than report
another handset's protection state as ours.

These reduce the *probability* of `com.termux` being killed under memory
pressure. They do not prevent it. When the app does eventually die, the
spawn-root cgroup is what determines whether the daemon goes with it.

All six target `com.termux` itself. Nothing applies them to the daemon, the
watchdog or the tmux server: those are not app processes, so
`ActivityManager` does not manage their `oom_score_adj` at all — each inherits
one at fork and keeps it for life.

## The supervision loop

Correct spawn-root keeps the daemon out of `com.termux`'s blast radius. It
does nothing about lmkd killing the daemon directly under memory pressure,
which on Android is the *normal* way it dies. That is `watchdog.sh`'s job.

```
watchdog.sh  ── every 60 s, or at once on SIGWINCH ──▶  operad status
                                     │
                        ┌────────────┴────────────┐
                    responds                  no response
                        │                          │
                  (nothing to do)           operad stream  ──▶ daemon
                                                                  │
                                                          re-adopts the existing
                                                          tmux server + sessions
```

tmux is the reason this works at all: the tmux **server** is its own process and
outlives the daemon. A restarted daemon re-adopts the running sessions rather
than recreating them, so an OOM kill of the daemon costs supervision, not work.

**What starts the watchdog:**

- `com.termux.boot` at device boot, via `~/.termux/boot/startup.sh` (a symlink
  to `watchdog.sh`) — the only path that lands in the right cgroup.
- `operad stream`, which spawns one if none is running. The dependency used to
  run only one way — the watchdog started the daemon, but nothing started the
  watchdog — so a watchdog that died stayed dead. Guarded by `OPERAD_WATCHDOG=1`
  so the two cannot spawn each other without end; opt out with `--no-watchdog`
  or `[operad] auto_watchdog = false`.

Only one runs at a time. The check is a pidfile *plus* a `/proc` scan, because
an instance started before the guard existed is invisible to a pidfile — which
is exactly how two ended up running here for weeks, both polling and both
restarting the daemon.

Both the shell guard and the TypeScript side match an argv **element** whose
basename is `watchdog.sh` or `startup.sh`, never the pattern anywhere in the
command line. A plain `pgrep -f watchdog.sh` also matches the shell running
that very pgrep, an editor with the file open, or a tool wrapper that mentions
the path — all of which would be reported as a live watchdog.

### Waking it early

A 60-second poll is fine for noticing a death nobody asked for. It is the wrong
latency for a restart someone is waiting on — `operad upgrade` shuts the daemon
down deliberately and then waits for the watchdog to bring it back.

`watchdog.sh` therefore traps **SIGWINCH** and ends its current sleep, so the
next `operad status` check runs immediately. Measured on this device: the poll
drops from 60 s to ~1 s.

SIGWINCH specifically, because its default action is **ignore**. The sender
cannot know whether the watchdog it found predates the handler — a long-lived
boot watchdog keeps executing the script bash parsed at launch, so an updated
`watchdog.sh` on disk proves nothing about the running process — and any signal
that defaults to *terminate* would kill the one process able to restart the
daemon. Verified both ways: an old-style script survives SIGWINCH and dies on
SIGUSR1. A genuine terminal resize also raises it, which at worst costs one
extra status check.

The nudge is best-effort. `operad upgrade` sends it and then waits up to 90 s —
one full poll interval plus daemon startup — so a watchdog that ignored it
still succeeds, just slower. It previously waited 20 s, which is shorter than
the poll, and so reported *"Watchdog didn't restart daemon within 20s"* for
restarts that had not been attempted yet and landed unattended moments later.

> A signal only helps if the target can receive it. A watchdog spawned from a
> process with a blocked signal mask inherits that mask and will not see
> SIGWINCH. Check with `rg -i SigBlk /proc/<pid>/status`: a healthy one here
> reads `0000000080010000`. Every process spawned by Claude Code's Bash tool
> carries `fffffe00dffbfeff` (nearly everything blocked), and a tmux **server**
> started from such a session passes that mask to everything it forks — so a
> watchdog started via `tmux new-session` on this box is deaf to the nudge and
> falls back to its poll.

### Four ways the watchdog silently stops working

Each of these has happened on real hardware. The common shape: **the watchdog
process is still alive, so everything looks fine, but it is not supervising.**

**1. It cannot invoke the binary.** `dist/tmx.js` carries `#!/usr/bin/env node`,
and Termux has no `/usr/bin/env`. Termux's exec shim rewrites that at `execve`
time — but only when it was `LD_PRELOAD`ed into the process *doing* the exec,
and the dynamic linker reads `LD_PRELOAD` once, at process start. Exporting it
from inside a running script therefore does nothing for that script's own
`execve`. Booting from Termux:Boot happened to work only because the login
environment had already loaded the shim into bash.

The watchdog now probes at startup and falls back to naming the interpreter
(`node <bundle>`), which sidesteps the shebang entirely. It logs which form it
chose.

Related: a missing executable bit gives exit **126**. `build.cjs` chmods the
bundle, `verify-package.mjs` fails CI without it, and the watchdog repairs it
before retrying — because a rebuild that dropped the bit once disabled
supervision for **two months**, logging 1,036,045 consecutive failures into a
144 MB file while the daemon stayed down.

**2. The device suspends.** This is the subtle one, and the most damaging.

Without a wake lock the CPU suspends. `sleep` counts `CLOCK_MONOTONIC`, which
**does not advance across suspend** — so the watchdog's 60-second poll silently
becomes 5, 10, or 340 minutes. The daemon's own timers freeze identically,
because they are the same clock on the same suspended CPU. Nothing crashes;
supervision just stops happening, and the logs look healthy, merely sparse.

Measured here before the fix: **60 gaps totalling 933 minutes of blind
supervision over three days**, worst single gap 5h43m, with the daemon
confirmed silent in 17 of 18 sampled windows. A daemon dying at the start of
such a window would not be noticed until it ended.

**3. The wake lock is lost and nothing re-takes it.** `termux-wake-lock` exits 0
as soon as the intent reaches TermuxService — that says nothing about whether
the lock was taken, or kept. It goes away when that service restarts, with
nothing reported.

`WakeLockManager` used to gate on a flag that latched: set once on first
success, never cleared. So a lost lock was permanent, and `operad status`
printed `wake: held` for a lock the OS did not have. This device ran that way
for over a day while `dumpsys power` listed exactly one wake lock — belonging
to Google Messages.

Now:

- `Platform.isWakeLockHeld()` asks the OS (Android via `dumpsys power`;
  Linux/macOS via the liveness of the `systemd-inhibit` / `caffeinate` child).
  `null` means "cannot determine" and is never read as "gone".
- `isHeld()` reports that rather than an intention, so `wake: held` is a fact.
- The health timer (`health_interval_s`, default 120 s) calls `verify()`, which
  re-acquires a dropped lock and warns that it did.
- **`watchdog.sh` holds a lock independently.** The supervisor cannot depend on
  the daemon for the conditions it needs in order to supervise — the daemon is
  the thing that might be dead.

> When reading `dumpsys power`, match **only** the active `Wake Locks: size=N`
> block. The wake-lock *event history* further down retains tags for days after
> release, so a whole-output match reports "held" forever once a lock has ever
> existed. Both the shell and TypeScript checks got this wrong initially.

Acquire-only, always: `termux-wake-unlock` gets processes killed.

**4. It cannot be signalled, including to shut down.** bash defers a trapped
signal until the current **foreground** command finishes. The poll was a plain
`sleep 60`, so for up to a minute the process ignored every signal sent to it —
`trap ... WINCH` never fired, and neither did the `TERM` handler. Measured here:
`kill <watchdog>` returned 0 and the process kept running for **19 seconds**
before dying, which reads as a wedged supervisor.

The fix is to background the sleep and wait on it — the `wait` builtin *is*
interruptible, returning 128+n and then running the trap:

```sh
sleep "$want" &
SLEEP_PID=$!
wait "$SLEEP_PID" 2> /dev/null
```

This is what makes both the SIGWINCH wake and prompt shutdown work; before it,
the wake signal would have been correct in principle and inert in practice.

### When the watchdog goes too

The four modes above share a shape: the watchdog is alive and not supervising.
The fifth is the opposite, and the supervision loop has no answer to it — the
watchdog is **killed by the same memory pressure that killed the daemon**.

Measured here on 2026-11-03:

```
dumpsys activity exit-info com.termux
  timestamp=2026-11-03 12:35:56.943 pid=23832 process=com.termux
  reason=3 (LOW_MEMORY) subreason=0 (UNKNOWN) state=empty rss=32MB
```

lmkd killed 13 app processes in that one second and 33 within 20 s;
`com.termux.api` went 391 ms before `com.termux`. The daemon, the watchdog and
the **tmux server** all stopped in the same window: the watchdog's last
half-hourly heartbeat was 12:12:19, the one due around 12:42 never arrived, and
the next line in the log is a fresh startup at 14:00:39. That is **85 minutes
unsupervised** — and because the tmux server died too, the restart recreated
every session instead of re-adopting it, which is the one cost the design
exists to avoid.

Three things about it are worth keeping:

- **Correct cgroup placement did not help.** `com.termux.boot` has no exit
  record for that day, so the spawn-root cgroup was intact. The tree was in it
  — started by Termux:Boot a week earlier, log line *"direct exec unavailable
  — no exec shim in this process"* — and died anyway. Domain 1's defence is
  not a defence against domain 2.
- **A low `oom_score_adj` was not protection either.** The daemon, watchdog and
  tmux server all read `0`, the *least* killable tier, inherited at fork and
  never updated, while `com.termux` itself read `200`. Under a critical sweep
  that margin ran out.
- **Nothing attests which killer it was.** `exit-info` records app processes
  only, so a dead daemon leaves no entry; the candidates are lmkd's last-resort
  tier and the kernel OOM killer. The operational conclusion is the same
  either way: the supervisor is exactly as killable as the thing it supervises,
  and the only things that can replace a dead watchdog are the next
  BOOT_COMPLETED and the next `operad stream` — which in this scenario means a
  human, because the daemon that would otherwise spawn one is dead as well.

The usable signal is the **rate**, not the event. `dumpsys activity exit-info`
persists across reboots — back to February 2025 on this device — so the trend
is readable at any time. (It is a bounded ring *per package*, so counts for
older days drift downward as new deaths evict them. Read it for shape, not for
exact history.)

```sh
/system/bin/dumpsys activity exit-info > "${TMPDIR:-$PREFIX/tmp}/exit.txt"
awk '/timestamp=/{d=substr($0,index($0,"timestamp=")+10,10)}
     /reason=3 \(LOW_MEMORY\)/{c[d]++} END{for(k in c) print k,c[k]}' \
  "${TMPDIR:-$PREFIX/tmp}/exit.txt" | sort | tail -14
```

Daily LOW_MEMORY kills on this device: **1–30** throughout 2025, ~25/day in
early October 2026, ~140/day by the end of that month, then 207 → 291 →
**1263** on the day the daemon died. It survived a week of *bad* days and died
on the one that was 9× worse. No change inside operad moves that number; the
lever is how many heavyweights run at once — here two Gradle daemons at 1.5 GB
combined plus seven Claude sessions at ~370 MB each, against 11.4 GB of usable
RAM and a device whose swap was already 4 GB deep.

## Recovery primitives

- **Watchdog respawn.** `watchdog.sh` polls `operad status` every 60 s and runs
  `operad stream` when it does not answer. Retries back off geometrically
  (5 s → 5 min) so a failure retrying cannot fix costs one line every five
  minutes rather than every five seconds, and the log rotates at 5 MB.

  This is **not** unconditionally functional — see the four failure modes
  above. It requires an invokable binary, an awake CPU, and a poll that can be
  interrupted. An earlier version of this page listed it as "always
  functional", which was wrong. It also requires the watchdog to still exist,
  which under memory pressure is not given
  ([When the watchdog goes too](#when-the-watchdog-goes-too)).
- **Deliberate restart.** `operad upgrade` rebuilds, stops the daemon, and lets
  the watchdog restart it on the new bundle — running tmux sessions stay up
  throughout, because the tmux server is not what restarted. It signals the
  watchdog to re-check immediately rather than waiting out the poll
  ([Waking it early](#waking-it-early)). With no watchdog running it restarts
  the daemon directly instead.
- **Suspend self-reporting.** The watchdog measures wall-clock across each poll
  and logs the overshoot, which is exactly the interval in which a dead daemon
  would have gone unnoticed. It also logs state changes plus a half-hourly
  heartbeat rather than two lines per poll, so a gap is visible instead of
  buried.
- **IPC socket self-healing.** When `$PREFIX/tmp/` gets cleared but the daemon
  is alive, the CLI probes `http://localhost:18970/api/fix-socket` and the
  daemon recreates the unix socket. Round-trip < 1s.
- **Crash-safe trace log.** `appendFileSync` on every trace event with no
  open FD, so a SIGKILL'd daemon doesn't lose recent state.

## Verifying it actually works

Liveness is not evidence. Check the properties, not the process list:

```sh
WDLOG=~/.local/share/tmx/logs/watchdog.log   # Android; elsewhere .../operad/logs/

# 1. Is a wake lock genuinely held? (the ACTIVE block only — not the history)
/system/bin/dumpsys power | awk '/^Wake Locks: size=/{f=1} f{print} /^$/{if(f)exit}'

# 2. Has the device been suspending out from under supervision?
rg "SUSPENDED|Wake lock not held" "$WDLOG" | tail

# 3. Is the daemon in a cgroup that survives Termux death?
cat /proc/$(pidof -s com.termux)/cgroup | rg apps
cat /proc/$(pgrep -f 'tmx.js daemon')/cgroup | rg apps   # must NOT match above

# 4. Exactly one watchdog, and can it invoke the binary?
#    Confirm each candidate by its argv, not by the -f pattern: `pgrep -f
#    watchdog.sh` also matches the shell running that pgrep.
for p in $(pgrep -f 'watchdog\.sh|startup\.sh'); do
  tr '\0' '\n' < /proc/$p/cmdline | awk -v p=$p '{n=$0; sub(/.*\//,"",n)}
    n=="watchdog.sh" || n=="startup.sh" {print p; exit}'
done
rg "Supervising via|code=12[67]" "$WDLOG" | tail -3

# 5. Can it receive the wake signal? (blocked-mask watchdogs fall back to
#    the 60s poll — see "Waking it early")
rg -i SigBlk /proc/$(cat "${TMPDIR:-$PREFIX/tmp}/operad-watchdog.pid")/status

# 6. Has the whole tree been killed and rebuilt at some point? Every
#    "Supervising via" line is a NEW watchdog. One carrying "no exec shim in
#    this process" came from Termux:Boot (right cgroup); one without it came
#    from a terminal (wrong cgroup — see "When the watchdog goes too").
rg -n 'Supervising via' "$WDLOG" | tail -5
```

Two Termux notes on the above: `dumpsys` needs its absolute path, because
`/system/bin` is not on Termux's `PATH`; and `grep` here can be a login-profile
shell function that injects flags and survives into non-interactive bash, which
is why every snippet on this page uses `rg` or `awk`.

Silence from (2) means the lock held. Repeated `SUSPENDED` lines mean something
is taking the lock away that re-acquiring does not stop — at which point the
next step is `termux-job-scheduler`, which uses Android's own AlarmManager and
is suspend-proof by design, rather than a userspace `sleep` loop.

`operad doctor` checks the ADB-side protections listed under
[Defensive layers](#defensive-layers-still-useful-but-secondary).

## Background reading

The 6 ADB protections above are documented in detail (with verification
commands and Samsung Knox-specific notes) in
`adb-process-protection.md` in the legacy `tribixbite/termux-tools` repo.
