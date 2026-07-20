import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const findByRef = mock((_ref?: string) => Promise.resolve(null));
const updateConfig = mock(() => Promise.resolve(null));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const getVerifiedRequestPrincipal = mock(() => Promise.resolve({ id: "test-admin", type: "admin" as const }));
const resolvedDatabaseRefs: string[] = [];
const managementTransactionCalls: Array<{ query: string; values: unknown[] }> = [];
let rejectTransactionalOutbox = false;
let captureManagementState: () => unknown = () => undefined;
let restoreManagementState: (snapshot: unknown) => void = () => undefined;
const managementTransaction = mock(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  managementTransactionCalls.push({ query: strings.join("?"), values });
  const query = strings.join("?");
  if (query.includes("SELECT * FROM projects")) {
    const project = await findByRef(String(values[0]));
    return project ? [project] : [];
  }
  if (query.includes("UPDATE projects") && query.includes("SET config =")) {
    const nextConfig = JSON.parse(String(values[0])) as Record<string, unknown>;
    const project = await updateConfig(String(values[1]), nextConfig);
    return project ? [project] : [];
  }
  if (query.includes("COUNT(*)::int AS count FROM project_webhooks w")) return [{ count: 1 }];
  if (query.includes("COUNT(*)::int AS count FROM webhook_outbox")) return [{ count: 0 }];
  if (query.includes("INSERT INTO webhook_outbox")) {
    if (rejectTransactionalOutbox) throw new Error("outbox unavailable");
    return [{ event_id: "11111111-1111-4111-8111-111111111111" }];
  }
  return Promise.resolve([]);
});
let managementTransactionTail = Promise.resolve();
const managementSql = Object.assign(
  mock(() => Promise.resolve([])),
  {
    begin: mock(async (callback: (transaction: typeof managementTransaction) => Promise<unknown>) => {
      const precedingTransaction = managementTransactionTail;
      let releaseTransaction!: () => void;
      managementTransactionTail = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      await precedingTransaction;
      const stateSnapshot = captureManagementState();
      try {
        return await callback(managementTransaction);
      } catch (error) {
        restoreManagementState(stateSnapshot);
        throw error;
      } finally {
        releaseTransaction();
      }
    }),
  },
);
const authorityDb = mock((strings: TemplateStringsArray) => {
  const query = strings.join("?");
  if (query.includes("FROM auth.users")) return Promise.resolve([{ id: "user-one" }]);
  if (query.includes("FROM auth.oauth_clients")) return Promise.resolve([{ id: "client-one" }]);
  return Promise.resolve([]);
});

mock.module("../../src/db", () => ({
  sql: managementSql,
  getProjectDb: mock(() => authorityDb),
  resolveDbName: mock((ref: string) => {
    resolvedDatabaseRefs.push(ref);
    return Promise.resolve(`supa_${ref}`);
  }),
}));

const { projectRepository } = await import("../../src/repositories/project.repository");
const authModule = await import("../../src/middleware/auth");
const rbacServiceModule = await import("../../src/services/project-rbac.service");
const { config } = await import("../../src/config");
const originalAssertUserTarget = rbacServiceModule.projectRbacTargetService.assertUser;
const originalAssertApplicationTarget = rbacServiceModule.projectRbacTargetService.assertApplication;

const findByRefSpy = spyOn(projectRepository, "findByRef").mockImplementation(
  findByRef as typeof projectRepository.findByRef,
);
const updateConfigSpy = spyOn(projectRepository, "updateConfig").mockImplementation(
  updateConfig as typeof projectRepository.updateConfig,
);
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const getVerifiedRequestPrincipalSpy = spyOn(authModule, "getVerifiedRequestPrincipal").mockImplementation(
  getVerifiedRequestPrincipal as typeof authModule.getVerifiedRequestPrincipal,
);
const assertUserTargetSpy = spyOn(rbacServiceModule.projectRbacTargetService, "assertUser").mockResolvedValue(undefined);
const assertApplicationTargetSpy = spyOn(rbacServiceModule.projectRbacTargetService, "assertApplication").mockResolvedValue(undefined);
const assertOrganizationTargetSpy = spyOn(rbacServiceModule.projectRbacTargetService, "assertOrganization").mockResolvedValue(undefined);

const { projectRbacRoutes } = await import("../../src/routes/project-rbac");
const app = new Elysia().use(projectRbacRoutes);

const originalFetch = globalThis.fetch;
const originalOwnerRef = config.authRuntimeOwnerRef;

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

function makeProject(
  config: Record<string, unknown>,
  ref = "proj_1",
  serviceRoleKey = "service-role-key",
): TestProject {
  return {
    id: "proj-id",
    ref,
    organization_id: "org-root",
    name: "Project 1",
    db_name: "supa_proj_1",
    db_user: "role_proj_1",
    db_password: "pw",
    jwt_secret: "jwt-secret",
    anon_key: "anon",
    service_role_key: serviceRoleKey,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectProjection(
  appMetadata: Record<string, unknown>,
  ref = "proj_1",
): Record<string, unknown> {
  const supaoauth = isRecord(appMetadata.supaoauth) ? appMetadata.supaoauth : {};
  const projects = isRecord(supaoauth.projects) ? supaoauth.projects : {};
  return isRecord(projects[ref]) ? projects[ref] : {};
}

function seededRbacConfig(
  roleCount: number,
  permissionCount = 0,
  scopeId: string | null = null,
): Record<string, unknown> {
  const timestamp = "2026-07-20T00:00:00.000Z";
  const roles = Array.from({ length: roleCount }, (_, roleIndex) => ({
    id: `role-${roleIndex}`,
    name: `role-${roleIndex.toString().padStart(3, "0")}`,
    description: null,
    permissions: roleIndex === 0
      ? Array.from({ length: permissionCount }, (_, permissionIndex) => ({
        id: `permission-${permissionIndex}`,
        name: `permission-${permissionIndex.toString().padStart(3, "0")}`,
        description: null,
        resource_id: null,
        scope_id: scopeId,
        created_at: timestamp,
        updated_at: timestamp,
      }))
      : [],
    created_at: timestamp,
    updated_at: timestamp,
  }));
  return {
    rbac: {
      roles,
      assignments: roles.map((role, assignmentIndex) => ({
        id: `assignment-${assignmentIndex}`,
        role_id: role.id,
        user_id: "user-one",
        organization_id: null,
        application_id: assignmentIndex === 0 ? "seed-application" : null,
        created_at: timestamp,
      })),
      application_ids: [],
      version: 1,
      updated_at: timestamp,
    },
  };
}

describe("projectRbacRoutes", () => {
  let storedConfig: Record<string, unknown>;
  let userAppMetadata: Record<string, unknown>;
  let putUserUpdateReturns405 = false;
  let persistUserUpdates = true;
  let forcedGoTrueError: Error | null = null;
  let transformPersistedMetadata: ((metadata: Record<string, unknown>) => Record<string, unknown>) | null = null;
  let rejectAvailableProjectionWrites = false;
  const userUpdateMethods: string[] = [];
  const userUpdateBodies: Array<Record<string, unknown>> = [];
  const gotrueRequests: Array<{ url: string; headers: Headers; signal: AbortSignal | null }> = [];

  async function createAssignedRole(name: string, permissionName?: string) {
    const role = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name }),
    })).json() as { id: string };
    let permissionId: string | undefined;
    if (permissionName) {
      const permission = await (await request(`/v1/projects/proj_1/rbac/roles/${role.id}/permissions`, {
        method: "POST",
        body: JSON.stringify({ name: permissionName }),
      })).json() as { id: string };
      permissionId = permission.id;
    }
    const assignment = await (await request(`/v1/projects/proj_1/rbac/roles/${role.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    })).json() as { id: string };
    return { roleId: role.id, permissionId, assignmentId: assignment.id };
  }

  afterAll(() => {
    findByRefSpy.mockRestore();
    updateConfigSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
    getVerifiedRequestPrincipalSpy.mockRestore();
    assertUserTargetSpy.mockRestore();
    assertApplicationTargetSpy.mockRestore();
    assertOrganizationTargetSpy.mockRestore();
    globalThis.fetch = originalFetch;
    config.authRuntimeOwnerRef = originalOwnerRef;
  });

  beforeEach(() => {
    storedConfig = {};
    userAppMetadata = {
      provider: "email",
      providers: ["email"],
      supaoauth: {
        profile: { role: "管理员" },
      },
    };
    putUserUpdateReturns405 = false;
    persistUserUpdates = true;
    forcedGoTrueError = null;
    transformPersistedMetadata = null;
    rejectAvailableProjectionWrites = false;
    userUpdateMethods.length = 0;
    userUpdateBodies.length = 0;
    gotrueRequests.length = 0;
    resolvedDatabaseRefs.length = 0;
    managementTransactionCalls.length = 0;
    managementTransactionTail = Promise.resolve();
    managementTransaction.mockClear();
    managementSql.begin.mockClear();
    config.authRuntimeOwnerRef = "";
    findByRef.mockReset();
    updateConfig.mockReset();
    requireProjectOrAdminAuth.mockReset();
    getVerifiedRequestPrincipal.mockReset();
    assertUserTargetSpy.mockClear();
    assertApplicationTargetSpy.mockClear();
    assertOrganizationTargetSpy.mockClear();

    requireProjectOrAdminAuth.mockResolvedValue(null);
    getVerifiedRequestPrincipal.mockResolvedValue({ id: "test-admin", type: "admin" });
    rejectTransactionalOutbox = false;
    captureManagementState = () => structuredClone(storedConfig);
    restoreManagementState = (snapshot) => {
      storedConfig = snapshot as Record<string, unknown>;
    };
    findByRef.mockImplementation(async () => makeProject(storedConfig) as never);
    updateConfig.mockImplementation(async (_ref, nextConfig) => {
      storedConfig = nextConfig;
      return makeProject(storedConfig) as never;
    });
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      gotrueRequests.push({ url, headers: new Headers(init?.headers), signal: init?.signal ?? null });
      if (forcedGoTrueError) throw forcedGoTrueError;
      if (url.endsWith("/admin/users/user-one") && (init?.method === "PUT" || init?.method === "PATCH")) {
        userUpdateMethods.push(init.method);
        let updateBody: Record<string, unknown> | undefined;
        if (typeof init.body === "string") {
          updateBody = JSON.parse(init.body) as Record<string, unknown>;
          userUpdateBodies.push(updateBody);
        }
        const updateMetadata = isRecord(updateBody?.app_metadata) ? updateBody.app_metadata : {};
        if (rejectAvailableProjectionWrites && projectProjection(updateMetadata).projection_unavailable !== true) {
          return Response.json({ message: "simulated full projection failure" }, { status: 503 });
        }
        if (init.method === "PUT" && putUserUpdateReturns405) {
          return Response.json({ message: "method not allowed" }, { status: 405 });
        }
        if (persistUserUpdates && isRecord(updateBody?.app_metadata)) {
          userAppMetadata = transformPersistedMetadata
            ? transformPersistedMetadata(updateBody.app_metadata)
            : updateBody.app_metadata;
        }
        return Response.json({ id: "user-one" });
      }
      if (url.endsWith("/admin/users/user-one")) {
        return Response.json({
          id: "user-one",
          app_metadata: userAppMetadata,
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
    userAppMetadata = {
      ...userAppMetadata,
      supaoauth: {
        profile: { role: "管理员" },
        roles: ["legacy-local-role"],
        permissions: ["legacy.local.manage"],
        hook: {
          version: 1,
          authentication_method: "password",
          processed_at: "2026-07-20T00:00:00.000Z",
          extra: true,
        },
      },
    };
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
    expect(managementTransactionCalls.flatMap(({ values }) => values)).toContain(`role.assigned:${assignment.id}`);

    expect(userUpdateMethods.at(-1)).toBe("PUT");
    const projection = userUpdateBodies.at(-1)?.app_metadata as Record<string, unknown>;
    expect(projection.provider).toBe("email");
    expect(projection.supaoauth).toMatchObject({
      schema_version: 2,
      projects: {
        proj_1: {
          roles: [],
          permissions: [],
          scopes: [],
          organization_ids: ["org-one"],
          current_org_id: "org-one",
          organizations: {
            "org-one": {
              roles: ["admin"],
              permissions: ["project.manage"],
              scopes: ["scope-manage"],
            },
          },
        },
      },
    });
    const rootSupaoauth = projection.supaoauth as Record<string, unknown>;
    expect("profile" in rootSupaoauth).toBe(false);
    expect("hook" in rootSupaoauth).toBe(false);
    expect("roles" in rootSupaoauth).toBe(false);
    const lockCall = managementTransactionCalls.find(({ query }) => query.includes("pg_advisory_xact_lock"));
    expect(lockCall?.values).toEqual(["rbac-project-config:proj_1"]);
    expect(managementTransactionCalls.some(({ values }) =>
      values[0] === "rbac-user-metadata:proj_1:user-one"
    )).toBe(true);
    expect(gotrueRequests.filter(({ url }) => url.endsWith("/admin/users/user-one"))).toHaveLength(3);

    const permissions = await request("/v1/projects/proj_1/auth/users/user-one/permissions?org_id=org-one");
    expect(await permissions.json()).toEqual({
      roles: ["admin"],
      permissions: ["project.manage"],
      scopes: ["scope-manage"],
    });

    const userRoles = await request("/v1/projects/proj_1/auth/users/user-one/roles");
    expect(await userRoles.json()).toMatchObject({
      total: 1,
      items: [{ organization_id: "org-one", role: { name: "admin" } }],
    });

    const orgAssignments = await request("/v1/projects/proj_1/organizations/org-one/roles");
    const orgBody = await orgAssignments.json() as { items: unknown[]; total: number };
    expect(orgBody.total).toBe(1);

    const revoke = await request(`/v1/projects/proj_1/rbac/roles/${role.id}/assign/${assignment.id}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(200);
    expect(managementTransactionCalls.flatMap(({ values }) => values)).toContain(`role.revoked:${assignment.id}`);
    expect(userUpdateMethods.at(-1)).toBe("PUT");
    const revokedProjection = userUpdateBodies.at(-1)?.app_metadata as Record<string, unknown>;
    const revokedProject = projectProjection(revokedProjection);
    expect(revokedProject).toMatchObject({
      roles: [],
      permissions: [],
      scopes: [],
      organization_ids: [],
      organizations: {},
    });
    expect("current_org_id" in revokedProject).toBe(false);
  });

  test("rolls back an assignment when its transactional outbox write fails", async () => {
    const role = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "rollback-role" }),
    })).json() as { id: string };
    rejectTransactionalOutbox = true;

    const assignment = await request(`/v1/projects/proj_1/rbac/roles/${role.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });

    expect(assignment.status).toBe(500);
    expect(await assignment.json()).toMatchObject({ message: "outbox unavailable" });
    const rbac = storedConfig.rbac as { assignments: unknown[] };
    expect(rbac.assignments).toEqual([]);
    expect(userUpdateBodies).toEqual([]);
  });

  test("does not enqueue role-assigned again when the assignment already exists", async () => {
    const role = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "stable-role" }),
    })).json() as { id: string };
    const assignmentBody = JSON.stringify({ user_id: "user-one", organization_id: "org-one" });

    const first = await (await request(`/v1/projects/proj_1/rbac/roles/${role.id}/assign`, {
      method: "POST",
      body: assignmentBody,
    })).json() as { id: string };
    const updatesAfterFirstAssignment = userUpdateBodies.length;
    const configWritesAfterFirstAssignment = managementTransactionCalls.filter(({ query }) => (
      query.includes("UPDATE projects") && query.includes("SET config =")
    )).length;
    const outboxWritesAfterFirstAssignment = managementTransactionCalls.filter(({ query }) => (
      query.includes("INSERT INTO webhook_outbox")
    )).length;
    const second = await (await request(`/v1/projects/proj_1/rbac/roles/${role.id}/assign`, {
      method: "POST",
      body: assignmentBody,
    })).json() as { id: string };

    expect(second.id).toBe(first.id);
    expect(userUpdateBodies).toHaveLength(updatesAfterFirstAssignment);
    expect(managementTransactionCalls.filter(({ query }) => (
      query.includes("UPDATE projects") && query.includes("SET config =")
    ))).toHaveLength(configWritesAfterFirstAssignment);
    expect(managementTransactionCalls.filter(({ query }) => (
      query.includes("INSERT INTO webhook_outbox")
    ))).toHaveLength(outboxWritesAfterFirstAssignment);
  });

  test("does not leak an application-scoped assignment across application contexts", async () => {
    const role = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "fa_engineer" }),
    })).json() as { id: string };
    await request(`/v1/projects/proj_1/rbac/roles/${role.id}/permissions`, {
      method: "POST",
      body: JSON.stringify({ name: "fa.rework.approve" }),
    });
    const otherRole = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "other_app_admin" }),
    })).json() as { id: string };
    await request(`/v1/projects/proj_1/rbac/roles/${otherRole.id}/permissions`, {
      method: "POST",
      body: JSON.stringify({ name: "other.manage" }),
    });

    const first = await request(`/v1/projects/proj_1/rbac/roles/${role.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one", application_id: "fa-app" }),
    });
    expect(first.status).toBe(200);
    const second = await request(`/v1/projects/proj_1/rbac/roles/${otherRole.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one", application_id: "other-app" }),
    });
    expect(second.status).toBe(200);

    const faPermissions = await request(
      "/v1/projects/proj_1/auth/users/user-one/permissions?application_id=fa-app",
    );
    expect(await faPermissions.json()).toEqual({
      application_id: "fa-app",
      roles: ["fa_engineer"],
      permissions: ["fa.rework.approve"],
      scopes: [],
    });

    const otherPermissions = await request(
      "/v1/projects/proj_1/auth/users/user-one/permissions?application_id=other-app",
    );
    expect(await otherPermissions.json()).toEqual({
      application_id: "other-app",
      roles: ["other_app_admin"],
      permissions: ["other.manage"],
      scopes: [],
    });

    const legacyPermissions = await request(
      "/v1/projects/proj_1/auth/users/user-one/permissions",
    );
    expect(await legacyPermissions.json()).toEqual({ roles: [], permissions: [], scopes: [] });

    const faRoles = await request(
      "/v1/projects/proj_1/auth/users/user-one/roles?application_id=fa-app",
    );
    expect(await faRoles.json()).toMatchObject({
      total: 1,
      items: [{ application_id: "fa-app", role: { name: "fa_engineer" } }],
    });
    const projectWideRoles = await request("/v1/projects/proj_1/auth/users/user-one/roles");
    expect(await projectWideRoles.json()).toEqual({ items: [], total: 0 });

    const projection = userUpdateBodies.at(-1)?.app_metadata as Record<string, unknown>;
    expect((projectProjection(projection).applications as Record<string, unknown>)).toMatchObject({
      "fa-app": { roles: ["fa_engineer"], permissions: ["fa.rework.approve"] },
      "other-app": { roles: ["other_app_admin"], permissions: ["other.manage"] },
    });
  });

  test("keeps application metadata permissions isolated by organization", async () => {
    const projectRole = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "project_reader" }),
    })).json() as { id: string };
    await request(`/v1/projects/proj_1/rbac/roles/${projectRole.id}/permissions`, {
      method: "POST",
      body: JSON.stringify({ name: "project.read", scope_id: "scope-project" }),
    });

    const adminRole = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "fa_admin" }),
    })).json() as { id: string };
    await request(`/v1/projects/proj_1/rbac/roles/${adminRole.id}/permissions`, {
      method: "POST",
      body: JSON.stringify({ name: "fa.approve", scope_id: "scope-fa-admin" }),
    });

    const viewerRole = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "fa_viewer" }),
    })).json() as { id: string };
    await request(`/v1/projects/proj_1/rbac/roles/${viewerRole.id}/permissions`, {
      method: "POST",
      body: JSON.stringify({ name: "fa.view", scope_id: "scope-fa-viewer" }),
    });

    await request(`/v1/projects/proj_1/rbac/roles/${projectRole.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });
    await request(`/v1/projects/proj_1/rbac/roles/${adminRole.id}/assign`, {
      method: "POST",
      body: JSON.stringify({
        user_id: "user-one",
        application_id: "fa-app",
        organization_id: "org-a",
      }),
    });
    await request(`/v1/projects/proj_1/rbac/roles/${viewerRole.id}/assign`, {
      method: "POST",
      body: JSON.stringify({
        user_id: "user-one",
        application_id: "fa-app",
        organization_id: "org-b",
      }),
    });

    const projection = userUpdateBodies.at(-1)?.app_metadata as Record<string, unknown>;
    const applications = projectProjection(projection).applications as Record<string, unknown>;
    expect(applications["fa-app"]).toEqual({
      roles: ["project_reader"],
      permissions: ["project.read"],
      scopes: ["scope-project"],
      organization_ids: ["org-a", "org-b"],
      organizations: {
        "org-a": {
          roles: ["fa_admin", "project_reader"],
          permissions: ["fa.approve", "project.read"],
          scopes: ["scope-fa-admin", "scope-project"],
        },
        "org-b": {
          roles: ["fa_viewer", "project_reader"],
          permissions: ["fa.view", "project.read"],
          scopes: ["scope-fa-viewer", "scope-project"],
        },
      },
    });

    const appOnlyPermissions = await request(
      "/v1/projects/proj_1/auth/users/user-one/permissions?application_id=fa-app",
    );
    expect(await appOnlyPermissions.json()).toEqual({
      application_id: "fa-app",
      roles: ["project_reader"],
      permissions: ["project.read"],
      scopes: ["scope-project"],
    });

    const orgAPermissions = await request(
      "/v1/projects/proj_1/auth/users/user-one/permissions?application_id=fa-app&org_id=org-a",
    );
    expect(await orgAPermissions.json()).toEqual({
      application_id: "fa-app",
      roles: ["fa_admin", "project_reader"],
      permissions: ["fa.approve", "project.read"],
      scopes: ["scope-fa-admin", "scope-project"],
    });
    const orgBPermissions = await request(
      "/v1/projects/proj_1/auth/users/user-one/permissions?application_id=fa-app&org_id=org-b",
    );
    expect(await orgBPermissions.json()).toEqual({
      application_id: "fa-app",
      roles: ["fa_viewer", "project_reader"],
      permissions: ["fa.view", "project.read"],
      scopes: ["scope-fa-viewer", "scope-project"],
    });
  });

  test("keeps a known application namespace after revoking its last scoped assignment", async () => {
    const projectRole = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "project_reader" }),
    })).json() as { id: string };
    await request(`/v1/projects/proj_1/rbac/roles/${projectRole.id}/permissions`, {
      method: "POST",
      body: JSON.stringify({ name: "project.read", scope_id: "scope-project" }),
    });

    const appRole = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "fa_admin" }),
    })).json() as { id: string };
    await request(`/v1/projects/proj_1/rbac/roles/${appRole.id}/permissions`, {
      method: "POST",
      body: JSON.stringify({ name: "fa.approve", scope_id: "scope-fa" }),
    });

    await request(`/v1/projects/proj_1/rbac/roles/${projectRole.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });
    const appAssignmentResponse = await request(`/v1/projects/proj_1/rbac/roles/${appRole.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one", application_id: "fa-app" }),
    });
    const appAssignment = await appAssignmentResponse.json() as { id: string };

    const currentSupaoauth = isRecord(userAppMetadata.supaoauth) ? userAppMetadata.supaoauth : {};
    const currentProjects = isRecord(currentSupaoauth.projects) ? currentSupaoauth.projects : {};
    const currentProject = isRecord(currentProjects.proj_1) ? currentProjects.proj_1 : {};
    userAppMetadata = {
      ...userAppMetadata,
      supaoauth: {
        ...currentSupaoauth,
        projects: {
          ...currentProjects,
          proj_1: {
            ...currentProject,
            applications: {},
          },
        },
      },
    };

    const revoke = await request(
      `/v1/projects/proj_1/rbac/roles/${appRole.id}/assign/${appAssignment.id}`,
      { method: "DELETE" },
    );
    expect(revoke.status).toBe(200);
    expect((storedConfig.rbac as Record<string, unknown>).application_ids).toEqual(["fa-app"]);

    const projection = userUpdateBodies.at(-1)?.app_metadata as Record<string, unknown>;
    const applications = projectProjection(projection).applications as Record<string, unknown>;
    expect(applications["fa-app"]).toEqual({
      roles: ["project_reader"],
      permissions: ["project.read"],
      scopes: ["scope-project"],
      organization_ids: [],
      organizations: {},
    });

    const permissions = await request(
      "/v1/projects/proj_1/auth/users/user-one/permissions?application_id=fa-app",
    );
    expect(await permissions.json()).toEqual({
      application_id: "fa-app",
      roles: ["project_reader"],
      permissions: ["project.read"],
      scopes: ["scope-project"],
    });
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
    expect(projectProjection(projection)).toMatchObject({
      roles: ["admin"],
      permissions: [],
      scopes: [],
    });
  });

  test("resolves user and OAuth client targets from the shared GoTrue authority", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    await originalAssertUserTarget("proj_1", "user-one");
    await originalAssertApplicationTarget("proj_1", "client-one");
    expect(resolvedDatabaseRefs).toEqual(["auth-owner", "auth-owner"]);
  });

  test("serializes concurrent child RBAC mutations without losing assignments", async () => {
    const adminRole = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "admin" }),
    })).json() as { id: string };
    const readerRole = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "reader" }),
    })).json() as { id: string };
    managementTransactionCalls.length = 0;

    const [adminAssignment, readerAssignment] = await Promise.all([
      request(`/v1/projects/proj_1/rbac/roles/${adminRole.id}/assign`, {
        method: "POST",
        body: JSON.stringify({ user_id: "user-one" }),
      }),
      request(`/v1/projects/proj_1/rbac/roles/${readerRole.id}/assign`, {
        method: "POST",
        body: JSON.stringify({ user_id: "user-one" }),
      }),
    ]);

    expect(adminAssignment.status).toBe(200);
    expect(readerAssignment.status).toBe(200);
    const storedRbac = storedConfig.rbac as { assignments: unknown[] };
    expect(storedRbac.assignments).toHaveLength(2);
    expect(projectProjection(userAppMetadata)).toMatchObject({ roles: ["admin", "reader"] });
    const lockKeys = managementTransactionCalls.map(({ values }) => values[0]);
    expect(lockKeys.filter((key) => key === "rbac-project-config:proj_1")).toHaveLength(2);
    expect(lockKeys.filter((key) => key === "rbac-user-metadata:proj_1:user-one")).toHaveLength(2);
  });

  test("isolates shared-authority child projections across assign and reverse revoke order", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    const childConfigs = new Map<string, Record<string, unknown>>([
      ["child-a", {}],
      ["child-b", {}],
    ]);
    userAppMetadata = {
      provider: "email",
      supaoauth: {
        profile: { role: "authority-owner" },
        unknown_root_field: "remove-me",
        hook: {
          version: 1,
          authentication_method: "password",
          processed_at: "2026-07-20T00:00:00.000Z",
        },
        roles: ["legacy-authority-role"],
        permissions: ["legacy.authority.manage"],
        projects: {
          legacy: { roles: ["legacy-reader"] },
        },
      },
    };
    findByRef.mockImplementation(async (ref) => {
      if (ref === "auth-owner") return makeProject({}, "auth-owner", "authority-service-key") as never;
      return makeProject(childConfigs.get(ref) ?? {}, ref) as never;
    });
    updateConfig.mockImplementation(async (ref, nextConfig) => {
      childConfigs.set(ref, nextConfig);
      return makeProject(nextConfig, ref) as never;
    });

    const childARole = await (await request("/v1/projects/child-a/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "child-a-admin" }),
    })).json() as { id: string };
    const childAAssignmentResponse = await request(`/v1/projects/child-a/rbac/roles/${childARole.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });
    const childAAssignment = await childAAssignmentResponse.json() as { id: string };
    const childBRole = await (await request("/v1/projects/child-b/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "child-b-reader" }),
    })).json() as { id: string };
    const childBAssignmentResponse = await request(`/v1/projects/child-b/rbac/roles/${childBRole.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });
    const childBAssignment = await childBAssignmentResponse.json() as { id: string };

    expect(childAAssignmentResponse.status).toBe(200);
    expect(childBAssignmentResponse.status).toBe(200);
    expect(projectProjection(userAppMetadata, "child-a")).toMatchObject({ roles: ["child-a-admin"] });
    expect(projectProjection(userAppMetadata, "child-b")).toMatchObject({ roles: ["child-b-reader"] });
    expect(projectProjection(userAppMetadata, "legacy")).toEqual({ roles: ["legacy-reader"] });
    const sharedSupaoauth = userAppMetadata.supaoauth as Record<string, unknown>;
    expect(sharedSupaoauth).toMatchObject({
      schema_version: 2,
      hook: {
        version: 1,
        authentication_method: "password",
        processed_at: "2026-07-20T00:00:00.000Z",
      },
    });
    expect("profile" in sharedSupaoauth).toBe(false);
    expect("unknown_root_field" in sharedSupaoauth).toBe(false);
    expect("roles" in sharedSupaoauth).toBe(false);
    expect("permissions" in sharedSupaoauth).toBe(false);

    const revokeChildB = await request(
      `/v1/projects/child-b/rbac/roles/${childBRole.id}/assign/${childBAssignment.id}`,
      { method: "DELETE" },
    );
    expect(revokeChildB.status).toBe(200);
    expect(projectProjection(userAppMetadata, "child-a")).toMatchObject({ roles: ["child-a-admin"] });
    expect(projectProjection(userAppMetadata, "child-b")).toMatchObject({
      roles: [],
      permissions: [],
      scopes: [],
    });

    const revokeChildA = await request(
      `/v1/projects/child-a/rbac/roles/${childARole.id}/assign/${childAAssignment.id}`,
      { method: "DELETE" },
    );
    expect(revokeChildA.status).toBe(200);
    expect(projectProjection(userAppMetadata, "child-a")).toMatchObject({ roles: [] });
    expect(projectProjection(userAppMetadata, "child-b")).toMatchObject({ roles: [] });

    expect(updateConfig).toHaveBeenCalledWith("child-a", expect.any(Object));
    expect(updateConfig).toHaveBeenCalledWith("child-b", expect.any(Object));
    const lockKeys = managementTransactionCalls
      .filter(({ query }) => query.includes("pg_advisory_xact_lock"))
      .map(({ values }) => values[0])
      .filter((key) => typeof key === "string" && key.startsWith("rbac-user-metadata:"));
    expect(lockKeys).toEqual([
      "rbac-user-metadata:auth-owner:user-one",
      "rbac-user-metadata:auth-owner:user-one",
      "rbac-user-metadata:auth-owner:user-one",
      "rbac-user-metadata:auth-owner:user-one",
      "rbac-user-metadata:auth-owner:user-one",
      "rbac-user-metadata:auth-owner:user-one",
    ]);

    expect(findByRef.mock.calls.some(([ref]) => ref === "auth-owner")).toBe(true);
    const authorityRequest = gotrueRequests.find(({ url }) => url.endsWith("/admin/users/user-one"));
    expect(authorityRequest?.headers.get("x-project-ref")).toBe("auth-owner");
    expect(authorityRequest?.headers.get("apikey")).toBe("authority-service-key");
    expect(authorityRequest?.headers.get("authorization")).toBe("Bearer authority-service-key");
  });

  test("fails closed instead of partially projecting roles above the 64-role limit", async () => {
    storedConfig = seededRbacConfig(64);
    const atLimit = await request("/v1/projects/proj_1/rbac/roles/role-0/assign", {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });
    expect(atLimit.status).toBe(200);
    expect(projectProjection(userAppMetadata).roles).toHaveLength(64);
    expect("roles_truncated" in projectProjection(userAppMetadata)).toBe(false);

    storedConfig = seededRbacConfig(65);
    const aboveLimit = await request("/v1/projects/proj_1/rbac/roles/role-0/assign", {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });
    expect(aboveLimit.status).toBe(200);
    expect(projectProjection(userAppMetadata)).toMatchObject({
      roles: [],
      roles_count: 65,
      roles_truncated: true,
      roles_projection_limit: 64,
    });
  });

  test("fails closed instead of partially projecting permissions above the 256-permission limit", async () => {
    storedConfig = seededRbacConfig(1, 256);
    const atLimit = await request("/v1/projects/proj_1/rbac/roles/role-0/assign", {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });
    expect(atLimit.status).toBe(200);
    expect(projectProjection(userAppMetadata).permissions).toHaveLength(256);
    expect("permissions_truncated" in projectProjection(userAppMetadata)).toBe(false);

    storedConfig = seededRbacConfig(1, 257);
    const aboveLimit = await request("/v1/projects/proj_1/rbac/roles/role-0/assign", {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });
    expect(aboveLimit.status).toBe(200);
    expect(projectProjection(userAppMetadata)).toMatchObject({
      permissions: [],
      permissions_count: 257,
      permissions_truncated: true,
      permissions_projection_limit: 256,
    });
  });

  test("returns an unavailable empty projection when a field exceeds its byte budget", async () => {
    storedConfig = seededRbacConfig(1, 1, "scope-" + "x".repeat(3_000));
    const assignment = await request("/v1/projects/proj_1/rbac/roles/role-0/assign", {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });

    expect(assignment.status).toBe(200);
    expect(projectProjection(userAppMetadata)).toEqual({
      roles: [],
      permissions: [],
      scopes: [],
      organization_ids: [],
      organizations: {},
      applications: {},
      rbac_version: 2,
      roles_count: 1,
      permissions_count: 1,
      scopes_count: 1,
      organization_ids_count: 0,
      organizations_count: 0,
      applications_count: 1,
      truncated: true,
      projection_limit: 2_048,
      projection_unavailable: true,
    });
  });

  test("returns an unavailable empty projection when the complete project exceeds 16 KiB", async () => {
    storedConfig = seededRbacConfig(1);
    userAppMetadata = {
      provider: "email",
      supaoauth: {
        schema_version: 2,
        projects: {
          proj_1: {
            organization_memberships: [{ organization_id: "org-one", slug: "x".repeat(17_000) }],
          },
        },
      },
    };
    const assignment = await request("/v1/projects/proj_1/rbac/roles/role-0/assign", {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });

    expect(assignment.status).toBe(200);
    expect(projectProjection(userAppMetadata)).toMatchObject({
      roles: [],
      permissions: [],
      scopes: [],
      organizations: {},
      applications: {},
      truncated: true,
      projection_limit: 16_384,
      projection_unavailable: true,
    });
    expect("organization_memberships" in projectProjection(userAppMetadata)).toBe(false);
  });

  test("fails every child closed when individually valid projects exceed the 64 KiB namespace budget", async () => {
    storedConfig = seededRbacConfig(1);
    const projectRefs = ["proj_1", "child-a", "child-b", "child-c", "child-d", "child-e"];
    userAppMetadata = {
      provider: "email",
      providers: ["email"],
      supaoauth: {
        schema_version: 2,
        projects: Object.fromEntries(projectRefs.map((ref) => [ref, {
          roles: [`stale-${ref}`],
          permissions: [`stale.${ref}.manage`],
          padding: "x".repeat(12_000),
          rbac_version: 1,
        }])),
      },
    };
    const assignment = await request("/v1/projects/proj_1/rbac/roles/role-0/assign", {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });

    expect(assignment.status).toBe(200);
    const supaoauth = userAppMetadata.supaoauth as Record<string, unknown>;
    const projects = supaoauth.projects as Record<string, Record<string, unknown>>;
    expect(Object.keys(projects).sort()).toEqual([...projectRefs].sort());
    for (const projection of Object.values(projects)) {
      expect(projection).toMatchObject({
        roles: [],
        permissions: [],
        projection_unavailable: true,
        projection_limit: 65_536,
      });
      expect("padding" in projection).toBe(false);
    }
  });

  test("clears all project namespaces when even minimal unavailable entries exceed 64 KiB", async () => {
    storedConfig = seededRbacConfig(1);
    const oversizedProjects = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [
      index === 0 ? "proj_1" : `child-${index.toString().padStart(3, "0")}`,
      {
        roles: ["stale-admin"],
        permissions: ["stale.manage"],
        padding: "x".repeat(200),
        rbac_version: 1,
      },
    ]));
    userAppMetadata = {
      provider: "email",
      supaoauth: { schema_version: 2, projects: oversizedProjects },
    };
    const assignment = await request("/v1/projects/proj_1/rbac/roles/role-0/assign", {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });

    expect(assignment.status).toBe(200);
    expect((userAppMetadata.supaoauth as Record<string, unknown>).projects).toEqual({});
  });

  test("fails read-back when GoTrue drops another project or non-RBAC metadata", async () => {
    userAppMetadata = {
      provider: "email",
      providers: ["email"],
      supaoauth: {
        profile: { role: "管理员" },
        schema_version: 2,
        projects: { other: { roles: ["other-reader"] } },
      },
    };
    transformPersistedMetadata = (metadata) => {
      const supaoauth = isRecord(metadata.supaoauth) ? metadata.supaoauth : {};
      const projects = isRecord(supaoauth.projects) ? supaoauth.projects : {};
      return {
        provider: metadata.provider,
        supaoauth: {
          ...supaoauth,
          projects: { proj_1: projects.proj_1 },
        },
      };
    };
    const role = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "admin" }),
    })).json() as { id: string };
    const assignment = await request(`/v1/projects/proj_1/rbac/roles/${role.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });

    expect(assignment.status).toBe(502);
    expect(await assignment.json()).toMatchObject({ message: "RBAC metadata read-back verification failed" });
    expect(projectProjection(userAppMetadata).projection_unavailable).toBe(true);
  });

  test("fails closed when the bounded GoTrue request times out", async () => {
    const role = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "admin" }),
    })).json() as { id: string };
    forcedGoTrueError = new DOMException("The operation timed out", "TimeoutError");
    const assignment = await request(`/v1/projects/proj_1/rbac/roles/${role.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });

    expect(assignment.status).toBe(500);
    expect(await assignment.json()).toMatchObject({ message: expect.stringContaining("unavailable compensation") });
    expect(gotrueRequests.at(-1)?.signal).toBeInstanceOf(AbortSignal);
    expect(userUpdateBodies).toEqual([]);
  });

  test("keeps revoke fail-closed when final projection sync fails and retry returns 404", async () => {
    const { roleId, assignmentId } = await createAssignedRole("revoke-admin", "project.revoke");
    rejectAvailableProjectionWrites = true;

    const revoke = await request(`/v1/projects/proj_1/rbac/roles/${roleId}/assign/${assignmentId}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(503);
    const storedRbac = storedConfig.rbac as { assignments: Array<{ id: string }> };
    expect(storedRbac.assignments.some((assignment) => assignment.id === assignmentId)).toBe(false);
    expect(projectProjection(userAppMetadata)).toMatchObject({
      roles: [],
      permissions: [],
      projection_unavailable: true,
      truncated: true,
    });

    const retry = await request(`/v1/projects/proj_1/rbac/roles/${roleId}/assign/${assignmentId}`, {
      method: "DELETE",
    });
    expect(retry.status).toBe(404);
    expect(projectProjection(userAppMetadata).projection_unavailable).toBe(true);
  });

  test("does not save a permission deletion when unavailable pre-sync fails", async () => {
    const { roleId, permissionId } = await createAssignedRole("permission-admin", "project.delete");
    const configBefore = JSON.stringify(storedConfig);
    forcedGoTrueError = new DOMException("The operation timed out", "TimeoutError");

    const deletion = await request(`/v1/projects/proj_1/rbac/roles/${roleId}/permissions/${permissionId}`, {
      method: "DELETE",
    });
    expect(deletion.status).toBe(500);
    expect(JSON.stringify(storedConfig)).toBe(configBefore);
    const storedRole = ((storedConfig.rbac as { roles: Array<{ id: string; permissions: unknown[] }> }).roles)
      .find((role) => role.id === roleId);
    expect(storedRole?.permissions).toHaveLength(1);
  });

  test("does not save a role deletion when unavailable pre-sync fails", async () => {
    const { roleId } = await createAssignedRole("role-delete-admin");
    const configBefore = JSON.stringify(storedConfig);
    forcedGoTrueError = new DOMException("The operation timed out", "TimeoutError");

    const deletion = await request(`/v1/projects/proj_1/rbac/roles/${roleId}`, { method: "DELETE" });
    expect(deletion.status).toBe(500);
    expect(JSON.stringify(storedConfig)).toBe(configBefore);
    expect((storedConfig.rbac as { roles: Array<{ id: string }> }).roles.some((role) => role.id === roleId)).toBe(true);
  });

  test("does not save a role update when unavailable pre-sync fails", async () => {
    const { roleId } = await createAssignedRole("role-update-admin");
    const configBefore = JSON.stringify(storedConfig);
    forcedGoTrueError = new DOMException("The operation timed out", "TimeoutError");

    const update = await request(`/v1/projects/proj_1/rbac/roles/${roleId}`, {
      method: "PUT",
      body: JSON.stringify({ name: "renamed-admin" }),
    });
    expect(update.status).toBe(500);
    expect(JSON.stringify(storedConfig)).toBe(configBefore);
    const storedRole = (storedConfig.rbac as { roles: Array<{ id: string; name: string }> }).roles
      .find((role) => role.id === roleId);
    expect(storedRole?.name).toBe("role-update-admin");
  });

  test("fails closed when GoTrue read-back does not contain the written project projection", async () => {
    persistUserUpdates = false;
    const role = await (await request("/v1/projects/proj_1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "admin" }),
    })).json() as { id: string };

    const assignment = await request(`/v1/projects/proj_1/rbac/roles/${role.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one" }),
    });

    expect(assignment.status).toBe(500);
    expect(await assignment.json()).toMatchObject({ message: expect.stringContaining("unavailable compensation") });
    expect(projectProjection(userAppMetadata)).toEqual({});
    expect(managementTransactionCalls.some(({ values }) =>
      values[0] === "rbac-user-metadata:proj_1:user-one"
    )).toBe(true);
  });
});
