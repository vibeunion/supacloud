import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { projectServiceRoutes } from "../../src/routes/project-services";
import { projectService } from "../../src/services";
import {
  projectAuthServiceEntry,
  tenantRuntimeService,
  type PostgrestRuntimeStatus,
  type ProjectServiceStatus,
} from "../../src/services/tenant-runtime.service";

const app = new Elysia().use(projectServiceRoutes);
const authHeaders = { Authorization: "Bearer dev-master-token" };

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { ...authHeaders, ...(init.headers || {}) },
    }),
  );
}

function project(ref = "proj_1") {
  return {
    id: ref,
    ref,
    name: "Project 1",
    status: "active",
    organization_id: "default",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function postgrestStatus(overrides: Partial<PostgrestRuntimeStatus> = {}): PostgrestRuntimeStatus {
  return {
    component: "postgrest",
    desired: "running",
    actual: "running",
    port: 3101,
    unit: "supacloud-pgrst@proj_1",
    health: "healthy",
    last_error: null,
    updated_at: "2026-05-16T00:00:00.000Z",
    last_reconciled_at: "2026-05-16T00:00:00.000Z",
    ...overrides,
  };
}

const externalAuthProjectConfig = {
  auth: {
    third_party_auth: {
      enabled: true,
      auth_endpoint_mode: "external",
      auth_upstream: "127.0.0.1:3367",
    },
  },
};

const inactiveGoTrueService: ProjectServiceStatus = {
  id: "gotrue",
  name: "GoTrue",
  status: "UNHEALTHY",
  healthy: false,
  service_host_ids: ["proj_1-gotrue"],
};

describe("project external Auth service status", () => {
  test("reports expected local GoTrue shutdown as inactive", () => {
    expect(projectAuthServiceEntry(inactiveGoTrueService, {
      project_ref: "proj_1",
      mode: "local",
      authority_project_ref: "proj_1",
      local_gotrue_enabled: true,
    }, externalAuthProjectConfig)).toMatchObject({
      status: "INACTIVE",
      healthy: false,
      runtime_mode: "external",
      local_runtime_enabled: false,
      unit: "supacloud-gotrue@proj_1",
    });
  });

  test("keeps an unexpectedly active local GoTrue visible", () => {
    const activeEntry = projectAuthServiceEntry({
      ...inactiveGoTrueService,
      status: "ACTIVE_HEALTHY",
      healthy: true,
    }, {
      project_ref: "proj_1",
      mode: "local",
      authority_project_ref: "proj_1",
      local_gotrue_enabled: true,
    }, externalAuthProjectConfig);

    expect(activeEntry).toMatchObject({
      status: "ACTIVE_HEALTHY",
      healthy: true,
      runtime_mode: "external",
      local_runtime_enabled: false,
    });
  });

  test("keeps SupaCloud shared Auth ownership authoritative", () => {
    expect(projectAuthServiceEntry(inactiveGoTrueService, {
      project_ref: "proj_1",
      mode: "shared",
      authority_project_ref: "auth_owner",
      local_gotrue_enabled: false,
    }, externalAuthProjectConfig)).toMatchObject({
      status: "UNHEALTHY",
      runtime_mode: "shared",
      managed_by_ref: "auth_owner",
      local_runtime_enabled: false,
      unit: "supacloud-gotrue@auth_owner",
    });
  });
});

describe("project service PostgREST runtime controls", () => {
  test("returns PostgREST desired and actual runtime status", async () => {
    const originalGetProject = projectService.getProject;
    const originalStatusPostgrest = tenantRuntimeService.statusPostgrest;
    projectService.getProject = async () => project() as never;
    tenantRuntimeService.statusPostgrest = async () =>
      postgrestStatus({ desired: "stopped", actual: "stopped", health: "unknown" });

    try {
      const response = await request("/v1/projects/proj_1/services/postgrest/status");
      const raw = await response.text();
      const body = JSON.parse(raw);

      expect(response.status).toBe(200);
      expect(body.component).toBe("postgrest");
      expect(body.desired).toBe("stopped");
      expect(body.actual).toBe("stopped");
      expect(body.unit).toBe("supacloud-pgrst@proj_1");
    } finally {
      projectService.getProject = originalGetProject;
      tenantRuntimeService.statusPostgrest = originalStatusPostgrest;
    }
  });

  test("lists PostgREST observability fields in project services", async () => {
    const originalGetProject = projectService.getProject;
    const originalGetProjectServiceStatuses = tenantRuntimeService.getProjectServiceStatuses;
    projectService.getProject = async () => project() as never;
    tenantRuntimeService.getProjectServiceStatuses = async () => [
      {
        id: "db",
        name: "db",
        status: "ACTIVE_HEALTHY",
        healthy: true,
        service_host_ids: ["proj_1-db"],
      },
      {
        id: "rest",
        name: "rest",
        status: "UNHEALTHY",
        healthy: false,
        service_host_ids: ["proj_1-rest"],
        component: "postgrest",
        desired_state: "running",
        actual_state: "error",
        health: "unhealthy",
        port: 3101,
        unit: "supacloud-pgrst@proj_1",
        last_error: "connect ECONNREFUSED 127.0.0.1:3101",
        updated_at: "2026-05-16T00:00:00.000Z",
        last_reconciled_at: "2026-05-16T00:00:00.000Z",
      },
      {
        id: "auth",
        name: "auth",
        status: "ACTIVE_HEALTHY",
        healthy: true,
        service_host_ids: ["proj_1-auth"],
      },
      {
        id: "realtime",
        name: "realtime",
        status: "ACTIVE_HEALTHY",
        healthy: true,
        service_host_ids: ["proj_1-realtime"],
      },
      {
        id: "storage",
        name: "storage",
        status: "ACTIVE_HEALTHY",
        healthy: true,
        service_host_ids: ["proj_1-storage"],
      },
    ] as never;

    try {
      const response = await request("/v1/projects/proj_1/services");
      const body = await response.json();
      const rest = body.find((service: Record<string, unknown>) => service.id === "rest");

      expect(response.status).toBe(200);
      expect(rest.component).toBe("postgrest");
      expect(rest.status).toBe("UNHEALTHY");
      expect(rest.desired_state).toBe("running");
      expect(rest.actual_state).toBe("error");
      expect(rest.last_error).toContain("ECONNREFUSED");
    } finally {
      projectService.getProject = originalGetProject;
      tenantRuntimeService.getProjectServiceStatuses = originalGetProjectServiceStatuses;
    }
  });

  test("routes PostgREST stop action through pausePostgrest only", async () => {
    const originalGetProject = projectService.getProject;
    const originalPausePostgrest = tenantRuntimeService.pausePostgrest;
    const originalResumePostgrest = tenantRuntimeService.resumePostgrest;
    projectService.getProject = async () => project() as never;
    tenantRuntimeService.pausePostgrest = async () =>
      postgrestStatus({ desired: "stopped", actual: "stopped", health: "unknown" });
    tenantRuntimeService.resumePostgrest = async () => postgrestStatus();

    try {
      const response = await request("/v1/projects/proj_1/services/postgrest/stop", {
        method: "POST",
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.service).toBe("postgrest");
      expect(body.runtime.desired).toBe("stopped");
      expect(body.runtime.actual).toBe("stopped");
    } finally {
      projectService.getProject = originalGetProject;
      tenantRuntimeService.pausePostgrest = originalPausePostgrest;
      tenantRuntimeService.resumePostgrest = originalResumePostgrest;
    }
  });
});
