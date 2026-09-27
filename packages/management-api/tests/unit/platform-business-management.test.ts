import { expect, test } from "bun:test";
import { businessManagementSettings, requireBusinessMigrationLedger,
  businessManagementVerifierPolicy, businessManagementMigrationEvidence, requireBusinessManagementProject,
  runPlatformBusinessManagement, type BusinessManagementInput } from "../fixtures/platform-business-management";
import { applicationReleaseId, type ApplicationReleaseRecord } from "../../../delivery/src";
import { stableSha256 } from "../../src/utils/stable-json";

const ref = "ttzatqixbiaxhyratbvh";
const common = { SUPACLOUD_PROJECT_ID: ref, APP_TENANT_ID: `business-${ref}`,
  SUPACLOUD_URL: `https://${ref}.api.localhost`, DATABASE_URL: `postgres://user:fixture@localhost/supa_${ref}` };
const input: BusinessManagementInput = {
  ref, manifestPath: "/owned/archive/delivery.manifest.json",
  environment: { api: { ...common }, jobs: { ...common,
    DATABASE_URL: `postgres://worker:fixture@localhost/supa_${ref}` } },
  ownerToken: "fixture-owner", managementToken: "fixture-management",
  inspectionDatabaseUrl: common.DATABASE_URL, verifierExecutable: "/owned/verify", expectedRevision: 1,
};
const env = { SUPACLOUD_BUSINESS_MANAGEMENT_TEST: "1", SUPACLOUD_TEST_PROJECT_REF: ref };

test("management acceptance requires explicit owned-project opt-in and valid existing configuration schema", () => {
  const settings = businessManagementSettings(input, env);
  expect(settings.host).toBe(`business-${ref}.localhost`);
  expect(settings.configuration.configuration.targets.map(target => target.hosts))
    .toEqual([[`business-${ref}.localhost`], []]);
  expect(() => businessManagementSettings(input, {})).toThrow();
  expect(() => businessManagementSettings(input, { ...env, SUPACLOUD_TEST_PROJECT_REF: "foreign" })).toThrow();
  for (const changes of [
    { applicationId: "../escape" }, { environmentId: "../escape" }, { managementToken: "" },
    { inspectionDatabaseUrl: "postgres://user:fixture@localhost/postgres" },
    { environment: { ...input.environment, api: { ...common, SUPACLOUD_PROJECT_ID: "foreign" } } },
    { environment: { ...input.environment, jobs: { ...common, DATABASE_SOCKET_PATH: "/tmp/socket" } } },
  ]) expect(() => businessManagementSettings({ ...input, ...changes }, env)).toThrow();
});

test("missing, pending or baseline-only ledger cannot be promoted to activation evidence", () => {
  for (const report of [null, {}, { ledger_compatible: true, project_migrations_applied: true },
    { schema: "supacloud.application-migrations.v1", ledger_compatible: true, project_migrations_applied: false },
    { schema: "supacloud.application-migrations.v1", ledger_compatible: false, project_migrations_applied: true }]) {
    expect(() => requireBusinessMigrationLedger(report)).toThrow("MIGRATION_ADOPTION_REQUIRED");
  }
  expect(() => requireBusinessMigrationLedger({
    schema: "supacloud.application-migrations.v1", ledger_compatible: true, project_migrations_applied: true,
  })).not.toThrow();
});

test("entry fails before filesystem/network effects without opt-in", async () => {
  const previous = process.env.SUPACLOUD_BUSINESS_MANAGEMENT_TEST;
  delete process.env.SUPACLOUD_BUSINESS_MANAGEMENT_TEST;
  try { await expect(runPlatformBusinessManagement(input)).rejects.toThrow("opt-in"); }
  finally {
    if (previous !== undefined) process.env.SUPACLOUD_BUSINESS_MANAGEMENT_TEST = previous;
  }
});

test("only the dedicated default tenant is eligible, and creating is not activation-ready", () => {
  const project = { ref, name: "platform-app-acceptance-default-20260927", status: "creating" };
  expect(requireBusinessManagementProject(project, ref)).toBe(false);
  expect(requireBusinessManagementProject({ ...project, status: "active" }, ref)).toBe(true);
  expect(requireBusinessManagementProject({ ...project, status: "ACTIVE_HEALTHY" }, ref)).toBe(true);
  expect(() => requireBusinessManagementProject({ ...project, ref: "foreign" }, ref)).toThrow();
  expect(() => requireBusinessManagementProject({ ...project, name: "platform-app-acceptance-business" }, ref)).toThrow();
});

test("private verifier policy binds exact archive, environment, OAuth token and distinct roles", () => {
  const digest = "a".repeat(64);
  const release: ApplicationReleaseRecord = {
    schema: "supacloud.application-release.v1", project_ref: ref, application_id: "business-management",
    manifest_sha256: digest, release_id: applicationReleaseId(ref, "business-management", digest),
    created_at: "2026-09-27T00:00:00.000Z",
    targets: [
      { name: "api", kind: "http", object_id: "b".repeat(64), entrypoint: "bundle/index.js" },
      { name: "jobs", kind: "worker", object_id: "c".repeat(64), entrypoint: "bundle/index.js" },
    ],
  };
  const policy = businessManagementVerifierPolicy(input, release, env);
  expect(policy.environment_sha256).toBe(stableSha256(input.environment));
  expect(policy.releases).toEqual([{ manifest_sha256: digest, revision: 1 }]);
  expect(policy.identity_token).toBe(input.ownerToken);
  expect(policy.inspection).toEqual({ url: input.inspectionDatabaseUrl });
  expect([policy.http_role, policy.worker_role]).toEqual(["user", "worker"]);
  expect(policy).not.toHaveProperty("bun_executable");
  expect(JSON.stringify(policy)).not.toContain(input.managementToken);
  expect(businessManagementVerifierPolicy({ ...input, expectedRevision: 2 }, release, env).releases[0]?.revision).toBe(2);
  expect(() => businessManagementVerifierPolicy({ ...input, applicationId: "foreign" }, release, env)).toThrow();
  expect(() => businessManagementSettings({
    ...input, environment: { api: common, jobs: common },
  }, env)).toThrow("Distinct runtime");
});

test("ledger evidence retains out-of-order/conflict statuses without SQL or credentials", () => {
  const evidence = businessManagementMigrationEvidence({
    ledger_compatible: false, project_migrations_applied: false,
    targets: [{ migrations: [
      { version: "1", status: "out-of-order", sql: "PRIVATE SQL" },
      { version: "2", status: "checksum-mismatch", credentials: "PRIVATE PASSWORD" },
    ] }],
  });
  expect(evidence).toEqual({
    ledgerCompatible: false, projectMigrationsApplied: false,
    migrations: [{ version: "1", status: "out-of-order" }, { version: "2", status: "checksum-mismatch" }],
  });
  expect(JSON.stringify(evidence)).not.toContain("PRIVATE");
});
