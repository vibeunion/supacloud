import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAppDatabaseSources } from "./app-database-check";

const roots: string[] = [];
async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "app-db-check-")));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tool(root: string, source: string): Promise<void> {
  const directory = join(root, "node_modules/@supacloud/db");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "@supacloud/db", type: "module", exports: { "./source-contracts-cli": "./cli.js" },
  }));
  await writeFile(join(directory, "cli.js"), source);
}
test("HTTP projects are not forced to install a database tool", async () => {
  expect(checkAppDatabaseSources(await project())).toBeUndefined();
});
test("configured projects fail closed on unavailable, malformed or failed installed checkers", async () => {
  const root = await project();
  await writeFile(join(root, "database.sources.json"), "{}");
  expect(checkAppDatabaseSources(root)?.ok).toBe(false);
  for (const source of [
    'console.log("not JSON")',
    'console.log(JSON.stringify({scope:"local-source-contracts",ok:true,findings:[]}));process.exitCode=1;',
  ]) {
    const installed = await project();
    await writeFile(join(installed, "database.sources.json"), "{}");
    await tool(installed, source);
    expect(checkAppDatabaseSources(installed)?.ok).toBe(false);
  }
  const invalid = await project();
  await writeFile(join(invalid, "database.sources.json"), "{}");
  await tool(invalid, 'console.log(JSON.stringify({scope:"local-source-contracts",ok:false,findings:[{file:"src/main.ts",message:"Audit input"}]}));');
  expect(checkAppDatabaseSources(invalid)).toMatchObject({ ok: false, detail: "src/main.ts: Audit input" });
});
test("only check is executed with an explicit project root and no generation", async () => {
  const root = await project();
  await writeFile(join(root, "database.sources.json"), "{}");
  await tool(root, `if (process.argv[2] !== "check" || process.argv[3] !== "--root" || process.argv[4] !== process.cwd()) throw Error("Unexpected arguments");
console.log(JSON.stringify({scope:"local-source-contracts",ok:true,findings:[]}));`);
  expect(checkAppDatabaseSources(root)?.ok).toBe(true);
});
