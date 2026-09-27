import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { canonical, digest } from "./delivery-files";

export const ApplicationIdSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" });
export const ApplicationReleaseIdSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const ApplicationReleaseRecordSchema = Type.Object({
  schema: Type.Literal("supacloud.application-release.v1"),
  project_ref: Type.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" }),
  application_id: ApplicationIdSchema,
  release_id: ApplicationReleaseIdSchema,
  manifest_sha256: ApplicationReleaseIdSchema,
  created_at: Type.String(),
  targets: Type.Array(Type.Object({
    name: Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }),
    object_id: ApplicationReleaseIdSchema,
    kind: Type.Union([Type.Literal("http"), Type.Literal("worker")]),
    entrypoint: Type.Literal("bundle/index.js"),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });

export type ApplicationReleaseRecord = Static<typeof ApplicationReleaseRecordSchema>;
export interface ApplicationReleaseInventory {
  project_ref: string;
  application_id: string;
  releases: ApplicationReleaseRecord[];
  next_cursor: string | null;
}

export function applicationReleaseId(projectRef: string, applicationId: string, manifestSha256: string): string {
  return digest(canonical({
    schema: "supacloud.application-release.v1",
    project_ref: projectRef, application_id: applicationId, manifest_sha256: manifestSha256,
  }));
}

export function parseApplicationReleaseRecord(candidate: unknown): ApplicationReleaseRecord {
  if (!Value.Check(ApplicationReleaseRecordSchema, candidate)
    || applicationReleaseId(candidate.project_ref, candidate.application_id, candidate.manifest_sha256) !== candidate.release_id
    || !Number.isFinite(Date.parse(candidate.created_at))
    || new Date(candidate.created_at).toISOString() !== candidate.created_at
    || new Set(candidate.targets.map(target => target.name)).size !== candidate.targets.length) {
    throw new Error("Invalid application release record.");
  }
  return candidate;
}
