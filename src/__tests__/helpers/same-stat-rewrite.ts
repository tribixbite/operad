/**
 * Fixtures for tests of code that skips re-reading a file whose size and
 * mtime are unchanged (TranscriptTitleCache and its callers).
 *
 * Such a test changes a file's bytes behind the cache's back and puts size
 * and mtime back. The mtime can only be put back exactly when it is a whole
 * number of seconds: `utimes` takes seconds as a double, while ext4, APFS and
 * NTFS (the CI runners) stamp a freshly written file with nanoseconds, a value
 * a double cannot carry at today's epoch. Restoring such an mtime moves it by
 * a fraction of a millisecond, so `mtimeMs` differs and the cache rightly
 * rescans. (On this Termux device the tests passed anyway, which hid it.)
 */
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";

/** A whole-second Unix time (2026-09-21), exact on every filesystem. */
const PINNED_MTIME_S = 1_790_000_000;

/** Set a file's atime and mtime to a whole second so they can be restored exactly. */
export function pinMtime(path: string): void {
  utimesSync(path, PINNED_MTIME_S, PINNED_MTIME_S);
}

/** Write a file and pin its mtime (see {@link pinMtime}). */
export function writePinned(path: string, content: string): void {
  writeFileSync(path, content);
  pinMtime(path);
}

/**
 * Replace `from` with an equal-length `to` in a file, keeping its size and
 * mtime, so only a re-read can notice. The file's mtime must have been pinned.
 */
export function rewriteKeepingStat(path: string, from: string, to: string): void {
  if (to.length !== from.length) {
    throw new Error(`rewriteKeepingStat: "${to}" must be as long as "${from}" to keep the size`);
  }
  const before = statSync(path);
  if (before.mtimeMs % 1000 !== 0) {
    throw new Error(`rewriteKeepingStat: ${path} has a sub-second mtime; create it with writePinned() or pinMtime()`);
  }
  writeFileSync(path, readFileSync(path, "utf-8").replace(from, to));
  utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000);
}
