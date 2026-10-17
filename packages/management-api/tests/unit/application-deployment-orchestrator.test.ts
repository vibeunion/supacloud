import { expect, test } from "bun:test";
import {
  applicationReleaseId, type ApplicationDeployPlan, type ApplicationDeployRequest, type ApplicationReleaseRecord,
} from "@supacloud/delivery";
import {
  ApplicationDeploymentOrchestrator,
  type ApplicationDeploymentOrchestratorDependencies,
} from "../../src/services/application-deployment-orchestrator";
import {
  projectMutationResourceKey,
  type MutationLeaseInput, type ProjectMutationState,
} from "../../src/services/project-mutation.service";
import { stableSha256 } from "../../src/utils/stable-json";

const principal = { type: "project" as const, id: "project:demo" };
const configurationId = "11234567-89ab-4def-8123-456789abcdef";
const mutationId = "21234567-89ab-4def-8123-456789abcdef";
const activationId = "41234567-89ab-4def-8123-456789abcdef";
const webReleaseId = "c".repeat(64);
const manifestSha256 = "b".repeat(64);
const releaseId = applicationReleaseId("demo", "reviews", manifestSha256);

const release: ApplicationReleaseRecord = {
  schema: "supacloud.application-release.v1",
  project_ref: "demo",
  application_id: "reviews",
  release_id: releaseId,
  manifest_sha256: manifestSha256,
  created_at: "2026-10-11T00:00:00.000Z",
  targets: [{ name: "api", kind: "http", object_id: "d".repeat(64), entrypoint: "bundle/index.js" }],
};

const plan: ApplicationDeployPlan = {
  schema: "supacloud.application-deploy-plan.v1",
  project_ref: "demo",
  application_id: "reviews",
  environment_id: "test",
  candidate: { release_id: releaseId, configuration_id: configurationId },
  current: null,
  expected_activation_id: null,
  action: "activate",
  changes: { release: true, configuration: true, targets: { added: ["api"], removed: [], changed: [] } },
  migrations: {
    ledger_digest: "e".repeat(64),
    ledger_compatible: true,
    project_migrations_applied: false,
    operator_provisioning: "not-declared",
  },
  compatibility: "not-proven",
  execution_performed: false,
};

function fixture(options: {
  migrationFails?: boolean;
  currentActivation?: boolean;
  migrationAlreadyApplied?: boolean;
} = {}) {
  const calls: string[] = [];
  const phases: string[] = [];
  const lease: MutationLeaseInput = {
    projectRef: "demo", mutationId, leaseToken: "51234567-89ab-4def-8123-456789abcdef", fencingEpoch: 1,
  };
  let state: ProjectMutationState = {
    projectRef: "demo",
    mutationId,
    operation: "application.release.deploy",
    resourceKey: projectMutationResourceKey({
      type: "application_deploy",
      id: stableSha256({ applicationId: "reviews", environmentId: "test" }),
    }),
    requestFingerprint: "f".repeat(64),
    principal,
    status: "running",
    checkpoint: {},
    receipt: null,
    responseStatus: null,
    failureCode: null,
    leaseOwner: "fixture",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    fencingEpoch: 1,
    completedAt: null,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
  };
  const backendAfter = {
    schema: "supacloud.application-migrations.v1" as const,
    project_ref: "demo",
    application_id: "reviews",
    release_id: releaseId,
    manifest_sha256: manifestSha256,
    ledger_digest: "a".repeat(64),
    ledger_compatible: true,
    project_migrations_applied: true,
    declaration_conflicts: [],
    targets: [],
    operator_provisioning: "not-declared" as const,
    compatibility: "not-proven" as const,
    execution_performed: false as const,
    data_recovery: "separate-required" as const,
  };
  const frontendRelease = {
    schema: "supacloud.frontend-release.v2" as const,
    project_ref: "demo",
    deployment_id: "web",
    release_id: webReleaseId,
    sha256: webReleaseId,
    tree_sha256: "d".repeat(64),
    size_bytes: 1,
    file_count: 1,
    created_at: "2026-10-11T00:00:00.000Z",
    kind: "prebuilt_static" as const,
    archive_format: "tar.zst" as const,
  };
  const dependencies: ApplicationDeploymentOrchestratorDependencies = {
    storage: { readRelease: async () => structuredClone(release) },
    configurations: { put: async () => {
      throw new Error("configuration write not used");
    }, read: async () => ({
      schema: "supacloud.application-configuration.v1" as const,
      project_ref: "demo",
      application_id: "reviews",
      environment_id: "test",
      configuration_id: configurationId,
      created_at: "2026-10-11T00:00:00.000Z",
      bun_version: "1.3.0",
      targets: [{ name: "api", kind: "http" as const, hosts: ["orders.example.test"], environment_names: [] }],
    }) },
    deployPlans: { read: async () => ({
      ...structuredClone(plan),
      ...(options.migrationAlreadyApplied ? {
        migrations: { ...plan.migrations, project_migrations_applied: true },
      } : {}),
      ...(options.currentActivation ? {
        current: { activation_id: activationId, release_id: "9".repeat(64), configuration_id: configurationId },
        expected_activation_id: activationId,
        changes: { ...plan.changes, configuration: false },
      } : {}),
    }) },
    migrations: {
      readExecutionPlan: async () => {
        calls.push("migration-plan");
        return {
          schema: "supacloud.application-migration-execution-plan.v1" as const,
          project_ref: "demo", application_id: "reviews", release_id: releaseId,
          manifest_sha256: manifestSha256, ledger_digest: plan.migrations.ledger_digest,
          plan_sha256: "7".repeat(64),
          migrations: [{
            version: "1", name: "create_reviews", raw_sha256: "e".repeat(64),
            destructive: [], unsupported: [], non_transactional: [],
          }],
          ledger_compatible: true, operator_provisioning_required: false,
          backup_required: true, destructive_confirmation_required: false,
          execution_performed: false as const,
        };
      },
      apply: async () => {
        calls.push("migration");
        if (options.migrationFails) throw new Error("provider-timeout");
        return {
          before: { ...backendAfter, ledger_digest: plan.migrations.ledger_digest, project_migrations_applied: false },
          after: structuredClone(backendAfter),
          applied: [{ version: "1", name: "create_reviews", checksum: "f".repeat(64), alreadyApplied: false, strippedTransactionWrappers: 0 }],
          backup: {
            backup_id: "logical-full_demo_" + "a".repeat(32),
            project_ref: "demo", database: "supa_demo", kind: "logical-full" as const,
            created_at: "2026-10-11T00:00:00.000Z", completed_at: "2026-10-11T00:00:00.000Z",
            bytes: 128, sha256: "1".repeat(64),
          },
        };
      },
      inspect: async () => structuredClone(backendAfter),
    },
    deployment: {
      activateConfigured: async input => {
        calls.push("activation");
        return {
          project_ref: "demo", application_id: "reviews", environment_id: "test",
          release_id: input.runtime.release.release_id, activation_id: input.runtime.activationId, replayed: false,
        };
      },
    },
    frontends: {
      release: async () => {
        calls.push("web-release");
        return structuredClone(frontendRelease);
      },
      activeReleaseSnapshot: async () => ({
        project_ref: "demo",
        deployment_id: "web",
        active_release_id: null,
        active_activation_id: null,
        releases: [],
        next_cursor: null,
      }),
      activateRelease: async input => {
        calls.push("web-activation");
        return {
          project_ref: "demo", deployment_id: input.deploymentId, active_release_id: input.releaseId,
          activation_id: input.mutationId, release: structuredClone(frontendRelease),
          mutation: { mutation_id: input.mutationId, status: "succeeded" as const, replayed: false },
        };
      },
    },
    postgrestStatus: async () => ({ actual: "running", health: "healthy" }),
    mutations: {
      async begin() {
        calls.push("begin");
        return state.status === "succeeded" ? { state: structuredClone(state) } : { state: structuredClone(state), lease };
      },
      async checkpoint(value, checkpoint) {
        phases.push(String(checkpoint.phase));
        state.checkpoint = structuredClone(checkpoint);
      },
      async protect(_value, action) {
        await action();
      },
      async success(_value, receipt) {
        calls.push("success");
        state = { ...state, status: "succeeded", receipt, responseStatus: 200 };
      },
      async failure(_value, uncertain, terminal) {
        state = {
          ...state,
          status: uncertain ? "outcome_unknown" : terminal ? "failed_terminal" : "failed_retryable",
        };
      },
      async recover() {},
      async read() {
        calls.push("read");
        return structuredClone(state);
      },
    },
  };
  return {
    calls,
    phases,
    dependencies,
    state: () => state,
    orchestrator: new ApplicationDeploymentOrchestrator(dependencies),
    request: {
      mutation_id: mutationId,
      release_id: releaseId,
      configuration_id: configurationId,
      web_release: {
        deployment_id: "web",
        release_id: webReleaseId,
      },
    } as ApplicationDeployRequest,
  };
}

test("skips migration execution planning when the server plan proves a code-only release", async () => {
  const fixtureValue = fixture({ migrationAlreadyApplied: true });
  const result = await fixtureValue.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal,
    request: fixtureValue.request,
  });
  expect(result.backend_receipt.applied_versions).toEqual([]);
  expect(fixtureValue.calls).not.toContain("migration");
  expect(fixtureValue.calls).not.toContain("migration-plan");
});

test("runs migration once, persists ordered checkpoints, and binds Web after the backend receipt", async () => {
  const fixtureValue = fixture();
  const first = await fixtureValue.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal,
    request: fixtureValue.request,
  });
  expect(first).toMatchObject({
    schema: "supacloud.application-deploy.v1",
    action: "activate",
    execution_performed: true,
    replayed: false,
    backend_receipt: {
      schema: "supacloud.application-backend-receipt.v1",
      backup_id: "logical-full_demo_" + "a".repeat(32),
      applied_versions: ["1"],
      postgrest_healthy: true,
    },
    web: { deployment_id: "web", release_id: webReleaseId },
  });
  expect(fixtureValue.phases).toEqual(["prepared", "migrating", "activating", "binding-web", "verifying"]);
  expect(fixtureValue.calls.indexOf("migration")).toBeLessThan(fixtureValue.calls.indexOf("activation"));
  expect(fixtureValue.calls.indexOf("activation")).toBeLessThan(fixtureValue.calls.indexOf("web-activation"));
  expect(fixtureValue.calls.filter(call => call === "migration")).toHaveLength(1);

  const replay = await fixtureValue.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal,
    request: fixtureValue.request,
  });
  expect(replay).toMatchObject({ replayed: true, execution_performed: false });
  expect(fixtureValue.calls.filter(call => ["migration", "activation", "web-activation"].includes(call)))
    .toEqual(["migration", "activation", "web-activation"]);
});

test("marks an uncertain backend outcome and blocks a blind retry", async () => {
  const fixtureValue = fixture({ migrationFails: true });
  await expect(fixtureValue.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal,
    request: fixtureValue.request,
  })).rejects.toMatchObject({ code: "APPLICATION_DEPLOY_OUTCOME_UNKNOWN", statusCode: 503 });
  expect(fixtureValue.state().status).toBe("outcome_unknown");
  await expect(fixtureValue.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal,
    request: fixtureValue.request,
  })).rejects.toMatchObject({ code: "APPLICATION_DEPLOY_RECONCILIATION_REQUIRED", statusCode: 503 });
  expect(fixtureValue.calls.filter(call => call === "migration")).toHaveLength(1);
  expect(fixtureValue.calls).not.toContain("activation");
  expect(fixtureValue.calls).not.toContain("web-activation");
});

test.each([false, true])("missing health probe rejects before effects (code-only=%s)", async codeOnly => {
  const value = fixture({ migrationAlreadyApplied: codeOnly });
  delete value.dependencies.postgrestStatus;
  let configurationWrites = 0;
  value.dependencies.configurations.put = async () => {
    configurationWrites++;
    throw new Error("must not write");
  };
  await expect(value.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal,
    request: value.request,
  })).rejects.toMatchObject({ code: "APPLICATION_POSTGREST_STATUS_UNAVAILABLE", statusCode: 503 });
  expect(configurationWrites).toBe(0);
  expect(value.calls).toEqual([]);
});

test.each(["project_ref", "application_id", "release_id", "manifest_sha256"] as const)(
  "migration plan with mismatched %s cannot execute SQL or activate", async key => {
    const value = fixture();
    const read = value.dependencies.migrations.readExecutionPlan;
    value.dependencies.migrations.readExecutionPlan = async input => ({
      ...await read(input), [key]: key.endsWith("_id") || key.endsWith("sha256") ? "f".repeat(64) : "other",
    });
    await expect(value.orchestrator.execute({
      projectRef: "demo", applicationId: "reviews", environmentId: "test", principal, request: value.request,
    })).rejects.toMatchObject({ code: "APPLICATION_MIGRATION_PLAN_CHANGED", statusCode: 409 });
    expect(value.state().status).toBe("failed_terminal");
    expect(value.calls).not.toContain("migration");
    expect(value.calls).not.toContain("activation");
    expect(value.calls).not.toContain("web-activation");
    expect(value.calls).not.toContain("success");
  },
);

test.each([false, true])("mismatched backend manifest blocks success (code-only=%s)", async codeOnly => {
  const value = fixture({ migrationAlreadyApplied: codeOnly });
  const inspect = value.dependencies.migrations.inspect;
  const apply = value.dependencies.migrations.apply;
  value.dependencies.migrations.inspect = async (...args) => ({
    ...await inspect(...args), manifest_sha256: "f".repeat(64),
  });
  value.dependencies.migrations.apply = async input => {
    const result = await apply(input);
    return { ...result, after: { ...result.after, manifest_sha256: "f".repeat(64) } };
  };
  await expect(value.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal, request: value.request,
  })).rejects.toMatchObject({ code: "APPLICATION_DEPLOY_RECEIPT_INVALID", statusCode: 503 });
  expect(value.state().status).toBe(codeOnly ? "failed_terminal" : "outcome_unknown");
  expect(value.calls).not.toContain("activation");
  expect(value.calls).not.toContain("web-activation");
  expect(value.calls).not.toContain("success");
});

test.each([false, true])("unhealthy PostgREST blocks success (code-only=%s)", async codeOnly => {
  const value = fixture({ migrationAlreadyApplied: codeOnly });
  value.dependencies.postgrestStatus = async () => ({ actual: "running", health: "unhealthy" });
  await expect(value.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal, request: value.request,
  })).rejects.toMatchObject({ code: "APPLICATION_POSTGREST_NOT_READY", statusCode: 503 });
  expect(value.state().status).toBe(codeOnly ? "failed_terminal" : "outcome_unknown");
  expect(value.calls).not.toContain("activation");
  expect(value.calls).not.toContain("web-activation");
  expect(value.calls).not.toContain("success");
});

test("a failing health probe cannot become a successful backend receipt", async () => {
  const value = fixture();
  value.dependencies.postgrestStatus = async () => { throw new Error("private provider error"); };
  await expect(value.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal, request: value.request,
  })).rejects.toMatchObject({ code: "APPLICATION_DEPLOY_OUTCOME_UNKNOWN", statusCode: 503 });
  expect(value.state().status).toBe("outcome_unknown");
  expect(value.calls).not.toContain("activation");
  expect(value.calls).not.toContain("web-activation");
  expect(value.calls).not.toContain("success");
});

test("outstanding operator provisioning cannot pass the code-only receipt path", async () => {
  const value = fixture({ migrationAlreadyApplied: true });
  const inspect = value.dependencies.migrations.inspect;
  value.dependencies.migrations.inspect = async (...args) => ({
    ...await inspect(...args), operator_provisioning: "separate-verification-required",
  });
  await expect(value.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal, request: value.request,
  })).rejects.toMatchObject({ code: "APPLICATION_DEPLOY_RECEIPT_INVALID", statusCode: 503 });
  expect(value.calls).not.toContain("activation");
  expect(value.calls).not.toContain("web-activation");
  expect(value.calls).not.toContain("success");
});

test("reuses the platform configuration head when the request omits configuration identity", async () => {
  const fixtureValue = fixture();
  const request = { ...fixtureValue.request };
  delete request.configuration_id;
  const result = await fixtureValue.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal,
    request,
  });
  expect(result.configuration_id).toBe(configurationId);
  expect(result.execution_performed).toBe(true);
});

test("a changed candidate gets a new activation ID while retaining the observed CAS", async () => {
  const value = fixture({ currentActivation: true });
  const result = await value.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal, request: value.request,
  });
  expect(result.activation_id).not.toBe(activationId);
  expect(result.expected_activation_id).toBe(activationId);
});

test("status verifies the persisted receipt and never repeats deployment effects", async () => {
  const value = fixture();
  await value.orchestrator.execute({
    projectRef: "demo", applicationId: "reviews", environmentId: "test", principal, request: value.request,
  });
  const count = value.calls.length;
  expect(await value.orchestrator.status("demo", mutationId)).toMatchObject({
    status: "succeeded", phase: "verifying", project_ref: "demo", application_id: "reviews",
    environment_id: "test", receipt: { replayed: true, execution_performed: false },
  });
  expect(value.calls.slice(count)).toEqual(["read"]);
});

for (const [name, corrupt] of [
  ["wrong response status", (state: ProjectMutationState) => { state.responseStatus = 503; }],
  ["wrong stored project", (state: ProjectMutationState) => { state.projectRef = "other"; }],
  ["wrong checkpoint", (state: ProjectMutationState) => { state.checkpoint.schema = "other"; }],
  ["missing binding", (state: ProjectMutationState) => { state.checkpoint.request = {}; }],
  ["wrong candidate receipt", (state: ProjectMutationState) => { state.receipt!.release_id = "0".repeat(64); }],
  ["nonterminal phase", (state: ProjectMutationState) => { state.checkpoint.phase = "migrating"; }],
] as const) {
  test(`status refuses ${name}`, async () => {
    const value = fixture();
    await value.orchestrator.execute({
      projectRef: "demo", applicationId: "reviews", environmentId: "test", principal, request: value.request,
    });
    corrupt(value.state());
    await expect(value.orchestrator.status("demo", mutationId)).rejects.toMatchObject({ statusCode: 503 });
  });
}
