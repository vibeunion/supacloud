import { expect, test } from "bun:test";
import { createApplicationRoutes } from "../../src/routes/applications";
import type { ApplicationDeploymentOrchestrator } from "../../src/services/application-deployment-orchestrator";

const releaseId = "a".repeat(64);
const configurationId = "11234567-89ab-4def-8123-456789abcdef";
const activationId = "21234567-89ab-4def-8123-456789abcdef";
const deployPath = "http://localhost/v1/projects/demo/applications/reviews/environments/test/deploy";

test("deploy route forwards one durable backend and Web binding request", async () => {
  const calls: unknown[] = [];
  const deploymentOrchestrator: Pick<ApplicationDeploymentOrchestrator, "execute"> = {
    execute: async input => {
      calls.push(input);
      return {
        schema: "supacloud.application-deploy.v1",
        project_ref: "demo", application_id: "reviews", environment_id: "test",
        mutation_id: activationId, release_id: releaseId, configuration_id: configurationId,
        activation_id: activationId, expected_activation_id: null, plan_sha256: "d".repeat(64),
        action: "activate", replayed: false, execution_performed: true,
        backend_receipt: {
          schema: "supacloud.application-backend-receipt.v1",
          project_ref: "demo", application_id: "reviews", environment_id: "test",
          release_id: releaseId, manifest_sha256: "e".repeat(64), mutation_id: activationId,
          plan_sha256: "d".repeat(64), backup_id: null,
          before_ledger_digest: "f".repeat(64), after_ledger_digest: "f".repeat(64),
          applied_versions: [], schema_reloaded: false, postgrest_healthy: true,
        },
        web: {
          deployment_id: "web", release_id: "a".repeat(64),
          activation_id: activationId, replayed: false,
        },
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
    deploymentOrchestrator,
  });
  const web_release = { deployment_id: "web", release_id: "a".repeat(64) };
  const response = await app.handle(new Request(deployPath, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mutation_id: activationId, release_id: releaseId, configuration_id: configurationId, web_release,
    }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    schema: "supacloud.application-deploy.v1", release_id: releaseId,
    backend_receipt: { schema: "supacloud.application-backend-receipt.v1" },
    web: { deployment_id: "web", release_id: "a".repeat(64) },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    projectRef: "demo", applicationId: "reviews", environmentId: "test",
    request: { mutation_id: activationId, release_id: releaseId, configuration_id: configurationId, web_release },
  });
});
