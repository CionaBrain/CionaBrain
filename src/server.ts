import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { parseConnectome } from "./connectome";
import { LiveCionaRuntime, type LiveCommand } from "./live-runtime";

const root = join(process.cwd(), "static");
const port = Number(process.env.PORT || 8765);
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".json": "application/json" };
const graph = parseConnectome(readFileSync(join(process.cwd(), "data/nodes.csv"), "utf8"), readFileSync(join(process.cwd(), "data/edges.csv"), "utf8"));
const live = new LiveCionaRuntime(graph);
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/api/health") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ status: "ok", runtime: "shared-live-ciona", neurons: 177, edges: 2903, viewers: live.viewers, generation: live.generation, age_seconds: +(live.simulator.timeMs / 1000).toFixed(1) })); return; }
    const urlPath = request.url === "/" ? "index.html" : (request.url || "/").split("?")[0].replace(/^\/static\//, "");
    const file = normalize(join(root, urlPath));
    if (!file.startsWith(root) || !(await stat(file)).isFile()) throw new Error("not found");
    response.setHeader("content-type", mime[extname(file)] || "application/octet-stream");
    response.setHeader("cache-control", extname(file) === ".html" ? "no-cache" : "public, max-age=3600");
    response.end(await readFile(file));
  } catch { response.statusCode = 404; response.end("Not found"); }
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url || "/", "http://localhost").pathname !== "/ws") { socket.destroy(); return; }
  sockets.handleUpgrade(request, socket, head, client => sockets.emit("connection", client, request));
});

function send(client: WebSocket, message: Record<string, unknown>): void {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}
function broadcast(message: Record<string, unknown>): void {
  const encoded = JSON.stringify(message);
  for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) client.send(encoded);
}

sockets.on("connection", client => {
  live.viewers = sockets.clients.size;
  let nextCommandAt = 0;
  send(client, live.metadata());
  broadcast(live.state());
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
  client.on("close", () => { live.viewers = sockets.clients.size; broadcast(live.state()); });
});

let broadcasts = 0;
setInterval(() => {
  live.tick(10);
  if (++broadcasts % 2 === 0) broadcast(live.state());
}, 50);

server.listen(port, "0.0.0.0", () => console.log(`CionaBrain shared organism listening on :${port}`));
