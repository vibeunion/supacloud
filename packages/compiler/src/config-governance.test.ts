import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileOptionsFromConfig, loadSupacloudConfig } from "./config";
import { compileProject, checkProject } from "./compile";
import { writeFixtureProject } from "./fixtures/helpers";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(config: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "compiler-governance-"));
  temporary.push(root);
  await writeFixtureProject(root, { "supacloud.config.mjs": `export default ${JSON.stringify(config)};` });
  return root;
}

test.each([
  { moduleBoundaries: {} },
  { moduleBoundaries: [null] },
  { moduleBoundaries: [{ sourceTag: "" }] },
  { moduleBoundaries: [{ sourceTag: "feature", bannedDependenciesWithTags: [1] }] },
  { moduleBoundaries: [{ sourceTag: "feature", onlyDependOnLibsWithTags: "shared" }] },
  { moduleBoundaries: [{ sourceTag: "feature", bannedDependenciesWithTag: ["shared"] }] },
  { typeSafety: false },
  { typeSafety: { scanProductionSource: "true" } },
  { typeSafety: { noAnyInGenerated: 1 } },
  { typeSafety: { exclude: [null] } },
  { typeSafety: { scanProductionSources: true } },
  { allowRouteCommandBindings: "false" },
  { disallowControllerDirectDb: 1 },
  { detectOrphanModules: null },
])("rejects invalid governance configuration from a file: %j", async (config) => {
  const root = await fixture(config);
  await expect(loadSupacloudConfig(root)).rejects.toThrow();
});

test("a config-file Command binding rule is enforced by both compile and check", async () => {
  const root = await fixture({
    root: "src",
    strict: false,
    allowRouteCommandBindings: false,
  });
  await writeFixtureProject(root, GOOD_PROJECT_FILES);
  const config = compileOptionsFromConfig(await loadSupacloudConfig(root), root);
  const compiled = await compileProject(config);
  const checked = await checkProject(config);
  expect(compiled.diagnostics.some((item) => item.code === "route-command-binding-disallowed" && item.severity === "error")).toBe(true);
  expect(checked.diagnostics.some((item) => item.code === "route-command-binding-disallowed" && item.severity === "error")).toBe(true);
  expect(compiled.written).toEqual([]);
});

test("CLI applies configured type safety instead of requiring a custom compilation script", async () => {
  const root = await fixture({
    root: "src", strict: true,
    typeSafety: { scanProductionSource: true, noAnyInGenerated: true },
  });
  await writeFixtureProject(root, {
    "src/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, types: [] } }),
    "src/main.ts": "export const invalid: any = 1;",
  });
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "--no-env-file", join(import.meta.dir, "cli.ts"), "compile", "--json"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect(status).toBe(1);
  expect(stderr).toBe("");
  const result: unknown = JSON.parse(stdout);
  expect(result).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "source-any", severity: "error" })]),
    written: [],
  });
});
