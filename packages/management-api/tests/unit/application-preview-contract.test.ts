import { expect, test } from "bun:test";
import { buildApplicationPreviewReceipt } from "../../src/services/application-preview-contract";

test("preview receipt names every isolated resource and never contains a secret value", () => {
  const receipt = buildApplicationPreviewReceipt({
    previewId: "01234567-89ab-4def-8123-456789abcdef",
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
      queue_namespace: { namespace: "preview_0123456789ab4def8123456789abcdef" },
      storage_namespace: { namespace: "branch-1" },
      test_secret: { name: "PREVIEW_TOKEN_0123456789AB4DEF8123456789ABCDEF", value_issued: false },
      smoke_test: { status: "pending" },
    },
    cleanup: { required: true, completed: false },
  });
  expect(JSON.stringify(receipt)).not.toContain("secret-value");
});
