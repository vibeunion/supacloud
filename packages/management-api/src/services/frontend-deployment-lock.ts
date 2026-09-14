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

interface DeploymentLockLease {
  active: boolean;
  pending: Set<Promise<unknown>>;
}

export function createFrontendDeploymentLock(
  pool: FrontendDeploymentLockPool = sql,
): FrontendDeploymentLock {
  const operationContext = new AsyncLocalStorage<ReadonlyMap<string, DeploymentLockLease>>();
  const deploymentTails = new Map<string, Promise<void>>();

  async function runWithSessionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const connection = await pool.reserve();
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
    let acquired = false;
    let unlocked = false;
    try {
      await connection`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
      acquired = true;
      const lease: DeploymentLockLease = { active: true, pending: new Set() };
      try {
        const context = new Map(operationContext.getStore());
        context.set(key, lease);
        outcome = { ok: true, value: await operationContext.run(context, operation) };
      } catch (error: unknown) {
        outcome = { ok: false, error };
      } finally {
        // Keep the session for nested work already admitted under this lease.
        while (lease.pending.size > 0) {
          const results = await Promise.allSettled([...lease.pending]);
          for (const result of results) {
            if (result.status === "rejected" && outcome?.ok) {
              outcome = { ok: false, error: result.reason };
            }
          }
        }
        lease.active = false;
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
    if (outcome && !outcome.ok) throw outcome.error;
    if (!unlocked) {
      logger.error("[frontend-deployment-lock] advisory unlock was not confirmed", { key });
      throw new FrontendDeploymentLockReleaseError();
    }
    if (!outcome) throw new Error("Missing deployment lock operation outcome");
    return outcome.value;
  }

  return async <T>(projectRef: string, deploymentId: string, operation: () => Promise<T>): Promise<T> => {
    const key = deploymentLockKey(projectRef, deploymentId);
    const lease = operationContext.getStore()?.get(key);
    if (lease?.active) {
      const nested = Promise.resolve().then(operation);
      lease.pending.add(nested);
      void nested.then(() => lease.pending.delete(nested), () => lease.pending.delete(nested));
      return nested;
    }
    const previous = deploymentTails.get(key)?.catch(() => undefined) ?? Promise.resolve();
    const current = Promise.withResolvers<void>();
    const tail = previous.then(() => current.promise);
    deploymentTails.set(key, tail);
    await previous;
    try {
      return await runWithSessionLock(key, operation);
    } finally {
      current.resolve();
      if (deploymentTails.get(key) === tail) deploymentTails.delete(key);
    }
  };
}

export const withFrontendDeploymentLock = createFrontendDeploymentLock();
