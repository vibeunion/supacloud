import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { projectService } from "../services";
import { resolveProjectServiceRoleKey } from "../utils/service-role";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { sql as metaSql } from "../db";
import { resolveTenantPorts, normalizeProjectRoutingConfig } from "../utils/project-routing";
import { normalizeProjectConfig } from "../utils/project-config";

async function getGoTrueAdminContext(ref: string) {
  const project = await projectService.getProject(ref);
  if (!project) return null;

  const serviceRoleKey = await resolveProjectServiceRoleKey(ref);
  if (!serviceRoleKey) return null;

  const { config } = await import("../config");

  let apiUrl: string;
  try {
    const rows = await metaSql`
      SELECT config FROM projects WHERE ref = ${ref} AND deleted_at IS NULL LIMIT 1
    `;
    const projectConfig = normalizeProjectConfig(rows[0]?.config);
    const routingConfig = normalizeProjectRoutingConfig(projectConfig);
    const ports = resolveTenantPorts(routingConfig);
    if (ports?.gotruePort) {
      apiUrl = `http://127.0.0.1:${ports.gotruePort}`;
    } else {
      apiUrl = config.kongInternal.startsWith("http")
        ? config.kongInternal
        : `http://${config.kongInternal}`;
    }
  } catch {
    apiUrl = config.kongInternal.startsWith("http")
      ? config.kongInternal
      : `http://${config.kongInternal}`;
  }

  return { project, apiUrl, serviceRoleKey };
}

async function gotrueFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("self signed certificate") || msg.includes("CERT") || msg.includes("ECONNREFUSED") || msg.includes("connect")) {
      throw new Error(`Auth service unavailable: ${msg}`);
    }
    throw err;
  }
}

/**
 * User Management routes — Admin API proxy to GoTrue
 */
export const userManagementRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .get(
    "/users",
    async ({ params, query, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const limit = Number(query.per_page || query._limit || query.limit || 50);
      const page = Number(query.page || query._page || 1) || Math.floor(Number(query.skip || 0) / limit) + 1;
      const q = query.q;
      
      const searchParams = new URLSearchParams();
      searchParams.set("page", String(page));
      searchParams.set("per_page", String(limit));
      if (q) searchParams.set("q", String(q));

      const res = await gotrueFetch(`${apiUrl}/admin/users?${searchParams.toString()}`, {
        headers: {
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        }
      });

      if (!res.ok) {
        set.status = res.status;
        const err = await res.json().catch(() => ({}));
        return { message: err.msg || err.message || "Failed to fetch users", code: err.code || "500" };
      }

      const linkHeader = res.headers.get("link");
      if (linkHeader) set.headers["link"] = linkHeader;
      const totalHeader = res.headers.get("x-total-count");
      if (totalHeader) set.headers["x-total-count"] = totalHeader;

      const d = await res.json() as Record<string, unknown>;
      
      if (Array.isArray(d)) {
          const totalHeader = res.headers.get('x-total-count');
          const linkHeader = res.headers.get('link');
          let nextPage: number | null = null;
          let lastPage: number | null = null;
          if (linkHeader) {
            const lastMatch = linkHeader.match(/page=(\d+)[^>]*>; rel="last"/);
            const nextMatch = linkHeader.match(/page=(\d+)[^>]*>; rel="next"/);
            if (lastMatch) lastPage = parseInt(lastMatch[1], 10);
            if (nextMatch) nextPage = parseInt(nextMatch[1], 10);
          }
          return {
              users: d,
              aud: 'authenticated',
              next_page: nextPage,
              last_page: lastPage,
              total: totalHeader ? Number(totalHeader) : d.length
          };
      }
      return d;
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Object({
        skip: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        page: t.Optional(t.String()),
        per_page: t.Optional(t.String()),
        _page: t.Optional(t.String()),
        _limit: t.Optional(t.String()),
        _sort: t.Optional(t.String()),
        _order: t.Optional(t.String()),
        q: t.Optional(t.String()),
      }, { additionalProperties: true })
    }
  )
  .post(
    "/users",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/admin/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: JSON.stringify({
          ...(body.email !== undefined ? { email: body.email } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.password !== undefined ? { password: body.password } : {}),
          ...(body.email_confirm !== undefined ? { email_confirm: body.email_confirm } : {}),
          ...(body.phone_confirm !== undefined ? { phone_confirm: body.phone_confirm } : {}),
          ...(body.user_metadata !== undefined ? { user_metadata: body.user_metadata } : {}),
          ...(body.app_metadata !== undefined ? { app_metadata: body.app_metadata } : {}),
          ...(body.nonce !== undefined ? { nonce: body.nonce } : {}),
          ...(body.ban_duration !== undefined ? { ban_duration: body.ban_duration } : {}),
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.password_hash !== undefined ? { password_hash: body.password_hash } : {}),
          ...(body.id !== undefined ? { id: body.id } : {}),
          ...(body.current_password !== undefined ? { current_password: body.current_password } : {})
        })
      });

      if (!res.ok) {
        set.status = res.status;
        const err = await res.json().catch(() => ({}));
        return { message: err.msg || err.message || "Failed to create user", code: err.code || "500" };
      }

      return res.json();
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        email: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        password: t.Optional(t.String()),
        email_confirm: t.Optional(t.Boolean()),
        phone_confirm: t.Optional(t.Boolean()),
        user_metadata: t.Optional(t.Any()),
        app_metadata: t.Optional(t.Any()),
        nonce: t.Optional(t.String()),
        ban_duration: t.Optional(t.String()),
        role: t.Optional(t.String()),
        password_hash: t.Optional(t.String()),
        id: t.Optional(t.String()),
        current_password: t.Optional(t.String()),
      })
    }
  )

  .post(
    "/users/invite",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/invite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: JSON.stringify({
          email: body.email,
          data: body.user_metadata || {},
          ...(body.redirectTo ? { redirect_to: body.redirectTo } : {}),
          ...(body.app_metadata ? { app_metadata: body.app_metadata } : {}),
        })
      });

      if (!res.ok) {
        set.status = res.status;
        const err = await res.json().catch(() => ({}));
        return { message: err.msg || err.message || "Failed to invite user", code: err.code || "500" };
      }

      return res.json();
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        email: t.String(),
        user_metadata: t.Optional(t.Any()),
        app_metadata: t.Optional(t.Any()),
        redirectTo: t.Optional(t.String()),
      })
    }
  )

  .get(
    "/users/:id",
    async ({ params, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/admin/users/${params.id}`, {
        headers: {
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        }
      });

      if (!res.ok) {
        set.status = res.status;
        const err = await res.json().catch(() => ({}));
        return { message: err.msg || err.message || "User not found", code: err.code || "500" };
      }

      return res.json();
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      })
    }
  )

  .put(
    "/users/:id",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/admin/users/${params.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        set.status = res.status;
        const err = await res.json().catch(() => ({}));
        return { message: err.msg || err.message || "Failed to update user", code: err.code || "500" };
      }

      return res.json();
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        email: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        password: t.Optional(t.String()),
        email_confirm: t.Optional(t.Boolean()),
        phone_confirm: t.Optional(t.Boolean()),
        user_metadata: t.Optional(t.Any()),
        app_metadata: t.Optional(t.Any()),
        ban_duration: t.Optional(t.String()),
        role: t.Optional(t.String()),
      })
    }
  )

  .patch(
    "/users/:id",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/admin/users/${params.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { message: err.msg || err.message || "Failed to update user", code: err.code || "500" };
      }

      return res.json();
    },
    {
      params: t.Object({ ref: t.String(), id: t.String() }),
      body: t.Object({
        email: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        password: t.Optional(t.String()),
        email_confirm: t.Optional(t.Boolean()),
        phone_confirm: t.Optional(t.Boolean()),
        user_metadata: t.Optional(t.Any()),
        app_metadata: t.Optional(t.Any()),
        ban_duration: t.Optional(t.String()),
        role: t.Optional(t.String()),
      })
    }
  )

  .delete(
    "/users/:id",
    async ({ params, set, body, query, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const url = `${apiUrl}/admin/users/${params.id}`;

      const res = await gotrueFetch(url, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: body && Object.keys(body).length > 0 ? JSON.stringify(body) : undefined
      });

      if (!res.ok) {
        set.status = res.status;
        const err = await res.json().catch(() => ({}));
        return { message: err.msg || err.message || "Failed to delete user", code: err.code || "500" };
      }

      return res.json();
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Optional(t.Any())
    }
  )

  .get(
    "/users/:id/factors",
    async ({ params, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/admin/users/${params.id}/factors`, {
        headers: {
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        }
      });

      if (!res.ok) {
        set.status = res.status;
        const err = await res.json().catch(() => ({}));
        return { message: err.msg || err.message || "Failed to list factors", code: err.code || "500" };
      }

      return res.json();
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      })
    }
  )

  .post(
    "/generate_link",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/admin/generate_link`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        set.status = res.status;
        const err = await res.json().catch(() => ({}));
        return { message: err.msg || err.message || "Failed to generate link", code: err.code || "500" };
      }

      return res.json();
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        type: t.String(),
        email: t.Optional(t.String()),
        password: t.Optional(t.String()),
        new_email: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        new_phone: t.Optional(t.String()),
        redirect_to: t.Optional(t.String()),
        data: t.Optional(t.Record(t.String(), t.Unknown())),
        gotrue_meta_security: t.Optional(t.Record(t.String(), t.Unknown())),
      }, { additionalProperties: true }),
    }
  );
