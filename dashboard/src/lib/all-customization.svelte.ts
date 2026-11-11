/**
 * all-customization.svelte.ts — lazy loader for the "All Projects" tab.
 *
 * Eight customization panels (Skills, Hooks, Plans, Commands, Memories,
 * Subagents, CLAUDE.md, AGENTS.md) each had an identical copy of this state:
 *
 *   let allData: AllProjectsCustomizationResponse | null = $state(null);
 *
 * Written that way, TypeScript narrows the declared union down to the type of
 * the initializer — `null` — for every read that is not inside a closure, so
 * `allData ? allData.user… : []` inside `$derived(...)` typed the truthy branch
 * as `never`. Passing the type to `$state<T>()` keeps the full union. Holding
 * the state on a class instance also means the property is read as
 * `loader.data`, which TS never narrows from the declaration.
 */

import { fetchAllCustomization } from "./api";
import type { AllProjectsCustomizationResponse } from "./types";

/** Per-panel loader: fetches `/api/customization/all-projects` once, on demand. */
export class AllCustomizationLoader {
  /** Aggregated user + per-project customization; null until loaded. */
  data = $state<AllProjectsCustomizationResponse | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  /** Fetch once. A no-op while a request is in flight or after a success;
   * a failed fetch leaves `data` null so the next call retries. */
  async load(): Promise<void> {
    if (this.data || this.loading) return;
    this.loading = true;
    this.error = null;
    try {
      this.data = await fetchAllCustomization();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }
}
