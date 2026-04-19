/**
 * adb-routes.ts — ADB device management REST API route handlers.
 *
 * Handles GET /api/adb, POST /api/adb/connect,
 * POST /api/adb/disconnect, and POST /api/adb/disconnect/:serial.
 *
 * Extracted from RestHandler (rest-handler.ts) as part of domain split.
 */

import { spawnSync } from "node:child_process";
import type { OrchestratorContext } from "../orchestrator-context.js";
import { detectPlatform } from "../platform/platform.js";

/** Resolve ADB binary path via platform abstraction */
const ADB_BIN = detectPlatform().resolveAdbPath() ?? "adb";

/**
 * AdbRoutes — handles ADB device listing, wireless connect, and disconnect.
 */
export class AdbRoutes {
  constructor(private readonly ctx: OrchestratorContext) {}

  /** List connected ADB devices */
  getAdbDevices(): { devices: { serial: string; state: string }[] } {
    try {
      const result = spawnSync(ADB_BIN, ["devices"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0 || !result.stdout) return { devices: [] };
      const devices = result.stdout
        .split("\n")
        .slice(1)
        .filter((l) => l.includes("\t"))
        .map((l) => {
          const [serial, state] = l.split("\t");
          return { serial: serial.trim(), state: state.trim() };
        });
      return { devices };
    } catch (err) {
      this.ctx.log.warn("getAdbDevices failed", { err: String(err) });
      return { devices: [] };
    }
  }

  /** Initiate ADB wireless connection using the adbc script */
  adbWirelessConnect(): { status: number; data: unknown } {
    const script = this.ctx.config.adb.connect_script;
    if (!script) {
      return { status: 400, data: { error: "adb.connect_script not configured" } };
    }
    try {
      const result = spawnSync("bash", [script], {
        encoding: "utf-8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: process.env.PATH },
      });
      const output = (result.stdout ?? "") + (result.stderr ?? "");
      if (output.includes("connected") || output.includes("Reconnected")) {
        this.ctx.invalidateAdbSerial();
        return { status: 200, data: { ok: true, message: output.trim().split("\n").pop() } };
      }
      return { status: 500, data: { ok: false, message: output.trim().split("\n").pop() || "Connection failed" } };
    } catch (err) {
      return { status: 500, data: { ok: false, message: (err as Error).message } };
    }
  }

  /** Disconnect all ADB devices */
  adbDisconnectAll(): { status: number; data: unknown } {
    try {
      spawnSync(ADB_BIN, ["disconnect", "-a"], { timeout: 5000, stdio: "ignore" });
      this.ctx.invalidateAdbSerial();
      return { status: 200, data: { ok: true } };
    } catch (err) {
      return { status: 500, data: { ok: false, message: (err as Error).message } };
    }
  }

  /** Disconnect a specific ADB device by serial */
  adbDisconnectDevice(serial: string): { status: number; data: unknown } {
    try {
      const result = spawnSync(ADB_BIN, ["disconnect", serial], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.ctx.invalidateAdbSerial();
      const output = (result.stdout ?? "").trim();
      return { status: 200, data: { ok: true, serial, message: output } };
    } catch (err) {
      return { status: 500, data: { ok: false, message: (err as Error).message } };
    }
  }
}
