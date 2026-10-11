import {
  parseApplicationPromotionPlan, parseApplicationReleaseTransferResult, parseApplicationReleaseRecord,
  parseDeploymentEvidence, type ApplicationPromotionPlan, type ApplicationReleaseTransferResult, type DeploymentEvidence,
} from "@supacloud/delivery";
import type { ApplicationDeploymentService } from "./application-deployment";
import {
  ApplicationPromotionError, type ApplicationPromotionInput, type ApplicationPromotions,
} from "./application-promotion";
import { ApplicationMigrations, ApplicationMigrationError } from "./application-migrations";
import { ApplicationReleaseTransferError, type ApplicationReleaseTransfers } from "./application-release-transfer";
import type { ApplicationReleaseStorage } from "./application-release-storage";
import {
  applicationActivationMutations, type ApplicationActivationMutations, type ApplicationActiveRecord,
} from "./application-activation";
import { isProjectMutationId, type MutationPrincipal, type MutationLeaseInput, type ProjectMutationState } from "./project-mutation.service";
import { stableSha256, stableStringify } from "../utils/stable-json";
import type { ApplicationActiveStorage } from "./application-active-storage";
import type { ApplicationDeploymentEvidenceStorage } from "./application-deployment-evidence";
import {
  applicationPromotionFingerprint, applicationPromotionResource, parseApplicationPromotionCheckpoint,
  applicationPromotionReceipt,
  hasApplicationPromotionRecoveryReceipt,
  type ApplicationPromotionCheckpoint, type ApplicationPromotionRequest,
} from "./application-promotion-operation";

const OPERATION = "application.release.promote";
type PromotionCheckpoint = ApplicationPromotionCheckpoint & {
  transfer?: ReturnType<typeof compactTransfer>;
  migration?: ReturnType<typeof compactMigration>;
  activation?: Record<string, unknown>;
  verification?: Record<string, unknown>;
};

export interface ApplicationPromotionExecuteInput extends ApplicationPromotionInput {
  mutationId: string;
  plan: ApplicationPromotionPlan;
  approvedMigrationDigest?: string;
  principal: MutationPrincipal;
}

export interface ApplicationPromotionExecuteResult {
  project_ref: string;
  application_id: string;
  environment_id: string;
  mutation_id: string | null;
  activation_id: string | null;
  plan_sha256: string;
  action: "promote" | "no-op";
  replayed: boolean;
}

export interface ApplicationPromotionExecutorDependencies {
  promotions: Pick<ApplicationPromotions, "readPlan" | "readOwnedPlan">;
  transfers: Pick<ApplicationReleaseTransfers, "transfer">;
  migrations: Pick<ApplicationMigrations, "readExecutionPlan" | "apply" | "inspect">;
  releases: Pick<ApplicationReleaseStorage, "readRelease">;
  active: Pick<ApplicationActiveStorage, "readForApplication">;
  evidence: Pick<ApplicationDeploymentEvidenceStorage, "read" | "write">;
  deployment: Pick<ApplicationDeploymentService, "activatePromotionConfigured" | "observePromotion">;
  verifySmoke(record: ApplicationActiveRecord): Promise<DeploymentEvidence>;
  mutations?: ApplicationActivationMutations;
  now?: () => number;
}

function compactTransfer(result: ApplicationReleaseTransferResult) {
  return {
    schema: result.schema, project_ref: result.project_ref, application_id: result.application_id,
    source: result.source, candidate_release_id: result.candidate_release_id,
    release_id: result.release.release_id, manifest_sha256: result.release.manifest_sha256,
    activation_performed: result.activation_performed,
  };
}

function compactMigration(result: Awaited<ReturnType<ApplicationMigrations["apply"]>>) {
  return {
    schema: "supacloud.application-migration-result.v1",
    before_ledger_digest: result.before.ledger_digest,
    after_ledger_digest: result.after.ledger_digest,
    backup: result.backup,
    applied: result.applied.map(entry => ({
      version: entry.version, name: entry.name, checksum: entry.checksum,
    })),
  };
}

function validateInput(input: ApplicationPromotionExecuteInput): void {
  if (!/^[a-z0-9-]{1,20}$/.test(input.projectRef)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(input.applicationId)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(input.environmentId)
    || !/^[a-z0-9-]{1,20}$/.test(input.sourceProjectRef)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(input.sourceEnvironmentId)
    || !/^[a-f0-9]{64}$/.test(input.sourceReleaseId)
    || !isProjectMutationId(input.mutationId)
    || input.approvedMigrationDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.approvedMigrationDigest)) {
    throw new ApplicationPromotionError("APPLICATION_PROMOTION_IDENTITY_INVALID", 400);
  }
}

function assertPlanBinding(plan: ApplicationPromotionPlan, input: ApplicationPromotionExecuteInput): void {
  if (plan.project_ref !== input.projectRef || plan.application_id !== input.applicationId
    || plan.environment_id !== input.environmentId || plan.source.project_ref !== input.sourceProjectRef
    || plan.source.environment_id !== input.sourceEnvironmentId || plan.source.release_id !== input.sourceReleaseId
    || input.configurationId !== undefined && input.configurationId !== plan.target.configuration_id) {
    throw new ApplicationPromotionError("APPLICATION_PROMOTION_PLAN_MISMATCH", 409);
  }
}

function requestFor(input: ApplicationPromotionExecuteInput, plan: ApplicationPromotionPlan): ApplicationPromotionRequest {
  return {
    project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId,
    source_ref: input.sourceProjectRef, source_environment_id: input.sourceEnvironmentId,
    source_release_id: input.sourceReleaseId, configuration_id: plan.target.configuration_id!,
    plan_sha256: plan.plan_sha256, approved_migration_digest: input.approvedMigrationDigest ?? null,
  };
}

function stableBackupId(input: ApplicationPromotionExecuteInput, plan: ApplicationPromotionPlan): string {
  return `logical-full_${plan.project_ref}_${stableSha256({
    mutation_id: input.mutationId, application_id: plan.application_id,
    environment_id: plan.environment_id, plan_sha256: plan.plan_sha256,
  }).slice(0, 32)}`;
}

function owner(input: ApplicationPromotionExecuteInput, lease: MutationLeaseInput, fingerprint: string) {
  return { lease, principal: structuredClone(input.principal), requestFingerprint: fingerprint };
}

function success(state: ProjectMutationState): boolean {
  return state.status === "succeeded" && state.responseStatus !== null
    && state.responseStatus >= 200 && state.responseStatus < 300;
}

function assertReceipt(state: ProjectMutationState, input: ApplicationPromotionExecuteInput): string {
  const parent = parseApplicationPromotionCheckpoint(state);
  const receipt = state.receipt;
  if (hasApplicationPromotionRecoveryReceipt(state)) {
    if (parent.plan.plan_sha256 !== input.plan.plan_sha256) {
      throw new ApplicationPromotionError("APPLICATION_PROMOTION_RECEIPT_INVALID", 503);
    }
    return parent.activation_id;
  }
  if (!receipt || receipt["schema"] !== "supacloud.application-promotion-receipt.v1"
    || receipt["mutation_id"] !== input.mutationId || receipt["plan_sha256"] !== input.plan.plan_sha256
    || receipt["project_ref"] !== input.projectRef || receipt["application_id"] !== input.applicationId
    || receipt["environment_id"] !== input.environmentId || typeof receipt["activation_id"] !== "string"
    || stableStringify(receipt) !== stableStringify(applicationPromotionReceipt(parent))) {
    throw new ApplicationPromotionError("APPLICATION_PROMOTION_RECEIPT_INVALID", 503);
  }
  return receipt["activation_id"];
}

export class ApplicationPromotionExecutor {
  private readonly mutations: ApplicationActivationMutations;

  constructor(private readonly dependencies: ApplicationPromotionExecutorDependencies) {
    if (typeof dependencies.verifySmoke !== "function") {
      throw new Error("APPLICATION_PROMOTION_SMOKE_VERIFIER_REQUIRED");
    }
    this.mutations = dependencies.mutations ?? applicationActivationMutations;
  }

  async execute(request: ApplicationPromotionExecuteInput): Promise<ApplicationPromotionExecuteResult> {
    const input = structuredClone(request);
    validateInput(input);
    const plan = parseApplicationPromotionPlan(input.plan);
    assertPlanBinding(plan, input);
    if (plan.action === "no-op") {
      const observed = await this.dependencies.promotions.readPlan(input);
      if (observed.plan_sha256 !== plan.plan_sha256 || observed.action !== "no-op") {
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_PLAN_CHANGED", 409);
      }
      return {
        project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId,
        mutation_id: null, activation_id: plan.target.activation_id, plan_sha256: plan.plan_sha256,
        action: "no-op", replayed: false,
      };
    }
    if (plan.blockers.some(code => !["MIGRATION_PENDING", "BACKUP_REQUIRED"].includes(code))) {
      throw new ApplicationPromotionError("APPLICATION_PROMOTION_BLOCKED", 409);
    }
    if (!plan.target.configuration_id || !plan.target.configuration) {
      throw new ApplicationPromotionError("APPLICATION_PROMOTION_CONFIGURATION_REQUIRED", 409);
    }

    const requestBinding = requestFor(input, plan);
    const fingerprint = applicationPromotionFingerprint(requestBinding);
    const begun = await this.mutations.begin({
      projectRef: input.projectRef, mutationId: input.mutationId, operation: OPERATION,
      resource: applicationPromotionResource(input.applicationId, input.environmentId),
      principal: input.principal, requestFingerprint: fingerprint,
    });
    if (!begun.lease) {
      if (!success(begun.state)) throw new ApplicationPromotionError("APPLICATION_PROMOTION_OUTCOME_UNRESOLVED", 503);
      const activationId = assertReceipt(begun.state, input);
      const observed = await this.dependencies.promotions.readPlan(input);
      if (observed.action !== "no-op" || observed.target.activation_id !== activationId
        || observed.target.candidate_release_id !== plan.target.candidate_release_id
        || observed.target.configuration_id !== plan.target.configuration_id) {
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_READBACK_FAILED", 503);
      }
      return {
        project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId,
        mutation_id: input.mutationId, activation_id: activationId, plan_sha256: plan.plan_sha256,
        action: "promote", replayed: true,
      };
    }

    const lease = begun.lease;
    const promotionOwner = owner(input, lease, fingerprint);
    const backupId = stableBackupId(input, plan);
    const checkpoint: PromotionCheckpoint = {
      schema: "supacloud.application-promotion-operation.v1", phase: "prepared",
      request: requestBinding, plan, mutation_id: input.mutationId, backup_id: backupId,
      activation_id: crypto.randomUUID(),
    };
    let effectsStarted = false;
    let completed = false;
    try {
      if (Object.keys(begun.state.checkpoint).length !== 0) {
        effectsStarted = begun.state.checkpoint["phase"] !== "prepared";
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_RECONCILIATION_REQUIRED", 503);
      }
      await this.mutations.checkpoint(lease, checkpoint);
      const ownedPlan = await this.dependencies.promotions.readOwnedPlan(input, promotionOwner);
      if (ownedPlan.plan_sha256 !== plan.plan_sha256) {
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_PLAN_CHANGED", 409);
      }

      if (plan.target.artifact_action === "materialize") {
        checkpoint.phase = "transferring";
        await this.mutations.checkpoint(lease, checkpoint);
        effectsStarted = true;
        await this.mutations.protect(lease, async () => {
          const transfer = parseApplicationReleaseTransferResult(await this.dependencies.transfers.transfer({
            projectRef: input.projectRef, applicationId: input.applicationId,
            sourceProjectRef: input.sourceProjectRef, sourceReleaseId: input.sourceReleaseId,
            expectedManifestSha256: plan.manifest_sha256,
          }));
          if (transfer.project_ref !== input.projectRef || transfer.application_id !== input.applicationId
            || transfer.source.project_ref !== input.sourceProjectRef || transfer.source.release_id !== input.sourceReleaseId
            || transfer.candidate_release_id !== plan.target.candidate_release_id
            || transfer.release.manifest_sha256 !== plan.manifest_sha256) {
            throw new ApplicationPromotionError("APPLICATION_PROMOTION_TRANSFER_UNVERIFIED", 503);
          }
          checkpoint.transfer = compactTransfer(transfer);
        });
      }

      if (plan.migrations.pending_versions.length > 0) {
        checkpoint.phase = "migrating";
        await this.mutations.checkpoint(lease, checkpoint);
        const executionPlan = await this.dependencies.migrations.readExecutionPlan({
          projectRef: input.projectRef, applicationId: input.applicationId,
          releaseId: plan.target.candidate_release_id,
        });
        if (executionPlan.ledger_digest !== plan.migrations.ledger_digest) {
          throw new ApplicationPromotionError("APPLICATION_PROMOTION_PLAN_CHANGED", 409);
        }
        effectsStarted = true;
        await this.mutations.protect(lease, async () => {
          checkpoint.migration = compactMigration(await this.dependencies.migrations.apply({
            projectRef: input.projectRef, applicationId: input.applicationId,
            releaseId: plan.target.candidate_release_id, expectedLedgerDigest: executionPlan.ledger_digest,
            backupId,
            ...(input.approvedMigrationDigest === undefined
              ? {} : { approvedMigrationDigest: input.approvedMigrationDigest }),
          }));
        });
      }

      const release = parseApplicationReleaseRecord(await this.dependencies.releases.readRelease(
        input.projectRef, input.applicationId, plan.target.candidate_release_id,
      ));
      if (release.project_ref !== input.projectRef || release.application_id !== input.applicationId
        || release.release_id !== plan.target.candidate_release_id || release.manifest_sha256 !== plan.manifest_sha256) {
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_TRANSFER_UNVERIFIED", 503);
      }
      checkpoint.phase = "activating";
      await this.mutations.checkpoint(lease, checkpoint);
      effectsStarted = true;
      const activation = await this.dependencies.deployment.activatePromotionConfigured({
        runtime: {
          release, environmentId: input.environmentId, activationId: checkpoint.activation_id,
        },
        configurationId: plan.target.configuration_id,
        expectedActivationId: plan.target.activation_id,
        principal: input.principal, owner: promotionOwner,
      });
      if (activation.activation_id !== checkpoint.activation_id || activation.release_id !== release.release_id
        || activation.project_ref !== input.projectRef || activation.application_id !== input.applicationId
        || activation.environment_id !== input.environmentId) {
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_ACTIVATION_UNVERIFIED", 503);
      }
      const state = await this.mutations.read(input.projectRef, input.mutationId);
      if (!state || state.status !== "running" || state.fencingEpoch !== lease.fencingEpoch) {
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_OWNER_LOST", 409);
      }
      const activated = parseApplicationPromotionCheckpoint(state);
      if (activated.phase !== "verifying" || activated.activation_id !== checkpoint.activation_id
        || activated.plan.plan_sha256 !== plan.plan_sha256) {
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_ACTIVATION_UNVERIFIED", 503);
      }
      // 保留委托 journal 中的逐阶段 checkpoint，不能用 HTTP 结果覆盖它。
      Object.assign(checkpoint, activated);
      const current = await this.dependencies.active.readForApplication(
        input.projectRef, input.applicationId, input.environmentId,
      );
      if (!current || current.promotionMutationId !== input.mutationId
        || current.runtime.activationId !== checkpoint.activation_id || current.configurationId !== plan.target.configuration_id
        || stableStringify(current.runtime.release) !== stableStringify(release)) {
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_READBACK_FAILED", 503);
      }
      await this.mutations.protect(lease, () => this.dependencies.deployment.observePromotion(state, current));
      const smokeStarted = (this.dependencies.now ?? Date.now)();
      const evidence = parseDeploymentEvidence(await this.dependencies.verifySmoke(structuredClone(current)));
      const now = (this.dependencies.now ?? Date.now)();
      if (evidence.status === "failed" || evidence.scope.project_ref !== input.projectRef
        || evidence.scope.application_id !== input.applicationId || evidence.scope.environment_id !== input.environmentId
        || evidence.source.manifest_sha256 !== plan.manifest_sha256 || evidence.activation.release_id !== release.release_id
        || evidence.activation.activation_id !== current.runtime.activationId
        || evidence.activation.configuration_id !== current.configurationId
        || evidence.health.status !== "confirmed" || evidence.health.authenticated_smoke !== "confirmed"
        || evidence.health.checked_at === null || Date.parse(evidence.health.checked_at) < smokeStarted
        || Date.parse(evidence.health.checked_at) > now || Date.parse(evidence.recorded_at) < smokeStarted
        || Date.parse(evidence.recorded_at) > now
        || evidence.database.migration.status !== "confirmed" || evidence.database.migration.compatibility !== "verified") {
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_SMOKE_UNVERIFIED", 503);
      }
      const after = await this.dependencies.migrations.inspect(input.projectRef, input.applicationId, release.release_id);
      if (!after.project_migrations_applied || !after.ledger_compatible
        || evidence.database.migration.inventory_sha256 !== after.ledger_digest
        || after.ledger_digest !== (checkpoint.migration?.after_ledger_digest ?? plan.migrations.ledger_digest)) {
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_READBACK_FAILED", 503);
      }
      await this.mutations.protect(lease, async () => {
        await this.dependencies.deployment.observePromotion(state, current);
        const saved = await this.dependencies.evidence.write(evidence);
        const readback = await this.dependencies.evidence.read(input.projectRef, input.applicationId, input.environmentId);
        if (stableStringify(saved) !== stableStringify(evidence)
          || stableStringify(readback) !== stableStringify(evidence)) {
          throw new ApplicationPromotionError("APPLICATION_PROMOTION_EVIDENCE_UNVERIFIED", 503);
        }
      });
      const observed = await this.dependencies.promotions.readOwnedPlan(input, promotionOwner);
      if (observed.target.activation_id !== checkpoint.activation_id
        || observed.action !== "no-op"
        || !observed.target.ready || !observed.target.smoke_verified
        || observed.target.evidence_sha256 !== stableSha256(evidence)
        || observed.target.configuration_id !== plan.target.configuration_id) {
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_READBACK_FAILED", 503);
      }
      checkpoint.verification = {
        target_activation_id: observed.target.activation_id,
        target_ready: observed.target.ready, target_smoke_verified: observed.target.smoke_verified,
        evidence_sha256: observed.target.evidence_sha256,
        migration_ledger_digest: observed.target.migration_ledger_digest,
      };
      checkpoint.phase = "verifying";
      await this.mutations.checkpoint(lease, checkpoint);
      await this.mutations.success(lease, applicationPromotionReceipt(checkpoint));
      completed = true;
      const stored = await this.mutations.read(input.projectRef, input.mutationId);
      if (!stored || !success(stored)) throw new ApplicationPromotionError("APPLICATION_PROMOTION_RECEIPT_INVALID", 503);
      const activationId = assertReceipt(stored, input);
      return {
        project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId,
        mutation_id: input.mutationId, activation_id: activationId, plan_sha256: plan.plan_sha256,
        action: "promote", replayed: false,
      };
    } catch (error) {
      if (!completed) await this.mutations.failure(lease, effectsStarted, !effectsStarted);
      if (error instanceof ApplicationPromotionError) throw error;
      if (error instanceof ApplicationMigrationError || error instanceof ApplicationReleaseTransferError) {
        throw new ApplicationPromotionError(error.code, error.statusCode);
      }
      throw new ApplicationPromotionError(
        effectsStarted ? "APPLICATION_PROMOTION_OUTCOME_UNRESOLVED" : "APPLICATION_PROMOTION_FAILED", 503,
      );
    }
  }
}
