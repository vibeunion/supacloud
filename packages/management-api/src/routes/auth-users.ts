import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { projectService } from "../services";

/**
 * User Management routes — Admin API proxy to GoTrue
 */
export const userManagementRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .post(
    "/users",
    async ({ params, body, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project || !project.jwt_secret) {
        return status(404, { error: "Project or JWT secret not found" });
      }

      const { jwtService } = await import("../services/jwt.service");
      const serviceRoleKey = await jwtService.generateServiceRoleKey(project.jwt_secret);
      const apiUrl = project.api?.url || `https://${params.ref}.supabase.co`;

      const res = await fetch(`${apiUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`
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
      const apiUrl = project.api?.url || `https://${params.ref}.supabase.co`;

      const res = await fetch(`${apiUrl}/auth/v1/invite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`
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
      const apiUrl = project.api?.url || `https://${params.ref}.supabase.co`;

      const res = await fetch(`${apiUrl}/auth/v1/admin/users/${params.id}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`
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
