import { Elysia, status, t } from "elysia";
import { ApplicationPromotionPlanSchema, parseApplicationPromotionPlan, type ApplicationPromotionPlan } from "@supacloud/delivery";
import { getVerifiedRequestPrincipal } from "../middleware/auth";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { appendAuditEvent } from "../services/audit.service";
import type { TrustedPrincipal } from "../services/bff-proof.service";
import { requireCapability } from "../services/project-collaborator.service";
import { ForbiddenError } from "../utils/errors";
import type { ApplicationPromotionExecuteInput, ApplicationPromotionExecuteResult, ApplicationPromotionExecutor } from "../services/application-promotion-executor";
import type { ApplicationPromotionReconcileInput, ApplicationPromotionReconciler } from "../services/application-promotion-reconciler";
import {
  executeApprovedPromotion, WorkspaceReleaseApprovalError, WorkspaceReleaseApprovals,
  type WorkspaceApprovalAudit, type WorkspaceApprovalStore,
} from "../services/workspace-release-approval";
import { SqlWorkspaceApprovalStore } from "../services/workspace-release-approval-store";

const sha = t.String({ pattern: "^[a-f0-9]{64}$" });
const revision = t.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" });
const repository = t.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]*$" });
const projectParams = t.Object({ ref: t.String({ pattern: "^[a-z0-9-]{1,20}$" }) });
const environmentParams = t.Object({
  ref: projectParams.properties.ref,
  id: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
  environmentId: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
});

const approvalBody = t.Object({
  repository, application_id: environmentParams.properties.id,
  environment_id: environmentParams.properties.environmentId,
  release_id: sha, manifest_sha256: sha, config_digest: sha,
  source_revision: revision, workspace_plan_sha256: sha,
}, { additionalProperties: false });

export interface WorkspaceActivationRequest {
  projectRef: string;
  applicationId: string;
  environmentId: string;
  releaseId: string;
  configurationId: string;
  activationId: string;
  expectedActivationId: string | null;
  principal: TrustedPrincipal;
}

export interface WorkspaceReleaseRouteDependencies {
  store?: WorkspaceApprovalStore;
  authorize?: typeof requireProjectOrAdminAuth;
  principal?: (request: Request) => Promise<{ id: string; type: string; requestId?: string; platformAdmin?: boolean } | null>;
  requireCapability?: typeof requireCapability;
  audit?: (record: Parameters<NonNullable<ConstructorParameters<typeof WorkspaceReleaseApprovals>[0]["audit"]>>[0], audit: WorkspaceApprovalAudit) => Promise<void>;
  promotionExecutor?: Pick<ApplicationPromotionExecutor, "execute">;
  promotionReconciler?: Pick<ApplicationPromotionReconciler, "reconcile">;
  activate?: (input: WorkspaceActivationRequest) => Promise<{ activation_id: string; release_id: string }>;
  reconcileActivation?: (input: { projectRef: string; applicationId: string; environmentId: string; activationId: string; principal: TrustedPrincipal }) => Promise<{ activation_id: string; release_id?: string; mutation?: { status?: string } }>;
}

function failure(error: unknown) {
  if (error instanceof ForbiddenError) return status(403, { code: "FORBIDDEN", error: "Workspace release approval was rejected" });
  if (error instanceof WorkspaceReleaseApprovalError) {
    return status(error.statusCode, { code: error.code, error: "Workspace release approval was rejected" });
  }
  throw error;
}

function auditOf(actor: { id: string; type: string; requestId?: string; platformAdmin?: boolean }): WorkspaceApprovalAudit {
  return { actor: actor.id, actorType: actor.type, requestId: actor.requestId ?? "workspace", platformAdmin: actor.platformAdmin === true };
}

function requestIdOf(actor: object): string {
  return "requestId" in actor && typeof actor.requestId === "string" ? actor.requestId : "workspace";
}

function mutationPrincipal(actor: { id: string; type: string }): { type: "master" | "admin" | "project"; id: string } {
  const type = actor.type === "admin" || actor.type === "master" || actor.type === "project" ? actor.type : "project";
  return { type, id: actor.id };
}

export function createWorkspaceReleaseRoutes(dependencies: WorkspaceReleaseRouteDependencies = {}) {
  const approvals = new WorkspaceReleaseApprovals({
    store: dependencies.store ?? new SqlWorkspaceApprovalStore(),
    authorize: async (projectRef, audit, capability) => {
      await (dependencies.requireCapability ?? requireCapability)(projectRef, {
        id: audit.actor, type: audit.actorType, requestId: audit.requestId, platformAdmin: audit.platformAdmin === true,
      }, capability);
    },
    audit: dependencies.audit ?? (async (record, audit) => {
      await appendAuditEvent({
        projectRef: record.project_ref, actor: audit.actor, actorType: audit.actorType,
        action: "workspace.release.approve", method: "POST",
        path: `/v1/projects/${record.project_ref}/workspace-approvals`, status: 201,
        requestId: audit.requestId,
        metadata: {
          approval_id: record.approval_id, repository_id: record.repository_id,
          application_id: record.application_id, environment_id: record.environment_id,
          release_id: record.release_id, manifest_sha256: record.manifest_sha256,
          config_digest: record.config_digest, source_revision: record.source_revision,
          workspace_plan_sha256: record.workspace_plan_sha256,
        },
      });
    }),
  });
  const authorize = dependencies.authorize ?? requireProjectOrAdminAuth;
  const principal = dependencies.principal ?? (async (request: Request) => {
    const actor = await getVerifiedRequestPrincipal(request);
    return actor ? { ...actor, platformAdmin: actor.type === "master" || actor.type === "admin" } : null;
  });
  const manage = dependencies.requireCapability ?? requireCapability;
  async function requireManage(request: Request, projectRef: string, actor: { id: string; type: string; platformAdmin?: boolean }) {
    await manage(projectRef, {
      id: actor.id, type: actor.type, requestId: requestIdOf(actor), platformAdmin: actor.platformAdmin === true,
    }, "applications.manage");
  }
  return new Elysia({ prefix: "/v1/projects/:ref", name: "workspace-releases" })
    .post("/workspace-approvals", {
      params: projectParams, body: approvalBody,
      detail: { tags: ["applications"], summary: "Record a digest-bound workspace release approval" },
    }, async ({ params: values, body, request }) => {
      const denied = await authorize(request, values.ref);
      if (denied) return status(denied.status, denied.body);
      const actor = await principal(request);
      if (!actor) return status(401, { code: "UNAUTHORIZED", error: "Verified principal required" });
      try {
        if (body.repository.includes("://")) return status(400, { code: "WORKSPACE_APPROVAL_INVALID", error: "Repository identity must not be a URL" });
        const record = await approvals.grant({ ...body, project_ref: values.ref }, auditOf(actor));
        return status(201, record);
      } catch (error) { return failure(error); }
    })
    .get("/workspace-approvals/:approvalId", {
      params: t.Object({ ...projectParams.properties, approvalId: sha }),
      detail: { tags: ["applications"], summary: "Read one workspace release approval" },
    }, async ({ params: values, request }) => {
      const denied = await authorize(request, values.ref);
      if (denied) return status(denied.status, denied.body);
      const actor = await principal(request);
      if (!actor) return status(401, { code: "UNAUTHORIZED", error: "Verified principal required" });
      try { return await approvals.read(values.ref, values.approvalId, auditOf(actor)); }
      catch (error) { return failure(error); }
    })
    .post("/applications/:id/environments/:environmentId/workspace-promotions", {
      params: environmentParams,
      body: t.Object({
        mutation_id: t.String({ format: "uuid" }),
        approval_id: sha,
        repository, source_ref: t.String({ pattern: "^[a-z0-9-]{1,20}$" }),
        source_environment_id: environmentParams.properties.environmentId,
        source_release_id: sha, configuration_id: t.String({ format: "uuid" }),
        manifest_sha256: sha, config_digest: sha, source_revision: revision,
        workspace_plan_sha256: sha, plan: ApplicationPromotionPlanSchema,
        approved_migration_digest: t.Optional(sha),
      }, { additionalProperties: false }),
      detail: { tags: ["applications"], summary: "Promote one approved immutable release through the existing promotion executor" },
    }, async ({ params: values, body, request }) => {
      if (!dependencies.promotionExecutor) return status(503, { code: "APPLICATION_PROMOTION_EXECUTOR_UNAVAILABLE", error: "Application promotion executor is unavailable" });
      const denied = await authorize(request, values.ref);
      if (denied) return status(denied.status, denied.body);
      const actor = await principal(request);
      if (!actor) return status(401, { code: "UNAUTHORIZED", error: "Verified principal required" });
      try { await requireManage(request, values.ref, actor); }
      catch (error) { return failure(error); }
      let plan: ApplicationPromotionPlan;
      try { plan = parseApplicationPromotionPlan(body.plan); }
      catch { return status(422, { code: "APPLICATION_PROMOTION_PLAN_INVALID", error: "Application promotion plan was rejected" }); }
      try {
        if (plan.project_ref !== values.ref || plan.application_id !== values.id || plan.environment_id !== values.environmentId
          || plan.manifest_sha256 !== body.manifest_sha256 || plan.source.release_id !== body.source_release_id
          || plan.source.project_ref !== body.source_ref || !plan.target?.candidate_release_id) {
          return status(409, { code: "WORKSPACE_APPROVAL_MISMATCH", error: "Workspace release approval was rejected" });
        }
        const input: ApplicationPromotionExecuteInput = {
          projectRef: values.ref, applicationId: values.id, environmentId: values.environmentId,
          sourceProjectRef: body.source_ref, sourceEnvironmentId: body.source_environment_id,
          sourceReleaseId: body.source_release_id, configurationId: body.configuration_id,
          mutationId: body.mutation_id, plan, principal: mutationPrincipal(actor),
          ...(body.approved_migration_digest === undefined ? {} : { approvedMigrationDigest: body.approved_migration_digest }),
        };
        return await executeApprovedPromotion(approvals, values.ref, body.approval_id, {
          repository: body.repository, project_ref: values.ref, application_id: values.id,
          environment_id: values.environmentId, release_id: plan.target.candidate_release_id,
          manifest_sha256: body.manifest_sha256, config_digest: body.config_digest,
          source_revision: body.source_revision, workspace_plan_sha256: body.workspace_plan_sha256,
        }, body.mutation_id, () => dependencies.promotionExecutor!.execute(input));
      } catch (error) { return failure(error); }
    })
    .post("/applications/:id/environments/:environmentId/workspace-activations", {
      params: environmentParams,
      body: t.Object({
        release_id: sha,
        configuration_id: t.String({ format: "uuid" }), activation_id: t.String({ format: "uuid" }),
        expected_activation_id: t.Union([t.String({ format: "uuid" }), t.Null()]),
        approval_id: t.Optional(sha), repository: t.Optional(repository), manifest_sha256: t.Optional(sha),
        config_digest: t.Optional(sha), source_revision: t.Optional(revision), workspace_plan_sha256: t.Optional(sha),
      }, { additionalProperties: false }),
      detail: { tags: ["applications"], summary: "Activate an approved immutable release through the existing activation path" },
    }, async ({ params: values, body, request }) => {
      if (!dependencies.activate) return status(503, { code: "APPLICATION_ACTIVATION_UNAVAILABLE", error: "Application activation is unavailable" });
      const denied = await authorize(request, values.ref);
      if (denied) return status(denied.status, denied.body);
      const actor = await principal(request);
      if (!actor) return status(401, { code: "UNAUTHORIZED", error: "Verified principal required" });
      try {
        await requireManage(request, values.ref, actor);
        if (values.environmentId === "production") {
          if (!body.approval_id || !body.repository || !body.manifest_sha256 || !body.config_digest || !body.source_revision || !body.workspace_plan_sha256) {
            return status(409, { code: "WORKSPACE_APPROVAL_REQUIRED", error: "Production activation requires a matching server approval" });
          }
          await approvals.assertMatch(values.ref, body.approval_id, {
            repository: body.repository, project_ref: values.ref, application_id: values.id,
            environment_id: values.environmentId, release_id: body.release_id, manifest_sha256: body.manifest_sha256,
            config_digest: body.config_digest, source_revision: body.source_revision,
            workspace_plan_sha256: body.workspace_plan_sha256,
          });
        }
        return await dependencies.activate({
          projectRef: values.ref, applicationId: values.id, environmentId: values.environmentId,
          releaseId: body.release_id, configurationId: body.configuration_id,
          activationId: body.activation_id, expectedActivationId: body.expected_activation_id,
          principal: { ...mutationPrincipal(actor), requestId: requestIdOf(actor), platformAdmin: actor.platformAdmin === true },
        });
      } catch (error) { return failure(error); }
    })
    .post("/applications/:id/environments/:environmentId/workspace-promotions/:mutationId/reconcile", {
      params: t.Object({ ...environmentParams.properties, mutationId: t.String({ format: "uuid" }) }),
      body: t.Object({}, { additionalProperties: false }),
      detail: { tags: ["applications"], summary: "Reconcile one existing workspace promotion without a new mutation id" },
    }, async ({ params: values, request }) => {
      if (!dependencies.promotionReconciler) return status(503, { code: "APPLICATION_PROMOTION_RECONCILER_UNAVAILABLE", error: "Application promotion observation is unavailable" });
      const denied = await authorize(request, values.ref);
      if (denied) return status(denied.status, denied.body);
      const actor = await principal(request);
      if (!actor) return status(401, { code: "UNAUTHORIZED", error: "Verified principal required" });
      try { await requireManage(request, values.ref, actor); }
      catch (error) { return failure(error); }
      const input: ApplicationPromotionReconcileInput = {
        projectRef: values.ref, applicationId: values.id, environmentId: values.environmentId,
        mutationId: values.mutationId, principal: mutationPrincipal(actor),
      };
      const result = await dependencies.promotionReconciler.reconcile(input, async () => undefined);
      return { ...result, mutation_id: values.mutationId };
    })
    .post("/applications/:id/environments/:environmentId/workspace-activations/:activationId/reconcile", {
      params: t.Object({ ...environmentParams.properties, activationId: t.String({ format: "uuid" }) }),
      body: t.Object({}, { additionalProperties: false }),
      detail: { tags: ["applications"], summary: "Reconcile one existing activation without a new activation id" },
    }, async ({ params: values, request }) => {
      if (!dependencies.reconcileActivation) return status(503, { code: "APPLICATION_ACTIVATION_UNAVAILABLE", error: "Application activation is unavailable" });
      const denied = await authorize(request, values.ref);
      if (denied) return status(denied.status, denied.body);
      const actor = await principal(request);
      if (!actor) return status(401, { code: "UNAUTHORIZED", error: "Verified principal required" });
      try { await requireManage(request, values.ref, actor); }
      catch (error) { return failure(error); }
      const result = await dependencies.reconcileActivation({
        projectRef: values.ref, applicationId: values.id, environmentId: values.environmentId,
        activationId: values.activationId,
        principal: { ...mutationPrincipal(actor), requestId: requestIdOf(actor), platformAdmin: actor.platformAdmin === true },
      });
      if (result.activation_id !== values.activationId) {
        return status(503, { code: "WORKSPACE_MUTATION_IDENTITY_CHANGED", error: "Activation reconcile changed the activation id" });
      }
      return result;
    });
}
