import { expect, test } from "bun:test";
import {
  defaultManagementLauncherSettings, managementAcceptanceDatabaseOptions, managementSetupMigrationPlan,
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
  for (const field of Object.keys(env)) {
    expect(() => defaultManagementLauncherSettings({ ...env, [field]: undefined })).toThrow();
  }
  expect(() => defaultManagementLauncherSettings({ ...env, SUPACLOUD_TEST_PROJECT_REF: "foreign" })).toThrow();
  for (const field of ["SUPACLOUD_BUSINESS_ARCHIVE", "SUPACLOUD_BUSINESS_VERIFIER", "NODE_EXTRA_CA_CERTS"]) {
    expect(() => defaultManagementLauncherSettings({ ...env, [field]: "relative" })).toThrow("Absolute");
  }
});

test("launcher rejects missing opt-in before filesystem, project or database effects", async () => {
  await expect(runDefaultManagementLauncher({ ...env, SUPACLOUD_BUSINESS_MANAGEMENT_TEST: "" }))
    .rejects.toThrow("opt-in");
});

test("tenant connection supplies explicit database and credentials instead of inheriting PGDATABASE", () => {
  const url = "postgres://http_user:fixture@localhost:55432/supa_ttzatqixbiaxhyratbvh";
  expect(managementAcceptanceDatabaseOptions(url)).toMatchObject({
    adapter: "postgres", url, hostname: "localhost", port: 55432, username: "http_user",
    password: "fixture", database: "supa_ttzatqixbiaxhyratbvh", max: 1, connectionTimeout: 5,
  });
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
