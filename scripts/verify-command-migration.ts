import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const connection = process.env["SUPACLOUD_COMMAND_TEST_URL"];
if (!connection) throw new Error("SUPACLOUD_COMMAND_TEST_URL is required; native acceptance must not silently skip");
const url = new URL(connection);
if (url.hostname !== "127.0.0.1" || url.pathname !== "/supacloud_commands_test") {
  throw new Error("Use the isolated local supacloud_commands_test database");
}

const logDir = resolve(root, "output/command-migration");
await mkdir(logDir, { recursive: true });
let step = 0;
async function run(cwd: string, args: string[], executable = process.execPath) {
  console.log(`\n${cwd}: ${args.join(" ")}`);
  const child = Bun.spawn([executable, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  const output = `${stdout}\n${stderr}`;
  await Bun.write(resolve(logDir, `${String(++step).padStart(2, "0")}.log`), output);
  console.log(output.trim().split("\n").slice(-8).join("\n"));
  if (status !== 0) throw new Error(`Command migration gate failed in ${cwd}: ${args.join(" ")}`);
}

await run(root, ["scripts/prepare-command-test-database.ts"]);
for (const name of ["contracts", "commands", "db", "app", "compiler", "app-svelte", "supacloud-js", "elysia"]) {
  const cwd = resolve(root, "packages", name);
  // Bun copies file dependencies; refresh them after upstream builds.
  await run(cwd, ["install", "--force", "--ignore-scripts", "--frozen-lockfile"]);
  if (name === "elysia") await run(cwd, ["run", "generate:example"]);
  await run(cwd, ["run", "typecheck"]);
  await run(cwd, ["run", "typecheck:test"]);
  if (name === "db" || name === "supacloud-js") await run(cwd, ["-p", "tsconfig.commands.json"], resolve(cwd, "node_modules/.bin/tsc"));
  await run(cwd, ["test"]);
  await run(cwd, ["run", "build"]);
  if (name === "supacloud-js") await run(cwd, ["run", "typecheck:consumer"]);
}
await run(root, ["run", "check:boundaries"]);
const node = Bun.which("node");
if (!node) throw new Error("Node.js is required for release script tests");
await run(root, ["--test", ".github/scripts/prepare-command-package.test.mjs", ".github/scripts/ai-review-merge.test.mjs"], node);
await run(root, ["-p", "scripts/tsconfig.commands.json"], resolve(root, "packages/compiler/node_modules/.bin/tsc"));
console.log("\nCommand migration package/native gates passed. Run the Svelte browser acceptance separately.");
