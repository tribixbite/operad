/**
 * Tiny formatting helpers used by the customization panels — file size,
 * mtime, and a copy-path-to-clipboard utility used by the path icon
 * that replaces the wide path column in the panel tables.
 */

const HOME_PREFIX = "/data/data/com.termux/files/home/";

/** Render a fs path with $HOME collapsed to ~/. */
export function shortenHomePath(p: string): string {
  if (p.startsWith(HOME_PREFIX)) return "~/" + p.slice(HOME_PREFIX.length);
  return p;
}

/**
 * Render a byte count as a 1-3 char label: "412 B", "8.4 KB", "1.2 MB".
 * Uses base-1024 because the storage backing on Termux is filesystem-backed.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Render an mtime in epoch ms as a relative-or-short label depending on age.
 * "now"/"5m ago"/"3h ago" for the last day, "Apr 26" for older within the
 * year, "2025-12-04" for prior years. Avoids loading a full i18n stack —
 * everything in the dashboard is already English-only.
 */
export function formatRelativeTime(epochMs: number | null | undefined): string {
  if (!epochMs) return "—";
  const now = Date.now();
  const diff = now - epochMs;
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return "now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  // Older than a week — switch to absolute date.
  const d = new Date(epochMs);
  const now2 = new Date();
  if (d.getFullYear() === now2.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Copy text to the clipboard. Returns true on success. Used by the
 * path-icon button so users can lift a file path into their terminal
 * without us having to display the full path on screen.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  // Fallback for older browsers / non-secure contexts.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
