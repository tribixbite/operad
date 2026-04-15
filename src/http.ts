/**
 * http.ts — HTTP server for the web dashboard
 *
 * Serves static Astro build files from dashboard/dist/ and provides a REST API
 * that mirrors IPC commands. Includes SSE endpoint for real-time state updates.
 */

import * as http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Logger } from "./log.js";

/** MIME types for static file serving */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

/** API route handler type */
export type ApiHandler = (
  method: string,
  path: string,
  body: string,
) => Promise<{ status: number; data: unknown }>;

/** WebSocket message handler — receives parsed JSON messages from clients */
export type WsMessageHandler = (
  ws: WebSocket,
  msg: WsClientMessage,
  rooms: ReadonlyMap<string, ReadonlySet<WebSocket>>,
) => void;

/** Client -> Server WS message types */
export interface WsClientMessage {
  type: "subscribe" | "unsubscribe" | "ping" | "prompt" | "permission_response" | "abort" | "attach" | "detach" | "agent_run" | "switchboard_get" | "switchboard_update" | "agent_chat" | "agent_chat_history" | "agent_chat_clear";
  sessionName?: string;
  [key: string]: unknown;
}

/** SSE client connection */
interface SseClient {
  res: http.ServerResponse;
  id: number;
}

export class DashboardServer {
  private server: http.Server | null = null;
  private log: Logger;
  private port: number;
  private staticDir: string;
  private apiHandler: ApiHandler;
  private sseClients = new Set<SseClient>();
  private sseIdCounter = 0;

  /** WebSocket server for bidirectional streaming */
  private wss: WebSocketServer | null = null;
  /** Session room registry — maps session name to subscribed clients */
  private wsRooms = new Map<string, Set<WebSocket>>();
  /** All connected WS clients */
  private wsClients = new Set<WebSocket>();
  /** Optional handler for incoming WS messages (set by daemon) */
  private wsMessageHandler: WsMessageHandler | null = null;
  /** Ping interval for WS keepalive */
  private wsPingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(port: number, staticDir: string, apiHandler: ApiHandler, log: Logger) {
    this.port = port;
    this.log = log;
    this.staticDir = staticDir;
    this.apiHandler = apiHandler;
  }

  /** Set handler for incoming WS messages */
  setWsMessageHandler(handler: WsMessageHandler): void {
    this.wsMessageHandler = handler;
  }

  /** Start the HTTP server, retrying if port is in TIME_WAIT from previous daemon */
  async start(): Promise<void> {
    const maxRetries = 3;
    const retryDelay = 2000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.tryListen();
        return;
      } catch (err: unknown) {
        const isAddrInUse = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE";
        if (isAddrInUse && attempt < maxRetries) {
          this.log.warn(`Dashboard port ${this.port} in use, retrying in ${retryDelay / 1000}s (${attempt}/${maxRetries})`);
          await new Promise((r) => setTimeout(r, retryDelay));
          continue;
        }
        throw err;
      }
    }
  }

  /** Attempt to bind the HTTP server once */
  private tryListen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      // Attach WebSocket server on /ws path
      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on("connection", (ws) => this.handleWsConnection(ws));

      this.server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if (url.pathname === "/ws" && this.wss) {
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss!.emit("connection", ws, req);
          });
        } else {
          socket.destroy();
        }
      });

      // WS keepalive: ping every 30s, terminate unresponsive clients
      this.wsPingInterval = setInterval(() => {
        for (const ws of this.wsClients) {
          if ((ws as any).__alive === false) {
            ws.terminate();
            continue;
          }
          (ws as any).__alive = false;
          ws.ping();
        }
      }, 30_000);

      this.server.on("error", (err) => {
        try { this.server?.close(); } catch { /* already closed */ }
        this.server = null;
        reject(err);
      });

      this.server.listen(this.port, "0.0.0.0", () => {
        this.log.info(`Dashboard server listening on http://0.0.0.0:${this.port}`);
        resolve();
      });
    });
  }

  /** Stop the HTTP server, force-closing all connections to release the port */
  stop(): void {
    // Close all SSE connections
    for (const client of this.sseClients) {
      client.res.end();
    }
    this.sseClients.clear();

    // Close all WS connections
    if (this.wsPingInterval) {
      clearInterval(this.wsPingInterval);
      this.wsPingInterval = null;
    }
    for (const ws of this.wsClients) {
      ws.close(1001, "Server shutting down");
    }
    this.wsClients.clear();
    this.wsRooms.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      // Force-close all open connections so port is released immediately
      // (prevents TIME_WAIT from blocking next daemon's bind)
      this.server.closeAllConnections();
      this.server.close();
      this.server = null;
    }
  }

  /** Push an SSE event to all connected clients */
  pushEvent(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const client of this.sseClients) {
      try {
        client.res.write(payload);
      } catch {
        // Safe to delete during Set iteration per ES spec
        this.sseClients.delete(client);
      }
    }
  }

  /** Get number of connected SSE clients */
  get sseClientCount(): number {
    return this.sseClients.size;
  }

  /** Get number of connected WS clients */
  get wsClientCount(): number {
    return this.wsClients.size;
  }

  /** Broadcast data to all WS clients subscribed to a session room */
  broadcastToRoom(sessionName: string, data: unknown): void {
    const room = this.wsRooms.get(sessionName);
    if (!room?.size) return;
    const payload = JSON.stringify(data);
    for (const ws of room) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  /** Broadcast data to all connected WS clients */
  broadcastWs(data: unknown): void {
    const payload = JSON.stringify(data);
    for (const ws of this.wsClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  /** Handle new WebSocket connection */
  private handleWsConnection(ws: WebSocket): void {
    (ws as any).__alive = true;
    this.wsClients.add(ws);
    this.log.debug(`WS client connected (total=${this.wsClients.size})`);

    ws.on("pong", () => { (ws as any).__alive = true; });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsClientMessage;
        switch (msg.type) {
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;
          case "subscribe":
            if (msg.sessionName) {
              let room = this.wsRooms.get(msg.sessionName);
              if (!room) {
                room = new Set();
                this.wsRooms.set(msg.sessionName, room);
              }
              room.add(ws);
              ws.send(JSON.stringify({ type: "subscribed", sessionName: msg.sessionName }));
              this.log.debug(`WS subscribed to room: ${msg.sessionName}`);
            }
            break;
          case "unsubscribe":
            if (msg.sessionName) {
              const room = this.wsRooms.get(msg.sessionName);
              if (room) {
                room.delete(ws);
                if (room.size === 0) this.wsRooms.delete(msg.sessionName);
              }
              ws.send(JSON.stringify({ type: "unsubscribed", sessionName: msg.sessionName }));
            }
            break;
          default:
            // Forward to daemon's message handler for SDK/permission messages
            if (this.wsMessageHandler) {
              this.wsMessageHandler(ws, msg, this.wsRooms);
            }
            break;
        }
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      }
    });

    ws.on("close", () => {
      this.wsClients.delete(ws);
      // Remove from all rooms
      for (const [name, room] of this.wsRooms) {
        room.delete(ws);
        if (room.size === 0) this.wsRooms.delete(name);
      }
      this.log.debug(`WS client disconnected (remaining=${this.wsClients.size})`);
    });

    ws.on("error", (err) => {
      this.log.warn(`WS client error: ${err.message}`);
    });

    // Send connected confirmation
    ws.send(JSON.stringify({ type: "connected", timestamp: Date.now() }));
  }

  // -- Request handling -------------------------------------------------------

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // CORS headers for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // SSE endpoint
      if (path === "/api/events") {
        this.handleSse(req, res);
        return;
      }

      // API routes — pass full URL (path + search params) to handler
      if (path.startsWith("/api/")) {
        const fullPath = path + url.search;
        await this.handleApi(req, res, fullPath);
        return;
      }

      // Static files
      this.handleStatic(res, path);
    } catch (err) {
      this.log.error(`HTTP error: ${err}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  /** Handle SSE connection */
  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const clientId = ++this.sseIdCounter;
    const client: SseClient = { res, id: clientId };
    this.sseClients.add(client);

    this.log.debug(`SSE client connected (id=${clientId}, total=${this.sseClients.size})`);

    // Send initial ping
    res.write(`event: connected\ndata: ${JSON.stringify({ id: clientId })}\n\n`);

    // Clean up on disconnect — O(1) Set.delete vs O(n) array filter
    req.on("close", () => {
      this.sseClients.delete(client);
      this.log.debug(`SSE client disconnected (id=${clientId}, remaining=${this.sseClients.size})`);
    });
  }

  /** Handle API request */
  private async handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
  ): Promise<void> {
    // Read request body for POST/PUT/DELETE (with timeout + size limit)
    let body = "";
    if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
      try {
        body = await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let totalLength = 0;
          const MAX_BODY_SIZE = 1024 * 1024; // 1MB

          const timer = setTimeout(() => {
            req.destroy();
            reject(new Error("Request body timeout"));
          }, 10_000);

          req.on("data", (chunk: Buffer) => {
            totalLength += chunk.length;
            if (totalLength > MAX_BODY_SIZE) {
              clearTimeout(timer);
              req.destroy();
              reject(new Error("Payload too large"));
            } else {
              chunks.push(chunk);
            }
          });
          req.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString()); });
          req.on("error", (err) => { clearTimeout(timer); reject(err); });
        });
      } catch (err) {
        const status = (err as Error).message === "Payload too large" ? 413 : 408;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
        return;
      }
    }

    const result = await this.apiHandler(req.method ?? "GET", path, body);
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.data));
  }

  /** Serve static files from the dashboard dist directory */
  private handleStatic(res: http.ServerResponse, urlPath: string): void {
    // Normalize path
    let filePath = urlPath === "/" ? "/index.html" : urlPath;

    // Security: resolve to absolute path and verify it's inside staticDir.
    // Trailing slash on prefix prevents partial-match bypass (e.g. /dist_secrets matching /dist).
    const safePrefix = this.staticDir.endsWith("/") ? this.staticDir : this.staticDir + "/";
    let fullPath = resolve(this.staticDir, filePath.replace(/^\//, ""));
    if (!fullPath.startsWith(safePrefix) && fullPath !== this.staticDir) {
      // Directory traversal attempt — serve fallback
      fullPath = join(this.staticDir, "index.html");
    }

    // If path is a directory (or ends with /), look for index.html inside it
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      fullPath = join(fullPath, "index.html");
    } else if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      // Try appending /index.html for clean URLs (e.g. /memory → /memory/index.html)
      const dirIndex = join(fullPath, "index.html");
      if (existsSync(dirIndex) && statSync(dirIndex).isFile()) {
        fullPath = dirIndex;
      } else {
        // Try appending .html (SvelteKit adapter-static flat output: /memory → memory.html)
        const htmlFile = fullPath + ".html";
        if (existsSync(htmlFile) && statSync(htmlFile).isFile()) {
          fullPath = htmlFile;
        }
      }
    }

    // Check if file exists
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      // Fallback: serve root index.html for unknown routes
      const indexPath = join(this.staticDir, "index.html");
      if (existsSync(indexPath)) {
        const content = readFileSync(indexPath);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(content);
        return;
      }

      // If no dashboard is built, serve a minimal status page
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(this.getFallbackHtml());
      return;
    }

    const ext = extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const content = readFileSync(fullPath);

    // Cache static assets (hashed filenames) but not HTML
    const cacheControl = ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
    });
    res.end(content);
  }

  /** Minimal HTML fallback when dashboard isn't built */
  private getFallbackHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>operad dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
      background: #0d1117; color: #c9d1d9;
      padding: 1rem; max-width: 800px; margin: 0 auto;
    }
    h1 { color: #58a6ff; margin-bottom: 1rem; font-size: 1.2rem; }
    pre { background: #161b22; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; }
    .status { margin: 1rem 0; }
    .green { color: #3fb950; } .yellow { color: #d29922; } .red { color: #f85149; }
    .dim { color: #484f58; }
    #data { white-space: pre-wrap; }
    .err { color: #f85149; font-style: italic; }
  </style>
</head>
<body>
  <h1>operad dashboard</h1>
  <p class="dim">Dashboard not built. Run: <code>cd orchestrator/dashboard && bun install && bun run build</code></p>
  <div class="status">
    <h2>Live Status</h2>
    <pre id="data">Loading...</pre>
  </div>
  <script>
    async function refresh() {
      try {
        const [status, memory] = await Promise.all([
          fetch('/api/status').then(r => r.json()),
          fetch('/api/memory').then(r => r.json()).catch(() => null),
        ]);
        let out = JSON.stringify(status, null, 2);
        if (memory) out += '\\n\\n--- Memory ---\\n' + JSON.stringify(memory, null, 2);
        document.getElementById('data').textContent = out;
      } catch (e) {
        document.getElementById('data').innerHTML = '<span class="err">Failed to fetch: ' + e.message + '</span>';
      }
    }
    refresh();
    setInterval(refresh, 5000);

    // SSE for real-time updates
    const es = new EventSource('/api/events');
    es.addEventListener('state', () => refresh());
    es.addEventListener('memory', () => refresh());
  </script>
</body>
</html>`;
  }
}
