import { expect, test } from "bun:test";
import { buildApplicationPreviewReceipt } from "../../src/services/application-preview-contract";

test("preview receipt names every isolated resource and never contains a secret value", () => {
  const receipt = buildApplicationPreviewReceipt({
    previewId: "preview-1",
    projectRef: "demo",
    applicationId: "api",
    environmentId: "test",
    releaseId: "a".repeat(64),
    branchRef: "branch-1",
    dataMode: "schema_only",
  });
  expect(receipt).toMatchObject({
    schema: "supacloud.application-preview.v1",
    status: "planned",
    resources: {
      build_artifact: { status: "ready" },
      database_branch: { status: "pending", branch_ref: "branch-1" },
      queue_namespace: { namespace: "preview_preview-1" },
      storage_namespace: { namespace: "branch-1" },
      test_secret: { value_issued: false },
      smoke_test: { status: "pending" },
    },
    cleanup: { required: true, completed: false },
  });
  expect(JSON.stringify(receipt)).not.toContain("secret-value");
});
