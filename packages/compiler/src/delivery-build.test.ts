import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeliveryProject } from "./delivery-build";
import { parseDeliveryBuildManifest, parseDeliveryBuildResult } from "./delivery-build-schema";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { requireValue, writeFixtureProject } from "./fixtures/helpers";
import { bundleDeliveryTarget } from "./delivery-bundle";
import { reserveOutput } from "./delivery-files";
import { parseDeliveryOptions } from "./delivery-schema";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "delivery-build-"));
  await writeFixtureProject(root, {
    ...GOOD_PROJECT_FILES,
    "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"].replace('"strict": true', '"strict": true, "rootDir": "src"'),
    "src/runtime.ts": GOOD_PROJECT_FILES["src/runtime.ts"].replaceAll("() => {}", "(..._args: unknown[]) => {}"),
  });
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const settings = { version: 1 };
const build = () => buildDeliveryProject({
  rootDir: root, outDir: join(root, "generated"), strict: false,
  generateClient: false, generatePermissions: false,
}, settings);

test("builds a movable factory and reuses immutable artifacts; failures preserve the pointer", async () => {
  const first = await build();
  if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
  expect(parseDeliveryBuildResult(JSON.parse(JSON.stringify(first)))).toEqual(first);
  expect(first.manifest.deploymentReady).toBe(false);
  expect(() => parseDeliveryBuildManifest({...first.manifest, routes: []})).toThrow();
  expect(() => parseDeliveryBuildManifest({...first.manifest, objects: []})).toThrow();
  expect(first.manifest.routes).toEqual([{ method: "POST", path: "/cases/:caseId/accept", target: "api" }]);
  const object = requireValue(first.manifest.objects[0]);
  const bundle = join(root, "generated/delivery/objects", object.objectId, "bundle");
  const mtime = (await stat(join(bundle, "index.js"))).mtimeMs;
  const detached = await mkdtemp(join(tmpdir(), "detached-delivery-"));
  try {
    await cp(bundle, detached, { recursive: true });
    const loaded: unknown = await import(join(detached, "index.js"));
    expect(typeof loaded).toBe("object");
    if (loaded === null || typeof loaded !== "object" || !("createCompiledModules" in loaded)
      || typeof loaded.createCompiledModules !== "function") throw new Error("Missing factory export");
    expect(Array.isArray(loaded.createCompiledModules())).toBe(true);
  } finally { await rm(detached, { recursive: true, force: true }); }
  const second = await build();
  if (!second.ok) throw new Error(JSON.stringify(second.diagnostics));
  expect(second.written).toEqual([]);
  expect(second.bundledTargets).toEqual(["api"]);
  expect(second.unchangedTargets).toEqual(["api"]);
  expect((await stat(join(bundle, "index.js"))).mtimeMs).toBe(mtime);
  const pointer = join(root, "generated/delivery/delivery.manifest.json");
  const before = await readFile(pointer, "utf8");
  await writeFixtureProject(root, { "src/features/audit/logger.ts": "export function createLogger(config: {level: string}): string { return 42; }" });
  const failed = await build();
  expect(failed.ok).toBe(false);
  expect(await readFile(pointer, "utf8")).toBe(before);
  await writeFixtureProject(root, { "src/features/audit/logger.ts": GOOD_PROJECT_FILES["src/features/audit/logger.ts"].replace("return { level: config.level };", 'return { level: config.level + "-changed" };') });
  const changed = await build();
  if (!changed.ok) throw new Error(JSON.stringify(changed.diagnostics));
  expect(changed.changedTargets).toEqual(["api"]);
  expect(requireValue(changed.manifest.objects[0]).inputDigest).not.toBe(object.inputDigest);
  expect((await stat(join(bundle, "index.js"))).mtimeMs).toBe(mtime);
}, 120_000);

test("isolates route owners, includes assets, and invalidates only dependent targets", async () => {
  const project = await mkdtemp(join(tmpdir(), "delivery-targets-"));
  try {
    await writeFixtureProject(project, {
      ...GOOD_PROJECT_FILES,
      "src/runtime.ts": GOOD_PROJECT_FILES["src/runtime.ts"].replaceAll("() => {}", "(..._args: unknown[]) => {}"),
      "src/features/health/health.module.ts": `import { Module, Controller, Get } from "../../runtime";
        @Controller("/health") export class HealthController {
          @Get("/", { response: {type: "string"} }) status(): string { return "ok"; }
        }
        @Module({name: "health", controllers: [HealthController]}) export class HealthModule {}`,
      "src/template.txt": "first",
    });
    const options = { rootDir: project, outDir: join(project, "generated"), strict: false, generateClient: false, generatePermissions: false };
    const config = { version: 1, targets: [{ name: "cases", kind: "api", modules: ["case"] }],
      build: { assets: [{ target: "cases", source: "src/template.txt", path: "template.txt" }] } };
    const first = await buildDeliveryProject(options, config);
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
    expect(first.manifest.routes).toEqual([
      { method: "GET", path: "/health", target: "api" },
      { method: "POST", path: "/cases/:caseId/accept", target: "cases" },
    ]);
    const cases = requireValue(first.manifest.objects.find((item) => item.name === "cases"));
    const api = requireValue(first.manifest.objects.find((item) => item.name === "api"));
    const objects = join(project, "generated/delivery/objects");
    expect(await readFile(join(objects, cases.objectId, "bundle/assets/template.txt"), "utf8")).toBe("first");
    expect(await readFile(join(objects, api.objectId, "generated/application.ts"), "utf8")).not.toContain("CaseController");
    expect(await readFile(join(objects, cases.objectId, "generated/application.ts"), "utf8")).not.toContain("HealthController");
    expect(await readFile(join(objects, cases.objectId, "generated/application.ts"), "utf8")).toContain("AuditService");
    await writeFixtureProject(project, { "src/template.txt": "second" });
    const changed = await buildDeliveryProject(options, config);
    if (!changed.ok) throw new Error(JSON.stringify(changed.diagnostics));
    expect(changed.changedTargets).toEqual(["cases"]);
    expect(changed.unchangedTargets).toEqual(["api"]);
    const pointer = join(project, "generated/delivery/delivery.manifest.json");
    const before = await readFile(pointer, "utf8");
    await writeFixtureProject(project, { "src/features/audit/logger.ts": GOOD_PROJECT_FILES["src/features/audit/logger.ts"].replace("config.level", 'config.level + "changed"') });
    const dependency = await buildDeliveryProject(options, config);
    if (!dependency.ok) throw new Error(JSON.stringify(dependency.diagnostics));
    expect(dependency.changedTargets).toEqual(["cases"]);
    expect(dependency.unchangedTargets).toEqual(["api"]);
    expect(await readFile(pointer, "utf8")).not.toBe(before);
    const active = await readFile(pointer, "utf8");
    const badAsset = await buildDeliveryProject(options, { ...config, build: { assets: [{target: "cases", source: "missing.txt", path: "template.txt"}] } });
    expect(badAsset.ok).toBe(false);
    expect(await readFile(pointer, "utf8")).toBe(active);
    const removed = await buildDeliveryProject(options, {version: 1});
    if (!removed.ok) throw new Error(JSON.stringify(removed.diagnostics));
    expect(removed.removedTargets).toEqual(["cases"]);
    expect((await stat(join(objects, cases.objectId))).isDirectory()).toBe(true);
    const current = requireValue(removed.manifest.objects[0]);
    await writeFixtureProject(project, { [`generated/delivery/objects/${current.objectId}/bundle/index.js`]: "tampered" });
    const corrupted = await buildDeliveryProject(options, {version: 1});
    expect(corrupted.ok).toBe(false);
    expect(await readFile(join(objects, current.objectId, "bundle/index.js"), "utf8")).toBe("tampered");
  } finally { await rm(project, { recursive: true, force: true }); }
}, 120_000);

test("rejects unsafe paths, unowned output, links, and concurrent writers", async () => {
  for (const path of ["../escape", "/absolute", ".hidden/file", "a/../b"]) {
    expect(() => parseDeliveryOptions({version: 1, build: {assets: [{target: "api", source: path, path: "safe"}]}})).toThrow();
  }
  const project = await mkdtemp(join(tmpdir(), "delivery-ownership-"));
  try {
    await writeFixtureProject(project, { "unowned/keep.txt": "keep" });
    await expect(reserveOutput(project, join(project, "unowned"))).rejects.toThrow();
    expect(await readFile(join(project, "unowned/keep.txt"), "utf8")).toBe("keep");
    await symlink(join(project, "unowned"), join(project, "linked"));
    await expect(reserveOutput(project, join(project, "linked/output"))).rejects.toThrow();
    const first = await reserveOutput(project, join(project, "owned"));
    try { await expect(reserveOutput(project, join(project, "owned"))).rejects.toThrow(); }
    finally { await first.release(); }
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("does not inline environment values and rejects computed imports", async () => {
  const project = await mkdtemp(join(tmpdir(), "delivery-bundle-"));
  const variable = "SUPACLOUD_DELIVERY_TEST_VALUE";
  const previous = process.env[variable];
  process.env[variable] = "DO_NOT_EMBED_DELIVERY_SECRET";
  try {
    await writeFixtureProject(project, { "entry.ts": `import { basename } from "node:path"; export const value = basename(process.env.${variable} ?? "");` });
    const result = await bundleDeliveryTarget("api", 'export { value } from "./entry.ts";', project, project, {version: 1});
    expect(new TextDecoder().decode(result.files.get("bundle/index.js"))).not.toContain("DO_NOT_EMBED_DELIVERY_SECRET");
    expect(result.runtimeImports.map((path) => path.replace(/^node:/, ""))).toContain("path");
    const script = `import { bundleDeliveryTarget } from ${JSON.stringify(join(import.meta.dir, "delivery-bundle.ts"))};
      await bundleDeliveryTarget("api", 'export { value } from "./entry.ts";', ${JSON.stringify(project)}, ${JSON.stringify(project)}, {version: 1});`;
    const child = Bun.spawn([Bun.argv[0] ?? "bun", "-e", script], {cwd: "/", stdout: "pipe", stderr: "pipe"});
    const [, errors, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(errors).toBe("");
    expect(status).toBe(0);
    await writeFixtureProject(project, { "entry.ts": 'const name = "./runtime"; export const load = () => import(name);' });
    await expect(bundleDeliveryTarget("api", 'export { load } from "./entry.ts";', project, project, {version: 1})).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
    await rm(project, { recursive: true, force: true });
  }
});

test("keeps shared-module routes private to their owner and preserves Job factories", async () => {
  const project = await mkdtemp(join(tmpdir(), "delivery-jobs-"));
  try {
    await writeFixtureProject(project, {
      ...GOOD_PROJECT_FILES,
      "src/runtime.ts": GOOD_PROJECT_FILES["src/runtime.ts"].replaceAll("() => {}", "(..._args: unknown[]) => {}"),
      "src/features/audit/audit.module.ts": GOOD_PROJECT_FILES["src/features/audit/audit.module.ts"]
        .replace('import { Module }', 'import { Module, Controller, Get }')
        .replace("@Module({", '@Controller("/audit") export class AuditController { @Get("/", {response: {type: "string"}}) status(): string {return "ok";} }\n@Module({controllers: [AuditController],'),
      "src/jobs.module.ts": `import { Job, Module } from "./runtime";
        import { AuditModule } from "./features/audit/audit.module";
        @Job({name: "case.rebuild"}) export class RebuildJob {run(input: string): string {return input;}}
        @Module({name: "worker", imports: [AuditModule], jobs: [RebuildJob]}) export class WorkerModule {}`,
    });
    const result = await buildDeliveryProject({
      rootDir: project, outDir: join(project, "generated"), strict: false,
      generateClient: false, generatePermissions: false,
    }, {version: 1, targets: [{name: "cases", kind: "api", modules: ["case"]}],
      runtime: {processIsolation: true, durableQueue: true, capabilities: []}});
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.manifest.jobs).toEqual([{name: "case.rebuild", target: "jobs"}]);
    for (const object of result.manifest.objects) {
      const loaded: unknown = await import(join(project, "generated/delivery/objects", object.objectId, object.entrypoint));
      if (loaded === null || typeof loaded !== "object" || !("createCompiledModules" in loaded)
        || typeof loaded.createCompiledModules !== "function") throw new Error("Missing factory export");
      const modules: unknown = loaded.createCompiledModules();
      const text = JSON.stringify(modules);
      expect(text.includes('"method":"GET"')).toBe(object.name === "api");
      expect(text.includes('"method":"POST"')).toBe(object.name === "cases");
      expect(text.includes('"name":"case.rebuild"')).toBe(object.name === "jobs");
      if (object.name === "cases") expect(text).toContain('"permission":"case.accept"');
      if (object.name === "jobs") {
        expect(await readFile(join(project, "generated/delivery/objects", object.objectId, "generated/application.ts"), "utf8")).toContain("createJobScope");
      }
    }
  } finally { await rm(project, {recursive: true, force: true}); }
}, 60_000);

test("CLI exposes structured builds and rejects write-like preview flags", async () => {
  const project = await mkdtemp(join(tmpdir(), "delivery-cli-build-"));
  try {
    await writeFixtureProject(project, {
      ...GOOD_PROJECT_FILES,
      "src/runtime.ts": GOOD_PROJECT_FILES["src/runtime.ts"].replaceAll("() => {}", "(..._args: unknown[]) => {}"),
      "supacloud.config.ts": `export default {root: ".", outDir: "generated", strict: false,
        generateClient: false, generatePermissions: false};`,
      "invalid.json": '{"version":1,"secret":"DO_NOT_ECHO_THIS"}',
    });
    async function run(args: string[]) {
      const process = Bun.spawn([Bun.argv[0] ?? "bun", join(import.meta.dir, "cli.ts"), "build-delivery", ...args, "--json"], {
        cwd: project, stdout: "pipe", stderr: "pipe",
      });
      const stdout = await new Response(process.stdout).text();
      const stderr = await new Response(process.stderr).text();
      const code = await process.exited;
      expect(stdout + stderr).not.toContain("DO_NOT_ECHO_THIS");
      return {code, result: parseDeliveryBuildResult(JSON.parse(stdout))};
    }
    const first = await run([]);
    expect(first.code).toBe(0);
    expect(first.result.ok).toBe(true);
    const pointer = join(project, "generated/delivery/delivery.manifest.json");
    const before = await readFile(pointer, "utf8");
    for (const args of [["--dry-run"], ["--write"], ["--delivery", "invalid.json"]]) {
      const rejected = await run(args);
      expect(rejected.code).toBe(1);
      expect(rejected.result.ok).toBe(false);
      expect(await readFile(pointer, "utf8")).toBe(before);
    }
  } finally { await rm(project, {recursive: true, force: true}); }
}, 60_000);
