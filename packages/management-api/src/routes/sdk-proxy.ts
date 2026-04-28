import { Elysia, t } from "elysia";
import { getProjectDb } from "../db";
import { config } from "../config";
import { sql as metaSql } from "../db";
import { logger } from "../utils/logger";
import { DEFAULT_CORS_HEADERS, DEFAULT_CORS_EXPOSED } from '../services/gateway.service';
import { backgroundTaskService } from "../services/background-task.service";
import { edgeFunctionService } from "../services/edge-function.service";
import { projectService } from "../services/project.service";
import { resolveTenantPorts } from "../utils/project-routing";
import { resolveProjectRefFromApiKey } from "../utils/project-auth";

const MAX_ASYNC_BODY_BYTES = 256 * 1024;
let sdkProxyFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init)) as typeof fetch;

export function setSdkProxyFetchForTests(fetchImpl?: typeof fetch): void {
    sdkProxyFetch = fetchImpl || (((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init)) as typeof fetch);
}

function normalizeAsyncRoutePath(path: string): string {
    if (!path) return "/";
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return normalized.replace(/\/+$/, "") || "/";
}

function shouldForceAsyncRoute(targetPath: string, configuredRoutes: string[] | undefined): boolean {
    const normalizedTarget = normalizeAsyncRoutePath(targetPath);
    return (configuredRoutes || []).some((route) => {
        const normalizedRoute = normalizeAsyncRoutePath(route);
        return normalizedTarget === normalizedRoute || normalizedTarget.startsWith(`${normalizedRoute}/`);
    });
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
        const [, payload] = token.split(".");
        if (!payload) return null;
        const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
        return null;
    }
}

async function maybeEnqueueAsyncFunction(request: Request, ref: string): Promise<Response | null> {
    const url = new URL(request.url);
    const targetPath = url.pathname.replace(/^\/functions\/v1/, "");
    const [functionSlug, ...restPath] = targetPath.split("/").filter(Boolean);
    if (!functionSlug) {
        return new Response(JSON.stringify({ message: "Missing function slug" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const fnConfig = await edgeFunctionService.getConfig(ref, functionSlug);
    const routePath = restPath.length > 0 ? `/${restPath.join("/")}` : "/";
    const shouldEnqueue = shouldForceAsyncRoute(routePath, fnConfig.background_routes);
    if (!shouldEnqueue) return null;

    const backgroundSettings = await projectService.getBackgroundTaskSettings(ref);
    const maxPayloadBytes = backgroundSettings?.max_payload_bytes || MAX_ASYNC_BODY_BYTES;
    const requestedTimeout = backgroundSettings?.timeout_sec_default;
    const timeoutSec = Math.min(
        backgroundSettings?.timeout_sec_max || 900,
        backgroundTaskService.normalizeBackgroundTaskTimeout(requestedTimeout),
    );
    const maxAttempts = Math.min(
        backgroundSettings?.max_attempts || 3,
        backgroundTaskService.normalizeBackgroundTaskMaxAttempts(backgroundSettings?.max_attempts),
    );

    const requestClone = request.clone();
    const bodyBuffer =
        ["GET", "HEAD"].includes(request.method) ? null : await requestClone.arrayBuffer();
    if (bodyBuffer && bodyBuffer.byteLength > maxPayloadBytes) {
        return new Response(
            JSON.stringify({
                message: `Async payload too large. Max supported size is ${maxPayloadBytes} bytes`,
            }),
            {
                status: 413,
                headers: { "Content-Type": "application/json" },
            },
        );
    }

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if ([
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "authorization",
            "apikey",
            "cookie",
            "x-supacloud-internal-auth",
        ].includes(lower)) {
            return;
        }
        headers[key] = value;
    });

    const traceId = request.headers.get("x-request-id") || crypto.randomUUID();
    const authHeaders: Record<string, string> = {};
    const authorization = request.headers.get("authorization");
    const apikey = request.headers.get("apikey");
    const projectKeys = apikey && typeof projectService.getApiKeys === "function"
        ? await projectService.getApiKeys(ref)
        : null;
    const authPayload = authorization?.startsWith("Bearer ")
        ? decodeJwtPayload(authorization.replace(/^Bearer\s+/i, ""))
        : null;
    const authKind = authorization
        ? "jwt"
        : apikey
            ? "apikey"
            : "none";
    const apikeyKind = apikey
        ? apikey === projectKeys?.anon_key
            ? "anon"
            : apikey === projectKeys?.service_role_key
                ? "service_role"
                : "unknown"
        : null;

    const task = await backgroundTaskService.enqueueBackgroundFunctionTask({
        projectRef: ref,
        functionSlug,
        functionVersion: fnConfig.version || "1",
        timeoutSec,
        maxAttempts,
        maxPayloadBytes,
        idempotencyKey: null,
        traceId,
        envelope: {
            method: request.method,
            path: restPath.length > 0 ? `/${restPath.join("/")}` : "",
            query: url.search,
            headers,
            body: bodyBuffer ? Buffer.from(bodyBuffer).toString("utf8") : null,
            body_encoding: "utf8",
            requested_timeout_sec: timeoutSec,
            auth: {
                kind: authKind,
                authorization,
                apikey,
                invoker_user_id: typeof authPayload?.sub === "string" ? authPayload.sub : null,
                invoker_role: typeof authPayload?.role === "string" ? authPayload.role : null,
                apikey_kind: apikeyKind,
            },
        },
    });

    return new Response(
        JSON.stringify({
            task_id: task.id,
            status: task.status,
            project_ref: task.project_ref,
            function_slug: task.function_slug,
            attempt: task.attempt,
            max_attempts: task.max_attempts,
        }),
        {
            status: 202,
            headers: {
                "Content-Type": "application/json",
                "x-supacloud-task-id": task.id,
            },
        },
    );
}

export const sdkProxyInternals = {
    resolveProjectRefFromApiKey,
};

async function getProjectRef(request: Request): Promise<string> {
    const auth = request.headers.get('authorization') || '';
    const key = request.headers.get('apikey') || '';
    const apiKeyRef = await sdkProxyInternals.resolveProjectRefFromApiKey(key) || '';

    if (apiKeyRef) {
        const refHeader = request.headers.get("x-project-ref") || request.headers.get("x-supabase-project");
        if (refHeader && refHeader !== apiKeyRef) return '';

        const forwardedHost = request.headers.get('x-forwarded-host');
        const rawHosts = [forwardedHost, request.headers.get('host')].filter(Boolean) as string[];
        for (const rawHost of rawHosts) {
            const host = rawHost.split(',')[0].trim();
            if (!host) continue;

            if (config.baseDomain && host.includes(config.baseDomain)) {
                const hostRef = host.split('.')[0];
                if (hostRef && hostRef !== apiKeyRef) return '';
            }
            try {
                const hostWithoutPort = host.split(':')[0];
                const rows = await metaSql`
                    SELECT ref
                    FROM projects
                    WHERE config->>'custom_domain' = ${hostWithoutPort}
                       OR config->>'api_domain' = ${hostWithoutPort}
                       OR config->>'custom_domain' = ${hostWithoutPort.replace(/^api\./, '')}
                    LIMIT 1
                `;
                if (rows.length > 0 && rows[0].ref !== apiKeyRef) return '';
            } catch(e) {}
        }

        return apiKeyRef;
    }

    if (process.env.BUN_ENV === 'test' || process.env.NODE_ENV === 'test') {
        if (key === 'test-token' || auth.includes('test-token')) {
             return 'test_mock';
        }
    }
    
    return '';
}

async function getTenantPorts(ref: string): Promise<{ gotruePort: number, pgrstPort: number } | null> {
    if (ref === 'test_mock') return { gotruePort: 9999, pgrstPort: 3000 };
    
    try {
        const projectRows = await metaSql`
            SELECT config
            FROM projects
            WHERE ref = ${ref} AND deleted_at IS NULL
            LIMIT 1
        `;
        return resolveTenantPorts(projectRows[0]?.config as Record<string, unknown> | undefined);
    } catch (e) {
        logger.error(`Failed to get ports for tenant ${ref}`, { error: e instanceof Error ? e.message : String(e) });
        return null;
    }
}

function applyCorsHeaders(proxyHeaders: Headers, request: Request) {
    const origin = request.headers.get('origin');
    if (!origin) return;

    const hasCredentials = request.headers.get('authorization') || request.headers.get('cookie');
    if (hasCredentials) {
        proxyHeaders.set('access-control-allow-origin', origin);
        proxyHeaders.set('access-control-allow-credentials', 'true');
        proxyHeaders.set('vary', [proxyHeaders.get('vary'), 'origin'].filter(Boolean).join(', '));
    } else {
        proxyHeaders.set('access-control-allow-origin', '*');
    }
    proxyHeaders.set('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
    proxyHeaders.set('access-control-allow-headers', DEFAULT_CORS_HEADERS.join(', '));
    proxyHeaders.set('access-control-expose-headers', DEFAULT_CORS_EXPOSED.join(', '));
    proxyHeaders.set('access-control-max-age', '86400');
}

type ProxyInterceptors = {
    linkOrigin?: string;
    ref?: string;
    extraHeaders?: Record<string, string>;
    timeoutMs?: number;
};

async function executeProxy(request: Request, targetUrl: string, interceptors: ProxyInterceptors) {
    try {
        const body = ["GET", "HEAD"].includes(request.method) ? undefined : request.body;
        
        const reqHeaders = new Headers(request.headers);
        reqHeaders.delete('host');
        reqHeaders.delete('x-forwarded-host');
        reqHeaders.delete('x-forwarded-proto');
        reqHeaders.delete('x-forwarded-for');
        reqHeaders.delete('x-real-ip');
        
        const url = new URL(request.url);
        reqHeaders.set('x-forwarded-host', url.host);
        reqHeaders.set('x-forwarded-proto', url.protocol.replace(':', ''));
        reqHeaders.set('x-forwarded-for', '127.0.0.1');
        
        if (interceptors.ref) {
            reqHeaders.set('x-project-ref', interceptors.ref);
        }
        if (interceptors.extraHeaders) {
            for (const [k, v] of Object.entries(interceptors.extraHeaders)) {
                reqHeaders.set(k, v);
            }
        }

        const upstreamStart = performance.now();
        const fetchInit: RequestInit & { duplex?: "half" } = {
            method: request.method,
            headers: reqHeaders,
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(interceptors.timeoutMs ?? config.sdkProxyTimeoutMs),
        };
        if (body) {
            fetchInit.duplex = "half";
        }

        const response = await sdkProxyFetch(targetUrl, fetchInit);
        const duration = performance.now() - upstreamStart;
        if (process.env.NODE_ENV !== 'production' && duration > 500) {
            logger.warn(`[SDK Proxy] Slow upstream response (${duration.toFixed(0)}ms): ${targetUrl}`);
        }

        const proxyHeaders = new Headers();
        
        if (typeof response.headers.getSetCookie === 'function') {
            const cookies = response.headers.getSetCookie();
            cookies.forEach(c => proxyHeaders.append('set-cookie', c));
        }

        response.headers.forEach((val, key) => {
            const lowerKey = key.toLowerCase();
            if (lowerKey === 'set-cookie') return;
            if (lowerKey === 'access-control-allow-origin') return;
            if (lowerKey === 'access-control-allow-credentials') return;
            if (lowerKey === 'access-control-allow-methods') return;
            if (lowerKey === 'access-control-allow-headers') return;
            if (lowerKey === 'access-control-expose-headers') return;

            if (lowerKey === 'link' && interceptors.linkOrigin) {
                const rewritten = val.replace(/<(https?:\/\/[^>]+)(\/[^>]*)>/g, `<${interceptors.linkOrigin}$2>`);
                proxyHeaders.set(key, rewritten);
                return;
            }

            proxyHeaders.set(key, val);
        });

        proxyHeaders.set('x-supabase-api-version', new Date().toISOString().slice(0, 10).replace(/-/g, '').substring(0, 8));

        applyCorsHeaders(proxyHeaders, request);
        
        if (request.method === 'OPTIONS') {
             return new Response(null, { status: 204, headers: proxyHeaders });
        }

        return new Response(response.body, {
            status: response.status,
            headers: proxyHeaders
        });

    } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        const name = err instanceof Error ? err.name : "";
        if (name === "TimeoutError" || name === "AbortError" || /abort|timeout/i.test(message)) {
            logger.warn(`[SDK Proxy] Upstream timeout: ${targetUrl}`, { error: message });
            return new Response(JSON.stringify({ message: 'Upstream Proxy Timeout' }), {
                status: 504,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        logger.error(`[SDK Proxy] Internal error:`, message);
        return new Response(JSON.stringify({ message: 'Internal Proxy Error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

const sdkProxyRoutesBase = new Elysia({ prefix: "" })
    .group("/auth/v1", (app) => {
        const handler = async ({ request }: any) => {
            const ref = await getProjectRef(request);
            if (!ref) return new Response(JSON.stringify({ message: 'Missing tenant reference' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            const ports = await getTenantPorts(ref);
            if (!ports) return new Response(JSON.stringify({ message: 'Tenant backend not active' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
            
            const url = new URL(request.url);
            const targetUrl = `http://127.0.0.1:${ports.gotruePort}${url.pathname.replace(/^\/auth\/v1/, '')}${url.search}`;
            return executeProxy(request, targetUrl, { linkOrigin: url.origin });
        };
        return app.get("/*", handler).post("/*", handler).put("/*", handler).patch("/*", handler).delete("/*", handler).options("/*", handler)
                  .get("", handler).post("", handler).put("", handler).patch("", handler).delete("", handler).options("", handler);
    })
    .group("/rest/v1", (app) => {
        const handler = async ({ request }: any) => {
            const ref = await getProjectRef(request);
            if (!ref) return new Response(JSON.stringify({ message: 'Missing tenant reference' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            const ports = await getTenantPorts(ref);
            if (!ports) return new Response(JSON.stringify({ message: 'Tenant backend not active' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
            
            const url = new URL(request.url);
            let targetPath = url.pathname.replace(/^\/rest\/v1/, '');
            if (!targetPath || targetPath === '') targetPath = '/';
            const targetUrl = `http://127.0.0.1:${ports.pgrstPort}${targetPath}${url.search}`;
            const linkOrigin = `${url.protocol}//${url.host}/rest/v1`;
            return executeProxy(request, targetUrl, { linkOrigin, timeoutMs: config.restProxyTimeoutMs });
        };
        return app.get("/*", handler).post("/*", handler).put("/*", handler).patch("/*", handler).delete("/*", handler).options("/*", handler)
                  .get("", handler).post("", handler).put("", handler).patch("", handler).delete("", handler).options("", handler);
    });

const graphqlHandler = async ({ request }: any) => {
    const ref = await getProjectRef(request);
    if (!ref) return new Response(JSON.stringify({ message: 'Missing tenant reference' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const ports = await getTenantPorts(ref);
    if (!ports) return new Response(JSON.stringify({ message: 'Tenant backend not active' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    
    const url = new URL(request.url);
    const targetUrl = `http://127.0.0.1:${ports.pgrstPort}/rpc/graphql${url.search}`;
    
    return executeProxy(request, targetUrl, {
        extraHeaders: {
            'Accept-Profile': 'graphql_public',
            'Content-Profile': 'graphql_public'
        }
    });
};

const realtimeHandler = async ({ request }: any) => {
    const ref = await getProjectRef(request);
    if (!ref) return new Response(JSON.stringify({ message: 'Missing tenant reference' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    
    const url = new URL(request.url);
    const targetUrl = `${config.realtimeAdminUrl}${url.pathname}${url.search}`;
    return executeProxy(request, targetUrl, { ref });
};

const functionsHandler = async ({ request }: any) => {
    const ref = await getProjectRef(request);
    if (!ref) return new Response(JSON.stringify({ message: 'Missing tenant reference' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const asyncResponse = await maybeEnqueueAsyncFunction(request, ref);
    if (asyncResponse) return asyncResponse;

    const { config } = await import("../config");
    const [edgeHost, edgePortStr] = (config.edgeRuntimeInternal || "127.0.0.1:9000").split(':');
    const edgePort = parseInt(edgePortStr, 10) || 9000;

    const url = new URL(request.url);
    // Preserve the /functions/v1 prefix when forwarding to edge-runtime.
    // The runtime exposes both /functions/v1/:slug and bare /:slug routes, but
    // stripping the prefix causes function names like "health" to collide with
    // runtime diagnostics endpoints such as /health.
    const targetUrl = `http://${edgeHost}:${edgePort}${url.pathname}${url.search}`;

    return executeProxy(request, targetUrl, { ref });
};

export const sdkProxyRoutes = sdkProxyRoutesBase
    .get("/graphql/v1", graphqlHandler)
    .post("/graphql/v1", graphqlHandler)
    .options("/graphql/v1", graphqlHandler)
    .group("/graphql/v1", (app) => app.get("/*", graphqlHandler).post("/*", graphqlHandler).options("/*", graphqlHandler))
    .group("/realtime/v1", (app) => {
        return app.get("/*", realtimeHandler).post("/*", realtimeHandler).put("/*", realtimeHandler).patch("/*", realtimeHandler).delete("/*", realtimeHandler).options("/*", realtimeHandler)
                  .get("", realtimeHandler).post("", realtimeHandler).put("", realtimeHandler).patch("", realtimeHandler).delete("", realtimeHandler).options("", realtimeHandler);
    })
    .group("/functions/v1", (app) => app.get("/*", functionsHandler).post("/*", functionsHandler).put("/*", functionsHandler).patch("/*", functionsHandler).delete("/*", functionsHandler).options("/*", functionsHandler));
