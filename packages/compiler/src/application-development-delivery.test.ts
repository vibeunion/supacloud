import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeliveryProject } from "./delivery-build";
import { readApplicationDevelopmentContext } from "./delivery-context";
import { deliveryObjectDigest, type DeliveryBuildManifest } from "./delivery-build-schema";
import { artifactInventory } from "./delivery-files";
import { APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES, APPLICATION_DEVELOPMENT_LIMITS, parseApplicationDevelopmentContext, type ApplicationDevelopmentContext } from "./application-development";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { requireValue, writeFixtureProject } from "./fixtures/helpers";

let root: string;
let manifest: DeliveryBuildManifest;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "application-development-delivery-"));
  await writeFixtureProject(root, {
    ...GOOD_PROJECT_FILES,
    "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"].replace('"strict": true', '"strict": true, "rootDir": "src"'),
    "src/runtime.ts": GOOD_PROJECT_FILES["src/runtime.ts"].replaceAll("() => {}", "(..._args: unknown[]) => {}"),
  });
  const built = await buildDeliveryProject({
    rootDir: root, outDir: join(root, "generated"), strict: false,
    generateClient: false, generatePermissions: false,
  }, { version: 1 });
  if (!built.ok || !built.manifest) throw new Error(JSON.stringify(built.diagnostics));
  manifest = built.manifest;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const manifestPath = () => join(root, "generated/delivery/delivery.manifest.json");

test("delivered object carries the application development contract", async () => {
  const object = requireValue(manifest.objects[0]);
  const raw: unknown = JSON.parse(await readFile(
    join(root, "generated/delivery/objects", object.objectId, "bundle/application-development.json"), "utf8"));
  expect(raw).toMatchObject({ schema: "supacloud.application-development.v1", source: "current-graph", deploymentVerified: false });

  const delivered = await readApplicationDevelopmentContext(manifestPath(), manifest.objects[0]!.name);
  expect(delivered.correlation).toBe("verified-build-snapshot");
  expect(delivered.delivery).toEqual({ target: object.name, objectId: object.objectId, artifactVerified: true });
  expect(delivered.context.modules.map((module) => module.name)).toContain("case");
  expect(delivered.context.routes.some((route) => route.path.includes("accept"))).toBe(true);
  expect(delivered.context.diagnostics).toEqual([]);
});

test("a tampered development artifact fails closed without touching the source", async () => {
  const object = requireValue(manifest.objects[0]);
  const path = join(root, "generated/delivery/objects", object.objectId, "bundle/application-development.json");
  const original = await readFile(path, "utf8");
  try {
    await writeFile(path, original.replace('"current-graph"', '"tampered-graph"'));
    await expect(readApplicationDevelopmentContext(manifestPath(), object.name))
      .rejects.toMatchObject({ code: "DELIVERY_CONTEXT_INTEGRITY_FAILED" });
  } finally { await writeFile(path, original); }
});

test("an unknown delivery target fails without echoing paths", async () => {
  await expect(readApplicationDevelopmentContext(manifestPath(), "not-a-target"))
    .rejects.toMatchObject({ code: "DELIVERY_CONTEXT_IDENTITY_MISMATCH" });
});

test("self-consistent hashes cannot bypass structure, redaction, target or byte validation", async () => {
  const directory = join(root, "generated/delivery");
  const object = requireValue(manifest.objects[0]);
  const originalRoot = join(directory, "objects", object.objectId);
  const context = parseApplicationDevelopmentContext(JSON.parse(await readFile(join(originalRoot, "bundle/application-development.json"), "utf8")));
  const mutations: ((value: ApplicationDevelopmentContext) => void)[] = [
    value => { Object.assign(value, { modules: [null] }); },
    value => { Object.assign(value, { secret: "DO_NOT_ECHO" }); },
    value => { Object.assign(value.modules[0]!, { expression: "DO_NOT_ECHO" }); },
    value => { value.diagnostics = [{ code: "test", severity: "warn" }]; Object.assign(value.diagnostics[0]!, { message: "DO_NOT_ECHO" }); },
    value => { value.modules[0]!.file = "../DO_NOT_ECHO"; },
    value => { value.modules[0]!.name = "other-target-module"; },
    value => { value.routes[0]!.path = "/another-target"; },
    value => { value.executionPlans[0]!.stages = ["DO_NOT_ECHO"]; },
  ];
  const documents = mutations.map(mutate => {
    const value = structuredClone(context); mutate(value); return Buffer.from(JSON.stringify(value));
  });
  // Padding exceeds the raw archive budget, while invalid UTF-8 would be silently
  // replaced by Buffer.toString() and could otherwise form a schema-valid label.
  documents.push(Buffer.from(JSON.stringify(context) + " ".repeat(APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES)));
  const utf8 = structuredClone(context);
  utf8.modules[0]!.tags = ["UTF8_MARKER"];
  const [prefix, suffix] = JSON.stringify(utf8).split("UTF8_MARKER");
  documents.push(Buffer.concat([Buffer.from(prefix!), Buffer.from([0xff]), Buffer.from(suffix!)]));
  for (const [index, bytes] of documents.entries()) {
    const candidate = join(directory, `candidate-${index}`);
    await cp(originalRoot, candidate, { recursive: true });
    await writeFile(join(candidate, "bundle/application-development.json"), bytes);
    const modified = { ...object, files: await artifactInventory(candidate) };
    modified.objectId = deliveryObjectDigest(modified);
    await rename(candidate, join(directory, "objects", modified.objectId));
    const pointer = join(directory, `candidate-${index}.manifest.json`);
    await writeFile(pointer, JSON.stringify({ ...manifest, objects: manifest.objects.map(item => item.name === object.name ? modified : item) }));
    await expect(readApplicationDevelopmentContext(pointer, object.name))
      .rejects.toMatchObject({ code: "DELIVERY_CONTEXT_INTEGRITY_FAILED", message: "DELIVERY_CONTEXT_INTEGRITY_FAILED" });
  }
  expect((await readApplicationDevelopmentContext(manifestPath(), object.name)).delivery.objectId).toBe(object.objectId);
});

test("archive budget round trips above interactive size and rejects oversized rebuilds without replacing the pointer", async () => {
  const project = await mkdtemp(join(tmpdir(), "development-budget-build-"));
  try {
    const modulePath = "src/features/audit/audit.module.ts";
    const tagged = (count: number) => GOOD_PROJECT_FILES[modulePath]!.replace("@Module({", `@Module({ tags: ${JSON.stringify(
      Array.from({ length: count }, (_, index) => `tag-${index}-${"界".repeat(200)}`),
    )},`);
    await writeFixtureProject(project, {
      ...GOOD_PROJECT_FILES,
      "src/runtime.ts": GOOD_PROJECT_FILES["src/runtime.ts"]!.replaceAll("() => {}", "(..._args: unknown[]) => {}"),
      [modulePath]: tagged(200),
    });
    const options = { rootDir: join(project, "src"), outDir: join(project, "generated"), strict: false,
      generateClient: false, generatePermissions: false };
    const first = await buildDeliveryProject(options, { version: 1 });
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
    const target = requireValue(first.manifest.objects[0]);
    const snapshot = requireValue(target.files.find(file => file.path === "bundle/application-development.json"));
    expect(snapshot.bytes).toBeGreaterThan(APPLICATION_DEVELOPMENT_LIMITS.outputBytes);
    expect(snapshot.bytes).toBeLessThanOrEqual(APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES);
    const pointer = join(project, "generated/delivery/delivery.manifest.json");
    const selected = await readFile(pointer, "utf8");
    expect((await readApplicationDevelopmentContext(pointer, target.name)).context.modules.find(module => module.name === "audit")?.tags).toHaveLength(200);
    await writeFixtureProject(project, { [modulePath]: tagged(1000) });
    const rejected = await buildDeliveryProject(options, { version: 1 });
    expect(rejected.ok).toBe(false);
    expect(rejected.written).toEqual([]);
    expect(await readFile(pointer, "utf8")).toBe(selected);
    expect((await readApplicationDevelopmentContext(pointer, target.name)).delivery.objectId).toBe(target.objectId);
    expect((await readdir(join(project, "generated/delivery/objects"))).some(name => name.startsWith(".build-"))).toBe(false);
  } finally { await rm(project, { recursive: true, force: true }); }
}, 120_000);
