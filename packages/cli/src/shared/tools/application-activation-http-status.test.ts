import { expect, test } from "bun:test";
import { HttpTransport } from "../transports/http";
import type { ToolInvocation } from "../tool-server";
import { registerApplicationTools } from "./application-tools";

const scope = { ref: "demo", id: "reviews", environment_id: "test" };
const activationId = "11234567-89ab-4def-8123-456789abcdef";
const previousId = "21234567-89ab-4def-8123-456789abcdef";
const configurationId = "31234567-89ab-4def-8123-456789abcdef";
const releaseId = "a".repeat(64);
const publicScope = { project_ref: scope.ref, application_id: scope.id, environment_id: scope.environment_id };

function applicationTool(baseUrl: string): ToolInvocation {
  let invoke: ToolInvocation | undefined;
  registerApplicationTools({ tool(_name, _description, _schema, callback) { invoke = callback; } },
    new HttpTransport({ baseUrl, token: "local-http-status-fixture" }));
  if (!invoke) throw new Error("Application tool was not registered");
  return invoke;
}

for (const action of ["activate_release", "rollback_release", "reconcile_activation", "retire_activation"] as const) {
  test.each([200, 201, 202, 206])(`${action} verifies the completion HTTP status %s before declaring success`, async status => {
    const requests: string[] = [];
    const response = action === "retire_activation"
      ? { ...publicScope, activation_id: activationId, retired_at: "2026-10-11T00:00:00.000Z" }
      : { ...publicScope, activation_id: activationId, release_id: releaseId, replayed: action === "reconcile_activation" };
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      requests.push(request.method);
      return Response.json(response, { status });
    } });
    try {
      const invoke = applicationTool(server.url.toString());
      const result = await invoke({ ...scope, action, activation_id: activationId,
        ...(action === "retire_activation" ? {} : {
          release_id: releaseId, configuration_id: configurationId, expected_activation_id: previousId,
        }),
      });
      const body = JSON.parse(result.content[0]!.text);
      expect(requests).toEqual(["POST"]);
      if (status === 200) {
        expect(result.isError).toBeUndefined();
        expect(body).toMatchObject({ ok: true, operation: `applications.${action}` });
      } else {
        expect(result.isError).toBe(true);
        expect(body).toMatchObject({ ok: false, operation: `applications.${action}`,
          ...publicScope, activation_id: activationId,
          error: { code: "OUTCOME_UNKNOWN", http_status: status },
        });
        if (action === "rollback_release") expect(body).toMatchObject({
          release_id: releaseId, configuration_id: configurationId, expected_activation_id: previousId,
        });
      }
    } finally { await server.stop(true); }
  });
}

for (const action of ["get_rollback_snapshot", "rollback_release"] as const) {
  test.each([201, 202, 206])(`${action} rejects non-final snapshot status %s without POST`, async status => {
    const methods: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      methods.push(request.method);
      return Response.json({
        schema: "supacloud.application-rollback-snapshot.v1", ...publicScope,
        active: { activation_id: activationId, release_id: releaseId, configuration_id: configurationId },
        previous: { activation_id: previousId, release_id: "b".repeat(64), configuration_id: configurationId },
      }, { status });
    } });
    try {
      const result = await applicationTool(server.url.toString())({ ...scope, action });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        ok: false, error: { code: "INVALID_RESPONSE", http_status: status },
      });
      expect(methods).toEqual(["GET"]);
    } finally { await server.stop(true); }
  });
}
