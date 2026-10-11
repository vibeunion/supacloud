import { parseApplicationPromotionPlan, type ApplicationPromotionPlan } from "@supacloud/delivery";
import { assertPublicMutationPayload, isProjectMutationId, projectMutationResourceKey, type ProjectMutationState } from "./project-mutation.service";
import { stableSha256, stableStringify } from "../utils/stable-json";

export interface ApplicationPromotionRequest {
  project_ref: string;
  application_id: string;
  environment_id: string;
  source_ref: string;
  source_environment_id: string;
  source_release_id: string;
  configuration_id: string;
  plan_sha256: string;
  approved_migration_digest: string | null;
}

export interface ApplicationPromotionCheckpoint extends Record<string, unknown> {
  schema: "supacloud.application-promotion-operation.v1";
  phase: "prepared" | "transferring" | "migrating" | "activating" | "verifying";
  request: ApplicationPromotionRequest;
  plan: ApplicationPromotionPlan;
  mutation_id: string;
  backup_id: string;
  activation_id: string;
}

export function applicationPromotionReceipt(parent: ApplicationPromotionCheckpoint): Record<string, unknown> {
  return {
    schema: "supacloud.application-promotion-receipt.v1",
    project_ref: parent.plan.project_ref, application_id: parent.plan.application_id,
    environment_id: parent.plan.environment_id, mutation_id: parent["mutation_id"],
    plan_sha256: parent.plan.plan_sha256,
    release_id: parent.plan.target.candidate_release_id, activation_id: parent.activation_id,
    backup_id: parent.backup_id, migration: parent["migration"] ?? null,
    verification: parent["verification"] ?? null, data_recovery: "separate-required",
  };
}

export function applicationPromotionRecoveryFingerprint(
  input: { plan_sha256: string; activation_id: string; release_id: string; configuration_id: string | null },
): string {
  return stableSha256({
    schema: "supacloud.application-promotion-recovery.v1", ...input,
  });
}

export function hasApplicationPromotionRecoveryReceipt(state: ProjectMutationState): boolean {
  try {
    const parent = parseApplicationPromotionCheckpoint(state);
    const raw = state.receipt?.["reconciliation"];
    if (state.status !== "succeeded" || state.responseStatus !== 200 || parent.phase !== "verifying" || !raw
      || typeof raw !== "object" || Array.isArray(raw)) return false;
    const value = raw as Record<string, unknown>;
    const timestamp = value["observed_at"];
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))
      || new Date(timestamp).toISOString() !== timestamp) return false;
    return stableStringify(state.receipt) === stableStringify({ reconciliation: {
      source: "project.release.authority", observed_at: timestamp,
      evidence_code: "RELEASE_AUTHORITY_CONFIRMED", target_status: "succeeded",
      evidence_fingerprint: applicationPromotionRecoveryFingerprint({
        plan_sha256: parent.plan.plan_sha256, activation_id: parent.activation_id,
        release_id: parent.plan.target.candidate_release_id, configuration_id: parent.plan.target.configuration_id,
      }),
    } });
  } catch { return false; }
}

export function applicationPromotionResource(applicationId: string, environmentId: string) {
  return { type: "application_release", id: stableSha256({ applicationId, environmentId }) };
}

export function applicationPromotionFingerprint(request: ApplicationPromotionRequest): string {
  return stableSha256({ schema: "supacloud.application-promotion-request.v1", ...request });
}

/** 父请求摘要绑定持久计划；重建服务不能依赖上次进程的内存摘要。 */
export function parseApplicationPromotionCheckpoint(state: ProjectMutationState): ApplicationPromotionCheckpoint {
  const value = state.checkpoint;
  assertPublicMutationPayload(value);
  assertPublicMutationPayload(value["request"]);
  const request = value["request"];
  const plan = parseApplicationPromotionPlan(value["plan"]);
  if (value["schema"] !== "supacloud.application-promotion-operation.v1"
    || !["prepared", "transferring", "migrating", "activating", "verifying"].includes(String(value["phase"]))
    || !isProjectMutationId(value["activation_id"]) || value["activation_id"] === state.mutationId
    || value["activation_id"] === plan.target.activation_id
    || value["mutation_id"] !== state.mutationId
    || typeof value["backup_id"] !== "string"
    || !new RegExp(`^logical-full_${plan.project_ref}_[a-f0-9]{32}$`).test(value["backup_id"])
    || request["project_ref"] !== plan.project_ref || request["application_id"] !== plan.application_id
    || request["environment_id"] !== plan.environment_id || request["source_ref"] !== plan.source.project_ref
    || request["source_environment_id"] !== plan.source.environment_id
    || request["source_release_id"] !== plan.source.release_id
    || request["configuration_id"] !== plan.target.configuration_id || !plan.target.configuration_id
    || request["plan_sha256"] !== plan.plan_sha256
    || !(request["approved_migration_digest"] === null || typeof request["approved_migration_digest"] === "string"
      && /^[a-f0-9]{64}$/.test(request["approved_migration_digest"]))
    || Object.keys(request).length !== 9
    || state.operation !== "application.release.promote"
    || state.projectRef !== plan.project_ref || !isProjectMutationId(state.mutationId)
    || state.requestFingerprint !== applicationPromotionFingerprint(request as unknown as ApplicationPromotionRequest)
    || state.resourceKey !== projectMutationResourceKey(applicationPromotionResource(plan.application_id, plan.environment_id))) {
    throw new Error("APPLICATION_PROMOTION_CHECKPOINT_INVALID");
  }
  return value as ApplicationPromotionCheckpoint;
}
