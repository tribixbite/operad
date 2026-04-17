import type { OrchestratorContext } from "./orchestrator-context.js";

/**
 * AgentEngine — extracted subsystem for agent/cognitive/OODA workflows.
 * Takes an OrchestratorContext at construction — no direct daemon coupling.
 *
 * Full extraction from daemon.ts is incremental; initial shell establishes
 * the injection point. Methods are added as daemon.ts logic is moved over.
 */
export class AgentEngine {
  constructor(private ctx: OrchestratorContext) {}

  /** Placeholder — will host extracted OODA/agent methods in subsequent commits. */
  // Methods added incrementally as daemon.ts logic migrates.
}
