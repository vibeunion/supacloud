import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { queryProjectLogsSql, executeLogSnapshot, redactProjectLogs } from "../../src/services/log-sql.service";
import { victoriaLogsService } from "../../src/services/victorialogs.service";

const querySpy = spyOn(victoriaLogsService, "queryProjectLogs");

describe("project log SQL", () => {
  beforeEach(() => {
    querySpy.mockResolvedValue([
      {
        id: "1",
        timestamp: "2026-10-01T00:00:00.000Z",
        event_message: "login failed",
        severity: "error",
        service: "auth",
        metadata: { request_id: "r1", password: "redacted" },
      },
      {
        id: "2",
        timestamp: "2026-10-01T00:01:00.000Z",
        event_message: "login ok",
        severity: "info",
        service: "auth",
        metadata: { request_id: "r2" },
      },
    ]);
  });

  afterAll(() => querySpy.mockRestore());

  test("filters and projects one scoped virtual table", async () => {
    const result = await queryProjectLogsSql(
      "proj_1",
      "SELECT id, service, event_message FROM project_logs WHERE severity = 'error' ORDER BY timestamp DESC LIMIT 10",
    );
    expect(result.project_ref).toBe("proj_1");
    expect(result.rows).toEqual([{ id: "1", service: "auth", event_message: "login failed" }]);
    expect(result.read_only).toBe(true);
  });

  test("supports bounded aggregate counts and redacts sensitive metadata", async () => {
    const result = await queryProjectLogsSql(
      "proj_1",
      "SELECT service, COUNT(*) AS total FROM project_logs GROUP BY service LIMIT 10",
    );
    expect(result.rows).toEqual([{ service: "auth", total: 2 }]);
    const metadata = await queryProjectLogsSql("proj_1", "SELECT metadata FROM project_logs LIMIT 1");
    expect(JSON.stringify(metadata.rows)).not.toContain("password");
  });

  test("rejects writes, joins, other tables and unbounded input", async () => {
    for (const query of [
      "DELETE FROM project_logs",
      "SELECT * FROM users",
      "SELECT * FROM project_logs JOIN users ON true",
      "SELECT * FROM project_logs; SELECT * FROM project_logs",
      "SELECT (SELECT 1) FROM project_logs",
      "SELECT randomblob(100000000) FROM project_logs",
      "SELECT * FROM project_logs LIMIT 1001",
    ]) {
      await expect(queryProjectLogsSql("proj_1", query)).rejects.toThrow();
    }
  });

  test("bounds rows and redacts nested JSON messages before SQL inspection", () => {
    const rows = Array.from({ length: 600 }, (_, index) => ({
      id: String(index), timestamp: "2026-10-05T00:00:00Z", service: "auth", severity: "info" as const,
      event_message: '{"password":"hidden-value","details":{"api_key":"hidden-key"}}',
      metadata: { nested: [{ authorization: "hidden-bearer", message: "secret=hidden-message" }] },
    }));
    const result = executeLogSnapshot("demo", "SELECT * FROM project_logs", rows);
    expect(result.rows).toHaveLength(500);
    expect(result.result_truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("hidden-");
    expect(JSON.stringify(redactProjectLogs(rows.slice(0, 1)))).not.toContain("hidden-");
    expect(() => executeLogSnapshot("demo", "SELECT * FROM project_logs", Array(1001).fill(rows[0]))).toThrow("source");
  });
});
