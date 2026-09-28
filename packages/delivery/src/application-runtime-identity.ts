import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ApplicationIdSchema, ApplicationReleaseIdSchema } from "./application-release";

export const APPLICATION_RUNTIME_PROBE_PATH = "/.well-known/supacloud/runtime";
export const ApplicationRuntimeIdentitySchema = Type.Object({
  schema: Type.Literal("supacloud.application-runtime.v1"),
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  application_id: ApplicationIdSchema,
  environment_id: ApplicationIdSchema,
  release_id: ApplicationReleaseIdSchema,
  activation_id: Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$" }),
  target: Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }),
  object_id: ApplicationReleaseIdSchema,
  kind: Type.Union([Type.Literal("http"), Type.Literal("worker")]),
  pid: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });

export type ApplicationRuntimeIdentity = Static<typeof ApplicationRuntimeIdentitySchema>;

export function parseApplicationRuntimeIdentity(value: unknown): ApplicationRuntimeIdentity {
  if (!Value.Check(ApplicationRuntimeIdentitySchema, value)) throw new Error("Invalid application runtime identity");
  return value;
}

export const ApplicationReadinessReportSchema = Type.Object({
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  application_id: ApplicationIdSchema,
  environment_id: ApplicationIdSchema,
  release_id: ApplicationReleaseIdSchema,
  activation_id: ApplicationRuntimeIdentitySchema.properties.activation_id,
  ready: Type.Boolean(),
  targets: Type.Array(Type.Object({
    target: ApplicationRuntimeIdentitySchema.properties.target,
    kind: ApplicationRuntimeIdentitySchema.properties.kind,
    unit: Type.String({ minLength: 1, maxLength: 255 }),
    pid: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    invocation_id: Type.Union([Type.String({ pattern: "^[a-f0-9]{32}$" }), Type.Null()]),
    ready: Type.Boolean(),
    code: Type.Union([
      Type.Literal("READY"),
      Type.Literal("PROCESS_NOT_RUNNING"),
      Type.Literal("PROCESS_CHANGED"),
      Type.Literal("SUPERVISOR_UNAVAILABLE"),
      Type.Literal("HTTP_NOT_READY"),
      Type.Literal("IDENTITY_MISMATCH"),
      Type.Literal("WORKER_NOT_READY"),
      Type.Literal("PROBE_UNAVAILABLE"),
    ]),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });

export type ApplicationReadinessReport = Static<typeof ApplicationReadinessReportSchema>;
export type ApplicationReadinessTarget = ApplicationReadinessReport["targets"][number];

export function parseApplicationReadinessReport(value: unknown): ApplicationReadinessReport {
  if (!Value.Check(ApplicationReadinessReportSchema, value)
    || value.ready !== value.targets.every(target => target.ready)
    || new Set(value.targets.map(target => target.target)).size !== value.targets.length
    || value.targets.some(target =>
      target.unit !== `supacloud-application-${value.project_ref}-${value.activation_id}-${target.target}.service`
      || target.ready !== (target.code === "READY")
      || (target.ready && (target.pid === 0 || target.invocation_id === null)))) {
    throw new Error("Invalid application readiness report");
  }
  return value;
}
