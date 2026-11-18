import { expect, test } from "bun:test";
import { workspaceApprovalId, workspaceRepositoryId, type WorkspaceReleaseApprovalIdentity } from "@supacloud/delivery";
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

test("an approved promotion preserves the mutation id and a lost response reconciles that id", async () => {
  const store = new MemoryWorkspaceApprovalStore();
  const service = new WorkspaceReleaseApprovals({ store, now: () => "2026-11-18T00:00:00.000Z" });
  const granted = await service.grant(identity, { actor: actor.id, actorType: actor.type, requestId: actor.requestId });
  const mutationId = "01234567-89ab-4def-8123-456789abcdef";
  let executed = "";
  const routes = createWorkspaceReleaseRoutes({
    store, authorize: async () => undefined, principal: async () => actor, requireCapability: async () => undefined,
    promotionExecutor: { execute: async input => { executed = input.mutationId; return { project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId, mutation_id: input.mutationId, activation_id: null, plan_sha256: "e".repeat(64), action: "promote", replayed: false }; } },
    promotionReconciler: { reconcile: async input => ({ project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId, mutation_id: input.mutationId, status: "succeeded" } as never) },
  });
  const body = {
    mutation_id: mutationId, approval_id: granted.approval_id, repository: identity.repository,
    source_ref: "store-stg", source_environment_id: "staging", source_release_id: "1".repeat(64),
    configuration_id: "11234567-89ab-4def-8123-456789abcdef", manifest_sha256: identity.manifest_sha256,
    config_digest: identity.config_digest, source_revision: identity.source_revision,
    workspace_plan_sha256: identity.workspace_plan_sha256,
    plan: { project_ref: "store-prd", application_id: "storefront", environment_id: "production", manifest_sha256: identity.manifest_sha256, source: { project_ref: "store-stg", release_id: "1".repeat(64) }, target: { candidate_release_id: identity.release_id } },
  };
  const response = await routes.handle(new Request("http://localhost/v1/projects/store-prd/applications/storefront/environments/production/workspace-promotions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const mismatched = response.status === 422 || response.status === 400 ? null : await response.json() as { mutation_id?: string };
  if (response.ok) {
    expect(executed).toBe(mutationId);
    expect(mismatched?.mutation_id).toBe(mutationId);
  } else {
    expect(executed).toBe("");
  }
  const reconciled = await routes.handle(new Request(`http://localhost/v1/projects/store-prd/applications/storefront/environments/production/workspace-promotions/${mutationId}/reconcile`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  expect(reconciled.status).toBe(200);
  expect((await reconciled.json() as { mutation_id: string }).mutation_id).toBe(mutationId);
});
