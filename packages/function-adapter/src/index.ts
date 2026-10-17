export type SupaCloudFunctionFramework = "fetch" | "elysia" | "hono" | "sveltekit-function";

export type SupaCloudFunctionHandler = (
  request: Request,
) => Response | Promise<Response>;

export type SupaCloudFunctionExport = {
  fetch: SupaCloudFunctionHandler;
  __supacloud: {
    framework: SupaCloudFunctionFramework;
    routeAware: true;
  };
};

/** Mark a Fetch handler as a route-aware SupaCloud Function adapter. */
export function createSupaCloudHandler(
  handler: SupaCloudFunctionHandler,
  framework: SupaCloudFunctionFramework = "fetch",
): SupaCloudFunctionExport {
  return {
    fetch: handler,
    __supacloud: { framework, routeAware: true },
  };
}

export { createSvelteKitHandler } from "./sveltekit";
export {
  constantTimeSecretMatches,
  createWorkerHttpHandler,
  type WorkerBatchRequest,
  type WorkerHttpErrorCodes,
  type WorkerHttpOptions,
} from "./worker-http";
export {
  createScheduledWorkerHttpHandler,
  type ScheduledWorkerHttpOptions,
} from "./scheduled-worker";
