import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryObjectDigest, type DeliveryBuildManifest, type DeliveryObject } from "@supacloud/delivery/build-schema";
import { canonical, digest } from "@supacloud/delivery/files";
import type { DeliveryTarget } from "@supacloud/delivery/schema";
import { ApplicationReleaseStorage } from "../../src/services/application-release-storage";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "application-intake-unit-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(malformedMigration = false) {
  const manifestPath = join(root, "upload/delivery.manifest.json");
  const targets: DeliveryTarget[] = ["api", "jobs"].map(name => ({
    name, kind: name === "jobs" ? "jobs" : "api", isolation: "process",
    roots: [name], modules: [{ name, reason: "owner", importedBy: [] }],
    routes: [], jobs: [], externalTokens: [],
    requirements: { processIsolation: true, durableQueue: name === "jobs", capabilities: [] },
    runtimeStatus: "declared-compatible",
  }));
  const objects: DeliveryObject[] = [];
  for (const target of targets) {
    const entryKind = target.kind === "jobs" ? "bun-worker-application" : "bun-http-application";
    const contents = new Map([
      ["bundle/index.js", "throw new Error('intake must never execute code');\n"],
      ["bundle/target.json", canonical({ target, entryKind, deploymentReady: false })],
      ...(malformedMigration ? [["bundle/migrations.json", "{}"] as [string, string]] : []),
    ]);
    const object: Omit<DeliveryObject, "objectId"> = {
      name: target.name, inputDigest: digest("fixture"), entrypoint: "bundle/index.js",
      entryKind, runtimeImports: [],
      files: [...contents].map(([path, content]) => ({
        path, sha256: digest(content), bytes: Buffer.byteLength(content),
      })).sort((a, b) => a.path.localeCompare(b.path)),
    };
    const objectId = deliveryObjectDigest(object);
    objects.push({ ...object, objectId });
    const bundle = join(root, "upload/objects", objectId, "bundle");
    await mkdir(bundle, { recursive: true });
    for (const [path, content] of contents) {
      await writeFile(join(root, "upload/objects", objectId, path), content);
    }
  }
  const manifest: DeliveryBuildManifest = {
    schemaVersion: 1, producer: "@supacloud/compiler/delivery-build-v1", deploymentReady: false,
    plan: {
      schemaVersion: 1, policyVersion: "module-workload-v1", digestScope: "topology-only",
      topologyDigest: digest("topology"), deploymentReady: false, targets,
    },
    objects, routes: [], jobs: [],
  };
  await writeFile(manifestPath, canonical(manifest));
  return {
    projectRef: "example", applicationId: "reviews", manifestPath,
    expectedObjects: Object.fromEntries(objects.map(object => [object.name, object.objectId])),
  };
}

test("intake publishes all targets without executing them and reuses concurrent imports", async () => {
  const input = await fixture();
  const storage = new ApplicationReleaseStorage(join(root, "store"));
  const [first, second] = await Promise.all([storage.importRelease(input), storage.importRelease(input)]);
  expect(first).toEqual(second);
  expect(first!.targets.map(target => target.kind)).toEqual(["http", "worker"]);
  expect(await storage.readRelease(input.projectRef, input.applicationId, first!.release_id)).toEqual(first!);
  expect(await readdir(join(root, "store/example/reviews/releases"))).toEqual([first!.release_id]);
});

test("reads do not create storage directories and project/application paths are checked", async () => {
  const storage = new ApplicationReleaseStorage(join(root, "store"));
  await expect(storage.readRelease("example", "reviews", "0".repeat(64))).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
  const input = await fixture();
  await expect(storage.importRelease({ ...input, applicationId: "../elsewhere" })).rejects.toThrow();
  await expect(storage.importRelease({ ...input, expectedObjects: {} }))
    .rejects.toThrow("APPLICATION_RELEASE_OBJECT_MISMATCH");
});

test("first import creates and persists a nested storage root", async () => {
  const input = await fixture();
  const baseDir = join(root, "new/nested/store");
  const record = await new ApplicationReleaseStorage(baseDir).importRelease(input);
  const reopened = new ApplicationReleaseStorage(baseDir);
  expect(await reopened.readRelease(input.projectRef, input.applicationId, record.release_id)).toEqual(record);
});

test("a hash-valid but malformed migration inventory is not published", async () => {
  const input = await fixture(true);
  const storage = new ApplicationReleaseStorage(join(root, "store"));
  await expect(storage.importRelease(input)).rejects.toThrow("Invalid delivery migration archive");
  expect(await readdir(join(root, "store/example/reviews/releases"))).toEqual([]);
});

test("repeat import detects stored corruption without replacing the existing release", async () => {
  const input = await fixture();
  const storage = new ApplicationReleaseStorage(join(root, "store"));
  const record = await storage.importRelease(input);
  const entry = join(root, "store/example/reviews/releases", record.release_id,
    "objects", input.expectedObjects.api!, "bundle/index.js");
  await writeFile(entry, "corrupt");
  await expect(storage.importRelease(input)).rejects.toThrow();
  expect(await readFile(entry, "utf8")).toBe("corrupt");
});
