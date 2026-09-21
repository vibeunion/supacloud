import type { SQL } from "bun";
import { sql } from "../db";
import { readPgmqJson } from "../utils/pgmq-message-id";
import { PgmqSettingsError } from "../utils/pgmq-settings";

async function compareAndUpdate(
  ref: string,
  projectId: string,
  expected: Record<string, unknown>,
  queues: Record<string, unknown>,
  database: SQL = sql,
): Promise<unknown | null> {
  const expectedJson = readPgmqJson(expected);
  const queuesJson = readPgmqJson(queues);
  // Do not retry: after a lost response the write may already have committed.
  const rows: unknown = await database`
    UPDATE projects
    SET config = jsonb_set(config, '{queue_settings}', ${queuesJson}::jsonb, true),
        updated_at = NOW()
    WHERE ref = ${ref} AND id = ${projectId} AND deleted_at IS NULL
      AND config = ${expectedJson}::jsonb
    RETURNING id, ref, deleted_at, config
  `;
  if (!Array.isArray(rows) || rows.length > 1) throw new PgmqSettingsError(true);
  if (rows.length === 0) return null;
  const row: unknown = rows[0];
  if (row === null || typeof row !== "object" || Array.isArray(row)) throw new PgmqSettingsError(true);
  return row;
}

export const pgmqSettingsRepository = { compareAndUpdate };
