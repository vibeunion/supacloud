import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { projectService } from "../services";
import { resolveProjectServiceRoleKey } from "../utils/service-role";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { sql as metaSql } from "../db";
import { resolveTenantPorts, normalizeProjectRoutingConfig } from "../utils/project-routing";
import { normalizeProjectConfig } from "../utils/project-config";
import { requireAuthRuntimeManagement } from "./auth-runtime";

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
    apiUrl = ports?.gotruePort
      ? `http://127.0.0.1:${ports.gotruePort}`
      : `http://${config.managementApiInternal}/auth/v1`;
  } catch {
    apiUrl = `http://${config.managementApiInternal}/auth/v1`;
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

async function readGoTrueError(res: Response, fallbackMessage: string) {
  const text = await res.text().catch(() => "");
  let parsed: unknown;
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (parsed !== null && typeof parsed === "object") {
    const body = parsed as Record<string, unknown>;
    return {
      message: readOptionalString(body.msg) ?? readOptionalString(body.message) ?? fallbackMessage,
      code: readOptionalString(body.code) ?? String(res.status)
    };
  }

  return {
    message: text.trim().length > 0 && text.trim() !== "null" ? text.trim() : fallbackMessage,
    code: String(res.status)
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * User Management routes — Admin API proxy to GoTrue
 */
export const userManagementRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .onBeforeHandle(requireAuthRuntimeManagement("users"))
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
        return readGoTrueError(res, "Failed to fetch users");
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
      }, { additionalProperties: true }),
      detail: { tags: ["auth"], summary: "List users" },
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
        return readGoTrueError(res, "Failed to create user");
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
      }),
      detail: { tags: ["auth"], summary: "Create user" },
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
        return readGoTrueError(res, "Failed to invite user");
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
      }),
      detail: { tags: ["auth"], summary: "Invite user by email" },
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
        return readGoTrueError(res, "User not found");
      }

      return res.json();
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      detail: { tags: ["auth"], summary: "Get user" },
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
        return readGoTrueError(res, "Failed to update user");
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
      }),
      detail: { tags: ["auth"], summary: "Replace user" },
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
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        set.status = res.status;
        return readGoTrueError(res, "Failed to update user");
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
      }),
      detail: { tags: ["auth"], summary: "Update user" },
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
        return readGoTrueError(res, "Failed to delete user");
      }

      return res.json();
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Optional(t.Any()),
      detail: { tags: ["auth"], summary: "Delete user" },
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
        return readGoTrueError(res, "Failed to list factors");
      }

      return res.json();
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      detail: { tags: ["auth"], summary: "List user MFA factors" },
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
        return readGoTrueError(res, "Failed to generate link");
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
      detail: { tags: ["auth"], summary: "Generate auth link" },
    }
  );
