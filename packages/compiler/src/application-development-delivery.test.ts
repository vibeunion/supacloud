import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeliveryProject } from "./delivery-build";
import { readApplicationDevelopmentContext } from "./delivery-context";
import type { DeliveryBuildManifest } from "./delivery-build-schema";
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
  await writeFile(path, original.replace('"current-graph"', '"tampered-graph"'));
  await expect(readApplicationDevelopmentContext(manifestPath(), object.name))
    .rejects.toMatchObject({ code: "DELIVERY_CONTEXT_INTEGRITY_FAILED" });
  await writeFile(path, original);
});

test("an unknown delivery target fails without echoing paths", async () => {
  await expect(readApplicationDevelopmentContext(manifestPath(), "not-a-target"))
    .rejects.toMatchObject({ code: "DELIVERY_CONTEXT_IDENTITY_MISMATCH" });
});