import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeAppProject } from "../../cli/src/shared/tools/app-starter";
import { checkAppDatabaseSources } from "../../cli/src/shared/tools/app-database-check";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("built package CLI generates/checks a real starter; doctor uses the same read-only gate", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "db-source-cli-")));
  roots.push(root);
  const project = join(root, "project"), packed = join(root, "package");
  await initializeAppProject({ root: project, name: "example" });
  await mkdir(packed);
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "source-contracts-cli.ts")],
    outdir: packed, target: "node", external: ["libpg-query", "@typescript/typescript6"],
  });
  expect(built.success).toBe(true);
  await writeFile(join(packed, "package.json"), JSON.stringify({
    name: "@supacloud/db", type: "module",
    exports: { "./source-contracts-cli": "./source-contracts-cli.js" },
  }));
  await symlink(resolve(import.meta.dir, "../node_modules"), join(packed, "node_modules"), "dir");
  await mkdir(join(project, "node_modules/@supacloud"), { recursive: true });
  await symlink(packed, join(project, "node_modules/@supacloud/db"), "dir");
  const run = (args: string[]) => Bun.spawnSync([
    process.execPath, "--no-env-file", join(packed, "source-contracts-cli.js"), ...args, "--root", project,
  ], { cwd: project, stdout: "pipe", stderr: "pipe" });
  expect(run(["check"]).exitCode).toBe(1);
  const generated = run(["generate"]);
  expect({ status: generated.exitCode, error: generated.stderr.toString() }).toEqual({ status: 0, error: "" });
  expect(run(["check"]).exitCode).toBe(0);
  expect(checkAppDatabaseSources(project)?.ok).toBe(true);
  const before = await readFile(join(project, "db/contracts/manifest.json"), "utf8");
  await writeFile(join(project, "src/ordinary.ts"), 'readFile("output/database-audit/schema.sql");');
  expect(run(["check"]).exitCode).toBe(1);
  expect(checkAppDatabaseSources(project)).toMatchObject({ ok: false });
  expect(run(["assess"]).exitCode).toBe(0);
  expect(await readFile(join(project, "db/contracts/manifest.json"), "utf8")).toBe(before);
  expect(run(["generate", "--force"]).exitCode).toBe(1);
});
