import { Elysia, status, t } from "elysia";
import { projectService } from "../services";
import { requireAdminAuth, requireProjectOrAdminAuth } from "../middleware/auth";
import {
  deriveStudioHostFromApiHost,
  normalizeProjectRoutingConfig,
  resolveProjectApiHosts,
  resolveProjectApiUrl,
  resolveProjectAuthUrl,
  resolveProjectStudioUrl,
  type ProjectRoutingConfig,
} from "../utils/project-routing";

export const PROJECT_ENDPOINT_PROJECTION_SCHEMA = "supacloud.project-endpoints.v1" as const;

const ENDPOINT_SOURCES = ["explicit", "derived", "generated"] as const;
const ENDPOINT_STATUSES = ["configured", "pending", "inactive", "unknown"] as const;
const ENDPOINT_VERIFICATION = "not_checked" as const;

type EndpointSource = typeof ENDPOINT_SOURCES[number];
type EndpointStatus = typeof ENDPOINT_STATUSES[number];
type EndpointKind = "api" | "auth" | "studio";

export interface ProjectEndpointInput {
  ref: string;
  name: string;
  status?: string;
  config?: unknown;
}

function nonEmptyString(candidate: unknown): string | undefined {
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function publicProjectStatus(rawStatus: unknown): string {
  const normalized = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";
  if (["active", "active_healthy"].includes(normalized)) return "ACTIVE_HEALTHY";
  if (["creating", "coming_up"].includes(normalized)) return "COMING_UP";
  if (["paused", "inactive", "deleted"].includes(normalized)) return "INACTIVE";
  if (["unhealthy", "error"].includes(normalized)) return "UNHEALTHY";
  return "UNKNOWN";
}

function endpointStatus(projectStatus: string): EndpointStatus {
  if (projectStatus === "ACTIVE_HEALTHY") return "configured";
  if (projectStatus === "COMING_UP") return "pending";
  if (projectStatus === "INACTIVE") return "inactive";
  return "unknown";
}

function endpointSource(kind: EndpointKind, routing: ProjectRoutingConfig | undefined): EndpointSource {
  if (kind === "api") {
    if (nonEmptyString(routing?.api_domain)) return "explicit";
    return nonEmptyString(routing?.custom_domain) ? "derived" : "generated";
  }
  if (kind === "auth") {
    if (nonEmptyString(routing?.auth_domain)) return "explicit";
    return nonEmptyString(routing?.api_domain) || nonEmptyString(routing?.custom_domain)
      ? "derived"
      : "generated";
  }
  if (nonEmptyString(routing?.studio_domain)) return "explicit";
  return nonEmptyString(routing?.custom_domain)
    || deriveStudioHostFromApiHost(routing?.api_domain)
    ? "derived"
    : "generated";
}

function endpointProjection(
  origin: string,
  source: EndpointSource,
  statusValue: EndpointStatus,
  aliases: string[] = [],
) {
  const parsed = new URL(origin);
  const host = parsed.hostname;
  const normalizedAliases = [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))]
    .filter((alias) => alias.toLowerCase() !== host.toLowerCase());
  return {
    origin: parsed.origin,
    host,
    aliases: normalizedAliases,
    source,
    status: statusValue,
    verification: ENDPOINT_VERIFICATION,
  };
}

export function projectEndpointProjection(project: ProjectEndpointInput) {
  const routing = normalizeProjectRoutingConfig(project.config);
  const projectStatus = publicProjectStatus(project.status);
  const statusValue = endpointStatus(projectStatus);
  const apiOrigin = resolveProjectApiUrl(project.ref, routing);
  const authOrigin = resolveProjectAuthUrl(project.ref, routing);
  const studioOrigin = resolveProjectStudioUrl(project.ref, routing);
  const apiHost = new URL(apiOrigin).hostname;
  const apiAliases = resolveProjectApiHosts(project.ref, routing)
    .filter((host) => host.toLowerCase() !== apiHost.toLowerCase());

  return {
    schema: PROJECT_ENDPOINT_PROJECTION_SCHEMA,
    project_ref: project.ref,
    project_name: project.name,
    project_status: projectStatus,
    endpoints: {
      api: endpointProjection(apiOrigin, endpointSource("api", routing), statusValue, apiAliases),
      auth: endpointProjection(authOrigin, endpointSource("auth", routing), statusValue),
      studio: endpointProjection(studioOrigin, endpointSource("studio", routing), statusValue),
    },
  };
}

const EndpointSourceSchema = t.Union([
  t.Literal("explicit"),
  t.Literal("derived"),
  t.Literal("generated"),
]);
const EndpointStatusSchema = t.Union([
  t.Literal("configured"),
  t.Literal("pending"),
  t.Literal("inactive"),
  t.Literal("unknown"),
]);
const EndpointProjectionSchema = t.Object(
  {
    origin: t.String(),
    host: t.String(),
    aliases: t.Array(t.String()),
    source: EndpointSourceSchema,
    status: EndpointStatusSchema,
    verification: t.Literal(ENDPOINT_VERIFICATION),
  },
  { additionalProperties: false },
);

export const ProjectEndpointProjectionResponseSchema = t.Object(
  {
    schema: t.Literal(PROJECT_ENDPOINT_PROJECTION_SCHEMA),
    project_ref: t.String(),
    project_name: t.String(),
    project_status: t.String(),
    endpoints: t.Object(
      {
        api: EndpointProjectionSchema,
        auth: EndpointProjectionSchema,
        studio: EndpointProjectionSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const AuthErrorSchema = t.Object({ message: t.String(), code: t.String() });
const NotFoundSchema = t.Object({ message: t.String(), code: t.Optional(t.String()) });

export const projectEndpointRoutes = new Elysia({ prefix: "/v1/projects" })
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
      const projects = await projectService.listProjectDetails();
      return projects.map(projectEndpointProjection);
    },
    {
      response: {
        200: t.Array(ProjectEndpointProjectionResponseSchema),
        401: AuthErrorSchema,
        403: AuthErrorSchema,
      },
      detail: { tags: ["projects"], summary: "List authoritative project endpoint projections" },
    },
  )
  .get(
    "/:ref/endpoints",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) {
        return status(authError.status as 401 | 403, {
          message: authError.body.error,
          code: String(authError.status),
        });
      }
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "404" });
      return projectEndpointProjection(project);
    },
    {
      params: t.Object({ ref: t.String({ minLength: 1 }) }),
      response: {
        200: ProjectEndpointProjectionResponseSchema,
        401: AuthErrorSchema,
        403: AuthErrorSchema,
        404: NotFoundSchema,
      },
      detail: { tags: ["projects"], summary: "Get authoritative project endpoint projection" },
    },
  );
