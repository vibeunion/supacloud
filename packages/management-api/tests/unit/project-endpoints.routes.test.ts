import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const requireAdminAuth = mock(() => Promise.resolve(undefined));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(undefined));
const listProjects = mock(() => Promise.resolve([]));
const getProject = mock(() => Promise.resolve(null));

const authModule = await import("../../src/middleware/auth");
const servicesModule = await import("../../src/services");

const requireAdminAuthSpy = spyOn(authModule, "requireAdminAuth").mockImplementation(
  requireAdminAuth as typeof authModule.requireAdminAuth,
);
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const listProjectsSpy = spyOn(servicesModule.projectService, "listProjects").mockImplementation(
  listProjects as typeof servicesModule.projectService.listProjects,
);
const getProjectSpy = spyOn(servicesModule.projectService, "getProject").mockImplementation(
  getProject as typeof servicesModule.projectService.getProject,
);

const { projectEndpointRoutes } = await import("../../src/routes/project-endpoints");
const app = new Elysia().use(projectEndpointRoutes);

function request(path: string) {
  return app.handle(new Request(`http://localhost${path}`, {
    headers: { Authorization: "Bearer test-token" },
  }));
}

const project = {
  ref: "abc123",
  config: {
    api_domain: "api.example.com",
    auth_domain: "auth.example.com",
    studio_domain: "studio.example.com",
  },
};

describe("project endpoint routes", () => {
  afterAll(() => {
    requireAdminAuthSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
    listProjectsSpy.mockRestore();
    getProjectSpy.mockRestore();
  });

  beforeEach(() => {
    requireAdminAuth.mockReset();
    requireAdminAuth.mockResolvedValue(undefined);
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(undefined);
    listProjects.mockReset();
    listProjects.mockResolvedValue([] as never);
    getProject.mockReset();
    getProject.mockResolvedValue(project as never);
  });

  test("returns one project-scoped endpoint projection", async () => {
    const response = await request("/v1/projects/abc123/endpoint/projection");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schema: "supacloud.project-endpoints.v1",
      project_ref: "abc123",
      endpoints: {
        api: {
          origin: "https://api.example.com",
          host: "api.example.com",
          source: "explicit_api_domain",
        },
        auth: {
          origin: "https://auth.example.com",
          host: "auth.example.com",
          source: "explicit_auth_domain",
        },
        studio: {
          origin: "https://studio.example.com",
          host: "studio.example.com",
          source: "explicit_studio_domain",
        },
      },
    });
    expect(requireProjectOrAdminAuth).toHaveBeenCalledWith(expect.any(Request), "abc123");
    expect(getProject).toHaveBeenCalledWith("abc123");
  });

  test("returns an Admin-only endpoint inventory", async () => {
    listProjects.mockResolvedValue([project] as never);

    const response = await request("/v1/projects/endpoints");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      schema: "supacloud.project-endpoints.v1",
      project_ref: "abc123",
    });
    expect(requireAdminAuth).toHaveBeenCalledWith(expect.any(Request));
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  test("does not read projects when authorization fails", async () => {
    requireAdminAuth.mockResolvedValue({
      status: 403,
      body: { error: "Admin privileges required" },
    });

    const response = await request("/v1/projects/endpoints");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      message: "Admin privileges required",
      code: "403",
    });
    expect(listProjects).not.toHaveBeenCalled();
  });

  test("returns 404 for a missing project", async () => {
    getProject.mockResolvedValue(null);

    const response = await request("/v1/projects/missing/endpoint/projection");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Project not found", code: "404" });
  });
});
