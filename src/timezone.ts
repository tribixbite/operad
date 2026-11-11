/**
 * timezone.ts — make "local time" the device's time zone.
 *
 * operad does several things in local time: cron schedules fire at
 * wall-clock times, and token / cost history is bucketed by local calendar
 * day. On Termux the daemon runs under bun, which does not read Android's
 * time zone and falls back to UTC (Termux's node does read it), so on the
 * phone all of that was silently UTC — a "9am" job ran at 05:00 EDT, and
 * the cost chart's days ended at 8pm.
 *
 * At startup, if the environment does not set TZ, operad asks the platform
 * for the zone and sets it. bun and node both honour a TZ assigned at
 * runtime. An explicit TZ always wins.
 */

/** True when `zone` is a time zone this runtime can use. */
export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Set `env.TZ` from `detect()` when it is unset or empty.
 *
 * @returns the zone now in effect, or null when none could be determined
 *          (TZ is then left untouched and the runtime default applies).
 */
export function applyLocalTimezone(
  env: Record<string, string | undefined>,
  detect: () => string | null,
): string | null {
  if (env.TZ) return env.TZ;
  let zone: string | null;
  try {
    zone = detect();
  } catch {
    return null;
  }
  if (!zone || !isValidTimeZone(zone)) return null;
  env.TZ = zone;
  return zone;
}
