// @supacloud-test-isolate
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const authModule = await import("../../src/middleware/auth");
const servicesModule = await import("../../src/services");
const dataPlaneModule = await import("../../src/services/dataplane-runtime.service");

const requireProjectOrAdminAuth = mock(async () => null);
const getProject = mock(async (ref: string) => ({ ref, config: {} }));
const status = mock(async () => ({
  component: "dataplane",
  desired: "stopped",
  actual: "stopped",
  health: "unknown",
  port: null,
  unit: "supacloud-dataplane@proj_1",
  last_error: null,
  updated_at: null,
  enabled: false,
}));
const stop = mock(async () => ({
  component: "dataplane",
  desired: "stopped",
  actual: "stopped",
  health: "unknown",
  port: null,
  unit: "supacloud-dataplane@proj_1",
  last_error: null,
  updated_at: null,
  enabled: true,
}));
const start = mock(async (): Promise<never> => {
  throw new dataPlaneModule.DataPlaneUnavailableError(
    "DATA_PLANE_DISABLED",
    "Data plane is disabled (DATA_PLANE_ENABLED=false); PostgREST remains the project REST data plane",
  );
});

const spies = [
  spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
    requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
  ),
  spyOn(servicesModule.projectService, "getProject").mockImplementation(
    getProject as unknown as typeof servicesModule.projectService.getProject,
  ),
  spyOn(dataPlaneModule.dataPlaneRuntimeService, "status").mockImplementation(
    status as unknown as typeof dataPlaneModule.dataPlaneRuntimeService.status,
  ),
  spyOn(dataPlaneModule.dataPlaneRuntimeService, "stop").mockImplementation(
    stop as unknown as typeof dataPlaneModule.dataPlaneRuntimeService.stop,
  ),
  spyOn(dataPlaneModule.dataPlaneRuntimeService, "start").mockImplementation(
    start as unknown as typeof dataPlaneModule.dataPlaneRuntimeService.start,
  ),
];

const { projectServiceRoutes } = await import(
  "../../src/routes/project-services?project-dataplane-services-routes-test"
);
const app = new Elysia().use(projectServiceRoutes);

function call(path: string, method: "GET" | "POST" = "GET") {
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: "Bearer dev-master-token" },
  }));
}

afterAll(() => spies.forEach((spy) => spy.mockRestore()));

beforeEach(() => {
  requireProjectOrAdminAuth.mockReset();
  requireProjectOrAdminAuth.mockResolvedValue(null);
  getProject.mockReset();
  getProject.mockImplementation(async (ref: string) => ({ ref, config: {} } as never));
  status.mockClear();
  stop.mockClear();
  start.mockClear();
});

describe("project data plane service routes", () => {
  test("GET status reports observed state without pretending to provision", async () => {
    const response = await call("/v1/projects/proj_1/services/dataplane/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      component: "dataplane",
      desired: "stopped",
      actual: "stopped",
      unit: "supacloud-dataplane@proj_1",
      enabled: false,
    });
    expect(status).toHaveBeenCalledWith("proj_1");
  });

  test("status returns 404 for an unknown project", async () => {
    getProject.mockResolvedValue(null as never);
    const response = await call("/v1/projects/proj_1/services/dataplane/status");
    expect(response.status).toBe(404);
    expect(status).not.toHaveBeenCalled();
  });

  test("stop is allowed: it is the rollback action while both planes coexist", async () => {
    const response = await call("/v1/projects/proj_1/services/dataplane/stop", "POST");
    expect(response.status).toBe(200);
    expect(stop).toHaveBeenCalledWith("proj_1");
    expect(await response.json()).toMatchObject({ service: "dataplane", action: "stop" });
  });

  test("start fails closed with an actionable code instead of a fake success", async () => {
    const response = await call("/v1/projects/proj_1/services/dataplane/start", "POST");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "DATA_PLANE_DISABLED",
      message: expect.stringContaining("PostgREST remains"),
    });
    expect(stop).not.toHaveBeenCalled();
  });

  test("status action through the service-control route reads without mutating", async () => {
    const response = await call("/v1/projects/proj_1/services/dataplane/status", "POST");
    expect(response.status).toBe(200);
    expect(status).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test("an unknown action is still rejected before reaching the service", async () => {
    const response = await call("/v1/projects/proj_1/services/dataplane/frobnicate", "POST");
    expect(response.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});