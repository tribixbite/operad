/**
 * title-cache.ts — remember each transcript's last `/rename`, so boot does
 * not re-read every recent transcript to find it.
 *
 * Boot restores sessions the user renamed in Claude Code by looking for the
 * LAST `custom-title` entry in each recently active transcript. Finding the
 * last one is cheap when it exists (walk backwards, stop at the first hit),
 * but proving a transcript has NONE means reading it to its start — and
 * most transcripts have none. That was ~4.8 s at every boot on a phone.
 *
 * Transcripts are append-only, so a per-file record of how far it was
 * scanned and what was found makes every later lookup proportional to what
 * was added since:
 *
 *  - same size and mtime  → the cached answer, no read at all;
 *  - grown                → scan only the bytes after the last complete
 *                           line seen before (a rename there wins);
 *  - shrunk or rewritten  → full rescan.
 *
 * The cache is a small JSON file beside the daemon's state, and is pruned
 * to the transcripts looked up in the current run when saved, so it never
 * holds more than one boot's worth of entries.
 */

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { completeLinesEnd, forEachJsonlLine } from "./jsonl-lines.js";

/** What is remembered about one transcript. */
interface TitleCacheEntry {
  size: number;
  mtimeMs: number;
  /** Offset just past the last complete line already scanned. */
  scannedTo: number;
  /** The last rename found so far, or null for none. */
  title: string | null;
}

/** On-disk shape. `version` lets a future format be ignored rather than misread. */
interface TitleCacheFile {
  version: 1;
  entries: Record<string, TitleCacheEntry>;
}

/** Title of a `custom-title` line, or null for any other line. */
function parseCustomTitle(line: string): string | null {
  if (!line.includes("custom-title")) return null;
  try {
    const entry = JSON.parse(line) as { type?: unknown; customTitle?: unknown };
    return entry.type === "custom-title" && typeof entry.customTitle === "string" && entry.customTitle
      ? entry.customTitle
      : null;
  } catch {
    return null;
  }
}

/** Is a parsed value a usable cache entry? Guards against a hand-edited or foreign file. */
function isEntry(v: unknown): v is TitleCacheEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.size === "number" && typeof e.mtimeMs === "number" && typeof e.scannedTo === "number"
    && (e.title === null || typeof e.title === "string");
}

export class TranscriptTitleCache {
  private entries: Record<string, TitleCacheEntry> = {};
  /** Transcripts looked up in this run — the only ones `save` keeps. */
  private seen = new Set<string>();

  /** @param store cache file path, or null for an in-memory-only cache. */
  constructor(private readonly store: string | null) {
    if (store === null) return;
    try {
      const parsed = JSON.parse(readFileSync(store, "utf-8")) as Partial<TitleCacheFile>;
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        for (const [path, entry] of Object.entries(parsed.entries)) {
          if (isEntry(entry)) this.entries[path] = entry;
        }
      }
    } catch {
      // Missing or unreadable: start empty. The cache only saves time.
    }
  }

  /** The transcript's most recent `custom-title`, or null if it has none. */
  lastCustomTitle(path: string): string | null {
    let st;
    try {
      st = statSync(path);
    } catch {
      delete this.entries[path];
      return null;
    }
    if (!st.isFile()) return null;
    this.seen.add(path);

    const cached = this.entries[path];
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.title;

    let title: string | null;
    if (cached && st.size > cached.size && cached.scannedTo <= st.size) {
      // Appended since: only the new bytes can hold a newer rename.
      title = cached.title;
      forEachJsonlLine(path, (line) => {
        const t = parseCustomTitle(line);
        if (t !== null) title = t;
      }, { start: cached.scannedTo });
    } else {
      // First sight, or the file shrank / was rewritten: walk back from the
      // end and stop at the first (= most recent) rename.
      title = null;
      forEachJsonlLine(path, (line) => {
        const t = parseCustomTitle(line);
        if (t === null) return;
        title = t;
        return false;
      }, { reverse: true });
    }

    this.entries[path] = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      scannedTo: completeLinesEnd(path, st.size),
      title,
    };
    return title;
  }

  /**
   * Persist the entries looked up this run (atomically: write a temp file,
   * then rename over the store). Best effort — a failed save only costs the
   * next boot a rescan.
   */
  save(): void {
    if (this.store === null) return;
    const kept: Record<string, TitleCacheEntry> = {};
    for (const path of this.seen) {
      const e = this.entries[path];
      if (e) kept[path] = e;
    }
    const body: TitleCacheFile = { version: 1, entries: kept };
    const tmp = `${this.store}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(body));
      renameSync(tmp, this.store);
    } catch {
      // Unwritable state dir: next boot rescans.
    }
  }
}
