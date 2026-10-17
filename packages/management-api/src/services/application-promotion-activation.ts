import type { SQL } from "bun";
import { sql } from "../db";
import { stableSha256, stableStringify } from "../utils/stable-json";
import {
  assertPublicMutationPayload, checkpointProjectMutation, projectMutationResourceKey,
  readProjectMutation, withProjectMutationLease, type ProjectMutationState,
} from "./project-mutation.service";
import type { ApplicationActiveRecord } from "./application-activation";
import type { ApplicationPromotionOwner } from "./application-promotion-ownership";
import { parseApplicationPromotionCheckpoint } from "./application-promotion-operation";

interface ActivationAttempt {
  schema: "supacloud.application-promotion-activation.v1";
  request_fingerprint: string;
  outcome: "running" | "succeeded" | "failed_terminal" | "outcome_unknown";
  checkpoint: Record<string, unknown>;
  receipt: Record<string, unknown> | null;
}

function attempt(value: unknown): ActivationAttempt {
  assertPublicMutationPayload(value);
  if (value["schema"] !== "supacloud.application-promotion-activation.v1"
    || typeof value["request_fingerprint"] !== "string" || !/^[a-f0-9]{64}$/.test(value["request_fingerprint"])
    || !["running", "succeeded", "failed_terminal", "outcome_unknown"].includes(String(value["outcome"]))) {
    throw new Error("APPLICATION_PROMOTION_ACTIVATION_CHECKPOINT_INVALID");
  }
  assertPublicMutationPayload(value["checkpoint"]);
  if (value["receipt"] !== null) assertPublicMutationPayload(value["receipt"]);
  return value as unknown as ActivationAttempt;
}

/** 激活阶段共用提升行的租约；完成子阶段不得释放父资源或写父成功回执。 */
export class ApplicationPromotionActivationJournal {
  private readonly owner: ApplicationPromotionOwner;
  private readonly desired: ApplicationActiveRecord;
  private readonly expectedActivationId: string | null;
  private readonly fingerprint: string;

  constructor(
    owner: ApplicationPromotionOwner,
    binding: { desired: ApplicationActiveRecord; expectedActivationId: string | null },
    private readonly database: SQL = sql,
  ) {
    this.owner = structuredClone(owner);
    this.desired = structuredClone(binding.desired);
    this.expectedActivationId = binding.expectedActivationId;
    this.fingerprint = stableSha256(binding);
  }

  async begin(): Promise<{ checkpoint: Record<string, unknown> | null; completed: boolean }> {
    return this.withOwner(async (transaction, state) => {
      if (state.checkpoint["activation"] !== undefined) {
        const current = this.readAttempt(state);
        if (current.outcome !== "succeeded") throw new Error("APPLICATION_PROMOTION_ACTIVATION_RECONCILIATION_REQUIRED");
        if (current.checkpoint["phase"] !== "committed"
          || stableStringify(current.receipt) !== stableStringify(this.receipt())) {
          throw new Error("APPLICATION_PROMOTION_ACTIVATION_RECEIPT_INVALID");
        }
        return { checkpoint: structuredClone(current.checkpoint), completed: true };
      }
      if (state.checkpoint["phase"] !== "activating") throw new Error("APPLICATION_PROMOTION_ACTIVATION_PHASE_INVALID");
      const current: ActivationAttempt = {
        schema: "supacloud.application-promotion-activation.v1",
        request_fingerprint: this.fingerprint, outcome: "running", checkpoint: {}, receipt: null,
      };
      await this.write(transaction, state, current);
      return { checkpoint: null, completed: false };
    });
  }

  async checkpoint(value: Record<string, unknown>): Promise<void> {
    const snapshot = structuredClone(value);
    assertPublicMutationPayload(snapshot);
    await this.withOwner(async (transaction, state) => {
      const current = this.requireRunning(state);
      await this.write(transaction, state, { ...current, checkpoint: snapshot });
    });
  }

  async protect(action: () => Promise<void>): Promise<void> {
    await this.withOwner(async (_transaction, state) => {
      this.requireRunning(state);
      await action();
    });
  }

  async success(): Promise<void> {
    await this.withOwner(async (transaction, state) => {
      const current = this.requireRunning(state);
      if (current.checkpoint["phase"] !== "committed") throw new Error("APPLICATION_PROMOTION_ACTIVATION_PHASE_INVALID");
      await this.write(transaction, state, { ...current, outcome: "succeeded", receipt: this.receipt() }, "verifying");
    });
  }

  async failure(uncertain: boolean): Promise<void> {
    await this.withOwner(async (transaction, state) => {
      const current = this.requireRunning(state);
      await this.write(transaction, state, { ...current, outcome: uncertain ? "outcome_unknown" : "failed_terminal" });
    });
  }

  private receipt(): Record<string, unknown> {
    const runtime = this.desired.runtime;
    return {
      project_ref: runtime.release.project_ref, application_id: runtime.release.application_id,
      environment_id: runtime.environmentId, release_id: runtime.release.release_id,
      activation_id: runtime.activationId, replayed: false,
    };
  }

  private readAttempt(state: ProjectMutationState): ActivationAttempt {
    const current = attempt(state.checkpoint["activation"]);
    if (current.request_fingerprint !== this.fingerprint) throw new Error("APPLICATION_PROMOTION_ACTIVATION_REQUEST_CONFLICT");
    return current;
  }

  private requireRunning(state: ProjectMutationState): ActivationAttempt {
    const current = this.readAttempt(state);
    if (current.outcome !== "running" || state.checkpoint["phase"] !== "activating") {
      throw new Error("APPLICATION_PROMOTION_ACTIVATION_RECONCILIATION_REQUIRED");
    }
    return current;
  }

  private verifyOwner(state: ProjectMutationState): void {
    const { runtime } = this.desired;
    const scope = {
      projectRef: runtime.release.project_ref,
      applicationId: runtime.release.application_id,
      environmentId: runtime.environmentId,
    };
    if (state.status !== "running" || state.operation !== "application.release.promote"
      || state.projectRef !== scope.projectRef || state.projectRef !== this.owner.lease.projectRef
      || state.mutationId !== this.owner.lease.mutationId
      || state.fencingEpoch !== this.owner.lease.fencingEpoch
      || state.requestFingerprint !== this.owner.requestFingerprint
      || stableStringify(state.principal) !== stableStringify(this.owner.principal)
      || state.resourceKey !== projectMutationResourceKey({
        type: "application_release",
        id: stableSha256({ applicationId: scope.applicationId, environmentId: scope.environmentId }),
      })) throw new Error("APPLICATION_PROMOTION_ACTIVATION_OWNER_LOST");
    const parent = parseApplicationPromotionCheckpoint(state);
    if (!["activating", "verifying"].includes(parent.phase)) {
      throw new Error("APPLICATION_PROMOTION_ACTIVATION_PHASE_INVALID");
    }
    if (parent.activation_id !== runtime.activationId
      || this.desired.promotionMutationId !== state.mutationId) {
      throw new Error("APPLICATION_PROMOTION_ACTIVATION_PLAN_MISMATCH");
    }
    const plan = parent.plan;
    const configuration = plan.target.configuration;
    if (plan.project_ref !== scope.projectRef || plan.application_id !== scope.applicationId
      || plan.environment_id !== scope.environmentId || plan.target.candidate_release_id !== runtime.release.release_id
      || plan.manifest_sha256 !== runtime.release.manifest_sha256
      || plan.target.activation_id !== this.expectedActivationId
      || !configuration || this.desired.configurationId !== configuration.configuration_id
      || runtime.bunVersion !== configuration.bun_version
      || plan.blockers.some(blocker => blocker !== "MIGRATION_PENDING" && blocker !== "BACKUP_REQUIRED")
      || configuration.targets.length !== runtime.release.targets.length
      || runtime.release.targets.some(target =>
        !configuration.targets.some(binding => binding.name === target.name && binding.kind === target.kind))
      || stableStringify(this.desired.hosts) !== stableStringify(Object.fromEntries(configuration.targets
        .filter(target => target.kind === "http").map(target => [target.name, target.hosts])))) {
      throw new Error("APPLICATION_PROMOTION_ACTIVATION_PLAN_MISMATCH");
    }
  }

  private async write(
    transaction: SQL, state: ProjectMutationState, current: ActivationAttempt,
    phase: "activating" | "verifying" = "activating",
  ): Promise<void> {
    const result = await checkpointProjectMutation(transaction, {
      ...this.owner.lease, leaseSeconds: 3600, checkpoint: { ...state.checkpoint, phase, activation: current },
    });
    if (result !== "updated") throw new Error("APPLICATION_PROMOTION_ACTIVATION_OWNER_LOST");
  }

  private async withOwner<T>(action: (transaction: SQL, state: ProjectMutationState) => Promise<T>): Promise<T> {
    const execution = await this.database.begin(transaction => withProjectMutationLease(transaction, this.owner.lease, async () => {
      const state = await readProjectMutation(this.owner.lease, transaction);
      if (!state) throw new Error("APPLICATION_PROMOTION_ACTIVATION_OWNER_LOST");
      this.verifyOwner(state);
      return action(transaction, state);
    }));
    if (execution.kind !== "executed") throw new Error("APPLICATION_PROMOTION_ACTIVATION_OWNER_LOST");
    return execution.value;
  }
}
