import { Elysia, status, t } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { PreviewEnvironmentError, composePreviewEnvironment } from "../services/preview-environment.service";

const params = t.Object({ ref: t.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" }) });
const body = t.Object({
  preview_ref: t.String({ pattern: "^[A-Za-z0-9_-]{1,32}$" }),
  application_id: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
  environment_id: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
  release_id: t.String({ pattern: "^[a-f0-9]{64}$" }),
  source: t.Object({
    branch: t.String({ minLength: 1, maxLength: 255 }),
    commit: t.String({ maxLength: 40 }),
  }, { additionalProperties: false }),
  configuration_id: t.Optional(t.String()),
  resources: t.Optional(t.Record(t.String(), t.String())),
  data_mode: t.Optional(t.Union([t.Literal("schema_only"), t.Literal("full_clone")])),
  authorized_full_clone: t.Optional(t.Boolean()),
  lifecycle: t.Optional(t.Object({
    reclaim_on: t.Optional(t.Union([t.Literal("pr_closed"), t.Literal("timeout")])),
    timeout_hours: t.Optional(t.Number()),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export function createPreviewRoutes(dependencies: { authorize?: typeof requireProjectOrAdminAuth } = {}) {
  const authorize = dependencies.authorize ?? requireProjectOrAdminAuth;
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
    }, ({ params: values, body: input }) => composePreviewEnvironment({
      previewRef: input.preview_ref,
      projectRef: values.ref,
      applicationId: input.application_id,
      environmentId: input.environment_id,
      releaseId: input.release_id,
      source: input.source,
      ...(input.configuration_id ? { configurationId: input.configuration_id } : {}),
      ...(input.resources ? { resources: input.resources } : {}),
      ...(input.data_mode ? { dataMode: input.data_mode } : {}),
      ...(input.authorized_full_clone === undefined ? {} : { authorizedFullClone: input.authorized_full_clone }),
      ...(input.lifecycle ? {
        lifecycle: {
          ...(input.lifecycle.reclaim_on ? { reclaimOn: input.lifecycle.reclaim_on } : {}),
          ...(input.lifecycle.timeout_hours === undefined ? {} : { timeoutHours: input.lifecycle.timeout_hours }),
        },
      } : {}),
    }));
}

export const previewRoutes = createPreviewRoutes();