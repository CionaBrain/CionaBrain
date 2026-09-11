import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("dist-tests", { recursive: true });
await build({ entryPoints: ["tests-ts/core.test.ts"], outfile: "dist-tests/core.test.js", bundle: true, platform: "node", format: "esm", target: "node20" });
