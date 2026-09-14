import { SupaCloudApiError } from "./api-error.js";
import { queueJsonSnapshot } from "./queue-rpc.js";
import { isWorkflowTimestamp } from "./workflow-timestamp.js";
import type { SupaCloudArtifact } from "./artifacts.js";

export class SupaCloudArtifactReadError extends SupaCloudApiError {
  readonly mutationMayHaveApplied = false;
  constructor(input = false) {
    super("Artifact read could not be validated", 0, {
      code: input ? "ARTIFACT_READ_INPUT_INVALID" : "ARTIFACT_READ_INVALID",
      mutation_may_have_applied: false,
    });
    this.name = "SupaCloudArtifactReadError";
  }
}

function uuid(value: unknown): string {
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error();
  return value;
}
export function captureArtifactId(value: unknown): string {
  try {
    if (typeof value !== "string") throw new Error();
    return uuid(value.toLowerCase());
  } catch { throw new SupaCloudArtifactReadError(true); }
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}
export function artifactText(value: unknown, min = 0, max = 1048576): string {
  if (typeof value !== "string") throw new Error();
  let count = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (++count > max || point === undefined || point === 0
      || (point >= 0xd800 && point <= 0xdfff)) throw new Error();
  }
  if (count < min) throw new Error();
  return value;
}
export function artifactKey(value: unknown): string {
  const result = artifactText(value, 1, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(result)) throw new Error();
  return result;
}
function timestamp(value: unknown): string {
  if (!isWorkflowTimestamp(value)) throw new Error();
  return value;
}
export function artifactTimestampMicros(value: string): bigint {
  timestamp(value);
  const fraction = /\.(\d{1,6})/.exec(value)?.[1] ?? "";
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3));
}
export function artifactSize(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)
    || BigInt(value) > 9223372036854775807n) throw new Error();
  return value;
}
export function artifactPath(value: unknown): string {
  const result = artifactText(value, 1);
  if (result.startsWith("/") || result.includes("\\") || /(^|\/)\.\.?(\/|$)/.test(result)) throw new Error();
  return result;
}

export function decodeArtifactRead(value: unknown, artifactId: string, allowIdempotent = false): SupaCloudArtifact | null {
  if (value === null) return null;
  try {
    const data = record(queueJsonSnapshot(value));
    if (uuid(data.artifactId) !== artifactId || typeof data.idempotent !== "boolean"
      || (!allowIdempotent && data.idempotent)) throw new Error();
    const sizeBytes = artifactSize(data.sizeBytes);
    const sha256 = data.sha256;
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error();
    const objectPath = artifactPath(data.objectPath);
    const createdAt = timestamp(data.createdAt);
    const retentionUntil = data.retentionUntil === null ? null : timestamp(data.retentionUntil);
    if (retentionUntil !== null && artifactTimestampMicros(retentionUntil) < artifactTimestampMicros(createdAt)) throw new Error();
    if (!Array.isArray(data.parents)) throw new Error();
    const seen = new Set<string>();
    const parents = data.parents.map(value => {
      const parent = record(value);
      const parentId = uuid(parent.artifactId), relationType = artifactKey(parent.relationType);
      const identity = `${parentId}:${relationType}`;
      if (parentId === artifactId || seen.has(identity)) throw new Error();
      seen.add(identity);
      return {
        artifactId: parentId, relationType, metadata: record(parent.metadata), createdAt: timestamp(parent.createdAt),
      };
    });
    return {
      artifactId, bucketId: artifactText(data.bucketId, 1), objectPath, objectVersion: artifactText(data.objectVersion),
      artifactType: artifactKey(data.artifactType), sha256, sizeBytes, mimeType: artifactText(data.mimeType, 1, 255),
      metadata: record(data.metadata), retentionUntil,
      createdBy: data.createdBy === null ? null : uuid(data.createdBy),
      createdAt, idempotent: data.idempotent, parents,
    };
  } catch { throw new SupaCloudArtifactReadError(); }
}
