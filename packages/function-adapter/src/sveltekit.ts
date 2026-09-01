import { createSupaCloudHandler, type SupaCloudFunctionExport } from "./index";

export type SvelteKitRespond = (
  request: Request,
  options: {
    platform?: unknown;
    getClientAddress?: () => string;
  },
) => Response | Promise<Response>;

export type SvelteKitHandlerOptions = {
  respond: SvelteKitRespond;
  platform?: unknown;
  getClientAddress?: (request: Request) => string;
};

/**
 * Bridge a SvelteKit server `respond` function to SupaCloud's Fetch contract.
 * This intentionally does not start a listener or serve static assets.
 */
export function createSvelteKitHandler(
  options: SvelteKitHandlerOptions,
): SupaCloudFunctionExport {
  return createSupaCloudHandler(
    (request) => options.respond(request, {
      platform: options.platform,
      getClientAddress: () => options.getClientAddress?.(request) ?? "0.0.0.0",
    }),
    "sveltekit-function",
  );
}
