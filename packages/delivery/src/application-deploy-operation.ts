import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ApplicationActivationIdSchema } from "./application-activation";
import {
  ApplicationConfigurationIdSchema, ApplicationConfigurationWriteSchema,
} from "./application-configuration";
import { ApplicationIdSchema, ApplicationReleaseIdSchema } from "./application-release";

const closed = { additionalProperties: false } as const;
const sha256 = ApplicationReleaseIdSchema;
const nullableActivation = Type.Union([ApplicationActivationIdSchema, Type.Null()]);

export const ApplicationDeployWebRequestSchema = Type.Object({
  deployment_id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" }),
  release_id: sha256,
  expected_active_release_id: Type.String({ minLength: 1 }),
  expected_activation_id: Type.String({ minLength: 1 }),
  mutation_id: ApplicationActivationIdSchema,
}, closed);

export const ApplicationDeployRequestSchema = Type.Object({
  mutation_id: ApplicationActivationIdSchema,
  release_id: sha256,
  configuration_id: Type.Optional(ApplicationConfigurationIdSchema),
  configuration_write: Type.Optional(ApplicationConfigurationWriteSchema),
  expected_plan_sha256: Type.Optional(sha256),
  approved_migration_digest: Type.Optional(sha256),
  web: Type.Optional(ApplicationDeployWebRequestSchema),
}, closed);

export const ApplicationBackendReceiptSchema = Type.Object({
  schema: Type.Literal("supacloud.application-backend-receipt.v1"),
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  application_id: ApplicationIdSchema,
  environment_id: ApplicationIdSchema,
  release_id: sha256,
  manifest_sha256: sha256,
  mutation_id: ApplicationActivationIdSchema,
  plan_sha256: sha256,
  backup_id: Type.Union([Type.String(), Type.Null()]),
  before_ledger_digest: sha256,
  after_ledger_digest: sha256,
  applied_versions: Type.Array(Type.String({ pattern: "^\\d{1,20}$" }), { uniqueItems: true }),
  schema_reloaded: Type.Boolean(),
  postgrest_healthy: Type.Boolean(),
}, closed);

export const ApplicationDeployResultSchema = Type.Object({
  schema: Type.Literal("supacloud.application-deploy.v1"),
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  application_id: ApplicationIdSchema,
  environment_id: ApplicationIdSchema,
  mutation_id: ApplicationActivationIdSchema,
  release_id: sha256,
  configuration_id: ApplicationConfigurationIdSchema,
  activation_id: ApplicationActivationIdSchema,
  expected_activation_id: nullableActivation,
  plan_sha256: sha256,
  action: Type.Union([Type.Literal("activate"), Type.Literal("no-op")]),
  replayed: Type.Boolean(),
  execution_performed: Type.Boolean(),
  backend_receipt: ApplicationBackendReceiptSchema,
  web: Type.Optional(Type.Object({
    deployment_id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" }),
    release_id: sha256,
    activation_id: ApplicationActivationIdSchema,
    replayed: Type.Boolean(),
  }, closed)),
}, closed);

export type ApplicationDeployWebRequest = Static<typeof ApplicationDeployWebRequestSchema>;
export type ApplicationDeployRequest = Static<typeof ApplicationDeployRequestSchema>;
export type ApplicationBackendReceipt = Static<typeof ApplicationBackendReceiptSchema>;
export type ApplicationDeployResult = Static<typeof ApplicationDeployResultSchema>;

export function parseApplicationDeployResult(value: unknown): ApplicationDeployResult {
  if (!Value.Check(ApplicationDeployResultSchema, value)) {
    throw new Error("Invalid application deploy result");
  }
  return structuredClone(value);
}
