// src/server.ts
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
var root = join(process.cwd(), "static");
var port = Number(process.env.PORT || 8765);
var mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".json": "application/json" };
createServer(async (request, response) => {
  try {
    if (request.url === "/api/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", runtime: "typescript-web-worker", neurons: 177, edges: 2903 }));
      return;
    }
    const urlPath = request.url === "/" ? "index.html" : (request.url || "/").split("?")[0].replace(/^\/static\//, "");
    const file = normalize(join(root, urlPath));
    if (!file.startsWith(root) || !(await stat(file)).isFile()) throw new Error("not found");
    response.setHeader("content-type", mime[extname(file)] || "application/octet-stream");
    response.setHeader("cache-control", extname(file) === ".html" ? "no-cache" : "public, max-age=3600");
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
}).listen(port, "0.0.0.0", () => console.log(`CionaBrain static server on :${port}`));
