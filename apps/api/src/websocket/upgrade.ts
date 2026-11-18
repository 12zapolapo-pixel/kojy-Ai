/**
 * Routes WebSocket upgrades on the API's HTTP server by path.
 * OWNERSHIP: apps/api/src/websocket
 *
 *   /ws           live updates (gateway.ts)
 *   /ws/terminal  the owner's shell for a bot (terminal.ts)
 *
 * Each WebSocketServer is created with noServer: several servers attached to
 * one HTTP server each answer the other's paths with a 400.
 */

import type { IncomingMessage, Server as HttpServer } from "http";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";

export function routeUpgrades(server: HttpServer, routes: Record<string, WebSocketServer>): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = "";
    try { pathname = new URL(req.url ?? "/", "http://localhost").pathname; } catch { /* bad URL */ }
    const wss = routes[pathname];
    if (!wss) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}
