import { expect, test } from "bun:test";
import { createApplicationRoutes } from "../../src/routes/applications";
import { ApplicationReleaseStorage } from "../../src/services/application-release-storage";
import type { ApplicationDeploymentService } from "../../src/services/application-deployment";
import { runtimeInput } from "../helpers/application-runtime";
import { ConflictError } from "../../src/utils/errors";

const runtime = runtimeInput();
const url = "http://localhost/v1/projects/demo/applications/reviews/environments/test/activations";
const body = {
  activation_id: runtime.activationId, release_id: runtime.release.release_id,
  configuration_id: "91234567-89ab-4def-8123-456789abcdef", expected_activation_id: null,
};
const principal = { type: "project" as const, id: "project:demo" };
const receipt = {
      project_ref: "demo", application_id: "reviews", environment_id: "test",
  release_id: body.release_id, activation_id: body.activation_id, replayed: false,
};
function setup(options: {
  denied?: 401 | 403; missingPrincipal?: boolean; enabled?: boolean; retirement?: boolean; failure?: Error;
} = {}) {
  const calls: unknown[] = [];
  const storage = new class extends ApplicationReleaseStorage {
    override async readRelease(...args: [string, string, string]) { calls.push(args); return runtime.release; }
  }();
  const deployment: Pick<ApplicationDeploymentService, "activateConfigured" | "reconcile" | "retireConfigured"> = {
    activateConfigured: async input => {
      calls.push(input);
      if (options.failure) throw options.failure;
      return receipt;
    },
    reconcile: async input => {
      calls.push(input);
      if (options.failure) throw options.failure;
      return { ...receipt, replayed: true };
    },
    retireConfigured: async input => {
      calls.push(input);
      return {
        project_ref: "demo", application_id: "reviews", environment_id: "test",
        activation_id: input.activationId, retired_at: "2026-09-26T00:00:00.000Z",
      };
    },
  };
  return { calls, app: createApplicationRoutes({
    storage, projectExists: async () => true,
    authorize: async () => options.denied ? { status: options.denied, body: { error: "Access denied" } } : undefined,
    principal: async () => options.missingPrincipal ? null : principal,
    ...(options.enabled === false ? {} : { deployment }),
    ...(options.retirement ? { retirementVerifier: true } : {}),
  }) };
}
function post(value: unknown = body, path = url) {
  return new Request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}

test("activation writes stay unmounted without deployment composition", async () => {
  const { app, calls } = setup({ enabled: false });
  for (const request of [
    post(), post({}, `${url}/${body.activation_id}/reconcile`), post({}, `${url}/${body.activation_id}/retire`),
  ]) {
    const response = await app.handle(request);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "APPLICATION_ROUTE_NOT_FOUND", error: "Application route not found",
    });
  }
  expect(calls).toEqual([]);
});

test("activation binds path, stored release, immutable configuration and verified principal", async () => {
  const { app, calls } = setup();
  const response = await app.handle(post());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(receipt);
  expect(calls).toEqual([
    ["demo", "reviews", body.release_id],
    {
      runtime: { release: runtime.release, environmentId: "test", activationId: body.activation_id },
      configurationId: body.configuration_id, expectedActivationId: null, principal,
    },
  ]);
});

test("activation authorization and principal failures precede release reads or effects", async () => {
  for (const [options, expected] of [[{ denied: 403 }, 403], [{ denied: 401 }, 401], [{ missingPrincipal: true }, 401]] as const) {
    for (const reconcile of [false, true]) {
      const { app, calls } = setup(options);
      expect((await app.handle(reconcile ? post({}, `${url}/${body.activation_id}/reconcile`) : post())).status).toBe(expected);
      expect(calls).toEqual([]);
    }
  }
});

test("activation requires explicit revision expectation and valid immutable identifiers", async () => {
  for (const change of [
    { expected_activation_id: undefined }, { activation_id: "invalid" }, { configuration_id: "current" },
    { release_id: "latest" }, { expected_activation_id: "invalid" },
  ]) {
    const { app, calls } = setup();
    expect((await app.handle(post({ ...body, ...change }))).status).toBe(422);
    expect(calls).toEqual([]);
  }
});

test("reconcile binds the same environment and principal without reading releases or activating", async () => {
  const { app, calls } = setup();
  const response = await app.handle(post({}, `${url}/${body.activation_id}/reconcile`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...receipt, replayed: true });
  expect(calls).toEqual([{
    projectRef: "demo", applicationId: "reviews", environmentId: "test",
    activationId: body.activation_id, principal,
  }]);
});

test("retirement is mounted only with an explicit verifier and preserves route identity", async () => {
  const path = `${url}/${body.activation_id}/retire`;
  const absent = await setup().app.handle(post({}, path));
  expect(absent.status).toBe(404);
  const configured = setup({ retirement: true });
  const response = await configured.app.handle(post({}, path));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    project_ref: "demo", application_id: "reviews", environment_id: "test",
    activation_id: body.activation_id,
  });
  expect(configured.calls).toEqual([{
    projectRef: "demo", applicationId: "reviews", environmentId: "test",
    activationId: body.activation_id, principal,
  }]);
});

test("activation failures retain identity and distinguish conflict from reconciliation and unknown effects", async () => {
  for (const [failure, expected, code] of [
    [new ConflictError("private-fingerprint"), 409, "APPLICATION_ACTIVATION_CONFLICT"],
    [new Error("APPLICATION_ACTIVATION_REVISION_CONFLICT"), 409, "APPLICATION_ACTIVATION_CONFLICT"],
    [new Error("APPLICATION_ACTIVATION_OUTCOME_UNRESOLVED"), 503, "APPLICATION_ACTIVATION_RECONCILIATION_REQUIRED"],
    [new Error("APPLICATION_ACTIVATION_RECOVERY_OBSERVATION_REQUIRED"), 503, "APPLICATION_ACTIVATION_RECONCILIATION_REQUIRED"],
    [new Error("private-database-password"), 503, "APPLICATION_ACTIVATION_OUTCOME_UNKNOWN"],
  ] as const) {
    for (const reconcile of [false, true]) {
      const { app } = setup({ failure });
      const response = await app.handle(reconcile ? post({}, `${url}/${body.activation_id}/reconcile`) : post());
      expect(response.status).toBe(expected);
      const output = await response.json();
      expect(output).toMatchObject({
        code, activation_id: body.activation_id, project_ref: "demo", application_id: "reviews", environment_id: "test",
      });
      expect(JSON.stringify(output)).not.toContain("private-");
    }
  }
});
