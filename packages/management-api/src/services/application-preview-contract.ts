export type PreviewPhaseStatus = "pending" | "ready" | "failed" | "cleaned";

export interface ApplicationPreviewProbeInput {
  projectRef: string;
  branchRef: string;
  applicationId: string;
  environmentId: string;
  releaseId: string;
  configurationId: string;
  activationId: string;
}

export interface ApplicationPreviewReceipt {
  schema: "supacloud.application-preview.v1";
  preview_id: string;
  project_ref: string;
  application_id: string;
  environment_id: string;
  release_id: string;
  status: "planned" | "provisioning" | "ready" | "failed" | "cleaned";
  resources: {
    build_artifact: { status: PreviewPhaseStatus; release_id: string };
    database_branch: { status: PreviewPhaseStatus; branch_ref: string; data_mode: "schema_only" | "full_clone" };
    queue_namespace: { status: PreviewPhaseStatus; namespace: string };
    storage_namespace: { status: PreviewPhaseStatus; namespace: string };
    test_secret: { status: PreviewPhaseStatus; name: string; value_issued: false };
    configuration_revision: { status: PreviewPhaseStatus; configuration_id: string | null };
    application_activation: { status: PreviewPhaseStatus; activation_id: string | null };
    smoke_test: { status: PreviewPhaseStatus; checks: string[]; passed: string[]; failed: string[] };
  };
  cleanup: { required: boolean; completed: boolean; error: string | null };
}

export type StoredApplicationPreview = ApplicationPreviewReceipt & {
  branch_name: string;
  queue_name: string;
  test_secret_name: string;
  source_configuration_id: string | null;
  created_at: string;
  updated_at: string;
};

export function buildApplicationPreviewReceipt(input: {
  previewId: string;
  projectRef: string;
  applicationId: string;
  environmentId: string;
  releaseId: string;
  branchRef: string;
  dataMode: "schema_only" | "full_clone";
}): ApplicationPreviewReceipt {
  const namespace = `preview_${input.previewId}`;
  return {
    schema: "supacloud.application-preview.v1",
    preview_id: input.previewId,
    project_ref: input.projectRef,
    application_id: input.applicationId,
    environment_id: input.environmentId,
    release_id: input.releaseId,
    status: "planned",
    resources: {
      build_artifact: { status: "ready", release_id: input.releaseId },
      database_branch: { status: "pending", branch_ref: input.branchRef, data_mode: input.dataMode },
      queue_namespace: { status: "pending", namespace: namespace },
      storage_namespace: { status: "pending", namespace: input.branchRef },
      test_secret: { status: "pending", name: `SUPACLOUD_PREVIEW_${input.previewId.toUpperCase()}_TOKEN`, value_issued: false },
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
  };
}
