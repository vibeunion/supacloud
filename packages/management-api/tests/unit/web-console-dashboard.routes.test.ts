// @supacloud-test-isolate
import { afterEach, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import * as authModule from "../../src/middleware/auth";
import { systemRoutes } from "../../src/routes/system";
import * as systemInfoModule from "../../src/services/system-info";
import { formatSystemInfo, type SystemInfoSnapshot } from "../../src/services/system-info";
import { projectCrudRoutes } from "../../src/routes/project-crud";
import { projectService } from "../../src/services";
import { publicProjectList } from "../../src/services/project-list-response";

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

function systemSnapshot(): SystemInfoSnapshot {
  return {
    cpus: [{ user: 10, nice: 5, sys: 5, idle: 75, irq: 5 }],
    totalMemory: 2048 * 1024 * 1024, freeMemory: 1024 * 1024 * 1024,
    uptime: 93780, processUptime: 30.9, version: "1.2.3-beta+sha",
    platform: "linux", arch: "arm64", hostname: "test",
  };
}

test("system info formatter emits the canonical dashboard projection and rejects invalid snapshots", () => {
  const snapshot = systemSnapshot();
  expect(formatSystemInfo(snapshot)).toMatchObject({
    cpu: "25.0%", memory: "1024 / 2048 MB", uptime: "1d 2h 3m", version: "1.2.3-beta+sha",
    processUptime: 30,
  });
  for (const uptime of [0, 59, 60, 3599, 3600, 86399, 86400, 90000, 10 ** 9, Number.MAX_SAFE_INTEGER]) {
    expect(formatSystemInfo({ ...snapshot, uptime }).uptime).toBeDefined();
  }
  for (const idle of [0, 100]) {
    expect(formatSystemInfo({
      ...snapshot, cpus: [{ user: 100 - idle, nice: 0, sys: 0, idle, irq: 0 }],
    }).cpu).toBe(idle === 0 ? "100.0%" : "0.0%");
  }
  for (const patch of [
    { cpus: [] }, { cpus: [{ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }] },
    { cpus: [{ user: Number.NaN, nice: 0, sys: 0, idle: 1, irq: 0 }] },
    { totalMemory: 0 }, { freeMemory: Number.MAX_SAFE_INTEGER }, { uptime: Infinity },
    { processUptime: -1 }, { version: "" }, { hostname: "\0" },
  ]) expect(() => formatSystemInfo({ ...snapshot, ...patch } as SystemInfoSnapshot)).toThrow();
});

test("project list projection keeps public lifecycle fields and rejects private or ambiguous rows", () => {
  const input = {
    ...projectRecord(), db_password: "private-password", config: { secret: "private-config" },
  };
  expect(publicProjectList([input])).toEqual([{
    id: "id-a", ref: "a", organization_id: "default", organization_slug: "default",
    name: "Project a", region: "local", created_at: "2026-09-01T00:00:00.000Z", status: "ACTIVE_HEALTHY",
  }]);
  for (const [status, expected] of [["creating", "COMING_UP"], ["paused", "INACTIVE"], ["deleted", "INACTIVE"]]) {
    expect(publicProjectList([{ ...input, status }])[0]?.status).toBe(expected);
  }
  expect(publicProjectList([])).toEqual([]);
  for (const row of [
    null, [], {}, { ...input, id: undefined }, { ...input, ref: "../escape" },
    { ...input, organization_id: undefined }, { ...input, status: undefined },
    { ...input, created_at: "2026-02-30T00:00:00.000Z" },
  ]) expect(() => publicProjectList([row])).toThrow();
  expect(() => publicProjectList([input, input])).toThrow();
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
