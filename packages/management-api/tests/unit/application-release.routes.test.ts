import { expect, test } from "bun:test";
import { createApplicationRoutes } from "../../src/routes/applications";
import type { ApplicationReleaseOrchestrator } from "../../src/services/application-release-orchestrator";

const releaseId = "a".repeat(64);
const configurationId = "11234567-89ab-4def-8123-456789abcdef";
const activationId = "21234567-89ab-4def-8123-456789abcdef";
const path = "http://localhost/v1/projects/demo/applications/reviews/environments/test/release";

test("release route authenticates and forwards one bounded orchestration request", async () => {
  const calls: unknown[] = [];
  const releaseOrchestrator: Pick<ApplicationReleaseOrchestrator, "execute"> = {
    execute: async input => {
      calls.push(input);
      return {
        schema: "supacloud.application-release.v1",
        project_ref: "demo", application_id: "reviews", environment_id: "test",
        release_id: releaseId, configuration_id: configurationId, activation_id: activationId,
        expected_activation_id: null, plan_sha256: "d".repeat(64),
        action: "activate", replayed: false, execution_performed: true,
      };
    },
  };
  const app = createApplicationRoutes({
    authorize: async () => undefined, projectExists: async () => true,
    principal: async () => ({ type: "project", id: "project:demo" }),
    deployment: { activateConfigured: async () => {
      throw new Error("unused");
    }, reconcile: async () => {
      throw new Error("unused");
    }, retireConfigured: async () => {
      throw new Error("unused");
    } },
    releaseOrchestrator,
  });
  const request = new Request(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ release_id: releaseId, configuration_id: configurationId }),
  });
  const response = await app.handle(request);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    schema: "supacloud.application-release.v1", release_id: releaseId,
    configuration_id: configurationId, activation_id: activationId,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    projectRef: "demo", applicationId: "reviews", environmentId: "test",
    request: { release_id: releaseId, configuration_id: configurationId },
  });
});

test("release route rejects missing verified principal before orchestration", async () => {
  let calls = 0;
  const app = createApplicationRoutes({
    authorize: async () => undefined, projectExists: async () => true,
    principal: async () => null,
    deployment: { activateConfigured: async () => {
      calls++;
      throw new Error("unused");
    }, reconcile: async () => {
      throw new Error("unused");
    }, retireConfigured: async () => {
      throw new Error("unused");
    } },
    releaseOrchestrator: { execute: async () => {
      calls++;
      throw new Error("must not run");
    } },
  });
  const response = await app.handle(new Request(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ release_id: releaseId, configuration_id: configurationId }),
  }));
  expect(response.status).toBe(401);
  expect(calls).toBe(0);
});
