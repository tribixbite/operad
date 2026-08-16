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

LOG_DIR="$HOME/.local/share/tmx/logs"
SOCKET="$PREFIX/tmp/tmx.sock"
TMX="$HOME/.local/bin/tmx"
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

rotate_log() {
  [ -f "$LOG" ] || return 0
  local size
  size=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || true
  fi
}

log() {
  rotate_log
  echo "[$(date)] $*" >> "$LOG"
}

# Check if daemon is alive by testing the IPC socket with a status command.
# Returns 0 if daemon responds, 1 otherwise.
daemon_alive() {
  timeout 5 "$TMX" status > /dev/null 2>&1
}

while true; do
  # If daemon is already running, skip boot entirely — just attach tmux.
  if daemon_alive; then
    log "Daemon already running, attaching tmux"
    backoff=$MIN_BACKOFF
  else
    log "Starting operad stream..."

    # Exit 126 is "found but not executable" — a rebuild that dropped the +x
    # bit off dist/tmx.js. Retrying cannot fix that, so repair it here rather
    # than spin: the file is this package's bin entry and carries a shebang,
    # so it is always meant to be executable. build.cjs now sets the bit too;
    # this covers a checkout built by an older version.
    if [ -e "$TMX" ] && [ ! -x "$TMX" ]; then
      log "WARNING: $TMX is not executable — repairing with chmod +x"
      chmod +x "$(readlink -f "$TMX")" 2>/dev/null || chmod +x "$TMX" 2>/dev/null || true
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

  if tmux has-session 2>/dev/null; then
    log "Attaching tmux client"
    # Attach tmux to this terminal — makes the watchdog tab a tmux client.
    # No exec — when tmux exits (daemon shutdown/OOM), the loop continues and reboots.
    tmux attach
    log "tmux exited, loop will restart daemon"
  else
    log "No tmux sessions available, skipping attach"
  fi

  # Brief pause before checking again — prevents tight loop if daemon keeps crashing
  sleep 3
done
