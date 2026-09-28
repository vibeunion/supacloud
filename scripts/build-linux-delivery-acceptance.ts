import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDeliveryProject } from "../packages/compiler/dist/index.js";
import { GOOD_PROJECT_FILES } from "../packages/compiler/src/fixtures/good-project";
import { writeFixtureProject } from "../packages/compiler/src/fixtures/helpers";

// Transfer only this detached directory to the dedicated Linux test machine.
assert.equal(Bun.version, "1.4.2");
const output = await mkdtemp(join(tmpdir(), "supacloud-linux-delivery-"));
const project = join(output, "project");
try {
  await mkdir(join(project, "node_modules"), { recursive: true });
  for (const name of ["@types", "bun-types"]) {
    await symlink(resolve(import.meta.dir, "../packages/compiler/node_modules", name),
      join(project, "node_modules", name));
  }
  await writeFixtureProject(project, {
    ...GOOD_PROJECT_FILES,
    "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"]!.replace(
      '"strict": true', '"strict": true, "skipLibCheck": true, "types": ["bun"]'),
    "src/runtime.ts": GOOD_PROJECT_FILES["src/runtime.ts"]!.replaceAll("() => {}", "(..._args: unknown[]) => {}"),
    "src/report.ts": `import { Job, Module } from "./runtime";
      @Job({name: "report.render", mode: "task", idempotency: "required"})
      export class RenderReport { async run(input: {value: string}): Promise<{value: string}> { return input; } }
      @Module({name: "report", jobs: [RenderReport]}) export class ReportModule {}`,
    "src/host.ts": `export function createDeliveryApplication(_modules: unknown[]) {
      let ready = true;
      return {fetch: (request: Request) => {
        if (new URL(request.url).pathname === "/not-ready") ready = false;
        return new Response("linux-delivery-ready");
      }, ready: () => ready, close() {}};
    }`,
    "src/worker.ts": `export function createDeliveryWorker(_modules: unknown[]) {
      return {start() {}, close() {}};
    }`,
  });
  const options = {
    rootDir: join(project, "src"), outDir: join(project, "generated"), strict: false,
    generateClient: false, generatePermissions: false,
  };
  const built = await buildDeliveryProject(options, {
    version: 1, runtime: { processIsolation: true, durableQueue: true, capabilities: [] },
    build: {
      httpApplications: [{ target: "api", source: "host.ts" }],
      workerApplications: [{ target: "jobs", source: "worker.ts" }],
    },
  });
  if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
  await cp(join(options.outDir, "delivery"), join(output, "archive"), { recursive: true });
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "linux-delivery-acceptance.ts")],
    outdir: output, target: "bun", packages: "bundle",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Linux acceptance bundling failed");
  await cp(resolve(import.meta.dir, "lib/systemd_unit_broker.sh"), join(output, "systemd-unit"));
  await cp(resolve(import.meta.dir, "../infrastructure/systemd/supacloud-systemd-unit@.service"),
    join(output, "supacloud-systemd-unit@.service"));
  const compilerRoot = resolve(import.meta.dir, "../packages/compiler/dist");
  const compiler: Record<string, string> = {};
  for (const entry of (await readdir(compilerRoot, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).sort((a, b) =>
      join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
    const path = join(entry.parentPath, entry.name);
    compiler[path.slice(compilerRoot.length + 1)] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  const files: Record<string, string> = {};
  for (const name of ["linux-delivery-acceptance.js", "systemd-unit", "supacloud-systemd-unit@.service",
    "archive/delivery.manifest.json"]) {
    files[name] = createHash("sha256").update(await readFile(join(output, name))).digest("hex");
  }
  await writeFile(join(output, "acceptance-build.json"), JSON.stringify({
    schema: "supacloud.linux-delivery-build.v1", bun: Bun.version,
    builtAt: new Date().toISOString(), compiler, files,
  }, null, 2));
  console.log(output);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
} finally {
  await rm(project, { recursive: true, force: true });
}
