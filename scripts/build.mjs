import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";

await mkdir("static/dist", { recursive: true });
await mkdir("static/data", { recursive: true });
await Promise.all([
  copyFile("data/nodes.csv", "static/data/nodes.csv"),
  copyFile("data/edges.csv", "static/data/edges.csv"),
  build({ entryPoints: ["src/app.ts"], outfile: "static/dist/app.js", bundle: true, minify: true, target: "es2022" }),
  build({ entryPoints: ["src/worker.ts"], outfile: "static/dist/simulator.worker.js", bundle: true, minify: true, format: "esm", target: "es2022" }),
  build({ entryPoints: ["src/server.ts"], outfile: "dist/server.js", bundle: true, platform: "node", packages: "external", format: "esm", target: "node20" }),
]);
