import { Elysia } from "elysia";
import { config } from "../config";
import { checkAuth } from "../middleware/auth";
import { logger } from "../utils/logger";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// `fetch()` may transparently decode an upstream response. Forwarding the
// original encoding or length after that transformation makes browsers decode
// an already-decoded body, resulting in ERR_CONTENT_DECODING_FAILED.
const REPRESENTATION_HEADERS = new Set(["content-encoding", "content-length"]);

function buildGrafanaTargetUrl(requestUrl: string): URL {
  const source = new URL(requestUrl);
  const target = new URL(config.grafanaUrl);
  const basePath = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
  const strippedPath = source.pathname.replace(/^\/grafana(?=\/|$)/, "") || "/";
  target.pathname = `${basePath}${strippedPath.startsWith("/") ? strippedPath : `/${strippedPath}`}`;
  target.search = source.search;
  return target;
}

function buildProxyHeaders(request: Request, target: URL): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  headers.set("host", target.host);
  // Request a representation that can safely travel through the Bun fetch
  // proxy without relying on its upstream decompression behaviour.
  headers.set("accept-encoding", "identity");
  headers.set("x-forwarded-host", new URL(request.url).host);
  headers.set("x-forwarded-proto", new URL(request.url).protocol.replace(":", ""));
  return headers;
}

function buildResponseHeaders(upstreamHeaders: Headers, target: URL): Headers {
  const headers = new Headers();
  for (const [key, value] of upstreamHeaders) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || REPRESENTATION_HEADERS.has(lower)) continue;

    if (lower === "location") {
      try {
        const location = new URL(value, target);
        if (location.origin === target.origin) {
          const basePath = new URL(config.grafanaUrl).pathname.replace(/\/$/, "");
          const relativePath = location.pathname.startsWith(basePath)
            ? location.pathname.slice(basePath.length) || "/"
            : location.pathname;
          headers.set(key, `/grafana${relativePath}${location.search}${location.hash}`);
          continue;
        }
      } catch {
        // Preserve non-URL Location values as-is.
      }
    }

    headers.append(key, value);
  }
  return headers;
}

async function proxyGrafana(request: Request): Promise<Response> {
  const target = buildGrafanaTargetUrl(request.url);
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: buildProxyHeaders(request, target),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: buildResponseHeaders(upstream.headers, target),
    });
  } catch (error: unknown) {
    logger.warn("[GrafanaProxy] upstream unavailable", {
      target: target.origin,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Grafana upstream unavailable", { status: 502 });
  }
}

const handler = async ({ request, set }: { request: Request; set: { status?: number | string } }) => {
  const authError = await checkAuth(request);
  if (authError) {
    set.status = authError.status;
    return authError.body;
  }

  return proxyGrafana(request);
};

// Handle a Grafana request from the SPA static-asset catch-all. The wildcard
// `get("*")` in `registerStaticAssets` takes precedence over plugin routes in
// Elysia, so Grafana GET requests must be delegated here instead of relying on
// `.all("/grafana/*")` route matching.
export async function handleGrafanaRequest(request: Request): Promise<Response> {
  const authError = await checkAuth(request);
  if (authError) {
    return Response.json(authError.body, { status: authError.status });
  }
  return proxyGrafana(request);
}

export const grafanaProxyRoutes = new Elysia({ name: "grafana-proxy" })
  .all("/grafana", handler, { detail: { tags: ["monitoring"], summary: "Proxy Grafana root" } })
  .all("/grafana/*", handler, { detail: { tags: ["monitoring"], summary: "Proxy Grafana assets and dashboards" } });

export const grafanaProxyInternals = {
  buildGrafanaTargetUrl,
  buildProxyHeaders,
  buildResponseHeaders,
};
