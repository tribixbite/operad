/**
 * workflow.test.ts — Unit tests for the WorkflowEngine.
 *
 * Covers the algorithmic core (cycle detection, topological execution,
 * edge gating, skip propagation, cancellation) using an in-memory SQLite
 * + a deterministic fake task runner so tests don't shell out.
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  WorkflowEngine,
  validateSpec,
  type WorkflowSpec,
  type TaskRunner,
  type TaskResult,
} from "../workflow.js";

// -- Test fixtures ------------------------------------------------------------

/** Silent logger — workflow tests don't care about log output. */
const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

/** Build a fresh in-memory DB with the workflow tables created. */
function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agent_workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      spec_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT 'config',
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE agent_workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL,
      workflow_name TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      message TEXT
    );
    CREATE TABLE agent_workflow_run_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      exit_code INTEGER,
      output TEXT,
      error TEXT,
      UNIQUE(run_id, node_id)
    );
  `);
  return db;
}

/** Build a fake MemoryDb wrapper. */
function makeMemDb(db: Database) {
  return { requireDb: () => db } as any;
}

/**
 * Deterministic runner — looks up node.id in `outcomes` to decide success/
 * failure. Records execution order so we can assert dependencies fired in
 * the right sequence.
 */
function makeFakeRunner(outcomes: Record<string, "ok" | "fail">, order: string[]): TaskRunner {
  return async (node) => {
    order.push(node.id);
    const outcome = outcomes[node.id] ?? "ok";
    return {
      success: outcome === "ok",
      exit_code: outcome === "ok" ? 0 : 1,
      output: `output of ${node.id}`,
      error: outcome === "fail" ? `${node.id} failed` : undefined,
    } satisfies TaskResult;
  };
}

// -- validateSpec -------------------------------------------------------------

describe("validateSpec", () => {
  test("accepts a simple linear DAG", () => {
    const spec: WorkflowSpec = {
      nodes: [
        { id: "a", type: "task", command: "true" },
        { id: "b", type: "task", command: "true" },
      ],
      edges: [{ from: "a", to: "b" }],
    };
    expect(() => validateSpec(spec)).not.toThrow();
  });

  test("detects a 3-node cycle", () => {
    const spec: WorkflowSpec = {
      nodes: [
        { id: "a", type: "task", command: "x" },
        { id: "b", type: "task", command: "x" },
        { id: "c", type: "task", command: "x" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
      ],
    };
    expect(() => validateSpec(spec)).toThrow(/cycle/);
  });

  test("rejects self-loops", () => {
    const spec: WorkflowSpec = {
      nodes: [{ id: "a", type: "task", command: "x" }],
      edges: [{ from: "a", to: "a" }],
    };
    expect(() => validateSpec(spec)).toThrow(/self-loop/);
  });

  test("rejects edges that reference unknown nodes", () => {
    const spec: WorkflowSpec = {
      nodes: [{ id: "a", type: "task", command: "x" }],
      edges: [{ from: "a", to: "ghost" }],
    };
    expect(() => validateSpec(spec)).toThrow(/unknown node/);
  });

  test("rejects duplicate node ids", () => {
    const spec: WorkflowSpec = {
      nodes: [
        { id: "a", type: "task", command: "x" },
        { id: "a", type: "task", command: "y" },
      ],
      edges: [],
    };
    expect(() => validateSpec(spec)).toThrow(/duplicate/);
  });
});

// -- run() execution semantics -----------------------------------------------

describe("WorkflowEngine.run", () => {
  test("linear DAG runs in topological order, all success", async () => {
    const db = freshDb();
    const order: string[] = [];
    const engine = new WorkflowEngine(makeMemDb(db), log, makeFakeRunner({}, order));
    engine.upsert("linear", {
      nodes: [
        { id: "a", type: "task", command: "x" },
        { id: "b", type: "task", command: "x" },
        { id: "c", type: "task", command: "x" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    });

    const result = await engine.run("linear");
    expect(result.status).toBe("success");
    expect(order).toEqual(["a", "b", "c"]);
    expect(result.nodes.a.status).toBe("success");
    expect(result.nodes.b.status).toBe("success");
    expect(result.nodes.c.status).toBe("success");
    db.close();
  });

  test("diamond DAG: both branches run before the join", async () => {
    const db = freshDb();
    const order: string[] = [];
    const engine = new WorkflowEngine(makeMemDb(db), log, makeFakeRunner({}, order));
    engine.upsert("diamond", {
      nodes: [
        { id: "a", type: "task", command: "x" },
        { id: "b", type: "task", command: "x" },
        { id: "c", type: "task", command: "x" },
        { id: "d", type: "task", command: "x" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ],
    });

    const result = await engine.run("diamond");
    expect(result.status).toBe("success");
    expect(order[0]).toBe("a");
    expect(order[order.length - 1]).toBe("d");
    expect(order).toContain("b");
    expect(order).toContain("c");
    db.close();
  });

  test("on='error' edge: cleanup task runs only when source fails", async () => {
    const db = freshDb();
    const order: string[] = [];
    const engine = new WorkflowEngine(
      makeMemDb(db),
      log,
      makeFakeRunner({ build: "fail" }, order),
    );
    engine.upsert("error-branch", {
      nodes: [
        { id: "build", type: "task", command: "fail" },
        { id: "deploy", type: "task", command: "ok" },
        { id: "alert", type: "task", command: "ok" },
      ],
      edges: [
        { from: "build", to: "deploy" }, // default on=success → blocked
        { from: "build", to: "alert", on: "error" }, // fires
      ],
    });

    const result = await engine.run("error-branch");
    expect(result.status).toBe("failed");
    expect(result.nodes.build.status).toBe("failed");
    expect(result.nodes.deploy.status).toBe("skipped");
    expect(result.nodes.alert.status).toBe("success");
    expect(order).toEqual(["build", "alert"]); // deploy never ran
    db.close();
  });

  test("on='always' edge: cleanup runs whether source succeeded or failed", async () => {
    const db = freshDb();
    {
      const order: string[] = [];
      const engine = new WorkflowEngine(
        makeMemDb(db),
        log,
        makeFakeRunner({}, order),
      );
      engine.upsert("always", {
        nodes: [
          { id: "main", type: "task", command: "ok" },
          { id: "cleanup", type: "task", command: "ok" },
        ],
        edges: [{ from: "main", to: "cleanup", on: "always" }],
      });

      const ok = await engine.run("always");
      expect(ok.status).toBe("success");
      expect(order).toEqual(["main", "cleanup"]);
    }
    {
      const order: string[] = [];
      const engine = new WorkflowEngine(
        makeMemDb(db),
        log,
        makeFakeRunner({ main: "fail" }, order),
      );
      engine.upsert("always", {
        nodes: [
          { id: "main", type: "task", command: "fail" },
          { id: "cleanup", type: "task", command: "ok" },
        ],
        edges: [{ from: "main", to: "cleanup", on: "always" }],
      });

      const failed = await engine.run("always");
      expect(failed.status).toBe("failed");
      expect(failed.nodes.main.status).toBe("failed");
      expect(failed.nodes.cleanup.status).toBe("success");
      expect(order).toEqual(["main", "cleanup"]);
    }
    db.close();
  });

  test("skip propagates: when join's incoming edge is blocked, downstream skips too", async () => {
    const db = freshDb();
    const order: string[] = [];
    const engine = new WorkflowEngine(
      makeMemDb(db),
      log,
      makeFakeRunner({ a: "fail" }, order),
    );
    engine.upsert("skip-prop", {
      nodes: [
        { id: "a", type: "task", command: "fail" },
        { id: "b", type: "task", command: "ok" },
        { id: "c", type: "task", command: "ok" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    });

    const result = await engine.run("skip-prop");
    expect(result.nodes.a.status).toBe("failed");
    expect(result.nodes.b.status).toBe("skipped");
    expect(result.nodes.c.status).toBe("skipped"); // skip propagated
    expect(order).toEqual(["a"]); // only a ran
    db.close();
  });

  test("multi-incoming OR semantics: any fired edge runs the node", async () => {
    const db = freshDb();
    const order: string[] = [];
    const engine = new WorkflowEngine(
      makeMemDb(db),
      log,
      makeFakeRunner({ b: "fail" }, order),
    );
    engine.upsert("or-join", {
      nodes: [
        { id: "a", type: "task", command: "ok" },
        { id: "b", type: "task", command: "fail" },
        { id: "join", type: "task", command: "ok" },
      ],
      edges: [
        { from: "a", to: "join" }, // success → fires
        { from: "b", to: "join" }, // failed → blocked
      ],
    });

    const result = await engine.run("or-join");
    expect(result.status).toBe("failed"); // b failed, so run is failed
    expect(result.nodes.join.status).toBe("success"); // but join still ran via a
    db.close();
  });

  test("noop nodes always succeed and don't invoke the runner", async () => {
    const db = freshDb();
    const order: string[] = [];
    const runner: TaskRunner = async (node) => {
      order.push(node.id);
      return { success: true, exit_code: 0, output: "" };
    };
    const engine = new WorkflowEngine(makeMemDb(db), log, runner);
    engine.upsert("with-noop", {
      nodes: [
        { id: "start", type: "noop" },
        { id: "task", type: "task", command: "x" },
      ],
      edges: [{ from: "start", to: "task" }],
    });

    const result = await engine.run("with-noop");
    expect(result.nodes.start.status).toBe("success");
    expect(result.nodes.task.status).toBe("success");
    expect(order).toEqual(["task"]); // noop didn't go through runner
    db.close();
  });

  test("cancellation: aborted run leaves remaining nodes pending and reports cancelled", async () => {
    const db = freshDb();
    const ac = new AbortController();
    const runner: TaskRunner = async (node) => {
      if (node.id === "first") {
        ac.abort(); // cancel right after the first task lands
        return { success: true, exit_code: 0, output: "" };
      }
      return { success: true, exit_code: 0, output: "" };
    };
    const engine = new WorkflowEngine(makeMemDb(db), log, runner);
    engine.upsert("cancel-mid", {
      nodes: [
        { id: "first", type: "task", command: "x" },
        { id: "second", type: "task", command: "x" },
      ],
      edges: [{ from: "first", to: "second" }],
    });

    const result = await engine.run("cancel-mid", { signal: ac.signal });
    expect(result.status).toBe("cancelled");
    expect(result.nodes.first.status).toBe("success");
    expect(result.nodes.second).toBeUndefined(); // never reached
    db.close();
  });

  test("upsert + get round-trip preserves the spec", () => {
    const db = freshDb();
    const engine = new WorkflowEngine(makeMemDb(db), log, async () => ({
      success: true, exit_code: 0, output: "",
    }));
    const spec: WorkflowSpec = {
      nodes: [
        { id: "a", type: "task", command: "echo hi", cwd: "/tmp", timeout_s: 30 },
      ],
      edges: [],
    };
    engine.upsert("roundtrip", spec);
    const got = engine.get("roundtrip");
    expect(got).not.toBeNull();
    expect(got?.spec).toEqual(spec);
    expect(got?.enabled).toBe(true);
    db.close();
  });

  test("recentRuns returns runs newest-first", async () => {
    const db = freshDb();
    const engine = new WorkflowEngine(makeMemDb(db), log, async () => ({
      success: true, exit_code: 0, output: "",
    }));
    engine.upsert("rs", { nodes: [{ id: "x", type: "task", command: "ok" }], edges: [] });
    await engine.run("rs", { triggered_by: "first" });
    await engine.run("rs", { triggered_by: "second" });
    const runs = engine.recentRuns("rs");
    expect(runs).toHaveLength(2);
    // started_at desc → "second" comes first
    expect(runs[0].started_at).toBeGreaterThanOrEqual(runs[1].started_at);
    db.close();
  });
});
