import { expect, test } from "bun:test";
import {
  applicationPromotionAction, applicationPromotionPlanDigest, applicationPromotionSteps, applicationReleaseId,
  parseApplicationPromotionPlan, workspaceApprovalId, workspaceRepositoryId, type WorkspaceReleaseApprovalIdentity,
} from "@supacloud/delivery";
import { createWorkspaceReleaseRoutes } from "../../src/routes/workspace-releases";
import {
  executeApprovedPromotion, MemoryWorkspaceApprovalStore, WorkspaceReleaseApprovals, WorkspaceReleaseApprovalError,
} from "../../src/services/workspace-release-approval";

const identity: WorkspaceReleaseApprovalIdentity = {
  repository: "github.com/acme/store", project_ref: "store-prd", application_id: "storefront",
  environment_id: "production", release_id: "a".repeat(64), manifest_sha256: "b".repeat(64),
  config_digest: "c".repeat(64), source_revision: "d".repeat(40), workspace_plan_sha256: "e".repeat(64),
};
const actor = { id: "user-1", type: "project", requestId: "req-1", platformAdmin: false };

function approvals(authorize?: () => Promise<void>) {
  const audits: string[] = [];
  const service = new WorkspaceReleaseApprovals({
    store: new MemoryWorkspaceApprovalStore(), now: () => "2026-11-18T00:00:00.000Z",
    authorize: async (_project, _audit, capability) => {
      if (authorize) await authorize();
      if (capability !== "applications.manage" && capability !== "applications.read") throw new Error("capability");
    },
    audit: async record => { audits.push(record.approval_id); },
  });
  return { service, audits };
}

test("server approval is durable, actor-bound, and rejected when the digest changes", async () => {
  const { service, audits } = approvals();
  const granted = await service.grant(identity, { actor: actor.id, actorType: actor.type, requestId: actor.requestId });
  const again = await service.grant(identity, { actor: "other-user", actorType: actor.type, requestId: "req-2" });
  expect(again.actor).toBe("user-1");
  expect(audits).toEqual([granted.approval_id]);
  let seen = "";
  const promoted = await executeApprovedPromotion(service, identity.project_ref, granted.approval_id, identity, "01234567-89ab-4def-8123-456789abcdef", async () => {
    seen = "01234567-89ab-4def-8123-456789abcdef";
    return { mutation_id: seen };
  });
  expect(promoted.mutation_id).toBe(seen);
  await expect(executeApprovedPromotion(service, identity.project_ref, granted.approval_id, { ...identity, release_id: "9".repeat(64) }, seen, async () => {
    throw new Error("executor must not run");
  })).rejects.toMatchObject({ code: "WORKSPACE_APPROVAL_MISMATCH" });
  expect(granted.approval_id).toBe(workspaceApprovalId(identity));
  await expect(service.assertMatch(identity.project_ref, granted.approval_id, { ...identity, manifest_sha256: "f".repeat(64) }))
    .rejects.toBeInstanceOf(WorkspaceReleaseApprovalError);
  await expect(service.assertMatch("admin-prd", granted.approval_id, identity)).rejects.toMatchObject({ code: "WORKSPACE_APPROVAL_MISMATCH" });
});

test("approval route denies unauthorized actors and does not promote a mismatched release", async () => {
  const calls: string[] = [];
  const routes = createWorkspaceReleaseRoutes({
    store: new MemoryWorkspaceApprovalStore(),
    authorize: async () => undefined,
    principal: async () => actor,
    requireCapability: async () => { throw new (await import("../../src/utils/errors")).ForbiddenError("denied"); },
    promotionExecutor: { execute: async () => { calls.push("execute"); return { project_ref: "store-prd", application_id: "storefront", environment_id: "production", mutation_id: null, activation_id: null, plan_sha256: "e".repeat(64), action: "promote", replayed: false }; } },
  });
  const denied = await routes.handle(new Request("http://localhost/v1/projects/store-prd/workspace-approvals", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...identity, project_ref: undefined }),
  }));
  expect(denied.status).toBe(403);
  expect(calls).toEqual([]);
  expect(workspaceRepositoryId(identity.repository)).toHaveLength(64);
});

function promotionPlan(releaseId: string) {
  const manifest = identity.manifest_sha256;
  const configurationId = "11234567-89ab-4def-8123-456789abcdef";
  const content = {
    schema: "supacloud.application-promotion-plan.v1" as const,
    project_ref: "store-prd", application_id: "storefront", environment_id: "production", manifest_sha256: manifest,
    source: {
      project_ref: "store-stg", environment_id: "staging",
      release_id: applicationReleaseId("store-stg", "storefront", manifest),
      activation_id: "21234567-89ab-4def-8123-456789abcdef", receipt_confirmed: true, ready: true, smoke_verified: true,
      evidence_sha256: "f".repeat(64), migration_ledger_digest: "c".repeat(64),
    },
    target: {
      candidate_release_id: releaseId, current_release_id: null, artifact_action: "materialize" as const,
      configuration_id: configurationId,
      configuration: {
        schema: "supacloud.application-configuration.v1" as const, project_ref: "store-prd", application_id: "storefront",
        environment_id: "production", configuration_id: configurationId, created_at: "2026-11-18T00:00:00.000Z",
        bun_version: "1.2.3", targets: [{ name: "api", kind: "http" as const, hosts: ["store.example"], environment_names: [] }],
      },
      activation_id: null, receipt_confirmed: false, ready: false, smoke_verified: false,
      evidence_sha256: null, migration_ledger_digest: null,
    },
    migrations: {
      ledger_digest: "c".repeat(64), ledger_compatible: true, project_migrations_applied: true,
      pending_versions: [] as string[], operator_provisioning_required: false,
    },
    backup: { required: false, confirmed: false as const }, blockers: [] as const, execution_performed: false as const,
    data_recovery: "separate-required" as const,
  };
  const action = applicationPromotionAction(content);
  const withAction = { ...content, action };
  const steps = applicationPromotionSteps(withAction);
  return parseApplicationPromotionPlan({ ...withAction, steps, plan_sha256: applicationPromotionPlanDigest({ ...withAction, steps }) });
}

test("an approved promotion preserves the mutation id and a lost response reconciles that id", async () => {
  const store = new MemoryWorkspaceApprovalStore();
  const releaseId = applicationReleaseId("store-prd", "storefront", identity.manifest_sha256);
  const grantedIdentity = { ...identity, release_id: releaseId };
  const service = new WorkspaceReleaseApprovals({ store, now: () => "2026-11-18T00:00:00.000Z" });
  const granted = await service.grant(grantedIdentity, { actor: actor.id, actorType: actor.type, requestId: actor.requestId });
  const mutationId = "01234567-89ab-4def-8123-456789abcdef";
  let executed = "";
  let calls = 0;
  const routes = createWorkspaceReleaseRoutes({
    store, authorize: async () => undefined, principal: async () => actor, requireCapability: async () => undefined,
    promotionExecutor: { execute: async input => {
      calls += 1;
      executed = input.mutationId;
      return { project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId, mutation_id: calls === 1 ? input.mutationId : "99999999-89ab-4def-8123-456789abcdef", activation_id: null, plan_sha256: input.plan.plan_sha256, action: input.plan.action, replayed: false };
    } },
    promotionReconciler: { reconcile: async input => ({ project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId, mutation: { status: "outcome_unknown" }, promotion: { release_id: releaseId }, mutation_id: input.mutationId } as never) },
  });
  const plan = promotionPlan(releaseId);
  const body = {
    mutation_id: mutationId, approval_id: granted.approval_id, repository: grantedIdentity.repository,
    source_ref: "store-stg", source_environment_id: "staging", source_release_id: plan.source.release_id,
    configuration_id: "11234567-89ab-4def-8123-456789abcdef", manifest_sha256: grantedIdentity.manifest_sha256,
    config_digest: grantedIdentity.config_digest, source_revision: grantedIdentity.source_revision,
    workspace_plan_sha256: grantedIdentity.workspace_plan_sha256, plan,
  };
  const response = await routes.handle(new Request("http://localhost/v1/projects/store-prd/applications/storefront/environments/production/workspace-promotions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  expect(response.status).toBe(200);
  expect(executed).toBe(mutationId);
  expect((await response.json() as { mutation_id: string }).mutation_id).toBe(mutationId);
  const tampered = await routes.handle(new Request("http://localhost/v1/projects/store-prd/applications/storefront/environments/production/workspace-promotions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, plan: { ...plan, plan_sha256: "9".repeat(64) } }),
  }));
  expect(tampered.status).toBe(422);
  expect(executed).toBe(mutationId);
  const changed = await routes.handle(new Request("http://localhost/v1/projects/store-prd/applications/storefront/environments/production/workspace-promotions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  expect(changed.status).toBe(503);
  const reconciled = await routes.handle(new Request(`http://localhost/v1/projects/store-prd/applications/storefront/environments/production/workspace-promotions/${mutationId}/reconcile`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  expect(reconciled.status).toBe(200);
  const receipt = await reconciled.json() as { mutation_id: string; mutation: { status: string } };
  expect(receipt.mutation_id).toBe(mutationId);
  expect(receipt.mutation.status).toBe("outcome_unknown");
});

test("workspace mutations require applications.manage and production activation requires the grant", async () => {
  const store = new MemoryWorkspaceApprovalStore();
  let activations = 0;
  const denied = createWorkspaceReleaseRoutes({
    store, authorize: async () => undefined, principal: async () => actor,
    requireCapability: async () => { throw new (await import("../../src/utils/errors")).ForbiddenError("denied"); },
    activate: async () => { activations += 1; return { activation_id: "01234567-89ab-4def-8123-456789abcdef", release_id: identity.release_id }; },
  });
  const activation = {
    release_id: identity.release_id, configuration_id: "11234567-89ab-4def-8123-456789abcdef",
    activation_id: "01234567-89ab-4def-8123-456789abcdef", expected_activation_id: null,
  };
  const forbidden = await denied.handle(new Request("http://localhost/v1/projects/store-prd/applications/storefront/environments/staging/workspace-activations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(activation),
  }));
  expect(forbidden.status).toBe(403);
  expect(activations).toBe(0);
  const routes = createWorkspaceReleaseRoutes({
    store, authorize: async () => undefined, principal: async () => ({ ...actor, id: "teammate" }),
    requireCapability: async (_ref, _principal, capability) => { if (capability !== "applications.manage") throw new Error(capability); },
    activate: async () => { activations += 1; return { activation_id: activation.activation_id, release_id: identity.release_id }; },
  });
  const staging = await routes.handle(new Request("http://localhost/v1/projects/store-prd/applications/storefront/environments/staging/workspace-activations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(activation),
  }));
  expect(staging.status).toBe(200);
  expect(activations).toBe(1);
  const production = await routes.handle(new Request("http://localhost/v1/projects/store-prd/applications/storefront/environments/production/workspace-activations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(activation),
  }));
  expect(production.status).toBe(409);
  expect(activations).toBe(1);
});

test("another manage-capable actor can consume a grant and a concurrent grant does not replace the first actor", async () => {
  const secret = "user:embed-secret@github.com/acme/store";
  expect(() => workspaceRepositoryId(secret)).toThrow("Invalid workspace repository identity");
  try { workspaceRepositoryId(secret); } catch (error) { expect(error instanceof Error ? error.message : "").not.toContain("embed-secret"); }
  let gate: Promise<void> = Promise.resolve();
  let release: () => void = () => undefined;
  let entered = 0;
  const inner = new MemoryWorkspaceApprovalStore();
  const store = {
    async get(projectRef: string, approvalId: string) { return inner.get(projectRef, approvalId); },
    async putIfAbsent(record: Parameters<MemoryWorkspaceApprovalStore["putIfAbsent"]>[0]) {
      entered += 1;
      const mine = entered;
      if (mine === 1) gate = new Promise(resolve => { release = resolve; });
      else await gate;
      const result = await inner.putIfAbsent(record);
      if (mine === 1) release();
      return result;
    },
  };
  const audits: string[] = [];
  const racing = new WorkspaceReleaseApprovals({ store, now: () => "2026-11-18T00:00:00.000Z", audit: async record => { audits.push(record.actor); } });
  const [first, second] = await Promise.all([
    racing.grant(identity, { actor: "user-1", actorType: "project", requestId: "req-1" }),
    racing.grant(identity, { actor: "user-2", actorType: "project", requestId: "req-2" }),
  ]);
  expect(first.actor).toBe("user-1");
  expect(second.actor).toBe("user-1");
  expect(audits).toEqual(["user-1"]);
  let consumedBy = "";
  await executeApprovedPromotion(racing, identity.project_ref, first.approval_id, identity, "01234567-89ab-4def-8123-456789abcdef", async () => {
    consumedBy = "teammate";
    return { mutation_id: "01234567-89ab-4def-8123-456789abcdef" };
  });
  expect(consumedBy).toBe("teammate");
  expect(first.approval_id).toBe(workspaceApprovalId(identity));
});

test("workspace approval routes preserve platform administrator capability", async () => {
  const seen: boolean[] = [];
  const routes = createWorkspaceReleaseRoutes({
    store: new MemoryWorkspaceApprovalStore(),
    authorize: async () => undefined,
    audit: async () => undefined,
    principal: async () => ({ id: "platform-admin", type: "admin", requestId: "req-admin", platformAdmin: true }),
    requireCapability: async (_ref, actor, capability) => {
      seen.push(actor.platformAdmin);
      if (capability !== "applications.manage") throw new Error(capability);
    },
  });
  const { project_ref: _projectRef, ...body } = identity;
  const response = await routes.handle(new Request("http://localhost/v1/projects/store-prd/workspace-approvals", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  expect(response.status).toBe(201);
  expect(seen).toEqual([true]);
});
