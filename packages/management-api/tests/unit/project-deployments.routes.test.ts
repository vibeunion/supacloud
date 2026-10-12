import { expect, test } from "bun:test";
import type { ApplicationDeployResult } from "@supacloud/delivery";
import { createProjectDeploymentRoutes } from "../../src/routes/project-deployments";
import { delegatedProjectCapability } from "../../src/middleware/auth";
import type { ApplicationDeploymentStatus } from "../../src/services/application-deployment-orchestrator";

const deploymentId = "11234567-89ab-4def-8123-456789abcdef";
const configurationId = "21234567-89ab-4def-8123-456789abcdef";
const activationId = "31234567-89ab-4def-8123-456789abcdef";
const base = "http://localhost/v1/projects/demo/environments/test/deployments";
const body = {
  deployment_id: deploymentId, application_id: "reviews",
  release_id: "a".repeat(64), configuration_id: configurationId,
};

function receipt(): ApplicationDeployResult {
  return {
    schema: "supacloud.application-deploy.v1",
    project_ref: "demo", application_id: "reviews", environment_id: "test",
    mutation_id: deploymentId, release_id: body.release_id, configuration_id: configurationId,
    activation_id: activationId, expected_activation_id: null, plan_sha256: "b".repeat(64),
    action: "activate", replayed: false, execution_performed: true,
    backend_receipt: {
      schema: "supacloud.application-backend-receipt.v1",
      project_ref: "demo", application_id: "reviews", environment_id: "test",
      mutation_id: deploymentId, release_id: body.release_id, manifest_sha256: "c".repeat(64),
      plan_sha256: "b".repeat(64), backup_id: null,
      before_ledger_digest: "d".repeat(64), after_ledger_digest: "d".repeat(64),
      applied_versions: [], schema_reloaded: false, postgrest_healthy: true,
    },
  };
}

function state(): ApplicationDeploymentStatus {
  return {
    mutation_id: deploymentId, operation: "application.release.deploy",
    status: "succeeded", phase: "verifying", project_ref: "demo",
    application_id: "reviews", environment_id: "test", receipt: receipt(), failure_code: null,
  };
}

function fixture(options: {
  denied?: boolean; missingPrincipal?: boolean; error?: Error;
  result?: ApplicationDeployResult; state?: ApplicationDeploymentStatus | null;
} = {}) {
  const calls: unknown[] = [];
  const reads: unknown[] = [];
  const app = createProjectDeploymentRoutes({
    execute: async input => {
      calls.push(input);
      if (options.error) throw options.error;
      return options.result ?? receipt();
    },
    status: async (project, mutation) => {
      reads.push({ project, mutation });
      if (options.error) throw options.error;
      return options.state === undefined ? state() : options.state;
    },
  }, {
    authorize: async () => options.denied ? { status: 403, body: { error: "Denied" } } : undefined,
    principal: async () => options.missingPrincipal ? null : { type: "project", id: "project:demo" },
  });
  return { app, calls, reads };
}

function post(url = base, value: unknown = body) {
  return new Request(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
}

test("project endpoint submits one bound application request and returns a verified receipt", async () => {
  const f = fixture();
  const response = await f.app.handle(post());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true, ...receipt() });
  expect(f.calls).toEqual([{
    projectRef: "demo", applicationId: "reviews", environmentId: "test",
    principal: { type: "project", id: "project:demo" },
    request: { mutation_id: deploymentId, release_id: body.release_id, configuration_id: configurationId },
  }]);
});

test("authorization rejection prevents all deployment and status calls", async () => {
  const f = fixture({ denied: true });
  for (const request of [post(), new Request(`${base}/${deploymentId}`), post(`${base}/${deploymentId}/reconcile`, {})]) {
    expect((await f.app.handle(request)).status).toBe(403);
  }
  expect(f.calls).toEqual([]);
  expect(f.reads).toEqual([]);
});

test("missing verified principal prevents a mutation", async () => {
  const f = fixture({ missingPrincipal: true });
  expect((await f.app.handle(post())).status).toBe(401);
  expect(f.calls).toEqual([]);
});

test("foreign success is rejected rather than rebound to the requested environment", async () => {
  const f = fixture({ result: { ...receipt(), environment_id: "production" } });
  const response = await f.app.handle(post());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, code: "PROJECT_DEPLOYMENT_OUTCOME_UNKNOWN" });
});

test("private provider errors never escape POST or status", async () => {
  const f = fixture({ error: new Error("private-connection-secret") });
  for (const request of [post(), new Request(`${base}/${deploymentId}`)]) {
    const response = await f.app.handle(request);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-connection-secret");
  }
});

for (const changes of [{ environment_id: "production" }, { project_ref: "other" }, { mutation_id: activationId }]) {
  test(`status hides another scope ${JSON.stringify(changes)}`, async () => {
    const f = fixture({ state: { ...state(), ...changes } });
    expect((await f.app.handle(new Request(`${base}/${deploymentId}`))).status).toBe(404);
    expect((await f.app.handle(post(`${base}/${deploymentId}/reconcile`, {}))).status).toBe(404);
    expect(f.calls).toEqual([]);
  });
}

test("reconcile confirms only a verified success and never invokes execute", async () => {
  const f = fixture();
  const response = await f.app.handle(post(`${base}/${deploymentId}/reconcile`, {}));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, replayed: true, receipt: receipt() });
  expect(f.calls).toEqual([]);
  expect(f.reads).toHaveLength(1);
});

test("reconcile neither resumes nor labels a running operation successful", async () => {
  const f = fixture({ state: { ...state(), status: "running", receipt: null } });
  const response = await f.app.handle(post(`${base}/${deploymentId}/reconcile`, {}));
  expect(response.status).toBe(409);
  expect(f.calls).toEqual([]);
});

test("GET and reconcile reject a malformed stored success receipt", async () => {
  const f = fixture({ state: { ...state(), receipt: { ok: true } } });
  expect((await f.app.handle(new Request(`${base}/${deploymentId}`))).status).toBe(503);
  expect((await f.app.handle(post(`${base}/${deploymentId}/reconcile`, {}))).status).toBe(503);
  expect(f.calls).toEqual([]);
});

test("invalid request bodies are rejected before a deployment", async () => {
  const f = fixture();
  const response = await f.app.handle(post(base, { ...body, release_id: "invalid" }));
  expect(response.status).toBe(400);
  expect(f.calls).toEqual([]);
});

test("deployment permissions are scoped to the deployment resource only", () => {
  expect(delegatedProjectCapability(new Request(base), "demo")).toBe("operations.read");
  expect(delegatedProjectCapability(post(), "demo")).toBe("operations.manage");
  expect(delegatedProjectCapability(new Request(base.replace("/deployments", "/secrets")), "demo")).toBeNull();
  expect(delegatedProjectCapability(new Request(base), "other")).toBeNull();
});
