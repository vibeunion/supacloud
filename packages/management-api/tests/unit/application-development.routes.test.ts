import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryObjectDigest, type DeliveryBuildManifest, type DeliveryObject } from "@supacloud/delivery/build-schema";
import { canonical, digest } from "@supacloud/delivery/files";
import type { DeliveryTarget } from "@supacloud/delivery/schema";
import { createApplicationRoutes } from "../../src/routes/applications";
import { ApplicationReleaseStorage } from "../../src/services/application-release-storage";
import { APPLICATION_DEVELOPMENT_ARTIFACT } from "../../src/services/application-development.service";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "application-development-route-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const context = {
  schema: "supacloud.application-development.v1", source: "current-graph", deploymentVerified: false,
  modules: [], routes: [], commands: [], jobs: [], resources: [], resourceUses: [],
  executionPlans: [], diagnostics: [], omitted: {}, limits: { outputBytes: 65536 },
};

async function fixture(withDevelopment = true) {
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
    const contents = new Map<string, string>([
      ["bundle/index.js", "throw new Error('intake must never execute code');\n"],
      ["bundle/target.json", canonical({ target, entryKind, deploymentReady: false })],
      ...(withDevelopment && target.name === "api"
        ? [[APPLICATION_DEVELOPMENT_ARTIFACT, canonical(context)] as [string, string]] : []),
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
    await mkdir(join(root, "upload/objects", objectId, "bundle"), { recursive: true });
    for (const [path, content] of contents) await writeFile(join(root, "upload/objects", objectId, path), content);
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
  const storage = new ApplicationReleaseStorage(join(root, "store"));
  const release = await storage.importRelease({
    projectRef: "example", applicationId: "reviews", manifestPath,
    expectedObjects: Object.fromEntries(objects.map(object => [object.name, object.objectId])),
  });
  const app = createApplicationRoutes({ storage, projectExists: async () => true, authorize: async () => undefined });
  return { app, release };
}

test("serves the validated development contract for a release target", async () => {
  const { app, release } = await fixture();
  const response = await app.handle(new Request(
    `http://localhost/v1/projects/example/applications/reviews/releases/${release.release_id}/development?target=api`,
  ));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.project_ref).toBe("example");
  expect(body.release_id).toBe(release.release_id);
  expect(body.target).toBe("api");
  expect(body.correlation).toBe("verified-build-snapshot");
  expect(body.object_id).toMatch(/^[a-f0-9]{64}$/);
  expect(body.context.schema).toBe("supacloud.application-development.v1");
});

test("reports a missing artifact and an unknown target distinctly", async () => {
  const { app, release } = await fixture(false);
  const base = `http://localhost/v1/projects/example/applications/reviews/releases/${release.release_id}/development`;
  const missing = await app.handle(new Request(`${base}?target=api`));
  expect(missing.status).toBe(404);
  expect((await missing.json()).code).toBe("APPLICATION_DEVELOPMENT_MISSING");

  const { app: withArtifact, release: other } = await fixture();
  const unknown = await withArtifact.handle(new Request(
    `http://localhost/v1/projects/example/applications/reviews/releases/${other.release_id}/development?target=workers`,
  ));
  expect(unknown.status).toBe(404);
  expect((await unknown.json()).code).toBe("APPLICATION_DEVELOPMENT_TARGET_NOT_FOUND");
});

test("rejects an invalid target name before reading the archive", async () => {
  const { app, release } = await fixture();
  const response = await app.handle(new Request(
    `http://localhost/v1/projects/example/applications/reviews/releases/${release.release_id}/development?target=Bad_Target`,
  ));
  expect(response.status).toBe(422);
  expect((await response.json()).code).toBe("APPLICATION_REQUEST_INVALID");
});