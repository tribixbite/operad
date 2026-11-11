/**
 * jsonl-lines.ts — read a line-oriented file (JSONL transcripts, history,
 * logs) lazily, forward or backward, without loading it into memory.
 *
 * Shared by every module that scans Claude Code's files. Split out of
 * claude-session.ts so lower-level modules (the title cache, the registry)
 * can use it without importing the whole transcript layer.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/** Chunk size for both line readers. */
const LINE_CHUNK_SIZE = 65536;

/**
 * Yield a file's non-empty lines newest-first, lazily.
 *
 * Splits on the `\n` BYTE and only decodes complete lines. Decoding each
 * 64 KB chunk independently — what the previous inline reader did — cuts
 * multi-byte UTF-8 sequences at the boundary and replaces them with U+FFFD,
 * silently corrupting one character every chunk.
 *
 * Laziness is the point: the caller stops when it has what it needs, so a
 * deep `beforeUuid` cursor keeps reading instead of giving up after a fixed
 * window (the old reader collected `limit * 10` lines and then searched them
 * for the cursor — once paging reached beyond that, every further page came
 * back empty with `has_more: true`, so the viewer could not page back more
 * than a few hundred entries no matter how long the conversation was).
 */
export function* readLinesBackward(fd: number, size: number): Generator<string> {
  let offset = size;
  // Bytes of a line whose start lies in a chunk we have not read yet.
  // Explicitly typed: `subarray()` widens to Buffer<ArrayBufferLike>, which
  // the Buffer<ArrayBuffer> inferred from `alloc()` would reject.
  let carry: Buffer = Buffer.alloc(0);

  while (offset > 0) {
    const readSize = Math.min(LINE_CHUNK_SIZE, offset);
    offset -= readSize;
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, offset);
    const combined = carry.length > 0 ? Buffer.concat([buf, carry]) : buf;

    const segments: Buffer[] = [];
    let start = 0;
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] === 0x0a) {
        segments.push(combined.subarray(start, i));
        start = i + 1;
      }
    }
    segments.push(combined.subarray(start));

    // The first segment is only a complete line once we're at the file start.
    carry = offset > 0 ? (segments.shift() ?? Buffer.alloc(0)) : Buffer.alloc(0);

    for (let i = segments.length - 1; i >= 0; i--) {
      const line = segments[i].toString("utf-8").trim();
      if (line) yield line;
    }
  }

  if (carry.length > 0) {
    const line = carry.toString("utf-8").trim();
    if (line) yield line;
  }
}

/**
 * Yield a file's non-empty lines oldest-first, lazily. Byte-level split for
 * the same reason as `readLinesBackward`.
 */
export function* readLinesForward(fd: number, size: number, start = 0): Generator<string> {
  let offset = start;
  // Bytes of a line whose end lies in a chunk we have not read yet.
  let carry: Buffer = Buffer.alloc(0);

  while (offset < size) {
    const readSize = Math.min(LINE_CHUNK_SIZE, size - offset);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, offset);
    offset += readSize;
    const combined = carry.length > 0 ? Buffer.concat([carry, buf]) : buf;

    let start = 0;
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] === 0x0a) {
        const line = combined.subarray(start, i).toString("utf-8").trim();
        start = i + 1;
        if (line) yield line;
      }
    }
    carry = combined.subarray(start);
  }

  if (carry.length > 0) {
    const line = carry.toString("utf-8").trim();
    if (line) yield line;
  }
}

/**
 * Visit a JSONL file's non-empty lines without loading it into memory.
 *
 * `reverse` walks newest-first. `visit` returning `false` stops the walk, so
 * a caller that wants the last N of something reads only the tail.
 *
 * Transcripts here run to tens of megabytes (2.8 GB across 459 files on the
 * author's machine), and `readFileSync(...).split("\n")` costs the file
 * twice over in V8 strings. On a phone whose low-memory killer is already
 * taking processes, a boot-time scan that does that for every recently
 * active session is a self-inflicted memory spike.
 */
export function forEachJsonlLine(
  path: string,
  visit: (line: string) => boolean | void,
  opts: { reverse?: boolean; start?: number } = {},
): void {
  if (!existsSync(path)) return;
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (!st.isFile() || st.size === 0) return;

  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    // `start` (forward only) resumes a scan at a byte offset — the end of a
    // previously-read line — so an append-only file is read once.
    const lines = opts.reverse
      ? readLinesBackward(fd, st.size)
      : readLinesForward(fd, st.size, Math.min(Math.max(opts.start ?? 0, 0), st.size));
    for (const line of lines) {
      if (visit(line) === false) return;
    }
  } catch { /* unreadable — treat as empty */ } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

/**
 * Byte offset just past the last newline in the first `size` bytes of a
 * file: where the last COMPLETE line ends. A scan that resumes here re-reads
 * a line that was still being written when the previous scan ran, instead of
 * skipping it forever. 0 when there is no newline (or the file is unreadable).
 */
export function completeLinesEnd(path: string, size: number): number {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    let end = size;
    while (end > 0) {
      const len = Math.min(LINE_CHUNK_SIZE, end);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, end - len);
      const nl = buf.lastIndexOf(0x0a);
      if (nl >= 0) return end - len + nl + 1;
      end -= len;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}
