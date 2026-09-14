import { SupaCloudApiError } from "./api-error.js";
import {
  captureArtifactId, artifactText, artifactKey, artifactPath, artifactSize,
  artifactTimestampMicros, decodeArtifactRead,
} from "./artifact-read.js";
import { workflowRequestFields } from "./workflow-attempt.js";
import { workflowJsonEqual, workflowJsonObject } from "./workflow-json.js";
import type { SupaCloudArtifact, SupaCloudArtifactRegisterRequest } from "./artifacts.js";

export class SupaCloudArtifactRegisterError extends SupaCloudApiError {
  constructor(readonly mutationMayHaveApplied = false) {
    super("Artifact registration could not be validated", 0, {
      code: mutationMayHaveApplied ? "ARTIFACT_REGISTER_UNCONFIRMED" : "ARTIFACT_REGISTER_INPUT_INVALID",
      mutation_may_have_applied: mutationMayHaveApplied,
    });
    this.name = "SupaCloudArtifactRegisterError";
  }
}
type CapturedRegister = Omit<Required<SupaCloudArtifactRegisterRequest>, "sizeBytes" | "retentionUntil" | "createdBy">
  & { sizeBytes: string; retentionUntil: string | null; createdBy: string | null };
function trim(value: unknown): string {
  return artifactText(value).replace(/^ +| +$/g, "");
}

export function captureArtifactRegister(value: unknown): CapturedRegister {
  try {
    const fields = workflowRequestFields(value, [
      "artifactId", "bucketId", "objectPath", "artifactType", "sha256", "sizeBytes",
      "mimeType", "metadata", "retentionUntil", "createdBy",
    ]);
    let size = fields.sizeBytes;
    if (typeof size === "number") {
      if (!Number.isSafeInteger(size) || size < 0) throw new Error();
      size = String(size);
    }
    const sha256 = trim(fields.sha256).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error();
    const retentionUntil = fields.retentionUntil === undefined ? null : artifactText(fields.retentionUntil, 1, 40);
    if (retentionUntil !== null) artifactTimestampMicros(retentionUntil);
    return {
      artifactId: captureArtifactId(fields.artifactId),
      bucketId: artifactText(trim(fields.bucketId), 1),
      objectPath: artifactPath(trim(fields.objectPath)),
      artifactType: artifactKey(trim(fields.artifactType)), sha256, sizeBytes: artifactSize(size),
      mimeType: artifactText(trim(fields.mimeType).toLowerCase(), 1, 255),
      metadata: workflowJsonObject(fields.metadata), retentionUntil,
      createdBy: fields.createdBy === undefined ? null : captureArtifactId(fields.createdBy),
    };
  } catch { throw new SupaCloudArtifactRegisterError(); }
}

export function decodeArtifactRegister(value: unknown, request: CapturedRegister): SupaCloudArtifact {
  try {
    const receipt = decodeArtifactRead(value, request.artifactId, true);
    if (!receipt || receipt.bucketId !== request.bucketId || receipt.objectPath !== request.objectPath
      || receipt.artifactType !== request.artifactType || receipt.sha256 !== request.sha256
      || receipt.sizeBytes !== request.sizeBytes || receipt.mimeType !== request.mimeType
      || receipt.createdBy !== request.createdBy || !workflowJsonEqual(receipt.metadata, request.metadata)) throw new Error();
    if (request.retentionUntil === null ? receipt.retentionUntil !== null
      : receipt.retentionUntil === null
        || artifactTimestampMicros(receipt.retentionUntil) !== artifactTimestampMicros(request.retentionUntil)) throw new Error();
    if (!receipt.idempotent && receipt.parents.length !== 0) throw new Error();
    return receipt;
  } catch { throw new SupaCloudArtifactRegisterError(true); }
}
