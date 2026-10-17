import { expect, test } from "bun:test";
import { HttpTransport } from "../transports/http";
import type { ToolInvocation } from "../tool-server";
import { registerApplicationTools } from "./application-tools";

const scope = { ref: "demo", id: "reviews", environment_id: "test" };
const publicScope = { project_ref: scope.ref, application_id: scope.id, environment_id: scope.environment_id };
const activationId = "11234567-89ab-4def-8123-456789abcdef";
const currentId = "21234567-89ab-4def-8123-456789abcdef";
const configurationId = "31234567-89ab-4def-8123-456789abcdef";
const releaseId = "a".repeat(64);
const candidate = { release_id: releaseId, configuration_id: configurationId };
function plan(noOp: boolean) {
  return {
    schema: "supacloud.application-deploy-plan.v1", ...publicScope, candidate,
    current: { ...candidate, activation_id: currentId, release_id: noOp ? releaseId : "b".repeat(64) },
    expected_activation_id: currentId, action: noOp ? "no-op" : "activate",
    changes: { release: !noOp, configuration: false,
      targets: { added: [], removed: [], changed: noOp ? [] : ["api"] } },
    migrations: { ledger_digest: "c".repeat(64), ledger_compatible: true,
      project_migrations_applied: true, operator_provisioning: "not-declared" },
    compatibility: "not-proven", execution_performed: false,
  };
}
function applicationTool(baseUrl: string): ToolInvocation {
  let invoke: ToolInvocation | undefined;
  registerApplicationTools({ tool(_name, _description, _schema, callback) { invoke = callback; } },
    new HttpTransport({ baseUrl, token: "local-deploy-status-fixture" }));
  if (!invoke) throw new Error("Application tool was not registered");
  return invoke;
}

for (const action of ["get_deploy_plan", "deploy_release"] as const) {
  for (const noOp of [false, true]) {
    test.each([200, 201, 202, 206])(`${action} ${noOp ? "no-op" : "changed"} plan requires final HTTP %s`, async status => {
      const methods: string[] = [];
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        methods.push(request.method);
        if (request.method === "GET") return Response.json(plan(noOp), { status });
        const body = await request.json();
        return Response.json({ ...publicScope, release_id: releaseId, activation_id: body.activation_id, replayed: false });
      } });
      try {
        const result = await applicationTool(server.url.toString())({ ...scope, ...candidate, action });
        const body = JSON.parse(result.content[0]!.text);
        if (status === 200) {
          expect(result.isError).toBeUndefined();
          expect(body).toMatchObject({ ok: true, operation: `applications.${action}` });
          expect(methods).toEqual(action === "deploy_release" && !noOp ? ["GET", "POST"] : ["GET"]);
        } else {
          expect(result.isError).toBe(true);
          expect(body).toMatchObject({ ok: false, ...publicScope, ...candidate,
            error: { code: "INVALID_RESPONSE", http_status: status } });
          expect(methods).toEqual(["GET"]);
        }
      } finally { await server.stop(true); }
    });
  }
}

for (const explicit of [false, true]) {
  test.each([200, 201, 202, 206])(`${explicit ? "explicit" : "automatic"} deployment rejects non-final mutation status %s`, async status => {
    const methods: string[] = [];
    let sentActivationId: unknown;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      methods.push(request.method);
      if (request.method === "GET") return Response.json(plan(false));
      const body = await request.json();
      sentActivationId = body.activation_id;
      expect(body.expected_activation_id).toBe(currentId);
      return Response.json({ ...publicScope, release_id: releaseId, activation_id: body.activation_id, replayed: false }, { status });
    } });
    try {
      const result = await applicationTool(server.url.toString())({ ...scope, ...candidate, action: "deploy_release",
        ...(explicit ? { activation_id: activationId, expected_activation_id: currentId } : {}) });
      const body = JSON.parse(result.content[0]!.text);
      expect(methods).toEqual(explicit ? ["POST"] : ["GET", "POST"]);
      if (explicit) expect(sentActivationId).toBe(activationId);
      if (status === 200) {
        expect(result.isError).toBeUndefined();
        expect(body).toMatchObject({ ok: true, operation: "applications.deploy_release" });
      } else {
        expect(result.isError).toBe(true);
        expect(body).toMatchObject({ ok: false, operation: "applications.deploy_release", ...publicScope, ...candidate,
          activation_id: sentActivationId, expected_activation_id: currentId,
          error: { code: "OUTCOME_UNKNOWN", http_status: status } });
      }
    } finally { await server.stop(true); }
  });
}
