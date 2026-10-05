import { fileURLToPath } from "node:url";

// Compatibility entrypoint for existing CI and acceptance scripts. Nx owns
// prerequisite ordering and deduplication; verification-only dependencies live
// separately from runtime dependencies in scripts/workspace/verification.mjs.
const consumer = process.argv[2];
if (process.argv.length !== 3 || consumer === undefined) {
  throw new Error("Expected exactly one command consumer package name");
}
const runner = fileURLToPath(new URL("./workspace/prepare.mjs", import.meta.url));
const result = Bun.spawnSync(["node", runner, consumer], {
  stdout: "inherit", stderr: "inherit",
});
if (result.exitCode !== 0) throw new Error(`Dependency preparation failed: ${consumer}`);
