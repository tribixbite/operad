import type { SessionConfig, SessionStatus } from "./types.js";
import type { Logger } from "./log.js";

/** Minimal tmux operation result */
export interface TmuxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injected tmux runner — real spawnSync in production, fake in tests */
export type TmuxRunner = (args: string[]) => TmuxResult;

/** Minimal health check result */
export interface HealthResult {
  healthy: boolean;
  reason?: string;
}

/** Injected health checker — real checks in production, fake in tests */
export type HealthChecker = (sessionName: string, config: SessionConfig) => Promise<HealthResult>;

export interface SessionControllerOptions {
  tmuxRunner: TmuxRunner;
  healthChecker: HealthChecker;
  log: Logger;
  maxRestarts?: number;
  restartDelayMs?: number;
}

/** Per-session runtime state tracked by controller */
export interface SessionRuntimeState {
  name: string;
  status: SessionStatus;
  restartCount: number;
  lastTransition: Date;
  pid?: number;
}

/**
 * Pure session lifecycle controller — no daemon coupling.
 * Accepts injected tmuxRunner and healthChecker for testability.
 */
export class SessionController {
  private states = new Map<string, SessionRuntimeState>();
  private opts: Required<SessionControllerOptions>;

  constructor(opts: SessionControllerOptions) {
    this.opts = {
      ...opts,
      maxRestarts: opts.maxRestarts ?? 5,
      restartDelayMs: opts.restartDelayMs ?? 3000,
    };
  }

  getState(name: string): SessionRuntimeState | undefined {
    return this.states.get(name);
  }

  /** Transition a session to a new status, recording timestamp */
  private transition(name: string, to: SessionStatus, extra: Partial<SessionRuntimeState> = {}): SessionRuntimeState {
    const existing = this.states.get(name) ?? {
      name,
      status: "pending" as SessionStatus,
      restartCount: 0,
      lastTransition: new Date(),
    };
    const next: SessionRuntimeState = { ...existing, status: to, lastTransition: new Date(), ...extra };
    this.states.set(name, next);
    return next;
  }

  /** Start a session — transitions pending → starting → running/failed */
  async start(name: string, config: SessionConfig): Promise<SessionRuntimeState> {
    this.transition(name, "starting");

    const result = this.opts.tmuxRunner([
      "new-window", "-t", (config as any).tmux_session ?? "operad", "-n", name,
      "-d", "--", config.command ?? name,
    ]);

    if (result.exitCode !== 0) {
      this.opts.log.error(`Failed to start session '${name}'`, { stderr: result.stderr });
      return this.transition(name, "failed");
    }

    const health = await this.opts.healthChecker(name, config);
    if (health.healthy) {
      return this.transition(name, "running");
    }

    this.opts.log.warn(`Session '${name}' started but unhealthy: ${health.reason}`);
    return this.transition(name, "degraded");
  }

  /** Stop a session — transitions to stopped */
  async stop(name: string): Promise<SessionRuntimeState> {
    this.transition(name, "stopping");
    this.opts.tmuxRunner(["kill-window", "-t", name]);
    return this.transition(name, "stopped");
  }

  /** Handle a health check failure — increment restarts or mark failed */
  async handleHealthFailure(name: string, config: SessionConfig): Promise<SessionRuntimeState> {
    const state = this.states.get(name);
    if (!state) return this.transition(name, "failed");

    const maxRestarts = config.max_restarts ?? this.opts.maxRestarts;
    if (state.restartCount >= maxRestarts) {
      this.opts.log.error(`Session '${name}' exceeded max restarts (${maxRestarts})`);
      return this.transition(name, "failed", { restartCount: state.restartCount });
    }

    this.opts.log.warn(`Session '${name}' degraded — restarting (${state.restartCount + 1}/${maxRestarts})`);
    this.transition(name, "degraded", { restartCount: state.restartCount + 1 });

    await this.stop(name);
    if (this.opts.restartDelayMs > 0) {
      await new Promise(r => setTimeout(r, this.opts.restartDelayMs));
    }
    const afterStart = await this.start(name, config);
    // Reset restartCount to 0 after a successful restart so that future failures
    // don't erroneously count past recoveries against the max restarts limit.
    if (afterStart.status === "running") {
      return this.transition(name, "running", { restartCount: 0 });
    }
    return afterStart;
  }
}
