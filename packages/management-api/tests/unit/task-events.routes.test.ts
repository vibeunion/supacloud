import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const findByRef = mock(() => Promise.resolve(null));
const updateConfig = mock(() => Promise.resolve(null));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));

const { projectRepository } = await import("../../src/repositories/project.repository");
const authModule = await import("../../src/middleware/auth");

const findByRefSpy = spyOn(projectRepository, "findByRef").mockImplementation(findByRef as typeof projectRepository.findByRef);
const updateConfigSpy = spyOn(projectRepository, "updateConfig").mockImplementation(updateConfig as typeof projectRepository.updateConfig);
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);

const { taskEventRoutes } = await import("../../src/routes/task-events");
const app = new Elysia().use(taskEventRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  }));
}

describe("taskEventRoutes", () => {
  afterAll(() => {
    findByRefSpy.mockRestore();
    updateConfigSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
  });

  beforeEach(() => {
    findByRef.mockReset();
    updateConfig.mockReset();
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
  });

  test("POST /webhook stores webhook config in project settings", async () => {
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: {},
    } as never);
    updateConfig.mockResolvedValue({
      ref: "proj_1",
      config: {
        task_event_webhook: {
          url: "https://example.com/task-events",
          secret: "secret-123",
        },
      },
    } as never);

    const response = await request("/v1/projects/proj_1/task-events/webhook", {
      method: "POST",
      body: JSON.stringify({
        url: "https://example.com/task-events",
        secret: "secret-123",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      registered: true,
      project_ref: "proj_1",
      url: "https://example.com/task-events",
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });

  test("GET /webhook returns the persisted webhook config", async () => {
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: {
        task_event_webhook: {
          url: "https://example.com/task-events",
          secret: "secret-123",
        },
      },
    } as never);

    const response = await request("/v1/projects/proj_1/task-events/webhook");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      project_ref: "proj_1",
      url: "https://example.com/task-events",
      has_secret: true,
    });
  });

  test("DELETE /webhook removes webhook config", async () => {
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: {
        task_event_webhook: {
          url: "https://example.com/task-events",
          secret: "secret-123",
        },
      },
    } as never);
    updateConfig.mockResolvedValue({
      ref: "proj_1",
      config: {},
    } as never);

    const response = await request("/v1/projects/proj_1/task-events/webhook", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      unregistered: true,
      project_ref: "proj_1",
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });
});
