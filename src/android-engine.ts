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

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectPlatform } from "./platform/platform.js";
import type { OrchestratorContext } from "./orchestrator-context.js";

/** Resolve ADB binary path at module load time — same pattern as daemon.ts */
const ADB_BIN = detectPlatform().resolveAdbPath() ?? "adb";

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

      const lines = result.stdout.split("\n").filter((l) => l.includes("\t"));
      const online: string[] = [];
      const stale: string[] = [];

      for (const line of lines) {
        const [serial, state] = line.split("\t");
        if (state?.trim() === "device") {
          online.push(serial.trim());
        } else if (state?.trim() === "offline" || state?.trim() === "unauthorized") {
          stale.push(serial.trim());
        }
      }

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
      if (online.length > 1) {
        const localIp = this.getLocalIp();
        const localhost = online.find((s) =>
          s.startsWith("127.0.0.1:") ||
          s.startsWith("localhost:") ||
          (localIp && s.startsWith(`${localIp}:`))
        );
        if (localhost) {
          this.ctx.log.debug(`Multiple ADB devices, preferring localhost: ${localhost}`);
          this.adbSerial = localhost;
        } else {
          this.ctx.log.warn(`Multiple ADB devices, no localhost match — using ${online[0]}. ` +
            `Devices: ${online.join(", ")}`);
          this.adbSerial = online[0];
        }
      } else {
        this.adbSerial = online[0];
      }

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

  /** Attempt ADB connection and apply phantom process killer fix */
  async fixAdb(): Promise<boolean> {
    this.ctx.log.info("Attempting ADB connection for phantom process fix");

    const { connect_script, connect_timeout_s, phantom_fix } = this.ctx.config.adb;

    try {
      const result = spawnSync("timeout", [String(connect_timeout_s), connect_script], {
        encoding: "utf-8",
        timeout: (connect_timeout_s + 5) * 1000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (result.status !== 0) {
        this.ctx.log.warn("ADB connection failed", { stderr: result.stderr?.trim() });
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
   * Verify the resolved ADB device is this device (not an external phone).
   * When only one device is connected, it must be this device — skip IP matching.
   * IP matching is only needed when multiple devices are online to disambiguate.
   */
  isLocalAdbDevice(): boolean {
    const serial = this.resolveAdbSerial();
    if (!serial) return false;

    // Localhost connections are always local
    if (serial.startsWith("127.0.0.1:") || serial.startsWith("localhost:")) return true;

    // Count online devices to decide if IP matching is needed
    try {
      const result = spawnSync(ADB_BIN, ["devices"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const onlineCount = (result.stdout ?? "")
        .split("\n")
        .filter((l) => l.includes("\tdevice")).length;

      // Single device: must be this device — no need for IP matching
      if (onlineCount === 1) return true;

      // Multiple devices: fall through to IP check
    } catch { /* fall through to IP check */ }

    // Check if serial IP matches local IP (multi-device disambiguation)
    const localIp = this.getLocalIp();
    if (localIp && serial.startsWith(`${localIp}:`)) return true;

    // Serial doesn't match any local address — might be an external device
    return false;
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

    // 1. Phantom process killer fix
    const phantomCmds = [
      ["/system/bin/device_config", "put", "activity_manager", "max_phantom_processes", "2147483647"],
      ["settings", "put", "global", "settings_enable_monitor_phantom_procs", "false"],
    ];

    // 2. Doze whitelist — prevent Android from suspending these apps
    const dozeWhitelistPkgs = ["com.termux", "com.microsoft.emmx.canary"];

    // 3. Active standby bucket — prevent throttling
    const standbyPkgs = ["com.termux", "com.microsoft.emmx.canary"];

    // 4. Background execution — allow running in background unconditionally
    const bgPkgs = ["com.termux", "com.microsoft.emmx.canary"];

    // Apply phantom process fixes
    for (const cmd of phantomCmds) {
      try {
        spawnSync(ADB_BIN, this.adbShellArgs(...cmd), { timeout: 10_000, stdio: "ignore" });
      } catch (err) {
        this.ctx.log.warn(`Phantom fix command failed: ${cmd.join(" ")}`, { error: String(err) });
      }
    }

    // Apply Doze whitelist
    for (const pkg of dozeWhitelistPkgs) {
      try {
        spawnSync(ADB_BIN, this.adbShellArgs("cmd", "deviceidle", "whitelist", `+${pkg}`), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch (err) {
        this.ctx.log.warn(`Doze whitelist failed for ${pkg}`, { error: String(err) });
      }
    }

    // Apply active standby bucket
    for (const pkg of standbyPkgs) {
      try {
        spawnSync(ADB_BIN, this.adbShellArgs("am", "set-standby-bucket", pkg, "active"), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch (err) {
        this.ctx.log.warn(`Standby bucket failed for ${pkg}`, { error: String(err) });
      }
    }

    // Allow background execution
    for (const pkg of bgPkgs) {
      try {
        spawnSync(ADB_BIN, this.adbShellArgs("cmd", "appops", "set", pkg, "RUN_ANY_IN_BACKGROUND", "allow"), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch (err) {
        this.ctx.log.warn(`Background allow failed for ${pkg}`, { error: String(err) });
      }
    }

    // 5. OOM score adjustment — make Termux less likely to be killed by LMK
    // oom_score_adj ranges from -1000 (never kill) to 1000 (kill first).
    // -200 is moderate — enough to survive pressure spikes without starving
    // foreground apps. Logcat shows Termux main process already at adj=0
    // (foreground), so this mainly protects against transient demotion.
    try {
      // Get Termux's main PID from the app process
      const pidResult = spawnSync(ADB_BIN, this.adbShellArgs(
        "sh", "-c", "pidof com.termux | head -1",
      ), { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
      const termuxPid = pidResult.stdout?.trim();
      if (termuxPid && /^\d+$/.test(termuxPid)) {
        spawnSync(ADB_BIN, this.adbShellArgs(
          "sh", "-c", `echo -200 > /proc/${termuxPid}/oom_score_adj`,
        ), { timeout: 10_000, stdio: "ignore" });
        this.ctx.log.info(`Set oom_score_adj=-200 for Termux PID ${termuxPid}`);
      }
    } catch (err) {
      this.ctx.log.debug(`oom_score_adj failed (non-critical): ${err}`);
    }

    // 6. Prevent Android from classifying Termux as idle (which triggers restrictions)
    for (const pkg of ["com.termux", "com.microsoft.emmx.canary"]) {
      try {
        spawnSync(ADB_BIN, this.adbShellArgs("cmd", "activity", "set-inactive", pkg, "false"), {
          timeout: 10_000, stdio: "ignore",
        });
      } catch {
        // Non-critical — command may not exist on all Android versions
      }
    }

    // 7. Lower LMK trigger level to reduce aggressive kills under memory pressure
    try {
      spawnSync(ADB_BIN, this.adbShellArgs("settings", "put", "global", "low_power_trigger_level", "1"), {
        timeout: 10_000, stdio: "ignore",
      });
    } catch {
      // Non-critical
    }

    // Re-enable Samsung sensor packages
    const samsungPkgs = [
      "com.samsung.android.ssco",
      "com.samsung.android.mocca",
      "com.samsung.android.camerasdkservice",
    ];
    for (const pkg of samsungPkgs) {
      try {
        spawnSync(ADB_BIN, this.adbShellArgs("pm", "enable", pkg), { timeout: 10_000, stdio: "ignore" });
      } catch {
        // Non-critical
      }
    }

    this.ctx.log.info("Android process protection fixes applied (phantom + doze + standby + background + oom_adj + idle + lmk)");
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
    const stopped: string[] = [];
    for (const pkg of this.autoStopPkgs) {
      if (AndroidEngine.SYSTEM_PACKAGES.has(pkg)) continue;
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
  forceStopApp(pkg: string): { status: number; data: unknown } {
    if (!pkg || !pkg.includes(".")) {
      return { status: 400, data: { error: "Invalid package name" } };
    }
    if (AndroidEngine.SYSTEM_PACKAGES.has(pkg)) {
      return { status: 403, data: { error: `Cannot stop system package: ${pkg}` } };
    }

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
