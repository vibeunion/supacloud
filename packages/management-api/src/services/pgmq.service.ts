import { getProjectDb } from "../db";
import { projectRepository } from "../repositories/project.repository";
import { PgmqProjectContextError, pgmqProjectRef, readPgmqProjectDatabase } from "../utils/pgmq-project";
import { withRetry } from "../utils/retry";
import { pgmqCreateOptions, pgmqInteger, pgmqListOptions, pgmqSeconds } from "../utils/pgmq-input";
import { capturePgmqBatch } from "../utils/pgmq-batch";
import { serializePgmqPayload } from "../utils/pgmq-payload";
import { PgmqMutationError } from "../utils/pgmq-mutation";
import {
  assertPublicPgmqQueueName, PgmqInventoryError, readPgmqDropReceipt,
  readPgmqMetrics, readPgmqMetricsAll, readPgmqPurgeReceipt, readPgmqQueueInfo,
  type PgmqQueueInfo, type PgmqQueueMetrics,
} from "../utils/pgmq-inventory";
export { isPublicPgmqQueueName, type PgmqQueueInfo, type PgmqQueueMetrics } from "../utils/pgmq-inventory";
import {
  parsePgmqMessageId, readPgmqIdReceipt, readPgmqIdReceipts, readPgmqJson,
  readPgmqMessageRows, readPgmqTimestamp, readPgmqBooleanReceipt, type PgmqJson,
} from "../utils/pgmq-message-id";

const QUEUE_TASK_TYPE_PREFIX = "queue:";
export interface PgmqMessage {
  id: string;
  msg_id: string;
  read_ct: number;
  enqueued_at: string | Date;
  vt: string | Date;
  message: PgmqJson;
  payload: PgmqJson;
  status: "pending" | "leased" | "archived" | "deleted";
  task_type: string;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function queueTableName(queueName: string, archived: boolean): string {
  return `pgmq.${quoteIdentifier(`${archived ? "a" : "q"}_${queueName}`)}`;
}

function mapMessage(queueName: string, row: Record<string, unknown>, status: PgmqMessage["status"]): PgmqMessage {
  const message = readPgmqJson(row.message);
  const msgId = parsePgmqMessageId(row.msg_id);
  if (typeof row.read_ct !== "number" || !Number.isSafeInteger(row.read_ct) || row.read_ct < 0) {
    throw new Error("Invalid PGMQ message read count");
  }
  return {
    id: String(msgId),
    msg_id: msgId,
    read_ct: row.read_ct,
    enqueued_at: readPgmqTimestamp(row.enqueued_at),
    vt: readPgmqTimestamp(row.vt),
    message,
    payload: message,
    status,
    task_type: `${QUEUE_TASK_TYPE_PREFIX}${queueName}`,
  };
}

async function listMessages(
  projectRef: string,
  queueName: string,
  options: ReturnType<typeof pgmqListOptions>,
): Promise<PgmqMessage[]> {
  assertPublicPgmqQueueName(queueName);
  const { limit, archived } = options;
  const db = await prepareProjectDb(projectRef);
  const rows: unknown = await db.unsafe(
    `
      SELECT
        q.msg_id::text AS msg_id,
        read_ct,
        enqueued_at,
        vt,
        message,
        CASE
          WHEN $2::boolean THEN 'archived'
          WHEN vt > NOW() THEN 'leased'
          ELSE 'pending'
        END AS queue_status
      FROM ${queueTableName(queueName, archived)} AS q
      ORDER BY q.msg_id DESC
      LIMIT $1
    `,
    [limit, archived],
  );
  return readPgmqMessageRows(rows, limit).map(row => {
    const state = row.queue_status;
    if (state !== "pending" && state !== "leased" && state !== "archived") throw new Error("Invalid PGMQ queue status");
    if (archived !== (state === "archived")) throw new Error("Mismatched PGMQ archive status");
    return mapMessage(queueName, row, state);
  });
}

async function prepareProjectDb(projectRef: string) {
  pgmqProjectRef(projectRef);
  let database: string;
  try {
    const project: unknown = await projectRepository.findByRef(projectRef);
    database = readPgmqProjectDatabase(project, projectRef);
  } catch {
    throw new PgmqProjectContextError();
  }
  // One validated mapping and connection are used for setup and the operation.
  const db = getProjectDb(database);
  await db`CREATE EXTENSION IF NOT EXISTS pgmq`;
  return db;
}

async function createQueue(projectRef: string, queueName: string, options: { unlogged?: boolean } = {}): Promise<void> {
  assertPublicPgmqQueueName(queueName);
  const { unlogged } = pgmqCreateOptions(options);
  const db = await prepareProjectDb(projectRef);
  try {
    if (unlogged) {
      await db`SELECT pgmq.create_unlogged(${queueName})`;
    } else {
      await db`SELECT pgmq.create(${queueName})`;
    }
    const rows: unknown = await db`
      SELECT queue_name, created_at, is_partitioned, is_unlogged
      FROM pgmq.list_queues() WHERE queue_name = ${queueName}
    `;
    const queues = readPgmqQueueInfo(rows);
    const queue = queues[0];
    if (queues.length !== 1 || !queue || queue.queue_name !== queueName
      || queue.is_unlogged !== unlogged || queue.is_partitioned) {
      throw new PgmqMutationError();
    }
  } catch {
    throw new PgmqMutationError();
  }
}

async function dropQueue(projectRef: string, queueName: string): Promise<boolean> {
  assertPublicPgmqQueueName(queueName);
  const db = await prepareProjectDb(projectRef);
  try {
    const rows: unknown = await db`SELECT pgmq.drop_queue(${queueName}) AS dropped`;
    return readPgmqDropReceipt(rows);
  } catch {
    throw new PgmqInventoryError(true);
  }
}

async function listQueues(projectRef: string): Promise<PgmqQueueInfo[]> {
  const db = await prepareProjectDb(projectRef);
  const rows: unknown = await db`
    SELECT queue_name, created_at, is_partitioned, is_unlogged FROM pgmq.list_queues() ORDER BY queue_name
  `;
  return readPgmqQueueInfo(rows);
}

async function send(projectRef: string, queueName: string, message: Record<string, unknown>, sleepSeconds = 0): Promise<string> {
  assertPublicPgmqQueueName(queueName);
  const seconds = pgmqSeconds(sleepSeconds);
  const payload = serializePgmqPayload(message);
  const db = await prepareProjectDb(projectRef);
  try {
    const rows: unknown = await db`
      SELECT sent.msg_id::text AS msg_id
      FROM pgmq.send(${queueName}, ${payload}::text::jsonb, ${seconds}) AS sent(msg_id)
    `;
    return readPgmqIdReceipt(rows);
  } catch {
    throw new PgmqMutationError();
  }
}

async function sendBatch(
  projectRef: string,
  queueName: string,
  messages: Record<string, unknown>[],
  sleepSeconds = 0,
): Promise<string[]> {
  assertPublicPgmqQueueName(queueName);
  const seconds = pgmqSeconds(sleepSeconds);
  const values = capturePgmqBatch(messages);
  if (values.length === 0) return [];
  const db = await prepareProjectDb(projectRef);
  const params: unknown[] = [queueName, ...values, seconds];
  const messagePlaceholders = values.map((_, index) => `$${index + 2}::text::jsonb`).join(", ");
  const delayIndex = values.length + 2;
  try {
    const rows: unknown = await db.unsafe(
      `SELECT sent.msg_id::text AS msg_id FROM pgmq.send_batch($1, ARRAY[${messagePlaceholders}]::jsonb[], $${delayIndex}) AS sent(msg_id)`,
      params,
    );
    return readPgmqIdReceipts(rows, values.length);
  } catch {
    throw new PgmqMutationError();
  }
}

async function read(projectRef: string, queueName: string, sleepSeconds: number, count: number): Promise<PgmqMessage[]> {
  assertPublicPgmqQueueName(queueName);
  const seconds = pgmqSeconds(sleepSeconds);
  const quantity = pgmqInteger(count, 1, 10000);
  const db = await prepareProjectDb(projectRef);
  try {
    const rows: unknown = await db`
      SELECT msg_id::text AS msg_id, read_ct, enqueued_at, vt, message
      FROM pgmq.read(${queueName}, ${seconds}, ${quantity})
    `;
    return readPgmqMessageRows(rows, quantity).map(row => mapMessage(queueName, row, "leased"));
  } catch {
    throw new PgmqMutationError();
  }
}

async function pop(projectRef: string, queueName: string): Promise<PgmqMessage | null> {
  assertPublicPgmqQueueName(queueName);
  const db = await prepareProjectDb(projectRef);
  try {
    const rows: unknown = await db`
      SELECT msg_id::text AS msg_id, read_ct, enqueued_at, vt, message FROM pgmq.pop(${queueName})
    `;
    const row = readPgmqMessageRows(rows, 1)[0];
    return row ? mapMessage(queueName, row, "deleted") : null;
  } catch {
    throw new PgmqMutationError();
  }
}

async function archive(projectRef: string, queueName: string, messageId: string | number): Promise<boolean> {
  assertPublicPgmqQueueName(queueName);
  const id = parsePgmqMessageId(messageId);
  const db = await prepareProjectDb(projectRef);
  try {
    const rows: unknown = await db`SELECT pgmq.archive(${queueName}, ${id}::bigint) AS archived`;
    return readPgmqBooleanReceipt(rows, "archived");
  } catch {
    throw new PgmqMutationError();
  }
}

async function deleteMessage(projectRef: string, queueName: string, messageId: string | number): Promise<boolean> {
  assertPublicPgmqQueueName(queueName);
  const id = parsePgmqMessageId(messageId);
  const db = await prepareProjectDb(projectRef);
  try {
    const rows: unknown = await db`SELECT pgmq.delete(${queueName}, ${id}::bigint) AS deleted`;
    return readPgmqBooleanReceipt(rows, "deleted");
  } catch {
    throw new PgmqMutationError();
  }
}

async function setVisibilityTimeout(
  projectRef: string,
  queueName: string,
  messageId: string | number,
  sleepSeconds: number,
): Promise<PgmqMessage | null> {
  assertPublicPgmqQueueName(queueName);
  const id = parsePgmqMessageId(messageId);
  const seconds = pgmqSeconds(sleepSeconds);
  const db = await prepareProjectDb(projectRef);
  try {
    const rows: unknown = await db`
      SELECT msg_id::text AS msg_id, read_ct, enqueued_at, vt, message
      FROM pgmq.set_vt(${queueName}, ${id}::bigint, ${seconds})
    `;
    const row = readPgmqMessageRows(rows, 1)[0];
    if (row && row.msg_id !== id) throw new Error("Mismatched PGMQ visibility receipt");
    return row ? mapMessage(queueName, row, "leased") : null;
  } catch {
    throw new PgmqMutationError();
  }
}

async function purge(projectRef: string, queueName: string): Promise<number> {
  assertPublicPgmqQueueName(queueName);
  const db = await prepareProjectDb(projectRef);
  try {
    const rows: unknown = await db`SELECT pgmq.purge_queue(${queueName})::text AS purged`;
    return readPgmqPurgeReceipt(rows);
  } catch {
    throw new PgmqInventoryError(true);
  }
}

async function metrics(projectRef: string, queueName: string): Promise<PgmqQueueMetrics | null> {
  assertPublicPgmqQueueName(queueName);
  const db = await prepareProjectDb(projectRef);
  const rows: unknown = await db`
    SELECT queue_name, queue_length::text AS queue_length, total_messages::text AS total_messages,
      newest_msg_age_sec::text AS newest_msg_age_sec, oldest_msg_age_sec::text AS oldest_msg_age_sec, scrape_time
    FROM pgmq.metrics(${queueName})
  `;
  return readPgmqMetrics(rows, queueName);
}

async function metricsAll(projectRef: string): Promise<PgmqQueueMetrics[]> {
  const db = await prepareProjectDb(projectRef);
  const rows: unknown = await db`
    SELECT queue_name, queue_length::text AS queue_length, total_messages::text AS total_messages,
      newest_msg_age_sec::text AS newest_msg_age_sec, oldest_msg_age_sec::text AS oldest_msg_age_sec, scrape_time
    FROM pgmq.metrics_all() ORDER BY queue_name
  `;
  return readPgmqMetricsAll(rows);
}

export const pgmqService = {
  createQueue: (projectRef: string, queueName: string, options?: { unlogged?: boolean }) =>
    createQueue(projectRef, queueName, options),
  dropQueue: (projectRef: string, queueName: string) =>
    dropQueue(projectRef, queueName),
  listQueues: (projectRef: string) =>
    withRetry("PgmqService.listQueues", () => listQueues(projectRef), {
      shouldRetry: error => !(error instanceof PgmqInventoryError || error instanceof PgmqProjectContextError),
    }),
  listMessages: async (projectRef: string, queueName: string, options?: { archived?: boolean; limit?: number }) => {
    const captured = pgmqListOptions(options);
    return withRetry("PgmqService.listMessages", () => listMessages(projectRef, queueName, captured), {
      shouldRetry: error => !(error instanceof PgmqInventoryError || error instanceof PgmqProjectContextError),
    });
  },
  send: (projectRef: string, queueName: string, message: Record<string, unknown>, sleepSeconds?: number) =>
    send(projectRef, queueName, message, sleepSeconds),
  sendBatch: (projectRef: string, queueName: string, messages: Record<string, unknown>[], sleepSeconds?: number) =>
    sendBatch(projectRef, queueName, messages, sleepSeconds),
  read: (projectRef: string, queueName: string, sleepSeconds: number, count: number) =>
    read(projectRef, queueName, sleepSeconds, count),
  pop: (projectRef: string, queueName: string) =>
    pop(projectRef, queueName),
  archive: (projectRef: string, queueName: string, messageId: string | number) =>
    archive(projectRef, queueName, messageId),
  deleteMessage: (projectRef: string, queueName: string, messageId: string | number) =>
    deleteMessage(projectRef, queueName, messageId),
  setVisibilityTimeout: (projectRef: string, queueName: string, messageId: string | number, sleepSeconds: number) =>
    setVisibilityTimeout(projectRef, queueName, messageId, sleepSeconds),
  purge: (projectRef: string, queueName: string) =>
    purge(projectRef, queueName),
  metrics: (projectRef: string, queueName: string) =>
    withRetry("PgmqService.metrics", () => metrics(projectRef, queueName), {
      shouldRetry: error => !(error instanceof PgmqInventoryError || error instanceof PgmqProjectContextError),
    }),
  metricsAll: (projectRef: string) =>
    withRetry("PgmqService.metricsAll", () => metricsAll(projectRef), {
      shouldRetry: error => !(error instanceof PgmqInventoryError || error instanceof PgmqProjectContextError),
    }),
};
