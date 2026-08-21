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
about.

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
   `operad doctor` to verify whether the value actually took.
6. **Set-inactive false** via `cmd activity set-inactive <pkg> false`.

These reduce the *probability* of `com.termux` being killed under memory
pressure. They do not prevent it. When the app does eventually die, the
spawn-root cgroup is what determines whether the daemon goes with it.

## The supervision loop

Correct spawn-root keeps the daemon out of `com.termux`'s blast radius. It
does nothing about lmkd killing the daemon directly under memory pressure,
which on Android is the *normal* way it dies. That is `watchdog.sh`'s job.

```
watchdog.sh  ── every 60 s ──▶  operad status
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

### Three ways the watchdog silently stops working

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

## Recovery primitives

- **Watchdog respawn.** `watchdog.sh` polls `operad status` every 60 s and runs
  `operad stream` when it does not answer. Retries back off geometrically
  (5 s → 5 min) so a failure retrying cannot fix costs one line every five
  minutes rather than every five seconds, and the log rotates at 5 MB.

  This is **not** unconditionally functional — see the three failure modes
  above. It requires an invokable binary and an awake CPU. An earlier version
  of this page listed it as "always functional", which was wrong.
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
pgrep -af 'watchdog.sh'
rg "Supervising via|code=12[67]" "$WDLOG" | tail -3
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
