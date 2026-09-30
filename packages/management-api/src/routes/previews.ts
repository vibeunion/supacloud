import { Elysia, status, t } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { PreviewEnvironmentError, composePreviewEnvironment, evaluatePreviewIsolation } from "../services/preview-environment.service";
import { evaluatePreviewStatus } from "../services/preview-status.service";
import { collectPreviewIsolation, type PreviewIsolationCollectorPort } from "../services/preview-isolation-collector.service";

const params = t.Object({ ref: t.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" }) });
const body = t.Object({
  preview_ref: t.String({ pattern: "^(?:pr-\\d{1,10}|change-[A-Za-z0-9_-]{1,32})$" }),
  application_id: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
  environment_id: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
  release_id: t.String({ pattern: "^[a-f0-9]{64}$" }),
  source: t.Object({
    branch: t.String({ minLength: 1, maxLength: 255 }),
    commit: t.String({ maxLength: 40 }),
  }, { additionalProperties: false }),
  configuration_id: t.Optional(t.String()),
  resources: t.Optional(t.Record(t.String(), t.String())),
  queue_names: t.Optional(t.Array(t.String({ maxLength: 64 }), { maxItems: 64 })),
  storage_buckets: t.Optional(t.Array(t.String({ maxLength: 63 }), { maxItems: 64 })),
  data_mode: t.Optional(t.Union([t.Literal("schema_only"), t.Literal("full_clone")])),
  authorized_full_clone: t.Optional(t.Boolean()),
  lifecycle: t.Optional(t.Object({
    reclaim_on: t.Optional(t.Union([t.Literal("pr_closed"), t.Literal("timeout"), t.Literal("pr_closed_or_timeout")])),
    timeout_hours: t.Optional(t.Number()),
  }, { additionalProperties: false })),
  evidence: t.Optional(t.Object({
    database_role: t.Optional(t.Object({ ok: t.Boolean(), detail: t.Optional(t.String({ maxLength: 512 })) }, { additionalProperties: false })),
    storage_permissions: t.Optional(t.Object({ ok: t.Boolean(), detail: t.Optional(t.String({ maxLength: 512 })) }, { additionalProperties: false })),
    consumer_identity: t.Optional(t.Object({ ok: t.Boolean(), detail: t.Optional(t.String({ maxLength: 512 })) }, { additionalProperties: false })),
    route_access_control: t.Optional(t.Object({ ok: t.Boolean(), detail: t.Optional(t.String({ maxLength: 512 })) }, { additionalProperties: false })),
  }, { additionalProperties: false })),
  healthy: t.Optional(t.Object({ ok: t.Boolean(), detail: t.Optional(t.String({ maxLength: 512 })) }, { additionalProperties: false })),
  accepted: t.Optional(t.Object({ by: t.String({ minLength: 1, maxLength: 128 }), at: t.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false })),
}, { additionalProperties: false });

interface PreviewRequestBody {
  preview_ref: string;
  application_id: string;
  environment_id: string;
  release_id: string;
  source: { branch: string; commit: string };
  configuration_id?: string;
  resources?: Record<string, string>;
  queue_names?: string[];
  storage_buckets?: string[];
  data_mode?: "schema_only" | "full_clone";
  authorized_full_clone?: boolean;
  lifecycle?: { reclaim_on?: "pr_closed" | "timeout" | "pr_closed_or_timeout"; timeout_hours?: number };
  healthy?: { ok: boolean; detail?: string };
  accepted?: { by: string; at: string };
}

function toComposeInput(ref: string, input: PreviewRequestBody) {
  return {
    previewRef: input.preview_ref,
    projectRef: ref,
    applicationId: input.application_id,
    environmentId: input.environment_id,
    releaseId: input.release_id,
    source: input.source,
    ...(input.configuration_id ? { configurationId: input.configuration_id } : {}),
    ...(input.resources ? { resources: input.resources } : {}),
    ...(input.queue_names ? { queueNames: input.queue_names } : {}),
    ...(input.storage_buckets ? { storageBuckets: input.storage_buckets } : {}),
    ...(input.data_mode ? { dataMode: input.data_mode } : {}),
    ...(input.authorized_full_clone === undefined ? {} : { authorizedFullClone: input.authorized_full_clone }),
    ...(input.lifecycle ? {
      lifecycle: {
        ...(input.lifecycle.reclaim_on ? { reclaimOn: input.lifecycle.reclaim_on } : {}),
        ...(input.lifecycle.timeout_hours === undefined ? {} : { timeoutHours: input.lifecycle.timeout_hours }),
      },
    } : {}),
  };
}

export function createPreviewRoutes(dependencies: {
  authorize?: typeof requireProjectOrAdminAuth;
  /** Isolation evidence must come from a trusted collector; absent means collection is unavailable. */
  isolationCollector?: PreviewIsolationCollectorPort;
  now?: () => Date;
} = {}) {
  const authorize = dependencies.authorize ?? requireProjectOrAdminAuth;
  const now = dependencies.now ?? (() => new Date());
  return new Elysia({ prefix: "/v1/projects/:ref/previews", name: "preview-environments" })
    .error(({ error }) => {
      if (error instanceof PreviewEnvironmentError) {
        return status(error.statusCode, { code: error.code, error: error.message });
      }
      if (error instanceof Error && "code" in error && (error.code === "validation" || error.code === "parse")) {
        return status(error.code === "parse" ? 400 : 422, { code: "PREVIEW_ENVIRONMENT_INVALID", error: "Invalid preview environment request" });
      }
      return status(500, { code: "PREVIEW_ENVIRONMENT_FAILED", error: "Preview environment request failed" });
    })
    .beforeHandle(async ({ request, params: values }) => {
      const denied = await authorize(request, values.ref);
      if (denied) return status(denied.status, denied.body);
    })
    .post("/plan", {
      params,
      body,
      detail: { tags: ["previews"], summary: "Compose a complete preview environment plan without provisioning" },
    }, ({ params: values, body: input }) => composePreviewEnvironment(toComposeInput(values.ref, input)))
    .post("/acceptance", {
      params,
      body,
      detail: { tags: ["previews"], summary: "Evaluate observed isolation evidence for a composed preview without provisioning" },
    }, ({ params: values, body: input }) => {
      const preview = composePreviewEnvironment(toComposeInput(values.ref, input));
      const evaluation = evaluatePreviewIsolation(preview, input.evidence ?? {});
      const evaluated = { ...preview, isolation: evaluation.isolation };
      const status = evaluatePreviewStatus(evaluated, {
        ...(input.healthy ? { healthy: input.healthy } : {}),
        ...(input.accepted ? { accepted: input.accepted } : {}),
      });
      return { preview: evaluated, isolation: evaluation.isolation, accepted: evaluation.accepted, status };
    })
    .post("/isolation-collection", {
      params,
      body,
      detail: { tags: ["previews"], summary: "Collect isolation evidence from the trusted collector" },
    }, async ({ params: values, body: input }) => {
      if (!dependencies.isolationCollector) {
        return status(501, {
          code: "PREVIEW_ISOLATION_COLLECTOR_UNAVAILABLE",
          error: "Preview isolation collector is not configured",
        });
      }
      const preview = composePreviewEnvironment(toComposeInput(values.ref, input));
      const collected = await collectPreviewIsolation(preview, dependencies.isolationCollector, now());
      const evaluated = { ...preview, isolation: collected.isolation };
      return {
        preview: evaluated,
        evidence: collected.evidence,
        isolation: collected.isolation,
        accepted: collected.accepted,
        discarded: collected.discarded,
        status: evaluatePreviewStatus(evaluated),
      };
    });
}

export const previewRoutes = createPreviewRoutes();