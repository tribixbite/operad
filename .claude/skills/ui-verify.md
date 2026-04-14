# UI Verification

## Triggers
- User says `/ui-verify` or asks to check/verify/screenshot the dashboard
- After deploying dashboard changes that need visual confirmation
- User says "check the UI", "take a screenshot", "verify the page"

## Prerequisites
- ADB must be connected: `adb devices` should show a device
- Daemon must be running: `curl -s http://localhost:18970/api/health` should return JSON
- If ADB is offline, reconnect: `curl -s -X POST http://localhost:18970/api/adb/connect`

## Workflow

### 1. Wake & unlock the screen
```sh
adb shell input keyevent KEYCODE_WAKEUP
sleep 1
adb shell input keyevent KEYCODE_MENU
sleep 1
# Swipe up to dismiss lock screen (may need PIN — ask user if bouncer persists)
adb shell input swipe 540 1800 540 800 300
```

Check if unlocked:
```sh
adb shell dumpsys window | grep "mCurrentFocus"
```
If `Bouncer` is focused, the phone needs a PIN — inform the user.

### 2. Navigate to the target page
Dashboard pages:
- Overview: `http://localhost:18970/`
- Memory: `http://localhost:18970/memory`
- Logs: `http://localhost:18970/logs`
- Settings: `http://localhost:18970/settings`
- Telemetry: `http://localhost:18970/telemetry`

```sh
am start -a android.intent.action.VIEW -d "http://localhost:18970/<page>"
sleep 3  # Wait for page load + SSE hydration
```

### 3. Capture screenshot
```sh
adb shell screencap -p /sdcard/scr-<page>-$(date +%H%M%S).png
```

### 4. Resize for token efficiency
CRITICAL: No dimension may be >= 2000px and size must be < 4MB.
Device resolution is 1080x2340, so always resize:
```sh
ffmpeg -y -i ~/screenshot.png -vf "scale=540:-1" ~/screenshot-sm.png 2>/dev/null
```

### 5. Read and analyze
Use the Read tool to view the resized screenshot. Check for:
- Correct layout and element visibility
- SVG icons rendering (not Unicode boxes)
- Data populated (not stuck on "Loading...")
- No overflow or clipping
- Dark theme colors correct

### 6. Return focus
After verification, return to the starting app/view:
```sh
adb shell input keyevent KEYCODE_BACK
```

## Alternative: Use CFC/Playwright for DOM inspection
When ADB screenshots are insufficient (phone locked, need DOM details):
- Use Playwright MCP `browser_navigate` + `browser_snapshot` via a subagent
- ALWAYS delegate `browser_snapshot` to a subagent to avoid flooding main context
- Useful for checking: select dropdown contents, hidden elements, computed styles

## Common issues
- **Blank screenshot**: Screen was off or locked. Run wake sequence first.
- **Stale browser tab**: `am start` may open a new tab while old one shows stale content. The screenshot captures whatever is on screen.
- **ADB offline**: Reconnect via `curl -s -X POST http://localhost:18970/api/adb/connect`
- **Wrong coordinates**: Device is 1080x2340. Don't tap precise small targets via ADB — use CFC/Playwright instead.
