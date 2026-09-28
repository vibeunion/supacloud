import { Elysia, status, t } from "elysia";
import { getVerifiedRequestPrincipal, requireProjectOrAdminAuth } from "../middleware/auth";
import { projectRbacService } from "../services/project-rbac.service";
import { projectOrganizationService } from "../services/project-organization.service";

function toHttpError(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : 500;
  const message = error instanceof Error ? error.message : "RBAC request failed";
  return status(statusCode, { message, code: String(statusCode) });
}

async function actorId(request: Request): Promise<string> {
  return (await getVerifiedRequestPrincipal(request))!.id;
}

export const projectRbacRoutes = new Elysia({ prefix: "/v1/projects/:ref" })
  .beforeHandle(async ({ params, request }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("/rbac/roles", {
    detail: { tags: ["rbac"], summary: "List project RBAC roles" },
  }, async ({ params }) => {
    try {
      const roles = await projectRbacService.listRoles(params.ref);
      return { items: roles, total: roles.length };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/rbac/roles", {
    body: t.Object({
      name: t.String(),
      description: t.Optional(t.Nullable(t.String())),
    }, { additionalProperties: true }),
    detail: { tags: ["rbac"], summary: "Create project RBAC role" },
  }, async ({ params, body }) => {
    try {
      return await projectRbacService.createRole(params.ref, body);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/rbac/roles/:roleId", {
    detail: { tags: ["rbac"], summary: "Get project RBAC role" },
  }, async ({ params }) => {
    try {
      return await projectRbacService.getRole(params.ref, params.roleId);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .put("/rbac/roles/:roleId", {
    body: t.Object({
      name: t.Optional(t.String()),
      description: t.Optional(t.Nullable(t.String())),
    }, { additionalProperties: true }),
    detail: { tags: ["rbac"], summary: "Update project RBAC role" },
  }, async ({ params, body }) => {
    try {
      return await projectRbacService.updateRole(params.ref, params.roleId, body);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .delete("/rbac/roles/:roleId", {
    detail: { tags: ["rbac"], summary: "Delete project RBAC role" },
  }, async ({ params }) => {
    try {
      await projectRbacService.deleteRole(params.ref, params.roleId);
      return { deleted: true, role_id: params.roleId };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/rbac/roles/:roleId/permissions", {
    detail: { tags: ["rbac"], summary: "List project RBAC role permissions" },
  }, async ({ params }) => {
    try {
      const permissions = await projectRbacService.listRolePermissions(params.ref, params.roleId);
      return { items: permissions, total: permissions.length };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/rbac/roles/:roleId/permissions", {
    body: t.Object({
      name: t.String(),
      description: t.Optional(t.Nullable(t.String())),
      resource_id: t.Optional(t.Nullable(t.String())),
      resourceId: t.Optional(t.Nullable(t.String())),
      scope_id: t.Optional(t.Nullable(t.String())),
      scopeId: t.Optional(t.Nullable(t.String())),
    }, { additionalProperties: true }),
    detail: { tags: ["rbac"], summary: "Create project RBAC permission" },
  }, async ({ params, body }) => {
    try {
      return await projectRbacService.createPermission(params.ref, params.roleId, body);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .delete("/rbac/roles/:roleId/permissions/:permissionId", {
    detail: { tags: ["rbac"], summary: "Delete project RBAC permission" },
  }, async ({ params }) => {
    try {
      await projectRbacService.deletePermission(params.ref, params.roleId, params.permissionId);
      return { deleted: true, permission_id: params.permissionId };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/rbac/roles/:roleId/assign", {
    detail: { tags: ["rbac"], summary: "List project RBAC role assignments" },
  }, async ({ params }) => {
    try {
      const assignments = await projectRbacService.listRoleAssignments(params.ref, params.roleId);
      return { items: assignments, total: assignments.length };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/rbac/roles/:roleId/assign", {
    body: t.Object({
      user_id: t.Optional(t.Nullable(t.String())),
      userId: t.Optional(t.Nullable(t.String())),
      organization_id: t.Optional(t.Nullable(t.String())),
      organizationId: t.Optional(t.Nullable(t.String())),
      application_id: t.Optional(t.Nullable(t.String())),
      applicationId: t.Optional(t.Nullable(t.String())),
    }, { additionalProperties: true }),
    detail: { tags: ["rbac"], summary: "Assign project RBAC role" },
  }, async ({ params, body, request }) => {
    try {
      return await projectRbacService.assignRole(params.ref, params.roleId, body, await actorId(request));
    } catch (error) {
      return toHttpError(error);
    }
  })
  .delete("/rbac/roles/:roleId/assign/:assignmentId", {
    detail: { tags: ["rbac"], summary: "Revoke project RBAC role assignment" },
  }, async ({ params, request }) => {
    try {
      await projectRbacService.revokeRole(
        params.ref,
        params.roleId,
        params.assignmentId,
        await actorId(request),
      );
      return { deleted: true, assignment_id: params.assignmentId };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/auth/users/:id/roles", {
    query: t.Object({
      application_id: t.Optional(t.String()),
    }, { additionalProperties: true }),
    detail: { tags: ["rbac"], summary: "List project RBAC roles assigned to a user" },
  }, async ({ params, query }) => {
    try {
      const assignments = await projectRbacService.listUserRoleAssignments(params.ref, params.id, query.application_id);
      return { items: assignments, total: assignments.length };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/auth/users/:id/permissions", {
    query: t.Object({
      org_id: t.Optional(t.String()),
      application_id: t.Optional(t.String()),
    }, { additionalProperties: true }),
    detail: { tags: ["rbac"], summary: "Resolve project RBAC permissions for a user" },
  }, async ({ params, query }) => {
    try {
      return await projectRbacService.resolveUserPermissions(params.ref, params.id, query.org_id, query.application_id);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/auth/users/:id/organizations", {
    detail: { tags: ["organizations"], summary: "List business organizations for a GoTrue user" },
  }, async ({ params }) => {
    try {
      return await projectOrganizationService.listForUser(params.ref, params.id);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/rbac/applications/:applicationId/roles", {
    detail: { tags: ["rbac"], summary: "List project RBAC roles assigned to an application" },
  }, async ({ params }) => {
    try {
      const assignments = await projectRbacService.listApplicationRoleAssignments(params.ref, params.applicationId);
      return { items: assignments, total: assignments.length };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/organizations/:orgId/roles", {
    detail: { tags: ["rbac"], summary: "List project RBAC assignments for an organization" },
  }, async ({ params }) => {
    try {
      const assignments = await projectRbacService.listOrganizationRoleAssignments(params.ref, params.orgId);
      return { items: assignments, total: assignments.length };
    } catch (error) {
      return toHttpError(error);
    }
  });
