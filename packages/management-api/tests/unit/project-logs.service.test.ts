// @supacloud-test-isolate
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { projectRepository } from "../../src/repositories/project.repository";
import { ProjectLogService } from "../../src/services/project-logs.service";
import { victoriaLogsService } from "../../src/services/victorialogs.service";

const project = spyOn(projectRepository, "findByRef");
const logs = spyOn(victoriaLogsService, "queryProjectLogs");
const service = new ProjectLogService();

describe("legacy internal project log projection", () => {
  beforeEach(() => {
    project.mockReset();
    logs.mockReset();
    project.mockResolvedValue({
      id: "fixture", ref: "proj_1", organization_id: "fixture", name: "Fixture",
      db_name: "fixture", db_user: "fixture", db_password: "synthetic", jwt_secret: "synthetic",
      anon_key: "synthetic", service_role_key: "synthetic", s3_bucket: "fixture",
      s3_access_key: null, s3_secret_key: null, region: "local", status: "active",
      postgrest_desired: null, postgrest_actual: null, postgrest_health: null, postgrest_port: null,
      postgrest_last_error: null, postgrest_updated_at: null, postgrest_last_reconciled_at: null,
      config: {}, created_at: new Date(0), updated_at: new Date(0), deleted_at: null,
    });
    logs.mockResolvedValue([{
      id: "entry", timestamp: new Date(0).toISOString(), event_message: "redacted message",
      severity: "error", service: "postgrest", metadata: {},
    }]);
  });
  afterAll(() => {
    project.mockRestore();
    logs.mockRestore();
  });

  test("uses the canonical backend with a typed legacy projection and no journal process", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("A log read must not spawn a process"); });
    try {
      const entries = await service.queryLogs("proj_1", "api");
      expect(logs).toHaveBeenCalledWith("proj_1", { limit: 50, service: "postgrest" });
      expect(entries).toEqual([{
        id: "entry", timestamp: new Date(0).toISOString(), event_message: "redacted message",
        metadata: { items: [{ severity: "error", source: "api", syslog_identifier: "postgrest", message: "redacted message" }] },
      }]);
      expect(spawn).not.toHaveBeenCalled();
      await service.queryLogs("proj_1", "postgres");
      expect(logs).toHaveBeenLastCalledWith("proj_1", { limit: 50, service: "database" });
    } finally {
      spawn.mockRestore();
    }
  });

  test("rejects malformed identity before lookup and does not query missing projects", async () => {
    await expect(service.queryLogs("*")).rejects.toThrow("Invalid project ref");
    // @ts-expect-error Runtime callers cannot coerce an object to a filter.
    await expect(service.queryLogs("proj_1", {})).rejects.toThrow("Invalid log service filter");
    expect(project).not.toHaveBeenCalled();
    project.mockResolvedValue(null);
    expect(await service.queryLogs("missing")).toEqual([]);
    expect(logs).not.toHaveBeenCalled();
  });

  test("backend failures remain failures, never an empty successful log list", async () => {
    logs.mockRejectedValue(new Error("Invalid VictoriaLogs project record"));
    await expect(service.queryLogs("proj_1")).rejects.toThrow("Invalid VictoriaLogs project record");
    expect(logs).toHaveBeenCalledTimes(1);
  });
});
