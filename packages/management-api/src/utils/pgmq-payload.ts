import { PgmqPayloadTooLargeError } from "./pgmq-input";
import { readPgmqJson } from "./pgmq-message-id";

export const PGMQ_MESSAGE_BYTES = 1024 * 1024;
export const PGMQ_BATCH_BYTES = 8 * 1024 * 1024;
export const PGMQ_BATCH_NODES = 100000;

export interface PgmqPayloadBudget {
  remainingBytes: number;
  remainingNodes: number;
}

export function serializePgmqPayload(value: unknown, batch?: PgmqPayloadBudget): string {
  const budget = {
    remainingBytes: Math.min(PGMQ_MESSAGE_BYTES, batch?.remainingBytes ?? PGMQ_MESSAGE_BYTES),
    remainingNodes: batch?.remainingNodes ?? 10000,
  };
  const payload = JSON.stringify(readPgmqJson(value, budget));
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > PGMQ_MESSAGE_BYTES || (batch && bytes > batch.remainingBytes)) {
    throw new PgmqPayloadTooLargeError();
  }
  if (batch) {
    batch.remainingBytes -= bytes;
    batch.remainingNodes = budget.remainingNodes;
  }
  return payload;
}
