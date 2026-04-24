import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { logger } from "../utils/logger";
import { resolveProjectServiceRoleKey } from "../utils/service-role";

async function getGoTrueHeaders(ref: string) {
  const project = await projectService.getProject(ref);
  if (!project) return null;
  const serviceRoleKey = await resolveProjectServiceRoleKey(ref);
  if (!serviceRoleKey) return null;
  const { config } = await import("../config");
  const apiUrl = project.api?.url || (config.kongInternal.startsWith('http') ? config.kongInternal : `http://${config.kongInternal}`);
  return { apiUrl, serviceRoleKey, ref };
}

export const authSsoRoutes = new Elysia({ prefix: "/v1/projects" })

  .get(
    "/:ref/auth/sso/providers",
    async ({ params, set }) => {
      const ctx = await getGoTrueHeaders(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });

      try {
        const res = await fetch(`${ctx.apiUrl}/auth/v1/admin/sso/providers`, {
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
        return [];
      }
    },
    { params: t.Object({ ref: t.String() }) }
  )

  .post(
    "/:ref/auth/sso/providers",
    async ({ params, body, set }) => {
      const ctx = await getGoTrueHeaders(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });

      try {
        const res = await fetch(`${ctx.apiUrl}/auth/v1/admin/sso/providers`, {
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
        resource_id: t.Optional(t.String()),
        saml_provider_name: t.Optional(t.String()),
        domains: t.Optional(t.Array(t.String())),
        metadata_xml: t.Optional(t.String()),
        metadata_url: t.Optional(t.String()),
        metadata_attribute_url: t.Optional(t.String()),
        entity_id: t.Optional(t.String()),
        attribute_mapping: t.Optional(t.Record(t.String(), t.Unknown())),
      })
    }
  )

  .get(
    "/:ref/auth/sso/providers/:id",
    async ({ params, set }) => {
      const ctx = await getGoTrueHeaders(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });

      try {
        const res = await fetch(`${ctx.apiUrl}/auth/v1/admin/sso/providers/${params.id}`, {
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
    { params: t.Object({ ref: t.String(), id: t.String() }) }
  )

  .put(
    "/:ref/auth/sso/providers/:id",
    async ({ params, body, set }) => {
      const ctx = await getGoTrueHeaders(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });

      try {
        const res = await fetch(`${ctx.apiUrl}/auth/v1/admin/sso/providers/${params.id}`, {
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
        resource_id: t.Optional(t.String()),
        saml_provider_name: t.Optional(t.String()),
        domains: t.Optional(t.Array(t.String())),
        metadata_xml: t.Optional(t.String()),
        metadata_url: t.Optional(t.String()),
        metadata_attribute_url: t.Optional(t.String()),
        attribute_mapping: t.Optional(t.Record(t.String(), t.Unknown())),
      })
    }
  )

  .delete(
    "/:ref/auth/sso/providers/:id",
    async ({ params, set }) => {
      const ctx = await getGoTrueHeaders(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });

      try {
        const res = await fetch(`${ctx.apiUrl}/auth/v1/admin/sso/providers/${params.id}`, {
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
    { params: t.Object({ ref: t.String(), id: t.String() }) }
  );
