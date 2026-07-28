import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { projectService } from "../../src/services";
import { victoriaLogsService } from "../../src/services/victorialogs.service";
import { getProjectLogUnits, projectLogsRoutes } from "../../src/routes/project-logs";

const projectSpy = spyOn(projectService, "getProject");
const logsSpy = spyOn(victoriaLogsService, "queryProjectLogs");
const app = new Elysia().use(projectLogsRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe("project persisted log routes", () => {
  beforeEach(() => {
    projectSpy.mockResolvedValue({ ref: "proj_1" } as never);
    logsSpy.mockResolvedValue([
      {
        id: "log-1",
        timestamp: "2026-07-28T01:02:03.000Z",
        event_message: "request failed",
        severity: "error",
        service: "postgrest",
        metadata: { project_ref: "proj_1" },
      },
    ]);
  });

  afterAll(() => {
    projectSpy.mockRestore();
    logsSpy.mockRestore();
  });

  test("requires project auth and queries VictoriaLogs with filters", async () => {
    const path = "/v1/projects/proj_1/logs?limit=25&offset=5&service=postgrest&search=failed&start=2026-07-28T00%3A00%3A00Z";
    expect((await request(path)).status).toBe(401);

    const response = await request(path, { headers: { authorization: "Bearer dev-master-token" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      backend: "victorialogs",
      result: [{ event_message: "request failed", severity: "error", service: "postgrest" }],
      pagination: { offset: 5, limit: 25, total: 1 },
    });
    expect(logsSpy).toHaveBeenCalledWith("proj_1", {
      limit: 25,
      offset: 5,
      service: "postgrest",
      search: "failed",
      start: "2026-07-28T00:00:00Z",
      end: undefined,
    });
  });

  test("returns a stable unavailable response instead of querying Analytics", async () => {
    logsSpy.mockRejectedValueOnce(new Error("VictoriaLogs query failed (503)"));
    const response = await request("/v1/projects/proj_1/logs", {
      headers: { authorization: "Bearer dev-master-token" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "LOG_STORE_UNAVAILABLE",
      backend: "victorialogs",
    });
  });

  test("never subscribes a project stream to shared realtime or caddy journals", () => {
    expect(getProjectLogUnits("proj_1")).toEqual([
      "supacloud-gotrue@proj_1",
      "supacloud-pgrst@proj_1",
      "supacloud-postgres@proj_1",
      "supacloud-storage@proj_1",
    ]);
    expect(() => getProjectLogUnits("proj_1", "realtime")).toThrow("project-isolated");
    expect(() => getProjectLogUnits("proj_1", "caddy")).toThrow("project-isolated");
  });

  test("rejects shared or unknown services before starting an SSE process", async () => {
    for (const service of ["realtime", "caddy", "unknown"]) {
      const response = await request(`/v1/projects/proj_1/logs/stream?service=${service}`, {
        headers: { authorization: "Bearer dev-master-token" },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_LOG_SERVICE" });
    }
  });
});
