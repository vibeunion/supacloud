export interface WorkerTransaction {
  query(text: string, parameters?: readonly (string | number | boolean | null)[]): Promise<unknown>;
}
export interface WorkerAdmission {
  projectRef: string;
  group: string;
  operationId: string;
}

function parameters(binding: WorkerAdmission) {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(binding.projectRef)
    || !/^[a-z][a-z0-9-]{0,47}$/.test(binding.group)
    || !/^[A-Za-z0-9_.:@/-]{1,200}$/.test(binding.operationId)) {
    throw new Error("WORKER_ADMISSION_INVALID");
  }
  return [binding.projectRef, binding.group, binding.operationId];
}

/** Call inside the same transaction as domain intent and durable queue/outbox submission. */
export async function admitWorkerOperation(
  transaction: WorkerTransaction, binding: WorkerAdmission, fingerprint: string,
): Promise<{ admitted: boolean }> {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("WORKER_ADMISSION_INVALID");
  const rows = await transaction.query(
    "SELECT supacloud_worker.admit_operation($1,$2,$3,$4) AS admitted", [...parameters(binding), fingerprint],
  );
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object"
    || !("admitted" in rows[0]) || typeof rows[0].admitted !== "boolean") {
    throw new Error("WORKER_ADMISSION_RESULT_INVALID");
  }
  return { admitted: rows[0].admitted };
}

/** Unknown, pending and cancellation-requested outcomes must retain their token. */
export async function releaseWorkerOperation(
  transaction: WorkerTransaction, binding: WorkerAdmission,
  terminal: (transaction: WorkerTransaction) => Promise<"succeeded" | "failed" | "cancelled" | "unknown" | "pending">,
): Promise<void> {
  const args = parameters(binding);
  const state = await terminal(transaction);
  if (!["succeeded", "failed", "cancelled"].includes(state)) throw new Error("WORKER_OPERATION_NOT_TERMINAL");
  await transaction.query("SELECT supacloud_worker.release_operation($1,$2,$3)", args);
}

/** Operator/compatibility check. Pause admission first; never delete or move an old queue here. */
export async function requireDrainedWorkerGroup(transaction: WorkerTransaction, projectRef: string, group: string, queue: string) {
  parameters({ projectRef, group, operationId: "drain" });
  if (!/^scw_[a-z0-9_]{1,40}$/.test(queue)) throw new Error("WORKER_ADMISSION_INVALID");
  const result = await transaction.query(`SELECT l.accepting,l.outstanding,
    (SELECT count(*)::integer FROM supacloud_worker.admission_tokens t
      WHERE t.group_name=l.group_name AND NOT t.released) AS held,
    (SELECT queue_length FROM pgmq.metrics($3)) AS queued
    FROM supacloud_worker.admission_limits l
    WHERE l.group_name=$2 AND EXISTS(SELECT FROM supacloud_worker.installation WHERE singleton AND project_ref=$1)
    FOR UPDATE OF l`, [projectRef, group, queue]);
  const zero = (value: unknown) => value === 0 || value === "0" || value === 0n;
  if (!Array.isArray(result) || result.length !== 1 || !result[0] || typeof result[0] !== "object"
    || result[0].accepting !== false || !zero(result[0].outstanding)
    || !zero(result[0].held) || !zero(result[0].queued)) {
    throw new Error("WORKER_GROUP_NOT_DRAINED");
  }
}
