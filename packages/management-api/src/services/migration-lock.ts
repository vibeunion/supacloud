import { sql } from "../db";
import { projectMigrationLockKey } from "./migration-promotion";
import { logger } from "../utils/logger";

type ReservedControlSql = Awaited<ReturnType<typeof sql.reserve>>;

export class ProjectMigrationLockError extends Error {
  readonly code = "migration_locked" as const;
  readonly httpStatus = 423 as const;

  constructor(readonly projectRef: string) {
    super(`Another migration or database operation is already running for ${projectRef}`);
    this.name = "ProjectMigrationLockError";
  }
}

interface MigrationLockInput {
  projectRefs: readonly string[];
}

function uniqueSortedRefs(input: MigrationLockInput): string[] {
  return [...new Set(input.projectRefs.filter(Boolean))].sort();
}

async function releaseLocks(connection: ReservedControlSql, refs: readonly string[]): Promise<void> {
  for (const projectRef of [...refs].reverse()) {
    try {
      const lockKey = projectMigrationLockKey(projectRef);
      await connection`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
    } catch (error: unknown) {
      logger.warn(`[migration-lock] failed to release lock for ${projectRef}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function withProjectMigrationLocks<T>(
  input: MigrationLockInput,
  operation: () => Promise<T>,
): Promise<T> {
  const refs = uniqueSortedRefs(input);
  if (refs.length === 0) throw new Error("At least one project ref is required for a migration lock");

  const connection = await sql.reserve();
  const acquired: string[] = [];
  try {
    for (const projectRef of refs) {
      const lockKey = projectMigrationLockKey(projectRef);
      const [row] = await connection<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS locked
      `;
      if (row?.locked !== true) throw new ProjectMigrationLockError(projectRef);
      acquired.push(projectRef);
    }
    return await operation();
  } finally {
    await releaseLocks(connection, acquired);
    connection.release();
  }
}
