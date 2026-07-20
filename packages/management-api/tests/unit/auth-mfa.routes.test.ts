import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const FACTOR_ID = "00000000-0000-4000-8000-000000000002";

const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const getProject = mock(() => Promise.resolve({
  ref: "proj_1",
  config: { postgrest_port: 54321, gotrue_port: 9999 },
}));
const resolveProjectServiceRoleKey = mock(() => Promise.resolve("service-role-key"));

const authModule = await import("../../src/middleware/auth");
const servicesModule = await import("../../src/services");
const serviceRoleModule = await import("../../src/utils/service-role");
const dbModule = await import("../../src/db");

let databaseFailure: unknown = null;
let factorOwnerId: string | null = USER_ID;
const sqlStatements: string[] = [];
const sqlValues: unknown[][] = [];

const tenantDb = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const statement = strings.join("?");
  sqlStatements.push(statement);
  sqlValues.push(values);
  if (databaseFailure) throw databaseFailure;

  if (statement.includes("WITH filtered_factors")) {
    return Promise.resolve([{
      items: [{
        id: FACTOR_ID,
        user_id: USER_ID,
        user_email: "owner@example.test",
        friendly_name: "Work Authenticator",
        factor_type: "totp",
        status: "verified",
        created_at: "2026-07-19T00:00:00.000Z",
        updated_at: "2026-07-19T00:05:00.000Z",
        enrolled_factor_count: 2,
        verified_factor_count: 1,
        latest_session_aal: "aal2",
        latest_session_updated_at: "2026-07-19T00:04:00.000Z",
      }],
      total: "1",
    }]);
  }
  if (statement.includes("SELECT factor.user_id::text AS user_id")) {
    return Promise.resolve(factorOwnerId ? [{ user_id: factorOwnerId }] : []);
  }
  return Promise.resolve([]);
});

const requireAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const getProjectSpy = spyOn(servicesModule.projectService, "getProject").mockImplementation(
  getProject as typeof servicesModule.projectService.getProject,
);
const serviceRoleSpy = spyOn(serviceRoleModule, "resolveProjectServiceRoleKey").mockImplementation(
  resolveProjectServiceRoleKey as typeof serviceRoleModule.resolveProjectServiceRoleKey,
);
const resolveDbNameSpy = spyOn(dbModule, "resolveDbName").mockResolvedValue("supa_proj_1");
const getProjectDbSpy = spyOn(dbModule, "getProjectDb").mockReturnValue(tenantDb as never);

const { authMfaRoutes } = await import("../../src/routes/auth-mfa");
const app = new Elysia().use(swagger()).use(authMfaRoutes);
const originalFetch = globalThis.fetch;

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: "Bearer dev-master-token",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  }));
}

describe("authMfaRoutes", () => {
  afterAll(() => {
    globalThis.fetch = originalFetch;
    requireAuthSpy.mockRestore();
    getProjectSpy.mockRestore();
    serviceRoleSpy.mockRestore();
    resolveDbNameSpy.mockRestore();
    getProjectDbSpy.mockRestore();
  });

  beforeEach(() => {
    globalThis.fetch = originalFetch;
    databaseFailure = null;
    factorOwnerId = USER_ID;
    sqlStatements.length = 0;
    sqlValues.length = 0;
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    getProject.mockReset();
    getProject.mockResolvedValue({
      ref: "proj_1",
      config: { postgrest_port: 54321, gotrue_port: 9999 },
    } as never);
    resolveProjectServiceRoleKey.mockReset();
    resolveProjectServiceRoleKey.mockResolvedValue("service-role-key" as never);
  });

  test("lists only authoritative GoTrue TOTP factors with pagination and latest session AAL", async () => {
    const response = await request(
      `/v1/projects/proj_1/auth/factors?user_id=${USER_ID}&page=2&limit=10`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{
        id: FACTOR_ID,
        user_id: USER_ID,
        user_email: "owner@example.test",
        friendly_name: "Work Authenticator",
        factor_type: "totp",
        status: "verified",
        created_at: "2026-07-19T00:00:00.000Z",
        updated_at: "2026-07-19T00:05:00.000Z",
        enrolled_factor_count: 2,
        verified_factor_count: 1,
        latest_session_aal: "aal2",
        latest_session_updated_at: "2026-07-19T00:04:00.000Z",
      }],
      total: 1,
      page: 2,
      limit: 10,
    });
    expect(sqlStatements[0]).toContain("FROM auth.mfa_factors AS factor");
    expect(sqlStatements[0]).toContain("FROM auth.sessions AS session");
    expect(sqlStatements[0]).toContain("factor.factor_type::text = 'totp'");
    expect(sqlValues[0]).toEqual([USER_ID, USER_ID, 10, 10]);
  });

  test("rejects invalid list boundaries before querying tenant auth tables", async () => {
    const invalidUser = await request("/v1/projects/proj_1/auth/factors?user_id=not-a-uuid");
    expect(invalidUser.status).toBe(400);
    expect(await invalidUser.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    const invalidPage = await request("/v1/projects/proj_1/auth/factors?page=0&limit=101");
    expect(invalidPage.status).toBe(400);
    expect(await invalidPage.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    const unsafeOffset = await request("/v1/projects/proj_1/auth/factors?page=90071992547410&limit=100");
    expect(unsafeOffset.status).toBe(400);
    expect(await unsafeOffset.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(sqlStatements).toHaveLength(0);
  });

  test("returns capability unavailable instead of an empty list when GoTrue MFA tables are missing", async () => {
    databaseFailure = Object.assign(new Error("relation auth.mfa_factors does not exist"), { code: "42P01" });
    const response = await request("/v1/projects/proj_1/auth/factors");

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      reason_code: "gotrue_mfa_schema_unavailable",
    });
  });

  test("keeps the obsolete management enrollment route hidden and explicitly unavailable", async () => {
    const response = await request("/v1/projects/proj_1/auth/factors", {
      method: "POST",
      body: JSON.stringify({ factor_type: "totp" }),
    });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      reason_code: "gotrue_user_mfa_ceremony_required",
    });

    const openApiResponse = await request("/swagger/json");
    const openApi = await openApiResponse.json() as {
      paths: Record<string, { get?: unknown; post?: unknown }>;
    };
    const factorPath = openApi.paths["/v1/projects/{ref}/auth/factors"];
    expect(factorPath?.get).toBeDefined();
    expect(factorPath?.post).toBeUndefined();
  });

  test("deletes a factor only through the stock GoTrue user factor endpoint", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json({});
    }) as unknown as typeof fetch;

    const response = await request(`/v1/projects/proj_1/auth/factors/${FACTOR_ID}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, id: FACTOR_ID, source: "gotrue" });
    expect(requestUrl).toBe(`http://127.0.0.1:9999/admin/users/${USER_ID}/factors/${FACTOR_ID}`);
    expect(requestInit?.method).toBe("DELETE");
    expect((requestInit?.headers as Record<string, string>).Authorization).toBe("Bearer service-role-key");
    expect(sqlStatements.some((statement) => statement.includes("DELETE FROM auth"))).toBe(false);
  });

  test("returns 503 without a direct database fallback when GoTrue is unreachable", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const response = await request(`/v1/projects/proj_1/auth/factors/${FACTOR_ID}`, { method: "DELETE" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      reason_code: "gotrue_mfa_unavailable",
    });
    expect(sqlStatements.some((statement) => statement.includes("DELETE FROM auth"))).toBe(false);
  });

  test("does not call GoTrue when the TOTP factor does not exist", async () => {
    factorOwnerId = null;
    let upstreamCalls = 0;
    globalThis.fetch = mock(async () => {
      upstreamCalls += 1;
      return Response.json({});
    }) as unknown as typeof fetch;

    const response = await request(`/v1/projects/proj_1/auth/factors/${FACTOR_ID}`, { method: "DELETE" });
    expect(response.status).toBe(404);
    expect(upstreamCalls).toBe(0);
  });
});
