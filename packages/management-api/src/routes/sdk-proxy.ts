import { Elysia } from "elysia";
import { randomUUID } from "node:crypto";
import { encryptSecretIfNeeded } from "../utils/secret-crypto";
import { config } from "../config";
import { sql as metaSql } from "../db";
import { logger } from "../utils/logger";
import { backgroundTaskService } from "../services/background-task.service";
import { edgeFunctionService } from "../services/edge-function.service";
import { projectService } from "../services/project.service";
import { matchProjectRefFromHost, resolveProjectApiHost, resolveTenantPorts } from "../utils/project-routing";
import {
    resolveProjectApiKey,
    resolveProjectRefFromApiKey,
} from "../utils/project-auth";
import { isOpaqueApiKey } from "../utils/api-keys";
import { verifyProjectJwtPayload } from "../utils/project-jwt";
import { resolveProjectServiceRoleKey } from "../utils/service-role";
import { getAuthRuntimeDescriptor } from "../services/auth-runtime.service";
import { GOTRUE_USER_ID_PATTERN } from "../utils/project-user-lifecycle";

const MAX_ASYNC_BODY_BYTES = 256 * 1024;
type SdkProxySql = (
    strings: TemplateStringsArray,
    ...values: unknown[]
) => Promise<Array<Record<string, unknown>>>;

const defaultSdkProxySql = metaSql as unknown as SdkProxySql;
let sdkProxySql = defaultSdkProxySql;
let sdkProxyFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init)) as typeof fetch;

type AdminUserDeletionDispatchInput = {
    request: Request;
    authorityProjectRef: string;
    userId: string;
    directGoTrueUrl: string;
};

class InvalidAdminUserDeletionBodyError extends Error {}

function parsedAdminUserDeletionBody(sourceBody: string): Record<string, unknown> {
    if (!sourceBody) return {};
    let payload: unknown;
    try {
        payload = JSON.parse(sourceBody);
    } catch (error: unknown) {
        throw new InvalidAdminUserDeletionBodyError("Admin user deletion body must be valid JSON", { cause: error });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new InvalidAdminUserDeletionBodyError("Admin user deletion body must be a JSON object");
    }
    return { ...(payload as Record<string, unknown>) };
}

async function adminUserDeletionBody(request: Request): Promise<string> {
    const deletionBody = parsedAdminUserDeletionBody(await request.clone().text());
    const shouldSoftDelete = new URL(request.url).searchParams.get("should_soft_delete") === "true";
    if (shouldSoftDelete && deletionBody.should_soft_delete === undefined) {
        deletionBody.should_soft_delete = true;
    }
    return JSON.stringify(deletionBody);
}

function internalDeletionHeaders(input: AdminUserDeletionDispatchInput): Headers {
    const headers = new Headers({
        authorization: `Bearer ${config.masterToken}`,
        "content-type": "application/json",
        "x-supacloud-direct-gotrue-url": input.directGoTrueUrl,
    });
    const requestId = input.request.headers.get("x-request-id");
    if (requestId) headers.set("x-request-id", requestId);
    return headers;
}

async function dispatchAdminUserDeletionThroughManagement(
    input: AdminUserDeletionDispatchInput,
): Promise<Response> {
    const { userManagementRoutes } = await import("./auth-users");
    let body: string;
    try {
        body = await adminUserDeletionBody(input.request);
    } catch (error: unknown) {
        if (!(error instanceof InvalidAdminUserDeletionBodyError)) throw error;
        return Response.json({ message: error.message }, { status: 400 });
    }
    const requestInit: RequestInit & { duplex?: "half" } = {
        method: "DELETE",
        headers: internalDeletionHeaders(input),
        body,
    };
    requestInit.duplex = "half";
    return userManagementRoutes.handle(new Request(
        `http://localhost/v1/projects/${input.authorityProjectRef}/auth/users/${input.userId}`,
        requestInit,
    ));
}

let adminUserDeletionDispatcher = dispatchAdminUserDeletionThroughManagement;

export function setSdkProxySqlForTests(sqlImpl?: SdkProxySql): void {
    sdkProxySql = sqlImpl || defaultSdkProxySql;
}

export function setSdkProxyFetchForTests(fetchImpl?: typeof fetch): void {
    sdkProxyFetch = fetchImpl || (((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init)) as typeof fetch);
}

export function setAdminUserDeletionDispatcherForTests(
    dispatcher?: (input: AdminUserDeletionDispatchInput) => Promise<Response>,
): void {
    adminUserDeletionDispatcher = dispatcher || dispatchAdminUserDeletionThroughManagement;
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

function buildEncryptedBackgroundAuth(input: {
    authKind: "jwt" | "apikey" | "none";
    authorization: string | null;
    apikey: string | null;
    authPayload: Record<string, unknown> | null;
    apikeyKind: "anon" | "service_role" | "unknown" | null;
}) {
    return {
        kind: input.authKind,
        authorization: input.authorization ? encryptSecretIfNeeded(input.authorization) : null,
        apikey: input.apikey ? encryptSecretIfNeeded(input.apikey) : null,
        invoker_user_id: typeof input.authPayload?.sub === "string" ? input.authPayload.sub : null,
        invoker_role: typeof input.authPayload?.role === "string" ? input.authPayload.role : null,
        apikey_kind: input.apikeyKind,
    };
}

function hostFromRequestUrl(request: Request): string {
    try {
        return new URL(request.url).host;
    } catch {
        return "";
    }
}

function hostNameFromHeaderValue(rawHost: string): string {
    const host = rawHost.split(",")[0].trim();
    if (!host) return "";
    try {
        return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch {
        return host.replace(/^\[|\]$/g, "").split(":")[0].toLowerCase();
    }
}

function requestHostCandidates(request: Request): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const rawHost of [
        request.headers.get('x-forwarded-host'),
        request.headers.get('host'),
        hostFromRequestUrl(request),
    ]) {
        const host = rawHost?.trim();
        if (!host || seen.has(host)) continue;
        seen.add(host);
        result.push(host);
    }
    return result;
}

function firstForwardedHost(request: Request): string {
    const [rawHost] = requestHostCandidates(request);
    return rawHost ? hostNameFromHeaderValue(rawHost) : "";
}

function hostBelongsToBaseDomain(host: string): boolean {
    const baseDomain = config.baseDomain?.toLowerCase();
    if (!baseDomain || !host) return false;
    return host === baseDomain || host.endsWith(`.${baseDomain}`);
}

function isLoopbackRequestHost(request: Request): boolean {
    const host = firstForwardedHost(request);
    if (!host) return true;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isTestTenantAuthAllowed(request: Request): boolean {
    return (process.env.BUN_ENV === 'test' || process.env.NODE_ENV === 'test') && isLoopbackRequestHost(request);
}

async function verifyJwtPayload(ref: string, token: string): Promise<Record<string, unknown> | null> {
    try {
        const result = await verifyProjectJwtPayload(ref, token);
        return result?.payload as Record<string, unknown> | null;
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

    const traceId = request.headers.get("x-request-id") || randomUUID();
    const idempotencyKey = request.headers.get("x-supacloud-idempotency-key")?.trim() || null;
    const authorization = request.headers.get("authorization");
    const apikey = request.headers.get("apikey");
    const projectKeys = apikey && typeof projectService.getApiKeys === "function"
        ? await projectService.getApiKeys(ref)
        : null;
    const authPayload = authorization?.startsWith("Bearer ")
        ? await verifyJwtPayload(ref, authorization.replace(/^Bearer\s+/i, ""))
        : null;
    const authKind = authorization
        ? "jwt"
        : apikey
            ? "apikey"
            : "none";
    const apikeyKind = apikey
        ? apikey === projectKeys?.anon_key || apikey === projectKeys?.publishable_key
            ? "anon"
            : apikey === projectKeys?.service_role_key || apikey === projectKeys?.secret_key
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
        idempotencyKey,
        traceId,
        envelope: {
            method: request.method,
            path: restPath.length > 0 ? `/${restPath.join("/")}` : "",
            query: url.search,
            headers,
            body: bodyBuffer ? Buffer.from(bodyBuffer).toString("utf8") : null,
            body_encoding: "utf8",
            requested_timeout_sec: timeoutSec,
            auth: buildEncryptedBackgroundAuth({
                authKind,
                authorization,
                apikey,
                authPayload,
                apikeyKind,
            }),
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
    resolveProjectApiKey,
    resolveProjectServiceRoleKey,
    maybeEnqueueAsyncFunction,
    buildEncryptedBackgroundAuth,
    translateOpaqueApiKeyHeaders,
    dispatchAdminUserDeletionThroughManagement,
    adminUserDeletionBody,
};

async function getUpstreamAnonKey(ref: string): Promise<string | null> {
    const keys = await projectService.getApiKeys(ref);
    return keys?.anon_key || null;
}

async function translateOpaqueApiKeyHeaders(
    headers: Headers,
    ref: string,
    authAuthorityRef = ref,
): Promise<boolean> {
    const apikey = headers.get("apikey")?.trim() || "";
    const authorization = headers.get("authorization")?.trim() || "";
    const bearerToken = authorization.replace(/^Bearer\s+/i, "");
    let rewrittenApiKey: string | null = null;
    let projectServiceRoleKey: Promise<string | null> | undefined;

    const resolveSameProjectServiceRoleKey = (): Promise<string | null> => {
        projectServiceRoleKey ??= sdkProxyInternals.resolveProjectServiceRoleKey(ref);
        return projectServiceRoleKey;
    };

    const resolveUpstream = async (candidate: string): Promise<string | null | undefined> => {
        if (!candidate) return undefined;
        const resolved = await sdkProxyInternals.resolveProjectApiKey(candidate, { includeProvisioning: true });
        if (!resolved) return isOpaqueApiKey(candidate) ? null : undefined;
        if (resolved.ref !== ref) return null;
        // 从属项目只能借用 SupAuth owner 的匿名入口。绝不能把从属项目的
        // service_role/secret 凭据升级为 owner 的全局管理员凭据。
        if (authAuthorityRef !== ref) {
            if (resolved.role === "service_role") return null;
            return getUpstreamAnonKey(authAuthorityRef);
        }
        if (resolved.role === "service_role") return resolveSameProjectServiceRoleKey();
        return resolved.upstreamKey || null;
    };

    if (apikey) {
        const upstream = await resolveUpstream(apikey);
        if (upstream === null) return false;
        if (upstream) {
            rewrittenApiKey = upstream;
            headers.set("apikey", upstream);
        }
    }

    // Resolve every bearer so a legacy service_role JWT cannot bypass project
    // binding. Unknown user JWTs return undefined and remain unchanged.
    if (bearerToken) {
        const upstream = await resolveUpstream(bearerToken);
        if (upstream === null) return false;
        if (upstream) headers.set("authorization", `Bearer ${upstream}`);
    } else if (rewrittenApiKey && !authorization) {
        headers.set("authorization", `Bearer ${rewrittenApiKey}`);
    }
    return true;
}

async function hasProjectServiceRoleCredential(request: Request, projectRef: string): Promise<boolean> {
    const apiKey = request.headers.get("apikey")?.trim() || "";
    const authorization = request.headers.get("authorization")?.trim() || "";
    const bearerToken = authorization.replace(/^Bearer\s+/i, "");
    const candidates = [...new Set([apiKey, bearerToken].filter(Boolean))];
    for (const candidate of candidates) {
        const resolved = await sdkProxyInternals.resolveProjectApiKey(candidate, { includeProvisioning: true });
        if (resolved?.ref === projectRef && resolved.role === "service_role") return true;
    }
    return false;
}

function isOpenApiSchemaRequest(request: Request): boolean {
    if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return false;
    return new URL(request.url).pathname.replace(/\/+$/, "") === "/rest/v1";
}

function openApiSchemaForbiddenResponse(): Response {
    return new Response(JSON.stringify({
        message: "Access to schema is forbidden",
        hint: "Accessing the schema via the Data API is only allowed using a secret API key.",
    }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
    });
}

function adminUserDeletionId(request: Request): string | null {
    if (request.method !== "DELETE") return null;
    const match = new URL(request.url).pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)\/?$/);
    if (!match?.[1]) return null;
    try {
        const userId = decodeURIComponent(match[1]);
        return !userId.includes("/") && GOTRUE_USER_ID_PATTERN.test(userId)
            ? userId.toLowerCase()
            : null;
    } catch {
        return null;
    }
}

async function getProjectRef(request: Request): Promise<string> {
    const auth = request.headers.get('authorization') || '';
    const key = request.headers.get('apikey') || '';
    const refHeader = request.headers.get("x-project-ref") || request.headers.get("x-supabase-project") || "";
    const apiKeyRef = await sdkProxyInternals.resolveProjectRefFromApiKey(key, { includeProvisioning: true }) || '';

    if (apiKeyRef) {
        if (refHeader && refHeader !== apiKeyRef) return '';
        if (isLoopbackRequestHost(request)) return apiKeyRef;

        const rawHosts = requestHostCandidates(request);
        for (const rawHost of rawHosts) {
            const host = hostNameFromHeaderValue(rawHost);
            if (!host) continue;

            try {
                const rows = await sdkProxySql`
                    SELECT ref, config
                    FROM projects
                    WHERE deleted_at IS NULL
                      AND lower(status) IN ('active', 'creating')
                `;
                const matchedProject = rows.find((row: { ref?: unknown; config?: unknown }) =>
                    matchProjectRefFromHost(host, String(row.ref || ""), row.config),
                );
                if (matchedProject && matchedProject.ref !== apiKeyRef) return '';
                if (matchedProject) continue;
            } catch(error: unknown) {
                logger.warn("[SDK Proxy] Failed to validate API key host binding", {
                    apiKeyRef,
                    host,
                    error: error instanceof Error ? error.message : String(error),
                });
                if (!hostBelongsToBaseDomain(host)) return '';
            }

            // A configured alias may intentionally live below the platform
            // base domain (for example sapi.example.com). Only infer the first
            // label as a project ref after no configured host matched.
            if (hostBelongsToBaseDomain(host)) {
                const hostRef = host.split('.')[0];
                if (hostRef && hostRef !== apiKeyRef) return '';
            }
        }

        return apiKeyRef;
    }

    if (refHeader) {
        const trustedRef = await resolveProjectRefFromHeaderAndHost(refHeader, request);
        if (trustedRef) return trustedRef;
    }

    if (isTestTenantAuthAllowed(request)) {
        if (key === 'test-token' || auth.includes('test-token')) {
             return 'test_mock';
        }
    }
    
    return '';
}

async function resolveProjectRefFromHeaderAndHost(ref: string, request: Request): Promise<string> {
    const rawHosts = requestHostCandidates(request);

    for (const rawHost of rawHosts) {
        const host = hostNameFromHeaderValue(rawHost);
        if (!host) continue;

        if (config.baseDomain && host === `${ref}.api.${config.baseDomain}`) {
            return ref;
        }

        try {
            const rows = await sdkProxySql`
                SELECT ref, config
                FROM projects
                WHERE ref = ${ref}
                  AND deleted_at IS NULL
                  AND lower(status) IN ('active', 'creating')
                LIMIT 1
            `;
            if (
                rows.length > 0 &&
                rows[0].ref === ref &&
                (isLoopbackRequestHost(request) || matchProjectRefFromHost(host, ref, rows[0].config))
            ) {
                return ref;
            }
        } catch (error: unknown) {
            logger.warn("[SDK Proxy] Failed to validate project header host binding", {
                ref,
                host,
                error: error instanceof Error ? error.message : String(error),
            });
            return '';
        }
    }

    return '';
}

async function getTenantPorts(ref: string): Promise<{ gotruePort: number, pgrstPort: number } | null> {
    if (ref === 'test_mock') return { gotruePort: 9999, pgrstPort: 3000 };
    
    try {
        const projectRows = await sdkProxySql`
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

type ProxyInterceptors = {
    linkOrigin?: string;
    ref?: string;
    upstreamRef?: string;
    host?: string;
    extraHeaders?: Record<string, string>;
    authAuthorityRef?: string;
    timeoutMs?: number;
};

async function executeProxy(request: Request, targetUrl: string, interceptors: ProxyInterceptors) {
    try {
        if (request.method === 'OPTIONS') {
             return new Response(null, { status: 204 });
        }

        const body = ["GET", "HEAD"].includes(request.method) ? undefined : request.body;
        
        const reqHeaders = new Headers(request.headers);
        if (!(await translateOpaqueApiKeyHeaders(
            reqHeaders,
            interceptors.ref || "",
            interceptors.authAuthorityRef,
        ))) {
            return new Response(JSON.stringify({ message: "Invalid API key" }), {
                status: 401,
                headers: { "Content-Type": "application/json" },
            });
        }
        reqHeaders.delete('host');
        reqHeaders.delete('x-forwarded-host');
        reqHeaders.delete('x-forwarded-proto');
        reqHeaders.delete('x-forwarded-for');
        reqHeaders.delete('x-real-ip');
        
        const url = new URL(request.url);
        const upstreamHost = interceptors.host || url.host;
        if (interceptors.host) {
            reqHeaders.set('host', upstreamHost);
        }
        reqHeaders.set('x-forwarded-host', upstreamHost);
        reqHeaders.set('x-forwarded-proto', url.protocol.replace(':', ''));
        reqHeaders.set('x-forwarded-for', '127.0.0.1');
        
        if (interceptors.ref) {
            reqHeaders.set('x-project-ref', interceptors.upstreamRef || interceptors.ref);
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
            const authAuthorityRef = getAuthRuntimeDescriptor(ref).authority_project_ref;
            const ports = await getTenantPorts(authAuthorityRef);
            if (!ports) return new Response(JSON.stringify({ message: 'Tenant backend not active' }), { status: 502, headers: { 'Content-Type': 'application/json' } });

            const deletionUserId = adminUserDeletionId(request);
            if (deletionUserId) {
                if (authAuthorityRef !== ref) {
                    return new Response(JSON.stringify({ message: "Admin user deletion must use the auth authority project" }), {
                        status: 403,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                if (!(await hasProjectServiceRoleCredential(request, ref))) {
                    return new Response(JSON.stringify({ message: "Invalid API key" }), {
                        status: 401,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                return adminUserDeletionDispatcher({
                    request,
                    authorityProjectRef: authAuthorityRef,
                    userId: deletionUserId,
                    directGoTrueUrl: `http://127.0.0.1:${ports.gotruePort}`,
                });
            }
            
            const url = new URL(request.url);
            const targetUrl = `http://127.0.0.1:${ports.gotruePort}${url.pathname.replace(/^\/auth\/v1/, '')}${url.search}`;
            return executeProxy(request, targetUrl, {
                linkOrigin: url.origin,
                ref,
                upstreamRef: authAuthorityRef,
                authAuthorityRef,
                host: resolveProjectApiHost(ref, undefined),
            });
        };
        return app.get("/*", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Auth request" } }).post("/*", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Auth request" } }).put("/*", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Auth request" } }).patch("/*", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Auth request" } }).delete("/*", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Auth request" } }).options("/*", handler)
                  .get("", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Auth request" } }).post("", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Auth request" } }).put("", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Auth request" } }).patch("", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Auth request" } }).delete("", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Auth request" } }).options("", handler);
    })
    .group("/rest/v1", (app) => {
        const handler = async ({ request }: any) => {
            const ref = await getProjectRef(request);
            if (!ref) return new Response(JSON.stringify({ message: 'Missing tenant reference' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            if (isOpenApiSchemaRequest(request) && !(await hasProjectServiceRoleCredential(request, ref))) {
                return openApiSchemaForbiddenResponse();
            }
            const ports = await getTenantPorts(ref);
            if (!ports) return new Response(JSON.stringify({ message: 'Tenant backend not active' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
            
            const url = new URL(request.url);
            let targetPath = url.pathname.replace(/^\/rest\/v1/, '');
            if (!targetPath || targetPath === '') targetPath = '/';
            const targetUrl = `http://127.0.0.1:${ports.pgrstPort}${targetPath}${url.search}`;
            const linkOrigin = `${url.protocol}//${url.host}/rest/v1`;
            return executeProxy(request, targetUrl, { linkOrigin, ref, host: resolveProjectApiHost(ref, undefined), timeoutMs: config.restProxyTimeoutMs });
        };
        return app.get("/*", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy REST request" } }).post("/*", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy REST request" } }).put("/*", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy REST request" } }).patch("/*", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy REST request" } }).delete("/*", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy REST request" } }).options("/*", handler)
                  .get("", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy REST request" } }).post("", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy REST request" } }).put("", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy REST request" } }).patch("", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy REST request" } }).delete("", handler, { detail: { tags: ["sdk-proxy"], summary: "Proxy REST request" } }).options("", handler);
    });

const graphqlHandler = async ({ request }: any) => {
    const ref = await getProjectRef(request);
    if (!ref) return new Response(JSON.stringify({ message: 'Missing tenant reference' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const ports = await getTenantPorts(ref);
    if (!ports) return new Response(JSON.stringify({ message: 'Tenant backend not active' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    
    const url = new URL(request.url);
    const targetUrl = `http://127.0.0.1:${ports.pgrstPort}/rpc/graphql${url.search}`;
    
    return executeProxy(request, targetUrl, {
        ref,
        host: resolveProjectApiHost(ref, undefined),
        timeoutMs: config.restProxyTimeoutMs,
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
    const [edgeHost, edgePortStr] = (config.edgeRuntimeInternal || "127.0.0.1:9005").split(':');
    const edgePort = parseInt(edgePortStr, 10) || 9005;

    const url = new URL(request.url);
    // Preserve the /functions/v1 prefix when forwarding to edge-runtime.
    // The runtime exposes both /functions/v1/:slug and bare /:slug routes, but
    // stripping the prefix causes function names like "health" to collide with
    // runtime diagnostics endpoints such as /health.
    const targetUrl = `http://${edgeHost}:${edgePort}${url.pathname}${url.search}`;

    return executeProxy(request, targetUrl, { ref });
};

export const sdkProxyRoutes = sdkProxyRoutesBase
    .get("/graphql/v1", graphqlHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy GraphQL request" } })
    .post("/graphql/v1", graphqlHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy GraphQL request" } })
    .options("/graphql/v1", graphqlHandler)
    .group("/graphql/v1", (app) => app.get("/*", graphqlHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy GraphQL request" } }).post("/*", graphqlHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy GraphQL request" } }).options("/*", graphqlHandler))
    .group("/realtime/v1", (app) => {
        return app.get("/*", realtimeHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Realtime request" } }).post("/*", realtimeHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Realtime request" } }).put("/*", realtimeHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Realtime request" } }).patch("/*", realtimeHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Realtime request" } }).delete("/*", realtimeHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Realtime request" } }).options("/*", realtimeHandler)
                  .get("", realtimeHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Realtime request" } }).post("", realtimeHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Realtime request" } }).put("", realtimeHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Realtime request" } }).patch("", realtimeHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Realtime request" } }).delete("", realtimeHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Realtime request" } }).options("", realtimeHandler);
    })
    .group("/functions/v1", (app) => app.get("/*", functionsHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Edge Function request" } }).post("/*", functionsHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Edge Function request" } }).put("/*", functionsHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Edge Function request" } }).patch("/*", functionsHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Edge Function request" } }).delete("/*", functionsHandler, { detail: { tags: ["sdk-proxy"], summary: "Proxy Edge Function request" } }).options("/*", functionsHandler));
