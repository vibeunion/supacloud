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
  expect(result.artifacts.contractsManifest.features).toBe(0);
  expect(result.artifacts.contractsManifest.jobs).toBe(0);
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

test("migration assessment rejects a contract manifest without Feature Slice inventory", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-migration-assess-feature-manifest-"));
  await writeFixtureProject(rootDir, GOOD_PROJECT_FILES);
  const outDir = join(rootDir, "generated");
  const { compileProject } = await import("./compile");
  await compileProject({ rootDir, outDir });
  await writeFile(join(outDir, "contracts.manifest.json"), JSON.stringify({
    version: 1, commands: [], queries: [], routes: [], permissions: [],
  }), "utf8");

  const result = await assessMigration({
    projectDir: rootDir,
    compile: { rootDir, outDir },
    renderMode: "browser",
  });

  expect(result.findings.map((finding) => finding.code)).toContain("contract-manifest-not-proven");
});

test("migration assessment rejects malformed Feature Slice transitions", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-migration-assess-feature-shape-"));
  await writeFixtureProject(rootDir, GOOD_PROJECT_FILES);
  const outDir = join(rootDir, "generated");
  const { compileProject } = await import("./compile");
  await compileProject({ rootDir, outDir });
  await writeFile(join(outDir, "contracts.manifest.json"), JSON.stringify({
    version: 1, commands: [], queries: [], routes: [], permissions: [],
    features: [{ name: "case", states: ["draft"], transitions: [{ name: "approve", from: "draft", to: "missing" }] }],
  }), "utf8");

  const result = await assessMigration({
    projectDir: rootDir,
    compile: { rootDir, outDir },
    renderMode: "browser",
  });

  expect(result.findings.map((finding) => finding.code)).toContain("contract-manifest-not-proven");
});

test("migration assessment rejects downgraded transition Job metadata", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-migration-assess-job-details-"));
  await writeFixtureProject(rootDir, GOOD_PROJECT_FILES);
  const outDir = join(rootDir, "generated");
  const { compileProject } = await import("./compile");
  await compileProject({ rootDir, outDir });
  await writeFile(join(outDir, "contracts.manifest.json"), JSON.stringify({
    version: 1, commands: [], queries: [], routes: [], permissions: [],
    jobs: [{
      name: "case.refresh", className: "RefreshCaseJob", module: "case",
      input: "RefreshCaseInput", mode: "task", idempotency: "none", tenantScope: "required",
    }],
    features: [{
      name: "case", states: ["draft", "approved"], tenantField: "tenant_id",
      transitions: [{
        name: "approve", from: "draft", to: "approved", job: "case.refresh",
        jobDetails: {
          name: "case.refresh", className: "RefreshCaseJob",
          mode: "task", idempotency: "none", tenantScope: "required",
        },
      }],
    }],
  }), "utf8");

  const result = await assessMigration({
    projectDir: rootDir,
    compile: { rootDir, outDir },
    renderMode: "browser",
  });

  expect(result.findings.map((finding) => finding.code)).toContain("contract-manifest-not-proven");
});

test("migration assessment accepts transition Job bindings by class name", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-migration-assess-job-class-"));
  await writeFixtureProject(rootDir, GOOD_PROJECT_FILES);
  const outDir = join(rootDir, "generated");
  const { compileProject } = await import("./compile");
  await compileProject({ rootDir, outDir });
  await writeFile(join(outDir, "contracts.manifest.json"), JSON.stringify({
    version: 1, commands: [], queries: [], routes: [], permissions: [],
    jobs: [{
      name: "case.refresh", className: "RefreshCaseJob", module: "case",
      input: "RefreshCaseInput", inputKind: "declared",
      mode: "task", idempotency: "required", tenantScope: "required",
    }],
    features: [{
      name: "case", states: ["draft", "approved"], tenantField: "tenant_id",
      transitions: [{
        name: "approve", from: "draft", to: "approved", job: "RefreshCaseJob",
        jobDetails: {
          name: "case.refresh", className: "RefreshCaseJob",
          input: "RefreshCaseInput", inputKind: "declared",
          mode: "task", idempotency: "required", tenantScope: "required",
        },
        command: "ApproveCase",
        permission: "case.approve",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version", tenantField: "tenant_id", stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    }],
  }), "utf8");

  const result = await assessMigration({
    projectDir: rootDir,
    compile: { rootDir, outDir },
    renderMode: "browser",
  });

  expect(result.findings.map((finding) => finding.code)).not.toContain("contract-manifest-not-proven");
});

test("migration assessment rejects duplicate Job inventory identities", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-migration-assess-job-duplicates-"));
  await writeFixtureProject(rootDir, GOOD_PROJECT_FILES);
  const outDir = join(rootDir, "generated");
  const { compileProject } = await import("./compile");
  await compileProject({ rootDir, outDir });
  await writeFile(join(outDir, "contracts.manifest.json"), JSON.stringify({
    version: 1, commands: [], queries: [], routes: [], permissions: [],
    jobs: [
      { name: "case.refresh", className: "RefreshCaseJob", module: "case" },
      { name: "case.refresh", className: "OtherRefreshJob", module: "case" },
    ],
    features: [],
  }), "utf8");

  const result = await assessMigration({
    projectDir: rootDir,
    compile: { rootDir, outDir },
    renderMode: "browser",
  });

  expect(result.findings.map((finding) => finding.code)).toContain("contract-manifest-not-proven");
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
