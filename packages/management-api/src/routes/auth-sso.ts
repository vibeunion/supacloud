import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { logger } from "../utils/logger";
import { resolveProjectServiceRoleKey } from "../utils/service-role";
import { resolveTenantPorts, normalizeProjectRoutingConfig } from "../utils/project-routing";
import { normalizeProjectConfig } from "../utils/project-config";
import { requireAuthRuntimeManagement } from "./auth-runtime";

async function getGoTrueHeaders(ref: string) {
  const project = await projectService.getProject(ref);
  if (!project) return null;
  const serviceRoleKey = await resolveProjectServiceRoleKey(ref);
  if (!serviceRoleKey) return null;
  const { config } = await import("../config");
  const projectConfig = normalizeProjectConfig(project.config);
  const routingConfig = normalizeProjectRoutingConfig(projectConfig);
  const ports = resolveTenantPorts(routingConfig);
  const apiUrl = ports?.gotruePort
    ? `http://127.0.0.1:${ports.gotruePort}`
    : `http://${config.managementApiInternal}/auth/v1`;

  return { apiUrl, serviceRoleKey, ref };
}

export const authSsoRoutes = new Elysia({ prefix: "/v1/projects" })
  .onBeforeHandle(requireAuthRuntimeManagement("sso"))

  .get(
    "/:ref/auth/sso/providers",
    async ({ params, set }) => {
      const ctx = await getGoTrueHeaders(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });

      try {
        const res = await fetch(`${ctx.apiUrl}/admin/sso/providers`, {
          headers: {
            "apikey": ctx.serviceRoleKey,
            "Authorization": `Bearer ${ctx.serviceRoleKey}`,
            "x-project-ref": ctx.ref
          }
        });
        if (!res.ok) {
          set.status = res.status;
          const err = await res.json().catch(() => ({}));
          return { message: err.msg || err.message || "Failed to list SSO providers" };
        }
        return res.json();
      } catch (err: unknown) {
        logger.warn("[auth-sso] Failed to list SSO providers", { error: err instanceof Error ? err.message : String(err) });
        return status(503, {
          message: "GoTrue SSO provider service is unavailable",
          code: "SERVICE_UNAVAILABLE",
          reason_code: "gotrue_sso_unavailable",
        });
      }
    },
    { params: t.Object({ ref: t.String() }), detail: { tags: ["auth"], summary: "List SSO providers" } }
  )

  .post(
    "/:ref/auth/sso/providers",
    async ({ params, body, set }) => {
      const ctx = await getGoTrueHeaders(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });

      try {
        const res = await fetch(`${ctx.apiUrl}/admin/sso/providers`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": ctx.serviceRoleKey,
            "Authorization": `Bearer ${ctx.serviceRoleKey}`,
            "x-project-ref": ctx.ref
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          set.status = res.status;
          const err = await res.json().catch(() => ({}));
          return { message: err.msg || err.message || "Failed to create SSO provider", code: err.code || "500" };
        }
        return res.json();
      } catch (err: unknown) {
        return status(500, { message: "Failed to create SSO provider", code: "500", details: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        type: t.Literal("saml"),
        resource_id: t.Optional(t.String()),
        domains: t.Optional(t.Array(t.String())),
        metadata_xml: t.Optional(t.String()),
        metadata_url: t.Optional(t.String()),
        attribute_mapping: t.Optional(t.Record(t.String(), t.Unknown())),
        name_id_format: t.Optional(t.String()),
        disabled: t.Optional(t.Boolean()),
      }),
      detail: { tags: ["auth"], summary: "Create SSO provider" },
    }
  )

  .get(
    "/:ref/auth/sso/providers/:id",
    async ({ params, set }) => {
      const ctx = await getGoTrueHeaders(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });

      try {
        const res = await fetch(`${ctx.apiUrl}/admin/sso/providers/${params.id}`, {
          headers: {
            "apikey": ctx.serviceRoleKey,
            "Authorization": `Bearer ${ctx.serviceRoleKey}`,
            "x-project-ref": ctx.ref
          }
        });
        if (!res.ok) {
          set.status = res.status;
          const err = await res.json().catch(() => ({}));
          return { message: err.msg || err.message || "SSO provider not found" };
        }
        return res.json();
      } catch (err: unknown) {
        return status(500, { message: "Failed to get SSO provider", code: "500", details: err instanceof Error ? err.message : String(err) });
      }
    },
    { params: t.Object({ ref: t.String(), id: t.String() }), detail: { tags: ["auth"], summary: "Get SSO provider" } }
  )

  .put(
    "/:ref/auth/sso/providers/:id",
    async ({ params, body, set }) => {
      const ctx = await getGoTrueHeaders(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });

      try {
        const res = await fetch(`${ctx.apiUrl}/admin/sso/providers/${params.id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "apikey": ctx.serviceRoleKey,
            "Authorization": `Bearer ${ctx.serviceRoleKey}`,
            "x-project-ref": ctx.ref
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          set.status = res.status;
          const err = await res.json().catch(() => ({}));
          return { message: err.msg || err.message || "Failed to update SSO provider", code: err.code || "500" };
        }
        return res.json();
      } catch (err: unknown) {
        return status(500, { message: "Failed to update SSO provider", code: "500", details: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      params: t.Object({ ref: t.String(), id: t.String() }),
      body: t.Object({
        type: t.Optional(t.Literal("saml")),
        resource_id: t.Optional(t.String()),
        domains: t.Optional(t.Array(t.String())),
        metadata_xml: t.Optional(t.String()),
        metadata_url: t.Optional(t.String()),
        attribute_mapping: t.Optional(t.Record(t.String(), t.Unknown())),
        name_id_format: t.Optional(t.String()),
        disabled: t.Optional(t.Boolean()),
      }),
      detail: { tags: ["auth"], summary: "Update SSO provider" },
    }
  )

  .delete(
    "/:ref/auth/sso/providers/:id",
    async ({ params, set }) => {
      const ctx = await getGoTrueHeaders(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });

      try {
        const res = await fetch(`${ctx.apiUrl}/admin/sso/providers/${params.id}`, {
          method: "DELETE",
          headers: {
            "apikey": ctx.serviceRoleKey,
            "Authorization": `Bearer ${ctx.serviceRoleKey}`,
            "x-project-ref": ctx.ref
          }
        });
        if (!res.ok) {
          set.status = res.status;
          const err = await res.json().catch(() => ({}));
          return { message: err.msg || err.message || "Failed to delete SSO provider" };
        }
        return res.json();
      } catch (err: unknown) {
        return status(500, { message: "Failed to delete SSO provider", code: "500", details: err instanceof Error ? err.message : String(err) });
      }
    },
    { params: t.Object({ ref: t.String(), id: t.String() }), detail: { tags: ["auth"], summary: "Delete SSO provider" } }
  );
