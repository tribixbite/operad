# Crash Resilience on Termux/Android

This page corrects the older "PPid:1 = independence" framing. The actual
load-bearing property is **which APK's process spawns the daemon**, because
that determines its Android app cgroup. PPid:1 detachment alone is not enough
on Android 12+.

## The model

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
| `com.termux` shell (`tmx stream` typed in a tab)    | No            |
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
                                              tmx stream
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
  the right cgroup. Manual `tmx stream` from a Termux shell will then put the
  daemon in `com.termux`'s cgroup, where it dies with the app on the next
  Termux crash.
- **The daemon process tree in `com.termux.boot`'s cgroup is fully terminated**
  (e.g., a phone reboot, an overzealous memory sweep, or a `pkill -f watchdog`).
  After that point only the next BOOT_COMPLETED broadcast can re-create the
  process tree in the right cgroup; `tmx stream` from a terminal cannot.

If you find sessions are no longer surviving Termux crashes, check:

```sh
readlink -f ~/.termux/boot/startup.sh                         # must point at a real script
cat /proc/$(pidof -s com.termux)/cgroup | grep apps           # note the pid_<X>
cat /proc/$(pgrep -f 'tmx.js daemon')/cgroup | grep apps      # if pid_<X> matches above, the daemon will die with Termux
```

A daemon in the same `pid_X` bucket as `com.termux` is a daemon that won't
survive the next app death.

## Defensive layers (still useful, but secondary)

Even with the right spawn-root, operad applies a stack of ADB-driven
protections to reduce the rate at which `com.termux` itself gets killed.
These are applied by `applyPhantomFix()` in `src/android-engine.ts` on every
`tmx boot`:

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

## Recovery primitives that still work

Independent of spawn-root, these are always functional:

- **Watchdog respawn.** `watchdog.sh` runs `tmx stream` in a loop. If the
  daemon gets `SIGKILL`'d, the watchdog spawns a new one (in the same cgroup
  as the watchdog).
- **IPC socket self-healing.** When `$PREFIX/tmp/` gets cleared but the daemon
  is alive, the CLI probes `http://localhost:18970/api/fix-socket` and the
  daemon recreates the unix socket. Round-trip < 1s.
- **Crash-safe trace log.** `appendFileSync` on every trace event with no
  open FD, so a SIGKILL'd daemon doesn't lose recent state.

## Background reading

The 6 ADB protections above are documented in detail (with verification
commands and Samsung Knox-specific notes) in
`adb-process-protection.md` in the legacy `tribixbite/termux-tools` repo.
