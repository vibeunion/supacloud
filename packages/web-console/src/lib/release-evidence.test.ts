import { expect, test } from "bun:test";
import { loadReleaseEvidence, parseReleaseEvidence } from "./release-evidence";

const scope = { ref: "demo-project", application: "reviews", environment: "acceptance" };
const releaseId = "a".repeat(64);
const target = "api";
const response = {
  project_ref: scope.ref, application_id: scope.application, release_id: releaseId,
  schema: "supacloud.release-evidence.v1" as const, correlation: "verified-build-snapshot" as const,
  deploymentVerified: false as const, target,
  build: {
    producer: "@supacloud/compiler/delivery-build-v1", deploymentReady: false as const,
    manifestSha256: "b".repeat(64), objectId: "c".repeat(64),
    entryKind: "bun-http-application", entrypoint: "bundle/index.js", files: 3, bytes: 128,
  },
  contract: { status: "present" as const, schema: "supacloud.application-development.v1", resources: 1, diagnostics: { errors: 0, warnings: 1 } },
  migrations: { status: "present" as const, count: 2, latestVersion: "2", executionPerformed: false as const, compatibility: "not-proven" as const, dataRecovery: "separate-required" as const },
  rollback: { application: "previous release", database: "repair path", storage: "object version" },
  notes: ["Local artifact integrity only."],
};

test("release evidence decoder accepts a verified target summary", () => {
  const parsed = parseReleaseEvidence(response, scope, releaseId, target);
  expect(parsed.build.entryKind).toBe("bun-http-application");
  expect(parsed.contract.diagnostics.warnings).toBe(1);
  expect(parsed.migrations.latestVersion).toBe("2");
});

test("release evidence decoder rejects mismatched or unverifiable documents", () => {
  const cases: [Record<string, unknown>][] = [
    [{ ...response, deploymentVerified: true }],
    [{ ...response, project_ref: "other" }],
    [{ ...response, target: "workers" }],
    [{ ...response, build: { ...response.build, manifestSha256: "short" } }],
    [{ ...response, contract: { ...response.contract, status: "unknown" } }],
    [{ ...response, migrations: { ...response.migrations, executionPerformed: true } }],
    [{ ...response, migrations: { ...response.migrations, status: "absent", count: 2 } }],
    [{ ...response, rollback: { application: "" } }],
    [{ ...response, notes: ["ok", 3] }],
  ];
  for (const [value] of cases) expect(() => parseReleaseEvidence(value, scope, releaseId, target)).toThrow();
});

test("release evidence loader binds the release and target in its URL", async () => {
  let seen = "";
  const request = async (url: string, init: RequestInit) => {
    seen = url;
    expect(init.cache).toBe("no-store");
    return Response.json(response);
  };
  const loaded = await loadReleaseEvidence(scope, releaseId, target, request, new AbortController().signal);
  expect(loaded.schema).toBe("supacloud.release-evidence.v1");
  expect(seen).toBe(`/v1/projects/demo-project/applications/reviews/releases/${releaseId}/evidence?target=api`);
  expect(() => loadReleaseEvidence(scope, releaseId, "Bad_Target", request, new AbortController().signal)).toThrow();
});