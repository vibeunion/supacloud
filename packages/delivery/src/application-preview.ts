import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ApplicationConfigurationIdSchema } from "./application-configuration";
import { ApplicationActivationIdSchema } from "./application-activation";
import { ApplicationIdSchema, ApplicationReleaseIdSchema } from "./application-release";

const phaseStatus = Type.Union([
  Type.Literal("pending"), Type.Literal("ready"), Type.Literal("failed"), Type.Literal("cleaned"),
]);
const closed = { additionalProperties: false } as const;

export const ApplicationPreviewReceiptSchema = Type.Object({
  schema: Type.Literal("supacloud.application-preview.v1"),
  preview_id: Type.String({ pattern: "^[a-f0-9-]{8,64}$" }),
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  application_id: ApplicationIdSchema,
  environment_id: ApplicationIdSchema,
  release_id: ApplicationReleaseIdSchema,
  expires_at: Type.Optional(Type.Union([Type.String({
    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$", maxLength: 24,
  }), Type.Null()])),
  status: Type.Union([
    Type.Literal("planned"), Type.Literal("provisioning"), Type.Literal("ready"),
    Type.Literal("failed"), Type.Literal("cleaned"),
  ]),
  resources: Type.Object({
    build_artifact: Type.Object({ status: phaseStatus, release_id: ApplicationReleaseIdSchema }, closed),
    database_branch: Type.Object({
      status: phaseStatus, branch_ref: Type.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" }),
      data_mode: Type.Union([Type.Literal("schema_only"), Type.Literal("full_clone")]),
    }, closed),
    queue_namespace: Type.Object({
      status: phaseStatus, namespace: Type.String({ minLength: 1, maxLength: 128 }),
    }, closed),
    storage_namespace: Type.Object({
      status: phaseStatus, namespace: Type.String({ minLength: 1, maxLength: 128 }),
    }, closed),
    test_secret: Type.Object({
      status: phaseStatus, name: Type.String({ minLength: 1, maxLength: 128 }), value_issued: Type.Literal(false),
    }, closed),
    configuration_revision: Type.Object({
      status: phaseStatus, configuration_id: Type.Union([ApplicationConfigurationIdSchema, Type.Null()]),
    }, closed),
    application_activation: Type.Object({
      status: phaseStatus, activation_id: Type.Union([ApplicationActivationIdSchema, Type.Null()]),
    }, closed),
    smoke_test: Type.Object({
      status: phaseStatus,
      checks: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
      passed: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
      failed: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
    }, closed),
  }, closed),
  cleanup: Type.Object({
    required: Type.Boolean(), completed: Type.Boolean(),
    error: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  }, closed),
}, closed);

export type ApplicationPreviewReceipt = Static<typeof ApplicationPreviewReceiptSchema>;

export function applicationPreviewBranchRef(previewId: string): string {
  if (!/^[a-f0-9-]{8,64}$/.test(previewId)) throw new Error("Invalid preview ID");
  return `pv${previewId.replace(/-/g, "").slice(0, 18)}`;
}

export function parseApplicationPreviewReceipt(value: unknown): ApplicationPreviewReceipt {
  if (!Value.Check(ApplicationPreviewReceiptSchema, value)) {
    throw new Error("Invalid application preview receipt");
  }
  const resources = value.resources, smoke = resources.smoke_test;
  if (resources.build_artifact.release_id !== value.release_id
    || resources.storage_namespace.namespace !== resources.database_branch.branch_ref
    || value.expires_at != null && (!Number.isFinite(Date.parse(value.expires_at))
      || new Date(value.expires_at).toISOString() !== value.expires_at)
    || [smoke.checks, smoke.passed, smoke.failed].some(items => new Set(items).size !== items.length)
    || smoke.passed.some(check => smoke.failed.includes(check))
    || value.status === "ready" && (Object.values(resources).some(resource => resource.status !== "ready")
      || resources.configuration_revision.configuration_id === null
      || resources.application_activation.activation_id === null
      || smoke.failed.length > 0 || smoke.checks.some(check => !smoke.passed.includes(check))
      || !["release_artifact", "database_branch", "queue_namespace", "storage_namespace", "test_secret",
        "configuration_revision", "application_activation", "application_readiness", "tenant_runtime"]
        .every(check => smoke.checks.includes(check)))
    || value.status === "cleaned" && (!value.cleanup.completed || value.cleanup.required
      || value.cleanup.error !== null
      || [resources.database_branch, resources.queue_namespace, resources.storage_namespace, resources.test_secret]
        .some(resource => resource.status !== "cleaned"))) {
    throw new Error("Invalid application preview state");
  }
  return structuredClone(value);
}
