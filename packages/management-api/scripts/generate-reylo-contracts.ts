import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const cacheDir = join(packageRoot, ".reylo");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to infer Reylo control-plane query types");
}

const typecheck = Bun.spawnSync({
  cmd: [process.execPath, "run", "typecheck:reylo"],
  cwd: packageRoot,
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
if (typecheck.exitCode !== 0) throw new Error("Reylo contract typecheck failed");

if (!existsSync(cacheDir)) throw new Error("Reylo typecheck did not create .reylo");
const queries = readdirSync(join(cacheDir, "queries")).filter((name) => name.endsWith(".json"));
if (queries.length === 0) throw new Error("Reylo cache contains no query analyses");

const commit = Bun.spawnSync({
  cmd: ["git", "rev-parse", "HEAD"],
  cwd: packageRoot,
  stdout: "pipe",
  stderr: "ignore",
});
const manifest = {
  version: 1,
  commit: commit.exitCode === 0 ? commit.stdout.toString().trim() : null,
  generatedAt: new Date().toISOString(),
  queryCount: queries.length,
};
writeFileSync(join(cacheDir, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Reylo contracts ready: ${queries.length} queries, commit ${manifest.commit ?? "unknown"}`);
