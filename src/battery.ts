/**
 * battery.ts — Cross-platform battery monitoring
 *
 * Reads battery status via platform abstraction (Termux:API, sysfs, pmset, etc.).
 * When battery drops below a configurable threshold (default 10%) and is NOT
 * charging, disables radios (on supported platforms) and sends a notification.
 */

import type { Logger } from "./log.js";
import { detectPlatform } from "./platform/platform.js";

/** Battery status snapshot */
export interface BatteryStatus {
  /** Battery level 0-100 */
  percentage: number;
  /** Whether device is plugged in / charging */
  charging: boolean;
  /** Temperature in Celsius */
  temperature: number;
  /** Health string (platform-specific) */
  health: string;
}

/** Actions already taken — prevents repeated toggling */
interface BatteryActionState {
  /** Whether low-battery actions (wifi/data off) have been applied */
  actionsApplied: boolean;
  /** Last percentage when actions were applied */
  appliedAtPct: number;
  /** Timestamp of last action */
  appliedAt: number;
}

/** What `checkAndAct` should do this cycle, given current status + prior state */
export type BatteryAction = "trigger" | "clear" | "none";

/** Hysteresis margin (percentage points above threshold) required to re-enable radios */
export const BATTERY_HYSTERESIS_PCT = 5;

/**
 * Decide the low-battery action from current status, threshold, and whether
 * protective actions are already applied. Pure — no IO, no side effects.
 *
 * - "trigger": battery at/below threshold, NOT charging, not already applied.
 * - "clear":   already applied, now charging AND recovered strictly above
 *              threshold + {@link BATTERY_HYSTERESIS_PCT} (avoids flapping).
 * - "none":    steady state — nothing to do.
 */
export function batteryActionDecision(
  status: BatteryStatus,
  thresholdPct: number,
  actionsApplied: boolean,
): BatteryAction {
  if (!actionsApplied && status.percentage <= thresholdPct && !status.charging) {
    return "trigger";
  }
  if (actionsApplied && status.charging &&
      status.percentage > thresholdPct + BATTERY_HYSTERESIS_PCT) {
    return "clear";
  }
  return "none";
}

export class BatteryMonitor {
  private log: Logger;
  private lowThresholdPct: number;
  private actionState: BatteryActionState = {
    actionsApplied: false,
    appliedAtPct: 0,
    appliedAt: 0,
  };

  constructor(log: Logger, lowThresholdPct = 10) {
    this.log = log;
    this.lowThresholdPct = lowThresholdPct;
  }

  /** Update threshold (e.g. from config reload) */
  setThreshold(pct: number): void {
    this.lowThresholdPct = pct;
  }

  /** Read current battery status via platform abstraction */
  getBatteryStatus(): BatteryStatus | null {
    const plat = detectPlatform();
    const info = plat.getBatteryStatus();
    if (!info) return null;

    return {
      percentage: info.percentage,
      charging: info.charging,
      temperature: info.temperature,
      health: info.health,
    };
  }

  /**
   * Check battery and take action if below threshold.
   * Returns the battery status, or null if unavailable.
   * Only takes action (disable radios) when:
   * - Battery is below threshold
   * - Device is NOT charging
   * - Actions haven't already been applied at this level
   */
  checkAndAct(): BatteryStatus | null {
    const status = this.getBatteryStatus();
    if (!status) return null;

    const plat = detectPlatform();
    const action = batteryActionDecision(status, this.lowThresholdPct, this.actionState.actionsApplied);

    if (action === "trigger") {
      this.log.warn(`Battery critically low: ${status.percentage}% (threshold: ${this.lowThresholdPct}%), not charging — disabling radios`, {
        battery_pct: status.percentage,
        charging: status.charging,
      });
      plat.disableRadios();
      plat.sendBatteryAlert(status.percentage);
      this.actionState = {
        actionsApplied: true,
        appliedAtPct: status.percentage,
        appliedAt: Date.now(),
      };
    } else if (action === "clear") {
      this.log.info(`Battery recovered to ${status.percentage}% and charging — re-enabling radios`);
      plat.enableRadios();
      this.actionState.actionsApplied = false;
    }

    return status;
  }

  /** Whether low-battery actions are currently in effect */
  get actionsActive(): boolean {
    return this.actionState.actionsApplied;
  }
}
