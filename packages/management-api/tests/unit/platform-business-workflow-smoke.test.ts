import { expect, test } from "bun:test";
import { businessSettings } from "../fixtures/platform-business-workflow-smoke";

const env = {
  SUPACLOUD_BUSINESS_WORKFLOW_TEST: "1",
  SUPACLOUD_TEST_PROJECT_REF: "acceptancetest",
  SUPACLOUD_BUSINESS_ARCHIVE: "/test/archive/delivery.manifest.json",
  DATABASE_URL: "postgres://localhost/metadata",
  SUPACLOUD_BUSINESS_ORIGIN: "http://127.0.0.1:3000",
  SUPACLOUD_BUSINESS_TENANT_ID: "acceptance",
  SUPACLOUD_BUSINESS_CLIENT_ID: "acceptance-client",
  SUPACLOUD_BUSINESS_WORKER_ID: "acceptance-worker",
  SUPACLOUD_BUSINESS_OWNER_TOKEN: "test-owner-placeholder",
  SUPACLOUD_BUSINESS_OTHER_TOKEN: "test-other-placeholder",
};

test("business fixture requires explicit opt-in and complete external runtime inputs", () => {
  expect(businessSettings(env).timeoutMs).toBe(60000);
  for (const name of Object.keys(env)) {
    const missing: NodeJS.ProcessEnv = { ...env };
    delete missing[name];
    expect(() => businessSettings(missing)).toThrow();
  }
});

test("business fixture refuses unsafe origins and unbounded worker waits", () => {
  for (const origin of ["http://example.com", "https://user:password@example.com", "https://example.com/path",
    "https://example.com/?token=value"]) {
    expect(() => businessSettings({ ...env, SUPACLOUD_BUSINESS_ORIGIN: origin })).toThrow();
  }
  for (const timeout of ["NaN", "0", "300001"]) {
    expect(() => businessSettings({ ...env, SUPACLOUD_BUSINESS_TIMEOUT_MS: timeout })).toThrow();
  }
});

test("business fixture consumes compiled artifacts and never implements approval or a worker", async () => {
  const source = await Bun.file(new URL("../fixtures/platform-business-workflow-smoke.ts", import.meta.url)).text();
  for (const required of ["readDeliveryExecutableArchive", "SupaCloudWorkflowsClient", "SupaCloudArtifactsClient",
    "attachment-upload", "attachment-registration", 'call("approve"', "starter_attachment_results"]) {
    expect(source).toContain(required);
  }
  for (const forbidden of ["compileProject(", "buildDeliveryProject(", "createTransactionalCommand(",
    "workflows.start(", "workflows.claim(", "workflows.complete(", "start_run(", "rejectUnauthorized: false"]) {
    expect(source).not.toContain(forbidden);
  }
});
