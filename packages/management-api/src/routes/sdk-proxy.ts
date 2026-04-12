import { Elysia, t } from "elysia";
import { getProjectDb } from "../db";
import { config } from "../config";
import { sql as metaSql } from "../db";
import { logger } from "../utils/logger";
import { DEFAULT_CORS_HEADERS, DEFAULT_CORS_EXPOSED } from '../services/gateway.service';

async function getProjectRef(request: Request): Promise<string> {
    const refHeader = request.headers.get("x-project-ref") || request.headers.get("x-supabase-project");
    if (refHeader) return refHeader;
    
    const host = request.headers.get('host');
    if (host) {
        if (config.baseDomain && host.includes(config.baseDomain)) {
            return host.split('.')[0];
        }
        try {
            const hostWithoutPort = host.split(':')[0];
            const rows = await metaSql`SELECT ref FROM projects WHERE config->>'custom_domain' = ${hostWithoutPort} OR config->>'api_domain' = ${hostWithoutPort} OR config->>'custom_domain' = ${hostWithoutPort.replace(/^api\./, '')} LIMIT 1`;
            if (rows.length > 0) return rows[0].ref;
        } catch(e) {}
    }

    const auth = request.headers.get('authorization') || '';
    if (auth.startsWith('Bearer ')) {
        try {
           const payloadB64 = auth.split('.')[1];
           if (payloadB64) {
               const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
               if (payload.ref) return payload.ref;
           }
        } catch(e) {}
    }

    const key = request.headers.get('apikey') || '';
    if (key) {
        try {
            const rows = await metaSql`SELECT ref FROM projects WHERE anon_key = ${key} OR service_role_key = ${key} LIMIT 1`;
            if (rows.length > 0) return rows[0].ref;
        } catch(e) {}
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
        const rows = await metaSql`SELECT postgrest_port, gotrue_port FROM project_config WHERE project_ref = ${ref} LIMIT 1`;
        if (rows.length > 0 && rows[0].postgrest_port && rows[0].gotrue_port) {
            return {
                pgrstPort: rows[0].postgrest_port as number,
                gotruePort: rows[0].gotrue_port as number
            };
        }
        return null;
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

async function executeProxy(request: Request, targetUrl: string, interceptors: { linkOrigin?: string, ref?: string, extraHeaders?: Record<string, string> }) {
    try {
        const body = ["GET", "HEAD"].includes(request.method) ? undefined : request.body;
        
        const reqHeaders = new Headers(request.headers);
        reqHeaders.delete('host');
        
        const url = new URL(request.url);
        reqHeaders.set('x-forwarded-host', url.host);
        reqHeaders.set('x-forwarded-proto', url.protocol.replace(':', ''));
        reqHeaders.set('x-forwarded-for', request.headers.get('x-forwarded-for') || '127.0.0.1');
        
        if (interceptors.ref) {
            reqHeaders.set('x-project-ref', interceptors.ref);
        }
        if (interceptors.extraHeaders) {
            for (const [k, v] of Object.entries(interceptors.extraHeaders)) {
                reqHeaders.set(k, v);
            }
        }

        const upstreamStart = performance.now();
        const response = await fetch(targetUrl, {
            method: request.method,
            headers: reqHeaders,
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(30000),
        });
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
        logger.error(`[SDK Proxy] Internal error:`, err.message);
        return new Response(JSON.stringify({ error: 'Internal Proxy Error', message: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

const sdkProxyRoutesBase = new Elysia({ prefix: "" })
    .group("/auth/v1", (app) => {
        const handler = async ({ request }: any) => {
            const ref = await getProjectRef(request);
            if (!ref) return new Response(JSON.stringify({ error: 'Bad Request', message: 'Missing tenant reference' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            const ports = await getTenantPorts(ref);
            if (!ports) return new Response(JSON.stringify({ error: 'Bad Gateway', message: 'Tenant backend not active' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
            
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
            if (!ref) return new Response(JSON.stringify({ error: 'Bad Request', message: 'Missing tenant reference' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            const ports = await getTenantPorts(ref);
            if (!ports) return new Response(JSON.stringify({ error: 'Bad Gateway', message: 'Tenant backend not active' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
            
            const url = new URL(request.url);
            let targetPath = url.pathname.replace(/^\/rest\/v1/, '');
            if (!targetPath || targetPath === '') targetPath = '/';
            const targetUrl = `http://127.0.0.1:${ports.pgrstPort}${targetPath}${url.search}`;
            const linkOrigin = `${url.protocol}//${url.host}/rest/v1`;
            return executeProxy(request, targetUrl, { linkOrigin });
        };
        return app.get("/*", handler).post("/*", handler).put("/*", handler).patch("/*", handler).delete("/*", handler).options("/*", handler)
                  .get("", handler).post("", handler).put("", handler).patch("", handler).delete("", handler).options("", handler);
    });

const graphqlHandler = async ({ request }: any) => {
    const ref = await getProjectRef(request);
    if (!ref) return new Response(JSON.stringify({ error: 'Bad Request', message: 'Missing tenant reference' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const ports = await getTenantPorts(ref);
    if (!ports) return new Response(JSON.stringify({ error: 'Bad Gateway', message: 'Tenant backend not active' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    
    const url = new URL(request.url);
    const targetUrl = `http://127.0.0.1:${ports.pgrstPort}/rpc/graphql${url.search}`;
    
    return executeProxy(request, targetUrl, {
        extraHeaders: {
            'Accept-Profile': 'graphql_public',
            'Content-Profile': 'graphql_public'
        }
    });
};

const functionsHandler = async ({ request }: any) => {
    const ref = await getProjectRef(request);
    if (!ref) return new Response(JSON.stringify({ error: 'Bad Request', message: 'Missing tenant reference' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const { config } = await import("../config");
    const [edgeHost, edgePortStr] = (config.edgeRuntimeInternal || "127.0.0.1:9000").split(':');
    const edgePort = parseInt(edgePortStr, 10) || 9000;

    const url = new URL(request.url);
    const targetPath = url.pathname.replace(/^\/functions\/v1/, '');
    const targetUrl = `http://${edgeHost}:${edgePort}${targetPath}${url.search}`;

    return executeProxy(request, targetUrl, { ref });
};

export const sdkProxyRoutes = sdkProxyRoutesBase
    .get("/graphql/v1", graphqlHandler)
    .post("/graphql/v1", graphqlHandler)
    .options("/graphql/v1", graphqlHandler)
    .group("/graphql/v1", (app) => app.get("/*", graphqlHandler).post("/*", graphqlHandler).options("/*", graphqlHandler))
    .group("/functions/v1", (app) => app.get("/*", functionsHandler).post("/*", functionsHandler).put("/*", functionsHandler).patch("/*", functionsHandler).delete("/*", functionsHandler).options("/*", functionsHandler));
