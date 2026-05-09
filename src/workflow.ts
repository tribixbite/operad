/**
 * workflow.ts — DAG-based task workflow engine
 *
 * Adopted (in spirit) from Operit's `core/workflow/WorkflowExecutor.kt`. The
 * algorithm is the same — adjacency list + in-degree map, DFS cycle
 * detection, Kahn's-algorithm topological execution, per-edge condition
 * gating with skip propagation — but trimmed to what operad actually needs:
 *
 *   • Two node types: `task` (shell command) and `noop` (gate / placeholder).
 *     ConditionNode/LogicNode/ExtractNode from Operit are deferred — they
 *     model parameter dataflow inside a single workflow, but operad
 *     workflows so far always feed shell commands which already handle
 *     branching via exit-code edges.
 *
 *   • Edge `on` field: `success` (default) | `error` | `always`. An incoming
 *     edge "fires" only when the source's terminal state matches `on`. A
 *     node executes if at least one incoming edge fires (matches Operit's
 *     `incomingConnections.any { ... }` semantics) — otherwise it is
 *     marked `skipped`, and skip-propagation continues via Kahn.
 *
 *   • Persistence: workflows + runs + per-node results live in three SQLite
 *     tables (memory-db schema). Run logs survive daemon restart.
 *
 * The engine is decoupled from sessions/tools — it takes a `TaskRunner`
 * callback at construction time, so tests can pass a fake. The default
 * runner (`shellRunner`) is `child_process.spawn` with timeout.
 */

import { spawn } from "node:child_process";
import type { MemoryDb } from "./memory-db.js";
import type { Logger } from "./log.js";

// -- Types --------------------------------------------------------------------

/** A workflow node — currently only `task` and `noop`. */
export interface WorkflowNode {
  /** Unique within the workflow. Used by edges' `from`/`to`. */
  id: string;
  /** `task` runs a command; `noop` is a synthetic entry/join (always succeeds). */
  type: "task" | "noop";
  /** Shell command (task only). */
  command?: string;
  /** Working directory (task only). $HOME / $PREFIX / $VAR are NOT expanded
   *  here; pass an absolute path or rely on cwd inheritance. */
  cwd?: string;
  /** Extra env vars merged on top of the parent process env (task only). */
  env?: Record<string, string>;
  /** Hard kill after this many seconds. Defaults to 600 (10 min). */
  timeout_s?: number;
}

/**
 * A directed edge. `on` decides whether the edge fires based on the source
 * node's terminal state:
 *   • `success` (default): fire iff source completed successfully.
 *   • `error`: fire iff source failed (non-zero exit, throw, or timeout).
 *   • `always`: fire regardless — useful for cleanup tasks.
 */
export interface WorkflowEdge {
  from: string;
  to: string;
  on?: "success" | "error" | "always";
}

/** A workflow as stored in the DB (spec_json is parsed into this shape). */
export interface WorkflowSpec {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * TOML-side workflow shape (`[[workflow]]` section). The TOML form is
 * deliberately flatter than `WorkflowSpec`: each `[[workflow.task]]`
 * carries its own `needs` array (list of upstream task ids) and a single
 * `on` field describing the gating semantics for ALL its incoming edges.
 *
 * config.ts compiles this into the canonical `WorkflowSpec` (`nodes` +
 * `edges`) at parse time, so the engine never sees the TOML shape.
 */
export interface WorkflowConfig {
  /** Workflow name (matches DB `name`, must be unique). */
  name: string;
  /** Whether the workflow is enabled at boot — `false` means upserted but skipped. */
  enabled?: boolean;
  /** One entry per task node. */
  tasks: Array<{
    id: string;
    command: string;
    cwd?: string;
    timeout_s?: number;
    needs?: string[];
    /** Gates ALL incoming edges for this task. Default: `success`. */
    on?: "success" | "error" | "always";
  }>;
}

/** Compile a TOML-shaped WorkflowConfig into the engine's WorkflowSpec. */
export function compileWorkflowConfig(cfg: WorkflowConfig): WorkflowSpec {
  const nodes: WorkflowNode[] = cfg.tasks.map((t) => ({
    id: t.id,
    type: "task",
    command: t.command,
    cwd: t.cwd,
    timeout_s: t.timeout_s,
  }));
  const edges: WorkflowEdge[] = [];
  for (const t of cfg.tasks) {
    if (!t.needs) continue;
    for (const upstream of t.needs) {
      edges.push({ from: upstream, to: t.id, on: t.on });
    }
  }
  return { nodes, edges };
}

/** Workflow row from the DB. */
export interface WorkflowRecord {
  id: number;
  name: string;
  spec: WorkflowSpec;
  enabled: boolean;
  created_by: string;
}

/** Outcome of a single node execution. Mirrors the per-row table. */
export type NodeStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface NodeResult {
  status: NodeStatus;
  exit_code?: number;
  output?: string;
  error?: string;
}

/** Outcome of a single task execution — what `TaskRunner` returns. */
export interface TaskResult {
  success: boolean;
  exit_code: number;
  output: string;
  error?: string;
}

/**
 * Pluggable task runner. Defaults to `shellRunner` (spawn). Tests pass a
 * deterministic fake; future versions could route to session-commands or
 * tool-engine for more exotic node types.
 */
export type TaskRunner = (node: WorkflowNode, signal: AbortSignal) => Promise<TaskResult>;

/** Final result of a `run()` call. */
export interface WorkflowRunResult {
  run_id: number;
  workflow_id: number;
  workflow_name: string;
  status: "success" | "failed" | "cancelled";
  message: string;
  nodes: Record<string, NodeResult>;
  started_at: number;
  finished_at: number;
}

// -- Default shell runner -----------------------------------------------------

/**
 * Default task runner — spawns `sh -c <command>` and captures stdout/stderr.
 *
 * Failure modes (all reported as `success: false`):
 *   • command exited non-zero
 *   • signal abort (cancellation)
 *   • timeout (kill -9 after `timeout_s`)
 *   • spawn error (bad cwd, missing binary)
 */
export const shellRunner: TaskRunner = (node, signal) => {
  if (node.type !== "task" || !node.command) {
    return Promise.resolve({
      success: false,
      exit_code: -1,
      output: "",
      error: `node ${node.id}: shellRunner only handles task nodes with a command`,
    });
  }

  const command = node.command;
  const timeoutMs = (node.timeout_s ?? 600) * 1000;

  return new Promise<TaskResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = spawn("sh", ["-c", command], {
      cwd: node.cwd,
      env: { ...process.env, ...(node.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      killed = true;
      child.kill("SIGTERM");
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, exit_code: -1, output: stdout, error: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (killed) {
        resolve({
          success: false,
          exit_code: code ?? -1,
          output: stdout,
          error: signal.aborted ? "cancelled" : `timed out after ${node.timeout_s ?? 600}s`,
        });
        return;
      }
      const exit = code ?? -1;
      resolve({
        success: exit === 0,
        exit_code: exit,
        output: stdout,
        error: exit === 0 ? undefined : (stderr.trim() || `exit ${exit}`),
      });
    });
  });
};

// -- WorkflowEngine -----------------------------------------------------------

/** Validate a spec — throws on cycles, dangling edge endpoints, duplicate ids. */
export function validateSpec(spec: WorkflowSpec): void {
  const ids = new Set<string>();
  for (const n of spec.nodes) {
    if (ids.has(n.id)) {
      throw new Error(`duplicate node id: ${n.id}`);
    }
    ids.add(n.id);
  }
  for (const e of spec.edges) {
    if (!ids.has(e.from)) throw new Error(`edge references unknown node: ${e.from}`);
    if (!ids.has(e.to)) throw new Error(`edge references unknown node: ${e.to}`);
    if (e.from === e.to) throw new Error(`self-loop on node ${e.from}`);
  }
  // Cycle detection: 3-state DFS (white=0, gray=1, black=2).
  const adj = adjacencyList(spec);
  const state = new Map<string, number>();
  for (const id of ids) state.set(id, 0);

  function dfs(id: string): boolean {
    state.set(id, 1);
    for (const next of adj.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) return true;
      if (s === 0 && dfs(next)) return true;
    }
    state.set(id, 2);
    return false;
  }

  for (const id of ids) {
    if (state.get(id) === 0 && dfs(id)) {
      throw new Error("workflow has a cycle");
    }
  }
}

/** Build adjacency list (source id → target ids). */
function adjacencyList(spec: WorkflowSpec): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of spec.nodes) adj.set(n.id, []);
  for (const e of spec.edges) {
    const list = adj.get(e.from);
    if (list && !list.includes(e.to)) list.push(e.to);
  }
  return adj;
}

/** Reverse adjacency (target id → list of incoming edges). */
function reverseEdges(spec: WorkflowSpec): Map<string, WorkflowEdge[]> {
  const rev = new Map<string, WorkflowEdge[]>();
  for (const n of spec.nodes) rev.set(n.id, []);
  for (const e of spec.edges) rev.get(e.to)?.push(e);
  return rev;
}

/**
 * Decide whether an incoming edge "fires" based on the source's terminal
 * state. Skipped sources never fire any downstream edge — this matches
 * Operit's `isSkippedState(sourceState)` short-circuit.
 */
function edgeFires(edge: WorkflowEdge, sourceResult: NodeResult): boolean {
  if (sourceResult.status === "skipped") return false;
  const on = edge.on ?? "success";
  if (on === "always") return sourceResult.status === "success" || sourceResult.status === "failed";
  if (on === "success") return sourceResult.status === "success";
  if (on === "error") return sourceResult.status === "failed";
  return false;
}

export interface RunOptions {
  triggered_by?: string;
  signal?: AbortSignal;
  /** If provided, called whenever a node transitions state (live progress). */
  onNode?: (nodeId: string, result: NodeResult) => void;
}

/**
 * WorkflowEngine — manages workflow CRUD and execution.
 *
 * Single instance per daemon. Construct with the runner that should execute
 * task nodes; `shellRunner` is the production default. The engine never
 * spawns timers or polls — it executes synchronously when `run()` is called.
 */
export class WorkflowEngine {
  private db: MemoryDb;
  private log: Logger;
  private runner: TaskRunner;

  constructor(db: MemoryDb, log: Logger, runner: TaskRunner = shellRunner) {
    this.db = db;
    this.log = log;
    this.runner = runner;
  }

  /** Create or update a workflow definition (UPSERT on name). */
  upsert(name: string, spec: WorkflowSpec, createdBy = "agent"): number {
    validateSpec(spec);
    const db = this.db.requireDb();
    const json = JSON.stringify(spec);
    const result = db.prepare(
      `INSERT INTO agent_workflows (name, spec_json, created_by) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET spec_json = excluded.spec_json, enabled = 1`,
    ).run(name, json, createdBy);
    // SQLite returns 0 for lastInsertRowid on UPDATE; look up the row instead.
    if (result.lastInsertRowid && Number(result.lastInsertRowid) > 0) {
      return Number(result.lastInsertRowid);
    }
    const row = db.prepare(`SELECT id FROM agent_workflows WHERE name = ?`).get(name) as { id: number } | undefined;
    return row?.id ?? -1;
  }

  /** Hard-delete a workflow and all its run history (CASCADE). */
  delete(name: string): boolean {
    const db = this.db.requireDb();
    const result = db.prepare(`DELETE FROM agent_workflows WHERE name = ?`).run(name);
    return result.changes > 0;
  }

  /** Toggle enabled flag without losing the spec. */
  setEnabled(name: string, enabled: boolean): void {
    const db = this.db.requireDb();
    db.prepare(`UPDATE agent_workflows SET enabled = ? WHERE name = ?`).run(enabled ? 1 : 0, name);
  }

  /** Lookup a single workflow by name. */
  get(name: string): WorkflowRecord | null {
    const db = this.db.requireDb();
    const row = db.prepare(
      `SELECT id, name, spec_json, enabled, created_by FROM agent_workflows WHERE name = ?`,
    ).get(name) as { id: number; name: string; spec_json: string; enabled: number; created_by: string } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      spec: JSON.parse(row.spec_json) as WorkflowSpec,
      enabled: row.enabled === 1,
      created_by: row.created_by,
    };
  }

  /** All workflows, newest-first. */
  getAll(): WorkflowRecord[] {
    const db = this.db.requireDb();
    const rows = db.prepare(
      `SELECT id, name, spec_json, enabled, created_by FROM agent_workflows ORDER BY id DESC`,
    ).all() as Array<{ id: number; name: string; spec_json: string; enabled: number; created_by: string }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      spec: JSON.parse(row.spec_json) as WorkflowSpec,
      enabled: row.enabled === 1,
      created_by: row.created_by,
    }));
  }

  /** Recent runs, optionally filtered by workflow name. */
  recentRuns(name?: string, limit = 20): Array<{
    id: number; workflow_id: number; workflow_name: string; status: string;
    started_at: number; finished_at: number | null; message: string | null;
  }> {
    const db = this.db.requireDb();
    const sql = name
      ? `SELECT id, workflow_id, workflow_name, status, started_at, finished_at, message
         FROM agent_workflow_runs WHERE workflow_name = ? ORDER BY started_at DESC LIMIT ?`
      : `SELECT id, workflow_id, workflow_name, status, started_at, finished_at, message
         FROM agent_workflow_runs ORDER BY started_at DESC LIMIT ?`;
    return name
      ? db.prepare(sql).all(name, limit) as any[]
      : db.prepare(sql).all(limit) as any[];
  }

  /**
   * Execute a workflow by name. Returns the final result with per-node state.
   * Runs through the topology in dependency order (Kahn's algorithm); a node
   * is reached when all its predecessors have terminated, and executes only
   * if at least one incoming edge fires (cf. `edgeFires`). Otherwise it's
   * marked `skipped` and the skip propagates downstream.
   *
   * `opts.signal` aborts cleanly: in-flight task is killed, remaining nodes
   * are NOT marked skipped (they stay pending). The run is recorded as
   * `cancelled`.
   */
  async run(name: string, opts: RunOptions = {}): Promise<WorkflowRunResult> {
    const wf = this.get(name);
    if (!wf) throw new Error(`workflow not found: ${name}`);
    if (!wf.enabled) throw new Error(`workflow disabled: ${name}`);

    const triggeredBy = opts.triggered_by ?? "manual";
    const signal = opts.signal ?? new AbortController().signal;
    const startedAt = Math.floor(Date.now() / 1000);

    // Insert run row up front so failures still leave a trace.
    const db = this.db.requireDb();
    const runIns = db.prepare(
      `INSERT INTO agent_workflow_runs (workflow_id, workflow_name, triggered_by, started_at, status)
       VALUES (?, ?, ?, ?, 'running')`,
    ).run(wf.id, wf.name, triggeredBy, startedAt);
    const runId = Number(runIns.lastInsertRowid);
    this.log.info(`Workflow "${name}" run ${runId} starting (trigger=${triggeredBy})`);

    const adj = adjacencyList(wf.spec);
    const rev = reverseEdges(wf.spec);
    const inDegree = new Map<string, number>();
    for (const n of wf.spec.nodes) inDegree.set(n.id, rev.get(n.id)?.length ?? 0);

    const results = new Map<string, NodeResult>();
    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const persistNode = (nodeId: string, r: NodeResult, started?: number, finished?: number) => {
      db.prepare(
        `INSERT INTO agent_workflow_run_nodes (run_id, node_id, status, started_at, finished_at, exit_code, output, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, node_id) DO UPDATE SET
           status = excluded.status, started_at = excluded.started_at,
           finished_at = excluded.finished_at, exit_code = excluded.exit_code,
           output = excluded.output, error = excluded.error`,
      ).run(
        runId, nodeId, r.status, started ?? null, finished ?? null,
        r.exit_code ?? null, r.output ?? null, r.error ?? null,
      );
      opts.onNode?.(nodeId, r);
    };

    const nodeMap = new Map(wf.spec.nodes.map((n) => [n.id, n]));
    let cancelled = false;

    while (queue.length > 0) {
      if (signal.aborted) { cancelled = true; break; }
      const currentId = queue.shift()!;
      if (results.has(currentId)) continue;
      const node = nodeMap.get(currentId);
      if (!node) continue;

      // Decide: execute or skip? Skip iff the node has incoming edges AND
      // none of them fired. Roots (no incoming edges) always execute.
      const incoming = rev.get(currentId) ?? [];
      let shouldExec = incoming.length === 0;
      if (!shouldExec) {
        for (const edge of incoming) {
          const src = results.get(edge.from);
          if (src && edgeFires(edge, src)) { shouldExec = true; break; }
        }
      }

      let nodeResult: NodeResult;
      if (!shouldExec) {
        nodeResult = { status: "skipped", error: "no incoming edge fired" };
        persistNode(currentId, nodeResult);
      } else if (node.type === "noop") {
        nodeResult = { status: "success", output: "" };
        const now = Math.floor(Date.now() / 1000);
        persistNode(currentId, nodeResult, now, now);
      } else {
        const startNs = Math.floor(Date.now() / 1000);
        persistNode(currentId, { status: "running" }, startNs);
        try {
          const res = await this.runner(node, signal);
          const finishNs = Math.floor(Date.now() / 1000);
          nodeResult = res.success
            ? { status: "success", exit_code: res.exit_code, output: res.output }
            : { status: "failed", exit_code: res.exit_code, output: res.output, error: res.error };
          persistNode(currentId, nodeResult, startNs, finishNs);
        } catch (err) {
          const finishNs = Math.floor(Date.now() / 1000);
          nodeResult = { status: "failed", error: (err as Error).message };
          persistNode(currentId, nodeResult, startNs, finishNs);
        }
      }
      results.set(currentId, nodeResult);

      // Decrement successors' in-degree; enqueue when they hit 0.
      for (const next of adj.get(currentId) ?? []) {
        inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
        if ((inDegree.get(next) ?? 0) === 0) queue.push(next);
      }
    }

    const finishedAt = Math.floor(Date.now() / 1000);
    const anyFailed = [...results.values()].some((r) => r.status === "failed");
    const status: WorkflowRunResult["status"] = cancelled ? "cancelled" : anyFailed ? "failed" : "success";
    const message = cancelled
      ? "cancelled"
      : anyFailed
        ? `failed: ${[...results.entries()].filter(([, r]) => r.status === "failed").map(([id]) => id).join(", ")}`
        : "ok";

    db.prepare(
      `UPDATE agent_workflow_runs SET finished_at = ?, status = ?, message = ? WHERE id = ?`,
    ).run(finishedAt, status, message, runId);
    this.log.info(`Workflow "${name}" run ${runId} ${status} (${message})`);

    const nodesObj: Record<string, NodeResult> = {};
    for (const [id, r] of results) nodesObj[id] = r;

    return {
      run_id: runId,
      workflow_id: wf.id,
      workflow_name: wf.name,
      status,
      message,
      nodes: nodesObj,
      started_at: startedAt,
      finished_at: finishedAt,
    };
  }
}
