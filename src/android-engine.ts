/**
 * android-engine.ts — Android/ADB subsystem engine
 *
 * Extracts all Android-specific logic from daemon.ts:
 *   - ADB serial resolution and caching
 *   - Phantom process killer + process-protection fixes
 *   - ADB retry timer
 *   - Auto-stop package list (persist / toggle / apply on memory pressure)
 *   - Android app listing + management via `adb shell`
 *
 * Receives OrchestratorContext for shared deps (config, state, log).
 * Uses detectPlatform() directly for platform-specific helpers.
 */

import { spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectPlatform } from "./platform/platform.js";
import type { OrchestratorContext } from "./orchestrator-context.js";

/** Resolve ADB binary path at module load time — same pattern as daemon.ts */
const ADB_BIN = detectPlatform().resolveAdbPath() ?? "adb";

// -- Pure helpers (exported for unit tests) ------------------------------------

/**
 * Parse the text output of `adb devices` into two lists:
 *   - `online`  — serials with state "device" (ready for commands)
 *   - `stale`   — serials with state "offline" or "unauthorized"
 *
 * Handles the header line ("List of devices attached"), blank lines, and
 * extra whitespace. Pure — no IO.
 */
export function parseAdbDevicesOutput(output: string): {
  online: string[];
  stale: string[];
} {
  const online: string[] = [];
  const stale: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes("\t")) continue; // header / blank lines
    const [serial, state] = line.split("\t");
    const trimmedState = state?.trim();
    if (trimmedState === "device") {
      online.push(serial.trim());
    } else if (trimmedState === "offline" || trimmedState === "unauthorized") {
      stale.push(serial.trim());
    }
  }
  return { online, stale };
}

/**
 * Choose the best ADB serial from a list of online serials.
 *
 * Preference order:
 *   1. `127.0.0.1:*`  — loopback TCP connection
 *   2. `localhost:*`   — named loopback
 *   3. `<localIp>:*`  — device's own LAN IP (self-connection)
 *   4. First entry    — fallback when no local match (or single device)
 *
 * Returns null if `online` is empty. Pure — no IO.
 */
export function resolveSerialFromList(
  online: string[],
  localIp: string | null,
): string | null {
  if (online.length === 0) return null;
  if (online.length === 1) return online[0];
  // Prefer any localhost / self-IP connection
  const local = online.find(
    (s) =>
      s.startsWith("127.0.0.1:") ||
      s.startsWith("localhost:") ||
      (localIp !== null && s.startsWith(`${localIp}:`)),
  );
  return local ?? online[0];
}

export class AndroidEngine {
  // -- ADB serial cache -------------------------------------------------------
  private adbSerial: string | null = null;
  private adbSerialExpiry = 0;
  /** Cached local IP for ADB self-identification */
  private localIp: string | null = null;
  private localIpExpiry = 0;

  // -- ADB retry timer --------------------------------------------------------
  private adbRetryTimer: ReturnType<typeof setInterval> | null = null;

  // -- Auto-stop list ---------------------------------------------------------
  private autoStopPkgs = new Set<string>();

  // -- Statics ----------------------------------------------------------------

  /** ADB serial cache TTL — re-resolve every 30s to handle reconnects */
  static readonly ADB_SERIAL_TTL_MS = 30_000;

  /** Local IP cache TTL */
  static readonly LOCAL_IP_TTL_MS = 60_000;

  /** Persistent path for auto-stop package list */
  static readonly AUTOSTOP_PATH = join(homedir(), ".local", "share", "tmx", "autostop.json");

  /** Well-known system packages that must never be force-stopped */
  static readonly SYSTEM_PACKAGES = new Set([
    "system_server", "com.android.systemui", "com.google.android.gms.persistent",
    "com.termux", "com.termux.api", "com.sec.android.app.launcher",
    "com.android.phone", "com.android.providers.media",
    "com.samsung.android.providers.media", "com.google.android.gms",
    "com.android.bluetooth", "com.google.android.ext.services",
    "com.google.android.providers.media.module", "android.process.acore",
    "com.samsung.android.scs", "com.samsung.android.sead",
    "com.samsung.android.scpm", "com.sec.android.sdhms",
  ]);

  /** Friendly display names for well-known packages */
  static readonly APP_LABELS: Record<string, string> = {
    "com.microsoft.emmx.canary": "Edge Canary",
    "com.microsoft.emmx": "Edge",
    "com.android.chrome": "Chrome",
    "com.discord": "Discord",
    "com.Slack": "Slack",
    "com.google.android.gm": "Gmail",
    "com.google.android.apps.photos": "Photos",
    "com.google.android.apps.chromecast.app": "Google Home",
    "com.google.android.apps.maps": "Maps",
    "com.google.android.apps.docs": "Drive",
    "com.google.android.apps.youtube": "YouTube",
    "com.google.android.apps.messaging": "Messages",
    "com.google.android.calendar": "Calendar",
    "com.google.android.googlequicksearchbox": "Google",
    "com.google.android.gms": "Play Services",
    "com.google.android.gms.persistent": "Play Services",
    "com.ubercab.eats": "Uber Eats",
    "com.samsung.android.app.spage": "Samsung Free",
    "com.samsung.android.smartsuggestions": "Smart Suggest",
    "com.samsung.android.incallui": "Phone",
    "com.samsung.android.messaging": "Samsung Messages",
    "com.samsung.android.spay": "Samsung Pay",
    "com.sec.android.daemonapp": "Weather",
    "com.sec.android.app.sbrowser": "Samsung Internet",
    "net.slickdeals.android": "Slickdeals",
    "dev.imranr.obtainium": "Obtainium",
    "com.teslacoilsw.launcher": "Nova Launcher",
    "com.sec.android.app.launcher": "One UI Home",
    "com.android.systemui": "System UI",
    "com.android.settings": "Settings",
    "com.android.vending": "Play Store",
    "com.termux": "Termux",
    "com.termux.api": "Termux:API",
    "tribixbite.cleverkeys": "CleverKeys",
    "com.microsoft.appmanager": "Link to Windows",
    "com.google.android.apps.nbu.files": "Files by Google",
    "com.reddit.frontpage": "Reddit",
    "io.homeassistant.companion.android": "Home Assistant",
    "com.adguard.android.contentblocker": "AdGuard",
    "com.samsung.android.app.smartcapture": "Smart Select",
    "com.samsung.android.app.routines": "Routines",
    "com.samsung.android.rubin.app": "Customization",
    "com.samsung.android.app.moments": "Memories",
    "com.samsung.android.ce": "Samsung Cloud",
    "com.samsung.android.mdx": "Link to Windows",
    "com.samsung.euicc": "SIM Manager",
    "com.sec.imsservice": "IMS Service",
    "com.sec.android.app.clockpackage": "Clock",
    "com.samsung.cmh": "Connected Home",
    "com.samsung.android.kmxservice": "Knox",
    "com.samsung.android.stplatform": "SmartThings",
    "com.samsung.android.service.stplatform": "SmartThings",
    "com.google.android.gms.unstable": "Play Services",
    "com.google.android.as.oss": "Private Compute",
    "com.google.android.cellbroadcastreceiver": "Emergency Alerts",
    "com.sec.android.app.chromecustomizations": "Chrome Custom",
    "org.mopria.printplugin": "Print Service",
    "com.samsung.android.samsungpositioning": "Location",
    "com.google.android.providers.media.module": "Media Storage",
  };

  constructor(private ctx: OrchestratorContext) {}

  // -- ADB helpers ------------------------------------------------------------

  /** Get local IP with caching (60s TTL) */
  getLocalIp(): string | null {
    const now = Date.now();
    if (this.localIp && now < this.localIpExpiry) return this.localIp;
    this.localIp = detectPlatform().resolveLocalIp();
    this.localIpExpiry = now + AndroidEngine.LOCAL_IP_TTL_MS;
    if (this.localIp) this.ctx.log.debug(`Local IP resolved: ${this.localIp}`);
    return this.localIp;
  }

  /**
   * Resolve the active ADB device serial (needed when multiple devices are listed).
   * Prefers localhost/self-device connections over external phones.
   * Caches with a short TTL so reconnects with new ports are picked up.
   * Auto-disconnects stale offline/unauthorized entries to prevent confusion.
   */
  resolveAdbSerial(): string | null {
    const now = Date.now();
    if (this.adbSerial && now < this.adbSerialExpiry) return this.adbSerial;
    try {
      const result = spawnSync(ADB_BIN, ["devices"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0 || !result.stdout) return null;

      const { online, stale } = parseAdbDevicesOutput(result.stdout);

      // Auto-disconnect stale entries to prevent "more than one device" errors
      for (const serial of stale) {
        this.ctx.log.debug(`Disconnecting stale ADB device: ${serial}`);
        spawnSync(ADB_BIN, ["disconnect", serial], { timeout: 3000, stdio: "ignore" });
      }

      if (online.length === 0) {
        this.adbSerial = null;
        return null;
      }

      // Prefer localhost/self-device connections over external phones
      const localIp = this.getLocalIp();
      const chosen = resolveSerialFromList(online, localIp)!; // online non-empty here
      if (online.length > 1) {
        const pickedLocal = chosen.startsWith("127.0.0.1:") || chosen.startsWith("localhost:") ||
          (localIp !== null && chosen.startsWith(`${localIp}:`));
        if (pickedLocal) {
          this.ctx.log.debug(`Multiple ADB devices, preferring localhost: ${chosen}`);
        } else {
          this.ctx.log.warn(`Multiple ADB devices, no localhost match — using ${chosen}. ` +
            `Devices: ${online.join(", ")}`);
        }
      }
      this.adbSerial = chosen;

      this.adbSerialExpiry = now + AndroidEngine.ADB_SERIAL_TTL_MS;
      return this.adbSerial;
    } catch (err) {
      this.ctx.log.debug("resolveAdbSerial failed", { err: String(err) });
      return null;
    }
  }

  /** Build ADB shell args with serial selection for multi-device environments */
  adbShellArgs(...shellArgs: string[]): string[] {
    const serial = this.resolveAdbSerial();
    const args: string[] = [];
    if (serial) args.push("-s", serial);
    args.push("shell", ...shellArgs);
    return args;
  }

  /** Invalidate cached ADB serial — call after ADB connect/disconnect */
  invalidateAdbSerial(): void {
    this.adbSerial = null;
    this.adbSerialExpiry = 0;
  }

  // -- ADB fix ----------------------------------------------------------------

  /**
   * Run the ADB connect script bounded by `timeoutS`, WITHOUT blocking the
   * event loop. Mirrors the old `spawnSync('timeout', [timeoutS, script])`
   * (the `timeout` wrapper enforces the bound; a hard SIGKILL 5s later is a
   * backstop) but via async `spawn` so the daemon stays responsive during
   * the connect.
   *
   * This is load-bearing: the previous synchronous `spawnSync` froze the
   * daemon's single event loop for the entire connect. After a reboot the
   * stale ADB endpoint stretched that to ~2.5 minutes, during which NO IPC
   * could be served — so `operad stream` reported a spurious "IPC request
   * timed out" (90s client timeout) even though boot ultimately succeeded.
   */
  private runConnectScript(
    script: string,
    timeoutS: number,
  ): Promise<{ status: number | null; stderr: string }> {
    return new Promise((resolve) => {
      let stderr = "";
      let settled = false;
      const finish = (status: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardKill);
        resolve({ status, stderr });
      };
      const child = spawn("timeout", [String(timeoutS), script], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      // Backstop in case `timeout` itself wedges — kill 5s past its budget.
      const hardKill = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }, (timeoutS + 5) * 1000);
      child.stderr?.on("data", (d) => { stderr += d.toString(); });
      child.on("error", (err) => { stderr ||= String(err); finish(1); });
      child.on("close", (code) => finish(code));
    });
  }

  /** Attempt ADB connection and apply phantom process killer fix */
  async fixAdb(): Promise<boolean> {
    this.ctx.log.info("Attempting ADB connection for phantom process fix");

    const { connect_script, connect_timeout_s, phantom_fix } = this.ctx.config.adb;

    try {
      const result = await this.runConnectScript(connect_script, connect_timeout_s);

      if (result.status !== 0) {
        this.ctx.log.warn("ADB connection failed", { stderr: result.stderr.trim() });
        this.ctx.state.setAdbFixed(false);
        detectPlatform().notify("operad boot", "ADB fix failed — processes may be killed", "operad-boot");

        // Set up retry timer
        this.startAdbRetryTimer();
        return false;
      }

      this.ctx.log.info("ADB connected");
      // Clear cached serial so it's re-resolved with the new connection
      this.adbSerial = null;
      this.adbSerialExpiry = 0;

      if (phantom_fix) {
        this.applyPhantomFix();
      }

      this.ctx.state.setAdbFixed(true);
      return true;
    } catch (err) {
      this.ctx.log.error(`ADB fix error: ${err}`);
      this.ctx.state.setAdbFixed(false);
      this.startAdbRetryTimer();
      return false;
    }
  }

  /**
   * The kernel's per-boot UUID for THIS device, or null if unreadable.
   *
   * /proc/sys/kernel/random/boot_id is world-readable on Android (unlike
   * ro.serialno, which returns empty to unprivileged callers since Android 10,
   * and /proc/uptime, which is permission-denied to apps). It is regenerated
   * every boot and differs between machines, which makes it an exact identity
   * check rather than a heuristic.
   */
  private localBootId(): string | null {
    try {
      const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
      return id || null;
    } catch {
      return null;
    }
  }

  /** The same UUID read over ADB from `serial`, or null if unreadable. */
  private remoteBootId(serial: string): string | null {
    try {
      const r = spawnSync(
        ADB_BIN,
        ["-s", serial, "shell", "cat", "/proc/sys/kernel/random/boot_id"],
        { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (r.status !== 0) return null;
      // adb shell returns CRLF line endings.
      const id = (r.stdout ?? "").replace(/\r/g, "").trim();
      return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * Is the resolved ADB device the machine operad is running on?
   *
   * This used to answer "yes" whenever exactly one device was online — "single
   * device: must be this device". That is simply untrue: a phone running
   * operad in Termux with one other phone attached over wireless debugging has
   * exactly one device in `adb devices`, and it is the OTHER one. Verified on
   * the author's setup, where operad runs on an SM-S938U1 while the sole ADB
   * device is a different handset — so the phantom-process fix was being
   * applied to, and app lists were being read from, somebody else's phone.
   *
   * Identity is now established by comparing the kernel boot UUID, and the
   * function fails CLOSED: if identity cannot be established, the answer is
   * no. Applying settings or force-stopping apps on an unknown device is far
   * worse than skipping the optimisation.
   */
  isLocalAdbDevice(): boolean {
    const serial = this.resolveAdbSerial();
    if (!serial) return false;

    // A loopback connection can only be this device.
    if (
      serial.startsWith("127.0.0.1:") ||
      serial.startsWith("localhost:") ||
      serial.startsWith("emulator-")
    ) return true;

    // Exact check: same kernel boot UUID means same running kernel.
    const local = this.localBootId();
    if (local) {
      const remote = this.remoteBootId(serial);
      if (remote) return remote.toLowerCase() === local.toLowerCase();
      // Remote unreadable — fall through to the weaker IP check.
    }

    // Fallback: the serial's host part matches one of our own addresses.
    const localIp = this.getLocalIp();
    if (localIp && serial.startsWith(`${localIp}:`)) return true;

    // Nothing established identity. Fail closed.
    this.ctx.log.debug(
      `ADB device '${serial}' could not be confirmed as this device — treating as external`,
    );
    return false;
  }

  /**
   * Describe the resolved ADB target for the UI: which device, and whether it
   * is this one. Lets surfaces that list apps or processes say whose they are
   * instead of silently showing another handset's.
   */
  adbTargetInfo(): {
    serial: string | null;
    is_local: boolean;
    model: string | null;
  } {
    const serial = this.resolveAdbSerial();
    if (!serial) return { serial: null, is_local: false, model: null };
    let model: string | null = null;
    try {
      const r = spawnSync(ADB_BIN, ["-s", serial, "shell", "getprop", "ro.product.model"], {
        encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
      });
      if (r.status === 0) model = (r.stdout ?? "").replace(/\r/g, "").trim() || null;
    } catch { /* best effort */ }
    return { serial, is_local: this.isLocalAdbDevice(), model };
  }

  /**
   * Apply Android 12+ process protection fixes via ADB.
   * Mirrors ALL the protections from the old tasker/startup.sh:
   * 1. Phantom process killer disable (device_config + settings)
   * 2. Doze whitelist (deviceidle) for Termux + Edge
   * 3. Active standby bucket for Termux + Edge
   * 4. Background execution allow for Termux + Edge
   */
  applyPhantomFix(): void {
    // Safety check: only apply settings to this device, not external phones
    if (!this.isLocalAdbDevice()) {
      const serial = this.resolveAdbSerial();
      this.ctx.log.warn(`Skipping phantom fix — ADB device '${serial}' may not be this device`);
      return;
    }

    // Per-protection failure accumulator. Each entry is "<protection>: <reason>".
    // Used to emit a single summary line at the end, instead of pretending the
    // whole stack succeeded. Critical failures (oom_score_adj write rejected
    // because adb shell can't write another app's /proc on Android 14+) escalate
    // to warn so they actually surface in the log.
    const failures: string[] = [];

    /**
     * Run an ADB shell command and verify it actually succeeded. spawnSync's
     * default failure mode is silent — if the binary exits non-zero, the only
     * signal is `result.status`. We capture stdout/stderr too so we can include
     * the device's error message in the warn.
     */
    const runAdbVerified = (
      label: string,
      args: string[],
      severity: "warn" | "debug" = "warn",
    ): { ok: boolean; stdout: string; stderr: string; status: number | null } => {
      let result;
      try {
        result = spawnSync(ADB_BIN, this.adbShellArgs(...args), {
          encoding: "utf-8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        failures.push(`${label}: spawn failed (${err})`);
        if (severity === "warn") this.ctx.log.warn(`${label} failed`, { error: String(err) });
        return { ok: false, stdout: "", stderr: String(err), status: null };
      }
      const stdout = (result.stdout ?? "").trim();
      const stderr = (result.stderr ?? "").trim();
      // ADB exits 0 even when the underlying shell command errored. Many of
      // these commands signal failure by emitting text on stderr (or stdout
      // containing "Error:"/"Permission denied"/"Exception"). Treat any of
      // those as a failure.
      const looksError =
        result.status !== 0 ||
        /(\bError\b|\bException\b|Permission denied|not allowed|Bad command|Unknown command|Failure)/i.test(stderr) ||
        /(\bError\b|\bException\b|Permission denied|not allowed|Bad command|Unknown command|Failure)/i.test(stdout);
      if (looksError) {
        const detail = stderr || stdout || `exit=${result.status}`;
        failures.push(`${label}: ${detail.split("\n")[0].slice(0, 160)}`);
        if (severity === "warn") {
          this.ctx.log.warn(`${label} failed`, { detail: detail.slice(0, 240) });
        } else {
          this.ctx.log.debug(`${label} failed: ${detail.slice(0, 240)}`);
        }
        return { ok: false, stdout, stderr, status: result.status ?? null };
      }
      return { ok: true, stdout, stderr, status: result.status ?? 0 };
    };

    // 1. Phantom process killer disable
    runAdbVerified("phantom: device_config max_phantom_processes",
      ["/system/bin/device_config", "put", "activity_manager", "max_phantom_processes", "2147483647"]);
    runAdbVerified("phantom: settings_enable_monitor_phantom_procs",
      ["settings", "put", "global", "settings_enable_monitor_phantom_procs", "false"]);

    const protectedPkgs = ["com.termux", "com.microsoft.emmx.canary"];

    // 2. Doze whitelist
    for (const pkg of protectedPkgs) {
      runAdbVerified(`doze whitelist +${pkg}`,
        ["cmd", "deviceidle", "whitelist", `+${pkg}`]);
    }

    // 3. Active standby bucket
    for (const pkg of protectedPkgs) {
      runAdbVerified(`standby ${pkg}=ACTIVE`,
        ["am", "set-standby-bucket", pkg, "active"]);
    }

    // 4. Background execution
    for (const pkg of protectedPkgs) {
      runAdbVerified(`appops ${pkg} RUN_ANY_IN_BACKGROUND`,
        ["cmd", "appops", "set", pkg, "RUN_ANY_IN_BACKGROUND", "allow"]);
    }

    // 5. OOM score adjustment. On Android 14+ the adb-shell uid usually can't
    // write another app's /proc/<pid>/oom_score_adj — this WILL fail there
    // with "Permission denied". That's a meaningful protection gap, so warn
    // (don't bury at debug) and let `operad doctor` surface it.
    //
    // Avoid `sh -c "pidof X | head -1"` — adb-shell's pipe handling is flaky
    // and returns empty stdout intermittently. Call `pidof` directly and pick
    // the first PID client-side (multiple PIDs would mean two app processes,
    // which Termux generally doesn't have).
    const pidResult = runAdbVerified("oom_score_adj: pidof com.termux",
      ["pidof", "com.termux"], "debug");
    const termuxPid = pidResult.stdout.trim().split(/\s+/)[0];
    if (termuxPid && /^\d+$/.test(termuxPid)) {
      runAdbVerified(`oom_score_adj: write -200 to /proc/${termuxPid}/oom_score_adj`,
        ["sh", "-c", `echo -200 > /proc/${termuxPid}/oom_score_adj`]);
    } else {
      failures.push("oom_score_adj: could not resolve com.termux PID");
    }

    // 6. Set-inactive false
    for (const pkg of protectedPkgs) {
      runAdbVerified(`set-inactive ${pkg}=false`,
        ["cmd", "activity", "set-inactive", pkg, "false"]);
    }

    // 7. Lower LMK trigger level
    runAdbVerified("lmk: low_power_trigger_level=1",
      ["settings", "put", "global", "low_power_trigger_level", "1"]);

    // Re-enable Samsung sensor packages (best-effort; non-Samsung devices skip silently)
    const samsungPkgs = [
      "com.samsung.android.ssco",
      "com.samsung.android.mocca",
      "com.samsung.android.camerasdkservice",
    ];
    for (const pkg of samsungPkgs) {
      // debug severity — these only exist on Samsung; fail on Pixel/etc. is expected
      runAdbVerified(`pm enable ${pkg}`, ["pm", "enable", pkg], "debug");
    }

    if (failures.length === 0) {
      this.ctx.log.info("Android process protection: all 7 layers applied successfully");
    } else {
      this.ctx.log.warn(
        `Android process protection: ${failures.length} command(s) failed — see warnings above. Run 'operad doctor' to verify which protections are actually in effect.`,
      );
    }
  }

  // -- ADB retry timer --------------------------------------------------------

  /** Start a periodic ADB retry timer — no-op if already running */
  startAdbRetryTimer(): void {
    if (this.adbRetryTimer) return;
    const intervalMs = this.ctx.config.adb.retry_interval_s * 1000;
    this.adbRetryTimer = setInterval(async () => {
      if (this.ctx.state.getState().adb_fixed) {
        // Already fixed — stop retrying
        if (this.adbRetryTimer) {
          clearInterval(this.adbRetryTimer);
          this.adbRetryTimer = null;
        }
        return;
      }
      this.ctx.log.info("Retrying ADB connection...");
      const success = await this.fixAdb();
      if (success && this.adbRetryTimer) {
        clearInterval(this.adbRetryTimer);
        this.adbRetryTimer = null;
      }
    }, intervalMs);
  }

  /** Clear the ADB retry timer — call from daemon shutdown() */
  stopRetryTimer(): void {
    if (this.adbRetryTimer) {
      clearInterval(this.adbRetryTimer);
      this.adbRetryTimer = null;
    }
  }

  // -- Auto-stop list ---------------------------------------------------------

  /** Load auto-stop package list from disk — call once on daemon boot */
  loadAutoStopList(): void {
    try {
      const raw = readFileSync(AndroidEngine.AUTOSTOP_PATH, "utf-8");
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        this.autoStopPkgs = new Set(list.filter((s: unknown) => typeof s === "string"));
      }
    } catch {
      // File doesn't exist or is invalid — start empty
      this.autoStopPkgs = new Set();
    }
  }

  /** Persist auto-stop package list to disk */
  private saveAutoStopList(): void {
    try {
      writeFileSync(AndroidEngine.AUTOSTOP_PATH, JSON.stringify([...this.autoStopPkgs], null, 2) + "\n");
    } catch (err) {
      this.ctx.log.warn("Failed to save autostop list", { error: String(err) });
    }
  }

  /** Get auto-stop list for the REST API */
  getAutoStopList(): { packages: string[] } {
    return { packages: [...this.autoStopPkgs] };
  }

  /** Toggle a package in the auto-stop list, persisting to disk */
  toggleAutoStop(pkg: string): { status: number; data: unknown } {
    if (!pkg || !pkg.includes(".")) {
      return { status: 400, data: { error: "Invalid package name" } };
    }
    if (AndroidEngine.SYSTEM_PACKAGES.has(pkg)) {
      return { status: 403, data: { error: `Cannot auto-stop system package: ${pkg}` } };
    }
    const enabled = !this.autoStopPkgs.has(pkg);
    if (enabled) {
      this.autoStopPkgs.add(pkg);
    } else {
      this.autoStopPkgs.delete(pkg);
    }
    this.saveAutoStopList();
    this.ctx.log.info(`Auto-stop ${enabled ? "enabled" : "disabled"} for ${pkg}`);
    return { status: 200, data: { pkg, autostop: enabled } };
  }

  /** Force-stop all auto-stop flagged apps — called during memory pressure */
  autoStopFlaggedApps(): void {
    if (this.autoStopPkgs.size === 0) return;
    // Same local-target guard as forceStopApp: this fires automatically on
    // memory pressure, so without it a second attached device gets its apps
    // killed by pressure on this one.
    if (!this.isLocalAdbDevice()) {
      this.ctx.log.warn("Skipping auto-stop: adb target is not this device");
      return;
    }
    const stopped: string[] = [];
    for (const pkg of this.autoStopPkgs) {
      if (AndroidEngine.SYSTEM_PACKAGES.has(pkg)) continue;
      // The persisted list can predate validation, so re-check on use.
      if (!AndroidEngine.isValidPackageName(pkg)) {
        this.ctx.log.warn(`Skipping auto-stop of invalid package name: ${pkg}`);
        continue;
      }
      try {
        const result = spawnSync(ADB_BIN, this.adbShellArgs("am", "force-stop", pkg), {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.status === 0) stopped.push(pkg);
      } catch {
        // Best-effort — skip failures
      }
    }
    if (stopped.length > 0) {
      const labels = stopped.map((p) => AndroidEngine.APP_LABELS[p] || p);
      this.ctx.log.info(`Auto-stopped ${labels.join(", ")} on memory pressure`);
    }
  }

  // -- Android app management -------------------------------------------------

  /**
   * List Android apps via `adb shell ps`, grouped by base package.
   * Merges sandboxed/privileged child processes into the parent total.
   */
  getAndroidApps(): { pkg: string; label: string; rss_mb: number; system: boolean; autostop: boolean }[] {
    // Never present another handset's processes as this device's. With one
    // other phone attached over wireless debugging, `adb devices` has exactly
    // one entry and it is not this machine — so this list silently showed the
    // wrong device's memory usage, and the kill button next to each row acted
    // on it.
    if (!this.isLocalAdbDevice()) {
      this.ctx.log.debug("Skipping app list — ADB target is not this device");
      return [];
    }
    try {
      const result = spawnSync(ADB_BIN, this.adbShellArgs("ps", "-A", "-o", "PID,RSS,NAME"), {
        encoding: "utf-8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0 || !result.stdout) {
        this.ctx.log.warn("adb ps failed", {
          status: result.status,
          stderr: result.stderr?.trim().slice(0, 200),
          hasStdout: !!result.stdout,
          args: this.adbShellArgs("ps", "-A", "-o", "PID,RSS,NAME").join(" "),
        });
        return [];
      }

      // Aggregate RSS by base package name (strip :sandboxed_process*, :privileged_process*, etc.)
      const pkgMap = new Map<string, number>();
      for (const line of result.stdout.trim().split("\n")) {
        const match = line.trim().match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) continue;
        const rssKb = parseInt(match[2], 10);
        const rawName = match[3].trim();
        if (rssKb < 1024) continue; // Skip < 1MB (aggregate later)

        // Extract base package: "com.foo.bar:sandboxed_process0:..." → "com.foo.bar"
        const basePkg = rawName.split(":")[0];
        // Only include Android package names (at least 2 dots, e.g. com.foo.bar)
        const dotCount = (basePkg.match(/\./g) || []).length;
        if (dotCount < 2 && !AndroidEngine.APP_LABELS[basePkg]) continue;
        // Skip zygote/isolated processes — they're OS-level, not user apps
        if (basePkg.endsWith("_zygote") || basePkg.startsWith("com.android.isolated")) continue;

        pkgMap.set(basePkg, (pkgMap.get(basePkg) ?? 0) + rssKb);
      }

      const apps: { pkg: string; label: string; rss_mb: number; system: boolean; autostop: boolean }[] = [];
      for (const [pkg, rssKb] of pkgMap) {
        const rssMb = Math.round(rssKb / 1024);
        if (rssMb < 50) continue; // Skip apps using < 50MB after aggregation
        const system = AndroidEngine.SYSTEM_PACKAGES.has(pkg);
        // Derive a readable label: known name > last meaningful segment > raw package
        const label = AndroidEngine.APP_LABELS[pkg] ?? AndroidEngine.deriveLabel(pkg);
        apps.push({ pkg, label, rss_mb: rssMb, system, autostop: this.autoStopPkgs.has(pkg) });
      }

      apps.sort((a, b) => b.rss_mb - a.rss_mb);
      return apps;
    } catch (err) {
      this.ctx.log.warn("getAndroidApps exception", { error: String(err) });
      return [];
    }
  }

  /** Derive a human-readable label from a package name */
  static deriveLabel(pkg: string): string {
    const parts = pkg.split(".");
    // Skip common prefixes: com, org, net, android, google, samsung, sec, app, apps
    const skip = new Set(["com", "org", "net", "android", "google", "samsung", "sec", "app", "apps", "software"]);
    const meaningful = parts.filter((p) => !skip.has(p) && p.length > 1);
    // Capitalize the last meaningful segment
    const name = meaningful.length > 0 ? meaningful[meaningful.length - 1] : parts[parts.length - 1];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  /** Force-stop an Android app via ADB */
  /**
   * Launch the user-facing activity of an Android app.
   *
   * Accepts either a package name (`com.termux.x11`) or a fully-qualified
   * component (`com.termux.x11/.MainActivity`). For package-only inputs we
   * prefer ADB's `monkey ... LAUNCHER 1` because it correctly resolves the
   * launcher activity, and fall back to `am start -n <pkg>/.MainActivity`
   * (the most common pattern, works directly from the Termux uid) if ADB
   * isn't connected or monkey returns non-zero.
   *
   * Used by the dashboard "Launch app" button on session rows whose config
   * declares a `launch_package`.
   */
  launchApp(target: string): { status: number; data: unknown } {
    if (!target || !target.includes(".")) {
      return { status: 400, data: { error: "Invalid package or component" } };
    }
    // A component spec is `<pkg>/<activity>`; a bare target is a package. Both
    // halves reach a device shell via `adb shell monkey`, so validate each.
    const slash = target.indexOf("/");
    if (slash === -1) {
      if (!AndroidEngine.isValidPackageName(target)) {
        return { status: 400, data: { error: "Invalid package name" } };
      }
    } else {
      const pkgPart = target.slice(0, slash);
      const actPart = target.slice(slash + 1);
      if (
        !AndroidEngine.isValidPackageName(pkgPart)
        || !/^[A-Za-z0-9_.$]+$/.test(actPart)
        || actPart.length === 0
      ) {
        return { status: 400, data: { error: "Invalid component spec" } };
      }
    }
    if (slash !== -1) {
      // Caller provided an explicit component spec.
      const result = spawnSync("am", ["start", "-n", target], {
        encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status === 0) {
        this.ctx.log.info(`Launched ${target} via am start`);
        return { status: 200, data: { ok: true, target, via: "am" } };
      }
      return { status: 500, data: { error: result.stderr?.trim() || "am start failed", target } };
    }

    const pkg = target;
    if (AndroidEngine.SYSTEM_PACKAGES.has(pkg)) {
      return { status: 403, data: { error: `Cannot launch system package: ${pkg}` } };
    }

    // Preferred path: monkey via ADB resolves the launcher activity and
    // delivers the intent as the shell user, which works for apps that
    // reject intents from the Termux uid.
    if (this.resolveAdbSerial()) {
      try {
        const result = spawnSync(ADB_BIN, this.adbShellArgs(
          "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1",
        ), { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
        if (result.status === 0 && !(result.stderr ?? "").includes("Error")) {
          this.ctx.log.info(`Launched ${pkg} via adb monkey`);
          return { status: 200, data: { ok: true, target: pkg, via: "monkey" } };
        }
      } catch (err) {
        this.ctx.log.debug(`monkey launch threw: ${err}`);
        /* fall through to am fallback */
      }
    }

    // Fallback: assume <pkg>/.MainActivity. Works for the common case where
    // the launcher activity follows the standard naming convention.
    const fallback = `${pkg}/.MainActivity`;
    const result = spawnSync("am", ["start", "-n", fallback], {
      encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      this.ctx.log.info(`Launched ${pkg} via am ${fallback} fallback`);
      return { status: 200, data: { ok: true, target: pkg, via: "am-fallback" } };
    }
    return {
      status: 500,
      data: {
        error: result.stderr?.trim() || "monkey + am fallback both failed",
        target: pkg,
      },
    };
  }

  /**
   * Is this a syntactically valid Android package name?
   *
   * The only check was `pkg.includes(".")`. That matters because `adb shell`
   * concatenates the remote argv and runs it through the DEVICE's /system/bin/sh
   * — so argv separation on our side does not prevent injection on theirs. A
   * package of `com.x;id>/data/local/tmp/pwn` executed as uid shell (2000),
   * which is a privilege escalation relative to the Termux uid operad runs as.
   * `POST /api/autostop/<pkg>` also persisted such a value and replayed it on
   * every memory-pressure event.
   */
  static isValidPackageName(pkg: string): boolean {
    return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(pkg) && pkg.length <= 255;
  }

  /**
   * Refuse app-control operations unless the adb target is this device.
   *
   * `applyPhantomFix` already guarded with isLocalAdbDevice(), but none of the
   * force-stop / launch / auto-stop paths did. resolveSerialFromList falls back
   * to the first online device, so with a second phone attached over USB,
   * memory pressure here issued `am force-stop` on THAT phone.
   */
  private assertLocalTarget(action: string): { status: number; data: unknown } | null {
    if (this.isLocalAdbDevice()) return null;
    // Name the device — "not this device" alone leaves the user guessing which
    // handset was about to be acted on.
    const info = this.adbTargetInfo();
    const who = info.model ?? info.serial ?? "unknown device";
    this.ctx.log.warn(`Refusing ${action}: adb target '${who}' is not this device`);
    return {
      status: 409,
      data: { error: `Refusing ${action} — adb is connected to '${who}', not the device running operad` },
    };
  }

  forceStopApp(pkg: string): { status: number; data: unknown } {
    if (!AndroidEngine.isValidPackageName(pkg)) {
      return { status: 400, data: { error: "Invalid package name" } };
    }
    if (AndroidEngine.SYSTEM_PACKAGES.has(pkg)) {
      return { status: 403, data: { error: `Cannot stop system package: ${pkg}` } };
    }
    const notLocal = this.assertLocalTarget(`force-stop ${pkg}`);
    if (notLocal) return notLocal;

    try {
      const result = spawnSync(ADB_BIN, this.adbShellArgs("am", "force-stop", pkg), {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        return { status: 500, data: { error: result.stderr?.trim() || "force-stop failed" } };
      }
      this.ctx.log.info(`Force-stopped ${pkg} via dashboard`);
      return { status: 200, data: { ok: true, pkg } };
    } catch (err) {
      return { status: 500, data: { error: `Failed to stop ${pkg}: ${(err as Error).message}` } };
    }
  }
}
