import { expect, test } from "bun:test";
import { HttpTransport } from "../transports/http";
import type { ToolInvocation } from "../tool-server";
import { registerBranchTools } from "./branch-tools";

const scope = { ref: "demo", branch_ref: "preview", json: true };
const checksum = "a".repeat(64);
const entry = { version: "1", name: "example", checksum: "b".repeat(64), statement_count: 1, destructive: false };
function plan(pending = false) {
  return {
    mode: "migrations", parent_ref: scope.ref, branch_ref: scope.branch_ref, safe_to_apply: true,
    plan_checksum: checksum, pending: pending ? [entry] : [], applied: [], blocked: [], warnings: [],
    requires_destructive_confirmation: false, ignored_branch_data: true,
  };
}
function branchTool(baseUrl: string): ToolInvocation {
  let invoke: ToolInvocation | undefined;
  registerBranchTools({ tool(_name, _description, _schema, callback) { invoke = callback; } },
    new HttpTransport({ baseUrl, token: "local-branch-receipt-fixture" }));
  if (!invoke) throw new Error("Branch tool was not registered");
  return invoke;
}

for (const action of ["promotion_plan", "promote"] as const) {
  test.each([200, 201, 202, 206])(`${action} requires a complete HTTP %s plan before success or no-op`, async status => {
    const methods: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      methods.push(request.method);
      return Response.json(plan(), { status });
    } });
    try {
      const result = await branchTool(server.url.toString())({ ...scope, action, plan_checksum: checksum });
      const body = JSON.parse(result.content[0]!.text);
      expect(methods).toEqual(["GET"]);
      if (status === 200) {
        expect(result.isError).toBeUndefined();
        expect(body).toMatchObject({ ok: true, operation: `branch.${action}` });
        if (action === "promote") expect(body).toMatchObject({ unchanged: true, mutation_sent: false });
      } else {
        expect(result.isError).toBe(true);
        expect(body).toMatchObject({ ok: false, project_ref: scope.ref, branch_ref: scope.branch_ref,
          error: { code: "INVALID_RESPONSE", http_status: status },
        });
        if (action === "promote") expect(body).toMatchObject({ mutation_sent: false, plan_checksum: checksum });
      }
    } finally { await server.stop(true); }
  });
}

test.each([200, 201, 202, 206])("branch mutation requires HTTP %s completion without replaying POST", async status => {
  const methods: string[] = [];
  const receipt = { promoted: true, mode: "migrations", project_ref: scope.ref, branch_ref: scope.branch_ref,
    applied: [entry], plan: { ...plan(), applied: [entry] }, branch_data_copied: false };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    methods.push(request.method);
    return request.method === "GET" ? Response.json(plan(true)) : Response.json(receipt, { status });
  } });
  try {
    const result = await branchTool(server.url.toString())({ ...scope, action: "promote", plan_checksum: checksum });
    const body = JSON.parse(result.content[0]!.text);
    expect(methods).toEqual(["GET", "POST"]);
    if (status === 200) {
      expect(result.isError).toBeUndefined();
      expect(body).toMatchObject({ ok: true, promoted: true, unchanged: false });
    } else {
      expect(result.isError).toBe(true);
      expect(body).toMatchObject({ ok: false, project_ref: scope.ref, branch_ref: scope.branch_ref,
        plan_checksum: checksum, mutation_sent: true, automatic_retry: false,
        error: { code: "OUTCOME_UNKNOWN", http_status: status },
        reconciliation: { action: "promotion_plan", ref: scope.ref, branch_ref: scope.branch_ref },
      });
    }
  } finally { await server.stop(true); }
});
