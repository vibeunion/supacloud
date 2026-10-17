import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  ApplicationIdSchema, ApplicationReleaseIdSchema, ApplicationReleaseRecordSchema,
  applicationReleaseId, parseApplicationReleaseRecord,
} from "./application-release";

const projectRef = Type.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" });
const source = Type.Object({
  project_ref: projectRef,
  release_id: ApplicationReleaseIdSchema,
  manifest_sha256: ApplicationReleaseIdSchema,
}, { additionalProperties: false });
const identity = {
  project_ref: projectRef, application_id: ApplicationIdSchema, source,
  candidate_release_id: ApplicationReleaseIdSchema,
};

export const ApplicationReleaseTransferPlanSchema = Type.Object({
  schema: Type.Literal("supacloud.application-release-transfer-plan.v1"),
  ...identity,
  action: Type.Union([Type.Literal("materialize"), Type.Literal("no-op")]),
  execution_performed: Type.Literal(false),
}, { additionalProperties: false });

export const ApplicationReleaseTransferResultSchema = Type.Object({
  schema: Type.Literal("supacloud.application-release-transfer-result.v1"),
  ...identity,
  release: ApplicationReleaseRecordSchema,
  activation_performed: Type.Literal(false),
}, { additionalProperties: false });

export type ApplicationReleaseTransferPlan = Static<typeof ApplicationReleaseTransferPlanSchema>;
export type ApplicationReleaseTransferResult = Static<typeof ApplicationReleaseTransferResultSchema>;

function assertIdentity(value: ApplicationReleaseTransferPlan | ApplicationReleaseTransferResult): void {
  if (value.source.release_id !== applicationReleaseId(value.source.project_ref, value.application_id, value.source.manifest_sha256)
    || value.candidate_release_id !== applicationReleaseId(value.project_ref, value.application_id, value.source.manifest_sha256)) {
    throw new Error("Invalid application release transfer identity");
  }
}

export function parseApplicationReleaseTransferPlan(candidate: unknown): ApplicationReleaseTransferPlan {
  if (!Value.Check(ApplicationReleaseTransferPlanSchema, candidate)) throw new Error("Invalid application release transfer plan");
  assertIdentity(candidate);
  return candidate;
}

export function parseApplicationReleaseTransferResult(candidate: unknown): ApplicationReleaseTransferResult {
  if (!Value.Check(ApplicationReleaseTransferResultSchema, candidate)) throw new Error("Invalid application release transfer result");
  assertIdentity(candidate);
  const release = parseApplicationReleaseRecord(candidate.release);
  if (release.project_ref !== candidate.project_ref || release.application_id !== candidate.application_id
    || release.release_id !== candidate.candidate_release_id || release.manifest_sha256 !== candidate.source.manifest_sha256) {
    throw new Error("Invalid application release transfer result");
  }
  return candidate;
}
