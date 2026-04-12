# operad Platform Abstraction

## Triggers
- Adding new platform-specific functionality
- Porting operad to a new platform
- Debugging platform-specific behavior differences

## Architecture

All platform-specific code is isolated in `src/platform/`. Consumer modules import only the `Platform` interface.

```
src/platform/
  platform.ts   — Platform interface + detectPlatform() factory (singleton)
  common.ts     — Shared /proc helpers for android + linux
  android.ts    — Termux-specific (notifications, battery, wake lock, ADB, tabs)
  linux.ts      — Desktop Linux (notify-send, systemd-inhibit, /proc via common)
  darwin.ts     — macOS (vm_stat, ps, osascript, caffeinate, pmset)
```

## Adding a New Platform Method

1. Add the method signature to `Platform` interface in `platform.ts`
2. Implement in each platform file (android.ts, linux.ts, darwin.ts)
3. Use `common.ts` for shared /proc logic between android+linux
4. Import `platform` singleton in the consumer module:
   ```typescript
   import { platform } from "./platform/platform.js";
   platform.yourNewMethod();
   ```
5. Run `bun run typecheck` — all 3 implementations must satisfy the interface

## Platform Detection

```typescript
function detectPlatform(): PlatformId {
  if (process.env.TERMUX_VERSION) return "android";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}
```

Singleton: `export const platform: Platform = createPlatform();`

## Key Differences by Platform

| Capability | Android | Linux | macOS |
|---|---|---|---|
| Memory | /proc/meminfo | /proc/meminfo | sysctl + vm_stat |
| Process CPU | /proc/PID/stat | /proc/PID/stat | ps -o utime,stime |
| Process tree | /proc scan | /proc scan | ps -eo pid,ppid |
| Process alive | /proc/PID exists | /proc/PID exists | process.kill(0) |
| Process cwd | /proc/PID/cwd | /proc/PID/cwd | lsof -Fn |
| Notifications | termux-notification | notify-send | osascript |
| Battery | termux-battery-status | /sys/class/power_supply | pmset -g batt |
| Wake lock | termux-wake-lock | systemd-inhibit | caffeinate |
| Terminal tabs | am startservice | no-op | osascript |
| ADB | full support | no-op | no-op |
| Phantom budget | BFS from TERMUX_APP_PID | returns 0 | returns 0 |

## Testing

- CI tests on ubuntu-latest + macos-latest (no Android in CI)
- Local Android testing: `tmx boot` + verify notifications, ADB fix, dashboard
- Platform methods that return null/0/false on unsupported platforms are safe no-ops
