import { getProjectDb, resolveDbName } from "../db";
import { withRetry } from "../utils/retry";

const QUEUE_TASK_TYPE_PREFIX = "queue:";

export interface PgmqMessage {
  id: string;
  msg_id: number;
  read_ct: number;
  enqueued_at: string | Date;
  vt: string | Date;
  message: Record<string, unknown>;
  payload: Record<string, unknown>;
  status: "pending" | "leased" | "archived" | "deleted";
  task_type: string;
}

export interface PgmqQueueInfo {
  queue_name: string;
  created_at: string | Date | null;
  is_partitioned: boolean;
  is_unlogged: boolean;
}

export interface PgmqQueueMetrics {
  queue_name: string;
  queue_length: number;
  newest_msg_age_sec: number | null;
  oldest_msg_age_sec: number | null;
  total_messages: number;
  scrape_time: string | Date;
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeMsgId(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function queueTableName(queueName: string, archived: boolean): string {
  return `pgmq.${quoteIdentifier(`${archived ? "a" : "q"}_${queueName}`)}`;
}

function mapMessage(queueName: string, row: Record<string, unknown>, status: PgmqMessage["status"]): PgmqMessage {
  const message = asJsonObject(row.message);
  const msgId = normalizeMsgId(row.msg_id);
  return {
    id: String(msgId),
    msg_id: msgId,
    read_ct: Number(row.read_ct || 0),
    enqueued_at: row.enqueued_at as string | Date,
    vt: row.vt as string | Date,
    message,
    payload: message,
    status,
    task_type: `${QUEUE_TASK_TYPE_PREFIX}${queueName}`,
  };
}

async function listMessages(
  projectRef: string,
  queueName: string,
  options: { archived?: boolean; limit?: number } = {},
): Promise<PgmqMessage[]> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit || 50)));
  const rows = await db.unsafe(
    `
      SELECT
        msg_id,
        read_ct,
        enqueued_at,
        vt,
        message,
        CASE
          WHEN $2::boolean THEN 'archived'
          WHEN vt > NOW() THEN 'leased'
          ELSE 'pending'
        END AS queue_status
      FROM ${queueTableName(queueName, Boolean(options.archived))}
      ORDER BY msg_id DESC
      LIMIT $1
    `,
    [limit, Boolean(options.archived)],
  );
  return (rows as Record<string, unknown>[]).map((row) =>
    mapMessage(queueName, row as Record<string, unknown>, String(row.queue_status) as PgmqMessage["status"])
  );
}

async function projectDb(projectRef: string) {
  return getProjectDb(await resolveDbName(projectRef));
}

async function ensurePgmq(projectRef: string): Promise<void> {
  const db = await projectDb(projectRef);
  await db`CREATE EXTENSION IF NOT EXISTS pgmq`;
}

async function createQueue(projectRef: string, queueName: string, options: { unlogged?: boolean } = {}): Promise<void> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  if (options.unlogged) {
    await db`SELECT pgmq.create_unlogged(${queueName})`;
  } else {
    await db`SELECT pgmq.create(${queueName})`;
  }
}

async function dropQueue(projectRef: string, queueName: string): Promise<boolean> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  const [row] = await db`SELECT pgmq.drop_queue(${queueName}) AS dropped`;
  return Boolean(row?.dropped);
}

async function listQueues(projectRef: string): Promise<PgmqQueueInfo[]> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  const rows = await db`SELECT * FROM pgmq.list_queues() ORDER BY queue_name`;
  return (rows as Record<string, unknown>[]).map((row) => ({
    queue_name: String(row.queue_name),
    created_at: row.created_at as string | Date | null,
    is_partitioned: Boolean(row.is_partitioned),
    is_unlogged: Boolean(row.is_unlogged),
  }));
}

async function send(projectRef: string, queueName: string, message: Record<string, unknown>, sleepSeconds = 0): Promise<number> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  const [row] = await db`
    SELECT * FROM pgmq.send(${queueName}, ${JSON.stringify(message)}::jsonb, ${sleepSeconds}) AS msg_id
  `;
  return normalizeMsgId(row?.msg_id ?? row?.send);
}

async function sendBatch(
  projectRef: string,
  queueName: string,
  messages: Record<string, unknown>[],
  sleepSeconds = 0,
): Promise<number[]> {
  await ensurePgmq(projectRef);
  if (messages.length === 0) return [];
  const db = await projectDb(projectRef);
  const values = messages.map((message) => JSON.stringify(message));
  const params: unknown[] = [queueName, ...values, sleepSeconds];
  const messagePlaceholders = values.map((_, index) => `$${index + 2}::jsonb`).join(", ");
  const delayIndex = values.length + 2;
  const rows = await db.unsafe(
    `SELECT * FROM pgmq.send_batch($1, ARRAY[${messagePlaceholders}]::jsonb[], $${delayIndex}) AS msg_id`,
    params,
  );
  return (rows as Record<string, unknown>[]).map((row) => normalizeMsgId(row.msg_id ?? row.send_batch));
}

async function read(projectRef: string, queueName: string, sleepSeconds: number, count: number): Promise<PgmqMessage[]> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  const rows = await db`SELECT * FROM pgmq.read(${queueName}, ${sleepSeconds}, ${count})`;
  return (rows as Record<string, unknown>[]).map((row) => mapMessage(queueName, row, "leased"));
}

async function pop(projectRef: string, queueName: string): Promise<PgmqMessage | null> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  const rows = await db`SELECT * FROM pgmq.pop(${queueName})`;
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? mapMessage(queueName, row, "deleted") : null;
}

async function archive(projectRef: string, queueName: string, messageId: number): Promise<boolean> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  const [row] = await db`SELECT pgmq.archive(${queueName}, ${messageId}) AS archived`;
  return Boolean(row?.archived);
}

async function deleteMessage(projectRef: string, queueName: string, messageId: number): Promise<boolean> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  const [row] = await db`SELECT pgmq.delete(${queueName}, ${messageId}) AS deleted`;
  return Boolean(row?.deleted);
}

async function setVisibilityTimeout(
  projectRef: string,
  queueName: string,
  messageId: number,
  sleepSeconds: number,
): Promise<PgmqMessage | null> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  const rows = await db`SELECT * FROM pgmq.set_vt(${queueName}, ${messageId}, ${sleepSeconds})`;
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? mapMessage(queueName, row, "leased") : null;
}

async function purge(projectRef: string, queueName: string): Promise<number> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  const [row] = await db`SELECT pgmq.purge_queue(${queueName}) AS purged`;
  return Number(row?.purged || 0);
}

async function metrics(projectRef: string, queueName: string): Promise<PgmqQueueMetrics | null> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  const [row] = await db`SELECT * FROM pgmq.metrics(${queueName})`;
  if (!row) return null;
  return {
    queue_name: String(row.queue_name),
    queue_length: Number(row.queue_length || 0),
    newest_msg_age_sec: row.newest_msg_age_sec == null ? null : Number(row.newest_msg_age_sec),
    oldest_msg_age_sec: row.oldest_msg_age_sec == null ? null : Number(row.oldest_msg_age_sec),
    total_messages: Number(row.total_messages || 0),
    scrape_time: row.scrape_time as string | Date,
  };
}

async function metricsAll(projectRef: string): Promise<PgmqQueueMetrics[]> {
  await ensurePgmq(projectRef);
  const db = await projectDb(projectRef);
  const rows = await db`SELECT * FROM pgmq.metrics_all() ORDER BY queue_name`;
  return (rows as Record<string, unknown>[]).map((row) => ({
    queue_name: String(row.queue_name),
    queue_length: Number(row.queue_length || 0),
    newest_msg_age_sec: row.newest_msg_age_sec == null ? null : Number(row.newest_msg_age_sec),
    oldest_msg_age_sec: row.oldest_msg_age_sec == null ? null : Number(row.oldest_msg_age_sec),
    total_messages: Number(row.total_messages || 0),
    scrape_time: row.scrape_time as string | Date,
  }));
}

export const pgmqService = {
  createQueue: (projectRef: string, queueName: string, options?: { unlogged?: boolean }) =>
    createQueue(projectRef, queueName, options),
  dropQueue: (projectRef: string, queueName: string) =>
    dropQueue(projectRef, queueName),
  listQueues: (projectRef: string) =>
    withRetry("PgmqService.listQueues", () => listQueues(projectRef)),
  listMessages: (projectRef: string, queueName: string, options?: { archived?: boolean; limit?: number }) =>
    withRetry("PgmqService.listMessages", () => listMessages(projectRef, queueName, options)),
  send: (projectRef: string, queueName: string, message: Record<string, unknown>, sleepSeconds?: number) =>
    send(projectRef, queueName, message, sleepSeconds),
  sendBatch: (projectRef: string, queueName: string, messages: Record<string, unknown>[], sleepSeconds?: number) =>
    sendBatch(projectRef, queueName, messages, sleepSeconds),
  read: (projectRef: string, queueName: string, sleepSeconds: number, count: number) =>
    read(projectRef, queueName, sleepSeconds, count),
  pop: (projectRef: string, queueName: string) =>
    pop(projectRef, queueName),
  archive: (projectRef: string, queueName: string, messageId: number) =>
    archive(projectRef, queueName, messageId),
  deleteMessage: (projectRef: string, queueName: string, messageId: number) =>
    deleteMessage(projectRef, queueName, messageId),
  setVisibilityTimeout: (projectRef: string, queueName: string, messageId: number, sleepSeconds: number) =>
    setVisibilityTimeout(projectRef, queueName, messageId, sleepSeconds),
  purge: (projectRef: string, queueName: string) =>
    purge(projectRef, queueName),
  metrics: (projectRef: string, queueName: string) =>
    withRetry("PgmqService.metrics", () => metrics(projectRef, queueName)),
  metricsAll: (projectRef: string) =>
    withRetry("PgmqService.metricsAll", () => metricsAll(projectRef)),
};
