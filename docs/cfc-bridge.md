# CFC Bridge & Patched Edge Canary

operad's `/api/bridge` endpoints integrate with **claude-chrome-android** (the "CFC bridge") — a separate npm package that runs a CDP (Chrome DevTools Protocol) HTTP server on `127.0.0.1:18963`. The bridge controls a browser (typically **Microsoft Edge Canary** with debug-port access) so Claude Code can drive web pages through MCP tools (`mcp__cfc-bridge__*`).

operad does **not** bundle either component. They are optional, and only meaningful on Android/Termux today.

## Quick check

```sh
operad doctor
```

On Android the doctor output now includes:

```
[OK]   cfc-bridge       claude-chrome-android at /data/data/com.termux/files/home/.bun/install/global/node_modules/...
[OK]   edge-canary      com.microsoft.emmx.canary installed
```

…or `[WARN]` rows with install instructions if either is missing.

## Install — claude-chrome-android (CFC bridge)

```sh
bun add -g claude-chrome-android
# or:
npm i -g claude-chrome-android
```

operad searches these paths at runtime:

- `~/.bun/install/global/node_modules/claude-chrome-android/dist/cli.js`
- `~/.npm/lib/node_modules/claude-chrome-android/dist/cli.js`

Once installed, start it via the daemon:

```sh
curl -X POST http://localhost:18970/api/bridge
```

The daemon writes a startup script to `$PREFIX/tmp/tmx-bridge-start.sh` and launches it under TermuxService so the bridge survives the launcher tab closing.

If the bridge isn't installed, `POST /api/bridge` now returns:

```json
{
  "error": "claude-chrome-android (CFC bridge) not installed",
  "fix": "bun add -g claude-chrome-android",
  "searched": ["..."]
}
```

## Install — Microsoft Edge Canary (the "patched" browser)

The bridge needs a Chromium-based browser that exposes the remote debugging port. On Android, the community uses Edge Canary with a flag-set debug build:

1. Install Edge Canary from the Play Store (`com.microsoft.emmx.canary`)
2. Enable Edge developer options (about:flags) and set `--remote-debugging-port=9222` (process varies between Edge versions; community guides walk through it)
3. Open Edge once so it initialises

operad uses Edge Canary in two places:

| Use | File | Notes |
|-----|------|-------|
| Open dashboard from notification | `src/monitoring-engine.ts:362` | `am start … com.microsoft.emmx.canary` |
| Memory-pressure GC nudge | `src/monitoring-engine.ts:210` | `POST http://127.0.0.1:18963/memory-pressure` (handled by the CFC bridge against Edge) |

There is no fallback today — if Edge Canary isn't installed, the notification quick-open silently fails and the GC nudge is a no-op.

## Why "CFC"?

Short for **Claude For Chrome** — the original automation surface name. The Android variant runs against Edge (not Chrome) because Edge Canary on Android exposes debug-port control more easily than Chrome on Android does.

## Linux / macOS / Windows desktop

CFC bridge isn't supported on desktop platforms today. operad's doctor only runs the bridge/Edge checks on `platformId === "android"`. If you want similar functionality on desktop, run Chrome/Edge with `--remote-debugging-port=9222` directly and connect Claude Code's MCP via the standard CDP MCP server — operad has no special integration for that path.

## Troubleshooting

- `POST /api/bridge` returns 404 → `claude-chrome-android` not installed. Follow the `fix` field.
- `POST /api/bridge` returns 502 → bridge process not running. Check `$PREFIX/tmp/bridge.log`.
- Memory-pressure GC nudge does nothing → bridge not reachable on `127.0.0.1:18963`, or Edge not exposing the debug port. Errors are silenced (best-effort) — check daemon logs at level `debug`.
