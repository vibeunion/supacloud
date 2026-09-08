import { sql } from "../db";
import { ConflictError } from "../utils/errors";
import {
  beginProjectMutation, claimOrResumeProjectMutation, completeProjectMutationFailure,
  completeProjectMutationSuccess, readProjectMutation, reconcileProjectMutation, withProjectMutationLease,
  type BeginProjectMutationInput, type MutationLeaseInput, type ProjectMutationState,
} from "./project-mutation.service";

export interface ReleaseMutationStore {
  begin(input: BeginProjectMutationInput): Promise<{ state: ProjectMutationState; lease?: MutationLeaseInput }>;
  protect(lease: MutationLeaseInput, action: () => Promise<void>): Promise<void>;
  success(lease: MutationLeaseInput, receipt: Record<string, unknown>): Promise<void>;
  failure(lease: MutationLeaseInput, uncertain: boolean, terminal?: boolean): Promise<void>;
  recover(state: ProjectMutationState, fingerprint: string): Promise<void>;
  read(projectRef: string, mutationId: string): Promise<ProjectMutationState | null>;
}

export const projectReleaseMutations: ReleaseMutationStore = {
  begin: (input) => sql.begin(async (db) => {
    const begun = await beginProjectMutation(db, input);
    if (begun.kind !== "started" && begun.kind !== "replay") throw new ConflictError(`Release mutation ${begun.kind}`);
    if (["succeeded", "outcome_unknown", "failed_terminal"].includes(begun.mutation.status)) {
      return { state: begun.mutation };
    }
    const leaseToken = crypto.randomUUID();
    const claim = await claimOrResumeProjectMutation(db, {
      projectRef: input.projectRef, mutationId: input.mutationId,
      leaseOwner: `project-release-${process.pid}`, leaseToken, leaseSeconds: 3600,
    });
    if (claim.kind !== "claimed") throw new ConflictError("Release mutation is busy");
    return { state: claim.mutation, lease: {
      projectRef: input.projectRef, mutationId: input.mutationId,
      leaseToken, fencingEpoch: claim.mutation.fencingEpoch,
    } };
  }),
  protect: async (lease, action) => {
    const result = await sql.begin((db) => withProjectMutationLease(db, lease, action));
    if (result.kind !== "executed") throw new Error("Release mutation lease lost");
  },
  success: async (lease, receipt) => {
    const result = await sql.begin((db) => completeProjectMutationSuccess(db, { ...lease, receipt, responseStatus: 200 }));
    if (result !== "updated") throw new Error("Release success receipt lease lost");
  },
  failure: async (lease, uncertain, terminal) => {
    const result = await sql.begin((db) => completeProjectMutationFailure(db, {
      ...lease, status: uncertain ? "outcome_unknown" : terminal ? "failed_terminal" : "failed_retryable",
      failureCode: uncertain ? "RELEASE_OUTCOME_UNKNOWN" : "RELEASE_PREPARE_FAILED", responseStatus: 503,
    }));
    if (result !== "updated") throw new Error("Release failure receipt lease lost");
  },
  recover: async (state, fingerprint) => {
    const result = await sql.begin((db) => reconcileProjectMutation(db, state.principal, {
      projectRef: state.projectRef, mutationId: state.mutationId,
      expectedFencingEpoch: state.fencingEpoch, status: "succeeded", responseStatus: 200,
      evidence: {
        source: "project.release.authority", observedAt: new Date().toISOString(),
        evidenceCode: "RELEASE_AUTHORITY_CONFIRMED", evidenceFingerprint: fingerprint,
      },
    }));
    if (result.kind !== "updated") throw new Error("Release recovery receipt was not confirmed");
  },
  read: (projectRef, mutationId) => readProjectMutation({ projectRef, mutationId }),
};
