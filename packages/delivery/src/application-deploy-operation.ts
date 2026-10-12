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

export function parseApplicationDeployResult(value: unknown, expected?: {
  project_ref: string;
  application_id: string;
  environment_id: string;
  request: ApplicationDeployRequest;
}): ApplicationDeployResult {
  if (!Value.Check(ApplicationDeployResultSchema, value)) {
    throw new Error("Invalid application deploy result");
  }
  const backend = value.backend_receipt;
  const bindingKeys = [
    "project_ref", "application_id", "environment_id", "release_id", "mutation_id", "plan_sha256",
  ] as const;
  if (bindingKeys.some(key => backend[key] !== value[key]) || !backend.postgrest_healthy
    || (backend.applied_versions.length > 0 && (!backend.schema_reloaded || !backend.backup_id))) {
    throw new Error("Invalid application deploy receipt binding");
  }
  if (expected) {
    const { request } = expected;
    const configurationId = request.configuration_id ?? request.configuration_write?.configuration_id;
    if (value.project_ref !== expected.project_ref || value.application_id !== expected.application_id
      || value.environment_id !== expected.environment_id || value.release_id !== request.release_id
      || value.mutation_id !== request.mutation_id
      || (configurationId !== undefined && value.configuration_id !== configurationId)
      || (request.configuration_write !== undefined
        && value.configuration_id !== request.configuration_write.configuration_id)
      || (request.expected_plan_sha256 !== undefined && value.plan_sha256 !== request.expected_plan_sha256)
      || Boolean(value.web) !== Boolean(request.web)
      || (request.web !== undefined && (value.web?.deployment_id !== request.web.deployment_id
        || value.web.release_id !== request.web.release_id))) {
      throw new Error("Application deploy receipt does not match request");
    }
  }
  return structuredClone(value);
}
