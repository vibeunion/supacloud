import type { SQL, TransactionSQL } from "bun";

export type AdmissionDecision<T> =
  | { replay: true; value: T }
  | { replay: false; value: T; idempotencyKey: string; input: unknown };

export class AdmissionError extends Error {
  readonly retryAfterSeconds = 1;
  constructor(readonly code: string) { super(code); }
}

/** The callback must authorize and persist intent using ONLY this short transaction. */
export async function submitBoundedTask<T>(
  sql: SQL,
  binding: { projectRef: string; queueName: string; taskKey: string },
  prepare: (transaction: TransactionSQL) => Promise<AdmissionDecision<T>>,
): Promise<{ value: T; messageId: string | null; replay: boolean }> {
  try {
    return await sql.begin("isolation level read committed", async tx => {
      await tx`SET LOCAL lock_timeout = '2s'`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      const decision = await prepare(tx);
      if (decision.replay) return { value: decision.value, messageId: null, replay: true };
      const input = JSON.stringify(decision.input);
      if (input === undefined || Buffer.byteLength(input) > 65536)
        throw new AdmissionError("WORKER_PAYLOAD_TOO_LARGE");
      const [row] = await tx<{ id: string }[]>`
        SELECT supacloud_worker.enqueue_bounded(${binding.projectRef},${binding.queueName},
          ${binding.taskKey},${decision.idempotencyKey},${input}::text::jsonb) AS id`;
      if (!row || !/^[1-9][0-9]*$/.test(row.id)) throw new AdmissionError("WORKER_ADMISSION_FAILED");
      return { value: decision.value, messageId: row.id, replay: false };
    });
  } catch (error) {
    if (error instanceof AdmissionError) throw error;
    if (error instanceof Error && [
      "WORKER_ADMISSION_INVALID", "WORKER_ADMISSION_NOT_CONFIGURED", "WORKER_PAYLOAD_TOO_LARGE",
      "WORKER_QUEUE_FULL", "WORKER_PROJECT_FULL", "WORKER_RATE_LIMITED",
    ].includes(error.message)) throw new AdmissionError(error.message);
    // Do not echo SQL, connection strings or driver diagnostics through the business API.
    throw new AdmissionError("WORKER_ADMISSION_FAILED");
  }
}
