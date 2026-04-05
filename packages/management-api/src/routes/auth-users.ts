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
      const apiUrl = project.api?.url || config.kongInternal;

      // Pass along pagination (svadmin uses _page / _limit or standard skip/limit)
      const limit = Number(query._limit || query.limit || 50);
      const page = Number(query._page || 1);
      const offset = Number(query.skip || (page - 1) * limit);
      
      const res = await fetch(`${apiUrl}/auth/v1/admin/users`, {
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

      const d = await res.json() as Record<string, unknown>;
      const allUsers = Array.isArray(d) ? d : (Array.isArray(d?.users) ? d.users : []);
      
      // Manual pagination if GoTrue doesn't paginate automatically
      const paginatedUsers = allUsers.slice(offset, offset + limit);

      return {
        data: paginatedUsers,
        total: allUsers.length
      };
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
      const apiUrl = project.api?.url || config.kongInternal;

      const res = await fetch(`${apiUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: JSON.stringify({
          email: body.email,
          password: body.password,
          email_confirm: body.email_confirm ?? true,
          user_metadata: body.user_metadata || {},
          app_metadata: body.app_metadata || {}
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
        email: t.String(),
        password: t.String(),
        email_confirm: t.Optional(t.Boolean()),
        user_metadata: t.Optional(t.Any()),
        app_metadata: t.Optional(t.Any()),
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
      const apiUrl = project.api?.url || config.kongInternal;

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
          data: body.user_metadata || {}
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
      })
    }
  )

  .delete(
    "/users/:id",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project || !project.jwt_secret) {
        return status(404, { error: "Project or JWT secret not found" });
      }

      const { jwtService } = await import("../services/jwt.service");
      const serviceRoleKey = await jwtService.generateServiceRoleKey(project.jwt_secret);
      const { config } = await import("../config");
      const apiUrl = project.api?.url || config.kongInternal;

      const res = await fetch(`${apiUrl}/auth/v1/admin/users/${params.id}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        }
      });

      if (!res.ok) {
        set.status = res.status;
        const err = await res.json().catch(() => ({}));
        return { error: err.msg || err.message || "Failed to delete user" };
      }

      return { success: true, id: params.id };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      })
    }
  );
