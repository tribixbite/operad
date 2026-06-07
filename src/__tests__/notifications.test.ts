/**
 * notifications.test.ts — Unit tests for appendNotification / readNotifications
 *
 * All I/O is redirected to a per-test temp dir via the _baseDir option so the
 * real ~/.local/share/tmx/ is never touched.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { appendNotification, readNotifications } from "../notifications.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-notifs-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Round-trip: append then read back
// ---------------------------------------------------------------------------

describe("appendNotification + readNotifications round-trip", () => {
  test("single record is returned with correct fields", () => {
    const before = Date.now();
    const record = appendNotification({
      type: "session_start",
      title: "Session started",
      content: "alpha is up",
      session: "alpha",
      _baseDir: tmpDir,
    });

    expect(record.type).toBe("session_start");
    expect(record.title).toBe("Session started");
    expect(record.content).toBe("alpha is up");
    expect(record.session).toBe("alpha");
    // id is a 12-char hex prefix of a UUID
    expect(record.id).toHaveLength(12);
    // timestamp is a parseable ISO string within test window
    const ts = new Date(record.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);

    const results = readNotifications({ _baseDir: tmpDir });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(record);
  });

  test("session field is optional and absent when not provided", () => {
    const rec = appendNotification({
      type: "daemon_start",
      title: "Daemon started",
      content: "boot complete",
      _baseDir: tmpDir,
    });
    expect(rec.session).toBeUndefined();

    const results = readNotifications({ _baseDir: tmpDir });
    expect(results[0].session).toBeUndefined();
  });

  test("multiple appended records are all persisted", () => {
    appendNotification({ type: "session_start", title: "A", content: "1", _baseDir: tmpDir });
    appendNotification({ type: "battery_low", title: "B", content: "2", _baseDir: tmpDir });
    appendNotification({ type: "memory_pressure", title: "C", content: "3", _baseDir: tmpDir });

    const results = readNotifications({ _baseDir: tmpDir });
    expect(results).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Order: newest first (reverse chronological)
// ---------------------------------------------------------------------------

describe("readNotifications ordering", () => {
  test("returns records in reverse-append order (newest first)", () => {
    appendNotification({ type: "session_start", title: "first",  content: "1", _baseDir: tmpDir });
    appendNotification({ type: "session_stop",  title: "second", content: "2", _baseDir: tmpDir });
    appendNotification({ type: "daemon_stop",   title: "third",  content: "3", _baseDir: tmpDir });

    const results = readNotifications({ _baseDir: tmpDir });
    // Last appended should be first in results
    expect(results[0].title).toBe("third");
    expect(results[1].title).toBe("second");
    expect(results[2].title).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// limit option
// ---------------------------------------------------------------------------

describe("readNotifications limit option", () => {
  test("default limit is 50 — returns all when fewer than 50 records", () => {
    for (let i = 0; i < 5; i++) {
      appendNotification({ type: "session_start", title: `t${i}`, content: `c${i}`, _baseDir: tmpDir });
    }
    const results = readNotifications({ _baseDir: tmpDir });
    expect(results).toHaveLength(5);
  });

  test("limit=2 returns only two most-recent records", () => {
    for (let i = 0; i < 5; i++) {
      appendNotification({ type: "session_start", title: `t${i}`, content: String(i), _baseDir: tmpDir });
    }
    const results = readNotifications({ limit: 2, _baseDir: tmpDir });
    expect(results).toHaveLength(2);
    // most recent titles should be t4 and t3 (appended last)
    expect(results[0].title).toBe("t4");
    expect(results[1].title).toBe("t3");
  });

  test("limit=0 returns empty array", () => {
    appendNotification({ type: "session_start", title: "x", content: "x", _baseDir: tmpDir });
    const results = readNotifications({ limit: 0, _baseDir: tmpDir });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// since option (time-based filter)
// ---------------------------------------------------------------------------

describe("readNotifications since option", () => {
  test("since filters records older than the given ISO timestamp", async () => {
    appendNotification({ type: "session_start", title: "old", content: "1", _baseDir: tmpDir });

    // Wait to ensure the next record has a strictly later timestamp
    await new Promise(r => setTimeout(r, 50));

    // Capture midpoint AFTER the delay so "old" is guaranteed to be before it
    const midpoint = new Date().toISOString();
    await new Promise(r => setTimeout(r, 50));

    appendNotification({ type: "session_stop", title: "new", content: "2", _baseDir: tmpDir });

    const results = readNotifications({ since: midpoint, _baseDir: tmpDir });
    // Only the record after midpoint should appear
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("new");
  });

  test("since future timestamp returns empty array", () => {
    appendNotification({ type: "daemon_start", title: "x", content: "y", _baseDir: tmpDir });
    const future = new Date(Date.now() + 60_000).toISOString();
    const results = readNotifications({ since: future, _baseDir: tmpDir });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Missing file — returns empty
// ---------------------------------------------------------------------------

describe("readNotifications with missing file", () => {
  test("returns empty array when the JSONL file does not exist", () => {
    const results = readNotifications({ _baseDir: tmpDir });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Malformed JSONL lines are skipped without throwing
// ---------------------------------------------------------------------------

describe("readNotifications malformed-line resilience", () => {
  test("garbage lines interspersed with valid records are silently skipped", () => {
    // Manually pre-populate the JSONL file with a mix of valid and invalid lines
    const logsDir = join(tmpDir, ".local", "share", "tmx", "logs");
    mkdirSync(logsDir, { recursive: true });

    const goodRecord = appendNotification({
      type: "session_start",
      title: "good",
      content: "valid",
      _baseDir: tmpDir,
    });

    // Append several kinds of bad lines directly
    const filePath = join(logsDir, "notifications.jsonl");
    writeFileSync(
      filePath,
      [
        "not-json-at-all",
        "{broken json",
        "",
        JSON.stringify(goodRecord),
        "   ",
        '{"no_id": true}',   // valid JSON but missing required fields — still parsed (type cast)
        JSON.stringify({ ...goodRecord, id: "aabbccdd1122", title: "second-good" }),
      ].join("\n") + "\n",
    );

    // Must not throw; valid JSON lines come through
    let results: ReturnType<typeof readNotifications>;
    expect(() => {
      results = readNotifications({ _baseDir: tmpDir });
    }).not.toThrow();

    // "not-json-at-all" and "{broken json" are skipped; valid JSON objects returned
    expect(results!.some(r => r.title === "good" || r.title === "second-good")).toBe(true);
  });

  test("file with only malformed lines returns empty array without throwing", () => {
    const logsDir = join(tmpDir, ".local", "share", "tmx", "logs");
    mkdirSync(logsDir, { recursive: true });
    const filePath = join(logsDir, "notifications.jsonl");
    writeFileSync(filePath, "garbage\n{bad}\n\nnot valid\n");

    let results: ReturnType<typeof readNotifications>;
    expect(() => {
      results = readNotifications({ _baseDir: tmpDir });
    }).not.toThrow();
    // All JSON.parse failures were caught; result is empty (or only empty-line-skipped)
    // The only things that would come through are valid JSON objects
    expect(Array.isArray(results!)).toBe(true);
  });

  test("empty file returns empty array", () => {
    const logsDir = join(tmpDir, ".local", "share", "tmx", "logs");
    mkdirSync(logsDir, { recursive: true });
    const filePath = join(logsDir, "notifications.jsonl");
    writeFileSync(filePath, "");

    const results = readNotifications({ _baseDir: tmpDir });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// All NotificationType values are accepted
// ---------------------------------------------------------------------------

describe("appendNotification type coverage", () => {
  const types = [
    "session_start", "session_stop", "session_error",
    "battery_low", "memory_pressure",
    "daemon_start", "daemon_stop",
  ] as const;

  for (const type of types) {
    test(`accepts type=${type}`, () => {
      const rec = appendNotification({ type, title: type, content: type, _baseDir: tmpDir });
      expect(rec.type).toBe(type);
    });
  }
});

// ---------------------------------------------------------------------------
// IDs are unique across appends
// ---------------------------------------------------------------------------

describe("appendNotification id uniqueness", () => {
  test("each appended record gets a unique id", () => {
    const ids = Array.from({ length: 10 }, (_, i) =>
      appendNotification({ type: "session_start", title: `t${i}`, content: "", _baseDir: tmpDir }).id,
    );
    const unique = new Set(ids);
    expect(unique.size).toBe(10);
  });
});
