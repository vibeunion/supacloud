import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileProject } from "@supacloud/compiler";
import { initializeAppProject, appStarterFiles } from "./app-starter";
import { runAppTool } from "./app-tools";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "minimal-starter-"));
  roots.push(root);
  await initializeAppProject({ root, name: "sample" });
  return root;
}

test("default initialization is a small feature-local application without optional engines", async () => {
  const root = await fixture();
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(manifest.dependencies["@supacloud/js"]).toBeDefined();
  for (const name of ["rxjs", "@supacloud/commands", "@supacloud/db", "@supacloud/worker", "@supacloud/approval"]) {
    expect(manifest.dependencies[name]).toBeUndefined();
  }
  const config = await readFile(join(root, "supacloud.config.ts"), "utf8");
  expect(config).not.toContain("graphql:");
  expect(await readFile(join(root, "src/app.module.ts"), "utf8")).toContain("./features/health/health");
  await expect(readFile(join(root, "graphql/schema.graphql"), "utf8")).rejects.toThrow();
  await expect(initializeAppProject({ root, name: "sample" })).rejects.toThrow("empty directory");
});

test("minimal source compiles and its colocated health test executes with the new core entry", async () => {
  const root = await fixture();
  const repo = resolve(import.meta.dir, "../../../../..");
  const config = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
  config.compilerOptions.paths = {
    "@supacloud/app/core": [join(repo, "packages/app/src/core.ts")],
  };
  await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
  await symlink(join(repo, "packages/cli/node_modules"), join(root, "node_modules"), "dir");
  const compiled = await compileProject({
    rootDir: join(root, "src"),
    outDir: join(root, "generated"),
    strict: true,
    writeOnError: false,
  });
  expect(compiled.diagnostics.filter(item => item.severity === "error")).toEqual([]);
  const plan = await runAppTool({ action: "verify-plan", root, target: "health", format: "json" });
  expect(plan.isError).toBe(false);
  expect(JSON.parse(plan.content[0]!.text).tests).toEqual(["src/features/health/health.test.ts"]);
  const child = Bun.spawn([process.execPath, "--no-env-file", "test", "src/features/health/health.test.ts"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, errors: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, errors: "" });
});

test("the persistent command example remains an explicit compatible recipe", () => {
  const files = appStarterFiles("reference");
  expect(files["src/host/review-postgres.ts"]).toContain("createTransactionalCommand");
  expect(files["migrations/001-review.sql"]).toBeDefined();
  expect(files["scripts/serve-integration.ts"]).toContain("createDeliveryApplication");
  expect(files["scripts/serve-integration.ts"]).not.toContain("createMemorySandbox");
  expect(files["scripts/dev.ts"]).toContain("scripts/serve-integration.ts");
});

test("generated integration entry typechecks as a module with top-level await", async () => {
  const root = await mkdtemp(join(tmpdir(), "integration-entry-"));
  roots.push(root);
  const dependencies = resolve(import.meta.dir, "../../../node_modules");
  await symlink(dependencies, join(root, "node_modules"), "dir");
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/integration.ts"), appStarterFiles("reference")["scripts/integration.ts"]!);
  // Isolate the entry's module contract from the watcher's separately tested implementation.
  await writeFile(join(root, "scripts/dev.ts"), "export {};\n");
  const child = Bun.spawn([process.execPath, join(dependencies, "typescript/bin/tsc"),
    "--noEmit", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler",
    "--types", "bun", "--skipLibCheck", "scripts/integration.ts"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, errors: code ? stdout + stderr : "" }).toEqual({ code: 0, errors: "" });
});
