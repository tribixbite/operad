/**
 * telemetry-sink.test.ts — Tests for TelemetrySinkServer + inferSdk
 *
 * Covers:
 *   1. inferSdk — SDK classification rules for every known SDK + fallbacks
 *   2. Ring buffer — accumulation, cap enforcement, SDK filter
 *   3. Stat counters — totalCount, per-SDK, per_hour calculation
 *   4. JSONL logging — records are flushed to disk with correct shape
 *   5. Log rotation — old file renamed when rotate_at_bytes exceeded
 *   6. onRecordCaptured callback — fires for every captured request
 *   7. start / stop lifecycle — server binds and releases the port
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";

import { inferSdk, TelemetrySinkServer } from "../telemetry-sink.js";
import type { TelemetrySinkConfig } from "../types.js";
import type { Logger } from "../log.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLog(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

/** Default config — small ring buffer + tiny rotation threshold for easy testing */
function makeConfig(overrides: Partial<TelemetrySinkConfig> = {}): TelemetrySinkConfig {
  return {
    enabled: true,
    port: 0, // unused in unit tests; http tests pick an ephemeral port
    max_body_bytes: 4096,
    ring_buffer_size: 10,
    rotate_at_bytes: 10 * 1024 * 1024,
    ...overrides,
  };
}

/** Find a free TCP port by letting the OS bind to :0 */
async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** POST a minimal HTTP request to the sink and return the status code */
async function post(port: number, path = "/collect", host = "127.0.0.1", body = ""): Promise<number> {
  return new Promise((resolve, reject) => {
    const http = require("node:http") as typeof import("node:http");
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST",
        headers: { host, "content-length": Buffer.byteLength(body) } },
      (res) => {
        res.resume(); // drain
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "operad-tel-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// 1. inferSdk — classification rules
// ---------------------------------------------------------------------------

describe("inferSdk — known SDK rules", () => {
  test("Microsoft Aria via host", () => {
    expect(inferSdk("events.data.microsoft.com", "/")).toBe("aria");
  });

  test("Microsoft Aria via msn subdomain host", () => {
    expect(inferSdk("browser.events.data.msn.com", "/data")).toBe("aria");
  });

  test("OneCollector via path matches regardless of request casing", () => {
    // inferSdk lower-cases the path and the rule matches the lower-case literal,
    // so a mixed-case "/OneCollector/2.0" resolves to onecollector (not the
    // analytics catch-all).
    expect(inferSdk("127.0.0.1", "/OneCollector/2.0")).toBe("onecollector");
  });

  test("OneCollector via self.events host wins over the general aria rule", () => {
    // "self.events.data.microsoft.com" also contains "events.data.microsoft.com"
    // (the aria host match), but the specific self.events rule is ordered first,
    // so onecollector wins.
    expect(inferSdk("self.events.data.microsoft.com", "/")).toBe("onecollector");
  });

  test("Adjust via host", () => {
    expect(inferSdk("app.adjust.com", "/session")).toBe("adjust");
  });

  test("Adjust via path", () => {
    expect(inferSdk("127.0.0.1", "/adjust/session")).toBe("adjust");
  });

  test("App Center via host", () => {
    expect(inferSdk("in.appcenter.ms", "/logs")).toBe("appcenter");
  });

  test("ECS via config.edge.skype.com host", () => {
    expect(inferSdk("config.edge.skype.com", "/")).toBe("ecs");
  });

  test("ECS via ecs. prefix host", () => {
    expect(inferSdk("ecs.microsoftmetrics.com", "/")).toBe("ecs");
  });

  test("Vortex via host", () => {
    expect(inferSdk("vortex.data.microsoft.com", "/collect")).toBe("vortex");
  });

  test("Google analytics via google-analytics.com host", () => {
    expect(inferSdk("www.google-analytics.com", "/collect")).toBe("google");
  });

  test("Google via googleapis.com host", () => {
    expect(inferSdk("safebrowsing.googleapis.com", "/v4")).toBe("google");
  });

  test("Google via googletagmanager host", () => {
    expect(inferSdk("www.googletagmanager.com", "/gtag/js")).toBe("google");
  });

  test("Rewards via host", () => {
    expect(inferSdk("rewardsplatform.microsoft.com", "/v1/events")).toBe("rewards");
  });

  test("WebXT via host", () => {
    expect(inferSdk("webxtsvc.microsoft.com", "/edge")).toBe("webxt");
  });

  test("generic analytics via 'analytics' in path", () => {
    expect(inferSdk("127.0.0.1", "/browser_analytics")).toBe("analytics");
  });

  test("generic analytics via 'telemetry' in path", () => {
    expect(inferSdk("127.0.0.1", "/edge/telemetry/v1")).toBe("analytics");
  });

  test("generic analytics via 'collect' in path", () => {
    expect(inferSdk("127.0.0.1", "/collect/events")).toBe("analytics");
  });

  test("unknown host + unrecognised path returns 'unknown'", () => {
    expect(inferSdk("totally-random.example.com", "/just/a/path")).toBe("unknown");
  });

  test("rule matching is case-insensitive on both host and path", () => {
    expect(inferSdk("EVENTS.DATA.MICROSOFT.COM", "/")).toBe("aria");
  });

  test("a /OneCollector path on an aria host classifies as onecollector", () => {
    // The /onecollector path rule is ordered before the general aria host rule,
    // and OneCollector is the actual ingestion endpoint, so the path wins.
    expect(inferSdk("events.data.microsoft.com", "/OneCollector")).toBe("onecollector");
  });

  test("plain aria host with a non-OneCollector path stays aria", () => {
    expect(inferSdk("events.data.microsoft.com", "/v1/track")).toBe("aria");
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Ring buffer, stat counters — via HTTP POST to a live sink
// ---------------------------------------------------------------------------

describe("TelemetrySinkServer — ring buffer + counters", () => {
  test("getStats starts with zero counts and empty startedAt", () => {
    const srv = new TelemetrySinkServer(makeConfig(), tmpDir, silentLog());
    const stats = srv.getStats();
    expect(stats.total).toBe(0);
    expect(stats.started_at).toBe("");
  });

  test("getRecent returns empty array before any records", () => {
    const srv = new TelemetrySinkServer(makeConfig(), tmpDir, silentLog());
    expect(srv.getRecent()).toEqual([]);
  });

  test("captures records via HTTP POST and updates totalCount", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port }), tmpDir, silentLog());
    await srv.start();
    try {
      await post(port, "/collect", "events.data.microsoft.com");
      await post(port, "/collect", "vortex.data.microsoft.com");

      const stats = srv.getStats();
      expect(stats.total).toBe(2);
    } finally {
      srv.stop();
    }
  });

  test("per-SDK counters accumulate correctly", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port }), tmpDir, silentLog());
    await srv.start();
    try {
      await post(port, "/", "events.data.microsoft.com");
      await post(port, "/", "events.data.microsoft.com");
      await post(port, "/", "vortex.data.microsoft.com");

      const stats = srv.getStats();
      expect(stats.by_sdk["aria"]).toBe(2);
      expect(stats.by_sdk["vortex"]).toBe(1);
    } finally {
      srv.stop();
    }
  });

  test("ring buffer respects ring_buffer_size cap — oldest records evicted", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port, ring_buffer_size: 3 }), tmpDir, silentLog());
    await srv.start();
    try {
      for (let i = 0; i < 5; i++) {
        await post(port, `/path${i}`, "127.0.0.1");
      }
      const records = srv.getRecent(100);
      // Buffer capped at 3; total is still 5
      expect(records.length).toBe(3);
      expect(srv.getStats().total).toBe(5);
      // Oldest three evicted — only last three paths remain
      const paths = records.map((r) => r.path);
      expect(paths).toContain("/path4");
      expect(paths).toContain("/path3");
      expect(paths).toContain("/path2");
      expect(paths).not.toContain("/path0");
    } finally {
      srv.stop();
    }
  });

  test("getRecent SDK filter returns only matching records", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port }), tmpDir, silentLog());
    await srv.start();
    try {
      await post(port, "/", "events.data.microsoft.com");
      await post(port, "/", "vortex.data.microsoft.com");
      await post(port, "/", "events.data.microsoft.com");

      const ariaOnly = srv.getRecent(100, "aria");
      expect(ariaOnly.length).toBe(2);
      expect(ariaOnly.every((r) => r.sdk === "aria")).toBe(true);
    } finally {
      srv.stop();
    }
  });

  test("getRecent limit parameter constrains result count", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port, ring_buffer_size: 20 }), tmpDir, silentLog());
    await srv.start();
    try {
      for (let i = 0; i < 10; i++) {
        await post(port, "/", "127.0.0.1");
      }
      expect(srv.getRecent(3).length).toBe(3);
    } finally {
      srv.stop();
    }
  });

  test("per_hour rate is positive after at least one request", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port }), tmpDir, silentLog());
    await srv.start();
    try {
      await post(port, "/", "127.0.0.1");
      const stats = srv.getStats();
      expect(stats.per_hour).toBeGreaterThan(0);
    } finally {
      srv.stop();
    }
  });

  test("sink always responds 200 OK regardless of body content", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port }), tmpDir, silentLog());
    await srv.start();
    try {
      const status = await post(port, "/anything", "127.0.0.1", "not-valid-json");
      expect(status).toBe(200);
    } finally {
      srv.stop();
    }
  });

  test("body_bytes is recorded even when body exceeds max_body_bytes", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port, max_body_bytes: 10 }), tmpDir, silentLog());
    await srv.start();
    try {
      const bigBody = "x".repeat(200);
      await post(port, "/", "127.0.0.1", bigBody);
      const [rec] = srv.getRecent(1);
      // body_bytes reflects actual bytes sent (tracked regardless of cap)
      expect(rec.body_bytes).toBe(200);
      // body_preview is capped at max_body_bytes (10 bytes)
      expect(rec.body_preview.length).toBeLessThanOrEqual(10);
    } finally {
      srv.stop();
    }
  });

  test("record has correct shape — all required fields present", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port }), tmpDir, silentLog());
    await srv.start();
    try {
      await post(port, "/collect", "adjust.com", "hello");
      const [rec] = srv.getRecent(1);
      expect(typeof rec.ts).toBe("string");
      expect(rec.method).toBe("POST");
      expect(rec.path).toBe("/collect");
      expect(rec.host).toBe("adjust.com");
      expect(rec.sdk).toBe("adjust");
      expect(typeof rec.body_bytes).toBe("number");
    } finally {
      srv.stop();
    }
  });

  test("onRecordCaptured callback fires for each captured request", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port }), tmpDir, silentLog());
    const captured: string[] = [];
    srv.onRecordCaptured((rec) => captured.push(rec.sdk));
    await srv.start();
    try {
      await post(port, "/", "events.data.microsoft.com");
      await post(port, "/", "vortex.data.microsoft.com");
      // Small wait for async event handlers to fire
      await new Promise((r) => setTimeout(r, 50));
      expect(captured).toEqual(["aria", "vortex"]);
    } finally {
      srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. JSONL logging
// ---------------------------------------------------------------------------

describe("TelemetrySinkServer — JSONL log", () => {
  test("writes a valid JSONL record to disk for each request", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port }), tmpDir, silentLog());
    await srv.start();
    try {
      await post(port, "/collect", "adjust.com");
      // Brief flush time
      await new Promise((r) => setTimeout(r, 50));
      const logPath = join(tmpDir, "telemetry.jsonl");
      expect(existsSync(logPath)).toBe(true);
      const line = readFileSync(logPath, "utf-8").trim().split("\n")[0];
      const parsed = JSON.parse(line);
      expect(parsed.sdk).toBe("adjust");
      expect(parsed.method).toBe("POST");
      expect(typeof parsed.ts).toBe("string");
    } finally {
      srv.stop();
    }
  });

  test("appends multiple records as separate JSONL lines", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port }), tmpDir, silentLog());
    await srv.start();
    try {
      await post(port, "/a", "adjust.com");
      await post(port, "/b", "vortex.data.microsoft.com");
      await new Promise((r) => setTimeout(r, 80));
      const lines = readFileSync(join(tmpDir, "telemetry.jsonl"), "utf-8")
        .trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(2);
      const sdks = lines.map((l) => JSON.parse(l).sdk);
      expect(sdks).toContain("adjust");
      expect(sdks).toContain("vortex");
    } finally {
      srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Log rotation
// ---------------------------------------------------------------------------

describe("TelemetrySinkServer — log rotation", () => {
  test("rotates the JSONL file when it exceeds rotate_at_bytes", async () => {
    const port = await freePort();
    // Tiny rotation threshold (1 byte — guaranteed to trigger after first write)
    const srv = new TelemetrySinkServer(makeConfig({ port, rotate_at_bytes: 1 }), tmpDir, silentLog());
    await srv.start();
    try {
      // Seed the log file so it already exists and is non-empty before the second request
      const logPath = join(tmpDir, "telemetry.jsonl");
      writeFileSync(logPath, '{"ts":"seed"}\n');

      await post(port, "/a", "127.0.0.1");
      await new Promise((r) => setTimeout(r, 80));

      // The original file should have been rotated to .1
      expect(existsSync(`${logPath}.1`)).toBe(true);
      // Current log file should exist and contain only the new record(s)
      expect(existsSync(logPath)).toBe(true);
    } finally {
      srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Server lifecycle
// ---------------------------------------------------------------------------

describe("TelemetrySinkServer — start / stop lifecycle", () => {
  test("stop() without start() does not throw", () => {
    const srv = new TelemetrySinkServer(makeConfig(), tmpDir, silentLog());
    expect(() => srv.stop()).not.toThrow();
  });

  test("started_at is set after start()", async () => {
    const port = await freePort();
    const srv = new TelemetrySinkServer(makeConfig({ port }), tmpDir, silentLog());
    await srv.start();
    try {
      const stats = srv.getStats();
      expect(stats.started_at).not.toBe("");
      // Must be a valid ISO timestamp
      expect(() => new Date(stats.started_at)).not.toThrow();
      expect(isNaN(new Date(stats.started_at).getTime())).toBe(false);
    } finally {
      srv.stop();
    }
  });

  test("creating the server creates the log dir if absent", () => {
    const subDir = join(tmpDir, "nested", "logdir");
    // subDir does NOT exist yet
    new TelemetrySinkServer(makeConfig(), subDir, silentLog());
    expect(existsSync(subDir)).toBe(true);
  });
});
