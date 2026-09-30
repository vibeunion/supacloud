import { expect, test } from "bun:test";
import { loadReleaseEvidence, parseReleaseEvidence } from "./release-evidence";

const scope = { ref: "demo", application: "reviews", environment: "preview" };
const release = "a".repeat(64);
function response() {
  return {
    project_ref: "demo", application_id: "reviews", release_id: release,
    schema: "supacloud.release-evidence.v1", correlation: "verified-build-snapshot", deploymentVerified: false, target: "api",
    build: { producer: "@supacloud/compiler/delivery-build-v1", deploymentReady: false,
      manifestSha256: "b".repeat(64), objectId: "c".repeat(64), entryKind: "bun-http-application",
      entrypoint: "bundle/index.js", files: 3, bytes: 128 },
    contract: { status: "present", schema: "supacloud.application-development.v1", resources: 1, diagnostics: { errors: 0, warnings: 0 } },
    migrations: { status: "absent", count: 0, latestVersion: null, executionPerformed: false,
      compatibility: "not-proven", dataRecovery: "separate-required" },
    rollback: { application: "previous release", database: "separate repair", storage: "separate version restore" },
    notes: ["Not runtime evidence"],
  };
}

test("rejects unknown fields, invalid identity types and contradictory absent metadata", () => {
  const base = response();
  for (const value of [
    { ...base, privateValue: "must-not-return" },
    { ...base, build: { ...base.build, extra: "must-not-return" } },
    { ...base, build: { ...base.build, objectId: [base.build.objectId] } },
    { ...base, build: { ...base.build, entrypoint: "some-other-file.js" } },
    { ...base, contract: { ...base.contract, status: "absent", schema: null } },
    { ...base, migrations: { ...base.migrations, count: 1 } },
    { ...base, migrations: { ...base.migrations, status: "present", count: 1, latestVersion: "not-a-version" } },
    { ...base, migrations: { ...base.migrations, status: "present", count: 129, latestVersion: "129" } },
  ]) expect(() => parseReleaseEvidence(value, scope, release, "api")).toThrow();
});

test("detaches nested response objects from caller mutation", () => {
  const base = response();
  const parsed = parseReleaseEvidence(base, scope, release, "api");
  base.notes.push("mutated");
  base.contract.diagnostics.errors = 1;
  base.build.objectId = "d".repeat(64);
  expect(parsed.notes).toEqual(["Not runtime evidence"]);
  expect(parsed.contract.diagnostics.errors).toBe(0);
  expect(parsed.build.objectId).toBe("c".repeat(64));
});

test("loader captures scope before an asynchronous response", async () => {
  const selected = { ...scope };
  const pending = Promise.withResolvers<Response>();
  const loading = loadReleaseEvidence(selected, release, "api", async () => pending.promise, new AbortController().signal);
  selected.ref = "other";
  selected.application = "other-app";
  pending.resolve(Response.json(response()));
  const loaded = await loading;
  expect(loaded.project_ref).toBe("demo");
  expect(loaded.application_id).toBe("reviews");
});

test("optional inventory pin rejects a different object in the same target", async () => {
  const request = async () => Response.json(response());
  await expect(loadReleaseEvidence(scope, release, "api", request, new AbortController().signal, "d".repeat(64)))
    .rejects.toThrow();
});
