<script lang="ts">
  import "../app.css";
  import { page } from "$app/stores";
  import NotificationBell from "$lib/components/NotificationBell.svelte";

  let { children } = $props();

  const navItems = [
    { href: "/", label: "Overview", id: "overview",
      icon: '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8L8 2.5L14 8"/><path d="M4 7V13.5H12V7"/></svg>' },
    { href: "/memory", label: "Memory", id: "memory",
      icon: '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4V12C3 13.1 5.2 14 8 14S13 13.1 13 12V4"/><path d="M3 8C3 9.1 5.2 10 8 10S13 9.1 13 8"/></svg>' },
    { href: "/logs", label: "Logs", id: "logs",
      icon: '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4H13M3 8H10M3 12H7"/></svg>' },
    { href: "/telemetry", label: "Telemetry", id: "telemetry",
      icon: '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M2.5 13V9.5M6 13V5.5M9.5 13V8M13 13V3"/></svg>' },
    { href: "/settings", label: "Settings", id: "settings",
      icon: '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5V3.5M8 12.5V14.5M1.5 8H3.5M12.5 8H14.5M3.3 3.3L4.7 4.7M11.3 11.3L12.7 12.7M12.7 3.3L11.3 4.7M4.7 11.3L3.3 12.7"/></svg>' },
  ];

  /** Derive active nav item from current pathname */
  function isActive(href: string): boolean {
    const pathname = $page.url.pathname;
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }
</script>

<svelte:head>
  <title>operad dashboard</title>
</svelte:head>

<header class="sticky top-0 z-50 border-b border-[var(--border)] bg-[var(--bg-primary)]">
  <div class="max-w-5xl mx-auto px-4 py-2 flex items-center justify-between">
    <div class="flex items-center gap-2">
      <span class="text-[var(--accent-blue)] font-bold text-sm">operad</span>
      <span class="text-[var(--text-muted)] text-xs">dashboard</span>
    </div>
    <div class="flex items-center gap-2">
      <nav class="flex gap-1">
        {#each navItems as item (item.id)}
          <a href={item.href} class:active={isActive(item.href)} title={item.label} aria-label={item.label}>
            {@html item.icon}
          </a>
        {/each}
      </nav>
      <NotificationBell />
    </div>
  </div>
</header>
<main class="max-w-5xl mx-auto main-content">
  {@render children()}
</main>

<style>
  .main-content { padding: 1rem; }
  @media (max-width: 768px) {
    .main-content { padding: 0.5rem; }
  }
</style>
