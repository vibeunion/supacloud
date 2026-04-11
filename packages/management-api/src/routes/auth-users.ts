import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { projectService } from "../services";

/**
 * User Management routes — Admin API proxy to GoTrue
 */
export const userManagementRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .get(
    "/users",
    async ({ params, query, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project || !project.jwt_secret) {
        return status(404, { error: "Project or JWT secret not found" });
      }

      const { jwtService } = await import("../services/jwt.service");
      const serviceRoleKey = await jwtService.generateServiceRoleKey(project.jwt_secret);
      const { config } = await import("../config");
      const apiUrl = project.api?.url || (config.kongInternal.startsWith('http') ? config.kongInternal : `http://${config.kongInternal}`);

      // Pass along pagination (svadmin uses _page / _limit or standard skip/limit)
      const limit = Number(query._limit || query.limit || 50);
      const page = Number(query._page || 1) || Math.floor(Number(query.skip || 0) / limit) + 1;
      const q = query.q;
      
      const searchParams = new URLSearchParams();
      searchParams.set("page", String(page));
      searchParams.set("per_page", String(limit));
      if (q) searchParams.set("q", String(q));

      const res = await fetch(`${apiUrl}/auth/v1/admin/users?${searchParams.toString()}`, {
        headers: {
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        }
      });

      if (!res.ok) {
        set.status = res.status;
        const err = await res.json().catch(() => ({}));
        return { error: err.msg || err.message || "Failed to fetch users" };
      }

      // P1-6: Forward link and total count headers for SDK pagination
      const linkHeader = res.headers.get("link");
      if (linkHeader) set.headers["link"] = linkHeader;
      const totalHeader = res.headers.get("x-total-count");
      if (totalHeader) set.headers["x-total-count"] = totalHeader;

      const d = await res.json() as Record<string, unknown>;
      
      // If GoTrue returned an array natively (older version), wrap it in the expected paginated structure.
      // Otherwise it already returns { users, aud, next_page, last_page, total }
      if (Array.isArray(d)) {
          const totalHeader = res.headers.get('x-total-count');
          return {
              users: d,
              aud: '',
              next_page: null,
              last_page: null,
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
    async ({ params, body, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project || !project.jwt_secret) {
        return status(404, { error: "Project or JWT secret not found" });
      }

      const { jwtService } = await import("../services/jwt.service");
      const serviceRoleKey = await jwtService.generateServiceRoleKey(project.jwt_secret);
      const { config } = await import("../config");
      const apiUrl = project.api?.url || (config.kongInternal.startsWith('http') ? config.kongInternal : `http://${config.kongInternal}`);

      const res = await fetch(`${apiUrl}/auth/v1/admin/users`, {
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
        return { error: err.msg || err.message || "Failed to create user" };
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
    async ({ params, body, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project || !project.jwt_secret) {
        return status(404, { error: "Project or JWT secret not found" });
      }

      const { jwtService } = await import("../services/jwt.service");
      const serviceRoleKey = await jwtService.generateServiceRoleKey(project.jwt_secret);
      const { config } = await import("../config");
      const apiUrl = project.api?.url || (config.kongInternal.startsWith('http') ? config.kongInternal : `http://${config.kongInternal}`);

      const res = await fetch(`${apiUrl}/auth/v1/invite`, {
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
          ...(body.redirectTo ? { redirect_to: body.redirectTo } : {})
        })
      });

      if (!res.ok) {
        set.status = res.status;
        const err = await res.json().catch(() => ({}));
        return { error: err.msg || err.message || "Failed to invite user" };
      }

      return res.json();
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        email: t.String(),
        user_metadata: t.Optional(t.Any()),
        redirectTo: t.Optional(t.String()),
      })
    }
  )

  // GET /users/:id — Get a single user by ID
  // supabase.auth.admin.getUserById(id)
  .get(
    "/users/:id",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project || !project.jwt_secret) {
        return status(404, { error: "Project or JWT secret not found" });
      }

      const { jwtService } = await import("../services/jwt.service");
      const serviceRoleKey = await jwtService.generateServiceRoleKey(project.jwt_secret);
      const { config } = await import("../config");
      const apiUrl = project.api?.url || (config.kongInternal.startsWith('http') ? config.kongInternal : `http://${config.kongInternal}`);

      const res = await fetch(`${apiUrl}/auth/v1/admin/users/${params.id}`, {
        headers: {
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        }
      });

      if (!res.ok) {
        set.status = res.status;
        const err = await res.json().catch(() => ({}));
        return { error: err.msg || err.message || "User not found" };
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

  // PUT /users/:id — Update a user by ID
  // supabase.auth.admin.updateUserById(id, { email, password, user_metadata, ... })
  .put(
    "/users/:id",
    async ({ params, body, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project || !project.jwt_secret) {
        return status(404, { error: "Project or JWT secret not found" });
      }

      const { jwtService } = await import("../services/jwt.service");
      const serviceRoleKey = await jwtService.generateServiceRoleKey(project.jwt_secret);
      const { config } = await import("../config");
      const apiUrl = project.api?.url || (config.kongInternal.startsWith('http') ? config.kongInternal : `http://${config.kongInternal}`);

      const res = await fetch(`${apiUrl}/auth/v1/admin/users/${params.id}`, {
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
        return { error: err.msg || err.message || "Failed to update user" };
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

  .delete(
    "/users/:id",
    async ({ params, set, body, query }) => {
      const project = await projectService.getProject(params.ref);
      if (!project || !project.jwt_secret) {
        return status(404, { error: "Project or JWT secret not found" });
      }

      const { jwtService } = await import("../services/jwt.service");
      const serviceRoleKey = await jwtService.generateServiceRoleKey(project.jwt_secret);
      const { config } = await import("../config");
      const apiUrl = project.api?.url || (config.kongInternal.startsWith('http') ? config.kongInternal : `http://${config.kongInternal}`);

      // P1-2: should_soft_delete should be in the body, not query params
      const url = `${apiUrl}/auth/v1/admin/users/${params.id}`;

      const res = await fetch(url, {
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
        return { error: err.msg || err.message || "Failed to delete user" };
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
  );
