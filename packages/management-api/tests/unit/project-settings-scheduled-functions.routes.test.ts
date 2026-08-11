// @supacloud-test-isolate
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const authModule = await import("../../src/middleware/auth");
const servicesModule = await import("../../src/services");
const { config } = await import("../../src/config");

const requireProjectOrAdminAuth = mock(async () => null);
const getProjectSettings = mock(async () => projectSettings());
const updateProjectSettings = mock(async () => projectSettings());

const authSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const getSettingsSpy = spyOn(
  servicesModule.projectService,
  "getProjectSettings",
).mockImplementation(
  getProjectSettings as typeof servicesModule.projectService.getProjectSettings,
);
const updateSettingsSpy = spyOn(
  servicesModule.projectService,
  "updateProjectSettings",
).mockImplementation(
  updateProjectSettings as typeof servicesModule.projectService.updateProjectSettings,
);

const { projectConfigRoutes } = await import(
  "../../src/routes/project-config?project-settings-scheduled-functions-test"
);
const app = new Elysia().use(projectConfigRoutes);
const originalOwnerRef = config.authRuntimeOwnerRef;

function projectSettings() {
  return {
    api_domain: "tenant-a.api.example.com",
    scheduled_functions: [{
      id: "00000000-0000-4000-8000-000000000001",
      name: "Nightly",
      slug: "worker",
      cron: "0 2 * * *",
      method: "POST" as const,
      body: { token: "private-settings-body-sentinel" },
      headers: { "x-schedule-token": "private-settings-header-sentinel" },
      enabled: true,
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
    }],
  };
}

function request(method: "GET" | "PUT", body?: Record<string, unknown>) {
  return app.handle(new Request("http://localhost/v1/projects/tenant-a/settings", {
    method,
    headers: {
      authorization: "Bearer dev-master-token",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  }));
}

function expectPublicSchedule(responseBody: Record<string, unknown>) {
  const schedules = responseBody.scheduled_functions as Array<Record<string, unknown>>;
  expect(schedules[0]).toMatchObject({
    id: "00000000-0000-4000-8000-000000000001",
    body_empty: false,
    header_names: ["x-schedule-token"],
  });
  expect(schedules[0]).not.toHaveProperty("body");
  expect(schedules[0]).not.toHaveProperty("headers");
  expect(JSON.stringify(responseBody)).not.toContain("private-settings-body-sentinel");
  expect(JSON.stringify(responseBody)).not.toContain("private-settings-header-sentinel");
}

afterAll(() => {
  config.authRuntimeOwnerRef = originalOwnerRef;
  authSpy.mockRestore();
  getSettingsSpy.mockRestore();
  updateSettingsSpy.mockRestore();
});

beforeEach(() => {
  config.authRuntimeOwnerRef = "";
  requireProjectOrAdminAuth.mockReset();
  requireProjectOrAdminAuth.mockResolvedValue(null);
  getProjectSettings.mockReset();
  getProjectSettings.mockResolvedValue(projectSettings() as never);
  updateProjectSettings.mockReset();
  updateProjectSettings.mockResolvedValue(projectSettings() as never);
});

describe("project settings scheduled-function boundary", () => {
  test.each([
    ["local", ""],
    ["shared", "auth-owner"],
  ])("redacts GET and safe PUT responses in %s auth mode", async (_mode, ownerRef) => {
    config.authRuntimeOwnerRef = ownerRef;

    const getResponse = await request("GET");
    const getBody = await getResponse.json() as Record<string, unknown>;
    expect(getResponse.status).toBe(200);
    expectPublicSchedule(getBody);

    const putResponse = await request("PUT", { api_domain: "updated.api.example.com" });
    const putBody = await putResponse.json() as Record<string, unknown>;
    expect(putResponse.status).toBe(200);
    expectPublicSchedule(putBody);
  });

  test.each([
    ["local", ""],
    ["shared", "auth-owner"],
  ])("rejects generic scheduled-function writes with zero persistence in %s auth mode", async (_mode, ownerRef) => {
    config.authRuntimeOwnerRef = ownerRef;
    const bypassSchedules = Array.from({ length: 21 }, (_, index) => ({
      id: `bypass-${index}`,
      name: `Bypass ${index}`,
      slug: `bypass-${index}`,
      cron: "* * * * *",
      method: "POST",
      headers: { host: "attacker.invalid" },
      enabled: true,
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
    }));

    const response = await request("PUT", { scheduled_functions: bypassSchedules });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "SCHEDULED_FUNCTION_API_REQUIRED",
      message: "Scheduled functions must be managed through the dedicated scheduled-functions API",
    });
    expect(updateProjectSettings).not.toHaveBeenCalled();
  });
});
