# Crash Resilience on Termux/Android

How operad keeps its tmux sessions, and the Claude Code instances running in
them, alive on a device whose OS is actively trying to stop them, and where
it cannot.

There are **two independent failure domains**:

| Domain | What dies | What can be done |
| ------ | --------- | ---------------- |
| **App death**: Android kills `com.termux` | Everything in the app's cgroup: the tmux server, **every Claude Code instance in it**, the daemon, the watchdog | Only an orphaned cgroup protects the tree ([How the sessions used to survive](#how-the-sessions-used-to-survive)), and there is no unrooted way to get one on demand. Otherwise: lower the kill rate and recover afterwards |
| **Process death**: lmkd or the OOM killer kills one process, usually the daemon | That process only. The tmux server and its sessions keep running | The watchdog restarts the daemon, which re-adopts the running sessions ([The supervision loop](#the-supervision-loop)) |

The second is always survivable. The first is survivable only in the case
described under [How the sessions used to survive](#how-the-sessions-used-to-survive);
otherwise the sessions are lost, not just the supervision. A recreated session resumes its conversation from the
transcript on disk (`claude --resume <id>`), but whatever that Claude was doing
at the moment of the kill, such as a running tool call, a build it had started
or an unsent turn, is gone.

> **Each section states what has actually been observed on real hardware.**
> Every "this happened" here is measured, not hypothesised; the numbers come
> from the author's Samsung device (S25 Ultra, unrooted).

## App death: the cgroup sweep

Android places every process an app spawns into that app's cgroup:

```
/sys/fs/cgroup/apps/uid_<UID>/pid_<APP_LAUNCH_PID>/cgroup.procs
```

Reparenting to init (PPid=1), `setsid` and `detached: true` do not move a
process out of it, and an unrooted app cannot move one either: the cgroup
files belong to `system`. The one way a tree has ended up outside the live
app's cgroup is that Android forgot the cgroup, not that the tree left it
([How the sessions used to survive](#how-the-sessions-used-to-survive)).

When lmkd kills `com.termux`, `ActivityManager` kills every PID in that
cgroup. Measured 2026-11-15 in logcat:

```
lmkd: Reclaim 'com.termux' (26899) ...
ActivityManager: ... PhantomProcessRecord ... died      (every Termux child, within 80 ms)
libprocessgroup: Removed cgroup .../uid_10364/pid_26899
```

The daemon, the watchdog, crond, the tmux server and every Claude Code
session went in the same 80 ms. The trees that died on 2026-10-02, 10-10,
11-03, 11-11, 11-15 (twice) and 11-18 were each in the cgroup of the
`com.termux` instance that was killed, on three firmware builds.

### Every entry point lands in `com.termux`'s cgroup

| How the tree was started | Survives `com.termux` death? |
| ------------------------ | ---------------------------- |
| `operad stream` typed in a Termux tab | No |
| Termux:Boot (`~/.termux/boot/startup.sh`) | **No.** `BootJobService` sends an execute intent to `com.termux/.app.TermuxService`, which runs the script |
| Termux:Tasker, Termux:Widget | No (they delegate to `com.termux` the same way) |
| `am startservice → com.termux/.app.RunCommandService` | No |
| `termux-job-scheduler` | No (the job runs via TermuxService too) |

> **Correction.** From April to November 2026 this page said that
> Termux:Boot's `BootReceiver` calls `Runtime.exec()` in its own process, so
> a boot-started tree sits in `com.termux.boot`'s cgroup and "survives
> `com.termux` death untouched". That is not how Termux:Boot 0.8.1 works, and
> it was never measured: until mid-August the boot script could not even start
> operad (exit 126/127, see [failure mode 1](#four-ways-the-watchdog-silently-stops-working)),
> so no tree on this device had been boot-started when it was written. The
> survival it was trying to explain was real, but the cause was the one below.
> Nothing changed in operad's runtime between 2026-09-05 and 2026-11-09.

### How the sessions used to survive

Through October 2026 the sessions did survive `com.termux` being killed, for
days at a time, including through long Gradle builds that had lmkd killing the
launcher. The cause was an Android **framework soft restart**: system_server
and zygote restart without a kernel reboot.

A soft restart kills the `com.termux` app process without the usual cleanup:
no exit record is written and its cgroup is not swept. The tmux server, the
Claude Code sessions, the daemon and the watchdog keep running in the old
`pid_<X>` cgroup, which the restarted ActivityManager no longer tracks. Every
later `com.termux` gets a new cgroup, and an lmkd kill of it sweeps only that
new one. The orphaned tree is immune to app death until the next full reboot.

Framework starts, soft and cold, are recorded as the exits of boot-only system
apps. They survive reboots:

```sh
/system/bin/dumpsys activity exit-info com.sec.android.app.SecSetupWizard | rg 'timestamp='
```

On this device:

- **Soft restarts, with the daemon running straight through:** 2026-08-17,
  08-23, 08-30, 09-10 (twice), 09-11, 10-16, 10-20 and 10-26 05:59. Several
  were between 04:00 and 06:00.
- **Cold boots:** 09-12, 10-02, 10-08, 10-26 19:47 (the Android 17 update),
  11-08, 11-17 and 11-20. Each shows a clean "Shutdown complete" in the daemon
  log, battery deaths included.
- **Example:** the tree started on 2026-10-11 (app pid 4631, which has no exit
  record) ran through the 10-16 and 10-20 soft restarts, then survived five
  `com.termux` LOW_MEMORY kills until the 10-26 cold boot.
- **Trees with no soft restart in their lifetime** died at the first kill of
  their app: 10-02, 10-10, 11-03, 11-11, 11-15 (twice) and 11-18.

**The likely trigger** was a device bug the user identified. With about 20
keyboard apps installed, opening the keyboard picker (`showInputMethodPicker()`)
could crash InputMethodManagerService in system_server, which soft-restarts
the framework. CleverKeys' first-run "Select Keyboard" button did this, and
was logged as its UT-6. Its July 2026 fix removed the app-side crash states,
but the audit records that the device still soft-reset from the picker.
There has been no soft restart since the Android 17 update; the device now
has 10 keyboards installed.

**It cannot be produced on purpose without root.** `am restart` from adb fails
with `SecurityException: Requires permission android.permission.SHUTDOWN`
(tried 2026-11-25), and `stop; start` and `setprop ctl.restart zygote` need
root. Reproducing the keyboard-picker crash is the only candidate, and it
kills every app on the device. Treat an orphaned tree as luck, not a defence.

Before August the logs cannot separate app kills from battery deaths, so how
often trees died then is not known.

### What the boot hook is for

`~/.termux/boot/startup.sh` (a symlink to `watchdog.sh`) brings the tree back
**after a phone reboot**. Without it nothing does until someone runs
`operad stream`. `operad doctor` checks that the link exists, resolves and is
executable.

```
device boot → BOOT_COMPLETED → com.termux.boot/.BootJobService
                                     │  execute intent
                                     ▼
                          com.termux/.app.TermuxService      (com.termux's cgroup)
                                     │
                               watchdog.sh loop
                                     │
                               operad stream → daemon → tmux server → Claude sessions
```

### What helps with app death

- **Fewer kills of `com.termux`.** The rate is driven by memory pressure, and
  most of it is ours: Gradle JVMs (~2 GB), x2d and each Claude Code instance
  (~370 MB) all run inside the same cgroup. The
  [defensive layers](#defensive-layers-still-useful-but-secondary) lower the
  priority Android gives the kill; they do not prevent it.
- **Faster recovery.** Once Termux is dead nothing inside it can notice.
  A persisted `termux-job-scheduler` job re-runs the boot script every
  15 minutes; when a watchdog is already live, the script exits at once:

  ```sh
  timeout -s KILL 30 termux-job-scheduler --job-id 4242 \
    -s ~/.termux/boot/startup.sh --period-ms 900000 \
    --persisted true --network none --battery-not-low false
  ```

  The client can hang under memory pressure after the job is registered,
  hence the `timeout`. Whether the job starts Termux again after `com.termux`
  has died has not been tested yet.
- **A suspected trigger, not yet confirmed.** The Samsung camera was the focused app
  at the 2026-11-15 11:05 kill and opened 1.6 s before the 2026-11-18 09:07
  kill; Samsung's lmkd has a camera kill-boost mode
  (`CameraMode … camerakillboostmode`). Other camera opens did not kill Termux.

To see where the tree is:

```sh
cat /proc/$(pidof -s com.termux)/cgroup | rg apps                  # pid_<X>
cat /proc/$(tmux display-message -p '#{pid}')/cgroup | rg apps     # same pid_<X>: dies with Termux
```

A tmux server in a different `pid_<Y>` is in an orphaned cgroup
([How the sessions used to survive](#how-the-sessions-used-to-survive)) and
will outlive the app until the next reboot.

## Defensive layers (still useful, but secondary)

operad applies a stack of ADB-driven protections to reduce the rate at which
`com.termux` itself gets killed.
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
pressure. They do not prevent it, and when the app does die the tmux sessions
and their Claude Code instances go with it ([App death](#app-death-the-cgroup-sweep)).
Keeping Termux "open" in Samsung's battery settings did not prevent the
November kills either.

All six target `com.termux` itself. Nothing applies them to the daemon, the
watchdog or the tmux server: those are not app processes, so
`ActivityManager` does not manage their `oom_score_adj` at all — each inherits
one at fork and keeps it for life.

## The supervision loop

This covers the survivable domain: lmkd killing the daemon on its own while
`com.termux`, and so the tmux server, stays alive. That is `watchdog.sh`'s
job.

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

- Termux:Boot at device boot, via `~/.termux/boot/startup.sh` (a symlink to
  `watchdog.sh`).
- The `termux-job-scheduler` job, every 15 minutes, via the same script
  ([What helps with app death](#what-helps-with-app-death)).
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

- **The tree was boot-started, and that did not help.** Its watchdog came from
  Termux:Boot a week earlier (log line *"direct exec unavailable — no exec shim
  in this process"*). Boot-started trees run in `com.termux`'s cgroup
  ([App death](#app-death-the-cgroup-sweep)), so this was the sweep, not a
  separate kill of each process.
- **A low `oom_score_adj` was not protection either.** The daemon, watchdog and
  tmux server all read `0`, the *least* killable tier, inherited at fork and
  never updated, while `com.termux` itself read `200`. It made no difference:
  the sweep kills by cgroup membership, not by score.
- **The supervisor dies with what it supervises.** The watchdog, the daemon
  and tmux share one cgroup, so the only things that can bring the tree back
  are the next boot, the next `operad stream`, and the periodic
  `termux-job-scheduler` job, which was added for exactly this case.

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
- **Periodic re-run of the boot script.** The persisted `termux-job-scheduler`
  job 4242 runs `~/.termux/boot/startup.sh` every 15 minutes. It is the only
  recovery path that does not depend on a process inside Termux still being
  alive, but it only brings the tree back; it does not save the sessions that
  died ([What helps with app death](#what-helps-with-app-death)).
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

# 3. Which app cgroup holds the tmux server? Matching com.termux's pid_<X>
#    (the normal case) means the sessions die with the app.
cat /proc/$(pidof -s com.termux)/cgroup | rg apps
cat /proc/$(tmux display-message -p '#{pid}')/cgroup | rg apps

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
#    this process" came from Termux:Boot or the job scheduler; one without it
#    came from a terminal. Either way it is in com.termux's cgroup.
rg -n 'Supervising via' "$WDLOG" | tail -5

# 7. Is the recovery job registered?
timeout -s KILL 30 termux-job-scheduler --pending
```

Two Termux notes on the above: `dumpsys` needs its absolute path, because
`/system/bin` is not on Termux's `PATH`; and `grep` here can be a login-profile
shell function that injects flags and survives into non-interactive bash, which
is why every snippet on this page uses `rg` or `awk`.

Silence from (2) means the lock held. Repeated `SUSPENDED` lines mean something
is taking the lock away that re-acquiring does not stop. The job from (7) runs
on Android's JobScheduler, so it still fires when the userspace `sleep` loop is
frozen.

`operad doctor` checks the ADB-side protections listed under
[Defensive layers](#defensive-layers-still-useful-but-secondary).

## Background reading

The 6 ADB protections above are documented in detail (with verification
commands and Samsung Knox-specific notes) in
`adb-process-protection.md` in the legacy `tribixbite/termux-tools` repo.
