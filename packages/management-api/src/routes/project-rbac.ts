import { Elysia, status, t } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { projectRbacService } from "../services/project-rbac.service";

function toHttpError(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : 500;
  const message = error instanceof Error ? error.message : "RBAC request failed";
  return status(statusCode, { message, code: String(statusCode) });
}

export const projectRbacRoutes = new Elysia({ prefix: "/v1/projects/:ref" })
  .onBeforeHandle(async ({ params, request }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("/rbac/roles", async ({ params }) => {
    try {
      const roles = await projectRbacService.listRoles(params.ref);
      return { items: roles, total: roles.length };
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    detail: { tags: ["rbac"], summary: "List project RBAC roles" },
  })
  .post("/rbac/roles", async ({ params, body }) => {
    try {
      return await projectRbacService.createRole(params.ref, body);
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    body: t.Object({
      name: t.String(),
      description: t.Optional(t.Nullable(t.String())),
    }, { additionalProperties: true }),
    detail: { tags: ["rbac"], summary: "Create project RBAC role" },
  })
  .get("/rbac/roles/:roleId", async ({ params }) => {
    try {
      return await projectRbacService.getRole(params.ref, params.roleId);
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    detail: { tags: ["rbac"], summary: "Get project RBAC role" },
  })
  .put("/rbac/roles/:roleId", async ({ params, body }) => {
    try {
      return await projectRbacService.updateRole(params.ref, params.roleId, body);
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    body: t.Object({
      name: t.Optional(t.String()),
      description: t.Optional(t.Nullable(t.String())),
    }, { additionalProperties: true }),
    detail: { tags: ["rbac"], summary: "Update project RBAC role" },
  })
  .delete("/rbac/roles/:roleId", async ({ params }) => {
    try {
      await projectRbacService.deleteRole(params.ref, params.roleId);
      return { deleted: true, role_id: params.roleId };
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    detail: { tags: ["rbac"], summary: "Delete project RBAC role" },
  })
  .get("/rbac/roles/:roleId/permissions", async ({ params }) => {
    try {
      const permissions = await projectRbacService.listRolePermissions(params.ref, params.roleId);
      return { items: permissions, total: permissions.length };
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    detail: { tags: ["rbac"], summary: "List project RBAC role permissions" },
  })
  .post("/rbac/roles/:roleId/permissions", async ({ params, body }) => {
    try {
      return await projectRbacService.createPermission(params.ref, params.roleId, body);
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    body: t.Object({
      name: t.String(),
      description: t.Optional(t.Nullable(t.String())),
      resource_id: t.Optional(t.Nullable(t.String())),
      resourceId: t.Optional(t.Nullable(t.String())),
      scope_id: t.Optional(t.Nullable(t.String())),
      scopeId: t.Optional(t.Nullable(t.String())),
    }, { additionalProperties: true }),
    detail: { tags: ["rbac"], summary: "Create project RBAC permission" },
  })
  .delete("/rbac/roles/:roleId/permissions/:permissionId", async ({ params }) => {
    try {
      await projectRbacService.deletePermission(params.ref, params.roleId, params.permissionId);
      return { deleted: true, permission_id: params.permissionId };
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    detail: { tags: ["rbac"], summary: "Delete project RBAC permission" },
  })
  .post("/rbac/roles/:roleId/assign", async ({ params, body }) => {
    try {
      return await projectRbacService.assignRole(params.ref, params.roleId, body);
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    body: t.Object({
      user_id: t.Optional(t.Nullable(t.String())),
      userId: t.Optional(t.Nullable(t.String())),
      organization_id: t.Optional(t.Nullable(t.String())),
      organizationId: t.Optional(t.Nullable(t.String())),
      application_id: t.Optional(t.Nullable(t.String())),
      applicationId: t.Optional(t.Nullable(t.String())),
    }, { additionalProperties: true }),
    detail: { tags: ["rbac"], summary: "Assign project RBAC role" },
  })
  .delete("/rbac/roles/:roleId/assign/:assignmentId", async ({ params }) => {
    try {
      await projectRbacService.revokeRole(params.ref, params.roleId, params.assignmentId);
      return { deleted: true, assignment_id: params.assignmentId };
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    detail: { tags: ["rbac"], summary: "Revoke project RBAC role assignment" },
  })
  .get("/auth/users/:id/roles", async ({ params, query }) => {
    try {
      const assignments = await projectRbacService.listUserRoleAssignments(params.ref, params.id, query.application_id);
      return { items: assignments, total: assignments.length };
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    query: t.Object({
      application_id: t.Optional(t.String()),
    }, { additionalProperties: true }),
    detail: { tags: ["rbac"], summary: "List project RBAC roles assigned to a user" },
  })
  .get("/auth/users/:id/permissions", async ({ params, query }) => {
    try {
      return await projectRbacService.resolveUserPermissions(params.ref, params.id, query.org_id, query.application_id);
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    query: t.Object({
      org_id: t.Optional(t.String()),
      application_id: t.Optional(t.String()),
    }, { additionalProperties: true }),
    detail: { tags: ["rbac"], summary: "Resolve project RBAC permissions for a user" },
  })
  .get("/organizations/:orgId/roles", async ({ params }) => {
    try {
      const assignments = await projectRbacService.listOrganizationRoleAssignments(params.ref, params.orgId);
      return { items: assignments, total: assignments.length };
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    detail: { tags: ["rbac"], summary: "List project RBAC assignments for an organization" },
  });
