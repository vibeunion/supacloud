import type { SQL } from "bun";
import { sql } from "../db";
import { AsyncLocalStorage } from "node:async_hooks";

const heldLocks = new AsyncLocalStorage<ReadonlyMap<string, { held: boolean }>>();

async function withLifecycleLock<T>(
  key: string, operation: () => Promise<T>, database: SQL,
): Promise<T> {
  const existing = heldLocks.getStore()?.get(key);
  if (existing?.held) return operation();
  const connection = await database.reserve();
  let acquired = false;
  const ownership = { held: false };
  try {
    const [row] = await connection<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked
    `;
    if (row?.locked !== true) throw new Error("APPLICATION_LIFECYCLE_BUSY");
    acquired = true;
    ownership.held = true;
    return await heldLocks.run(new Map([...(heldLocks.getStore() ?? []), [key, ownership]]), operation);
  } finally {
    ownership.held = false;
    try {
      if (acquired) await connection`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
    } finally {
      connection.release();
    }
  }
}

export function withApplicationProjectLifecycle<T>(
  projectRef: string, operation: () => Promise<T>, database: SQL = sql,
): Promise<T> {
  if (!/^[a-z0-9-]{1,20}$/.test(projectRef)) throw new Error("APPLICATION_LIFECYCLE_IDENTITY_INVALID");
  return withLifecycleLock(`supacloud:application-lifecycle:${projectRef}`, operation, database);
}

export function withApplicationPreviewLifecycle<T>(
  projectRef: string, previewId: string, operation: () => Promise<T>, database: SQL = sql,
): Promise<T> {
  if (!/^[a-z0-9-]{1,20}$/.test(projectRef) || !/^[a-f0-9-]{8,64}$/.test(previewId)) {
    throw new Error("APPLICATION_LIFECYCLE_IDENTITY_INVALID");
  }
  return withLifecycleLock(`supacloud:application-preview:${projectRef}:${previewId}`, operation, database);
}
