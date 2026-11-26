/**
 * title-cache.test.ts — the boot-time "has this session been renamed?" scan.
 *
 * `findNamedSessions` must find each recent transcript's LAST `custom-title`
 * entry. A transcript with no rename has to be read to its start to prove
 * that, which cost ~4.8 s at every boot on the development device. The
 * cache remembers, per transcript, how far it was scanned and what it
 * found; transcripts are append-only, so only bytes added since are read.
 *
 * Several tests prove "the file was NOT re-read" by changing bytes in place
 * (same size, mtime restored) and checking the change is not seen.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptTitleCache } from "../title-cache.js";
import { rewriteKeepingStat, writePinned } from "./helpers/same-stat-rewrite.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "operad-titles-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const title = (t: string) => JSON.stringify({ type: "custom-title", customTitle: t }) + "\n";
const msg = (n: number) => JSON.stringify({ type: "user", message: { content: `message ${n}` } }) + "\n";


describe("TranscriptTitleCache", () => {
  test("finds the last rename in a transcript", () => {
    const f = join(dir, "a.jsonl");
    writeFileSync(f, msg(1) + title("first") + msg(2) + title("second") + msg(3));
    expect(new TranscriptTitleCache(null).lastCustomTitle(f)).toBe("second");
  });

  test("no rename → null", () => {
    const f = join(dir, "a.jsonl");
    writeFileSync(f, msg(1) + msg(2));
    expect(new TranscriptTitleCache(null).lastCustomTitle(f)).toBeNull();
  });

  test("an unchanged transcript is answered from the cache, not re-read", () => {
    const f = join(dir, "a.jsonl");
    writePinned(f, msg(1) + title("aaaa") + msg(2));
    const cache = new TranscriptTitleCache(null);
    expect(cache.lastCustomTitle(f)).toBe("aaaa");
    rewriteKeepingStat(f, "aaaa", "bbbb");
    expect(cache.lastCustomTitle(f)).toBe("aaaa");
  });

  test("an appended rename is found by reading only the new bytes", () => {
    const f = join(dir, "a.jsonl");
    writePinned(f, msg(1) + title("aaaa") + msg(2));
    const cache = new TranscriptTitleCache(null);
    expect(cache.lastCustomTitle(f)).toBe("aaaa");
    // Tamper with the already-scanned region; a full rescan would see it.
    rewriteKeepingStat(f, "aaaa", "bbbb");
    appendFileSync(f, msg(3) + title("cccc"));
    expect(cache.lastCustomTitle(f)).toBe("cccc");
  });

  test("appending without a rename keeps the cached title", () => {
    const f = join(dir, "a.jsonl");
    writePinned(f, title("aaaa"));
    const cache = new TranscriptTitleCache(null);
    cache.lastCustomTitle(f);
    rewriteKeepingStat(f, "aaaa", "bbbb");
    appendFileSync(f, msg(9));
    expect(cache.lastCustomTitle(f)).toBe("aaaa");
  });

  test("a rename whose line was half-written at scan time is still found", () => {
    // The writer was mid-line when we scanned: the partial line could not
    // be parsed then, and must be re-read once it is complete.
    const f = join(dir, "a.jsonl");
    const full = title("late");
    writeFileSync(f, msg(1) + full.slice(0, 10));
    const cache = new TranscriptTitleCache(null);
    expect(cache.lastCustomTitle(f)).toBeNull();
    appendFileSync(f, full.slice(10));
    expect(cache.lastCustomTitle(f)).toBe("late");
  });

  test("a transcript that shrank is rescanned from scratch", () => {
    const f = join(dir, "a.jsonl");
    writeFileSync(f, msg(1) + title("aaaa") + msg(2) + msg(3));
    const cache = new TranscriptTitleCache(null);
    expect(cache.lastCustomTitle(f)).toBe("aaaa");
    writeFileSync(f, title("zz"));
    expect(cache.lastCustomTitle(f)).toBe("zz");
  });

  test("a missing transcript → null", () => {
    expect(new TranscriptTitleCache(null).lastCustomTitle(join(dir, "nope.jsonl"))).toBeNull();
  });

  test("persists across daemon runs", () => {
    const f = join(dir, "a.jsonl");
    const store = join(dir, "title-cache.json");
    writePinned(f, msg(1) + title("aaaa"));
    const first = new TranscriptTitleCache(store);
    first.lastCustomTitle(f);
    first.save();
    rewriteKeepingStat(f, "aaaa", "bbbb");
    expect(new TranscriptTitleCache(store).lastCustomTitle(f)).toBe("aaaa");
  });

  test("save keeps only transcripts looked up this run", () => {
    const store = join(dir, "title-cache.json");
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, title("aaaa"));
    writeFileSync(b, title("bbbb"));
    const run1 = new TranscriptTitleCache(store);
    run1.lastCustomTitle(a);
    run1.lastCustomTitle(b);
    run1.save();
    const run2 = new TranscriptTitleCache(store);
    run2.lastCustomTitle(a);
    run2.save();
    expect(Object.keys(JSON.parse(readFileSync(store, "utf-8")).entries)).toEqual([a]);
  });

  test("a corrupt cache file is ignored, not fatal", () => {
    const store = join(dir, "title-cache.json");
    writeFileSync(store, "{nope");
    const f = join(dir, "a.jsonl");
    writeFileSync(f, title("aaaa"));
    expect(new TranscriptTitleCache(store).lastCustomTitle(f)).toBe("aaaa");
  });

  test("a null store never touches the disk", () => {
    const f = join(dir, "a.jsonl");
    writeFileSync(f, title("aaaa"));
    const c = new TranscriptTitleCache(null);
    c.lastCustomTitle(f);
    c.save();
    expect(existsSync(join(dir, "title-cache.json"))).toBe(false);
  });
});
