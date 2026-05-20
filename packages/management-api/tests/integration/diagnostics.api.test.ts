import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { diagnosticsRoutes } from "../../src/routes/diagnostics";
import * as diagnosticsService from "../../src/services/diagnostics.service";

const app = new Elysia().use(diagnosticsRoutes);
const authHeaders = { Authorization: "Bearer dev-master-token" };

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(authHeaders)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
}

function unauthenticatedRequest(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

const runDiagnostics = mock(() => Promise.resolve({
  id: "run_1",
  scope: "project",
  projectRef: "proj_1",
  status: "completed",
  startedAt: new Date("2026-05-20T00:00:00.000Z"),
  completedAt: new Date("2026-05-20T00:00:01.000Z"),
  summary: { total: 1, pass: 1, drift: 0, missing: 0, tampered: 0, unreachable: 0, degraded: 0, error: 0 },
}));

const getRun = mock(() => Promise.resolve({
  id: "run_1",
  scope: "project",
  projectRef: "proj_1",
  status: "completed",
  startedAt: new Date("2026-05-20T00:00:00.000Z"),
  completedAt: new Date("2026-05-20T00:00:01.000Z"),
  summary: { total: 1, pass: 1, drift: 0, missing: 0, tampered: 0, unreachable: 0, degraded: 0, error: 0 },
}));

const getRunResults = mock(() => Promise.resolve([
  {
    id: "result_1",
    runId: "run_1",
    checkId: "project-schema-hash",
    status: "pass",
    message: "Schema hash matches baseline or no baseline exists",
    detail: "sha256:abc",
    repairPreview: null,
    repairCommand: null,
    metadata: { hash: "abc" },
    createdAt: new Date("2026-05-20T00:00:01.000Z"),
  },
]));

const executeRepair = mock(() => Promise.resolve({ success: true, message: "repaired" }));

spyOn(diagnosticsService, "runDiagnostics").mockImplementation(
  runDiagnostics as typeof diagnosticsService.runDiagnostics,
);
spyOn(diagnosticsService, "getRun").mockImplementation(
  getRun as typeof diagnosticsService.getRun,
);
spyOn(diagnosticsService, "getRunResults").mockImplementation(
  getRunResults as typeof diagnosticsService.getRunResults,
);
spyOn(diagnosticsService, "executeRepair").mockImplementation(
  executeRepair as typeof diagnosticsService.executeRepair,
);

describe("diagnostics API", () => {
  beforeEach(() => {
    runDiagnostics.mockClear();
    getRun.mockClear();
    getRunResults.mockClear();
    executeRepair.mockClear();
  });

  test("runs project diagnostics", async () => {
    const response = await request("/v1/projects/proj_1/diagnostics/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.id).toBe("run_1");
    expect(runDiagnostics).toHaveBeenCalledWith("project", "proj_1", undefined);
  });

  test("reads project diagnostic results", async () => {
    const response = await request("/v1/projects/proj_1/diagnostics/runs/run_1/results");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.run.id).toBe("run_1");
    expect(body.results[0].checkId).toBe("project-schema-hash");
    expect(getRun).toHaveBeenCalledWith("run_1");
    expect(getRunResults).toHaveBeenCalledWith("run_1");
  });

  test("requires admin auth before repairing diagnostic results", async () => {
    const response = await unauthenticatedRequest("/v1/diagnostics/results/result_1/repair", {
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(executeRepair).not.toHaveBeenCalled();
  });
});
