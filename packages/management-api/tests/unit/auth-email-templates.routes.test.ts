import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const getProjectSettings = mock(() => Promise.resolve(null));
const updateProjectSettings = mock(() => Promise.resolve({}));
const restartRuntime = mock(() => Promise.resolve());

const authModule = await import("../../src/middleware/auth");
const servicesModule = await import("../../src/services");
const tenantRuntimeModule = await import("../../src/services/tenant-runtime.service");

const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const getProjectSettingsSpy = spyOn(servicesModule.projectService, "getProjectSettings").mockImplementation(
  getProjectSettings as typeof servicesModule.projectService.getProjectSettings,
);
const updateProjectSettingsSpy = spyOn(servicesModule.projectService, "updateProjectSettings").mockImplementation(
  updateProjectSettings as typeof servicesModule.projectService.updateProjectSettings,
);
const restartRuntimeSpy = spyOn(tenantRuntimeModule.tenantRuntimeService, "restartRuntime").mockImplementation(
  restartRuntime as typeof tenantRuntimeModule.tenantRuntimeService.restartRuntime,
);

const { projectCrudRoutes } = await import("../../src/routes/project-crud");

const app = new Elysia().use(projectCrudRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        Authorization: "Bearer dev-master-token",
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    }),
  );
}

describe("project auth email template routes", () => {
  afterAll(() => {
    requireProjectOrAdminAuthSpy.mockRestore();
    getProjectSettingsSpy.mockRestore();
    updateProjectSettingsSpy.mockRestore();
    restartRuntimeSpy.mockRestore();
  });

  beforeEach(() => {
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    getProjectSettings.mockReset();
    getProjectSettings.mockResolvedValue({
      auth: {
        mailer_subjects_confirmation: "Custom confirmation",
        mailer_templates_confirmation_content: "<p>Confirm</p>",
      },
    } as never);
    updateProjectSettings.mockReset();
    updateProjectSettings.mockImplementation(async (_ref, settings) => settings as never);
    restartRuntime.mockReset();
    restartRuntime.mockResolvedValue(undefined);
  });

  test("GET returns canonical template map and legacy Studio-compatible fields", async () => {
    const res = await request("/v1/projects/proj_1/auth/template");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.templates.confirmation).toEqual({
      subject: "Custom confirmation",
      content: "<p>Confirm</p>",
    });
    expect(body.confirmation_mail).toEqual(body.templates.confirmation);
    expect(body.variables).toContain(".ConfirmationURL");
    expect(requireProjectOrAdminAuth).toHaveBeenCalledWith(expect.any(Request), "proj_1");
  });

  test("PUT saves canonical templates to auth config and restarts runtime", async () => {
    const res = await request("/v1/projects/proj_1/auth/template", {
      method: "PUT",
      body: JSON.stringify({
        templates: {
          confirmation: {
            subject: "Verify your account",
            content: "<p>{{ .ConfirmationURL }}</p>",
          },
          recovery: {
            subject: "Reset",
            content: "<p>{{ .Token }}</p>",
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      saved: true,
      templates: {
        confirmation: {
          subject: "Verify your account",
          content: "<p>{{ .ConfirmationURL }}</p>",
        },
        recovery: {
          subject: "Reset",
          content: "<p>{{ .Token }}</p>",
        },
      },
    });

    expect(updateProjectSettings).toHaveBeenCalledWith("proj_1", {
      auth: expect.objectContaining({
        mailer_subjects_confirmation: "Verify your account",
        mailer_templates_confirmation_content: "<p>{{ .ConfirmationURL }}</p>",
        mailer_subjects_recovery: "Reset",
        mailer_templates_recovery_content: "<p>{{ .Token }}</p>",
      }),
    });
    expect(restartRuntime).toHaveBeenCalledWith("proj_1");
  });

  test("PUT rejects empty payloads instead of pretending success", async () => {
    const res = await request("/v1/projects/proj_1/auth/template", {
      method: "PUT",
      body: JSON.stringify({ templates: {} }),
    });

    expect(res.status).toBe(400);
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(restartRuntime).not.toHaveBeenCalled();
  });

  test("PUT rejects empty email subjects before persisting or restarting", async () => {
    const res = await request("/v1/projects/proj_1/auth/template", {
      method: "PUT",
      body: JSON.stringify({
        templates: {
          confirmation: {
            subject: "   ",
            content: "<p>{{ .ConfirmationURL }}</p>",
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      message: "Email subject for template 'confirmation' must not be empty",
    });
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(restartRuntime).not.toHaveBeenCalled();
  });

  test("DELETE clears canonical and legacy template keys for rollback", async () => {
    getProjectSettings.mockResolvedValue({
      auth: {
        mailer_subjects_confirmation: "Custom confirmation",
        mailer_templates_confirmation_content: "<p>Confirm</p>",
        MAILER_SUBJECTS_RECOVERY: "Legacy recovery",
      },
    } as never);

    const res = await request("/v1/projects/proj_1/auth/template", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const [, settings] = updateProjectSettings.mock.calls[0];
    expect(settings.auth).not.toHaveProperty("mailer_subjects_confirmation");
    expect(settings.auth).not.toHaveProperty("mailer_templates_confirmation_content");
    expect(settings.auth).not.toHaveProperty("MAILER_SUBJECTS_RECOVERY");
    expect(await res.json()).toMatchObject({
      reset: true,
      templates: {
        confirmation: { subject: "Confirm your signup", content: "" },
      },
    });
  });
});
