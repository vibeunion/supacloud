import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { applicationReleaseId, parseApplicationReleaseRecord } from "@supacloud/delivery";
import { optional, stringEnum } from "../schema";
import type { HttpTransport, HttpResult } from "../transports/http";
import { ApplicationIdSchema, ApplicationReleaseIdSchema, ApplicationConfigurationIdSchema } from "./application-schemas";
import { releaseControlFailure, releaseControlMutationFailure, releaseControlSuccess } from "./release-control-response";

export const APPLICATION_PREVIEW_ACTIONS = [
  "get_preview_plan", "create_preview", "list_previews", "get_preview", "cleanup_preview",
] as const;

const previewIdSchema = Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$" });
const branchRefSchema = Type.String({ pattern: "^[a-z0-9-]{1,20}$" });
const ttlSecondsSchema = Type.Integer({ minimum: 300, maximum: 604_800 });
const waitSecondsSchema = Type.Integer({ minimum: 1, maximum: 3600 });
const timestampSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$", maxLength: 24,
});
export const APPLICATION_PREVIEW_FIELDS = {
  preview_id: optional(previewIdSchema, "[get_preview/cleanup_preview] Preview receipt ID"),
  branch_ref: optional(branchRefSchema, "[get_preview_plan] Proposed branch ref; create assigns its own"),
  branch_name: optional(Type.String({ minLength: 1, maxLength: 80 }), "[create_preview] Branch display name"),
  data_mode: optional(stringEnum(["schema_only", "full_clone"]), "[get_preview_plan/create_preview] Default schema_only; full_clone copies rows"),
  ttl_seconds: optional(ttlSecondsSchema, "[get_preview_plan/create_preview] Lifetime from 300 to 604800 seconds; creation defaults to the platform TTL"),
  wait: optional(Type.Boolean(), "[create_preview/get_preview] Wait for verified readiness of this preview only"),
  timeout_seconds: optional(waitSecondsSchema, "[create_preview/get_preview] Observation budget with wait, from 1 to 3600 seconds (default 300)"),
};

const strict = { additionalProperties: false };
const phase = stringEnum(["pending", "ready", "failed", "cleaned"]);
const check = Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" });
const checks = Type.Array(check, { maxItems: 64, uniqueItems: true });
const revision = Type.Union([ApplicationConfigurationIdSchema, Type.Null()]);
const receiptSchema = Type.Object({
  schema: Type.Literal("supacloud.application-preview.v1"),
  preview_id: previewIdSchema, project_ref: branchRefSchema,
  application_id: ApplicationIdSchema, environment_id: ApplicationIdSchema,
  release_id: ApplicationReleaseIdSchema,
  expires_at: Type.Union([timestampSchema, Type.Null()]),
  status: stringEnum(["planned", "provisioning", "ready", "failed", "cleaned"]),
  resources: Type.Object({
    build_artifact: Type.Object({ status: phase, release_id: ApplicationReleaseIdSchema }, strict),
    database_branch: Type.Object({ status: phase, branch_ref: branchRefSchema, data_mode: stringEnum(["schema_only", "full_clone"]) }, strict),
    queue_namespace: Type.Object({ status: phase, namespace: Type.String({ minLength: 1, maxLength: 128 }) }, strict),
    storage_namespace: Type.Object({ status: phase, namespace: branchRefSchema }, strict),
    test_secret: Type.Object({ status: phase, name: Type.String({ pattern: "^[A-Z0-9_-]{1,128}$" }), value_issued: Type.Literal(false) }, strict),
    configuration_revision: Type.Object({ status: phase, configuration_id: revision }, strict),
    application_activation: Type.Object({ status: phase, activation_id: Type.Union([previewIdSchema, Type.Null()]) }, strict),
    smoke_test: Type.Object({ status: phase, checks, passed: checks, failed: checks }, strict),
  }, strict),
  cleanup: Type.Object({
    required: Type.Boolean(), completed: Type.Boolean(),
    error: Type.Union([Type.String({ pattern: "^[A-Z0-9_]{1,128}$" }), Type.Null()]),
  }, strict),
  branch_name: Type.Optional(Type.String({ maxLength: 80 })),
  queue_name: Type.Optional(Type.String({ maxLength: 128 })),
  test_secret_name: Type.Optional(Type.String({ pattern: "^[A-Z0-9_]{1,128}$" })),
  source_configuration_id: Type.Optional(revision),
  created_at: Type.Optional(timestampSchema),
  updated_at: Type.Optional(timestampSchema),
}, strict);

function required(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`'${field}' is required`);
  return value.trim();
}

const mandatoryChecks = [
  "release_artifact", "database_branch", "queue_namespace", "storage_namespace", "test_secret",
  "configuration_revision", "application_activation", "application_readiness", "tenant_runtime",
];

const actionFields: Record<string, readonly string[]> = {
  get_preview_plan: ["release_id", "branch_ref", "data_mode", "configuration_id", "ttl_seconds"],
  create_preview: ["release_id", "configuration_id", "data_mode", "branch_name", "ttl_seconds", "wait", "timeout_seconds"],
  list_previews: [],
  get_preview: ["preview_id", "wait", "timeout_seconds"],
  cleanup_preview: ["preview_id"],
};

function timestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function receipt(value: unknown, identity: { ref: string; id: string; environment: string; previewId?: string }) {
  if (!Value.Check(receiptSchema, value) || value.project_ref !== identity.ref
    || value.application_id !== identity.id || value.environment_id !== identity.environment
    || (identity.previewId && value.preview_id !== identity.previewId)
    || value.resources.build_artifact.release_id !== value.release_id
    || value.resources.storage_namespace.namespace !== value.resources.database_branch.branch_ref) {
    throw new Error("Invalid preview receipt");
  }
  if ((value.expires_at !== null && !timestamp(value.expires_at))
    || (value.created_at !== undefined && !timestamp(value.created_at))
    || (value.updated_at !== undefined && !timestamp(value.updated_at))
    || (value.expires_at !== null && value.created_at !== undefined
      && !Value.Check(ttlSecondsSchema, (Date.parse(value.expires_at) - Date.parse(value.created_at)) / 1000))) {
    throw new Error("Invalid preview expiry");
  }
  if (value.status === "ready") {
    if (value.resources.smoke_test.status !== "ready" || value.resources.smoke_test.failed.length > 0
      || mandatoryChecks.some(check => !value.resources.smoke_test.checks.includes(check)
        || !value.resources.smoke_test.passed.includes(check))
      || value.resources.smoke_test.passed.some(check => !value.resources.smoke_test.checks.includes(check))
      || Object.values(value.resources).some(resource => resource.status !== "ready")
      || !value.resources.configuration_revision.configuration_id || !value.resources.application_activation.activation_id) {
      throw new Error("Incomplete preview readiness");
    }
  }
  if (value.status === "cleaned" && (!value.cleanup.completed || value.cleanup.required
    || [value.resources.database_branch, value.resources.queue_namespace,
      value.resources.storage_namespace, value.resources.test_secret].some(resource => resource.status !== "cleaned"))) {
    throw new Error("Incomplete preview cleanup");
  }
  // 只投影公开回执，服务端持久化字段不成为 CLI 输出契约。
  const {
    branch_name: _branchName, queue_name: _queueName, test_secret_name: _secretName,
    source_configuration_id: _sourceConfiguration, created_at: _createdAt, updated_at: _updatedAt,
    ...publicReceipt
  } = value;
  return publicReceipt;
}

async function sourceManifest(http: HttpTransport, path: string, ref: string, id: string, releaseId: string) {
  const result = await http.get(`${path}/releases/${releaseId}`, { maxJsonBytes: 196_608, responseTimeoutMs: 30_000 });
  if (!result.ok) return { result };
  try {
    const data = result.data;
    if (!data || typeof data !== "object" || !("project_ref" in data) || data.project_ref !== ref
      || !("application_id" in data) || data.application_id !== id || !("release" in data)) throw new Error();
    const release = parseApplicationReleaseRecord(data.release);
    if (release.project_ref !== ref || release.application_id !== id || release.release_id !== releaseId) throw new Error();
    return { result, manifest: release.manifest_sha256 };
  } catch {
    return { result };
  }
}

async function waitForPreview(
  http: HttpTransport, path: string, operation: string,
  identity: { project_ref: string; application_id: string; environment_id: string },
  initial: ReturnType<typeof receipt>, timeoutSeconds: number, startedAt = performance.now(),
) {
  const deadline = startedAt + timeoutSeconds * 1000;
  let current = initial;
  const state = () => ({
    ...identity, preview_id: initial.preview_id, preview: current,
    reconciliation: {
      action: "get_preview", ref: identity.project_ref, id: identity.application_id,
      environment_id: identity.environment_id, preview_id: initial.preview_id,
      wait: true, timeout_seconds: timeoutSeconds,
    },
  });
  while (true) {
    if (current.status === "ready") return releaseControlSuccess(operation, {
      ...identity, preview: current, waiting: { status: "ready", timeout_seconds: timeoutSeconds },
    });
    if (current.status !== "provisioning") return releaseControlFailure(operation, "MUTATION_NOT_SUCCEEDED", null, {
      ...state(), waiting: { status: "stopped", timeout_seconds: timeoutSeconds },
    });
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 2) return releaseControlFailure(operation, "MUTATION_NOT_SUCCEEDED", null, {
      ...state(), waiting: { status: "timed_out", timeout_seconds: timeoutSeconds },
    });
    // Lifecycle GETs can resume provisioning. Keep one shared header/body
    // deadline and never repeat a failed observation automatically.
    const requestBudget = Math.min(120_000, remaining);
    const result = await http.get(`${path}/previews/${initial.preview_id}`, {
      retry: false, timeoutMs: requestBudget, responseTimeoutMs: requestBudget,
      totalTimeoutMs: requestBudget, maxJsonBytes: 1_048_576,
    });
    if (!result.ok) return releaseControlFailure(operation, "HTTP_ERROR", result.transportError ? null : result.status, {
      ...state(), waiting: { status: "observation_failed", timeout_seconds: timeoutSeconds },
    });
    try {
      const next = receipt(result.data, {
        ref: identity.project_ref, id: identity.application_id, environment: identity.environment_id,
        previewId: initial.preview_id,
      });
      if (next.status === "planned" || next.release_id !== initial.release_id || next.expires_at !== initial.expires_at
        || next.resources.database_branch.branch_ref !== initial.resources.database_branch.branch_ref
        || next.resources.database_branch.data_mode !== initial.resources.database_branch.data_mode
        || (current.resources.application_activation.activation_id !== null
          && next.resources.application_activation.activation_id !== current.resources.application_activation.activation_id)
        || (current.resources.configuration_revision.configuration_id !== null
          && next.resources.configuration_revision.configuration_id !== current.resources.configuration_revision.configuration_id)) {
        throw new Error("Preview identity changed during observation");
      }
      current = next;
    } catch {
      return releaseControlFailure(operation, "INVALID_RESPONSE", result.status, {
        ...state(), waiting: { status: "observation_failed", timeout_seconds: timeoutSeconds },
      });
    }
    if (current.status === "provisioning") {
      await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, Math.min(1000, deadline - performance.now()))));
    }
  }
}

export async function applicationPreviewAction(http: HttpTransport, args: Record<string, unknown>, project: string) {
  const action = required(args, "action"), ref = required(args, "ref"), id = required(args, "id");
  const environment = required(args, "environment_id");
  if (!Value.Check(ApplicationIdSchema, environment)) throw new Error("Invalid environment ID");
  const fields = new Set(["action", "ref", "id", "environment_id", ...(actionFields[action] ?? [])]);
  if (Object.entries(args).some(([key, value]) => value !== undefined && !fields.has(key))) {
    throw new Error("Invalid option for preview action");
  }
  if (args["ttl_seconds"] !== undefined && !Value.Check(ttlSecondsSchema, args["ttl_seconds"])) {
    throw new Error("ttl_seconds must be an integer from 300 to 604800");
  }
  if (args["wait"] !== undefined && typeof args["wait"] !== "boolean") throw new Error("wait must be boolean");
  if (args["timeout_seconds"] !== undefined
    && (args["wait"] !== true || !Value.Check(waitSecondsSchema, args["timeout_seconds"]))) {
    throw new Error("timeout_seconds requires wait and must be an integer from 1 to 3600");
  }
  const timeoutSeconds = args["wait"] === true ? ((args["timeout_seconds"] as number | undefined) ?? 300) : undefined;
  const startedAt = action === "get_preview" && timeoutSeconds !== undefined ? performance.now() : undefined;
  const operation = `applications.${action}`;
  const identity = { project_ref: ref, application_id: id, environment_id: environment };
  const applicationPath = `/v1/projects/${project}/applications/${encodeURIComponent(id)}`;
  const path = `${applicationPath}/environments/${encodeURIComponent(environment)}`;
  const previewId = action === "get_preview" || action === "cleanup_preview" ? required(args, "preview_id") : undefined;
  const mutation = action === "create_preview" || action === "cleanup_preview";
  // GET 状态查询会恢复服务端编排，不能套用普通只读 GET 的自动重试。
  const requestBudget = startedAt === undefined ? 120_000 : Math.min(120_000, timeoutSeconds! * 1000);
  const options = {
    timeoutMs: requestBudget, maxJsonBytes: 1_048_576, responseTimeoutMs: requestBudget, retry: false,
    ...(startedAt === undefined ? {} : { totalTimeoutMs: requestBudget }),
  };
  let sourceHash: string | undefined;
  let releaseId: string | undefined;
  let result: HttpResult<unknown>;
  if (action === "get_preview_plan" || action === "create_preview") {
    releaseId = required(args, "release_id");
    if (!Value.Check(ApplicationReleaseIdSchema, releaseId)) throw new Error("Invalid release ID");
    if (action === "get_preview_plan") {
      const query = new URLSearchParams({ release_id: releaseId, branch_ref: required(args, "branch_ref") });
      if (typeof args["data_mode"] === "string") query.set("data_mode", args["data_mode"]);
      if (typeof args["configuration_id"] === "string") query.set("configuration_id", args["configuration_id"]);
      if (args["ttl_seconds"] !== undefined) query.set("ttl_seconds", String(args["ttl_seconds"]));
      result = await http.get(`${path}/preview-plan?${query}`, options);
    } else {
      const configurationId = required(args, "configuration_id");
      if (!Value.Check(ApplicationConfigurationIdSchema, configurationId)) throw new Error("Invalid configuration ID");
      const source = await sourceManifest(http, applicationPath, ref, id, releaseId);
      if (!source.manifest) return releaseControlFailure(operation, source.result.ok ? "INVALID_RESPONSE" : "HTTP_ERROR",
        source.result.status, { ...identity, release_id: releaseId, configuration_id: configurationId });
      sourceHash = source.manifest;
      result = await http.post(`${path}/previews`, {
        release_id: releaseId, configuration_id: configurationId, data_mode: args["data_mode"] ?? "schema_only",
        ...(args["branch_name"] === undefined ? {} : { branch_name: args["branch_name"] }),
        ...(args["ttl_seconds"] === undefined ? {} : { ttl_seconds: args["ttl_seconds"] }),
      }, options);
    }
  } else if (action === "list_previews") {
    result = await http.get(`${path}/previews`, options);
  } else if (previewId) {
    if (!Value.Check(previewIdSchema, previewId)) throw new Error("Invalid preview ID");
    result = action === "cleanup_preview"
      ? await http.deleteReleaseMutation(`${path}/previews/${previewId}`)
      : await http.get(`${path}/previews/${previewId}`, options);
  } else {
    throw new Error("Unknown preview action");
  }
  const state = {
    ...identity, ...(previewId ? { preview_id: previewId } : {}),
    ...(releaseId ? { source_release_id: releaseId } : {}),
    reconciliation: previewId
      ? { action: "get_preview", ref, id, environment_id: environment, preview_id: previewId }
      : { action: "list_previews", ref, id, environment_id: environment },
  };
  if (!result.ok) return mutation
    ? releaseControlMutationFailure(operation, result, state)
    : releaseControlFailure(operation, "HTTP_ERROR", result.status, state);
  try {
    if (action === "list_previews") {
      const inventorySchema = Type.Object({
        ...Type.Object({ project_ref: branchRefSchema, application_id: ApplicationIdSchema, environment_id: ApplicationIdSchema }).properties,
        previews: Type.Array(receiptSchema, { maxItems: 1000 }),
      }, strict);
      if (!Value.Check(inventorySchema, result.data) || result.data.project_ref !== ref
        || result.data.application_id !== id || result.data.environment_id !== environment) throw new Error();
      const previews = result.data.previews.map(value => receipt(value, { ref, id, environment }));
      if (new Set(previews.map(value => value.preview_id)).size !== previews.length) throw new Error();
      return releaseControlSuccess(operation, { ...identity, previews });
    }
    const preview = receipt(result.data, {
      ref, id, environment, ...(previewId === undefined ? {} : { previewId }),
    });
    if (action === "get_preview_plan") {
      if (preview.status !== "planned" || preview.release_id !== releaseId
        || preview.resources.database_branch.branch_ref !== args["branch_ref"]
        || preview.resources.database_branch.data_mode !== (args["data_mode"] ?? "schema_only")
        || (args["ttl_seconds"] === undefined ? preview.expires_at !== null : preview.expires_at === null)) throw new Error();
    } else {
      if (preview.status === "planned"
        || preview.resources.database_branch.branch_ref !== `pv${preview.preview_id.replaceAll("-", "").slice(0, 18)}`) throw new Error();
      if (action === "create_preview" && (preview.release_id !== applicationReleaseId(
        preview.resources.database_branch.branch_ref, id, sourceHash!,
      ) || preview.resources.database_branch.data_mode !== (args["data_mode"] ?? "schema_only")
        || !Value.Check(receiptSchema, result.data) || result.data.source_configuration_id !== args["configuration_id"]
        || preview.expires_at === null || result.data.created_at === undefined
        || (args["ttl_seconds"] !== undefined
          && Date.parse(preview.expires_at) - Date.parse(result.data.created_at) !== (args["ttl_seconds"] as number) * 1000))) throw new Error();
    }
    if (preview.status === "failed" || (action === "cleanup_preview" && preview.status !== "cleaned")) {
      return releaseControlFailure(operation, "MUTATION_NOT_SUCCEEDED", result.status, { ...identity, preview });
    }
    if (timeoutSeconds !== undefined) return await waitForPreview(http, path, operation, identity, preview, timeoutSeconds, startedAt);
    return releaseControlSuccess(operation, { ...identity, preview });
  } catch {
    return releaseControlFailure(operation, mutation ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", result.status, state);
  }
}

export type ApplicationPreviewReceipt = Static<typeof receiptSchema>;
