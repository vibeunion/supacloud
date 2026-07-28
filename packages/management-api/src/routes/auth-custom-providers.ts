import { Elysia, status, t } from "elysia";
import { config } from "../config";
import { projectService } from "../services";
import { getAuthRuntimeDescriptor } from "../services/auth-runtime.service";
import { logger } from "../utils/logger";
import { normalizeProjectConfig } from "../utils/project-config";
import { normalizeProjectRoutingConfig, resolveTenantPorts } from "../utils/project-routing";
import { resolveProjectServiceRoleKey } from "../utils/service-role";
import { requireAuthRuntimeManagement } from "./auth-runtime";

const GOTRUE_ADMIN_TIMEOUT_MS = 10_000;

async function loadCustomProviderContext(ref: string) {
  const authorityRef = getAuthRuntimeDescriptor(ref).authority_project_ref;
  const project = await projectService.getProject(authorityRef);
  if (!project) return null;
  const serviceRoleKey = await resolveProjectServiceRoleKey(project);
  if (!serviceRoleKey) return null;
  const projectConfig = normalizeProjectConfig(project.config);
  const ports = resolveTenantPorts(normalizeProjectRoutingConfig(projectConfig));
  const apiUrl = ports?.gotruePort
    ? `http://127.0.0.1:${ports.gotruePort}`
    : `http://${config.managementApiInternal}/auth/v1`;
  return { apiUrl, authorityRef, serviceRoleKey };
}

async function proxyCustomProviderAdmin(
  ref: string,
  path: string,
  init: RequestInit = {},
) {
  const ctx = await loadCustomProviderContext(ref);
  if (!ctx) return status(404, { message: "Project not found", code: "404" });
  const headers = new Headers(init.headers);
  headers.set("apikey", ctx.serviceRoleKey);
  headers.set("authorization", `Bearer ${ctx.serviceRoleKey}`);
  headers.set("x-project-ref", ctx.authorityRef);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");

  try {
    const upstream = await fetch(`${ctx.apiUrl}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(GOTRUE_ADMIN_TIMEOUT_MS),
    });
    const responseHeaders = new Headers();
    for (const headerName of ["content-type", "location", "retry-after"]) {
      const value = upstream.headers.get(headerName);
      if (value) responseHeaders.set(headerName, value);
    }
    return new Response(upstream.status === 204 || upstream.status === 304 ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error: unknown) {
    logger.warn("[auth-custom-providers] GoTrue admin endpoint unavailable", {
      ref,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return status(503, {
      message: "GoTrue custom OAuth/OIDC provider service is unavailable",
      code: "SERVICE_UNAVAILABLE",
      reason_code: "gotrue_custom_oauth_unavailable",
    });
  }
}

export const authCustomProviderRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth/custom-providers" })
  .onBeforeHandle(requireAuthRuntimeManagement("providers"))
  .get("/", ({ params, query }) => {
    const search = query.type ? `?type=${encodeURIComponent(query.type)}` : "";
    return proxyCustomProviderAdmin(params.ref, `/admin/custom-providers${search}`);
  }, {
    params: t.Object({ ref: t.String() }),
    query: t.Object({ type: t.Optional(t.Union([t.Literal("oauth2"), t.Literal("oidc")])) }),
    detail: { tags: ["auth"], summary: "List custom OAuth/OIDC providers" },
  })
  .post("/", ({ params, body }) => proxyCustomProviderAdmin(params.ref, "/admin/custom-providers", {
    method: "POST",
    body: JSON.stringify(body),
  }), {
    params: t.Object({ ref: t.String() }),
    body: t.Record(t.String(), t.Unknown()),
    detail: { tags: ["auth"], summary: "Create custom OAuth/OIDC provider" },
  })
  .get("/:identifier", ({ params }) => proxyCustomProviderAdmin(
    params.ref,
    `/admin/custom-providers/${encodeURIComponent(params.identifier)}`,
  ), {
    params: t.Object({ ref: t.String(), identifier: t.String() }),
    detail: { tags: ["auth"], summary: "Get custom OAuth/OIDC provider" },
  })
  .put("/:identifier", ({ params, body }) => proxyCustomProviderAdmin(
    params.ref,
    `/admin/custom-providers/${encodeURIComponent(params.identifier)}`,
    { method: "PUT", body: JSON.stringify(body) },
  ), {
    params: t.Object({ ref: t.String(), identifier: t.String() }),
    body: t.Record(t.String(), t.Unknown()),
    detail: { tags: ["auth"], summary: "Update custom OAuth/OIDC provider" },
  })
  .delete("/:identifier", ({ params }) => proxyCustomProviderAdmin(
    params.ref,
    `/admin/custom-providers/${encodeURIComponent(params.identifier)}`,
    { method: "DELETE" },
  ), {
    params: t.Object({ ref: t.String(), identifier: t.String() }),
    detail: { tags: ["auth"], summary: "Delete custom OAuth/OIDC provider" },
  });
