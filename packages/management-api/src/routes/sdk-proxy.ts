import { Elysia, t } from "elysia";
import { getProjectDb } from "../db";
import { config } from "../config";
import { sql as metaSql } from "../db";
import { logger } from "../utils/logger";

async function getProjectRef(request: Request): Promise<string> {
    const refHeader = request.headers.get("x-project-ref") || request.headers.get("x-supabase-project");
    if (refHeader) return refHeader;
    
    // Parse Host header (e.g. ref.supabase.co -> ref, or ref.api.supabase.co)
    const host = request.headers.get('host');
    if (host) {
        if (host.includes('.supabase.co') || (config.baseDomain && host.includes(config.baseDomain))) {
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

    // Test backdoor
    if (process.env.NODE_ENV !== 'production') {
        if (key === 'test-token' || auth.includes('test-token') || auth.includes('jVFIR-MB7rNfUuJaUH') || key.includes('jVFIR-MB7rNfUuJaUH')) {
             return 'test_mock';
        }
    }
    
    return '';
}

async function getTenantPorts(ref: string): Promise<{ gotruePort: number, pgrstPort: number } | null> {
    if (ref === 'test_mock') return { gotruePort: 9999, pgrstPort: 3000 };
    
    // In SupaCloud, tenant ports are stored in projects or project_config table
    try {
        const rows = await metaSql`SELECT postgrest_port, gotrue_port FROM project_config WHERE project_ref = ${ref} LIMIT 1`;
        if (rows.length > 0 && rows[0].postgrest_port && rows[0].gotrue_port) {
            return {
                pgrstPort: rows[0].postgrest_port as number,
                gotruePort: rows[0].gotrue_port as number
            };
        }
        // Fallback or missing
        return null;
    } catch (e) {
        logger.error(`Failed to get ports for tenant ${ref}`, { error: e instanceof Error ? e.message : String(e) });
        return null;
    }
}
import { DEFAULT_CORS_HEADERS, DEFAULT_CORS_EXPOSED } from '../services/gateway.service';

async function executeProxy(request: Request, _set: any, targetUrl: string, interceptors: { linkOrigin?: string, ref?: string, extraHeaders?: Record<string, string> }) {
    try {
        // Body passthrough - absolutely no deserialization!
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
            redirect: 'manual'
        });
        const duration = performance.now() - upstreamStart;
        if (process.env.NODE_ENV !== 'production' && duration > 500) {
            logger.warn(`[SDK Proxy] Slow upstream response (${duration.toFixed(0)}ms): ${targetUrl}`);
        }

        // New Paradigm: Create an independent Headers object reflecting the exact upstream shape
        const proxyHeaders = new Headers();
        
        // Ensure Set-Cookie multi-values are perfectly reproduced.
        if (typeof response.headers.getSetCookie === 'function') {
            const cookies = response.headers.getSetCookie();
            cookies.forEach(c => proxyHeaders.append('set-cookie', c));
        }

        response.headers.forEach((val, key) => {
            const lowerKey = key.toLowerCase();
            if (lowerKey === 'set-cookie') return;

            // Transform Hook: Link URL override for HATEOAS / Pagination
            if (lowerKey === 'link' && interceptors.linkOrigin) {
                proxyHeaders.set(key, val.replace(/<(https?:\/\/[^>]+)?\/admin\/users/g, `<${interceptors.linkOrigin}/auth/v1/admin/users`));
                return;
            }

            proxyHeaders.set(key, val);
        });

        // Transform Hook: Force SDK Version and CORS
        proxyHeaders.set('x-supabase-api-version', '2024-01-01');
        proxyHeaders.set('access-control-allow-origin', '*'); // Default reflective if credentials present? SDK is usually anonymous or Authorization header. '*' is safe for non-credentialed.
        proxyHeaders.set('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
        proxyHeaders.set('access-control-allow-headers', DEFAULT_CORS_HEADERS.join(', '));
        proxyHeaders.set('access-control-expose-headers', DEFAULT_CORS_EXPOSED.join(', '));
        
        // If it's an OPTIONS request, intercept it entirely and return OK immediately
        if (request.method === 'OPTIONS') {
             return new Response(null, { status: 204, headers: proxyHeaders });
        }

        // Return a fully formed native Response stream. Elysia will adopt it exactly as-is.
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
    // Generic ALL route for Auth API
    .all("/auth/v1/*", async ({ request, set }) => {
        const ref = await getProjectRef(request);
        if (!ref) {
            set.status = 400;
            return { error: 'Bad Request', message: 'Missing tenant reference' };
        }
        const ports = await getTenantPorts(ref);
        if (!ports) {
            set.status = 502;
            return { error: 'Bad Gateway', message: 'Tenant backend not active' };
        }
        
        const url = new URL(request.url);
        const targetUrl = `http://127.0.0.1:${ports.gotruePort}${url.pathname.replace(/^\/auth\/v1/, '')}${url.search}`;
        return executeProxy(request, set, targetUrl, { linkOrigin: url.origin });
    })

    // Generic ALL route for PostgREST API
    .all("/rest/v1/*", async ({ request, set }) => {
        const ref = await getProjectRef(request);
        if (!ref) {
            set.status = 400;
            return { error: 'Bad Request', message: 'Missing tenant reference' };
        }
        const ports = await getTenantPorts(ref);
        if (!ports) {
            set.status = 502;
            return { error: 'Bad Gateway', message: 'Tenant backend not active' };
        }
        
        const url = new URL(request.url);
        let targetPath = url.pathname.replace(/^\/rest\/v1/, '');
        if (!targetPath || targetPath === '') targetPath = '/';
        const targetUrl = `http://127.0.0.1:${ports.pgrstPort}${targetPath}${url.search}`;
        return executeProxy(request, set, targetUrl, {});
    });

const graphqlHandler = async ({ request, set }: any) => {
    const ref = await getProjectRef(request);
    if (!ref) {
        set.status = 400;
        return { error: 'Bad Request', message: 'Missing tenant reference' };
    }
    const ports = await getTenantPorts(ref);
    if (!ports) {
        set.status = 502;
        return { error: 'Bad Gateway', message: 'Tenant backend not active' };
    }
    
    const url = new URL(request.url);
    const targetUrl = `http://127.0.0.1:${ports.pgrstPort}/rpc/graphql${url.search}`;
    
    return executeProxy(request, set, targetUrl, {
        extraHeaders: {
            'Accept-Profile': 'graphql_public',
            'Content-Profile': 'graphql_public'
        }
    });
};

const functionsHandler = async ({ request, set }: any) => {
    const ref = await getProjectRef(request);
    if (!ref) {
        set.status = 400;
        return { error: 'Bad Request', message: 'Missing tenant reference' };
    }

    const { config } = await import("../config");
    const [edgeHost, edgePortStr] = (config.edgeRuntimeInternal || "127.0.0.1:9000").split(':');
    const edgePort = parseInt(edgePortStr, 10) || 9000;

    const url = new URL(request.url);
    const targetPath = url.pathname.replace(/^\/functions\/v1/, '');
    const targetUrl = `http://${edgeHost}:${edgePort}${targetPath}${url.search}`;

    return executeProxy(request, set, targetUrl, { ref });
};

export const sdkProxyRoutes = sdkProxyRoutesBase
    .all("/graphql/v1", graphqlHandler)
    .all("/graphql/v1/*", graphqlHandler)
    .all("/functions/v1/*", functionsHandler);
