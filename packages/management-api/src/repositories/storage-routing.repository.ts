import type { SQL } from "bun";
import { sql } from "../db";
import {
  assertStorageRoutingRef,
  parseStorageRoutingRows,
  StorageRoutingUnavailableError,
  type StorageRoutingProject,
} from "../utils/storage-routing-record";

export async function findStorageRoutingProject(
  ref: string, database: SQL = sql,
): Promise<StorageRoutingProject | null> {
  assertStorageRoutingRef(ref);
  try {
    const rows: unknown = await database`
      SELECT ref, status, deleted_at, config
      FROM projects
      WHERE ref = ${ref}
        AND deleted_at IS NULL
        AND lower(status) IN ('active', 'creating')
    `;
    return parseStorageRoutingRows(rows, ref)[0] ?? null;
  } catch {
    throw new StorageRoutingUnavailableError();
  }
}

export async function listStorageRoutingProjects(database: SQL = sql): Promise<StorageRoutingProject[]> {
  try {
    const rows: unknown = await database`
      SELECT ref, status, deleted_at, config
      FROM projects
      WHERE deleted_at IS NULL
        AND lower(status) IN ('active', 'creating')
    `;
    return parseStorageRoutingRows(rows);
  } catch {
    throw new StorageRoutingUnavailableError();
  }
}

export const storageRoutingRepository = {
  findByRef: findStorageRoutingProject,
  list: listStorageRoutingProjects,
};
