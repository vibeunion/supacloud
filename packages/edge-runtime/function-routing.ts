/**
 * Function URL routing rules shared by the Edge Runtime and SupaCloud Lite.
 * Both runtimes pin their behavior to the same parity vectors:
 * packages/supacloud-lite/parity/function-routing.vectors.json
 */

export type FrameworkRouterHandler = Record<string, unknown> & {
  routes: unknown[];
};

/** Router objects and marked handlers own the path below /functions/v1/<name>. */
export function isFrameworkRouterHandler(handler: unknown): handler is FrameworkRouterHandler {
  if (!handler || typeof handler !== "object") return false;
  const candidate = handler as Record<string, unknown>;
  const metadata = candidate.__supacloud as Record<string, unknown> | undefined;
  return metadata?.routeAware === true
    || Array.isArray(candidate.routes)
    && (typeof candidate.handle === "function" || typeof candidate.fetch === "function");
}

/**
 * Strip the function prefix so framework routers see their own route table:
 * /functions/v1/<name>/a/b -> /a/b (and /functions/v1/<name> -> /).
 */
export function toFunctionLocalUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  const publicRoute = url.pathname.match(/^\/functions\/v1\/[^/]+(\/.*)?$/);
  if (publicRoute) {
    url.pathname = publicRoute[1] || "/";
    return url.toString();
  }

  const internalRoute = url.pathname.match(/^\/[^/]+(\/.*)?$/);
  if (internalRoute) {
    url.pathname = internalRoute[1] || "/";
  }
  return url.toString();
}
