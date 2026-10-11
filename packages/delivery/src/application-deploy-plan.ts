import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ApplicationIdSchema, ApplicationReleaseIdSchema } from "./application-release";
import { ApplicationActivationIdSchema } from "./application-activation";
import { ApplicationConfigurationIdSchema } from "./application-configuration";

const CandidateSchema = Type.Object({
  release_id: ApplicationReleaseIdSchema,
  configuration_id: ApplicationConfigurationIdSchema,
}, { additionalProperties: false });

export const ApplicationDeployPlanSchema = Type.Object({
  schema: Type.Literal("supacloud.application-deploy-plan.v1"),
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  application_id: ApplicationIdSchema,
  environment_id: ApplicationIdSchema,
  candidate: CandidateSchema,
  current: Type.Union([Type.Object({
    ...CandidateSchema.properties, activation_id: ApplicationActivationIdSchema,
  }, { additionalProperties: false }), Type.Null()]),
  expected_activation_id: Type.Union([ApplicationActivationIdSchema, Type.Null()]),
  action: Type.Union([Type.Literal("activate"), Type.Literal("no-op")]),
  changes: Type.Object({
    release: Type.Boolean(), configuration: Type.Boolean(),
    targets: Type.Object({
      added: Type.Array(Type.String()), removed: Type.Array(Type.String()), changed: Type.Array(Type.String()),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  migrations: Type.Object({
    ledger_digest: ApplicationReleaseIdSchema,
    ledger_compatible: Type.Boolean(),
    project_migrations_applied: Type.Boolean(),
    operator_provisioning: Type.Union([
      Type.Literal("separate-verification-required"), Type.Literal("not-declared"),
    ]),
  }, { additionalProperties: false }),
  compatibility: Type.Literal("not-proven"),
  execution_performed: Type.Literal(false),
}, { additionalProperties: false });

export type ApplicationDeployPlan = Static<typeof ApplicationDeployPlanSchema>;

export function parseApplicationDeployPlan(value: unknown): ApplicationDeployPlan {
  if (!Value.Check(ApplicationDeployPlanSchema, value)
    || value.expected_activation_id !== (value.current?.activation_id ?? null)
    || value.changes.release !== (value.current?.release_id !== value.candidate.release_id)
    || value.changes.configuration !== (value.current?.configuration_id !== value.candidate.configuration_id)
    || (value.migrations.project_migrations_applied && !value.migrations.ledger_compatible)) {
    throw new Error("Invalid application deploy plan");
  }
  const noOp = value.current !== null && !value.changes.release && !value.changes.configuration
    && Object.values(value.changes.targets).every(names => names.length === 0)
    && value.migrations.ledger_compatible && value.migrations.project_migrations_applied
    && value.migrations.operator_provisioning === "not-declared";
  if ((value.action === "no-op") !== noOp) throw new Error("Invalid application deploy plan action");
  return value;
}
