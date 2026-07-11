import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const getProject = mock(() => Promise.resolve({ ref: "proj_1", config: {} }));
const resolveProjectServiceRoleKey = mock(() => Promise.resolve("service-role-key"));

const authModule = await import("../../src/middleware/auth");
const servicesModule = await import("../../src/services");
const serviceRoleModule = await import("../../src/utils/service-role");

const requireProjectOrAdminAuthSpy = spyOn(
  authModule,
  "requireProjectOrAdminAuth",
).mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const getProjectSpy = spyOn(servicesModule.projectService, "getProject").mockImplementation(
  getProject as typeof servicesModule.projectService.getProject,
);
const resolveProjectServiceRoleKeySpy = spyOn(
  serviceRoleModule,
  "resolveProjectServiceRoleKey",
).mockImplementation(
  resolveProjectServiceRoleKey as typeof serviceRoleModule.resolveProjectServiceRoleKey,
);

const { userManagementRoutes } = await import("../../src/routes/auth-users");
const app = new Elysia().use(userManagementRoutes);
const originalFetch = globalThis.fetch;

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

describe("userManagementRoutes", () => {
  const userUpdateMethods: string[] = [];
  const userUpdateBodies: Array<Record<string, unknown>> = [];

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    getProject.mockReset();
    getProject.mockResolvedValue({ ref: "proj_1", config: {} } as never);
    resolveProjectServiceRoleKey.mockReset();
    resolveProjectServiceRoleKey.mockResolvedValue("service-role-key" as never);
    userUpdateMethods.length = 0;
    userUpdateBodies.length = 0;
  });

  test("PATCH user updates proxy to GoTrue with PUT for compatibility", async () => {
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      userUpdateMethods.push(init?.method ?? "GET");
      if (typeof init?.body === "string") {
        userUpdateBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return Response.json({ id: "user-one", email: "worker@example.test" });
    }) as unknown as typeof fetch;

    const res = await request("/v1/projects/proj_1/auth/users/user-one", {
      method: "PATCH",
      body: JSON.stringify({
        user_metadata: {
          houqin_profile_id: "profile-one",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(userUpdateMethods).toEqual(["PUT"]);
    expect(userUpdateBodies[0]).toEqual({
      user_metadata: {
        houqin_profile_id: "profile-one",
      },
    });
  });

  test("returns stable GoTrue errors when the upstream body is null", async () => {
    globalThis.fetch = mock(async () => Response.json(null, { status: 405 })) as unknown as typeof fetch;

    const res = await request("/v1/projects/proj_1/auth/users/user-one", {
      method: "PATCH",
      body: JSON.stringify({
        user_metadata: {
          houqin_profile_id: "profile-one",
        },
      }),
    });

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({
      message: "Failed to update user",
      code: "405",
    });
  });
});
