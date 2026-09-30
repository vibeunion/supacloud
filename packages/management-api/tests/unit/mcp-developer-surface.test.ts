import { expect, test } from "bun:test";
import { processMessage } from "../../src/mcp/server";

type Reply = { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> }; error?: { message: string } };

async function call(method: string, params: Record<string, unknown>, surface: "operations" | "developer") {
  return await processMessage({ jsonrpc: "2.0", id: 1, method, params }, { role: "project", ref: "demo" }, surface) as Reply | null;
}

test("developer surface exposes only read-only development tools", async () => {
  const reply = await call("tools/list", {}, "developer");
  const names = reply?.result?.tools?.map((tool) => tool.name) ?? [];
  expect(names).toContain("supacloud.get_capabilities");
  expect(names).toContain("supacloud.get_application_development");
  expect(names).not.toContain("supacloud.get_backup_readiness");
  expect(names).not.toContain("supacloud.plan_pitr_restore");
  expect(names).not.toContain("supacloud.get_request_metrics");
});

test("operations surface does not expose the development tool", async () => {
  const reply = await call("tools/list", {}, "operations");
  const names = reply?.result?.tools?.map((tool) => tool.name) ?? [];
  expect(names).not.toContain("supacloud.get_application_development");
  expect(names).toContain("supacloud.plan_pitr_restore");
});

test("capabilities describe the developer surface as read-only", async () => {
  const reply = await call("tools/call", { name: "supacloud.get_capabilities", arguments: {} }, "developer");
  const contract = JSON.parse(reply?.result?.content?.[0]?.text ?? "{}");
  expect(contract.surface).toBe("developer");
  expect(contract.write_policy).toBe("read_only");
  expect(contract.transport.endpoint).toBe("/mcp/developer/projects/demo");
});

test("developer surface rejects operations tools and project resources", async () => {
  await expect(call("tools/call", { name: "supacloud.get_backup_readiness", arguments: {} }, "developer"))
    .rejects.toThrow("Unknown MCP tool");
  await expect(call("resources/read", { uri: "supacloud://project/demo/backups" }, "developer"))
    .rejects.toThrow("Unknown MCP resource");
});

test("development tool requires an application, release, and target", async () => {
  await expect(call("tools/call", {
    name: "supacloud.get_application_development",
    arguments: { application_id: "reviews", release_id: "release-1" },
  }, "developer")).rejects.toThrow("target is required");
});