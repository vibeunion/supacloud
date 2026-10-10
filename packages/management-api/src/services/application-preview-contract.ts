import { parseApplicationPreviewReceipt, type ApplicationPreviewReceipt } from "@supacloud/delivery";

export type PreviewPhaseStatus = "pending" | "ready" | "failed" | "cleaned";
export type { ApplicationPreviewReceipt } from "@supacloud/delivery";

export interface ApplicationPreviewProbeInput {
  projectRef: string;
  branchRef: string;
  applicationId: string;
  environmentId: string;
  releaseId: string;
  configurationId: string;
  activationId: string;
}

export type StoredApplicationPreview = ApplicationPreviewReceipt & {
  branch_name: string;
  queue_name: string;
  test_secret_name: string;
  source_configuration_id: string | null;
  source_release_id?: string;
  source_manifest_sha256?: string;
  expires_at?: string | null;
  created_at: string;
  updated_at: string;
};

export function publicApplicationPreviewReceipt(receipt: ApplicationPreviewReceipt): ApplicationPreviewReceipt {
  return parseApplicationPreviewReceipt({
    schema: receipt.schema, preview_id: receipt.preview_id, project_ref: receipt.project_ref,
    application_id: receipt.application_id, environment_id: receipt.environment_id,
    release_id: receipt.release_id, expires_at: receipt.expires_at ?? null,
    status: receipt.status, resources: receipt.resources, cleanup: receipt.cleanup,
  });
}

export function buildApplicationPreviewReceipt(input: {
  previewId: string;
  projectRef: string;
  applicationId: string;
  environmentId: string;
  releaseId: string;
  branchRef: string;
  dataMode: "schema_only" | "full_clone";
  expiresAt?: string | null;
}): ApplicationPreviewReceipt {
  const normalizedId = input.previewId.replace(/-/g, "").slice(0, 40);
  const namespace = `preview_${normalizedId}`;
  return parseApplicationPreviewReceipt({
    schema: "supacloud.application-preview.v1",
    preview_id: input.previewId,
    project_ref: input.projectRef,
    application_id: input.applicationId,
    environment_id: input.environmentId,
    release_id: input.releaseId,
    expires_at: input.expiresAt ?? null,
    status: "planned",
    resources: {
      build_artifact: { status: "ready", release_id: input.releaseId },
      database_branch: { status: "pending", branch_ref: input.branchRef, data_mode: input.dataMode },
      queue_namespace: { status: "pending", namespace: namespace },
      storage_namespace: { status: "pending", namespace: input.branchRef },
      test_secret: { status: "pending", name: `PREVIEW_TOKEN_${normalizedId.toUpperCase()}`, value_issued: false },
      configuration_revision: { status: "pending", configuration_id: null },
      application_activation: { status: "pending", activation_id: null },
      smoke_test: {
      status: "pending",
      checks: ["release_artifact", "database_branch", "queue_namespace", "storage_namespace", "test_secret", "configuration_revision", "application_activation", "application_readiness"],
        passed: [],
        failed: [],
      },
    },
    cleanup: { required: true, completed: false, error: null },
  });
}
