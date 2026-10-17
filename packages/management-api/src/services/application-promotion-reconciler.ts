import { ApplicationPromotionError, type ApplicationPromotionInput, type ApplicationPromotions } from "./application-promotion";
import {
  hasApplicationPromotionActivationCheckpoint, hasApplicationPromotionActivationReceipt,
  type ApplicationActivationMutations, applicationActivationMutations,
} from "./application-activation";
import type { ApplicationActiveStorage } from "./application-active-storage";
import type { ApplicationDeploymentService } from "./application-deployment";
import {
  parseApplicationPromotionCheckpoint, applicationPromotionRecoveryFingerprint, applicationPromotionResource,
  hasApplicationPromotionRecoveryReceipt, type ApplicationPromotionCheckpoint,
} from "./application-promotion-operation";
import {
  isProjectMutationId, publicProjectMutation, projectMutationResourceKey,
  type MutationPrincipal, type ProjectMutationState,
} from "./project-mutation.service";
import { stableStringify } from "../utils/stable-json";

export interface ApplicationPromotionReconcileInput {
  projectRef: string;
  applicationId: string;
  environmentId: string;
  mutationId: string;
  principal: MutationPrincipal;
}

export interface ApplicationPromotionReconcilerDependencies {
  promotions: Pick<ApplicationPromotions, "readPlan" | "readReconciliationPlan">;
  active: Pick<ApplicationActiveStorage, "readForApplication">;
  deployment: Pick<ApplicationDeploymentService, "observePromotion">;
  mutations?: ApplicationActivationMutations;
}

function request(checkpoint: ApplicationPromotionCheckpoint): ApplicationPromotionInput {
  return {
    projectRef: checkpoint.request.project_ref,
    applicationId: checkpoint.request.application_id,
    environmentId: checkpoint.request.environment_id,
    sourceProjectRef: checkpoint.request.source_ref,
    sourceEnvironmentId: checkpoint.request.source_environment_id,
    sourceReleaseId: checkpoint.request.source_release_id,
    configurationId: checkpoint.request.configuration_id,
  };
}

function checkpoint(state: ProjectMutationState): ApplicationPromotionCheckpoint | null {
  if (Object.keys(state.checkpoint).length === 0) return null;
  try { return parseApplicationPromotionCheckpoint(state); }
  catch { throw new ApplicationPromotionError("APPLICATION_PROMOTION_RECONCILIATION_REQUIRED", 503); }
}

function response(input: ApplicationPromotionReconcileInput, state: ProjectMutationState) {
  const parent = checkpoint(state);
  return {
    project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId,
    mutation: publicProjectMutation(state),
    promotion: {
      phase: parent?.phase ?? null,
      plan_sha256: parent?.plan.plan_sha256 ?? null,
      activation_id: parent?.activation_id ?? null,
      release_id: parent?.plan.target.candidate_release_id ?? null,
      configuration_id: parent?.plan.target.configuration_id ?? null,
      backup_id: parent?.backup_id ?? null,
      data_recovery: "separate-required",
    },
  };
}

export class ApplicationPromotionReconciler {
  private readonly mutations: ApplicationActivationMutations;

  constructor(private readonly dependencies: ApplicationPromotionReconcilerDependencies) {
    this.mutations = dependencies.mutations ?? applicationActivationMutations;
  }

  private async read(input: ApplicationPromotionReconcileInput): Promise<ProjectMutationState> {
    if (!/^[a-z0-9-]{1,20}$/.test(input.projectRef)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(input.applicationId)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(input.environmentId)
      || !isProjectMutationId(input.mutationId)) {
      throw new ApplicationPromotionError("APPLICATION_PROMOTION_IDENTITY_INVALID", 400);
    }
    const state = await this.mutations.read(input.projectRef, input.mutationId);
    if (!state || state.projectRef !== input.projectRef || state.mutationId !== input.mutationId
      || state.operation !== "application.release.promote"
      || state.resourceKey !== projectMutationResourceKey(applicationPromotionResource(input.applicationId, input.environmentId))
      || state.principal.type !== input.principal.type || state.principal.id !== input.principal.id) {
      throw new ApplicationPromotionError("APPLICATION_PROMOTION_NOT_FOUND", 404);
    }
    checkpoint(state);
    return state;
  }

  async status(request: ApplicationPromotionReconcileInput) {
    const input = structuredClone(request);
    return response(input, await this.read(input));
  }

  async reconcile(
    identity: ApplicationPromotionReconcileInput,
    authorizeSource: (input: ApplicationPromotionInput) => Promise<void>,
  ) {
    const input = structuredClone(identity);
    const current = await this.read(input);
    if (current.status !== "outcome_unknown") return response(input, current);
    const parent = checkpoint(current);
    if (!parent || parent.phase !== "verifying") {
      throw new ApplicationPromotionError("APPLICATION_PROMOTION_RECONCILIATION_REQUIRED", 503);
    }
    const promotion = request(parent);
    await authorizeSource(structuredClone(promotion));
    try {
      const active = await this.dependencies.active.readForApplication(
        input.projectRef, input.applicationId, input.environmentId,
      );
      if (!active || !hasApplicationPromotionActivationCheckpoint(current, active)) throw new Error("Unverified authority");
      await this.dependencies.deployment.observePromotion(current, active);
      const observed = await this.dependencies.promotions.readReconciliationPlan(promotion, current);
      const migration = parent["migration"];
      const expectedLedger = migration && typeof migration === "object" && !Array.isArray(migration)
        ? (migration as Record<string, unknown>)["after_ledger_digest"] : parent.plan.migrations.ledger_digest;
      if (parent.plan.migrations.pending_versions.length > 0 && !migration
        || observed.action !== "no-op" || observed.target.activation_id !== parent.activation_id
        || observed.target.current_release_id !== parent.plan.target.candidate_release_id
        || observed.target.candidate_release_id !== parent.plan.target.candidate_release_id
        || observed.manifest_sha256 !== parent.plan.manifest_sha256
        || !observed.target.ready || !observed.target.smoke_verified || !observed.target.receipt_confirmed
        || observed.target.configuration_id !== parent.plan.target.configuration_id
        || observed.migrations.ledger_digest !== expectedLedger
        || observed.target.migration_ledger_digest !== expectedLedger
        || !observed.migrations.project_migrations_applied || !observed.migrations.ledger_compatible) {
        throw new Error("Unverified promotion");
      }
      const verification = parent["verification"];
      if (verification && (typeof verification !== "object" || Array.isArray(verification)
        || (verification as Record<string, unknown>)["evidence_sha256"] !== observed.target.evidence_sha256
        || (verification as Record<string, unknown>)["migration_ledger_digest"] !== expectedLedger)) {
        throw new Error("Changed evidence");
      }
      await this.dependencies.deployment.observePromotion(current, active);
      if (stableStringify(active) !== stableStringify(await this.dependencies.active.readForApplication(
        input.projectRef, input.applicationId, input.environmentId,
      )) || stableStringify(observed) !== stableStringify(
        await this.dependencies.promotions.readReconciliationPlan(promotion, current),
      ) || stableStringify(current) !== stableStringify(await this.read(input))) {
        throw new Error("Changed observation");
      }
      await this.mutations.recover(current, applicationPromotionRecoveryFingerprint({
        plan_sha256: parent.plan.plan_sha256, activation_id: parent.activation_id,
        release_id: parent.plan.target.candidate_release_id, configuration_id: parent.plan.target.configuration_id,
      }));
      const recovered = await this.read(input);
      if (!hasApplicationPromotionRecoveryReceipt(recovered)
        || !hasApplicationPromotionActivationReceipt(recovered, active)
        || (await this.dependencies.promotions.readPlan(promotion)).action !== "no-op") {
        throw new Error("Unverified recovery receipt");
      }
      return response(input, recovered);
    } catch {
      // 恢复只写观察回执，失败时保留未知结果，不重放运行时或数据库副作用。
      throw new ApplicationPromotionError("APPLICATION_PROMOTION_RECONCILIATION_REQUIRED", 503);
    }
  }
}
