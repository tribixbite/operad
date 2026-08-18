#!/data/data/com.termux/files/usr/bin/bash
# watchdog.sh — Keeps operad daemon alive after OOM kills
# Install: replace ~/.termux/boot/startup.sh with this script
# The operad daemon handles everything startup.sh used to do:
# ADB fix, session creation, health checks, wake lock management.
#
# After a successful boot, this script attaches tmux to the current terminal
# so the watchdog's Termux tab becomes a tmux client (enabling tab switching).

# Termux:Boot runs this without a login shell, so the environment a normal
# terminal would set up is absent — including LD_PRELOAD.
#
# That matters because dist/tmx.js carries a `#!/usr/bin/env node` shebang,
# which is correct for npm on Linux and macOS but unresolvable on Termux:
# there is no /usr/bin/env. Termux's exec shim rewrites the interpreter path
# at exec time, but only when it is preloaded into the CALLING shell. Without
# it every invocation dies with "bad interpreter" (exit 127), so the watchdog
# could never start or even detect the daemon — the exact failure that left
# operad down after an OOM kill.
#
# Guarded on the file existing, so this is a no-op off Termux.
for _shim in "$PREFIX/lib/libtermux-exec-ld-preload.so" "$PREFIX/lib/libtermux-exec.so"; do
  if [ -f "$_shim" ]; then
    case ":${LD_PRELOAD:-}:" in
      *":$_shim:"*) ;;                                   # already present
      *) export LD_PRELOAD="${LD_PRELOAD:+$LD_PRELOAD:}$_shim" ;;
    esac
    break
  fi
done
unset _shim

# Tell `operad stream` that supervision already exists. Without this the two
# would start each other without end: stream now spawns a watchdog when none
# is running, and the watchdog runs stream.
export OPERAD_WATCHDOG=1

# Where the daemon keeps its logs. Platform-dependent — Android uses the legacy
# `tmx` directory, everything else `operad` — so `operad stream` passes the one
# it actually resolved. The fallback only has to be right for a watchdog run
# directly from a boot script on this device.
LOG_DIR="${OPERAD_LOG_DIR:-$HOME/.local/share/tmx/logs}"
PIDFILE="${TMPDIR:-$PREFIX/tmp}/operad-watchdog.pid"

# Restore the executable bit on a file that should have it.
#
# dist/tmx.js carries a shebang and is this package's `bin` entry, so it is
# always meant to be executable; a build that dropped the bit makes every
# invocation exit 126 ("found but not executable"). build.cjs sets it now — this
# covers a checkout built by an older version.
repair_exec_bit() {
  local f="$1"
  [ -e "$f" ] || return 1
  [ -x "$f" ] && return 0
  chmod +x "$(readlink -f "$f" 2>/dev/null || echo "$f")" 2>/dev/null \
    || chmod +x "$f" 2>/dev/null || true
  [ -x "$f" ]
}

# Resolve the operad binary.
#
# This was hardcoded to `$HOME/.local/bin/tmx` — the author's dev symlink. The
# package's `bin` entry is named `operad` and lands wherever the package manager
# puts it, so on every install but that one the watchdog could not invoke the
# binary at all: `operad stream` exited 127, and the retry loop below then span
# on it forever. That is the very failure mode this script was hardened against.
resolve_bin() {
  local c p

  # 1. Told explicitly. `operad stream` exports OPERAD_BIN when it spawns us, so
  #    the watchdog supervises the exact bundle that started it rather than
  #    whichever copy happens to win a PATH lookup.
  if [ -n "${OPERAD_BIN:-}" ] && repair_exec_bit "$OPERAD_BIN"; then
    printf '%s' "$OPERAD_BIN"
    return 0
  fi

  # 2. On PATH, under the published name or the legacy one.
  for c in operad tmx; do
    p=$(command -v "$c" 2>/dev/null) || continue
    [ -x "$p" ] && { printf '%s' "$p"; return 0; }
  done

  # 3. The author's dev symlink, kept so an existing install keeps working.
  if repair_exec_bit "$HOME/.local/bin/tmx"; then
    printf '%s' "$HOME/.local/bin/tmx"
    return 0
  fi

  # 4. The bundle next to this script — a git checkout never linked onto PATH.
  p=$(cd "$(dirname "$0")" 2>/dev/null && pwd)/dist/tmx.js
  if repair_exec_bit "$p"; then
    printf '%s' "$p"
    return 0
  fi

  return 1
}

# Command line of a pid, one argument per line.
#
# /proc gives exact argument boundaries (NUL-delimited). macOS has no /proc, so
# fall back to `ps`, which is POSIX; splitting its output on whitespace only
# approximates the boundaries, but that is enough to match a script basename.
#
# Deliberately no grep, and no `mapfile -d` — grep can be a login-profile shell
# function on this platform that injects flags and survives into non-interactive
# bash, and `mapfile -d` needs bash 4.4 while macOS ships 3.2.
proc_args() {
  local pid="$1"
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null
    return 0
  fi
  ps -o args= -p "$pid" 2>/dev/null | tr ' ' '\n'
}

# Is this pid a live watchdog other than us?
is_live_watchdog() {
  local pid="$1"
  case "$pid" in (""|*[!0-9]*) return 1 ;; esac
  [ "$pid" = "$$" ] && return 1
  [ "$pid" = "$PPID" ] && return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # Match an actual script ARGUMENT, not the substring anywhere in the command
  # line. `bash -c '... startup.sh ...'` — a shell that merely mentions the
  # path, an editor, a grep — would otherwise look like a running watchdog and
  # block a real one from ever starting.
  local args a
  args=$(proc_args "$pid") || return 1
  [ -n "$args" ] || return 1
  while IFS= read -r a; do
    case "${a##*/}" in
      watchdog.sh|startup.sh) return 0 ;;
    esac
  done <<< "$args"
  return 1
}

# Single instance. Two watchdogs both poll, both decide the daemon is dead at
# the same moment, and both run `operad stream`; that happened on this device
# and ran for weeks.
#
# The pidfile alone is not enough to detect it: a watchdog started before this
# guard existed, or one whose pidfile was removed, is invisible to it — which
# is precisely how the duplicate pair arose. So scan /proc for a sibling too,
# and treat the pidfile as a fast path rather than the source of truth.
RUNNING_PID=""
if [ -f "$PIDFILE" ] && is_live_watchdog "$(cat "$PIDFILE" 2>/dev/null)"; then
  RUNNING_PID=$(cat "$PIDFILE" 2>/dev/null)
elif [ -d /proc ]; then
  # Only scan where /proc exists. Unmatched, the glob would be tested as the
  # literal string "/proc/[0-9]*", which fails the numeric check and quietly
  # reports "nothing running". Without /proc (macOS) the pidfile fast path above
  # still works — is_live_watchdog falls back to `ps` — so the only case left
  # unguarded there is an instance whose pidfile was deleted.
  for _p in /proc/[0-9]*; do
    _pid=${_p#/proc/}
    if is_live_watchdog "$_pid"; then RUNNING_PID="$_pid"; break; fi
  done
  unset _p _pid
fi

if [ -n "$RUNNING_PID" ]; then
  echo "operad watchdog already running (PID $RUNNING_PID) — exiting" >&2
  exit 0
fi

mkdir -p "$(dirname "$PIDFILE")" 2>/dev/null || true
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT INT TERM
LOG="$LOG_DIR/watchdog.log"
mkdir -p "$LOG_DIR"

# Rotate the log past this size. It had no cap: a persistent boot failure
# writes two lines every retry, and this machine's watchdog.log reached 144 MB.
MAX_LOG_BYTES=$((5 * 1024 * 1024))

# Retry backoff, in seconds. A fixed 5 s meant a failure the retry could never
# fix — a non-executable bundle, say — span forever: 1,036,045 consecutive
# exit-126 retries were recorded here, roughly two months of it, with nothing
# to show for them but disk consumption.
MIN_BACKOFF=5
MAX_BACKOFF=300
backoff=$MIN_BACKOFF

# Poll interval when there is no terminal to attach to, so a headless run
# supervises quietly instead of looping every three seconds.
HEADLESS_POLL=60

# Write a heartbeat every this many unchanged polls (30 x 60s = 30 min). The
# loop otherwise logs only changes, so without this a healthy watchdog would be
# indistinguishable in the log from one that had stopped.
HEARTBEAT_EVERY=30

# Loop state for change-only logging.
LAST_STATE=""
DAEMON_WAS_UP=""
POLLS=0
STATE=""

rotate_log() {
  [ -f "$LOG" ] || return 0
  local size
  # -c is GNU, -f is BSD/macOS. Falling through to 0 just means "do not rotate".
  size=$(stat -c %s "$LOG" 2>/dev/null || stat -f %z "$LOG" 2>/dev/null || echo 0)
  case "$size" in (""|*[!0-9]*) size=0 ;; esac
  if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || true
  fi
}

log() {
  rotate_log
  echo "[$(date)] $*" >> "$LOG"
}

# Keep the CPU awake, independently of the daemon.
#
# This is the difference between supervising and only appearing to. Without a
# wake lock Android suspends the CPU, and `sleep` counts CLOCK_MONOTONIC, which
# does not advance across suspend — so the poll below silently becomes 5, 10 or
# 340 minutes instead of one, and a daemon that dies at the start of such a
# window is not noticed until it ends. Measured on this device before the fix:
# 60 gaps totalling 933 minutes over three days, the daemon frozen in step.
#
# The daemon acquires a lock too, but the daemon is the thing that might be
# dead — so the supervisor cannot depend on it for the conditions it needs to
# supervise. Acquire-only, never released: termux-wake-unlock gets processes
# killed.
#
# No grep and no rg: grep can be a login-profile shell function on this device
# that injects flags and survives into non-interactive bash, and rg is not
# guaranteed to be installed. bash's own pattern matching has neither problem.
ensure_wake_lock() {
  command -v termux-wake-lock > /dev/null 2>&1 || return 0

  # Absolute path: Termux's PATH does not include /system/bin. Overridable so
  # both branches of this function can actually be tested.
  local dumpsys="${OPERAD_DUMPSYS:-/system/bin/dumpsys}"
  if [ -x "$dumpsys" ]; then
    local power
    # `termux:service-wakelock` is the tag Termux registers with PowerManager.
    power=$("$dumpsys" power 2>/dev/null) || power=""
    case "$power" in
      *"termux:service-wakelock"*) return 0 ;;   # already held, nothing to do
    esac
    # Only report a LOSS once we have seen the lock exist at least once;
    # otherwise a device where dumpsys is unreadable logs every poll.
    if [ -n "$power" ]; then
      log "Wake lock not held by Termux — acquiring (without it the device suspends and this loop stops polling)"
    fi
  fi

  termux-wake-lock > /dev/null 2>&1 || log "WARNING: termux-wake-lock failed"
}

# Sleep, then report how much wall-clock actually passed.
#
# The overshoot IS the outage: it is exactly the interval during which a dead
# daemon would not have been noticed. Logging it turns an invisible failure
# into an entry someone can find.
sleep_reporting_overshoot() {
  local want="$1" t0 t1 actual
  t0=$(date +%s)
  sleep "$want"
  t1=$(date +%s)
  actual=$((t1 - t0))
  if [ "$actual" -gt $((want * 2)) ]; then
    log "SUSPENDED: asked for ${want}s, ${actual}s of wall clock passed — supervision was blind for $((actual - want))s"
  fi
}

# Resolve the binary once, up front. If it cannot be found there is nothing to
# supervise and no amount of retrying will produce one, so say so and stop
# rather than spin — a fixed retry against an uninvokable binary is exactly what
# produced 1,036,045 consecutive failures and a 144 MB log on this device.
TMX=$(resolve_bin) || TMX=""
if [ -z "$TMX" ]; then
  log "FATAL: no operad binary found (tried \$OPERAD_BIN, PATH, ~/.local/bin/tmx, $(dirname "$0")/dist/tmx.js) — nothing to supervise"
  echo "operad watchdog: no operad binary found — nothing to supervise" >&2
  exit 1
fi
log "Supervising via $TMX"

# `timeout` is GNU coreutils. Stock macOS has neither it nor `gtimeout` unless
# coreutils is installed, and a missing command exits 127 — which daemon_alive
# would read as "daemon is dead" on every single poll and keep restarting a
# daemon that was never down.
if command -v timeout > /dev/null 2>&1; then
  TIMEOUT_CMD="timeout 5"
elif command -v gtimeout > /dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout 5"
else
  TIMEOUT_CMD=""
  log "No timeout(1) available — status checks will run unbounded"
fi

# Check if daemon is alive by testing the IPC socket with a status command.
# Returns 0 if daemon responds, 1 otherwise.
daemon_alive() {
  # Unquoted on purpose: TIMEOUT_CMD is a command plus its argument, or empty.
  # shellcheck disable=SC2086
  $TIMEOUT_CMD "$TMX" status > /dev/null 2>&1
}

while true; do
  # Before anything else: make sure the CPU can stay awake. Every other check
  # in this loop is worthless if the device suspends between iterations,
  # because this process stops running without ever stopping "running".
  ensure_wake_lock

  # If daemon is already running, skip boot entirely — just attach tmux.
  if daemon_alive; then
    # Only worth a line when it is news. This said "Daemon already running,
    # attaching tmux" on every poll — wrong on the headless path, and the
    # steady-state noise that made a real outage hard to see in the log.
    if [ "$DAEMON_WAS_UP" != "1" ]; then
      log "Daemon is up"
      DAEMON_WAS_UP=1
    fi
    backoff=$MIN_BACKOFF
  else
    DAEMON_WAS_UP=0
    log "Starting operad stream..."

    # Exit 126 is "found but not executable" — a rebuild that dropped the +x bit
    # off dist/tmx.js. resolve_bin guaranteed the bit at startup, but a rebuild
    # while we are running can drop it again, which is precisely what happened
    # here. Retrying cannot fix that, so repair it before each attempt.
    if [ -e "$TMX" ] && [ ! -x "$TMX" ]; then
      log "WARNING: $TMX is not executable — repairing with chmod +x"
      repair_exec_bit "$TMX" || log "WARNING: could not restore +x on $TMX"
    fi

    # Do NOT delete the socket here — isRunning() handles stale detection.
    # Deleting an active socket causes duplicate daemon spawns.

    "$TMX" stream
    EXIT_CODE=$?

    if [ $EXIT_CODE -ne 0 ]; then
      log "operad stream failed (code=$EXIT_CODE), retrying in ${backoff}s..."
      sleep "$backoff"
      # Back off geometrically so a failure that retrying cannot fix costs
      # one line every five minutes instead of every five seconds.
      backoff=$((backoff * 2))
      [ "$backoff" -gt "$MAX_BACKOFF" ] && backoff=$MAX_BACKOFF
      continue
    fi

    log "Boot succeeded"
    backoff=$MIN_BACKOFF
  fi

  # Wait for tmux sessions to exist before attaching (boot is async).
  for i in $(seq 1 15); do
    if tmux has-session 2>/dev/null; then break; fi
    sleep 1
  done

  # Attaching needs a terminal. Termux:Boot runs this script WITHOUT a tty, and
  # `tmux attach` then fails instantly ("open terminal failed") — so the loop
  # fell straight through to `sleep 3` and span every three seconds for as long
  # as the device stayed up, two log lines a time. Only attach when there is
  # actually a terminal to attach to; otherwise idle at a sane interval.
  if [ -t 0 ] && tmux has-session 2>/dev/null; then
    log "Attaching tmux client"
    # No exec — when tmux exits (daemon shutdown/OOM), the loop continues and reboots.
    tmux attach
    log "tmux exited, loop will restart daemon"
    # A returning attach means the user detached or tmux died; re-check promptly.
    sleep 3
  else
    # These two lines used to be written on every poll, alongside "Daemon
    # already running" — two lines a minute, forever, which is how this log
    # reached 692 KB saying nothing. Log a state CHANGE always, and otherwise
    # only a periodic heartbeat: enough to prove the loop is alive and to date
    # any gap in it, without burying the lines that matter.
    if [ ! -t 0 ]; then STATE=headless; else STATE=noattach; fi
    POLLS=$((POLLS + 1))
    if [ "$STATE" != "$LAST_STATE" ]; then
      if [ "$STATE" = headless ]; then
        log "Headless (no tty) — supervising without attaching"
      else
        log "No tmux sessions available, skipping attach"
      fi
      LAST_STATE="$STATE"
      POLLS=0
    elif [ "$POLLS" -ge "$HEARTBEAT_EVERY" ]; then
      log "Still supervising ($STATE, daemon up)"
      POLLS=0
    fi
    # Nothing to attach to, so this is a plain supervision poll. Three seconds
    # would be a spin; a minute is responsive enough to restart a dead daemon.
    sleep_reporting_overshoot "$HEADLESS_POLL"
  fi
done
