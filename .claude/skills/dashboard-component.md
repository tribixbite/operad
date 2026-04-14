# Dashboard Component Development

## Triggers
- User asks to create or modify a Svelte dashboard component
- User says `/dashboard-component`
- Working on any file in `dashboard/src/components/`

## Stack
- **Framework**: Astro 5 + Svelte 5 (runes mode)
- **Styling**: Tailwind v4 for layout utilities, scoped `<style>` for component-specific CSS
- **State**: `$state`, `$derived`, `$derived.by`, `$effect`, `$props`
- **Shared state**: `store.svelte.ts` — single SSE-fed reactive store
- **Build**: `cd dashboard && bun run build` (static site served by daemon on :18970)

## Critical Svelte 5 Patterns

### $derived vs $derived.by — THIS CAUSES BUGS
```typescript
// WRONG — stores a function reference, never re-evaluates reactively
const items = $derived(() => {
  return data.filter(x => x.active);
});
// Template: {#each items() ...}  <-- calling it like a function is the clue it's wrong

// CORRECT — evaluates the function and tracks reactive dependencies
const items = $derived.by(() => {
  return data.filter(x => x.active);
});
// Template: {#each items ...}  <-- used directly as a value
```

**Rule**: If your derived value needs a function body (multiple statements, intermediate variables), use `$derived.by(() => { ... })`. For simple expressions, use `$derived(expr)`.

### $state for reactive variables
```typescript
let loading = $state(true);
let items: Item[] = $state([]);
let error: string | null = $state(null);

// Sets — must reassign, not mutate
let active = $state(new Set<string>());
// WRONG: active.add(id);
// CORRECT: active = new Set([...active, id]);
```

### $effect for side effects (replaces onMount)
```typescript
// Runs on mount + when reactive deps change
$effect(() => {
  if (typeof window === "undefined") return; // SSR guard
  fetchData();
});

// Cleanup pattern
$effect(() => {
  const timer = setInterval(refresh, 5000);
  return () => clearInterval(timer);
});
```

### $props for component inputs
```typescript
interface Props {
  sessionName: string;
  compact?: boolean;
  onclose?: () => void;
}
let { sessionName, compact = false, onclose }: Props = $props();
```

## Component Template

```svelte
<script lang="ts">
  import { store } from "../lib/store.svelte";
  // Import API functions from "../lib/api"

  interface Props {
    // Define props
  }
  let { /* destructure props */ }: Props = $props();

  // Reactive state
  let loading = $state(true);
  let error: string | null = $state(null);

  // Derived values — use $derived.by for complex computations
  const computed = $derived.by(() => {
    if (!store.daemon?.sessions) return [];
    return store.daemon.sessions.filter(s => s.path);
  });

  // API functions
  async function loadData() {
    loading = true;
    error = null;
    try {
      // fetch...
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  // Lifecycle
  $effect(() => {
    if (typeof window === "undefined") return;
    loadData();
  });
</script>

<!-- Template with loading/error/empty states -->
{#if loading}
  <p class="text-xs text-[var(--text-muted)]">Loading...</p>
{:else if error}
  <p class="text-xs text-[var(--accent-red)]">{error}</p>
{:else}
  <!-- Content -->
{/if}

<style>
  /* Scoped styles — use CSS custom properties from global theme */
  /* --bg-primary, --bg-secondary, --bg-tertiary */
  /* --text-primary, --text-secondary, --text-muted */
  /* --border */
  /* --accent-blue, --accent-green, --accent-yellow, --accent-red */
</style>
```

## Shared Store Access
```typescript
import { store } from "../lib/store.svelte";

// Session data from SSE
const sessions = $derived(store.daemon?.sessions ?? []);

// Memory info
const memInfo = $derived(store.daemon?.memory);
```

## API Pattern
All API functions live in `dashboard/src/lib/api.ts`:
```typescript
// Standard fetch + error check
export async function fetchSomething(): Promise<Something[]> {
  const res = await fetch("/api/something");
  return checkedJson(res);
}
```

## SVG Icons
Use inline SVGs with `currentColor` for theme inheritance. Never use Unicode entities or emoji.
```html
<!-- Example: X close button -->
<svg width="12" height="12" viewBox="0 0 16 16" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <path d="M4 4L12 12M12 4L4 12"/>
</svg>
```

## Styling Conventions
- Font sizes: `0.625rem` (tiny), `0.6875rem` (small), `0.75rem` (base), `0.8125rem` (table)
- Buttons: `.btn`, `.btn-sm`, `.btn-danger` classes or scoped equivalents
- Cards: `.card` class from global styles
- Use `color-mix(in srgb, var(--accent-*) 15%, transparent)` for tinted backgrounds
- Mobile-first: touch targets min 44px, no hover-only interactions

## Adding to a Page
In `dashboard/src/pages/<page>.astro`:
```astro
---
import MyComponent from "../components/MyComponent.svelte";
---
<Layout title="Page | operad" active="page">
  <MyComponent client:load />
</Layout>
```

`client:load` hydrates immediately. Use `client:idle` for below-fold components.

## Build & Verify Checklist
1. `bun run typecheck` — zero errors
2. `cd dashboard && bun run build` — no build errors
3. `tmx upgrade` — deploy to running daemon
4. Use `/ui-verify` skill to screenshot and confirm rendering
