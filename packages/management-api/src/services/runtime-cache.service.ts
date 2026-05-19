import { config } from "../config";
import { logger } from "../utils/logger";

function runtimeInternalHeaders(): Record<string, string> {
  return { "x-supacloud-internal-auth": config.edgeRuntimeMasterKey || config.masterToken };
}

export async function invalidateProjectRuntimeEnv(ref: string): Promise<boolean> {
  try {
    const runtimeUrl = `http://${config.edgeRuntimeInternal}`;
    const res = await fetch(`${runtimeUrl}/invalidate-env/${encodeURIComponent(ref)}`, {
      method: "POST",
      headers: runtimeInternalHeaders(),
      signal: AbortSignal.timeout(1000),
    });

    if (!res.ok) {
      logger.warn("[RuntimeCache] Runtime env invalidate failed", { ref, status: res.status });
      return false;
    }
    return true;
  } catch (error: unknown) {
    logger.warn("[RuntimeCache] Runtime env invalidate skipped", {
      ref,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export const runtimeCacheService = {
  invalidateProjectRuntimeEnv,
};
