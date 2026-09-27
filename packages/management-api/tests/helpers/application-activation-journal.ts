import type { ApplicationActivationMutations } from "../../src/services/application-activation";
import { assertPublicMutationPayload, type ProjectMutationState } from "../../src/services/project-mutation.service";

/** In-memory journal for controller fault injection, not PostgreSQL acceptance. */
export function activationJournal() {
  const states = new Map<string, ProjectMutationState>();
  const clone = <T>(value: T): T => structuredClone(value);
  const journal: ApplicationActivationMutations = {
    async begin(input) {
      let state = states.get(input.mutationId);
      if (state) {
        if (state.requestFingerprint !== input.requestFingerprint
          || state.principal.id !== input.principal.id || state.principal.type !== input.principal.type) {
          throw new Error("mutation conflict");
        }
        if (["succeeded", "failed_terminal", "outcome_unknown"].includes(state.status)) return { state: clone(state) };
      } else {
        const now = new Date().toISOString();
        state = {
          projectRef: input.projectRef, mutationId: input.mutationId, operation: input.operation,
          resourceKey: input.resource?.id ?? null, requestFingerprint: input.requestFingerprint,
          principal: input.principal, status: "running", checkpoint: {}, receipt: null,
          responseStatus: null, failureCode: null, leaseOwner: "test", leaseExpiresAt: null,
          fencingEpoch: 1, completedAt: null, createdAt: now, updatedAt: now,
        };
        if ([...states.values()].some(other => other.resourceKey === state!.resourceKey
          && ["pending", "running", "failed_retryable", "outcome_unknown"].includes(other.status))) {
          throw new Error("resource busy");
        }
        states.set(input.mutationId, state);
      }
      return { state: clone(state), lease: {
        projectRef: state.projectRef, mutationId: state.mutationId, leaseToken: "local",
        fencingEpoch: state.fencingEpoch,
      } };
    },
    async protect(lease, action) {
      if (states.get(lease.mutationId)?.status !== "running") throw new Error("lease lost");
      await action();
    },
    async checkpoint(lease, checkpoint) {
      assertPublicMutationPayload(checkpoint);
      states.get(lease.mutationId)!.checkpoint = clone(checkpoint);
    },
    async success(lease, receipt) {
      Object.assign(states.get(lease.mutationId)!, { status: "succeeded", receipt: clone(receipt), responseStatus: 200 });
    },
    async failure(lease, unknown, terminal) {
      states.get(lease.mutationId)!.status = unknown ? "outcome_unknown" : terminal ? "failed_terminal" : "failed_retryable";
    },
    async read(_projectRef, mutationId) { return clone(states.get(mutationId) ?? null); },
    async recover(state, fingerprint) {
      const current = states.get(state.mutationId);
      if (!current || current.status !== "outcome_unknown" || current.fencingEpoch !== state.fencingEpoch) {
        throw new Error("Recovery fencing conflict");
      }
      const receipt = { reconciliation: {
        source: "project.release.authority", observed_at: new Date().toISOString(),
        evidence_code: "RELEASE_AUTHORITY_CONFIRMED", evidence_fingerprint: fingerprint, target_status: "succeeded",
      } };
      assertPublicMutationPayload(receipt);
      Object.assign(current, { status: "succeeded", receipt, responseStatus: 200 });
    },
  };
  return { journal, states };
}
