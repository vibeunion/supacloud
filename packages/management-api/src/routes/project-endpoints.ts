import { Elysia, status, t } from "elysia";
import { requireAdminAuth, requireProjectOrAdminAuth } from "../middleware/auth";
import { projectService } from "../services";
import {
  buildProjectEndpointsProjection,
  PROJECT_ENDPOINTS_SCHEMA,
} from "../utils/project-endpoint-projection";
import { validationErrorResponse } from "../utils/http-validation";
import { logger } from "../utils/logger";

const ProjectEndpointSourceSchema = t.Union([
  t.Literal("explicit_api_domain"),
  t.Literal("explicit_auth_domain"),
  t.Literal("explicit_studio_domain"),
  t.Literal("custom_domain"),
  t.Literal("derived_api_domain"),
  t.Literal("generated"),
]);

const ProjectEndpointSchema = t.Object(
  {
    origin: t.String(),
    host: t.String(),
    scheme: t.Union([t.Literal("http"), t.Literal("https")]),
    source: ProjectEndpointSourceSchema,
    aliases: t.Array(t.String()),
  },
  { additionalProperties: false },
);

export const V1ProjectEndpointsResponseSchema = t.Object(
  {
    schema: t.Literal(PROJECT_ENDPOINTS_SCHEMA),
    project_ref: t.String(),
    endpoints: t.Object(
      {
        api: ProjectEndpointSchema,
        auth: ProjectEndpointSchema,
        studio: ProjectEndpointSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ProjectEndpointErrorSchema = t.Object(
  {
    message: t.String(),
    code: t.String(),
  },
  { additionalProperties: false },
);

function endpointProjection(project: any) {
  return buildProjectEndpointsProjection(project.ref, project.config);
}

export const projectEndpointRoutes = new Elysia({ prefix: "/v1/projects" })
  .onError(({ code, error, set }) => {
    if (code === "VALIDATION") return validationErrorResponse(set);
    logger.error(`[ProjectEndpoints] Unhandled error [${code}]:`, error);
    set.status = code === "NOT_FOUND" ? 404 : 500;
    return {
      message: code === "NOT_FOUND" ? "Not found" : "Failed to project project endpoints",
      code: code === "NOT_FOUND" ? "NOT_FOUND" : "PROJECT_ENDPOINT_PROJECTION_FAILED",
    };
  })
  .get(
    "/endpoints",
    async ({ request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) {
        return status(authError.status as 401 | 403, {
          message: authError.body.error,
          code: String(authError.status),
        });
      }

      const projects = await projectService.listProjects();
      return projects.map(endpointProjection);
    },
    {
      response: {
        200: t.Array(V1ProjectEndpointsResponseSchema),
        401: ProjectEndpointErrorSchema,
        403: ProjectEndpointErrorSchema,
        500: ProjectEndpointErrorSchema,
      },
      detail: { tags: ["projects"], summary: "List authoritative project endpoint projections" },
    },
  )
  .get(
    "/:ref/endpoint/projection",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) {
        return status(authError.status as 401 | 403, {
          message: authError.body.error,
          code: String(authError.status),
        });
      }

      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return endpointProjection(project);
    },
    {
      params: t.Object({ ref: t.String({ minLength: 1, maxLength: 20 }) }),
      response: {
        200: V1ProjectEndpointsResponseSchema,
        401: ProjectEndpointErrorSchema,
        403: ProjectEndpointErrorSchema,
        404: ProjectEndpointErrorSchema,
        500: ProjectEndpointErrorSchema,
      },
      detail: { tags: ["projects"], summary: "Get an authoritative project endpoint projection" },
    },
  );
