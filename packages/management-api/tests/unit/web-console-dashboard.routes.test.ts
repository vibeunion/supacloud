// @supacloud-test-isolate
import { afterEach, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import * as authModule from "../../src/middleware/auth";
import { systemRoutes } from "../../src/routes/system";
import * as systemInfoModule from "../../src/services/system-info";
import { projectCrudRoutes } from "../../src/routes/project-crud";
import { projectService } from "../../src/services";

function projectRecord(ref = "a") {
  return {
    id: `id-${ref}`,
    ref,
    organization_id: "default",
    organization_slug: "default",
    name: `Project ${ref}`,
    region: "local",
    created_at: "2026-09-01T00:00:00.000Z",
    status: "active",
  };
}

const originalToken = config.masterToken;

afterEach(() => {
  config.masterToken = originalToken;
});

test("system info route requires administrator authorization and sanitizes collection failures", async () => {
  config.masterToken = "dashboard-test-master-token";
  const collect = spyOn(systemInfoModule, "collectSystemInfo").mockResolvedValue({
    cpu: "25.0%", memory: "1024 / 2048 MB", uptime: "1d 2h 3m", version: "1.2.3-beta+sha",
    cores: 1, platform: "linux", arch: "arm64", hostname: "test", processUptime: 30,
  });
  const app = new Elysia().use(systemRoutes);
  const request = (authorized = true) => app.handle(new Request("http://localhost/v1/system/info", {
    headers: authorized ? { Authorization: "Bearer dashboard-test-master-token" } : {},
  }));
  try {
    const denied = await request(false);
    expect(denied.status).toBe(401);
    expect(collect).not.toHaveBeenCalled();

    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: "1.2.3-beta+sha", platform: "linux" });

    collect.mockRejectedValue(new Error("private system failure"));
    const unavailable = await request();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      code: "SYSTEM_INFO_UNAVAILABLE", message: "System information unavailable",
    });

    const auth = spyOn(authModule, "getAuthContext").mockResolvedValue({
      role: "project", ref: "a", principalId: "project:a",
    });
    try {
      collect.mockClear();
      expect((await request()).status).toBe(403);
      expect(collect).not.toHaveBeenCalled();
    } finally {
      auth.mockRestore();
    }
  } finally {
    collect.mockRestore();
  }
});

test("project list routes preserve authorization, project scope and unavailable state", async () => {
  config.masterToken = "project-list-test-master-token";
  const list = spyOn(projectService, "listProjects").mockResolvedValue([projectRecord()]);
  const lookup = spyOn(projectService, "getProject").mockResolvedValue({ ...projectRecord(), config: {} });
  const app = new Elysia().use(projectCrudRoutes);
  const request = (suffix = "", authorized = true) => app.handle(new Request(`http://localhost/v1/projects${suffix}`, {
    headers: authorized ? { Authorization: "Bearer project-list-test-master-token" } : {},
  }));
  try {
    const denied = await request("", false);
    expect(denied.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
    for (const suffix of ["", "/"]) {
      const response = await request(suffix);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([projectRecord()].map(project => ({
        ...project, status: "ACTIVE_HEALTHY",
      })));
    }

    list.mockResolvedValue([{ ...projectRecord(), created_at: new Date(NaN) }]);
    expect((await request()).status).toBe(503);
    list.mockRejectedValue(new Error("private storage failure"));
    const unavailable = await request();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("private storage failure");

    const auth = spyOn(authModule, "getAuthContext").mockResolvedValue({
      role: "project", ref: "a", principalId: "project:a",
    });
    try {
      list.mockClear();
      const scoped = await request();
      expect(scoped.status).toBe(200);
      expect((await scoped.json()).map((row: { ref: string }) => row.ref)).toEqual(["a"]);
      expect(list).not.toHaveBeenCalled();
      lookup.mockResolvedValue({ ...projectRecord("b"), config: {} });
      expect((await request()).status).toBe(503);
      lookup.mockResolvedValue(null);
      const missing = await request();
      expect(missing.status).toBe(200);
      expect(await missing.json()).toEqual([]);
    } finally {
      auth.mockRestore();
    }
  } finally {
    list.mockRestore();
    lookup.mockRestore();
  }
});
