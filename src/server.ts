import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { parseConnectome } from "./connectome";
import { LiveCionaRuntime, type LiveCommand } from "./live-runtime";

const root = join(process.cwd(), "static");
const port = Number(process.env.PORT || 8765);
const broadcastHz = Math.max(1, Math.min(20, Number(process.env.BROADCAST_HZ || 8)));
const maxViewers = Math.max(100, Number(process.env.MAX_VIEWERS || 250));
const maxBufferedBytes = Math.max(64 * 1024, Number(process.env.MAX_BUFFERED_BYTES || 256 * 1024));
let slowClientDrops = 0;
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".json": "application/json" };
const graph = parseConnectome(readFileSync(join(process.cwd(), "data/nodes.csv"), "utf8"), readFileSync(join(process.cwd(), "data/edges.csv"), "utf8"));
const live = new LiveCionaRuntime(graph);
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/api/health") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ status: "ok", runtime: "shared-live-ciona", neurons: 177, edges: 2903, viewers: live.viewers, max_viewers: maxViewers, broadcast_hz: broadcastHz, slow_client_drops: slowClientDrops, generation: live.generation, age_seconds: +(live.simulator.timeMs / 1000).toFixed(1) })); return; }
    const urlPath = request.url === "/" ? "index.html" : (request.url || "/").split("?")[0].replace(/^\/static\//, "");
    const file = normalize(join(root, urlPath));
    if (!file.startsWith(root) || !(await stat(file)).isFile()) throw new Error("not found");
    response.setHeader("content-type", mime[extname(file)] || "application/octet-stream");
    response.setHeader("cache-control", extname(file) === ".html" ? "no-cache" : "public, max-age=3600");
    response.end(await readFile(file));
  } catch { response.statusCode = 404; response.end("Not found"); }
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url || "/", "http://localhost").pathname !== "/ws") { socket.destroy(); return; }
  if (sockets.clients.size >= maxViewers) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 10\r\n\r\n");
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, client => sockets.emit("connection", client, request));
});

function send(client: WebSocket, message: Record<string, unknown>): void {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}
function broadcast(message: Record<string, unknown>): void {
  const encoded = JSON.stringify(message);
  // Serialize once for every viewer. Slow tabs are skipped (and eventually
  // disconnected) instead of accumulating unbounded queued state snapshots.
  for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) {
    if (client.bufferedAmount > maxBufferedBytes * 4) { slowClientDrops++; client.terminate(); }
    else if (client.bufferedAmount <= maxBufferedBytes) client.send(encoded);
  }
}

const alive = new WeakSet<WebSocket>();
sockets.on("connection", client => {
  alive.add(client);
  live.viewers = sockets.clients.size;
  let nextCommandAt = 0;
  send(client, live.metadata());
  // Send initial state only to the newcomer. Broadcasting on every join/leave
  // would become O(n²) during a burst of 100 connections.
  send(client, live.state());
  client.on("message", raw => {
    try {
      const now = Date.now();
      if (now < nextCommandAt) throw new Error("Interaction rate limit: wait a moment and try again.");
      nextCommandAt = now + 180;
      const command = JSON.parse(raw.toString()) as LiveCommand;
      for (const message of live.command(command)) send(client, message);
    } catch (error) {
      send(client, { type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });
  client.on("pong", () => alive.add(client));
  client.on("error", () => client.terminate());
  client.on("close", () => { live.viewers = sockets.clients.size; });
});

let broadcastBudget = 0;
const simulationTimer = setInterval(() => {
  live.tick(10);
  // The simulation timer is 20 Hz; an accumulator preserves exact configured
  // rates such as 8 Hz instead of rounding them to a divisor of 20.
  broadcastBudget += broadcastHz;
  if (broadcastBudget >= 20) { broadcastBudget -= 20; broadcast(live.state()); }
}, 50);

const heartbeatTimer = setInterval(() => {
  for (const client of sockets.clients) {
    if (!alive.has(client)) { client.terminate(); continue; }
    alive.delete(client);
    client.ping();
  }
}, 30_000);

function shutdown(): void {
  clearInterval(simulationTimer);
  clearInterval(heartbeatTimer);
  for (const client of sockets.clients) client.close(1001, "Server shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

server.listen({ port, host: "0.0.0.0", backlog: 256 }, () => console.log(`CionaBrain shared organism listening on :${port} · ${broadcastHz} Hz · max ${maxViewers} viewers`));
