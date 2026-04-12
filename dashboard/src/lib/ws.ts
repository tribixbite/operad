/**
 * ws.ts — Reactive WebSocket client for the operad dashboard
 *
 * Auto-reconnects with exponential backoff, supports session room
 * subscriptions, and provides typed message routing. Closes on
 * page navigation to avoid connection exhaustion.
 */

/** Server -> Client WS message */
export interface WsServerMessage {
  type: string;
  sessionName?: string;
  [key: string]: unknown;
}

/** Connection status */
export type WsStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

/** Message handler callback */
export type WsHandler = (msg: WsServerMessage) => void;

/** Reactive WS client state — mutate properties for Svelte 5 reactivity */
export const wsState = $state({
  status: "disconnected" as WsStatus,
  /** Number of reconnect attempts since last successful connection */
  reconnectAttempts: 0,
});

/** Internal state */
let socket: WebSocket | null = null;
let handlers = new Map<string, Set<WsHandler>>();
let subscribedRooms = new Set<string>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let intentionalClose = false;

const BASE_DELAY = 1000;
const MAX_DELAY = 30_000;

/** Build the WebSocket URL from the current page origin */
function getWsUrl(): string {
  const loc = typeof window !== "undefined" ? window.location : null;
  if (!loc) return "ws://localhost:18970/ws";
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/ws`;
}

/** Connect to the WS server */
export function connect(): void {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;

  intentionalClose = false;
  wsState.status = wsState.reconnectAttempts > 0 ? "reconnecting" : "connecting";

  try {
    socket = new WebSocket(getWsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    wsState.status = "connected";
    wsState.reconnectAttempts = 0;

    // Re-subscribe to any rooms that were active before disconnect
    for (const room of subscribedRooms) {
      socket?.send(JSON.stringify({ type: "subscribe", sessionName: room }));
    }
  };

  socket.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as WsServerMessage;
      // Dispatch to type-specific handlers
      const typeHandlers = handlers.get(msg.type);
      if (typeHandlers) {
        for (const fn of typeHandlers) fn(msg);
      }
      // Also dispatch to wildcard handlers
      const wildcardHandlers = handlers.get("*");
      if (wildcardHandlers) {
        for (const fn of wildcardHandlers) fn(msg);
      }
    } catch {
      // Ignore malformed messages
    }
  };

  socket.onclose = () => {
    socket = null;
    wsState.status = "disconnected";
    if (!intentionalClose) scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose will fire after onerror, triggering reconnect
  };
}

/** Disconnect and stop reconnecting */
export function disconnect(): void {
  intentionalClose = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.close(1000, "Client disconnect");
    socket = null;
  }
  wsState.status = "disconnected";
  wsState.reconnectAttempts = 0;
}

/** Schedule a reconnect with exponential backoff */
function scheduleReconnect(): void {
  if (intentionalClose) return;
  wsState.reconnectAttempts++;
  const delay = Math.min(BASE_DELAY * Math.pow(2, wsState.reconnectAttempts - 1), MAX_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/** Subscribe to a session room for targeted messages */
export function subscribe(sessionName: string): void {
  subscribedRooms.add(sessionName);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "subscribe", sessionName }));
  }
}

/** Unsubscribe from a session room */
export function unsubscribe(sessionName: string): void {
  subscribedRooms.delete(sessionName);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "unsubscribe", sessionName }));
  }
}

/** Send a typed message to the server */
export function send(msg: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

/** Register a handler for a specific message type (or "*" for all) */
export function on(type: string, handler: WsHandler): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler);
  // Return unsubscribe function
  return () => {
    set!.delete(handler);
    if (set!.size === 0) handlers.delete(type);
  };
}

/** Remove all handlers (useful for cleanup) */
export function offAll(): void {
  handlers.clear();
}

// Close WS on page navigation to avoid connection exhaustion (see MEMORY.md SSE gotcha)
if (typeof window !== "undefined") {
  const cleanup = () => disconnect();
  window.addEventListener("beforeunload", cleanup);
  window.addEventListener("pagehide", cleanup);
}
