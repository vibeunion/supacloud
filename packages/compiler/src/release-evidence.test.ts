import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeliveryProject } from "./delivery-build";
import type { DeliveryBuildManifest } from "./delivery-build-schema";
import { createReleaseEvidence, formatReleaseEvidence, RELEASE_EVIDENCE_SCHEMA } from "./release-evidence";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { requireValue, writeFixtureProject } from "./fixtures/helpers";

let root: string;
let manifest: DeliveryBuildManifest;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "release-evidence-"));
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

test("summarizes one immutable target as verified release evidence", async () => {
  const object = requireValue(manifest.objects[0]);
  const evidence = await createReleaseEvidence(manifestPath(), object.name);
  expect(evidence.schema).toBe(RELEASE_EVIDENCE_SCHEMA);
  expect(evidence.correlation).toBe("verified-build-snapshot");
  expect(evidence.deploymentVerified).toBe(false);
  expect(evidence.target).toBe(object.name);
  expect(evidence.build).toMatchObject({
    producer: "@supacloud/compiler/delivery-build-v1",
    deploymentReady: false,
    objectId: object.objectId,
    entryKind: object.entryKind,
    entrypoint: "bundle/index.js",
    files: object.files.length,
    bytes: object.files.reduce((total, file) => total + file.bytes, 0),
  });
  expect(evidence.build.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(evidence.contract.status).toBe("present");
  expect(evidence.contract.schema).toBe("supacloud.application-development.v1");
  expect(evidence.contract.diagnostics).toEqual({ errors: 0, warnings: 0 });
  expect(evidence.migrations).toMatchObject({
    status: "absent", count: 0, latestVersion: null,
    executionPerformed: false, compatibility: "not-proven", dataRecovery: "separate-required",
  });
  expect(evidence.rollback.application).toContain("previous immutable release");
  expect(evidence.notes.join(" ")).toContain("not signed provenance");
  expect(formatReleaseEvidence(evidence)).toContain(`RELEASE ${object.name}`);
});

test("fails closed for an unknown target", async () => {
  await expect(createReleaseEvidence(manifestPath(), "not-a-target"))
    .rejects.toMatchObject({ code: "RELEASE_EVIDENCE_TARGET_NOT_FOUND" });
});

test("fails closed when an inventoried file is tampered", async () => {
  const object = requireValue(manifest.objects[0]);
  const target = requireValue(object.files.find((file) => file.path === "bundle/index.js"));
  const path = join(root, "generated/delivery/objects", object.objectId, target.path);
  const original = await readFile(path, "utf8");
  try {
    await writeFile(path, `${original}\n// tampered\n`);
    await expect(createReleaseEvidence(manifestPath(), object.name))
      .rejects.toMatchObject({ code: "RELEASE_EVIDENCE_INVALID" });
  } finally { await writeFile(path, original); }
});