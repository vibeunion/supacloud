import { Type } from "typebox";
import { Value } from "typebox/value";
import { mutationRequestFingerprint, safeMutationStatus } from "../mutation-protocol";
import {
  ApplicationIdSchema, ApplicationReleaseIdSchema, ApplicationActivationIdSchema,
  ApplicationConfigurationIdSchema,
} from "./application-schemas";

const closed = { additionalProperties: false } as const;
const ref = Type.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" });
const uuid = ApplicationActivationIdSchema;
const nullableUuid = Type.Union([uuid, Type.Null()]);
const nullableDigest = Type.Union([ApplicationReleaseIdSchema, Type.Null()]);
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const scope = { project_ref: ref, application_id: ApplicationIdSchema, environment_id: ApplicationIdSchema };

export const ApplicationPromotionResultSchema = Type.Object({
  ...scope, mutation_id: uuid, activation_id: uuid, plan_sha256: ApplicationReleaseIdSchema,
  action: Type.Literal("promote"), replayed: Type.Boolean(),
}, closed);

export const ApplicationPromotionStatusSchema = Type.Object({
  ...scope,
  mutation: Type.Unknown(),
  promotion: Type.Object({
    phase: Type.Union([Type.Literal("prepared"), Type.Literal("transferring"), Type.Literal("migrating"),
      Type.Literal("activating"), Type.Literal("verifying"), Type.Null()]),
    plan_sha256: nullableDigest, activation_id: nullableUuid, release_id: nullableDigest,
    configuration_id: Type.Union([ApplicationConfigurationIdSchema, Type.Null()]),
    backup_id: Type.Union([Type.String({ pattern: "^logical-full_[a-z0-9-]{1,20}_[a-f0-9]{32}$" }), Type.Null()]),
    data_recovery: Type.Literal("separate-required"),
  }, closed),
}, closed);

const phase = Type.Union([Type.Literal("pending"), Type.Literal("ready"), Type.Literal("failed"), Type.Literal("cleaned")]);
const previewId = Type.String({ pattern: "^[a-f0-9-]{8,64}$" });
const name = Type.String({ minLength: 1, maxLength: 256 });
const checks = Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64, uniqueItems: true });
export const ApplicationPreviewReceiptSchema = Type.Object({
  schema: Type.Literal("supacloud.application-preview.v1"),
  ...scope, preview_id: previewId, release_id: ApplicationReleaseIdSchema,
  expires_at: Type.Union([timestamp, Type.Null()]),
  status: Type.Union([Type.Literal("planned"), Type.Literal("provisioning"), Type.Literal("ready"),
    Type.Literal("failed"), Type.Literal("cleaned")]),
  resources: Type.Object({
    build_artifact: Type.Object({ status: phase, release_id: ApplicationReleaseIdSchema }, closed),
    database_branch: Type.Object({
      status: phase, branch_ref: ref, data_mode: Type.Union([Type.Literal("schema_only"), Type.Literal("full_clone")]),
    }, closed),
    queue_namespace: Type.Object({ status: phase, namespace: name }, closed),
    storage_namespace: Type.Object({ status: phase, namespace: name }, closed),
    test_secret: Type.Object({ status: phase, name, value_issued: Type.Literal(false) }, closed),
    configuration_revision: Type.Object({ status: phase, configuration_id: Type.Union([ApplicationConfigurationIdSchema, Type.Null()]) }, closed),
    application_activation: Type.Object({ status: phase, activation_id: nullableUuid }, closed),
    smoke_test: Type.Object({ status: phase, checks, passed: checks, failed: checks }, closed),
  }, closed),
  cleanup: Type.Object({
    required: Type.Boolean(), completed: Type.Boolean(),
    error: Type.Union([Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" }), Type.Null()]),
  }, closed),
  branch_name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  queue_name: Type.Optional(name), test_secret_name: Type.Optional(name),
  source_configuration_id: Type.Optional(Type.Union([ApplicationConfigurationIdSchema, Type.Null()])),
  created_at: Type.Optional(timestamp), updated_at: Type.Optional(timestamp),
}, closed);

const previewListSchema = Type.Object({
  ...scope, previews: Type.Array(ApplicationPreviewReceiptSchema, { maxItems: 1000 }),
}, closed);

export interface ApplicationWorkflowScope {
  project_ref: string;
  application_id: string;
  environment_id: string;
}

function assertScope(value: ApplicationWorkflowScope, identity: ApplicationWorkflowScope): void {
  if (value.project_ref !== identity.project_ref || value.application_id !== identity.application_id
    || value.environment_id !== identity.environment_id) throw new Error("Application workflow scope mismatch");
}

export function parsePromotionStatus(value: unknown, identity: ApplicationWorkflowScope & { mutation_id: string }) {
  if (!Value.Check(ApplicationPromotionStatusSchema, value)) throw new Error("Invalid promotion status");
  assertScope(value, identity);
  const mutation = safeMutationStatus(value.mutation);
  const resourceId = mutationRequestFingerprint({
    applicationId: identity.application_id, environmentId: identity.environment_id,
  });
  const resourceKey = `v1/application_release/${Buffer.from(resourceId).toString("base64url")}`;
  if (!mutation || mutation.project_ref !== identity.project_ref || mutation.mutation_id !== identity.mutation_id
    || mutation.operation !== "application.release.promote" || mutation.resource_key !== resourceKey
    || value.promotion.activation_id === identity.mutation_id) {
    throw new Error("Invalid promotion mutation identity");
  }
  if (mutation.status === "succeeded"
    && (mutation.response_status !== 200 || mutation.receipt === null
      || value.promotion.phase !== "verifying" || value.promotion.activation_id === null
      || value.promotion.plan_sha256 === null || value.promotion.release_id === null
      || value.promotion.configuration_id === null || value.promotion.backup_id === null)) {
    throw new Error("Invalid promotion success state");
  }
  if (value.promotion.backup_id !== null
    && !value.promotion.backup_id.startsWith(`logical-full_${identity.project_ref}_`)) {
    throw new Error("Invalid promotion backup identity");
  }
  return structuredClone({ ...value, mutation });
}

export function parsePreviewReceipt(value: unknown, identity: ApplicationWorkflowScope & {
  preview_id?: string; release_id?: string; branch_ref?: string; data_mode?: string; configuration_id?: string;
}) {
  if (!Value.Check(ApplicationPreviewReceiptSchema, value)) throw new Error("Invalid preview receipt");
  assertScope(value, identity);
  if (identity.preview_id !== undefined && value.preview_id !== identity.preview_id
    || identity.release_id !== undefined && value.release_id !== identity.release_id
    || identity.branch_ref !== undefined && value.resources.database_branch.branch_ref !== identity.branch_ref
    || identity.data_mode !== undefined && value.resources.database_branch.data_mode !== identity.data_mode
    || identity.configuration_id !== undefined && value.source_configuration_id !== identity.configuration_id
    || value.resources.build_artifact.release_id !== value.release_id) throw new Error("Invalid preview identity");
  return structuredClone(value);
}

export function parsePreviewList(value: unknown, identity: ApplicationWorkflowScope) {
  if (!Value.Check(previewListSchema, value)) throw new Error("Invalid preview list");
  assertScope(value, identity);
  const ids = new Set<string>();
  for (const item of value.previews) {
    parsePreviewReceipt(item, identity);
    if (ids.has(item.preview_id)) throw new Error("Duplicate preview identity");
    ids.add(item.preview_id);
  }
  return structuredClone(value);
}
