import {
  parseApplicationReleaseTransferPlan, parseApplicationReleaseTransferResult,
  type ApplicationReleaseTransferPlan,
} from "@supacloud/delivery";
import type { HttpTransport } from "../transports/http";
import { releaseControlFailure, releaseControlMutationFailure, releaseControlSuccess } from "./release-control-response";

export async function applicationReleaseTransfer(
  http: HttpTransport,
  input: {
    action: "get_release_transfer_plan" | "transfer_release";
    ref: string;
    id: string;
    sourceRef: string;
    sourceReleaseId: string;
  },
  project: string,
) {
  const operation = `applications.${input.action}`;
  const identity = {
    project_ref: input.ref, application_id: input.id,
    source_ref: input.sourceRef, source_release_id: input.sourceReleaseId,
  };
  const path = `/v1/projects/${project}/applications/${encodeURIComponent(input.id)}`;
  const query = new URLSearchParams({ source_ref: input.sourceRef, source_release_id: input.sourceReleaseId });
  const response = await http.get(`${path}/release-transfer-plan?${query}`,
    { maxJsonBytes: 65_536, responseTimeoutMs: 30_000 });
  if (!response.ok) return releaseControlFailure(operation, "HTTP_ERROR",
    response.transportError ? null : response.status, identity);
  let plan: ApplicationReleaseTransferPlan;
  try {
    if (response.status !== 200) throw new Error();
    plan = parseApplicationReleaseTransferPlan(response.data);
    if (plan.project_ref !== input.ref || plan.application_id !== input.id
      || plan.source.project_ref !== input.sourceRef || plan.source.release_id !== input.sourceReleaseId) throw new Error();
  } catch {
    return releaseControlFailure(operation, "INVALID_RESPONSE", response.status, identity);
  }
  if (input.action === "get_release_transfer_plan") return releaseControlSuccess(operation, { ...identity, plan });
  const safeIdentity = {
    ...identity, release_id: plan.candidate_release_id, manifest_sha256: plan.source.manifest_sha256,
  };
  if (plan.action === "no-op") return releaseControlSuccess(operation, {
    ...safeIdentity, no_op: true, execution_performed: false, activation_performed: false, plan,
  });
  const result = await http.postReleaseMutation(`${path}/release-transfers`, {
    source_ref: input.sourceRef, source_release_id: input.sourceReleaseId,
    expected_manifest_sha256: plan.source.manifest_sha256,
  }, { timeoutMs: 120_000 });
  if (!result.ok) return releaseControlMutationFailure(operation, result, safeIdentity);
  try {
    if (result.status !== 200) throw new Error();
    const receipt = parseApplicationReleaseTransferResult(result.data);
    if (receipt.project_ref !== input.ref || receipt.application_id !== input.id
      || receipt.source.project_ref !== input.sourceRef || receipt.source.release_id !== input.sourceReleaseId
      || receipt.candidate_release_id !== plan.candidate_release_id
      || receipt.source.manifest_sha256 !== plan.source.manifest_sha256) throw new Error();
    return releaseControlSuccess(operation, { ...safeIdentity, no_op: false, transfer: receipt });
  } catch {
    return releaseControlFailure(operation, "OUTCOME_UNKNOWN", result.status, safeIdentity);
  }
}
