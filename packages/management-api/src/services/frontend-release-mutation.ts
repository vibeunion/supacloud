import type { SQL } from "bun";
import { sql } from "../db";
import {
  beginProjectMutation,
  claimRecoverableProjectMutations,
  checkpointProjectMutation,
  claimOrResumeProjectMutation,
  completeProjectMutationFailure,
  completeProjectMutationSuccess,
  readProjectMutation,
  readActiveProjectMutationForResource,
  withProjectMutationLease,
  type BeginProjectMutationInput,
  type BeginProjectMutationResult,
  type CheckpointProjectMutationInput,
  type ClaimProjectMutationInput,
  type ClaimProjectMutationResult,
  type CompleteProjectMutationFailureInput,
  type CompleteProjectMutationSuccessInput,
  type ProjectMutationState,
  type RecoverableProjectMutationClaim,
  type VerifyProjectMutationLeaseInput,
  type ProjectMutationLeaseExecution,
} from "./project-mutation.service";

export interface FrontendReleaseMutationStore {
  beginAndClaim(
    begin: BeginProjectMutationInput,
    claim: Omit<ClaimProjectMutationInput, "projectRef" | "mutationId"> & {
      initialCheckpoint?: Record<string, unknown>;
    },
  ): Promise<{ begun: BeginProjectMutationResult; claimed?: ClaimProjectMutationResult }>;
  checkpoint(input: CheckpointProjectMutationInput): Promise<"updated" | "lease_lost">;
  completeSuccess(input: CompleteProjectMutationSuccessInput): Promise<"updated" | "lease_lost">;
  completeFailure(input: CompleteProjectMutationFailureInput): Promise<"updated" | "lease_lost">;
  read(projectRef: string, mutationId: string): Promise<ProjectMutationState | null>;
  activeForDeployment(projectRef: string, deploymentId: string): Promise<ProjectMutationState | null>;
  withLease<T>(
    input: VerifyProjectMutationLeaseInput,
    operation: () => Promise<T>,
  ): Promise<ProjectMutationLeaseExecution<T>>;
}

export function frontendReleaseMutationStore(): FrontendReleaseMutationStore {
  const transaction = <T>(operation: (database: SQL) => Promise<T>) => sql.begin(operation);
  return {
    beginAndClaim: (begin, claim) => transaction(async (database) => {
      const begun = await beginProjectMutation(database, begin);
      if (begun.kind !== "started" && begun.kind !== "replay") return { begun };
      if (begun.kind === "replay" && ["succeeded", "failed_terminal", "outcome_unknown"].includes(
        begun.mutation.status,
      )) return { begun };
      const claimed = await claimOrResumeProjectMutation(database, {
        projectRef: begin.projectRef,
        mutationId: begin.mutationId,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        leaseSeconds: claim.leaseSeconds,
      });
      if (begun.kind !== "started" || claimed.kind !== "claimed") return { begun, claimed };
      if (!claim.initialCheckpoint) throw new Error("New frontend release mutation requires an initial checkpoint");
      const checkpointed = await checkpointProjectMutation(database, {
        projectRef: begin.projectRef,
        mutationId: begin.mutationId,
        leaseToken: claim.leaseToken,
        fencingEpoch: claimed.mutation.fencingEpoch,
        checkpoint: claim.initialCheckpoint,
        leaseSeconds: claim.leaseSeconds,
      });
      if (checkpointed !== "updated") throw new Error("New frontend release mutation lost its initial lease");
      return {
        begun,
        claimed: {
          ...claimed,
          mutation: { ...claimed.mutation, checkpoint: claim.initialCheckpoint },
        },
      };
    }),
    checkpoint: (input) => transaction((database) => checkpointProjectMutation(database, input)),
    completeSuccess: (input) => transaction((database) => completeProjectMutationSuccess(database, input)),
    completeFailure: (input) => transaction((database) => completeProjectMutationFailure(database, input)),
    read: (projectRef, mutationId) => readProjectMutation({ projectRef, mutationId }),
    activeForDeployment: (projectRef, deploymentId) => readActiveProjectMutationForResource(
      projectRef,
      { type: "frontend_release", id: deploymentId },
    ),
    withLease: (input, operation) => transaction((database) =>
      withProjectMutationLease(database, input, operation)),
  };
}

export function claimRecoverableFrontendReleases(
  leaseOwner: string,
  limit: number,
): Promise<RecoverableProjectMutationClaim[]> {
  return claimRecoverableProjectMutations({
    operations: ["frontend.release.activate"],
    leaseOwner,
    leaseSeconds: 300,
    limit,
  });
}

export async function hasUnresolvedFrontendReleaseActivations(): Promise<boolean> {
  const [row] = await sql`
    SELECT EXISTS (
      SELECT 1
      FROM project_mutations
      WHERE operation = 'frontend.release.activate'
        AND status IN ('pending', 'running', 'failed_retryable', 'outcome_unknown')
    ) AS unresolved
  ` as Array<{ unresolved: boolean }>;
  if (typeof row?.unresolved !== "boolean") {
    throw new Error("Frontend release recovery state could not be read");
  }
  return row.unresolved;
}
