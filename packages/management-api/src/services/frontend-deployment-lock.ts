import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "../db";
import { logger } from "../utils/logger";

type ReservedControlSql = Awaited<ReturnType<typeof sql.reserve>>;

interface FrontendDeploymentLockPool {
  reserve(): Promise<ReservedControlSql>;
}

export type FrontendDeploymentLock = <T>(
  projectRef: string,
  deploymentId: string,
  operation: () => Promise<T>,
) => Promise<T>;

export class FrontendDeploymentLockReleaseError extends Error {
  readonly code = "FRONTEND_DEPLOYMENT_LOCK_RELEASE_FAILED" as const;

  constructor() {
    super("Frontend deployment lock release could not be proven");
    this.name = "FrontendDeploymentLockReleaseError";
  }
}

function deploymentLockKey(projectRef: string, deploymentId: string): string {
  return `supacloud:frontend-deployment:${projectRef}:${deploymentId}`;
}

export function createFrontendDeploymentLock(
  pool: FrontendDeploymentLockPool = sql,
): FrontendDeploymentLock {
  const operationContext = new AsyncLocalStorage<ReadonlySet<string>>();
  const deploymentTails = new Map<string, Promise<void>>();

  async function runWithSessionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const connection = await pool.reserve();
    let operationFailed = false;
    let operationError: unknown;
    let operationValue: T | undefined;
    let acquired = false;
    let unlocked = false;
    try {
      await connection`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
      acquired = true;
      try {
        operationValue = await operationContext.run(new Set([...(operationContext.getStore() ?? []), key]), operation);
      } catch (error: unknown) {
        operationFailed = true;
        operationError = error;
      }
      try {
        const [row] = await connection<{ unlocked: boolean }[]>`
          SELECT pg_advisory_unlock(hashtextextended(${key}, 0)) AS unlocked
        `;
        unlocked = row?.unlocked === true;
      } catch (error: unknown) {
        logger.error("[frontend-deployment-lock] advisory unlock failed", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (acquired && unlocked) {
        connection.release();
      } else {
        try {
          await connection.close({ timeout: 0 });
        } catch (error: unknown) {
          logger.error("[frontend-deployment-lock] failed to discard lock connection", {
            key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (operationFailed) throw operationError;
    if (!unlocked) {
      logger.error("[frontend-deployment-lock] advisory unlock was not confirmed", { key });
      throw new FrontendDeploymentLockReleaseError();
    }
    return operationValue as T;
  }

  return async <T>(projectRef: string, deploymentId: string, operation: () => Promise<T>): Promise<T> => {
    const key = deploymentLockKey(projectRef, deploymentId);
    if (operationContext.getStore()?.has(key)) return operation();
    const previous = deploymentTails.get(key)?.catch(() => undefined) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    deploymentTails.set(key, tail);
    await previous;
    try {
      return await runWithSessionLock(key, operation);
    } finally {
      release();
      if (deploymentTails.get(key) === tail) deploymentTails.delete(key);
    }
  };
}

export const withFrontendDeploymentLock = createFrontendDeploymentLock();
