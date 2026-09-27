import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeAppProject } from "../packages/cli/src/shared/tools/app-starter";
import { buildDeliveryProject, compileProject, compileOptionsFromConfig, loadSupacloudConfig } from "../packages/compiler/src";
import { readDeliveryExecutableArchive } from "../packages/delivery/src";

// Build the shipped business starter; the detached output contains no credentials.
assert.equal(Bun.version, "1.4.2");
const repo = resolve(import.meta.dir, "..");
const output = await mkdtemp(join(tmpdir(), "supacloud-platform-business-"));
const project = join(output, "project");
try {
  await initializeAppProject({ root: project, name: "platform-business-acceptance" });
  const dependencies = new Map<string, string>();
  for (const name of ["app", "elysia", "contracts", "commands", "db", "compiler", "delivery", "js"]) {
    const directory = join(repo, "packages", name === "js" ? "supacloud-js" : name);
    assert.ok(await Bun.file(join(directory, "dist/index.js")).exists(), `${name} must be built first`);
    dependencies.set(`@supacloud/${name}`, directory);
  }
  for (const name of ["elysia", "jose", "typebox", "bun-types", "@types/bun", "typescript"]) {
    dependencies.set(name, join(repo, "packages/elysia/node_modules", name));
  }
  dependencies.set("@supabase/supabase-js", join(repo, "packages/management-api/node_modules/@supabase/supabase-js"));
  for (const [name, path] of dependencies) {
    const destination = join(project, "node_modules", name);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await symlink(path, destination);
  }
  const config = await loadSupacloudConfig(project);
  const options = compileOptionsFromConfig(config, project);
  const settings = {
    version: 1,
    runtime: { processIsolation: true, durableQueue: true, capabilities: [] },
    build: {
      migrations: config.delivery?.build?.migrations,
      httpApplications: [{ target: "api", source: "delivery-host.ts" }],
      workerApplications: [{ target: "jobs", source: "delivery-worker.ts" }],
    },
  };
  const checked = await compileProject(options);
  assert.ok(checked.diagnostics.filter(item => item.severity === "error").length === 0,
    JSON.stringify(checked.diagnostics));
  const built = await buildDeliveryProject(options, settings);
  assert.ok(built.ok, JSON.stringify(built.diagnostics));
  const repeated = await buildDeliveryProject(options, settings);
  assert.ok(repeated.ok, JSON.stringify(repeated.diagnostics));
  assert.deepEqual(repeated.written, []);
  await cp(join(options.outDir, "delivery"), join(output, "archive"), { recursive: true });
  const manifestPath = join(output, "archive/delivery.manifest.json");
  const archive = await readDeliveryExecutableArchive(manifestPath);
  assert.deepEqual(archive.objects.map(({ object }) => [object.name, object.entryKind]).sort(), [
    ["api", "bun-http-application"], ["jobs", "bun-worker-application"],
  ]);
  const hashes: Record<string, string> = {};
  for (const { object } of archive.objects) {
    const contents = await readFile(join(output, "archive/objects", object.objectId, "bundle/index.js"));
    hashes[object.name] = createHash("sha256").update(contents).digest("hex");
  }
  for (const [fixture, name] of [
    ["starter-delivery-archive.fixture", "delivery-archive.ts"],
    ["starter-delivery-compatibility.fixture", "delivery-compatibility.ts"],
  ]) {
    await copyFile(join(repo, "scripts/fixtures", fixture!), join(project, "tests", name!));
  }
  const upgrade: {
    buildReferenceUpgradeArchive(directory: string, signal: AbortSignal): Promise<unknown>;
  } = await import(join(project, "tests/delivery-compatibility.ts"));
  await upgrade.buildReferenceUpgradeArchive(join(output, "upgraded"), new AbortController().signal);
  const upgraded = await readDeliveryExecutableArchive(join(output, "upgraded/delivery.manifest.json"));
  for (const { object } of upgraded.objects) {
    assert.notEqual(object.objectId, archive.objects.find(item => item.object.name === object.name)?.object.objectId);
  }
  await writeFile(join(output, "business-build.json"), JSON.stringify({
    schema: "supacloud.platform-business-build.v1",
    source: "shipped-review-starter",
    dependencies: "workspace-builds-not-published-packages",
    bun: Bun.version,
    manifestSha256: createHash("sha256").update(await readFile(manifestPath)).digest("hex"),
    objects: archive.objects.map(({ object }) => ({ name: object.name, objectId: object.objectId })),
    upgraded: upgraded.objects.map(({ object }) => ({ name: object.name, objectId: object.objectId })),
    bundles: hashes,
  }, null, 2));
  console.log(output);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
} finally {
  await rm(project, { recursive: true, force: true });
}
