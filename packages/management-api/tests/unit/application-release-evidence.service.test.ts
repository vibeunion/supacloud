import { expect, test } from "bun:test";
import type { VerifiedDeliveryExecutableArchive } from "@supacloud/delivery";
import {
  RELEASE_EVIDENCE_SCHEMA,
  ReleaseEvidenceError,
  createReleaseEvidence,
} from "../../src/services/application-release-evidence.service";

const context = {
  schema: "supacloud.application-development.v1", source: "current-graph", deploymentVerified: false,
  modules: [], routes: [], commands: [], jobs: [], resourceUses: [], executionPlans: [],
  resources: [{ name: "reviews-db", kind: "database" }],
  diagnostics: [{ code: "SC8103", severity: "warn" }],
  omitted: {}, limits: { outputBytes: 65536 },
};

function inputs(development: boolean) {
  const files = new Map([
    ["bundle/index.js", Buffer.from("export {};")],
    ...(development ? [["bundle/application-development.json", Buffer.from(JSON.stringify(context))] as [string, Buffer]] : []),
  ]);
  return {
    record: {
      schema: "supacloud.application-release.v1", project_ref: "demo", application_id: "reviews",
      release_id: "r".repeat(64), manifest_sha256: "m".repeat(64), created_at: "2026-09-30T00:00:00.000Z",
      targets: [{ name: "api", object_id: "b".repeat(64), kind: "http", entrypoint: "bundle/index.js" }],
    },
    archive: {
      manifest: { producer: "@supacloud/compiler/delivery-build-v1" },
      objects: [{
        object: {
          name: "api", objectId: "b".repeat(64), entryKind: "bun-http-application",
          entrypoint: "bundle/index.js", files: [...files.keys()].map((path) => ({ path, sha256: "a".repeat(64), bytes: files.get(path)!.length })),
        },
        files,
      }],
    } as unknown as VerifiedDeliveryExecutableArchive,
    migrations: [{ target: "api", migrations: [{ version: "1" }, { version: "2" }] }],
  };
}

test("summarizes build, contract and separate rollback paths", () => {
  const evidence = createReleaseEvidence({ ...inputs(true), target: "api" });
  expect(evidence.schema).toBe(RELEASE_EVIDENCE_SCHEMA);
  expect(evidence.correlation).toBe("verified-build-snapshot");
  expect(evidence.build).toMatchObject({ manifestSha256: "m".repeat(64), objectId: "b".repeat(64), entryKind: "bun-http-application", files: 2 });
  expect(evidence.contract).toEqual({ status: "present", schema: "supacloud.application-development.v1", resources: 1, diagnostics: { errors: 0, warnings: 1 } });
  expect(evidence.migrations).toMatchObject({ status: "present", count: 2, latestVersion: "2", executionPerformed: false, compatibility: "not-proven", dataRecovery: "separate-required" });
  expect(evidence.rollback.application).toContain("previous immutable release");
  expect(evidence.notes.join(" ")).toContain("not signed provenance");
});

test("reports an absent contract and empty migrations", () => {
  const evidence = createReleaseEvidence({ ...inputs(false), migrations: [], target: "api" });
  expect(evidence.contract).toEqual({ status: "absent", schema: null, resources: 0, diagnostics: { errors: 0, warnings: 0 } });
  expect(evidence.migrations).toMatchObject({ status: "absent", count: 0, latestVersion: null });
});

test("rejects an unknown target", () => {
  expect(() => createReleaseEvidence({ ...inputs(true), target: "worker" }))
    .toThrow(new ReleaseEvidenceError("RELEASE_EVIDENCE_TARGET_NOT_FOUND"));
});