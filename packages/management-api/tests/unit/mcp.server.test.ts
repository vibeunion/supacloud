import { describe, expect, test } from "bun:test";
import { handleMcpRequest, processMessage } from "../../src/mcp/server";

const adminScope = { role: "admin" as const };
const projectScope = { role: "project" as const, ref: "demo-project" };

async function post(body: unknown, headers: Record<string, string> = {}) {
  return handleMcpRequest(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    adminScope,
  );
}

describe("stateless MCP Streamable HTTP endpoint", () => {
  test("initializes with the current protocol and never creates a session", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toEqual({ listChanged: false });
  });

  test("returns deterministic tools and project-scoped resources", async () => {
    const tools = await processMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, adminScope);
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "supacloud.get_capabilities",
      "supacloud.get_backup_readiness",
      "supacloud.get_request_metrics",
      "supacloud.get_project_logs",
      "supacloud.query_project_logs_sql",
      "supacloud.get_connection_locks",
      "supacloud.plan_pitr_restore",
    ]);

    const resources = await processMessage({ jsonrpc: "2.0", id: 2, method: "resources/list" }, projectScope);
    expect(resources.result.resources.map((resource: { uri: string }) => resource.uri)).toEqual([
      "supacloud://capabilities",
      "supacloud://project/demo-project/backups",
      "supacloud://project/demo-project/metrics",
    ]);
  });

  test("rejects unsupported content and protocol versions", async () => {
    const contentType = await handleMcpRequest(
      new Request("http://localhost/mcp", { method: "POST", body: "{}" }),
      adminScope,
    );
    expect(contentType.status).toBe(415);

    const protocol = await post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { "mcp-protocol-version": "2099-01-01" },
    );
    expect(protocol.status).toBe(400);
  });

  test("uses JSON-RPC errors and keeps PITR planning non-executing", async () => {
    const unknown = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "missing.tool" },
    });
    const unknownBody = await unknown.json();
    expect(unknownBody.error.code).toBe(-32000);

    const plan = await processMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "supacloud.plan_pitr_restore",
          arguments: {
            project_ref: "demo-project",
            target: "2026-09-07T00:00:00Z",
          },
        },
      },
      adminScope,
    );
    expect(plan.result.content[0].text).toContain('"mode": "plan_only"');
    expect(plan.result.content[0].text).toContain("admin approval");
    expect(plan.result.content[0].text).not.toContain("restore_started");
  });

  test("accepts initialized notifications without a response body", async () => {
    const response = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  test("rejects resources outside a project token scope", async () => {
    const response = await handleMcpRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "resources/read",
          params: { uri: "supacloud://project/other-project/metrics" },
        }),
      }),
      projectScope,
    );
    const body = await response.json();
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain("outside the authorized scope");
  });
});
