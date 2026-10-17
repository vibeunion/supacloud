import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { canonical, digest } from "./delivery-files";
import { ApplicationActivationIdSchema } from "./application-activation";
import {
  ApplicationConfigurationIdSchema, ApplicationConfigurationViewSchema, parseApplicationConfigurationView,
} from "./application-configuration";
import { ApplicationIdSchema, ApplicationReleaseIdSchema, applicationReleaseId } from "./application-release";

const closed = { additionalProperties: false } as const;
const projectRef = Type.String({ pattern: "^[a-z0-9-]{1,20}$" });
const sha256 = ApplicationReleaseIdSchema;
const nullableActivation = Type.Union([ApplicationActivationIdSchema, Type.Null()]);
const nullableDigest = Type.Union([sha256, Type.Null()]);
const observation = {
  activation_id: nullableActivation,
  receipt_confirmed: Type.Boolean(),
  ready: Type.Boolean(),
  smoke_verified: Type.Boolean(),
  evidence_sha256: nullableDigest,
  migration_ledger_digest: nullableDigest,
};
const blocker = ["SOURCE_NOT_ACTIVE", "SOURCE_RECEIPT_UNCONFIRMED", "SOURCE_NOT_READY",
  "SOURCE_SMOKE_UNVERIFIED", "TARGET_CONFIGURATION_MISSING", "TARGET_CONFIGURATION_MISMATCH",
  "MIGRATION_PENDING", "MIGRATION_CONFLICT", "OPERATOR_PROVISIONING_REQUIRED", "BACKUP_REQUIRED"] as const;

export const ApplicationPromotionPlanSchema = Type.Object({
  schema: Type.Literal("supacloud.application-promotion-plan.v1"),
  project_ref: projectRef,
  application_id: ApplicationIdSchema,
  environment_id: ApplicationIdSchema,
  manifest_sha256: sha256,
  plan_sha256: sha256,
  source: Type.Object({
    project_ref: projectRef,
    environment_id: ApplicationIdSchema,
    release_id: sha256,
    ...observation,
  }, closed),
  target: Type.Object({
    candidate_release_id: sha256,
    current_release_id: Type.Union([sha256, Type.Null()]),
    artifact_action: Type.Union([Type.Literal("materialize"), Type.Literal("reuse")]),
    configuration_id: Type.Union([ApplicationConfigurationIdSchema, Type.Null()]),
    configuration: Type.Union([ApplicationConfigurationViewSchema, Type.Null()]),
    ...observation,
  }, closed),
  migrations: Type.Object({
    ledger_digest: sha256,
    ledger_compatible: Type.Boolean(),
    project_migrations_applied: Type.Boolean(),
    pending_versions: Type.Array(Type.String({ pattern: "^\\d{1,20}$" }), { maxItems: 4096, uniqueItems: true }),
    operator_provisioning_required: Type.Boolean(),
  }, closed),
  backup: Type.Object({
    required: Type.Boolean(),
    confirmed: Type.Literal(false),
  }, closed),
  action: Type.Union([Type.Literal("promote"), Type.Literal("no-op"), Type.Literal("blocked")]),
  blockers: Type.Array(Type.Enum<Array<typeof blocker[number]>>([...blocker]), {
    maxItems: blocker.length, uniqueItems: true,
  }),
  steps: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 8, uniqueItems: true }),
  execution_performed: Type.Literal(false),
  data_recovery: Type.Literal("separate-required"),
}, closed);

export type ApplicationPromotionPlan = Static<typeof ApplicationPromotionPlanSchema>;
export type ApplicationPromotionPlanContent = Omit<ApplicationPromotionPlan, "plan_sha256">;

export function applicationPromotionPlanDigest(value: ApplicationPromotionPlanContent): string {
  return digest(canonical(value));
}

export function applicationPromotionAction(value: ApplicationPromotionPlanContent): ApplicationPromotionPlan["action"] {
  if (value.blockers.length > 0) return "blocked";
  return value.target.artifact_action === "reuse"
    && value.target.current_release_id === value.target.candidate_release_id
    && value.target.configuration !== null
    && value.target.activation_id !== null
    && value.target.receipt_confirmed && value.target.ready && value.target.smoke_verified
    && value.migrations.project_migrations_applied
    && !value.migrations.operator_provisioning_required
    && (!value.backup.required || value.backup.confirmed)
    ? "no-op" : "promote";
}

export function applicationPromotionSteps(value: ApplicationPromotionPlanContent): string[] {
  if (value.action === "no-op") return [];
  return [
    ...(value.blockers.some(code => code.startsWith("SOURCE_")) ? ["verify-source"] : []),
    ...(value.blockers.some(code => code.startsWith("TARGET_CONFIGURATION_")) ? ["bind-target-configuration"] : []),
    ...(value.blockers.includes("MIGRATION_CONFLICT") ? ["resolve-migration-conflicts"] : []),
    ...(!value.backup.required || value.backup.confirmed ? [] : ["backup"]),
    ...(value.migrations.project_migrations_applied ? [] : ["review-and-apply-migrations"]),
    ...(value.migrations.operator_provisioning_required ? ["verify-operator-provisioning"] : []),
    ...(value.action === "promote" ? [
      ...(value.target.artifact_action === "materialize" ? ["transfer"] : []),
      "activate-with-cas", "verify-runtime-and-smoke",
    ] : []),
  ];
}

export function parseApplicationPromotionPlan(value: unknown): ApplicationPromotionPlan {
  if (!Value.Check(ApplicationPromotionPlanSchema, value)) throw new Error("Invalid application promotion plan");
  const { plan_sha256: _planSha256, ...content } = value;
  if (value.migrations.project_migrations_applied
    && (!value.migrations.ledger_compatible || value.migrations.pending_versions.length > 0)
    || !value.source.activation_id && (value.source.ready || value.source.receipt_confirmed || value.source.smoke_verified)
    || !value.target.activation_id && (value.target.ready || value.target.receipt_confirmed || value.target.smoke_verified)
    || !value.blockers.length && (!value.source.ready || !value.source.receipt_confirmed || !value.source.smoke_verified
      || !value.source.activation_id || !value.target.configuration || !value.migrations.ledger_compatible)) {
    throw new Error("Invalid application promotion prerequisites");
  }
  if (value.backup.required !== !value.migrations.project_migrations_applied
    || [value.source, value.target].some(observation =>
      observation.smoke_verified && (observation.evidence_sha256 === null || observation.migration_ledger_digest === null))
    || value.target.smoke_verified && value.target.migration_ledger_digest !== value.migrations.ledger_digest) {
    throw new Error("Invalid application promotion migration binding");
  }
  if (value.source.release_id !== applicationReleaseId(
    value.source.project_ref, value.application_id, value.manifest_sha256,
  ) || value.target.candidate_release_id !== applicationReleaseId(
    value.project_ref, value.application_id, value.manifest_sha256,
  ) || value.action !== applicationPromotionAction(content)
    || canonical(value.steps) !== canonical(applicationPromotionSteps(content))
    || value.plan_sha256 !== applicationPromotionPlanDigest(content)
    || (value.target.configuration !== null && (() => {
      const configuration = parseApplicationConfigurationView(value.target.configuration);
      return configuration.project_ref !== value.project_ref
        || configuration.application_id !== value.application_id
        || configuration.environment_id !== value.environment_id
        || configuration.configuration_id !== value.target.configuration_id;
    })())) {
    throw new Error("Invalid application promotion plan identity");
  }
  return structuredClone(value);
}
