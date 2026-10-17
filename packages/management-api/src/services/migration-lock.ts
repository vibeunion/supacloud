import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "../db";
import { logger } from "../utils/logger";
import { projectDatabaseLockKey } from "./project-database-lock";

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

interface MigrationLockScope {
  refs: ReadonlySet<string>;
  active: boolean;
  pending: Set<Promise<unknown>>;
}

const lockScope = new AsyncLocalStorage<MigrationLockScope>();

function uniqueSortedRefs(input: MigrationLockInput): string[] {
  return [...new Set(input.projectRefs.filter(Boolean))].sort();
}

async function releaseLocks(connection: ReservedControlSql, refs: readonly string[]): Promise<void> {
  for (const projectRef of [...refs].reverse()) {
    try {
      const lockKey = projectDatabaseLockKey(projectRef);
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
  const inherited = lockScope.getStore();
  if (inherited?.active) {
    // 备份和迁移共用外层锁；禁止嵌套扩大锁集合，避免改变全局加锁顺序。
    if (refs.some(ref => !inherited.refs.has(ref))) {
      throw new Error("PROJECT_MIGRATION_NESTED_LOCK_SCOPE_MISMATCH");
    }
    const task = Promise.resolve().then(operation);
    inherited.pending.add(task);
    try { return await task; }
    finally { inherited.pending.delete(task); }
  }

  const connection = await sql.reserve();
  const acquired: string[] = [];
  const scope: MigrationLockScope = { refs: new Set(refs), active: true, pending: new Set() };
  try {
    for (const projectRef of refs) {
      const lockKey = projectDatabaseLockKey(projectRef);
      const [row] = await connection<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS locked
      `;
      if (row?.locked !== true) throw new ProjectMigrationLockError(projectRef);
      acquired.push(projectRef);
    }
    return await lockScope.run(scope, operation);
  } finally {
    // 即使调用者遗漏 await，也要等已进入的嵌套操作结束才能解锁。
    while (scope.pending.size > 0) await Promise.allSettled([...scope.pending]);
    scope.active = false;
    await releaseLocks(connection, acquired);
    connection.release();
  }
}
