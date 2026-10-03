import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const consumer = process.argv[2];
if (!consumer || process.argv.length !== 3) throw new Error("Expected one workspace consumer package name");
const root = fileURLToPath(new URL("../", import.meta.url));
function run(command: string, args: string[]): void {
  const result = Bun.spawnSync([command, ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Workspace dependency preparation failed (${result.exitCode})`);
}
// This repository-only helper has always installed dependencies. It does not ship in applications.
if (!(await Bun.file(resolve(root, "node_modules/nx/package.json")).exists())) {
  run(process.execPath, ["install", "--ignore-scripts", "--frozen-lockfile"]);
}
const node = Bun.which("node");
if (!node) throw new Error("Node.js is required by repository Nx tooling");
run(node, [resolve(root, "scripts/workspace/cli.mjs"), "prepare", "--project", consumer]);
