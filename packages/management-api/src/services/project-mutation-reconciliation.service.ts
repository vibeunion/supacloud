import { sql } from "../db";
import {
  appendAuditEventInTransaction,
  type AppendAuditEventInput,
} from "./audit.service";
import {
  reconcileProjectMutation,
  type MutationPrincipal,
  type ReconcileProjectMutationInput,
  type ReconcileProjectMutationResult,
} from "./project-mutation.service";

export interface ReconcileProjectMutationCommand {
  mutation: ReconcileProjectMutationInput;
  actor: MutationPrincipal;
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

function reconciliationAuditEvent(
  command: ReconcileProjectMutationCommand,
): AppendAuditEventInput {
  const mutation = command.mutation;
  return {
    projectRef: mutation.projectRef,
    actor: command.actor.id,
    actorType: command.actor.type,
    action: "project_mutation.reconciled",
    method: "POST",
    path: `/v1/projects/${mutation.projectRef}/mutations/${mutation.mutationId}/reconcile`,
    status: 200,
    ipAddress: command.ipAddress,
    userAgent: command.userAgent,
    requestId: command.requestId,
    metadata: {
      mutation_id: mutation.mutationId,
      target_status: mutation.status,
      fencing_epoch: mutation.expectedFencingEpoch,
    },
  };
}

export async function reconcileProjectMutationWithAudit(
  command: ReconcileProjectMutationCommand,
): Promise<ReconcileProjectMutationResult> {
  return sql.begin(async (transaction) => {
    const reconciliation = await reconcileProjectMutation(
      transaction,
      command.actor,
      command.mutation,
    );
    if (reconciliation.kind !== "updated") return reconciliation;
    await appendAuditEventInTransaction(transaction, reconciliationAuditEvent(command));
    return reconciliation;
  });
}
