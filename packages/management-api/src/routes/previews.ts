import { Elysia, status, t } from "elysia";
import { getVerifiedRequestPrincipal, requireProjectOrAdminAuth } from "../middleware/auth";
import { PreviewEnvironmentError, composePreviewEnvironment } from "../services/preview-environment.service";
import { evaluatePreviewStatus } from "../services/preview-status.service";
import { collectPreviewIsolation, type PreviewIsolationCollectorPort } from "../services/preview-isolation-collector.service";

const params = t.Object({ ref: t.String({ pattern: "^[a-z0-9-]{1,20}$" }) });
const body = t.Object({
  preview_ref: t.String({ pattern: "^(?:pr-\\d{1,10}|change-[A-Za-z0-9_-]{1,32}|[a-f0-9]{20})$" }),
  application_id: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
  environment_id: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
  release_id: t.String({ pattern: "^[a-f0-9]{64}$" }),
  source: t.Object({ branch: t.String({ minLength: 1, maxLength: 255 }), commit: t.String({ maxLength: 40 }) }, { additionalProperties: false }),
  configuration_id: t.Optional(t.String({ minLength: 1, maxLength: 68 })),
  resources: t.Optional(t.Record(t.String({ minLength: 1, maxLength: 512 }), t.String({ minLength: 1, maxLength: 128 }))),
  queue_names: t.Optional(t.Array(t.String({ maxLength: 64 }), { maxItems: 64 })),
  storage_buckets: t.Optional(t.Array(t.String({ maxLength: 63 }), { maxItems: 64 })),
  data_mode: t.Optional(t.Union([t.Literal("schema_only"), t.Literal("full_clone")])),
  // Compatibility hints only; none of these fields grant authority or attest runtime state.
  authorized_full_clone: t.Optional(t.Boolean()),
  lifecycle: t.Optional(t.Object({
    reclaim_on: t.Optional(t.Union([t.Literal("pr_closed"), t.Literal("timeout"), t.Literal("pr_closed_or_timeout")])),
    timeout_hours: t.Optional(t.Integer({ minimum: 1, maximum: 720 })),
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
  preview_ref: string; application_id: string; environment_id: string; release_id: string;
  source: { branch: string; commit: string };
  configuration_id?: string;
  resources?: Record<string, string>;
  queue_names?: string[];
  storage_buckets?: string[];
  data_mode?: "schema_only" | "full_clone";
  authorized_full_clone?: boolean;
  lifecycle?: { reclaim_on?: "pr_closed" | "timeout" | "pr_closed_or_timeout"; timeout_hours?: number };
}

function toComposeInput(ref: string, input: PreviewRequestBody, authorizedFullClone: boolean) {
  const resources = Object.entries(input.resources ?? {});
  const strings = [ref, input.preview_ref, input.application_id, input.environment_id, input.release_id,
    input.source.branch, input.source.commit, input.configuration_id ?? "", ...resources.flat(),
    ...(input.queue_names ?? []), ...(input.storage_buckets ?? [])];
  if (resources.length > 64 || strings.some(value => /[\u0000-\u001f\u007f]/.test(value))) {
    throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INVALID");
  }
  return {
    previewRef: input.preview_ref, projectRef: ref, applicationId: input.application_id,
    environmentId: input.environment_id, releaseId: input.release_id, source: input.source,
    authorizedFullClone,
    ...(input.configuration_id === undefined ? {} : { configurationId: input.configuration_id }),
    ...(input.resources === undefined ? {} : { resources: input.resources }),
    ...(input.queue_names === undefined ? {} : { queueNames: input.queue_names }),
    ...(input.storage_buckets === undefined ? {} : { storageBuckets: input.storage_buckets }),
    ...(input.data_mode === undefined ? {} : { dataMode: input.data_mode }),
    ...(input.lifecycle ? { lifecycle: {
      ...(input.lifecycle.reclaim_on === undefined ? {} : { reclaimOn: input.lifecycle.reclaim_on }),
      ...(input.lifecycle.timeout_hours === undefined ? {} : { timeoutHours: input.lifecycle.timeout_hours }),
    } } : {}),
  };
}

export function createPreviewRoutes(dependencies: {
  authorize?: typeof requireProjectOrAdminAuth;
  principal?: typeof getVerifiedRequestPrincipal;
  isolationCollector?: PreviewIsolationCollectorPort;
  now?: () => Date;
} = {}) {
  const authorize = dependencies.authorize ?? requireProjectOrAdminAuth;
  const principal = dependencies.principal ?? getVerifiedRequestPrincipal;
  const now = dependencies.now ?? (() => new Date());
  const compose = async (request: Request, ref: string, input: PreviewRequestBody) => {
    const actor = input.data_mode === "full_clone" ? await principal(request) : null;
    const preview = composePreviewEnvironment(toComposeInput(ref, input, actor?.type === "admin" || actor?.type === "master"));
    if (Buffer.byteLength(JSON.stringify(preview), "utf8") > 65_536) throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INVALID");
    return preview;
  };
  return new Elysia({ prefix: "/v1/projects/:ref/previews", name: "preview-environments" })
    .error(({ error }) => {
      if (error instanceof PreviewEnvironmentError) return status(error.statusCode, { code: error.code, error: error.message });
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
      params, body, detail: { tags: ["previews"], summary: "Compose a complete preview environment plan without provisioning" },
    }, ({ request, params: values, body: input }) => compose(request, values.ref, input))
    .post("/acceptance", {
      params, body, detail: { tags: ["previews"], summary: "Return an unverified planning assessment; caller assertions cannot certify isolation" },
    }, async ({ request, params: values, body: input }) => {
      const preview = await compose(request, values.ref, input);
      // Compatibility endpoint: self-reported evidence/health/acceptance is not a trusted observation.
      return { preview, isolation: preview.isolation, accepted: false,
        evidence_source: "caller-unverified", status: evaluatePreviewStatus(preview) };
    })
    .post("/isolation-collection", {
      params, body, detail: { tags: ["previews"], summary: "Collect identity- and time-bound isolation evidence from the trusted collector" },
    }, async ({ request, params: values, body: input }) => {
      const preview = await compose(request, values.ref, input);
      if (!dependencies.isolationCollector) return status(501, {
        code: "PREVIEW_ISOLATION_COLLECTOR_UNAVAILABLE", error: "Preview isolation collector is not configured",
      });
      const collected = await collectPreviewIsolation(preview, dependencies.isolationCollector, now());
      const evaluated = { ...preview, isolation: collected.isolation };
      return { preview: evaluated, evidence: collected.evidence, isolation: collected.isolation,
        accepted: collected.accepted, evidence_source: "trusted-collector", discarded: collected.discarded,
        status: evaluatePreviewStatus(evaluated) };
    });
}
export const previewRoutes = createPreviewRoutes();
