import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applicationReleaseId, parseApplicationReleaseTransferPlan, parseApplicationReleaseTransferResult,
  type ApplicationReleaseRecord,
} from "@supacloud/delivery";
import { deliveryObjectDigest, type DeliveryBuildManifest, type DeliveryObject } from "@supacloud/delivery/build-schema";
import { canonical, digest } from "@supacloud/delivery/files";
import type { DeliveryTarget } from "@supacloud/delivery/schema";
import { ApplicationReleaseStorage } from "../../src/services/application-release-storage";
import { ApplicationReleaseTransfers } from "../../src/services/application-release-transfer";
import { createApplicationRoutes } from "../../src/routes/applications";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "application-transfer-unit-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(withMigrations = false) {
  const target: DeliveryTarget = {
    name: "api", kind: "api", isolation: "process", roots: ["api"],
    modules: [{ name: "api", reason: "owner", importedBy: [] }], routes: [], jobs: [], externalTokens: [],
    requirements: { processIsolation: true, durableQueue: false, capabilities: [] },
    runtimeStatus: "declared-compatible",
  };
  const files = new Map([
    ["bundle/index.js", "throw new Error('transfer must never execute code');\n"],
    ["bundle/target.json", canonical({ target, entryKind: "bun-http-application", deploymentReady: false })],
  ]);
  if (withMigrations) {
    const sql = "SELECT 1 / 0;\n";
    const path = "migrations/project-migration/1_fixture.sql";
    files.set(`bundle/${path}`, sql);
    files.set("bundle/migrations.json", canonical({
      version: 1, digestScope: "raw-sql-bytes", compatibility: "not-proven",
      executionPerformed: false, dataRecovery: "separate-required",
      migrations: [{
        version: "1", name: "fixture", executor: "project-migration",
        path, sha256: digest(sql), bytes: Buffer.byteLength(sql),
      }],
    }));
  }
  const object: Omit<DeliveryObject, "objectId"> = {
    name: "api", inputDigest: digest("fixture"), entryKind: "bun-http-application", entrypoint: "bundle/index.js",
    runtimeImports: [], files: [...files].map(([path, content]) => ({
      path, sha256: digest(content), bytes: Buffer.byteLength(content),
    })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  const objectId = deliveryObjectDigest(object);
  const manifest: DeliveryBuildManifest = {
    schemaVersion: 1, producer: "@supacloud/compiler/delivery-build-v1", deploymentReady: false,
    plan: {
      schemaVersion: 1, policyVersion: "module-workload-v1", digestScope: "topology-only",
      topologyDigest: digest("topology"), deploymentReady: false, targets: [target],
    },
    objects: [{ ...object, objectId }], routes: [], jobs: [],
  };
  const upload = join(root, "upload");
  await mkdir(join(upload, "objects", objectId, "bundle"), { recursive: true });
  for (const [path, content] of files) await Bun.write(join(upload, "objects", objectId, path), content);
  const manifestPath = join(upload, "delivery.manifest.json");
  await Bun.write(manifestPath, canonical(manifest));
  const storage = new ApplicationReleaseStorage(join(root, "store"));
  const source = await storage.importRelease({
    projectRef: "staging", applicationId: "reviews", manifestPath, expectedObjects: { api: objectId },
  });
  const input = {
    projectRef: "production", applicationId: "reviews", sourceProjectRef: "staging", sourceReleaseId: source.release_id,
  };
  const transfers = new ApplicationReleaseTransfers(storage);
  const entry = (ref: string, id: string) => join(root, "store", ref, "reviews/releases", id, "objects", objectId, "bundle/index.js");
  return { storage, source, input, transfers, files, entry };
}

test("read-only plan verifies source and predicts target identity without creating target storage", async () => {
  const f = await fixture();
  const plan = await f.transfers.readPlan(f.input);
  expect(parseApplicationReleaseTransferPlan(plan)).toEqual(plan);
  expect(plan.action).toBe("materialize");
  expect(plan.candidate_release_id).toBe(applicationReleaseId("production", "reviews", f.source.manifest_sha256));
  expect(plan.execution_performed).toBe(false);
  expect(await readdir(join(root, "store"))).toEqual(["staging"]);
});

test("transfer publishes identical objects under target scope and then plans a verified no-op", async () => {
  const f = await fixture();
  const result = await f.transfers.transfer({ ...f.input, expectedManifestSha256: f.source.manifest_sha256 });
  expect(parseApplicationReleaseTransferResult(result)).toEqual(result);
  expect(result.activation_performed).toBe(false);
  expect(result.release.project_ref).toBe("production");
  expect(result.release.targets).toEqual(f.source.targets);
  expect(result.release.manifest_sha256).toBe(f.source.manifest_sha256);
  expect(result.release.release_id).not.toBe(f.source.release_id);
  expect(await Bun.file(f.entry("production", result.release.release_id)).text()).toBe(f.files.get("bundle/index.js")!);
  const retained = await f.storage.readRelease("production", "reviews", result.release.release_id);
  expect((await f.transfers.readPlan(f.input)).action).toBe("no-op");
  expect((await f.transfers.transfer({ ...f.input, expectedManifestSha256: f.source.manifest_sha256 })).release).toEqual(retained);
  expect(await readdir(join(root, "store/production/reviews"))).toEqual(["releases"]);
});

test("same-project transfer reuses exact identity and creates no duplicate artifact", async () => {
  const f = await fixture();
  const input = { ...f.input, projectRef: "staging" };
  expect((await f.transfers.readPlan(input)).action).toBe("no-op");
  const result = await f.transfers.transfer({ ...input, expectedManifestSha256: f.source.manifest_sha256 });
  expect(result.release).toEqual(f.source);
  expect(await readdir(join(root, "store/staging/reviews/releases"))).toEqual([f.source.release_id]);
});

test("migration SQL and raw-byte digests are transferred without executing or changing the ledger", async () => {
  const f = await fixture(true);
  const receipt = await f.transfers.transfer({ ...f.input, expectedManifestSha256: f.source.manifest_sha256 });
  const source = await f.storage.readMigrations("staging", "reviews", f.source.release_id);
  const target = await f.storage.readMigrations("production", "reviews", receipt.release.release_id);
  expect(target.archives).toEqual(source.archives);
  expect(target.archives[0]!.migrations[0]!.sql).toBe("SELECT 1 / 0;\n");
  expect(target.archives[0]!.migrations[0]!.sha256).toBe(digest("SELECT 1 / 0;\n"));
});

test("concurrent platform transfers return the complete winner and remove staging directories", async () => {
  const f = await fixture();
  const request = { ...f.input, expectedManifestSha256: f.source.manifest_sha256 };
  const [a, b] = await Promise.all([f.transfers.transfer(request), f.transfers.transfer(request)]);
  expect(a).toEqual(b);
  expect(await f.storage.readRelease("production", "reviews", a.release.release_id)).toEqual(a.release);
  expect(await readdir(join(root, "store/production/reviews/releases"))).toEqual([a.release.release_id]);
});

test("materialization publishes the verified bytes even if the source path changes after validation", async () => {
  const f = await fixture();
  const read = f.storage.readArchive.bind(f.storage);
  f.storage.readArchive = async (ref, app, id) => {
    const snapshot = await read(ref, app, id);
    if (ref === "staging") await Bun.write(f.entry(ref, id), "changed after snapshot");
    return snapshot;
  };
  const release = await f.storage.materializeRelease("staging", "reviews", f.source.release_id, "production");
  expect(await Bun.file(f.entry("production", release.release_id)).text()).toBe(f.files.get("bundle/index.js")!);
  await expect(read("staging", "reviews", f.source.release_id)).rejects.toThrow();
});

test("existing corrupt target is rejected without overwrite or repair", async () => {
  const f = await fixture();
  const result = await f.transfers.transfer({ ...f.input, expectedManifestSha256: f.source.manifest_sha256 });
  const target = f.entry("production", result.release.release_id);
  await Bun.write(target, "corrupt-private-marker");
  await expect(f.transfers.readPlan(f.input)).rejects.toMatchObject({ code: "APPLICATION_RELEASE_TRANSFER_UNVERIFIED", statusCode: 503 });
  await expect(f.transfers.transfer({ ...f.input, expectedManifestSha256: f.source.manifest_sha256 })).rejects.toMatchObject({ statusCode: 503 });
  expect(await Bun.file(target).text()).toBe("corrupt-private-marker");
});

test("corrupt source cannot create target storage", async () => {
  const f = await fixture();
  await Bun.write(f.entry("staging", f.source.release_id), "corrupt");
  await expect(f.transfers.transfer({ ...f.input, expectedManifestSha256: f.source.manifest_sha256 })).rejects.toMatchObject({ statusCode: 503 });
  expect(await readdir(join(root, "store"))).toEqual(["staging"]);
});

test("both service and storage pin the manifest digest before publication", async () => {
  const f = await fixture();
  await expect(f.transfers.transfer({ ...f.input, expectedManifestSha256: "f".repeat(64) })).rejects.toMatchObject({ statusCode: 409 });
  await expect(f.storage.materializeRelease("staging", "reviews", f.source.release_id, "production", "f".repeat(64)))
    .rejects.toMatchObject({ code: "APPLICATION_RELEASE_TRANSFER_DIGEST_MISMATCH", statusCode: 409 });
  expect(await readdir(join(root, "store"))).toEqual(["staging"]);
});

test.each(["projectRef", "sourceProjectRef", "applicationId", "sourceReleaseId"] as const)(
  "invalid %s is rejected before storage reads", async field => {
    let reads = 0;
    const transfers = new ApplicationReleaseTransfers({
      readRelease: async () => { reads++; throw new Error("Unexpected read"); },
      materializeRelease: async () => { throw new Error("Unexpected materialization"); },
    });
    await expect(transfers.readPlan({
      projectRef: "production", applicationId: "reviews", sourceProjectRef: "staging",
      sourceReleaseId: "a".repeat(64), [field]: "../invalid",
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(reads).toBe(0);
  },
);

test("foreign provider records are rejected without reflecting private exceptions", async () => {
  const f = await fixture();
  const transfers = new ApplicationReleaseTransfers({
    readRelease: async () => ({
      ...f.source, project_ref: "foreign", release_id: applicationReleaseId("foreign", "reviews", f.source.manifest_sha256),
    }),
    materializeRelease: async () => { throw new Error("private-credential"); },
  });
  await expect(transfers.readPlan(f.input)).rejects.toMatchObject({
    code: "APPLICATION_RELEASE_TRANSFER_UNVERIFIED", message: "APPLICATION_RELEASE_TRANSFER_UNVERIFIED",
  });
});

function request(source: ApplicationReleaseRecord, write = false, change: Record<string, unknown> = {}) {
  const path = "http://localhost/v1/projects/production/applications/reviews/";
  const body = {
    source_ref: "staging", source_release_id: source.release_id,
    expected_manifest_sha256: source.manifest_sha256, ...change,
  };
  return write ? new Request(`${path}release-transfers`, {
    method: "POST", headers: { "content-type": "application/json", "authorization": "Bearer fixture" },
    body: JSON.stringify(body),
  }) : new Request(`${path}release-transfer-plan?source_ref=staging&source_release_id=${source.release_id}`, {
    headers: { authorization: "Bearer fixture" },
  });
}

test("API requires target access and separate source GET authorization before reading artifacts", async () => {
  const f = await fixture();
  const access: string[] = [];
  const app = createApplicationRoutes({
    storage: f.storage, transfers: f.transfers, projectExists: async () => true,
    authorize: async (req, ref) => {
      expect(req.headers.get("authorization")).toBe("Bearer fixture");
      access.push(`${req.method} ${new URL(req.url).pathname} ${ref}`);
      return undefined;
    },
  });
  const response = await app.handle(request(f.source, true));
  expect(response.status).toBe(200);
  expect(parseApplicationReleaseTransferResult(await response.json()).release.targets).toEqual(f.source.targets);
  expect(access).toEqual([
    "POST /v1/projects/production/applications/reviews/release-transfers production",
    `GET /v1/projects/staging/applications/reviews/releases/${f.source.release_id} staging`,
  ]);
});

test.each(["source", "target"] as const)("denied %s access never reads artifacts or transfers", async denied => {
  const f = await fixture();
  let reads = 0;
  const app = createApplicationRoutes({
    authorize: async (_request, ref) => ref === (denied === "source" ? "staging" : "production")
      ? { status: 403, body: { error: "Denied" } } : undefined,
    projectExists: async () => true,
    transfers: {
      readPlan: async () => { reads++; throw new Error("Unexpected read"); },
      transfer: async () => { reads++; throw new Error("Unexpected transfer"); },
    },
  });
  for (const write of [true, false]) expect((await app.handle(request(f.source, write))).status).toBe(403);
  expect(reads).toBe(0);
});

test("invalid API body and missing source project never invoke transfer", async () => {
  const f = await fixture();
  let writes = 0;
  const app = createApplicationRoutes({
    authorize: async () => undefined, projectExists: async ref => ref !== "staging",
    transfers: { readPlan: f.transfers.readPlan.bind(f.transfers), transfer: async () => { writes++; throw new Error(); } },
  });
  expect((await app.handle(request(f.source, true, { expected_manifest_sha256: "bad" }))).status).toBe(422);
  expect((await app.handle(request(f.source, true, { server_path: "/private" }))).status).toBe(422);
  expect((await app.handle(request(f.source, true))).status).toBe(404);
  expect(writes).toBe(0);
});

test("API plan is read-only and sanitizes corrupt artifact failures", async () => {
  const f = await fixture();
  const app = createApplicationRoutes({ authorize: async () => undefined, projectExists: async () => true, storage: f.storage });
  const plan = await app.handle(request(f.source));
  expect(plan.status).toBe(200);
  expect(parseApplicationReleaseTransferPlan(await plan.json()).action).toBe("materialize");
  expect(await readdir(join(root, "store"))).toEqual(["staging"]);
  await Bun.write(f.entry("staging", f.source.release_id), "private-fixture");
  const failure = await app.handle(request(f.source));
  expect(failure.status).toBe(503);
  expect(await failure.json()).toEqual({
    code: "APPLICATION_RELEASE_TRANSFER_UNVERIFIED", error: "Application release transfer is unavailable",
  });
});
