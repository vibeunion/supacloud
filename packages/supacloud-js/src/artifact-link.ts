import { SupaCloudApiError } from "./api-error.js";
import { artifactKey, artifactText, captureArtifactId, decodeArtifactRead } from "./artifact-read.js";
import { workflowRequestFields } from "./workflow-attempt.js";
import { workflowJsonEqual, workflowJsonObject } from "./workflow-json.js";
import type { SupaCloudArtifact, SupaCloudArtifactLinkRequest } from "./artifacts.js";

export class SupaCloudArtifactLinkError extends SupaCloudApiError {
  constructor(readonly mutationMayHaveApplied = false) {
    super("Artifact link could not be validated", 0, {
      code: mutationMayHaveApplied ? "ARTIFACT_LINK_UNCONFIRMED" : "ARTIFACT_LINK_INPUT_INVALID",
      mutation_may_have_applied: mutationMayHaveApplied,
    });
    this.name = "SupaCloudArtifactLinkError";
  }
}

export function captureArtifactLink(value: unknown): Required<SupaCloudArtifactLinkRequest> {
  try {
    const fields = workflowRequestFields(value, ["parentArtifactId", "childArtifactId", "relationType", "metadata"]);
    const parentArtifactId = captureArtifactId(fields.parentArtifactId);
    const childArtifactId = captureArtifactId(fields.childArtifactId);
    if (parentArtifactId === childArtifactId) throw new Error();
    return {
      parentArtifactId, childArtifactId,
      relationType: artifactKey(artifactText(fields.relationType).replace(/^ +| +$/g, "")),
      metadata: workflowJsonObject(fields.metadata),
    };
  } catch { throw new SupaCloudArtifactLinkError(); }
}

export function decodeArtifactLink(value: unknown, request: Required<SupaCloudArtifactLinkRequest>): SupaCloudArtifact {
  try {
    const receipt = decodeArtifactRead(value, request.childArtifactId, true);
    const edge = receipt?.parents.find(parent =>
      parent.artifactId === request.parentArtifactId && parent.relationType === request.relationType);
    if (!receipt || !edge || !workflowJsonEqual(edge.metadata, request.metadata)) throw new Error();
    return receipt;
  } catch { throw new SupaCloudArtifactLinkError(true); }
}
