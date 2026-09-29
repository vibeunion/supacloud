import { expect, test } from "bun:test";
import {
  assertStarterStorageBucket, defaultManagementLauncherSettings, managementAcceptanceDatabaseOptions, managementSetupMigrationPlan,
  runDefaultManagementLauncher,
} from "../fixtures/platform-business-management-launcher";
import { buildDeliveryMigrationPlan, type DeliveryMigrationArchive } from "../../../delivery/src";

const env = {
  SUPACLOUD_BUSINESS_MANAGEMENT_TEST: "1",
  SUPACLOUD_TEST_PROJECT_REF: "ttzatqixbiaxhyratbvh",
  DATABASE_URL: "postgres://fixture:fixture@localhost/metadata",
  MASTER_TOKEN: "fixture-management",
  SUPACLOUD_BUSINESS_ARCHIVE: "/owned/archive/delivery.manifest.json",
  SUPACLOUD_BUSINESS_VERIFIER: "/owned/verify",
  NODE_EXTRA_CA_CERTS: "/owned/root.crt",
};

test("default-management launcher binds the dedicated project and requires every private input", () => {
  expect(defaultManagementLauncherSettings(env).ref).toBe(env.SUPACLOUD_TEST_PROJECT_REF);
  expect(defaultManagementLauncherSettings(env).rolePrefix).toBe("starter_ttzatqixbiaxhyratbvh");
  for (const field of Object.keys(env)) {
    expect(() => defaultManagementLauncherSettings({ ...env, [field]: undefined })).toThrow();
  }
  expect(() => defaultManagementLauncherSettings({ ...env, SUPACLOUD_TEST_PROJECT_REF: "foreign" })).toThrow();
  expect(defaultManagementLauncherSettings({ ...env, SUPACLOUD_BUSINESS_ROLE_PREFIX: "project_prefix" }).rolePrefix)
    .toBe("project_prefix");
  for (const prefix of ["a;DROP ROLE postgres", "a".repeat(51), "CaseSensitive", ""]) {
    expect(() => defaultManagementLauncherSettings({ ...env, SUPACLOUD_BUSINESS_ROLE_PREFIX: prefix })).toThrow("prefix");
  }
  for (const field of ["SUPACLOUD_BUSINESS_ARCHIVE", "SUPACLOUD_BUSINESS_VERIFIER", "NODE_EXTRA_CA_CERTS"]) {
    expect(() => defaultManagementLauncherSettings({ ...env, [field]: "relative" })).toThrow("Absolute");
  }
});

test("launcher rejects missing opt-in before filesystem, project or database effects", async () => {
  await expect(runDefaultManagementLauncher({ ...env, SUPACLOUD_BUSINESS_MANAGEMENT_TEST: "" }))
    .rejects.toThrow("opt-in");
});

test("launcher rejects provisioning resume before any role adoption or password rotation", () => {
  for (const extra of [
    { SUPACLOUD_BUSINESS_RESUME_PROVISIONING: "1" },
    { SUPACLOUD_BUSINESS_RESUME_ROOT: "/retained" },
  ]) expect(() => defaultManagementLauncherSettings({ ...env, ...extra })).toThrow("resume is unsupported");
});

test("tenant connection supplies explicit database and credentials instead of inheriting PGDATABASE", () => {
  const url = "postgres://http_user:fixture@localhost:55432/supa_ttzatqixbiaxhyratbvh";
  expect(managementAcceptanceDatabaseOptions(url)).toMatchObject({
    adapter: "postgres", url, hostname: "localhost", port: 55432, username: "http_user",
    password: "fixture", database: "supa_ttzatqixbiaxhyratbvh", max: 1, connectionTimeout: 5,
  });
});

test("starter bucket validation accepts the Supabase Storage bigint string response", () => {
  expect(() => assertStarterStorageBucket({
    public: false, file_size_limit: "1048576", allowed_mime_types: ["text/plain"],
  })).not.toThrow();
  expect(() => assertStarterStorageBucket({
    public: false, file_size_limit: 1048575, allowed_mime_types: ["text/plain"],
  })).toThrow();
  expect(() => assertStarterStorageBucket({
    public: true, file_size_limit: "1048576", allowed_mime_types: ["text/plain"],
  })).toThrow();
});

test("setup resume requires exact structured ledger checksums and never accepts raw hashes", () => {
  const archive: DeliveryMigrationArchive = {
    artifactVerified: true, objectId: "a".repeat(64), target: "api",
    migrations: [{ version: "1", name: "test", sql: "SELECT 1;\n", sha256: "b".repeat(64),
      path: "migrations/project-migration/1_test.sql", bytes: 10, executor: "project-migration" }],
  };
  const checksum = buildDeliveryMigrationPlan(archive, [], env.SUPACLOUD_TEST_PROJECT_REF).migrations[0]!.ledgerChecksum;
  const row = { version: "1", name: "test", checksum };
  expect(managementSetupMigrationPlan(archive, [], env.SUPACLOUD_TEST_PROJECT_REF, false)
    .migrations[0]!.status).toBe("pending");
  expect(() => managementSetupMigrationPlan(archive, [row], env.SUPACLOUD_TEST_PROJECT_REF, false)).toThrow("explicit");
  expect(managementSetupMigrationPlan(archive, [row], env.SUPACLOUD_TEST_PROJECT_REF, true)
    .migrations[0]!.status).toBe("ledger-match");
  expect(() => managementSetupMigrationPlan(archive, [{ ...row, checksum: "b".repeat(64) }],
    env.SUPACLOUD_TEST_PROJECT_REF, true)).toThrow("conflicts");
  expect(() => managementSetupMigrationPlan(archive, [row, { ...row, version: "2", name: "foreign" }],
    env.SUPACLOUD_TEST_PROJECT_REF, true)).toThrow("Unexpected");
});
