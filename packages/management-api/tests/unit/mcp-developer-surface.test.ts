import { expect, test } from "bun:test";
import { processMessage } from "../../src/mcp/server";

type Reply = { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> }; error?: { message: string } };

async function call(method: string, params: Record<string, unknown>, surface: "operations" | "developer") {
  return await processMessage({ jsonrpc: "2.0", id: 1, method, params }, { role: "project", ref: "demo" }, surface) as Reply | null;
}

async function withInvocationEnvironment<T>(value: Record<string, string | undefined>, work: () => Promise<T>): Promise<T> {
  const keys = [
    "SUPACLOUD_DEVELOPER_MCP_INVOKE_ENVIRONMENTS",
    "SUPACLOUD_DEVELOPER_MCP_INVOKE_METHODS",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (value[key] === undefined) delete process.env[key];
      else process.env[key] = value[key];
    }
    return await work();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("developer surface exposes only read-only development tools", async () => {
  const reply = await call("tools/list", {}, "developer");
  const names = reply?.result?.tools?.map((tool) => tool.name) ?? [];
  expect(names).toContain("supacloud.get_capabilities");
  expect(names).toContain("supacloud.get_application_development");
  expect(names).toContain("supacloud.get_deployment_evidence");
  expect(names).not.toContain("supacloud.invoke_application_route");
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

test("invocation is disabled until an operator allowlists an environment", async () => {
  await expect(call("tools/call", {
    name: "supacloud.invoke_application_route",
    arguments: {
      application_id: "app", environment_id: "test", target: "api", method: "GET", path: "/health",
    },
  }, "developer")).rejects.toThrow("not enabled");
});

test("allowlisted invocation is exposed with explicit environment and method boundaries", async () => {
  await withInvocationEnvironment({
    SUPACLOUD_DEVELOPER_MCP_INVOKE_ENVIRONMENTS: "test,staging",
    SUPACLOUD_DEVELOPER_MCP_INVOKE_METHODS: "GET,POST",
  }, async () => {
    const list = await call("tools/list", {}, "developer");
    expect(list?.result?.tools?.map((tool) => tool.name)).toContain("supacloud.invoke_application_route");
    const capabilitiesReply = await call("tools/call", { name: "supacloud.get_capabilities", arguments: {} }, "developer");
    const contract = JSON.parse(capabilitiesReply?.result?.content?.[0]?.text ?? "{}");
    expect(contract.write_policy).toBe("allowlisted_test_invocation");
    expect(contract.invocation).toEqual({
      mode: "allowlisted_test_invocation",
      enabled: true,
      environments: ["test", "staging"],
      methods: ["GET", "POST"],
      credentials_forwarded: false,
      redirects_followed: false,
      transport: "application_loopback",
    });
    await expect(call("tools/call", {
      name: "supacloud.invoke_application_route",
      arguments: {
        application_id: "app", environment_id: "production", target: "api", method: "GET", path: "/health",
      },
    }, "developer")).rejects.toThrow("not allowlisted");
  });
});
