import { Elysia, status, t } from "elysia";
import { getVerifiedRequestPrincipal, requireProjectOrAdminAuth } from "../middleware/auth";
import { PreviewEnvironmentError, composePreviewEnvironment } from "../services/preview-environment.service";

const params = t.Object({ ref: t.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" }) });
const body = t.Object({
  preview_ref: t.String({ pattern: "^[A-Za-z0-9_-]{1,32}$" }),
  application_id: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
  environment_id: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
  release_id: t.String({ pattern: "^[a-f0-9]{64}$" }),
  source: t.Object({ branch: t.String({ minLength: 1, maxLength: 255 }), commit: t.String({ maxLength: 40 }) }, { additionalProperties: false }),
  configuration_id: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  resources: t.Optional(t.Record(t.String({ minLength: 1, maxLength: 512 }), t.String({ minLength: 1, maxLength: 128 }))),
  data_mode: t.Optional(t.Union([t.Literal("schema_only"), t.Literal("full_clone")])),
  // Legacy request hint only. It never grants cloning authority.
  authorized_full_clone: t.Optional(t.Boolean()),
  lifecycle: t.Optional(t.Object({
    reclaim_on: t.Optional(t.Union([t.Literal("pr_closed"), t.Literal("timeout")])),
    timeout_hours: t.Optional(t.Integer({ minimum: 1, maximum: 720 })),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export function createPreviewRoutes(dependencies: {
  authorize?: typeof requireProjectOrAdminAuth;
  principal?: typeof getVerifiedRequestPrincipal;
} = {}) {
  const authorize = dependencies.authorize ?? requireProjectOrAdminAuth;
  const principal = dependencies.principal ?? getVerifiedRequestPrincipal;
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
      params, body,
      detail: { tags: ["previews"], summary: "Compose a bounded preview plan without provisioning or granting execution authority" },
    }, async ({ request, params: values, body: input }) => {
      const actor = input.data_mode === "full_clone" ? await principal(request) : null;
      const authorizedFullClone = actor?.type === "admin" || actor?.type === "master";
      return composePreviewEnvironment({
        previewRef: input.preview_ref, projectRef: values.ref,
        applicationId: input.application_id, environmentId: input.environment_id,
        releaseId: input.release_id, source: input.source,
        ...(input.configuration_id === undefined ? {} : { configurationId: input.configuration_id }),
        ...(input.resources === undefined ? {} : { resources: input.resources }),
        ...(input.data_mode === undefined ? {} : { dataMode: input.data_mode }),
        authorizedFullClone,
        ...(input.lifecycle ? { lifecycle: {
          ...(input.lifecycle.reclaim_on === undefined ? {} : { reclaimOn: input.lifecycle.reclaim_on }),
          ...(input.lifecycle.timeout_hours === undefined ? {} : { timeoutHours: input.lifecycle.timeout_hours }),
        } } : {}),
      });
    });
}
export const previewRoutes = createPreviewRoutes();
