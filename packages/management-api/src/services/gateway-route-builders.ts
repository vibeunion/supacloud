import { config } from "../config";
import {
    type ProjectRoutingConfig,
    normalizeProjectRoutingConfig,
    resolveProjectApiHosts,
    resolveProjectAuthHost,
    resolveProjectStudioHost,
} from "../utils/project-routing";
import { uniqueStrings } from "../utils/strings";

export type CaddyHeaderValue = string | string[];
export type CaddyRoute = Record<string, unknown>;
export type CaddyMatcher = Record<string, unknown>;
export type CustomGatewayProtocol = "http" | "https";
export type CustomGatewayManagedUpstream = "edge-functions";
export type CustomGatewayRedirectStatus = 301 | 302 | 307 | 308;
export const MAX_CUSTOM_GATEWAY_HOSTS = 20;
// Hosted applications can exceed twenty exact paths; keep the larger Caddy matcher bounded.
export const MAX_CUSTOM_GATEWAY_PATHS = 32;

export interface CustomGatewayRouteConfig {
    id: string;
    hosts: string[];
    path: string | string[];
    upstream?: string;
    managed_upstream?: CustomGatewayManagedUpstream;
    upstream_tls_insecure_skip_verify?: boolean;
    static_root?: string;
    spa?: boolean;
    protocol?: CustomGatewayProtocol;
    redirect_to?: string;
    redirect_status?: CustomGatewayRedirectStatus;
    rewrite_uri?: string;
    strip_prefix?: string;
    headers?: Record<string, string>;
    cors?: string[];
    priority?: number;
    enabled?: boolean;
}

export const DEFAULT_CORS_HEADERS = [
    "Accept", "Accept-Language", "Authorization", "Content-Language", "Content-Type",
    "apikey", "x-client-info", "x-project-ref", "X-Api-Version", "x-supabase-api-version",
    "Prefer", "Content-Profile", "accept-profile", "Range", "Range-Unit",
    "x-upsert", "Cache-Control", "x-retry-count", "x-metadata",
    "tus-resumable", "upload-length", "upload-offset", "upload-metadata",
    "x-supacloud-async", "x-supacloud-timeout", "x-supacloud-retries",
    "Idempotency-Key", "x-supacloud-idempotency-key", "x-supacloud-function-version",
    "x-supacloud-trace-id", "x-supacloud-correlation-id",
    "x-supacloud-business-task-id", "x-supacloud-task-metadata",
    "x-request-id", "x-idempotency-key", "traceparent", "tracestate", "baggage",
];

export const DEFAULT_CORS_EXPOSED = [
    "Content-Length", "Content-Range", "X-Content-Range", "X-JSON",
    "x-supabase-api-version", "X-Client-Info", "Prefer",
    "Content-Profile", "accept-profile", "Range", "Range-Unit",
    "X-Relay-Error", "link", "x-total-count", "Content-Disposition", "Retry-After",
    "x-request-id", "x-supacloud-trace-id", "x-supacloud-correlation-id", "traceparent",
];

export const DEFAULT_CORS_ORIGINS = [
    "~^https?://.*\\.dbbaby\\.top$",
    "~^https?://localhost(:[0-9]+)?$",
    "~^https?://127\\.0\\.0\\.1(:[0-9]+)?$",
];

const WILDCARD_CORS_ORIGIN = "*";

const UPSTREAM_CORS_RESPONSE_HEADERS = [
    "Access-Control-Allow-Origin",
    "Access-Control-Allow-Credentials",
    "Access-Control-Allow-Methods",
    "Access-Control-Allow-Headers",
    "Access-Control-Expose-Headers",
    "Access-Control-Max-Age",
] as const;

const RESERVED_CUSTOM_PROXY_REQUEST_HEADERS = new Set([
    "x-project-ref",
    "x-supabase-project",
    "x-supacloud-internal-auth",
    "x-supacloud-internal-token",
]);

function hostToCorsOrigins(host: string): string[] {
    const trimmed = host.trim();
    if (!trimmed) return [];
    try {
        const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
        if (!parsed.host) return [];
        const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
        if (
            parsed.host.startsWith("localhost")
            || parsed.host.startsWith("127.0.0.1")
            || hostname.includes(":")
            || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
        ) {
            return [`http://${parsed.host}`, `https://${parsed.host}`];
        }
        return [`https://${parsed.host}`];
    } catch {
        return [];
    }
}

export function buildTenantCorsOrigins(
    projectRef: string,
    projectRouting?: ProjectRoutingConfig | string,
    extraHosts: string[] = [],
): string[] {
    const routingConfig = normalizeProjectRoutingConfig(projectRouting);
    const customDomain = typeof routingConfig?.custom_domain === "string"
        ? routingConfig.custom_domain
        : undefined;
    const hosts = [
        ...resolveProjectApiHosts(projectRef, routingConfig),
        resolveProjectAuthHost(projectRef, routingConfig),
        `studio-${projectRef}.${config.baseDomain}`,
        resolveProjectStudioHost(projectRef, routingConfig),
        ...(customDomain ? [customDomain] : []),
        config.dockerHostIp,
        ...extraHosts,
    ];
    return uniqueStrings([...DEFAULT_CORS_ORIGINS, ...hosts.flatMap(hostToCorsOrigins)]);
}

export function normalizeCaddyHost(host: string): string {
    return host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/:\d+$/, "");
}

export function caddyDial(upstream: string): string {
    return upstream.replace(/^https?:\/\//, "").split("/")[0] || upstream;
}

export function sanitizeCaddyId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function customGatewayRouteId(projectRef: string, routeId: string): string {
    return `route-custom-gateway-${projectRef}-${sanitizeCaddyId(routeId)}`;
}

export function isCustomGatewayRouteId(projectRef: string, routeId: string): boolean {
    return routeId.startsWith(`route-custom-gateway-${projectRef}-`);
}

function normalizeCustomPath(pathValue: string): string {
    const value = String(pathValue || "").trim();
    if (!value.startsWith("/") || value.includes("://") || /[\r\n\t]/.test(value)) {
        throw new Error("Custom route path must start with / and must not contain a URL or control characters");
    }
    return value;
}

function normalizeCustomStaticRoot(root: string): string {
    const value = String(root || "").trim();
    if (!value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) {
        throw new Error("Custom route static_root must be an absolute path without traversal segments");
    }
    return value.replace(/\/+$/, "") || "/";
}

function normalizeCustomRewriteUri(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const normalized = String(value || "").trim();
    if (!normalized) return undefined;
    if (!normalized.startsWith("/") || /[\r\n\t]/.test(normalized) || normalized.includes("://")) {
        throw new Error("Custom route rewrite_uri must start with / and must not contain a URL or control characters");
    }
    return normalized;
}

function normalizeCustomStripPrefix(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const normalized = normalizeCustomPath(value).replace(/\/+$/, "");
    return normalized || "/";
}

function normalizeCustomProtocol(value: CustomGatewayProtocol | undefined): CustomGatewayProtocol | undefined {
    if (value === undefined) return undefined;
    if (value !== "http" && value !== "https") {
        throw new Error("Custom route protocol must be http or https");
    }
    return value;
}

function normalizeCustomRedirectTo(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const normalized = String(value || "").trim();
    if (!normalized || /[\r\n\t\0]/.test(normalized)) {
        throw new Error("Custom route redirect_to is invalid");
    }

    const requestUriPlaceholder = "{http.request.uri}";
    const placeholderIndex = normalized.indexOf(requestUriPlaceholder);
    if (placeholderIndex >= 0 && (
        normalized.lastIndexOf(requestUriPlaceholder) !== placeholderIndex
        || placeholderIndex + requestUriPlaceholder.length !== normalized.length
    )) {
        throw new Error("Custom route redirect_to only supports one trailing {http.request.uri} placeholder");
    }
    const testableUrl = placeholderIndex >= 0
        ? normalized.slice(0, placeholderIndex)
        : normalized;
    if (/[{}]/.test(testableUrl)) {
        throw new Error("Custom route redirect_to only supports the {http.request.uri} placeholder");
    }
    try {
        const parsed = new URL(testableUrl);
        if (!/^https?:$/.test(parsed.protocol) || !parsed.host || parsed.username || parsed.password) {
            throw new Error("invalid redirect URL");
        }
    } catch {
        throw new Error("Custom route redirect_to must be an absolute http(s) URL");
    }
    return normalized;
}

function normalizeCustomRedirectStatus(
    value: CustomGatewayRedirectStatus | undefined,
    hasRedirect: boolean,
): CustomGatewayRedirectStatus | undefined {
    if (value === undefined) return hasRedirect ? 308 : undefined;
    if (!hasRedirect) throw new Error("Custom route redirect_status requires redirect_to");
    if (![301, 302, 307, 308].includes(value)) {
        throw new Error("Custom route redirect_status must be one of 301, 302, 307 or 308");
    }
    return value;
}

export function normalizeCustomUpstream(upstream: string): { dial: string; tls: boolean } {
    const value = String(upstream || "").trim();
    if (!value || /[\r\n\t]/.test(value)) throw new Error("Custom route upstream is invalid");
    if (/^https?:\/\//i.test(value)) {
        const parsed = new URL(value);
        if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
            throw new Error("Custom route upstream URL must not include path, query, or hash");
        }
        const tls = parsed.protocol === "https:";
        return { dial: `${parsed.hostname}:${parsed.port || (tls ? "443" : "80")}`, tls };
    }
    if (value.includes("/") || !/^[^:]+:\d+$/.test(value)) {
        throw new Error("Custom route upstream must be host:port or an http(s)://host[:port] URL");
    }
    return { dial: value, tls: false };
}

function normalizeCustomManagedUpstream(
    value: CustomGatewayManagedUpstream | undefined,
): CustomGatewayManagedUpstream | undefined {
    if (value === undefined) return undefined;
    if (value !== "edge-functions") {
        throw new Error("Custom route managed_upstream must be edge-functions");
    }
    return value;
}

function normalizeCustomHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!headers) return undefined;
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        const header = key.trim();
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header)) {
            throw new Error(`Invalid custom route header name: ${key}`);
        }
        if (/[\r\n]/.test(String(value))) throw new Error(`Invalid custom route header value for ${key}`);
        normalized[header] = String(value);
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeCustomProxyHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
    const normalized = normalizeCustomHeaders(headers);
    for (const header of Object.keys(normalized || {})) {
        if (RESERVED_CUSTOM_PROXY_REQUEST_HEADERS.has(header.toLowerCase())) {
            throw new Error(`Custom proxy route headers must not override reserved header: ${header}`);
        }
    }
    return normalized;
}

export function normalizeCustomGatewayRoute(input: CustomGatewayRouteConfig): CustomGatewayRouteConfig {
    const id = String(input.id || "").trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        throw new Error("Custom route id must be 1-64 characters of letters, numbers, _ or -");
    }

    const hosts = uniqueStrings((input.hosts || []).map(normalizeCaddyHost).filter(Boolean));
    if (hosts.length === 0 || hosts.length > MAX_CUSTOM_GATEWAY_HOSTS) {
        throw new Error(`Custom route requires 1-${MAX_CUSTOM_GATEWAY_HOSTS} hosts`);
    }
    const normalizedPaths = uniqueStrings((Array.isArray(input.path) ? input.path : [input.path]).map(normalizeCustomPath));
    if (normalizedPaths.length === 0 || normalizedPaths.length > MAX_CUSTOM_GATEWAY_PATHS) {
        throw new Error(`Custom route requires 1-${MAX_CUSTOM_GATEWAY_PATHS} paths`);
    }

    const hasUpstream = typeof input.upstream === "string" && input.upstream.trim().length > 0;
    const managedUpstream = normalizeCustomManagedUpstream(input.managed_upstream);
    const hasManagedUpstream = managedUpstream !== undefined;
    const hasStaticRoot = typeof input.static_root === "string" && input.static_root.trim().length > 0;
    const redirectTo = normalizeCustomRedirectTo(input.redirect_to);
    const hasRedirect = typeof redirectTo === "string";
    if ([hasUpstream, hasManagedUpstream, hasStaticRoot, hasRedirect].filter(Boolean).length !== 1) {
        throw new Error("Custom route must set exactly one of upstream, managed_upstream, static_root or redirect_to");
    }
    if (input.spa === true && !hasStaticRoot) {
        throw new Error("Custom route spa option requires static_root");
    }

    const rewriteUri = normalizeCustomRewriteUri(input.rewrite_uri);
    const stripPrefix = normalizeCustomStripPrefix(input.strip_prefix);
    if (rewriteUri && stripPrefix) throw new Error("Custom route must not set both rewrite_uri and strip_prefix");
    if (hasRedirect && (rewriteUri || stripPrefix)) {
        throw new Error("Custom redirect routes must not set rewrite_uri or strip_prefix");
    }
    if (hasRedirect && Object.keys(input.headers || {}).some((key) => key.trim().toLowerCase() === "location")) {
        throw new Error("Custom redirect routes must not override the Location header");
    }
    const headers = hasUpstream || hasManagedUpstream
        ? normalizeCustomProxyHeaders(input.headers)
        : normalizeCustomHeaders(input.headers);
    const firstPath = normalizedPaths[0];
    if (firstPath === undefined) throw new Error("Custom route path is missing");
    const upstream = hasUpstream && input.upstream !== undefined ? input.upstream.trim() : undefined;
    const staticRoot = hasStaticRoot && input.static_root !== undefined
        ? normalizeCustomStaticRoot(input.static_root) : undefined;
    const protocol = normalizeCustomProtocol(input.protocol);
    const redirectStatus = normalizeCustomRedirectStatus(input.redirect_status, hasRedirect);
    const cors = input.cors
        ? uniqueStrings(input.cors.map((origin) => origin.trim()).filter(Boolean)).slice(0, 50) : undefined;

    return {
        id,
        hosts,
        path: Array.isArray(input.path) ? normalizedPaths : firstPath,
        ...(upstream === undefined ? {} : { upstream }),
        ...(managedUpstream === undefined ? {} : { managed_upstream: managedUpstream }),
        upstream_tls_insecure_skip_verify: input.upstream_tls_insecure_skip_verify === true,
        ...(staticRoot === undefined ? {} : { static_root: staticRoot }),
        ...(hasStaticRoot && input.spa === true ? { spa: true } : {}),
        ...(protocol === undefined ? {} : { protocol }),
        ...(redirectTo === undefined ? {} : { redirect_to: redirectTo }),
        ...(redirectStatus === undefined ? {} : { redirect_status: redirectStatus }),
        ...(rewriteUri === undefined ? {} : { rewrite_uri: rewriteUri }),
        ...(stripPrefix === undefined ? {} : { strip_prefix: stripPrefix }),
        ...(headers === undefined ? {} : { headers }),
        ...(cors === undefined ? {} : { cors }),
        priority: Number.isFinite(input.priority) ? Math.trunc(input.priority || 0) : 0,
        enabled: input.enabled ?? true,
    };
}

export function normalizeCustomGatewayRoutes(value: unknown): CustomGatewayRouteConfig[] {
    if (!Array.isArray(value)) return [];
    return value.map((route) => normalizeCustomGatewayRoute(route as CustomGatewayRouteConfig));
}

export function makeCorsHeaderHandler(wildcard = false) {
    return {
        handler: "headers",
        response: {
            set: {
                "Access-Control-Allow-Origin": [wildcard ? WILDCARD_CORS_ORIGIN : "{http.request.header.Origin}"],
                ...(wildcard ? {} : { "Access-Control-Allow-Credentials": ["true"] }),
                "Access-Control-Allow-Methods": ["GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD"],
                "Access-Control-Allow-Headers": [DEFAULT_CORS_HEADERS.join(", ")],
                "Access-Control-Expose-Headers": [DEFAULT_CORS_EXPOSED.join(", ")],
                "Access-Control-Max-Age": ["86400"],
                "Vary": ["Origin, Access-Control-Request-Headers, Accept-Encoding"],
            },
        },
    };
}

function makeCorsOriginMatchers(origins: string[], extra: CaddyMatcher = {}): CaddyMatcher[] {
    const wildcard = origins.some((origin) => origin.trim() === WILDCARD_CORS_ORIGIN);
    const exactOrigins = uniqueStrings(origins
        .map((origin) => origin.trim())
        .filter((origin) => origin && origin !== WILDCARD_CORS_ORIGIN && !origin.startsWith("~")));
    const regexOrigins = origins
        .map((origin) => origin.trim())
        .filter((origin) => origin.startsWith("~"))
        .map((origin) => origin.slice(1).trim())
        .filter(Boolean);

    const matchers: CaddyMatcher[] = [];
    if (wildcard) matchers.push({ ...extra, header_regexp: { Origin: { name: "cors_any_origin", pattern: ".+" } } });
    if (exactOrigins.length > 0) matchers.push({ ...extra, header: { Origin: exactOrigins } });
    if (regexOrigins.length > 0) {
        matchers.push({
            ...extra,
            header_regexp: {
                Origin: {
                    name: "cors_origin",
                    pattern: regexOrigins.map((pattern) => `(?:${pattern})`).join("|"),
                },
            },
        });
    }
    return matchers;
}

export function makeCorsSubroute(origins: string[]): Record<string, unknown> | null {
    const wildcard = origins.some((origin) => origin.trim() === WILDCARD_CORS_ORIGIN);
    const preflightMatchers = makeCorsOriginMatchers(origins, { method: ["OPTIONS"] });
    const originMatchers = makeCorsOriginMatchers(origins);
    if (preflightMatchers.length === 0 && originMatchers.length === 0) return null;

    const routes: CaddyRoute[] = [];
    if (preflightMatchers.length > 0) {
        routes.push({
            match: preflightMatchers,
            handle: [makeCorsHeaderHandler(wildcard), { handler: "static_response", status_code: 204 }],
            terminal: true,
        });
    }
    if (originMatchers.length > 0) {
        routes.push({ match: originMatchers, handle: [makeCorsHeaderHandler(wildcard)] });
    }
    return { handler: "subroute", routes };
}

export function makeFunctionCorsErrorFallback(origins: string[]) {
    const matcher = makeCorsOriginMatchers(origins);
    const wildcard = origins.some((origin) => origin.trim() === WILDCARD_CORS_ORIGIN);
    const { Vary, ...headers } = makeCorsHeaderHandler(wildcard).response.set;
    const corsHandler = {
        handler: "headers",
        response: {
            set: headers,
            add: { Vary },
            ...(wildcard ? { delete: ["Access-Control-Allow-Credentials"] } : {}),
            require: { status_code: [5], headers: { "Access-Control-Allow-Origin": null } },
        },
    };
    // A non-terminal subroute wraps the remaining handler chain, including the
    // proxy. Deferred headers cover upstream 5xx; errors cover transport errors.
    return {
        handler: "subroute",
        routes: matcher.length ? [{ match: matcher, handle: [corsHandler] }] : [],
        errors: {
            routes: [
                ...(matcher.length ? [{ match: matcher, handle: [corsHandler] }] : []),
                {
                    handle: [{
                        handler: "static_response",
                        status_code: "{http.error.status_code}",
                        headers: { "Content-Type": ["application/json"], "Cache-Control": ["no-store"] },
                        body: '{"error":"FUNCTION_GATEWAY_ERROR","message":"Function upstream unavailable"}',
                    }],
                    terminal: true,
                },
            ],
        },
    };
}

function isFunctionCorsErrorFallback(handler: Record<string, unknown>): boolean {
    return handler["handler"] === "subroute" && "errors" in handler;
}

function isCorsHeaderHandler(handler: Record<string, unknown>): boolean {
    return handler["handler"] === "headers"
        && typeof (handler["response"] as any)?.set?.["Access-Control-Allow-Origin"] !== "undefined";
}

export function isCorsSubroute(handler: Record<string, unknown>): boolean {
    if (isFunctionCorsErrorFallback(handler)) return false;
    if (handler["handler"] !== "subroute" || !Array.isArray(handler["routes"])) return false;
    return handler["routes"].some((route: any) =>
        Array.isArray(route?.handle) && route.handle.some((item: any) => isCorsHeaderHandler(item)),
    );
}

/**
 * Routes whose upstream owns the CORS policy (functions, storage) keep the
 * upstream access-control-* headers instead of deleting them at the gateway.
 */
export function routePreservesUpstreamCors(route: CaddyRoute): boolean {
    const handle = Array.isArray(route["handle"]) ? route["handle"] as Array<Record<string, any>> : [];
    return handle.some((handler) => {
        if (handler?.["handler"] !== "reverse_proxy") return false;
        const deletions = handler?.["headers"]?.response?.delete;
        return !(Array.isArray(deletions) && deletions.includes("Access-Control-Allow-Origin"));
    });
}

export function setRouteCors(route: CaddyRoute, origins: string[]): void {
    // Custom routes own their policy, including deliberately omitting CORS.
    // Tenant/frontend reconciliation must not replace that persisted policy.
    if (String(route["@id"] || "").startsWith("route-custom-gateway-")) return;
    if (String(route["@id"] || "").startsWith("route-project-")
        && String(route["@id"]).endsWith("-functions")) {
        const handle = Array.isArray(route["handle"]) ? route["handle"] as Record<string, unknown>[] : [];
        if (config.edgeFunctionsCorsMode === "auto") {
            const proxy = handle.find((handler) => handler["handler"] === "reverse_proxy");
            if (proxy) {
                const headers = proxy["headers"] && typeof proxy["headers"] === "object" && !Array.isArray(proxy["headers"])
                    ? proxy["headers"] as Record<string, unknown>
                    : {};
                const response = headers["response"] && typeof headers["response"] === "object" && !Array.isArray(headers["response"])
                    ? headers["response"] as Record<string, unknown>
                    : {};
                response["delete"] = [...UPSTREAM_CORS_RESPONSE_HEADERS];
                headers["response"] = response;
                proxy["headers"] = headers;
            }
            const corsSubroute = makeCorsSubroute(origins);
            route["handle"] = corsSubroute
                ? [corsSubroute, ...handle.filter((handler) =>
                    !isFunctionCorsErrorFallback(handler) && !isCorsHeaderHandler(handler) && !isCorsSubroute(handler))]
                : handle.filter((handler) =>
                    !isFunctionCorsErrorFallback(handler) && !isCorsHeaderHandler(handler) && !isCorsSubroute(handler));
            return;
        }
        route["handle"] = [
            makeFunctionCorsErrorFallback(origins),
            ...handle.filter((handler) => !isFunctionCorsErrorFallback(handler)
                && !isCorsHeaderHandler(handler) && !isCorsSubroute(handler)),
        ];
        return;
    }
    // Routes that preserve upstream CORS (functions, storage) answer preflight
    // themselves; never re-attach the gateway CORS subroute to them.
    if (routePreservesUpstreamCors(route)) return;
    const corsSubroute = makeCorsSubroute(origins);
    const handle = Array.isArray(route["handle"]) ? route["handle"] as Record<string, unknown>[] : [];
    const withoutCors = handle.filter((handler) => !isCorsHeaderHandler(handler) && !isCorsSubroute(handler));
    route["handle"] = corsSubroute ? [corsSubroute, ...withoutCors] : withoutCors;
}

export function makeReverseProxy(
    upstream: string,
    headers: Record<string, CaddyHeaderValue>,
    readTimeoutMs?: number,
    preserveUpstreamCors?: boolean,
    streaming?: boolean,
    upstreamTls?: boolean,
    upstreamTlsInsecureSkipVerify?: boolean,
): Record<string, unknown> {
    const responseHeaders: Record<string, unknown> = {};
    if (!preserveUpstreamCors) responseHeaders["delete"] = [...UPSTREAM_CORS_RESPONSE_HEADERS];
    const proxy: Record<string, unknown> = {
        handler: "reverse_proxy",
        upstreams: [{ dial: caddyDial(upstream) }],
        headers: {
            request: {
                set: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value : [value]])),
            },
        },
        transport: {
            protocol: "http",
            read_timeout: `${Math.ceil((readTimeoutMs || 500_000) / 1000)}s`,
            write_timeout: "500s",
        },
    };
    if (upstreamTls) {
        (proxy["transport"] as Record<string, unknown>)["tls"] = upstreamTlsInsecureSkipVerify
            ? { insecure_skip_verify: true }
            : {};
    }
    if (Object.keys(responseHeaders).length > 0) {
        (proxy["headers"] as Record<string, unknown>)["response"] = responseHeaders;
    }
    if (streaming !== false) proxy["flush_interval"] = -1;
    return proxy;
}

export function makeStaticFileServer(root: string): Record<string, unknown> {
    return {
        handler: "file_server",
        root,
        index_names: ["index.html"],
        precompressed: { br: {}, zstd: {}, gzip: {} },
        precompressed_order: ["br", "zstd", "gzip"],
        hide: [".git", ".env", "deployment.json"],
    };
}

export function makeCustomGatewayRoute(projectRef: string, input: CustomGatewayRouteConfig): CaddyRoute | null {
    const route = normalizeCustomGatewayRoute(input);
    if (route.enabled === false) return null;

    const handle: Record<string, unknown>[] = [];
    const corsSubroute = route.cors ? makeCorsSubroute(route.cors) : null;
    if (corsSubroute) handle.push(corsSubroute);

    if (route.upstream || route.managed_upstream) {
        const upstream = normalizeCustomUpstream(
            route.managed_upstream === "edge-functions" ? config.edgeRuntimeInternal : route.upstream!,
        );
        const headers: Record<string, CaddyHeaderValue> = {
            Host: "{http.request.host}",
            "X-Project-Ref": projectRef,
            "x-project-ref": projectRef,
            "X-Forwarded-Host": "{http.request.host}",
            "X-Forwarded-Proto": "{http.request.scheme}",
            ...route.headers,
        };
        if (route.rewrite_uri) handle.push({ handler: "rewrite", uri: route.rewrite_uri });
        else if (route.strip_prefix) handle.push({ handler: "rewrite", strip_path_prefix: route.strip_prefix });
        handle.push(makeReverseProxy(
            upstream.dial,
            headers,
            500_000,
            false,
            true,
            upstream.tls,
            route.upstream ? route.upstream_tls_insecure_skip_verify : false,
        ));
    } else if (route.static_root) {
        if (route.headers && Object.keys(route.headers).length > 0) {
            handle.push({
                handler: "headers",
                response: {
                    set: Object.fromEntries(Object.entries(route.headers).map(([key, value]) => [key, [value]])),
                },
            });
        }
        if (route.rewrite_uri) handle.push({ handler: "rewrite", uri: route.rewrite_uri });
        else if (route.strip_prefix) handle.push({ handler: "rewrite", strip_path_prefix: route.strip_prefix });
        if (route.spa) {
            handle.push({
                handler: "subroute",
                routes: [
                    {
                        match: [
                            {
                                file: {
                                    root: route.static_root,
                                    try_files: ["{http.request.uri.path}", "{http.request.uri.path}/", "/index.html"],
                                },
                            },
                        ],
                        handle: [
                            {
                                handler: "rewrite",
                                uri: "{http.matchers.file.relative}",
                            },
                        ],
                    },
                    makeStaticFileServer(route.static_root),
                ],
            });
        } else {
            handle.push(makeStaticFileServer(route.static_root));
        }
    } else if (route.redirect_to) {
        const responseHeaders = Object.fromEntries(
            Object.entries(route.headers || {}).map(([key, value]) => [key, [value]]),
        );
        responseHeaders["Location"] = [route.redirect_to];
        handle.push({
            handler: "static_response",
            headers: responseHeaders,
            status_code: route.redirect_status || 308,
        });
    } else {
        return null;
    }

    const match: CaddyMatcher = {
        host: route.hosts,
        path: Array.isArray(route.path) ? route.path : [route.path],
    };
    if (route.protocol) {
        match["vars"] = {
            "{http.request.scheme}": [route.protocol],
        };
    }

    return {
        "@id": customGatewayRouteId(projectRef, route.id),
        __supacloud_priority: route.priority || 0,
        match: [match],
        handle,
        terminal: true,
    };
}
