/**
 * memory-tree.test.ts — per-session RSS covers every pane of the session.
 *
 * The monitor used to root a session's process tree at the first pane of
 * the current window, so processes in other windows were not counted — a
 * second window running a build looked like a small session, and memory
 * shedding picked the wrong victims.
 */

import { describe, test, expect } from "bun:test";
import { MemoryMonitor } from "../memory.js";

const silent = { info() {}, warn() {}, error() {}, debug() {} } as never;

/** pid, ppid, rss_kb — two panes (10, 20), each with a child, one shared grandchild path. */
const PS = [
  { pid: 10, ppid: 1, rss_kb: 1024 },
  { pid: 11, ppid: 10, rss_kb: 2048 },
  { pid: 20, ppid: 1, rss_kb: 1024 },
  { pid: 21, ppid: 20, rss_kb: 4096 },
  { pid: 99, ppid: 1, rss_kb: 8192 }, // unrelated
];

describe("MemoryMonitor.getProcessTreeRss", () => {
  test("sums every root's tree once", () => {
    const m = new MemoryMonitor(silent, undefined, undefined, undefined, { listProcesses: () => PS });
    const r = m.getProcessTreeRss([10, 20]);
    expect(r.process_count).toBe(4);
    expect(r.rss_mb).toBe(Math.round((1024 + 2048 + 1024 + 4096) / 1024));
  });

  test("a root listed twice, or nested in another root's tree, is not double-counted", () => {
    const m = new MemoryMonitor(silent, undefined, undefined, undefined, { listProcesses: () => PS });
    expect(m.getProcessTreeRss([10, 10, 11]).process_count).toBe(2);
  });

  test("a single root still works", () => {
    const m = new MemoryMonitor(silent, undefined, undefined, undefined, { listProcesses: () => PS });
    expect(m.getProcessTreeRss(20).process_count).toBe(2);
  });
});
