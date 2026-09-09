import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const dependencies: Readonly<Record<string, readonly string[]>> = {
  app: ["contracts"],
  db: ["contracts"],
  commands: ["contracts"],
  "app-svelte": ["contracts"],
  elysia: ["contracts", "commands", "db", "app", "compiler"],
};
const consumer = process.argv[2];
if (consumer === undefined || !Object.hasOwn(dependencies, consumer)) {
  throw new Error("Expected a command consumer package name");
}
const order = dependencies[consumer];
if (order === undefined) throw new Error("Missing dependency order");
const root = fileURLToPath(new URL("../", import.meta.url));
for (const name of order) {
  for (const args of [["install", "--force", "--ignore-scripts", "--frozen-lockfile"], ["run", "build"]]) {
    const result = Bun.spawnSync([process.execPath, ...args], {
      cwd: resolve(root, "packages", name), stdout: "inherit", stderr: "inherit",
    });
    if (result.exitCode !== 0) throw new Error(`Dependency build failed: ${name}`);
  }
}
