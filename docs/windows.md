# operad on Windows (Experimental)

Windows support is experimental. Core session orchestration works; battery
monitoring, wake locks, and process tree introspection are limited compared
to Linux/macOS. See [Known Limitations](#known-limitations) below.

---

## Prerequisites

### tmux

tmux has no native Windows port. Install it via **MSYS2** or use **WSL**.

#### MSYS2 (recommended)

1. Download and install MSYS2 from <https://www.msys2.org/>.
2. Open an **MSYS2 UCRT64** shell and install tmux:
   ```sh
   pacman -S tmux
   ```
3. Add the MSYS2 `usr/bin` directory to your Windows `PATH`:
   - Open **System Properties → Advanced → Environment Variables**.
   - Edit the `Path` variable and add `C:\msys64\usr\bin` (or your MSYS2 install path).
4. Verify from a standard Windows terminal (cmd or PowerShell):
   ```cmd
   tmux -V
   ```

#### WSL alternative

Run operad entirely inside WSL (Windows Subsystem for Linux) where native
Linux platform support is available. See [WSL Alternative](#wsl-alternative).

### Node.js or Bun

Install **bun** (preferred) or **Node.js** from their official installers:

- bun: <https://bun.sh> — run `powershell -c "irm bun.sh/install.ps1 | iex"`
- Node.js: <https://nodejs.org>

---

## Installation

```cmd
npm install -g operadic
```

Or with bun:

```cmd
bun install -g operadic
```

---

## First-Run Setup

```cmd
operad init
operad doctor
operad boot
```

`operad init` creates a minimal config at `%APPDATA%\operad\operad.toml`.

`operad doctor` checks tmux, runtime, config, and state directory. Address
any `fail` items before booting.

`operad boot` starts the daemon and all configured sessions.

---

## Paths

| Resource | Location |
|----------|----------|
| Config file | `%APPDATA%\operad\operad.toml` |
| State file | `%LOCALAPPDATA%\operad\state.json` |
| Log directory | `%LOCALAPPDATA%\operad\logs\` |
| IPC socket | `%LOCALAPPDATA%\operad\operad.sock` |
| Dashboard | <http://localhost:18970> |

The IPC socket uses Unix-domain sockets (AF_UNIX), which are supported on
Windows 10 build 17063+ and Windows Server 2019+.

---

## Config Example

```toml
[operad]
dashboard_port = 18970

[[session]]
name = "my-project"
type = "claude"
path = "C:/Users/you/git/my-project"
```

Note: use forward slashes or double backslashes in TOML path strings.

---

## Known Limitations

| Feature | Status |
|---------|--------|
| tmux sessions | Works via MSYS2 or WSL |
| Dashboard | Works |
| Health checks | Works |
| Notifications | Best-effort via PowerShell (Windows 10+) |
| Battery monitoring | Works via WMI (laptop only; desktops return null) |
| Wake lock | Not implemented (returns false) |
| Radio control | Not applicable |
| Process tree / CPU ticks | Not available — ActivityDetector degrades gracefully |
| Process cwd | Not available |
| ADB protections | Not applicable (Android-only) |
| Phantom budget | Not applicable (Android-only) |
| Terminal tabs | Not applicable |

The `tmux` binary must come from MSYS2 or WSL — there is no native Win32 port.
operad does not ship tmux.

---

## Troubleshooting

### `tmux: command not found`

tmux is not on PATH. Either:
- Add `C:\msys64\usr\bin` to your Windows `PATH`, or
- Run operad inside an MSYS2 shell, or
- Use WSL.

### `operad doctor` reports state-dir as missing

The directory will be created automatically on first `operad boot`. If the
error persists, create it manually:
```powershell
mkdir "$env:LOCALAPPDATA\operad"
```

### IPC socket errors on older Windows

Unix-domain sockets require Windows 10 build 17063+ or Windows Server 2019+.
Upgrade your Windows installation or use WSL.

### Dashboard does not load

Ensure port 18970 is not blocked by a firewall. Add an inbound rule in
Windows Defender Firewall for TCP port 18970 if needed.

---

## WSL Alternative

Running operad inside WSL gives full Linux platform support including:
- `/proc`-based process introspection and CPU tracking
- Battery monitoring via `/sys/class/power_supply/`
- `systemd-inhibit` wake lock (on WSL2 with systemd enabled)
- Native `notify-send` notifications (if a DBus session is running)

Install WSL: <https://learn.microsoft.com/en-us/windows/wsl/install>

```powershell
wsl --install
```

Then follow the Linux installation instructions inside the WSL shell.
