import { expect, test } from "bun:test";
import {
  applicationReleaseId, type ApplicationDeployPlan, type ApplicationReleaseRecord,
} from "@supacloud/delivery";
import { ApplicationReleaseOrchestrationError, ApplicationReleaseOrchestrator } from "../../src/services/application-release-orchestrator";
import { stableSha256 } from "../../src/utils/stable-json";

const release: ApplicationReleaseRecord = {
  schema: "supacloud.application-release.v1",
  project_ref: "demo", application_id: "reviews", release_id: applicationReleaseId("demo", "reviews", "b".repeat(64)),
  manifest_sha256: "b".repeat(64), created_at: "2026-10-11T00:00:00.000Z",
  targets: [{ name: "api", kind: "http", object_id: "c".repeat(64), entrypoint: "bundle/index.js" }],
};
const configurationId = "11234567-89ab-4def-8123-456789abcdef";
const activationId = "21234567-89ab-4def-8123-456789abcdef";
const principal = { type: "project" as const, id: "project:demo" };
const plan: ApplicationDeployPlan = {
  schema: "supacloud.application-deploy-plan.v1",
  project_ref: "demo", application_id: "reviews", environment_id: "test",
  candidate: { release_id: release.release_id, configuration_id: configurationId },
  current: null, expected_activation_id: null, action: "activate",
  changes: { release: true, configuration: true, targets: { added: ["api"], removed: [], changed: [] } },
  migrations: {
    ledger_digest: "d".repeat(64), ledger_compatible: true, project_migrations_applied: true,
    operator_provisioning: "not-declared",
  },
  compatibility: "not-proven", execution_performed: false,
};

function fixture(overrides: {
  plan?: ApplicationDeployPlan;
  activation?: (input: { activationId: string; configurationId: string }) => Promise<{
    project_ref: string; application_id: string; environment_id: string; release_id: string;
    activation_id: string; replayed: boolean;
  }>;
} = {}) {
  const calls: unknown[] = [];
  const currentPlan = overrides.plan ?? plan;
  const orchestrator = new ApplicationReleaseOrchestrator({
    storage: { readRelease: async () => release },
    configurations: {
      put: async (_scope, value) => {
        calls.push({ type: "configuration", value });
        return {
          schema: "supacloud.application-configuration.v1", project_ref: "demo", application_id: "reviews",
          environment_id: "test", configuration_id: configurationId, created_at: "2026-10-11T00:00:00.000Z",
          bun_version: "1.3.0", targets: [{ name: "api", kind: "http", hosts: ["reviews.example.test"], environment_names: [] }],
        };
      },
    },
    deployPlans: { read: async input => { calls.push({ type: "plan", input }); return currentPlan; } },
    deployment: {
      activateConfigured: async input => {
        calls.push({ type: "activation", input });
        return overrides.activation
          ? overrides.activation({ activationId: input.runtime.activationId, configurationId: input.configurationId })
          : {
            project_ref: "demo", application_id: "reviews", environment_id: "test",
            release_id: release.release_id, activation_id: input.runtime.activationId, replayed: false,
          };
      },
    },
  });
  return { calls, orchestrator };
}

test("orchestrates configuration write, deploy plan and one CAS activation", async () => {
  const f = fixture();
  const result = await f.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal,
    request: {
      release_id: release.release_id,
      configuration_write: {
        configuration_id: configurationId, expected_configuration_id: null,
        configuration: { bun_version: "1.3.0", targets: [{ name: "api", kind: "http", hosts: ["reviews.example.test"], environment: {} }] },
      },
    },
  });
  expect(result).toMatchObject({
    schema: "supacloud.application-release.v1", action: "activate",
    release_id: release.release_id, configuration_id: configurationId,
    activation_id: expect.any(String), expected_activation_id: null,
    execution_performed: true, replayed: false,
  });
  expect(f.calls.map(value => (value as { type: string }).type)).toEqual(["configuration", "plan", "activation"]);
  expect((f.calls[2] as { input: { expectedActivationId: string | null } }).input.expectedActivationId).toBe(null);
});

test("verified no-op returns the active activation without runtime effects", async () => {
  const noOp: ApplicationDeployPlan = {
    ...plan, current: { ...plan.candidate, activation_id: activationId },
    expected_activation_id: activationId, action: "no-op",
    changes: { release: false, configuration: false, targets: { added: [], removed: [], changed: [] } },
  };
  const f = fixture({ plan: noOp });
  const result = await f.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal,
    request: { release_id: release.release_id, configuration_id: configurationId },
  });
  expect(result).toMatchObject({ action: "no-op", activation_id: activationId, execution_performed: false });
  expect(f.calls.map(value => (value as { type: string }).type)).toEqual(["plan"]);
});

test("rejects a stale plan and preserves activation identity for reconciliation", async () => {
  const f = fixture({
    activation: async ({ activationId }) => { throw new Error("APPLICATION_ACTIVATION_OUTCOME_UNRESOLVED"); },
  });
  await expect(f.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal,
    request: {
      release_id: release.release_id, configuration_id: configurationId,
      expected_plan_sha256: stableSha256({ ...plan, action: "no-op" }),
    },
  })).rejects.toMatchObject({
    code: "APPLICATION_RELEASE_PLAN_CHANGED", statusCode: 409,
  });

  let retry: ApplicationReleaseOrchestrationError | undefined;
  try {
    await f.orchestrator.execute({
      projectRef: "demo", applicationId: "reviews", environmentId: "test", principal,
      request: { release_id: release.release_id, configuration_id: configurationId, activation_id: activationId },
    });
  } catch (error) {
    retry = error as ApplicationReleaseOrchestrationError;
  }
  expect(retry).toBeDefined();
  expect(retry).toMatchObject({ code: "APPLICATION_RELEASE_RECONCILIATION_REQUIRED", statusCode: 503 });
  expect(retry!.details).toMatchObject({ activation_id: activationId, release_id: release.release_id });
});
