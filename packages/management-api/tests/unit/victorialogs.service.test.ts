import { describe, expect, test } from "bun:test";
import { VictoriaLogsService } from "../../src/services/victorialogs.service";

describe("VictoriaLogsService", () => {
  test("queries project-scoped persisted logs and parses JSON lines", async () => {
    let requestedUrl = "";
    let requestedBody = "";
    const service = new VictoriaLogsService({
      baseUrl: "http://127.0.0.1:9428",
      fetcher: async (input, init) => {
        requestedUrl = String(input);
        requestedBody = String(init?.body || "");
        return new Response([
          JSON.stringify({ _time: "2026-07-28T01:02:03Z", _msg: "request complete", project_ref: "proj_1", service: "postgrest", PRIORITY: "6" }),
          JSON.stringify({ _time: "2026-07-28T01:01:03Z", message: "request failed", project_ref: "proj_1", service: "postgrest", PRIORITY: "3" }),
        ].join("\n"), { status: 200 });
      },
    });

    const result = await service.queryProjectLogs("proj_1", {
      service: "postgrest",
      search: "request",
      start: "2026-07-28T00:00:00Z",
      end: "2026-07-29T00:00:00Z",
      limit: 20,
      offset: 5,
    });

    expect(requestedUrl).toBe("http://127.0.0.1:9428/select/logsql/query");
    const params = new URLSearchParams(requestedBody);
    expect(params.get("query")).toContain('project_ref:="proj_1"');
    expect(params.get("query")).toContain('service:="postgrest"');
    expect(params.get("query")).toContain('"request"');
    expect(params.get("start")).toBe("2026-07-28T00:00:00.000Z");
    expect(params.get("end")).toBe("2026-07-29T00:00:00.000Z");
    expect(params.get("limit")).toBe("20");
    expect(params.get("offset")).toBe("5");
    expect(result).toEqual([
      expect.objectContaining({ timestamp: "2026-07-28T01:02:03.000Z", event_message: "request complete", severity: "info", service: "postgrest" }),
      expect.objectContaining({ timestamp: "2026-07-28T01:01:03.000Z", event_message: "request failed", severity: "error", service: "postgrest" }),
    ]);
  });

  test("escapes LogsQL literals and rejects invalid project refs", async () => {
    let query = "";
    const service = new VictoriaLogsService({
      baseUrl: "http://127.0.0.1:9428/",
      fetcher: async (_input, init) => {
        query = new URLSearchParams(String(init?.body || "")).get("query") || "";
        return new Response("", { status: 200 });
      },
    });

    await service.queryProjectLogs("proj_1", { search: 'quote" and \\ slash' });
    expect(query).toContain('"quote\\\" and \\\\ slash"');
    await expect(service.queryProjectLogs("proj_1 | *", {})).rejects.toThrow("Invalid project ref");
  });

  test("surfaces VictoriaLogs failures without falling back to Analytics", async () => {
    const service = new VictoriaLogsService({
      baseUrl: "http://127.0.0.1:9428",
      fetcher: async () => new Response("query failed", { status: 503 }),
    });

    await expect(service.queryProjectLogs("proj_1", {})).rejects.toThrow("VictoriaLogs query failed (503)");
  });

  test("writes normalized JSON lines to the local VictoriaLogs ingestion endpoint", async () => {
    let requestedUrl = "";
    let requestedBody = "";
    const service = new VictoriaLogsService({
      baseUrl: "http://127.0.0.1:9428/",
      fetcher: async (input, init) => {
        requestedUrl = String(input);
        requestedBody = String(init?.body || "");
        return new Response("", { status: 204 });
      },
    });

    await service.ingest([{
      timestamp: "2026-07-28T01:02:03.000Z",
      message: "request complete",
      service: "postgrest",
      projectRef: "proj_1",
      severity: "info",
      unit: "supacloud-pgrst@proj_1.service",
    }]);

    expect(requestedUrl).toBe("http://127.0.0.1:9428/insert/jsonline");
    expect(requestedBody).toBe(`${JSON.stringify({
      _time: "2026-07-28T01:02:03.000Z",
      _msg: "request complete",
      service: "postgrest",
      project_ref: "proj_1",
      severity: "info",
      _SYSTEMD_UNIT: "supacloud-pgrst@proj_1.service",
    })}\n`);
  });
});
