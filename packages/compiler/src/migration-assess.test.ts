import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessMigration } from "./migration-assess";
import { migrationDependencies } from "./migration-policy";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";

async function writeInstalledTuple(rootDir: string): Promise<void> {
  for (const [name, version] of Object.entries(migrationDependencies())) {
    const directory = join(rootDir, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version }), "utf8");
  }
}

const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: { title: "fixture", version: "1" },
  paths: {},
};

test("migration assessment is read-only and does not require SSR", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-migration-assess-"));
  await writeFixtureProject(rootDir, GOOD_PROJECT_FILES);
  await writeInstalledTuple(rootDir);
  const outDir = join(rootDir, "generated");
  const { compileProject } = await import("./compile");
  await compileProject({ rootDir, outDir });
  const baselinePath = join(rootDir, "openapi-baseline.json");
  const currentPath = join(rootDir, "openapi-current.json");
  await writeFile(baselinePath, JSON.stringify(OPENAPI_DOCUMENT), "utf8");
  await writeFile(currentPath, JSON.stringify(OPENAPI_DOCUMENT), "utf8");

  const result = await assessMigration({
    projectDir: rootDir,
    compile: { rootDir, outDir },
    baselineOpenApiPath: baselinePath,
    currentOpenApiPath: currentPath,
    renderMode: "browser",
  });

  expect(result.status).toBe("compatible");
  expect(result.ok).toBe(true);
  expect(result.readOnly).toBe(true);
  expect(result.writesPerformed).toBe(false);
  expect(result.rendering).toMatchObject({ selected: "browser", ssrRequired: false });
  expect(result.rendering.supportedModes).toContain("ssr");
});

test("migration assessment reports missing evidence without prescribing SSR", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-migration-assess-missing-"));
  await writeFixtureProject(rootDir, GOOD_PROJECT_FILES);
  const outDir = join(rootDir, "generated");
  const result = await assessMigration({
    projectDir: rootDir,
    compile: { rootDir, outDir },
    renderMode: "unspecified",
  });

  expect(result.status).toBe("not-proven");
  expect(result.ok).toBe(false);
  expect(result.rendering.ssrRequired).toBe(false);
  expect(result.findings.map((finding) => finding.code)).toContain("openapi-baseline-not-proven");
});

test("CLI exposes the read-only assessment with an explicit non-SSR boundary", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-migration-assess-cli-"));
  const child = Bun.spawn([
    process.execPath,
    "--no-env-file",
    join(import.meta.dir, "cli.ts"),
    "migration-assess",
    "--json",
    "--render-mode",
    "browser",
  ], { cwd: rootDir, stdout: "pipe", stderr: "pipe" });
  const [status, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  expect(status).toBe(0);
  const result = JSON.parse(stdout) as {
    status: string;
    rendering: { selected: string; ssrRequired: boolean };
  };
  expect(result.status).toBe("not-proven");
  expect(result.rendering).toMatchObject({ selected: "browser", ssrRequired: false });
});
