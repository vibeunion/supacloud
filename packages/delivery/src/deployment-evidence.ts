import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ApplicationConfigurationIdSchema } from "./application-configuration";
import { ApplicationIdSchema, ApplicationReleaseIdSchema } from "./application-release";

const closed = { additionalProperties: false } as const;
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const isoDate = Type.String({ minLength: 20, maxLength: 40 });
const status = Type.Union([
  Type.Literal("confirmed"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
]);
const evidenceStatus = Type.Union([
  Type.Literal("confirmed"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
  Type.Literal("incomplete"),
]);

export const DEPLOYMENT_EVIDENCE_SCHEMA = "supacloud.deployment-evidence.v1";

export const DatabaseProviderSchema = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_.-]*$" }),
  version: Type.String({ minLength: 1, maxLength: 64 }),
  topology: Type.Union([Type.Literal("single-node"), Type.Literal("distributed")]),
  migration: Type.Object({
    status,
    inventory_sha256: Type.Union([sha256, Type.Null()]),
    compatibility: Type.Union([
      Type.Literal("verified"),
      Type.Literal("not-proven"),
      Type.Literal("failed"),
    ]),
  }, closed),
  backup: Type.Object({
    status,
    latest_success_at: Type.Union([isoDate, Type.Null()]),
    freshness_seconds: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  }, closed),
  recovery: Type.Object({
    status,
    drill_id: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    rpo_seconds: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    rto_seconds: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  }, closed),
}, closed);

export type DatabaseProviderEvidence = Static<typeof DatabaseProviderSchema>;

const componentName = Type.Union([
  Type.Literal("management-api"),
  Type.Literal("web-console"),
  Type.Literal("edge-runtime"),
  Type.Literal("worker"),
  Type.Literal("postgres"),
  Type.Literal("postgrest"),
  Type.Literal("gotrue"),
  Type.Literal("storage"),
  Type.Literal("realtime"),
]);

export const DeploymentComponentEvidenceSchema = Type.Object({
  name: componentName,
  version: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  status,
  health_check: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  checked_at: Type.Union([isoDate, Type.Null()]),
}, closed);

export type DeploymentComponentEvidence = Static<typeof DeploymentComponentEvidenceSchema>;

export const DeploymentEvidenceSchema = Type.Object({
  schema: Type.Literal(DEPLOYMENT_EVIDENCE_SCHEMA),
  status: evidenceStatus,
  recorded_at: isoDate,
  scope: Type.Object({
    project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
    application_id: ApplicationIdSchema,
    environment_id: ApplicationIdSchema,
  }, closed),
  source: Type.Object({
    commit_sha: Type.Union([Type.String({ pattern: "^[0-9a-f]{7,64}$" }), Type.Null()]),
    manifest_sha256: sha256,
    contract_schema: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    environment_binding_version: Type.Union([sha256, Type.Null()]),
  }, closed),
  database: DatabaseProviderSchema,
  components: Type.Array(DeploymentComponentEvidenceSchema, { minItems: 1, maxItems: 32 }),
  activation: Type.Object({
    release_id: ApplicationReleaseIdSchema,
    configuration_id: ApplicationConfigurationIdSchema,
    activation_id: ApplicationConfigurationIdSchema,
  }, closed),
  health: Type.Object({
    status,
    checked_at: Type.Union([isoDate, Type.Null()]),
    authenticated_smoke: status,
  }, closed),
  rollback: Type.Object({
    release_id: Type.Union([ApplicationReleaseIdSchema, Type.Null()]),
    configuration_id: Type.Union([ApplicationConfigurationIdSchema, Type.Null()]),
    status: Type.Union([Type.Literal("ready"), Type.Literal("not-ready"), Type.Literal("unknown")]),
    result: Type.Union([status, Type.Null()]),
  }, closed),
  notes: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
}, closed);

export type DeploymentEvidence = Static<typeof DeploymentEvidenceSchema>;
export type DeploymentEvidenceStatus = DeploymentEvidence["status"];

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function statusValues(evidence: DeploymentEvidence): readonly string[] {
  return [
    evidence.database.migration.status,
    evidence.database.backup.status,
    evidence.database.recovery.status,
    ...evidence.components.map(component => component.status),
    evidence.health.status,
    evidence.health.authenticated_smoke,
    ...(evidence.rollback.result === null ? [] : [evidence.rollback.result]),
  ];
}

/**
 * Derive the overall state from observed evidence. Unknown observations never
 * become success, and missing required operational proof remains incomplete.
 */
export function deriveDeploymentEvidenceStatus(
  evidence: Omit<DeploymentEvidence, "status">,
): DeploymentEvidenceStatus {
  const values = statusValues({ ...evidence, status: "incomplete" });
  if (values.includes("failed")) return "failed";
  if (values.includes("unknown")) return "unknown";
  if (evidence.database.migration.compatibility !== "verified"
    || evidence.rollback.status !== "ready"
    || evidence.components.some(component => component.health_check === null || component.checked_at === null)
    || evidence.health.checked_at === null
    || evidence.health.authenticated_smoke !== "confirmed"
    || evidence.database.recovery.status !== "confirmed"
    || evidence.database.recovery.drill_id === null
    || evidence.database.recovery.rpo_seconds === null
    || evidence.database.recovery.rto_seconds === null) {
    return "incomplete";
  }
  return "confirmed";
}

export function parseDeploymentEvidence(value: unknown): DeploymentEvidence {
  if (!Value.Check(DeploymentEvidenceSchema, value)
    || !isIsoDate(value.recorded_at)
    || (value.health.checked_at !== null && !isIsoDate(value.health.checked_at))
    || (value.database.backup.latest_success_at !== null && !isIsoDate(value.database.backup.latest_success_at))
    || value.components.some(component =>
      component.checked_at !== null && !isIsoDate(component.checked_at))
    || new Set(value.components.map(component => component.name)).size !== value.components.length
    || deriveDeploymentEvidenceStatus(value) !== value.status) {
    throw new Error("Invalid deployment evidence.");
  }
  return structuredClone(value);
}

export function formatDeploymentEvidence(evidence: DeploymentEvidence): string {
  return [
    `DEPLOYMENT ${evidence.scope.project_ref}/${evidence.scope.application_id}/${evidence.scope.environment_id}`,
    `  status:     ${evidence.status}`,
    `  manifest:   ${evidence.source.manifest_sha256.slice(0, 12)}`,
    `  database:   ${evidence.database.provider} ${evidence.database.version} (${evidence.database.topology})`,
    `  activation: ${evidence.activation.activation_id}`,
    `  rollback:   ${evidence.rollback.status}`,
    `  health:     ${evidence.health.status}; smoke=${evidence.health.authenticated_smoke}`,
  ].join("\n");
}
