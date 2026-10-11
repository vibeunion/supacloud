import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const bundlePath = join(packageRoot, "dist", "index.js");
const bundle = readFileSync(bundlePath, "utf8");

for (const forbidden of ["/home/runner/work/", "libpg-query/wasm/libpg-query.js"]) {
  if (bundle.includes(forbidden)) {
    throw new Error(`CLI release bundle contains non-portable parser path: ${forbidden}`);
  }
}

const result = spawnSync(process.execPath, [bundlePath, "--version"], {
  cwd: packageRoot,
  encoding: "utf8",
});
if (result.status !== 0) {
  throw new Error(`CLI release bundle failed to start: ${result.stderr || result.stdout}`);
}
if (!/^\d+\.\d+\.\d+(?:\r?\n)?$/.test(result.stdout)) {
  throw new Error(`CLI release bundle returned an invalid version: ${result.stdout}`);
}

console.log(`CLI release bundle verified: ${result.stdout.trim()}`);
