import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const findByRef = mock(() => Promise.resolve(null));
const updateConfig = mock(() => Promise.resolve(null));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));

const { projectRepository } = await import("../../src/repositories/project.repository");
const authModule = await import("../../src/middleware/auth");

const findByRefSpy = spyOn(projectRepository, "findByRef").mockImplementation(
  findByRef as typeof projectRepository.findByRef,
);
const updateConfigSpy = spyOn(projectRepository, "updateConfig").mockImplementation(
  updateConfig as typeof projectRepository.updateConfig,
);
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);

const { projectRbacRoutes } = await import("../../src/routes/project-rbac");
const app = new Elysia().use(projectRbacRoutes);

const originalFetch = globalThis.fetch;

type TestProject = {
  id: string;
  ref: string;
  organization_id: string;
  name: string;
  db_name: string;
  db_user: string;
  db_password: string;
  jwt_secret: string;
  anon_key: string;
  service_role_key: string;
  s3_bucket: string;
  s3_access_key: null;
  s3_secret_key: null;
  region: string;
  status: "active";
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: null;
};

function makeProject(config: Record<string, unknown>): TestProject {
  return {
    id: "proj-id",
    ref: "proj_1",
    organization_id: "org-root",
    name: "Project 1",
    db_name: "supa_proj_1",
    db_user: "role_proj_1",
    db_password: "pw",
    jwt_secret: "jwt-secret",
    anon_key: "anon",
    service_role_key: "service-role-key",
    s3_bucket: "bucket",
    s3_access_key: null,
    s3_secret_key: null,
    region: "local",
    status: "active",
    config,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  };
}

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        authorization: "Bearer dev-master-token",
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    }),
  );
}

describe("projectRbacRoutes", () => {
  let storedConfig: Record<string, unknown>;
  let putUserUpdateReturns405 = false;
  const userUpdateMethods: string[] = [];
  const userUpdateBodies: Array<Record<string, unknown>> = [];

  afterAll(() => {
    findByRefSpy.mockRestore();
    updateConfigSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    storedConfig = {};
    putUserUpdateReturns405 = false;
    userUpdateMethods.length = 0;
    userUpdateBodies.length = 0;
    findByRef.mockReset();
    updateConfig.mockReset();
    requireProjectOrAdminAuth.mockReset();

    requireProjectOrAdminAuth.mockResolvedValue(null);
    findByRef.mockImplementation(async () => makeProject(storedConfig) as never);
    updateConfig.mockImplementation(async (_ref, nextConfig) => {
      storedConfig = nextConfig;
      return makeProject(storedConfig) as never;
    });
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/admin/users/user-one") && (init?.method === "PUT" || init?.method === "PATCH")) {
        userUpdateMethods.push(init.method);
        if (typeof init.body === "string") {
          userUpdateBodies.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        if (init.method === "PUT" && putUserUpdateReturns405) {
          return Response.json({ message: "method not allowed" }, { status: 405 });
        }
        return Response.json({ id: "user-one" });
      }
      if (url.endsWith("/admin/users/user-one")) {
        return Response.json({
          id: "user-one",
          app_metadata: {
            provider: "email",
            providers: ["email"],
            supaoauth: {
              profile: { role: "管理员" },
            },
          },
        });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    }) as unknown as typeof fetch;
  });

  test("creates roles and permissions in project config", async () => {
    const createRole = await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "admin", description: "Administrators" }),
    });
    expect(createRole.status).toBe(200);
    const role = await createRole.json() as { id: string; name: string; permissions: unknown[] };
    expect(role.name).toBe("admin");
    expect(role.permissions).toEqual([]);

    const createPermission = await request(`/v1/projects/proj_1/rbac/roles/${role.id}/permissions`, {
      method: "POST",
      body: JSON.stringify({ name: "project.manage", description: "Manage project", scopeId: "scope-manage" }),
    });
    expect(createPermission.status).toBe(200);
    const permission = await createPermission.json() as { id: string; name: string; scope_id: string };
    expect(permission.name).toBe("project.manage");
    expect(permission.scope_id).toBe("scope-manage");

    const listRoles = await request("/v1/projects/proj_1/rbac/roles");
    const listBody = await listRoles.json() as { items: Array<{ permissions: unknown[] }>; total: number };
    expect(listBody.total).toBe(1);
    expect(listBody.items[0].permissions).toHaveLength(1);
  });

  test("rejects requests when project auth guard denies access", async () => {
    requireProjectOrAdminAuth.mockResolvedValueOnce({
      status: 403,
      body: { error: "Project service role or admin privileges required" },
    });

    const res = await request("/v1/projects/proj_1/rbac/roles");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Project service role or admin privileges required",
    });
    expect(findByRef).not.toHaveBeenCalled();
  });

  test("updates and deletes roles and permissions", async () => {
    const role = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "admin" }),
    })).json() as { id: string };
    const permission = await (await request(`/v1/projects/proj_1/rbac/roles/${role.id}/permissions`, {
      method: "POST",
      body: JSON.stringify({ name: "project.manage" }),
    })).json() as { id: string };

    const update = await request(`/v1/projects/proj_1/rbac/roles/${role.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "owner", description: "Project owner" }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      id: role.id,
      name: "owner",
      description: "Project owner",
    });

    const deletePermission = await request(`/v1/projects/proj_1/rbac/roles/${role.id}/permissions/${permission.id}`, {
      method: "DELETE",
    });
    expect(deletePermission.status).toBe(200);
    const permissions = await request(`/v1/projects/proj_1/rbac/roles/${role.id}/permissions`);
    expect(await permissions.json()).toMatchObject({ items: [], total: 0 });

    const deleteRole = await request(`/v1/projects/proj_1/rbac/roles/${role.id}`, {
      method: "DELETE",
    });
    expect(deleteRole.status).toBe(200);
    const roles = await request("/v1/projects/proj_1/rbac/roles");
    expect(await roles.json()).toMatchObject({ items: [], total: 0 });
  });

  test("returns RBAC validation errors for missing and duplicate resources", async () => {
    const missingRole = await request("/v1/projects/proj_1/rbac/roles/missing");
    expect(missingRole.status).toBe(404);
    expect(await missingRole.json()).toMatchObject({ message: "Role not found", code: "404" });

    await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "admin" }),
    });
    const duplicateRole = await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "admin" }),
    });
    expect(duplicateRole.status).toBe(409);
    expect(await duplicateRole.json()).toMatchObject({ message: "Role name already exists", code: "409" });
  });

  test("assigns and revokes a user role while syncing app_metadata.supaoauth", async () => {
    const role = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "admin" }),
    })).json() as { id: string };
    await request(`/v1/projects/proj_1/rbac/roles/${role.id}/permissions`, {
      method: "POST",
      body: JSON.stringify({ name: "project.manage", scope_id: "scope-manage" }),
    });

    const assign = await request(`/v1/projects/proj_1/rbac/roles/${role.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ userId: "user-one", organizationId: "org-one" }),
    });
    expect(assign.status).toBe(200);
    const assignment = await assign.json() as { id: string; role_id: string; user_id: string; organization_id: string };
    expect(assignment).toMatchObject({
      role_id: role.id,
      user_id: "user-one",
      organization_id: "org-one",
    });

    expect(userUpdateMethods.at(-1)).toBe("PUT");
    const projection = userUpdateBodies.at(-1)?.app_metadata as Record<string, unknown>;
    expect(projection.provider).toBe("email");
    expect(projection.supaoauth).toMatchObject({
      profile: { role: "管理员" },
      roles: ["admin"],
      permissions: ["project.manage"],
      scopes: ["scope-manage"],
      organization_ids: ["org-one"],
      current_org_id: "org-one",
    });

    const permissions = await request("/v1/projects/proj_1/auth/users/user-one/permissions?org_id=org-one");
    expect(await permissions.json()).toEqual({
      roles: ["admin"],
      permissions: ["project.manage"],
      scopes: ["scope-manage"],
    });

    const orgAssignments = await request("/v1/projects/proj_1/organizations/org-one/roles");
    const orgBody = await orgAssignments.json() as { items: unknown[]; total: number };
    expect(orgBody.total).toBe(1);

    const revoke = await request(`/v1/projects/proj_1/rbac/roles/${role.id}/assign/${assignment.id}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(200);
    expect(userUpdateMethods.at(-1)).toBe("PUT");
    const revokedProjection = userUpdateBodies.at(-1)?.app_metadata as Record<string, unknown>;
    const revokedSupauth = revokedProjection.supaoauth as Record<string, unknown>;
    expect(revokedProjection.supaoauth).toMatchObject({
      roles: [],
      permissions: [],
      scopes: [],
      organization_ids: [],
    });
    expect("current_org_id" in revokedSupauth).toBe(false);
  });

  test("falls back to PATCH when GoTrue rejects PUT user updates", async () => {
    putUserUpdateReturns405 = true;
    const role = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "admin" }),
    })).json() as { id: string };

    const assign = await request(`/v1/projects/proj_1/rbac/roles/${role.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ userId: "user-one" }),
    });

    expect(assign.status).toBe(200);
    expect(userUpdateMethods).toEqual(["PUT", "PATCH"]);
    const projection = userUpdateBodies.at(-1)?.app_metadata as Record<string, unknown>;
    expect(projection.supaoauth).toMatchObject({
      roles: ["admin"],
      permissions: [],
      scopes: [],
    });
  });
});
