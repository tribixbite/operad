// SPA mode: no SSR, prerender all pages
// ssr = false is critical: stores use EventSource, WebSocket, and window at module scope
export const prerender = true;
export const ssr = false;
