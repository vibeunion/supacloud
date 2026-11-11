import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeAppProject, appStarterFiles } from "./app-starter";
import { resolveStarterTemplate } from "./app-starter-templates";
import { runAppTool } from "./app-tools";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(template?: "minimal" | "client" | "app") {
  const root = await mkdtemp(join(tmpdir(), "minimal-starter-"));
  roots.push(root);
  await initializeAppProject({ root, name: "sample", ...(template ? { template } : {}) });
  return root;
}

test("operator checklist matches the current default app init", async () => {
  const repo = resolve(import.meta.dir, "../../../../..");
  const en = await readFile(join(repo, "docs/self-hosted-stable-baseline.md"), "utf8");
  const zh = await readFile(join(repo, "docs/self-hosted-stable-baseline.zh-CN.md"), "utf8");
  const enRow = en.split("\n").find((line) => line.startsWith("| Default app init |"));
  const zhRow = zh.split("\n").find((line) => line.startsWith("| 默认 app init |"));
  expect(enRow).toBeDefined();
  expect(zhRow).toBeDefined();
  for (const row of [enRow!, zhRow!]) {
    expect(row).toContain("minimal");
    expect(row).toContain("@supacloud/app");
    expect(row).toContain("@supacloud/compiler");
    expect(row).toContain("@supacloud/elysia");
    expect(row).toContain("Effect");
    expect(row).toContain("@supabase/supabase-js");
    expect(row).toContain("--template client");
    expect(row).toContain("command");
    expect(row).toContain("model-command");
    expect(row).not.toContain("--template app");
    expect(row).not.toContain("supabase-js` only");
    expect(row).not.toContain("只生成");
  }
  expect(enRow).toContain("`app` is an alias of `minimal`");
  expect(zhRow).toContain("`app` 是 `minimal` 的别名");
  expect(enRow).toContain("supabase-js-only");
  expect(zhRow).toContain("仅含 supabase-js");
});

test("resolveStarterTemplate forces minimal and accepts the app alias", () => {
  expect(resolveStarterTemplate(undefined)).toBe("minimal");
  expect(resolveStarterTemplate("minimal")).toBe("minimal");
  expect(resolveStarterTemplate("client")).toBe("client");
  expect(resolveStarterTemplate("app")).toBe("minimal");
  expect(resolveStarterTemplate("command")).toBe("command");
  expect(resolveStarterTemplate("model-command")).toBe("model-command");
  expect(() => resolveStarterTemplate("surreal")).toThrow(/Unknown app init template/);
});

test("default initialization is the compiler/Effect stack with supabase-js as the data plane", async () => {
  const root = await fixture();
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(manifest.dependencies["@supacloud/app"]).toBeDefined();
  expect(manifest.dependencies["@supacloud/elysia"]).toBeDefined();
  expect(manifest.dependencies.effect).toBeDefined();
  expect(manifest.dependencies.elysia).toBeDefined();
  expect(manifest.dependencies["@supabase/supabase-js"]).toBeDefined();
  expect(manifest.dependencies["@supacloud/js"]).toBeDefined();
  expect(manifest.devDependencies["@supacloud/compiler"]).toBeDefined();
  expect(manifest.scripts.compile).toContain("@supacloud/compiler");
  expect(await readFile(join(root, "src/app.module.ts"), "utf8")).toContain("HealthModule");
  expect(await readFile(join(root, "src/features/health/health.ts"), "utf8")).toContain("Effect");
  await expect(readFile(join(root, "src/client.ts"), "utf8")).rejects.toThrow();
  await expect(readFile(join(root, "graphql/schema.graphql"), "utf8")).rejects.toThrow();
  await expect(initializeAppProject({ root, name: "sample" })).rejects.toThrow("empty directory");
});

test("explicit client template is supabase-js only without the compiler stack", async () => {
  const root = await fixture("client");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(manifest.dependencies["@supabase/supabase-js"]).toBeDefined();
  for (const name of [
    "rxjs", "effect", "elysia", "@supacloud/js", "@supacloud/app", "@supacloud/elysia",
    "@supacloud/commands", "@supacloud/db", "@supacloud/worker", "@supacloud/approval",
  ]) {
    expect(manifest.dependencies[name]).toBeUndefined();
  }
  expect(manifest.devDependencies["@supacloud/compiler"]).toBeUndefined();
  expect(manifest.scripts.compile).toBeUndefined();
  expect(await readFile(join(root, "src/client.ts"), "utf8")).toContain('from "@supabase/supabase-js"');
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("minimal");
  await expect(readFile(join(root, "src/app.module.ts"), "utf8")).rejects.toThrow();
});

test("client template test runs against the workspace supabase-js package", async () => {
  const root = await fixture("client");
  const repo = resolve(import.meta.dir, "../../../../..");
  await symlink(join(repo, "packages/cli/node_modules"), join(root, "node_modules"), "dir");
  const child = Bun.spawn([process.execPath, "--no-env-file", "test", "tests/client.test.ts"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, errors: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, errors: "" });
});

test("default minimal health feature compiles and executes with the new core entry", async () => {
  const { compileProject } = await import("@supacloud/compiler");
  const root = await fixture();
  const host = await readFile(join(root, "src/application.ts"), "utf8");
  expect(host).toContain("export function readCreatedApplication");
  expect(host).toContain("isApplicationHost");
  expect(host).toContain("signal?: AbortSignal");
  expect(host).toContain("handle: (request: Request) => Promise<Response>");
  expect(host).toContain("onExecution?: ExecutionObserver");
  expect(host).toContain("deps: Record<string, unknown>");
  expect(host).not.toContain("Reflect.apply");
  expect(host).not.toContain('ApplicationOptions["deps"]');
  // Feature compile must not depend on unresolved package `.d.ts` widening from the host file.
  await rm(join(root, "src/application.ts"));
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
}, 60_000);

test("the app template alias initializes the same compiler stack as minimal", async () => {
  const root = await fixture("app");
  expect(await readFile(join(root, "src/app.module.ts"), "utf8")).toContain("HealthModule");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(manifest.devDependencies["@supacloud/compiler"]).toBeDefined();
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
