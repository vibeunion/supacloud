import { config } from "../config";
import { $ } from "bun";
import { logger } from "../utils/logger";
import { sql } from "../db";
import {
    type ProjectRoutingConfig,
    normalizeProjectRoutingConfig,
    resolveProjectApiHosts,
    resolveProjectAuthHost,
    resolveProjectStudioHost,
} from "../utils/project-routing";
import { normalizeProjectConfig, resolveExternalAuthEndpointConfig } from "../utils/project-config";
import { uniqueStrings } from "../utils/strings";
import { stableStringify } from "../utils/stable-json";
import { GOTRUE_USER_ID_POSTGRES_PATTERN } from "../utils/project-user-lifecycle";
import { assertUniqueCaddyIds, runCaddyStartupPreflight } from "./caddy-startup-preflight";
import { FRONTEND_GATEWAY_DURABILITY_UNKNOWN_CODE } from "./frontend-release-contract";
import {
    type CaddyHeaderValue,
    type CaddyRoute,
    type CustomGatewayRouteConfig,
    DEFAULT_CORS_ORIGINS,
    buildTenantCorsOrigins,
    isCustomGatewayRouteId,
    makeCorsSubroute,
    makeCustomGatewayRoute,
    makeReverseProxy,
    makeStaticFileServer,
    normalizeCaddyHost,
    normalizeCustomGatewayRoutes,
    normalizeCustomUpstream,
    sanitizeCaddyId,
    setRouteCors,
} from "./gateway-route-builders";
export {
    DEFAULT_CORS_EXPOSED,
    DEFAULT_CORS_HEADERS,
    DEFAULT_CORS_ORIGINS,
    MAX_CUSTOM_GATEWAY_HOSTS,
    MAX_CUSTOM_GATEWAY_PATHS,
    buildTenantCorsOrigins,
    normalizeCustomGatewayRoute,
    normalizeCustomGatewayRoutes,
} from "./gateway-route-builders";
export type { CustomGatewayRouteConfig } from "./gateway-route-builders";

import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface GatewayConfig {
    rateLimitTier?: "free" | "pro" | "enterprise";
    corsOrigins?: string;
    jwtEnabled?: boolean;
    jwtSecret?: string;
}

type CaddyLiveCandidateState = "candidate" | "different" | "unknown";
type CaddyGatewayDurabilityStage =
    | "candidate_sync"
    | "candidate_rename"
    | "config_directory_sync"
    | "notice_open"
    | "notice_write"
    | "notice_sync"
    | "notice_directory_sync";

class CaddyGatewayDurabilityError extends Error {
    readonly code = FRONTEND_GATEWAY_DURABILITY_UNKNOWN_CODE;
    readonly preserveCandidate = true;

    constructor(message: string) {
        super(message);
        this.name = "CaddyGatewayDurabilityError";
    }
}

function preservesGatewayCandidate(error: unknown): boolean {
    return error instanceof CaddyGatewayDurabilityError && error.preserveCandidate;
}

function fileErrorCode(error: unknown): string {
    return typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
}

function initializedMarkerPath(): string {
    return path.join(path.dirname(config.caddyConfigPath), "INITIALIZED");
}

function assertDurableCaddyConfig(candidate: unknown): asserts candidate is CaddyConfig {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new Error("Durable Caddy config must be a JSON object");
    }
    const routes = (candidate as CaddyConfig).apps?.http?.servers?.supacloud?.routes;
    if (!Array.isArray(routes)) {
        throw new Error("Durable Caddy config is missing the canonical route array");
    }
    assertUniqueCaddyIds(candidate);
}

interface RateLimitConfig {
    second: number;
    minute: number;
    hour: number;
}

const RATE_LIMIT_TIERS: Record<"free" | "pro" | "enterprise", RateLimitConfig> = {
    // 整体 API 限流需要容纳现代 SPA 的并发初始化请求，同时保留持续流量保护。
    free: { second: 60, minute: 3000, hour: 100000 },
    pro: { second: 300, minute: 18000, hour: 500000 },
    enterprise: { second: 1500, minute: 90000, hour: 3000000 },
};

const RATE_LIMIT_RING_CAPS: Record<keyof RateLimitConfig, number> = {
    second: 1500,
    minute: 1500,
    hour: 1500,
};

const RATE_LIMIT_WINDOW_MS: Record<keyof RateLimitConfig, number> = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
};

type GatewaySetupOptions = { functionsPort?: number; storagePort?: number; realtimeApiPort?: number; realtimeWsPort?: number };

export interface FrontendGatewayRoute {
    projectRef: string;
    deploymentId: string;
    hosts: string[];
    port?: number;
    root?: string;
    mode?: "proxy" | "static";
}

interface CaddyGatewayFileOperations {
    beforeDurabilityStage(stage: CaddyGatewayDurabilityStage): Promise<void>;
    persistLoadedCandidate(tmpPath: string): Promise<void>;
}

export interface CanonicalGatewayReconcileState {
    tenants: { success: boolean; updated: number; errors: string[] };
    hostedAuth: { success: boolean; error?: string };
    frontends: { total: number; configured: number; skipped: number; errors: string[] };
}

export interface CanonicalGatewayReconcileDependencies {
    gateway?: GatewayProvider;
    reconcileFrontends?: () => Promise<CanonicalGatewayReconcileState["frontends"]>;
}

export interface GatewayProvider {
    readonly name: "caddy";
    setupJwt(projectRef: string, jwtSecret: string): Promise<boolean>;
    enableJwtAuth(projectRef: string): Promise<boolean>;
    setIpRestriction(projectRef: string, allowedIps: string[]): Promise<boolean>;
    getRateLimit(projectRef: string): Promise<{ tier: string; second: number; minute: number; hour: number; enabled: boolean } | null>;
    setRateLimit(projectRef: string, opts?: string | { second?: number; minute?: number; hour?: number }): Promise<boolean>;
    setCustomRouteRateLimit(projectRef: string, basePath: string, limits: { second?: number; minute?: number; hour?: number }): Promise<boolean>;
    removeCustomRouteRateLimit(projectRef: string, basePath: string): Promise<boolean>;
    setCors(projectRef: string, origins?: string[]): Promise<boolean>;
    addCorsOriginsForHosts(projectRef: string, hosts: string[]): Promise<boolean>;
    setupUpstream(projectRef: string, pgrstPort: number | string, gotruePort: number | string, projectRouting?: ProjectRoutingConfig | string, opts?: GatewaySetupOptions): Promise<{ success: boolean; error?: string }>;
    addProjectDomains(projectRef: string, apiDomains: string[], studioDomains: string[]): Promise<boolean>;
    removeProjectDomains(projectRef: string, apiDomains: string[], studioDomains: string[]): Promise<boolean>;
    removeService(projectRef: string): Promise<{ success: boolean; error?: string }>;
    addUpstreamTarget(projectRef: string, replicaIp: string): Promise<{ success: boolean; error?: string }>;
    removeUpstreamTarget(projectRef: string, replicaIp: string): Promise<{ success: boolean; error?: string }>;
    applyConfig(projectRef: string, gatewayConfig: GatewayConfig): Promise<{ success: boolean; message: string }>;
    rebuildAllTenantConfigs(): Promise<{ success: boolean; updated: number; errors: string[] }>;
    prepareCleanRebuild(): Promise<void>;
    withDeferredPersist<T>(fn: () => Promise<T>, shouldFlush?: (result: T) => boolean): Promise<T>;
    configureCustomGatewayRoutes(projectRef: string, routes: CustomGatewayRouteConfig[]): Promise<{ success: boolean; error?: string }>;
    setupMasterRoutes(): Promise<void>;
    configureStudioDomain(domain: string, port: number): Promise<void>;
    upsertCertificateForSnis(opts: { projectRef: string; cert: string; key: string; snis: string[]; existingCertificateId?: string }): Promise<{ success: boolean; certificateId?: string; error?: string }>;
    configureFrontendRoute(route: FrontendGatewayRoute): Promise<void>;
    removeFrontendRoute(projectRef: string, deploymentId: string): Promise<void>;
    readFrontendStaticRoot(projectRef: string, deploymentId: string): Promise<string | null>;
    setupHostedAuthRoutes(): Promise<{ success: boolean; error?: string }>;
    ensureGatewayReady(opts?: { maxAttempts?: number; intervalMs?: number }): Promise<{ ready: boolean; error?: string }>;
    checkCaddyConnectivity(): Promise<boolean>;
    confirmCanonicalState(): Promise<void>;
}

function getRateLimitConfig(tier: string): RateLimitConfig {
    if (tier === "pro" || tier === "enterprise") return { ...RATE_LIMIT_TIERS[tier] };
    return { ...RATE_LIMIT_TIERS.free };
}

function hashStr(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

type CaddyServer = {
    listen: string[];
    tls_connection_policies?: Array<Record<string, unknown>>;
    routes: CaddyRoute[];
};

type CaddyConfig = {
    admin?: Record<string, unknown>;
    logging?: Record<string, unknown>;
    storage?: Record<string, unknown>;
    apps: {
        tls?: Record<string, unknown>;
        http: {
            servers: Record<string, CaddyServer>;
        };
    };
};

type CaddyMutableStateSnapshot = {
    routes: Map<string, CaddyRoute>;
    certs: Map<string, { certificate: string; key: string }>;
    rateLimits: Map<string, { tier: string; second: number; minute: number; hour: number; enabled: boolean }>;
    customRateLimits: Map<string, { second: number; minute: number; hour: number }>;
    hydrated: boolean;
};

type CaddyGatewayQuarantine = {
    candidate: CaddyConfig;
    previousSnapshot: CaddyMutableStateSnapshot;
};

type CaddyGatewayOperationContext = {
    token: object;
    previousSnapshot: CaddyMutableStateSnapshot;
};

const CADDY_GENERATED_CONFIG_NOTICE_LOG =
    "supacloud_notice_do_not_edit_caddy_config_json_use_supacloud_cli_management_api_or_web_console";
const CADDY_UNMATCHED_HOST_ROUTE_ID = "route-system-unmatched-host-404";

const CADDY_SENSITIVE_REQUEST_HEADERS = [
    "Apikey",
    "Authorization",
    "Cookie",
    "Proxy-Authorization",
    "X-Api-Key",
    "X-Auth-Token",
    "X-Supabase-Api-Key",
] as const;

export function caddySensitiveRequestLogEncoder(): Record<string, unknown> {
    return {
        format: "filter",
        wrap: { format: "json" },
        fields: Object.fromEntries(
            CADDY_SENSITIVE_REQUEST_HEADERS.map((header) => [
                `request>headers>${header}`,
                { filter: "replace", value: "REDACTED" },
            ]),
        ),
    };
}

function caddyGeneratedConfigNoticeLog(): Record<string, unknown> {
    return {
        writer: { output: "discard" },
        level: "INFO",
    };
}

function caddyGeneratedConfigNotice(configPath = config.caddyConfigPath): string {
    return [
        "SupaCloud generated Caddy configuration",
        "",
        `Do not edit ${configPath} by hand.`,
        "SupaCloud regenerates this Caddy JSON during route, domain, certificate, rate-limit, and frontend deployment reconciliation.",
        "Change via: supacloud CLI, SupaCloud management API, SupaCloud web console.",
        "",
    ].join("\n");
}

function caddyRouteId(projectRef: string, kind: string): string {
    return `route-project-${projectRef}-${kind}`;
}

function caddyAdminListen(): string {
    try {
        const url = new URL(config.caddyAdminUrl);
        const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
        const port = url.port || (url.protocol === "https:" ? "443" : "80");
        return `${host}:${port}`;
    } catch {
        return "127.0.0.1:2019";
    }
}

const CADDY_PROJECT_ROUTE_KINDS = [
    "opaque-rest",
    "opaque-graphql",
    "opaque-auth-domain",
    "opaque-auth",
    "auth-admin-user-delete",
    "rest-openapi",
    "rest",
    "graphql",
    "auth-domain-auth",
    "auth-domain-gotrue-well-known",
    "auth",
    "gotrue-well-known",
    "functions",
    "storage-resumable",
    "storage",
    "realtime-api",
    "realtime",
    "management",
    "acme",
    "studio",
];

export class CaddyGatewayProvider implements GatewayProvider {
    readonly name = "caddy" as const;
    private readonly routesById = new Map<string, CaddyRoute>();
    private readonly certsById = new Map<string, { certificate: string; key: string }>();
    private readonly rateLimits = new Map<string, { tier: string; second: number; minute: number; hour: number; enabled: boolean }>();
    private readonly customRateLimits = new Map<string, { second: number; minute: number; hour: number }>();
    private deferredPersistDepth = 0;
    private deferredPersistPending = false;
    private persistAndLoadTail: Promise<void> = Promise.resolve();
    private readonly operationContext = new AsyncLocalStorage<CaddyGatewayOperationContext>();
    private readonly operationToken = Object.freeze({});
    private operationTail: Promise<void> = Promise.resolve();
    private quarantine: CaddyGatewayQuarantine | null = null;
    private readonly fileOperations: CaddyGatewayFileOperations;
    private hydrated = false;

    constructor(fileOperations?: Partial<CaddyGatewayFileOperations>) {
        this.fileOperations = {
            beforeDurabilityStage: async () => undefined,
            persistLoadedCandidate: (tmpPath) => this.persistLoadedCandidate(tmpPath),
            ...fileOperations,
        };
    }

    private async caddyRequest(pathname: string, method = "GET", body?: unknown): Promise<Response> {
        return fetch(`${config.caddyAdminUrl}${pathname}`, {
            method,
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }

    async checkCaddyConnectivity(): Promise<boolean> {
        try {
            const res = await this.caddyRequest("/config/");
            if (res.ok || res.status === 404) return true;
            logger.warn(`[CaddyGatewayProvider] Caddy Admin API returned ${res.status}`);
            return false;
        } catch (error: unknown) {
            logger.warn(`[CaddyGatewayProvider] Caddy Admin API is not reachable: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    // Caddy may still be starting, restarting, or temporarily unreachable when Management
    // begins its fail-closed bootstrap. Wait for the Admin API, then publish and read back
    // the durable JSON before Management starts serving requests.
    async ensureGatewayReady(opts?: { maxAttempts?: number; intervalMs?: number }): Promise<{ ready: boolean; error?: string }> {
        return this.serializeOperation(() => this.ensureGatewayReadyUnlocked(opts));
    }

    private async ensureGatewayReadyUnlocked(opts?: { maxAttempts?: number; intervalMs?: number }): Promise<{ ready: boolean; error?: string }> {
        const maxAttempts = Math.max(1, Math.trunc(opts?.maxAttempts ?? 30));
        const intervalMs = Math.max(1, Math.trunc(opts?.intervalMs ?? 1000));
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const reachable = await this.checkCaddyConnectivity();
            if (reachable) {
                try {
                    await this.persistAndLoad();
                    const liveState = await this.liveCandidateState(this.baseConfig());
                    if (liveState !== "candidate") {
                        throw new Error(`Caddy config read-back is ${liveState}`);
                    }
                    logger.info(`[CaddyGatewayProvider] Gateway ready after ${attempt} attempt(s); JSON config applied`);
                    return { ready: true };
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.warn(`[CaddyGatewayProvider] Caddy reachable but config apply failed on attempt ${attempt}: ${message}`);
                    // caddy 可达但 /load 被拒（通常是配置校验失败），退避后重试可能仍失败；
                    // 为避免无限重试无效配置，在剩余尝试内继续，但错误会向上透传。
                    if (attempt >= maxAttempts) return { ready: false, error: message };
                }
            } else {
                logger.debug(`[CaddyGatewayProvider] Waiting for Caddy Admin API (attempt ${attempt}/${maxAttempts})`);
            }
            if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        return { ready: false, error: `Caddy Admin API not reachable after ${maxAttempts} attempts` };
    }

    private baseConfig(): CaddyConfig {
        const routes = Array.from(this.routesById.values())
            .sort((a, b) => this.compareRoutesForCaddy(a, b))
            .map((route) => this.renderRouteForCaddy(route));
        routes.push(this.makeUnmatchedHostRoute());

        return {
            admin: { listen: caddyAdminListen() },
            logging: {
                logs: {
                    default: {
                        encoder: caddySensitiveRequestLogEncoder(),
                    },
                    [CADDY_GENERATED_CONFIG_NOTICE_LOG]: caddyGeneratedConfigNoticeLog(),
                },
            },
            storage: { module: "file_system", root: config.caddyStateDir },
            apps: {
                tls: {
                    automation: {
                        on_demand: {
                            permission: {
                                module: "http",
                                endpoint: `http://${config.managementApiInternal}/v1/gateway/caddy/ask`,
                            },
                        },
                        policies: [
                            // ACME (Let's Encrypt) cannot validate domains that resolve
                            // to RFC1918 addresses; on LAN-only hosts the validators never
                            // reach the server, so tls-alpn-01/http-01 fail and HTTPS hangs.
                            // When the server listens on a private IP, use Caddy's internal
                            // CA so on-demand TLS works without an externally reachable host.
                            {
                                on_demand: true,
                                key_type: "p256",
                                ...(config.caddyTlsIssuer === "internal"
                                    ? { issuers: [{ module: "internal" }] }
                                    : {}),
                            },
                        ],
                    },
                    certificates: {
                        load_files: Array.from(this.certsById.values()),
                    },
                },
                http: {
                    servers: {
                        supacloud: {
                            listen: [":80", ":443"],
                            // Caddy JSON requires an explicit TLS policy to keep :443 in TLS mode after file reloads.
                            tls_connection_policies: [{}],
                            routes,
                        },
                    },
                },
            },
        };
    }

    private async readDurableConfig(): Promise<CaddyConfig | null> {
        let markerPresent = false;
        try {
            await fs.access(initializedMarkerPath());
            markerPresent = true;
        } catch (error: unknown) {
            if (fileErrorCode(error) !== "ENOENT") throw error;
        }

        let rawConfig: string;
        try {
            rawConfig = await fs.readFile(config.caddyConfigPath, "utf8");
        } catch (error: unknown) {
            if (fileErrorCode(error) !== "ENOENT") throw error;
            if (markerPresent) {
                throw new Error("Initialized Caddy config is missing from durable storage");
            }
            return null;
        }

        let parsedConfig: unknown;
        try {
            parsedConfig = JSON.parse(rawConfig);
        } catch {
            throw new Error("Durable Caddy config is malformed JSON");
        }
        assertDurableCaddyConfig(parsedConfig);
        return parsedConfig;
    }

    private async hydrateFromDisk(): Promise<void> {
        if (this.hydrated) return;
        const parsed = await this.readDurableConfig();
        if (parsed) {
            const routes = parsed.apps.http.servers.supacloud.routes;
            for (const route of routes) {
                const id = typeof route?.["@id"] === "string" ? route["@id"] : "";
                if (!id || id === CADDY_UNMATCHED_HOST_ROUTE_ID) continue;
                if (!this.routesById.has(id)) this.routesById.set(id, this.migrateHydratedRoute(id, route));
                this.hydrateRateLimitFromRoute(id, route);
            }
            this.hydrateCertificatesFromConfig(parsed);
        }
        this.hydrated = true;
    }

    private hydrateCertificatesFromConfig(parsed: CaddyConfig): void {
        const certs = (parsed.apps?.tls as Record<string, any> | undefined)?.certificates?.load_files;
        if (!Array.isArray(certs)) return;
        for (const cert of certs) {
            if (typeof cert?.certificate !== "string" || typeof cert?.key !== "string") continue;
            const id = `disk-${hashStr(`${cert.certificate}:${cert.key}`)}`;
            if (!this.certsById.has(id)) {
                this.certsById.set(id, { certificate: cert.certificate, key: cert.key });
            }
        }
    }

    private async hydrateCertificatesFromDisk(): Promise<void> {
        const parsed = await this.readDurableConfig();
        if (parsed) this.hydrateCertificatesFromConfig(parsed);
    }

    async prepareCleanRebuild(): Promise<void> {
        return this.serializeOperation(() => this.prepareCleanRebuildUnlocked());
    }

    private async prepareCleanRebuildUnlocked(): Promise<void> {
        await this.hydrateFromDiskIfUninitialized();
        await this.hydrateCertificatesFromDisk();
        const globalRoutes = Array.from(this.routesById.entries()).filter(([id]) =>
            id.startsWith("route-custom-gateway-_global-") || id.startsWith("route-frontend-_global-")
        );
        this.routesById.clear();
        for (const [id, route] of globalRoutes) this.routesById.set(id, route);
        this.rateLimits.clear();
        this.customRateLimits.clear();
        this.hydrated = true;
    }

    private async hydrateFromDiskIfUninitialized(): Promise<void> {
        if (this.routesById.size > 0 || this.certsById.size > 0 || this.rateLimits.size > 0 || this.customRateLimits.size > 0) {
            // Provider already has in-memory state from another path (setupUpstream, etc).
            // Latch hydrated so we never read disk later even if routes are temporarily removed.
            this.hydrated = true;
            return;
        }
        await this.hydrateFromDisk();
    }

    private migrateHydratedRoute(routeId: string, route: CaddyRoute): CaddyRoute {
        if (!routeId.startsWith("route-project-")) return route;
        const isStorageRoute = routeId.endsWith("-storage");
        const isFunctionsRoute = routeId.endsWith("-functions");
        if (!isStorageRoute && !isFunctionsRoute) return route;

        const projectRef = this.projectRefFromRouteId(routeId);
        if (!projectRef) return route;

        const migrated = JSON.parse(JSON.stringify(route)) as CaddyRoute;
        const handle = Array.isArray(migrated.handle) ? migrated.handle as Record<string, unknown>[] : [];
        const migratedHandle = isStorageRoute
            ? handle.filter((handler) => handler.strip_path_prefix !== "/storage/v1")
            : handle;
        migrated.handle = migratedHandle;

        const proxy = migratedHandle.find((handler) => handler.handler === "reverse_proxy") as Record<string, any> | undefined;
        if (!proxy) return migrated;

        const canonicalHost = `${projectRef}.api.${config.baseDomain}`;
        proxy.headers = proxy.headers && typeof proxy.headers === "object" ? proxy.headers : {};
        proxy.headers.request = proxy.headers.request && typeof proxy.headers.request === "object" ? proxy.headers.request : {};
        proxy.headers.request.set = proxy.headers.request.set && typeof proxy.headers.request.set === "object" ? proxy.headers.request.set : {};
        proxy.headers.request.set.Host = [canonicalHost];
        proxy.headers.request.set["X-Forwarded-Host"] = [canonicalHost];
        proxy.headers.request.set["X-Project-Ref"] = [projectRef];
        proxy.headers.request.set["x-project-ref"] = [projectRef];
        proxy.headers.request.set["X-Forwarded-Proto"] = ["{http.request.scheme}"];

        if (isStorageRoute) {
            proxy.headers.response = proxy.headers.response && typeof proxy.headers.response === "object" ? proxy.headers.response : {};
            delete proxy.headers.response.delete;
            delete proxy.flush_interval;
        }

        return migrated;
    }

    private hydrateRateLimitFromRoute(routeId: string, route: CaddyRoute): void {
        const handle = Array.isArray(route.handle) ? route.handle as Record<string, unknown>[] : [];
        const rateHandler = handle.find((handler) => handler.handler === "rate_limit");
        const limits = this.extractRateLimits(rateHandler);
        if (!limits) return;

        if (routeId.startsWith("route-custom-")) {
            this.customRateLimits.set(routeId, limits);
            return;
        }

        const projectRef = this.projectRefFromRouteId(routeId);
        if (projectRef && !this.rateLimits.has(projectRef)) {
            this.rateLimits.set(projectRef, { tier: "custom", ...limits, enabled: true });
        }
    }

    private extractRateLimits(handler: Record<string, unknown> | undefined): { second: number; minute: number; hour: number } | null {
        const zones = handler?.rate_limits;
        if (!zones || typeof zones !== "object") return null;

        const limits = { second: 0, minute: 0, hour: 0 };
        for (const [zoneName, zone] of Object.entries(zones as Record<string, any>)) {
            const window = String(zone?.window || "");
            const maxEvents = Number(zone?.max_events || 0);
            const encoded = zoneName.match(/_(second|minute|hour)_configured_([0-9]+(?:\.[0-9]+)?)$/);
            if (encoded) {
                const dimension = encoded[1] as keyof RateLimitConfig;
                const configuredMaxEvents = Number(encoded[2]);
                if (Number.isFinite(configuredMaxEvents) && configuredMaxEvents > 0) {
                    limits[dimension] = configuredMaxEvents;
                    continue;
                }
            }
            if (window === "1s") limits.second = maxEvents;
            if (window === "1m") limits.minute = maxEvents;
            if (window === "1h") limits.hour = maxEvents;
        }

        return limits.second || limits.minute || limits.hour ? limits : null;
    }

    private projectRefFromRouteId(routeId: string): string | null {
        if (!routeId.startsWith("route-project-")) return null;
        for (const kind of CADDY_PROJECT_ROUTE_KINDS) {
            const suffix = `-${kind}`;
            if (routeId.endsWith(suffix)) {
                return routeId.slice("route-project-".length, -suffix.length);
            }
        }
        return null;
    }

    private compareRoutesForCaddy(a: CaddyRoute, b: CaddyRoute): number {
        const aid = String(a["@id"] || "");
        const bid = String(b["@id"] || "");
        const aCustom = aid.startsWith("route-custom-") || aid.startsWith("route-hosted-") || aid.startsWith("route-supauth-");
        const bCustom = bid.startsWith("route-custom-") || bid.startsWith("route-hosted-") || bid.startsWith("route-supauth-");
        if (aCustom !== bCustom) return aCustom ? -1 : 1;

        const aPriority = typeof a.__supacloud_priority === "number" ? a.__supacloud_priority : 0;
        const bPriority = typeof b.__supacloud_priority === "number" ? b.__supacloud_priority : 0;
        if (aPriority !== bPriority) return bPriority - aPriority;

        const aPath = Array.isArray((a.match as any)?.[0]?.path) ? String((a.match as any)[0].path[0] || "") : "";
        const bPath = Array.isArray((b.match as any)?.[0]?.path) ? String((b.match as any)[0].path[0] || "") : "";
        if (aPath.length !== bPath.length) return bPath.length - aPath.length;

        const aProtocol = typeof (a.match as any)?.[0]?.protocol === "string";
        const bProtocol = typeof (b.match as any)?.[0]?.protocol === "string";
        if (aProtocol !== bProtocol) return aProtocol ? -1 : 1;
        return aid.localeCompare(bid);
    }

    private makeRateLimitHandler(projectRef: string, limits: { second: number; minute: number; hour: number }, suffix = "default"): Record<string, unknown> {
        const zones: Record<string, unknown> = {};
        const entries: Array<[keyof RateLimitConfig, number, string]> = [
            ["second", limits.second, "1s"],
            ["minute", limits.minute, "1m"],
            ["hour", limits.hour, "1h"],
        ];

        for (const [name, configuredMaxEvents, configuredWindow] of entries) {
            if (!Number.isFinite(configuredMaxEvents) || configuredMaxEvents <= 0) continue;

            // caddy-ratelimit stores one time.Time per max_event and client key.
            // Bound each per-IP ring, then shorten the window proportionally so
            // the configured sustained rate remains unchanged without OOM-sized
            // minute/hour buffers for high-capacity tiers.
            const ringCap = RATE_LIMIT_RING_CAPS[name];
            const maxEvents = Math.min(configuredMaxEvents, ringCap);
            const window = configuredMaxEvents > ringCap
                ? `${Math.max(1, Math.round(RATE_LIMIT_WINDOW_MS[name] * ringCap / configuredMaxEvents))}ms`
                : configuredWindow;
            zones[`supacloud_${sanitizeCaddyId(projectRef)}_${sanitizeCaddyId(suffix)}_${name}_configured_${configuredMaxEvents}`] = {
                key: "{http.request.remote.host}",
                window,
                max_events: maxEvents,
            };
        }

        return {
            handler: "rate_limit",
            rate_limits: zones,
        };
    }

    private projectRefForRoute(routeId: string): string | null {
        for (const projectRef of this.rateLimits.keys()) {
            if (routeId.startsWith(`route-project-${projectRef}-`)) return projectRef;
        }
        return this.projectRefFromRouteId(routeId);
    }

    private renderRouteForCaddy(route: CaddyRoute): CaddyRoute {
        const rendered = JSON.parse(JSON.stringify(route)) as CaddyRoute;
        delete rendered.__supacloud_priority;
        const id = String(rendered["@id"] || "");
        const handle = Array.isArray(rendered.handle) ? rendered.handle as Record<string, unknown>[] : [];
        const withoutRateLimit = handle.filter((handler) => handler.handler !== "rate_limit");

        const customLimits = this.customRateLimits.get(id);
        let rateLimitHandler: Record<string, unknown> | null = null;
        if (customLimits) {
            rateLimitHandler = this.makeRateLimitHandler(id, customLimits, "custom");
        } else {
            const projectRef = this.projectRefForRoute(id);
            const limit = projectRef ? this.rateLimits.get(projectRef) : undefined;
            const isApiRoute = id.startsWith("route-project-") && !id.endsWith("-acme") && !id.endsWith("-studio");
            if (projectRef && limit?.enabled && isApiRoute) {
                rateLimitHandler = this.makeRateLimitHandler(projectRef, limit, "api");
            }
        }

        if (rateLimitHandler) {
            const proxyIndex = withoutRateLimit.findIndex((handler) => handler.handler === "reverse_proxy");
            const insertAt = proxyIndex >= 0 ? proxyIndex : withoutRateLimit.length;
            withoutRateLimit.splice(insertAt, 0, rateLimitHandler);
            rendered.handle = withoutRateLimit;
        }

        return rendered;
    }

    private makeUnmatchedHostRoute(): CaddyRoute {
        return {
            "@id": CADDY_UNMATCHED_HOST_ROUTE_ID,
            handle: [{ handler: "static_response", status_code: 404 }],
            terminal: true,
        };
    }

    private async validateCandidateConfig(candidatePath: string, candidateConfig: CaddyConfig): Promise<void> {
        assertUniqueCaddyIds(candidateConfig);
        try {
            await fs.access(config.caddyBinaryPath);
        } catch {
            return;
        }

        const result = await $`${config.caddyBinaryPath} validate --config ${candidatePath}`.nothrow().quiet();
        if (result.exitCode !== 0) {
            const detail = result.stderr.toString() || result.stdout.toString();
            throw new Error(`Caddy config validation failed: ${detail.slice(0, 1000)}`);
        }
        await runCaddyStartupPreflight(config.caddyBinaryPath, candidatePath, candidateConfig);
    }

    private async liveCandidateState(candidateConfig: CaddyConfig): Promise<CaddyLiveCandidateState> {
        try {
            const response = await this.caddyRequest("/config/");
            if (!response.ok) return "unknown";
            const liveConfig = await response.json();
            return stableStringify(liveConfig) === stableStringify(candidateConfig) ? "candidate" : "different";
        } catch {
            return "unknown";
        }
    }

    private async persistLoadedCandidate(tmpPath: string): Promise<void> {
        const directoryPath = path.dirname(config.caddyConfigPath);
        await this.syncCandidateFile(tmpPath);
        await this.fileOperations.beforeDurabilityStage("candidate_rename");
        await fs.rename(tmpPath, config.caddyConfigPath);
        await this.fileOperations.beforeDurabilityStage("config_directory_sync");
        await this.syncCaddyConfigDirectory(directoryPath);
        await this.writeGeneratedConfigNotice(directoryPath);
        await this.fileOperations.beforeDurabilityStage("notice_directory_sync");
        await this.syncCaddyConfigDirectory(directoryPath);
    }

    private async syncCandidateFile(tmpPath: string): Promise<void> {
        const candidateFile = await fs.open(tmpPath, "r");
        try {
            await this.fileOperations.beforeDurabilityStage("candidate_sync");
            await candidateFile.sync();
        } finally {
            await candidateFile.close();
        }
    }

    private async writeGeneratedConfigNotice(directoryPath: string): Promise<void> {
        const noticePath = path.join(directoryPath, "DO-NOT-EDIT.txt");
        await this.fileOperations.beforeDurabilityStage("notice_open");
        const notice = await fs.open(noticePath, "w", 0o644);
        try {
            await this.fileOperations.beforeDurabilityStage("notice_write");
            await notice.writeFile(caddyGeneratedConfigNotice(), "utf8");
            await this.fileOperations.beforeDurabilityStage("notice_sync");
            await notice.sync();
        } finally {
            await notice.close();
        }
    }

    private async syncCaddyConfigDirectory(directoryPath: string): Promise<void> {
        const directory = await fs.open(directoryPath, "r");
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    }

    private async writeInitializedMarker(): Promise<void> {
        const directoryPath = path.dirname(config.caddyConfigPath);
        const markerPath = initializedMarkerPath();
        const temporaryPath = `${markerPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
        try {
            const markerFile = await fs.open(temporaryPath, "wx", 0o644);
            try {
                await markerFile.writeFile("supacloud-caddy-config-v1\n", "utf8");
                await markerFile.sync();
            } finally {
                await markerFile.close();
            }
            await fs.rename(temporaryPath, markerPath);
            await this.syncCaddyConfigDirectory(directoryPath);
        } catch (error: unknown) {
            await fs.unlink(temporaryPath).catch(() => undefined);
            throw error;
        }
    }

    async confirmCanonicalState(): Promise<void> {
        await this.serializeOperation(async () => {
            const durableConfig = await this.readDurableConfig();
            if (!durableConfig) throw new Error("Canonical Caddy config was not persisted");
            const liveState = await this.liveCandidateState(durableConfig);
            if (liveState !== "candidate") {
                throw new Error(`Canonical Caddy read-back is ${liveState}`);
            }
            await this.writeInitializedMarker();
        });
    }

    private throwQuarantinedCandidateError(candidate: CaddyConfig, message: string): never {
        const context = this.operationContext.getStore();
        if (!context || context.token !== this.operationToken) {
            throw new CaddyGatewayDurabilityError("Caddy mutation context could not be proven");
        }
        this.quarantine = { candidate, previousSnapshot: context.previousSnapshot };
        throw new CaddyGatewayDurabilityError(message);
    }

    private async writeAndLoadCurrentConfig(): Promise<void> {
        const next = this.baseConfig();
        await fs.mkdir(path.dirname(config.caddyConfigPath), { recursive: true });
        const tmpPath = `${config.caddyConfigPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await fs.writeFile(tmpPath, JSON.stringify(next, null, 2));

        try {
            await this.validateCandidateConfig(tmpPath, next);
            let response: Response;
            try {
                response = await this.caddyRequest("/load", "POST", next);
            } catch (loadError: unknown) {
                const state = await this.liveCandidateState(next);
                if (state === "different") throw loadError;
                if (state === "unknown") {
                    this.throwQuarantinedCandidateError(next, "Caddy candidate state could not be proven after load");
                }
                try {
                    await this.fileOperations.persistLoadedCandidate(tmpPath);
                } catch {
                    this.throwQuarantinedCandidateError(next, "Caddy candidate is live but its durable config could not be repaired");
                }
                return;
            }
            if (!response.ok) {
                const text = await response.text().catch(() => "");
                throw new Error(`Caddy /load failed with ${response.status}: ${text}`);
            }
            try {
                await this.fileOperations.persistLoadedCandidate(tmpPath);
            } catch {
                this.throwQuarantinedCandidateError(next, "Caddy candidate is live but its durable config could not be persisted");
            }
        } catch (error: unknown) {
            await fs.unlink(tmpPath).catch(() => undefined);
            throw error;
        }
    }

    private async persistAndLoad(): Promise<void> {
        if (this.deferredPersistDepth > 0) {
            this.deferredPersistPending = true;
            return;
        }

        await this.repairQuarantinedCandidate();
        const previous = this.persistAndLoadTail.catch(() => undefined);
        const current = previous.then(() => this.writeAndLoadCurrentConfig());
        this.persistAndLoadTail = current.catch(() => undefined);
        await current;
    }

    async withDeferredPersist<T>(fn: () => Promise<T>, shouldFlush: (result: T) => boolean = () => true): Promise<T> {
        return this.serializeOperation(() => this.withDeferredPersistUnlocked(fn, shouldFlush));
    }

    private async withDeferredPersistUnlocked<T>(fn: () => Promise<T>, shouldFlush: (result: T) => boolean): Promise<T> {
        const snapshot = this.mutableStateSnapshot();
        const pendingAtEntry = this.deferredPersistPending;
        this.deferredPersistDepth++;
        let completed = false;
        let accepted = false;
        let result: T;
        try {
            result = await fn();
            completed = true;
            accepted = shouldFlush(result);
            return result;
        } finally {
            this.deferredPersistDepth--;
            if (!completed || !accepted) {
                this.restoreMutableState(snapshot);
                this.deferredPersistPending = pendingAtEntry;
            } else if (this.deferredPersistDepth === 0) {
                const flush = this.deferredPersistPending;
                this.deferredPersistPending = false;
                if (flush) {
                    try {
                        await this.persistAndLoad();
                    } catch (error: unknown) {
                        if (!preservesGatewayCandidate(error)) this.restoreMutableState(snapshot);
                        throw error;
                    }
                }
            }
        }
    }

    private async repairQuarantinedCandidate(): Promise<void> {
        const quarantine = this.quarantine;
        if (!quarantine) return;
        const state = await this.liveCandidateState(quarantine.candidate);
        if (state === "different") {
            this.restoreMutableState(quarantine.previousSnapshot);
            this.quarantine = null;
            return;
        }
        if (state === "unknown") {
            throw new CaddyGatewayDurabilityError("Caddy quarantined candidate state could not be proven");
        }
        const tmpPath = `${config.caddyConfigPath}.repair-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        try {
            await fs.writeFile(tmpPath, JSON.stringify(quarantine.candidate, null, 2));
            await this.fileOperations.persistLoadedCandidate(tmpPath);
            this.quarantine = null;
        } catch {
            await fs.unlink(tmpPath).catch(() => undefined);
            throw new CaddyGatewayDurabilityError("Caddy quarantined candidate durability could not be repaired");
        }
    }

    private mutableStateSnapshot(): CaddyMutableStateSnapshot {
        return {
            routes: structuredClone(this.routesById),
            certs: structuredClone(this.certsById),
            rateLimits: structuredClone(this.rateLimits),
            customRateLimits: structuredClone(this.customRateLimits),
            hydrated: this.hydrated,
        };
    }

    private restoreMutableState(snapshot: CaddyMutableStateSnapshot): void {
        this.routesById.clear();
        for (const [key, value] of snapshot.routes) this.routesById.set(key, value);
        this.certsById.clear();
        for (const [key, value] of snapshot.certs) this.certsById.set(key, value);
        this.rateLimits.clear();
        for (const [key, value] of snapshot.rateLimits) this.rateLimits.set(key, value);
        this.customRateLimits.clear();
        for (const [key, value] of snapshot.customRateLimits) this.customRateLimits.set(key, value);
        this.hydrated = snapshot.hydrated;
    }

    private projectRouteIds(projectRef: string): string[] {
        return Array.from(this.routesById.keys()).filter((id) =>
            id.includes(`-${projectRef}-`) || id.endsWith(`-${projectRef}`),
        );
    }

    private hostsForProjectRoutes(projectRef: string): string[] {
        const hosts: string[] = [];
        for (const id of this.projectRouteIds(projectRef)) {
            const route = this.routesById.get(id);
            const match = Array.isArray(route?.match) ? route.match[0] as Record<string, unknown> | undefined : undefined;
            if (match && Array.isArray(match.host)) hosts.push(...match.host as string[]);
        }
        return uniqueStrings(hosts);
    }

    private makeEncodeHandler(): Record<string, unknown> {
        return {
            handler: "encode",
            encodings: {
                zstd: {},
                gzip: {},
            },
            prefer: ["zstd", "gzip"],
            minimum_length: 1024,
        };
    }

    private makeStaticSecurityHeaders(): Record<string, unknown> {
        return {
            handler: "headers",
            response: {
                set: {
                    "X-Content-Type-Options": ["nosniff"],
                    "Referrer-Policy": ["strict-origin-when-cross-origin"],
                },
            },
        };
    }

    private makeStaticCacheHeaders(cacheControl: string): Record<string, unknown> {
        return {
            handler: "headers",
            response: {
                set: {
                    "Cache-Control": [cacheControl],
                },
            },
        };
    }

    private makeStaticTryFilesRoute(root: string): CaddyRoute {
        return {
            match: [{
                file: {
                    root,
                    try_files: [
                        "{http.request.uri.path}",
                        "{http.request.uri.path}.html",
                        "{http.request.uri.path}/index.html",
                    ],
                },
            }],
            handle: [{
                handler: "rewrite",
                uri: "{http.matchers.file.relative}",
            }, makeStaticFileServer(root)],
            terminal: true,
        };
    }

    private makeStaticSpaFallbackRoute(root: string): CaddyRoute {
        return {
            match: [{
                file: {
                    root,
                    try_files: ["/index.html"],
                },
            }],
            handle: [
                this.makeStaticCacheHeaders("no-cache"),
                {
                    handler: "rewrite",
                    uri: "{http.matchers.file.relative}",
                },
            ],
        };
    }

    private makeStaticAssetRoute(root: string, cacheControl: string): CaddyRoute {
        return {
            match: [{
                path: ["/_app/*", "/assets/*"],
                file: {
                    root,
                    try_files: ["{http.request.uri.path}"],
                },
            }],
            handle: [
                this.makeStaticCacheHeaders(cacheControl),
                {
                    handler: "rewrite",
                    uri: "{http.matchers.file.relative}",
                },
                makeStaticFileServer(root),
            ],
            terminal: true,
        };
    }

    private makeMissingStaticAssetRoute(): CaddyRoute {
        return {
            match: [{
                path: ["/_app/*", "/assets/*"],
            }],
            handle: [
                this.makeStaticCacheHeaders("no-cache"),
                {
                    handler: "static_response",
                    status_code: 404,
                },
            ],
            terminal: true,
        };
    }

    private makeStaticImageVariantRoute(root: string, accept: string, suffix: ".avif" | ".webp"): CaddyRoute {
        return {
            match: [{
                header: {
                    Accept: [`*${accept}*`],
                },
                file: {
                    root,
                    try_files: [`{http.request.uri.path}${suffix}`],
                },
            }],
            handle: [{
                handler: "rewrite",
                uri: "{http.matchers.file.relative}",
            }, makeStaticFileServer(root)],
            terminal: true,
        };
    }

    private makeStaticFrontendRoute(route: FrontendGatewayRoute): CaddyRoute {
        if (!route.root) {
            throw new Error("Caddy static frontend routes require a root directory");
        }

        const immutableCache = "public, max-age=31536000, immutable";
        const defaultCache = "public, max-age=3600";

        return {
            "@id": `route-frontend-${route.projectRef}-${route.deploymentId}`,
            match: [{
                host: uniqueStrings(route.hosts.map(normalizeCaddyHost)),
                path: ["/*"],
            }],
            handle: [
                this.makeStaticSecurityHeaders(),
                this.makeStaticCacheHeaders(defaultCache),
                this.makeEncodeHandler(),
                {
                    handler: "subroute",
                    routes: [
                        this.makeStaticImageVariantRoute(route.root, "image/avif", ".avif"),
                        this.makeStaticImageVariantRoute(route.root, "image/webp", ".webp"),
                        this.makeStaticAssetRoute(route.root, immutableCache),
                        this.makeMissingStaticAssetRoute(),
                        {
                            match: [{ path: ["/", "*.html"] }],
                            handle: [this.makeStaticCacheHeaders("no-cache")],
                        },
                        this.makeStaticTryFilesRoute(route.root),
                        this.makeStaticSpaFallbackRoute(route.root),
                        {
                            handle: [makeStaticFileServer(route.root)],
                        },
                    ],
                },
            ],
            terminal: true,
        };
    }

    private makeRoute(opts: {
        id: string;
        hosts: string[];
        path: string | string[];
        upstream: string;
        projectRef: string;
        stripPrefix?: string;
        rewriteUri?: string;
        headers?: string[];
        corsOrigins?: string[];
        readTimeout?: number;
        preserveUpstreamCors?: boolean;
        streaming?: boolean;
        upstreamTls?: boolean;
        upstreamTlsInsecureSkipVerify?: boolean;
        methods?: string[];
        pathRegexp?: string;
    }): CaddyRoute {
        const requestHeaders: Record<string, CaddyHeaderValue> = {
            "Host": "{http.request.host}",
            "X-Project-Ref": opts.projectRef,
            "x-project-ref": opts.projectRef,
            "X-Forwarded-Host": "{http.request.host}",
            "X-Forwarded-Proto": "{http.request.scheme}",
        };
        for (const header of opts.headers || []) {
            const [key, ...rest] = header.split(":");
            if (key && rest.length > 0) requestHeaders[key.trim()] = rest.join(":").trim();
        }

        const handle: Record<string, unknown>[] = [];
        const corsSubroute = opts.corsOrigins && !opts.preserveUpstreamCors
            ? makeCorsSubroute(opts.corsOrigins)
            : null;
        if (corsSubroute) handle.push(corsSubroute);
        if (opts.rewriteUri) handle.push({ handler: "rewrite", uri: opts.rewriteUri });
        else if (opts.stripPrefix) handle.push({ handler: "rewrite", strip_path_prefix: opts.stripPrefix });
        handle.push(makeReverseProxy(opts.upstream, requestHeaders, opts.readTimeout, opts.preserveUpstreamCors, opts.streaming, opts.upstreamTls, opts.upstreamTlsInsecureSkipVerify));

        return {
            "@id": opts.id,
            match: [{
                host: uniqueStrings(opts.hosts.map(normalizeCaddyHost)),
                path: Array.isArray(opts.path) ? opts.path : [opts.path],
                ...(opts.methods && opts.methods.length > 0 ? { method: opts.methods } : {}),
                ...(opts.pathRegexp ? {
                    path_regexp: {
                        name: `${sanitizeCaddyId(opts.id)}_path`,
                        pattern: opts.pathRegexp,
                    },
                } : {}),
            }],
            handle,
            terminal: true,
        };
    }

    private makeOpaqueApiKeyProxyRoute(opts: {
        id: string;
        hosts: string[];
        path: string | string[];
        upstream: string;
        projectRef: string;
        corsOrigins?: string[];
        readTimeout?: number;
    }): CaddyRoute {
        const route = this.makeRoute(opts);
        const baseMatch = Array.isArray(route.match)
            ? route.match[0] as Record<string, unknown>
            : {};
        const matcherName = sanitizeCaddyId(opts.id);
        route.match = [
            {
                ...baseMatch,
                header_regexp: {
                    apikey: {
                        name: `${matcherName}_apikey`,
                        pattern: "^sb_(publishable|secret)_[A-Za-z0-9_-]+$",
                    },
                },
            },
            {
                ...baseMatch,
                header_regexp: {
                    Authorization: {
                        name: `${matcherName}_authorization`,
                        pattern: "(?i)^Bearer\\s+sb_(publishable|secret)_[A-Za-z0-9_-]+$",
                    },
                },
            },
        ];
        route.__supacloud_priority = 100;
        return route;
    }

    private async putRoute(route: CaddyRoute): Promise<void> {
        await this.serializeOperation(async () => {
            const id = String(route["@id"]);
            const previous = this.routesById.get(id);
            this.routesById.set(id, route);
            try {
                await this.persistAndLoad();
            } catch (error: unknown) {
                if (!preservesGatewayCandidate(error)) {
                    if (previous) this.routesById.set(id, previous);
                    else this.routesById.delete(id);
                }
                throw error;
            }
        });
    }

    private async removeRoutes(ids: string[]): Promise<void> {
        await this.serializeOperation(async () => {
            const previous = ids.flatMap((id) => {
                const route = this.routesById.get(id);
                return route ? [[id, route] as const] : [];
            });
            for (const id of ids) this.routesById.delete(id);
            try {
                await this.persistAndLoad();
            } catch (error: unknown) {
                if (!preservesGatewayCandidate(error)) {
                    for (const [id, route] of previous) this.routesById.set(id, route);
                }
                throw error;
            }
        });
    }

    private async serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
        if (this.operationContext.getStore()?.token === this.operationToken) return operation();
        const previous = this.operationTail.catch(() => undefined);
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        const tail = previous.then(() => current);
        this.operationTail = tail;
        await previous;
        try {
            await this.repairQuarantinedCandidate();
            await this.hydrateFromDiskIfUninitialized();
            const context = {
                token: this.operationToken,
                previousSnapshot: this.mutableStateSnapshot(),
            };
            return await this.operationContext.run(context, operation);
        } finally {
            release();
            if (this.operationTail === tail) this.operationTail = Promise.resolve();
        }
    }

    async setupJwt(_projectRef: string, _jwtSecret: string): Promise<boolean> {
        // Supabase-compatible upstreams validate JWTs; Caddy remains the edge data plane.
        return true;
    }

    async enableJwtAuth(_projectRef: string): Promise<boolean> {
        return true;
    }

    async setIpRestriction(projectRef: string, allowedIps: string[]): Promise<boolean> {
        logger.info(`[CaddyGatewayProvider] IP restriction is tracked by policy layer for ${projectRef}`, { allowedIps });
        return true;
    }

    async getRateLimit(projectRef: string): Promise<{ tier: string; second: number; minute: number; hour: number; enabled: boolean }> {
        return this.rateLimits.get(projectRef) || { tier: "none", second: 0, minute: 0, hour: 0, enabled: false };
    }

    async setRateLimit(projectRef: string, opts: string | { second?: number; minute?: number; hour?: number } = "free"): Promise<boolean> {
        return this.serializeOperation(() => this.setRateLimitUnlocked(projectRef, opts));
    }

    private async setRateLimitUnlocked(projectRef: string, opts: string | { second?: number; minute?: number; hour?: number }): Promise<boolean> {
        await this.hydrateFromDiskIfUninitialized();
        const defaults = RATE_LIMIT_TIERS.free;
        const limits = typeof opts === "string" ? getRateLimitConfig(opts) : {
            second: opts.second ?? defaults.second,
            minute: opts.minute ?? defaults.minute,
            hour: opts.hour ?? defaults.hour,
        };
        this.rateLimits.set(projectRef, {
            tier: typeof opts === "string" ? opts : "custom",
            ...limits,
            enabled: true,
        });
        await this.persistAndLoad();
        return true;
    }

    async setCustomRouteRateLimit(projectRef: string, basePath: string, limits: { second?: number; minute?: number; hour?: number }): Promise<boolean> {
        return this.serializeOperation(() => this.setCustomRouteRateLimitUnlocked(projectRef, basePath, limits));
    }

    private async setCustomRouteRateLimitUnlocked(projectRef: string, basePath: string, limits: { second?: number; minute?: number; hour?: number }): Promise<boolean> {
        await this.hydrateFromDiskIfUninitialized();
        const routeId = `route-custom-${projectRef}-${hashStr(basePath)}`;
        const parent = this.cloneRouteForCustomLimit(projectRef, basePath, routeId);
        if (!parent) {
            logger.error(`[CaddyGatewayProvider] Cannot determine upstream route for custom path: ${basePath}`);
            return false;
        }

        this.routesById.set(routeId, parent);
        this.customRateLimits.set(routeId, {
            second: Math.min(limits.second ?? 100, 100),
            minute: Math.min(limits.minute ?? 2000, 2000),
            hour: Math.min(limits.hour ?? 50000, 50000),
        });
        await this.persistAndLoad();
        return true;
    }

    async removeCustomRouteRateLimit(projectRef: string, basePath: string): Promise<boolean> {
        return this.serializeOperation(() => this.removeCustomRouteRateLimitUnlocked(projectRef, basePath));
    }

    private async removeCustomRouteRateLimitUnlocked(projectRef: string, basePath: string): Promise<boolean> {
        await this.hydrateFromDiskIfUninitialized();
        const routeId = `route-custom-${projectRef}-${hashStr(basePath)}`;
        this.customRateLimits.delete(routeId);
        this.routesById.delete(routeId);
        await this.persistAndLoad();
        return true;
    }

    async configureCustomGatewayRoutes(projectRef: string, routes: CustomGatewayRouteConfig[]): Promise<{ success: boolean; error?: string }> {
        return this.serializeOperation(() => this.configureCustomGatewayRoutesUnlocked(projectRef, routes));
    }

    private async configureCustomGatewayRoutesUnlocked(projectRef: string, routes: CustomGatewayRouteConfig[]): Promise<{ success: boolean; error?: string }> {
        const previousRoutes: Array<[string, CaddyRoute]> = [];
        try {
            await this.hydrateFromDiskIfUninitialized();
            for (const entry of this.routesById.entries()) {
                if (isCustomGatewayRouteId(projectRef, entry[0])) previousRoutes.push(entry);
            }
            for (const id of Array.from(this.routesById.keys())) {
                if (isCustomGatewayRouteId(projectRef, id)) this.routesById.delete(id);
            }
            for (const route of routes) {
                const rendered = makeCustomGatewayRoute(projectRef, route);
                if (rendered) this.routesById.set(String(rendered["@id"]), rendered);
            }
            await this.persistAndLoad();
            return { success: true };
        } catch (error: unknown) {
            if (preservesGatewayCandidate(error)) throw error;
            for (const id of Array.from(this.routesById.keys())) {
                if (isCustomGatewayRouteId(projectRef, id)) this.routesById.delete(id);
            }
            for (const [id, route] of previousRoutes) this.routesById.set(id, route);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    private cloneRouteForCustomLimit(projectRef: string, basePath: string, routeId: string): CaddyRoute | null {
        const normalizedPath = basePath.startsWith("/") ? basePath : `/${basePath}`;
        const parentKind =
            normalizedPath.startsWith("/rest/v1") ? "rest" :
            normalizedPath.startsWith("/graphql/v1") ? "graphql" :
            normalizedPath.startsWith("/auth/v1") ? "auth" :
            normalizedPath.startsWith("/functions/v1") ? "functions" :
            normalizedPath.startsWith("/storage/v1") ? "storage" :
            normalizedPath.startsWith("/realtime/v1/api") ? "realtime-api" :
            normalizedPath.startsWith("/realtime/v1") ? "realtime" :
            "";
        if (!parentKind) return null;

        const parent = this.routesById.get(caddyRouteId(projectRef, parentKind));
        if (!parent) return null;

        const cloned = JSON.parse(JSON.stringify(parent)) as CaddyRoute;
        cloned["@id"] = routeId;
        const match = Array.isArray(cloned.match) ? cloned.match[0] as Record<string, unknown> | undefined : undefined;
        if (match) {
            match.path = [normalizedPath.endsWith("*") ? normalizedPath : `${normalizedPath.replace(/\/$/, "")}*`];
        }
        return cloned;
    }

    async setCors(projectRef: string, origins: string[] = DEFAULT_CORS_ORIGINS): Promise<boolean> {
        return this.serializeOperation(() => this.setCorsUnlocked(projectRef, origins));
    }

    private async setCorsUnlocked(projectRef: string, origins: string[]): Promise<boolean> {
        logger.debug(`[CaddyGatewayProvider] CORS is rendered into route JSON for ${projectRef}`);
        await this.hydrateFromDiskIfUninitialized();
        for (const id of this.projectRouteIds(projectRef)) {
            const route = this.routesById.get(id);
            if (route) setRouteCors(route, origins);
        }
        await this.persistAndLoad();
        return true;
    }

    async addCorsOriginsForHosts(projectRef: string, hosts: string[]): Promise<boolean> {
        return this.serializeOperation(() => this.addCorsOriginsForHostsUnlocked(projectRef, hosts));
    }

    private async addCorsOriginsForHostsUnlocked(projectRef: string, hosts: string[]): Promise<boolean> {
        await this.hydrateFromDiskIfUninitialized();
        const allHosts = uniqueStrings([...this.hostsForProjectRoutes(projectRef), ...hosts]);
        return this.setCors(projectRef, buildTenantCorsOrigins(projectRef, undefined, allHosts));
    }

    async setupUpstream(projectRef: string, pgrstPort: number | string, gotruePort: number | string, projectRouting?: ProjectRoutingConfig | string, opts?: GatewaySetupOptions): Promise<{ success: boolean; error?: string }> {
        return this.serializeOperation(() => this.setupUpstreamUnlocked(projectRef, pgrstPort, gotruePort, projectRouting, opts));
    }

    private async setupUpstreamUnlocked(projectRef: string, pgrstPort: number | string, gotruePort: number | string, projectRouting?: ProjectRoutingConfig | string, opts?: GatewaySetupOptions): Promise<{ success: boolean; error?: string }> {
        try {
            const hostIp = await this.detectHostIp();
            const projectConfig = normalizeProjectConfig(projectRouting);
            const routingConfig = normalizeProjectRoutingConfig(projectRouting);
            const authConfig = projectConfig.auth && typeof projectConfig.auth === "object" && !Array.isArray(projectConfig.auth)
                ? projectConfig.auth as Record<string, unknown>
                : {};
            const externalAuth = resolveExternalAuthEndpointConfig(authConfig.third_party_auth);
            const externalAuthUpstream = externalAuth
                ? normalizeCustomUpstream(externalAuth.auth_upstream)
                : null;
            let sharedAuthPort: number | null = null;
            if (config.authRuntimeOwnerRef && config.authRuntimeOwnerRef !== projectRef) {
                const [owner] = await sql`
                    SELECT ref, config FROM projects
                    WHERE ref=${config.authRuntimeOwnerRef} AND status='active' AND deleted_at IS NULL
                `;
                const ownerConfig = normalizeProjectConfig(owner?.config);
                const port = Number(ownerConfig.gotrue_port);
                if (!owner || !Number.isInteger(port) || port <= 0) {
                    throw new Error(`shared auth runtime owner ${config.authRuntimeOwnerRef} is unavailable`);
                }
                sharedAuthPort = port;
            }
            const sharedAuthProxy = sharedAuthPort !== null;
            const directAuthUpstream = sharedAuthPort !== null
                ? `${hostIp}:${sharedAuthPort}`
                : externalAuthUpstream?.dial || `${hostIp}:${gotruePort}`;
            const authUpstream = sharedAuthProxy
                ? `${hostIp}:${config.port}`
                : directAuthUpstream;
            const authHeaders = sharedAuthPort !== null
                    ? [`X-Project-Ref:${config.authRuntimeOwnerRef}`, `x-project-ref:${config.authRuntimeOwnerRef}`]
                    : externalAuthUpstream && externalAuth?.auth_host_header
                        ? [`Host:${externalAuth.auth_host_header}`, `X-Forwarded-Host:${externalAuth.auth_host_header}`]
                        : undefined;
            const authProxyHeaders = sharedAuthProxy ? undefined : authHeaders;
            const authUpstreamTls = sharedAuthPort === null ? externalAuthUpstream?.tls : false;
            const authUpstreamTlsInsecureSkipVerify = sharedAuthPort === null
                && externalAuth?.auth_upstream_tls_insecure_skip_verify;
            const hosts = uniqueStrings(resolveProjectApiHosts(projectRef, routingConfig));
            const hostSet = new Set(hosts.map(normalizeCaddyHost));
            const authHosts = uniqueStrings([resolveProjectAuthHost(projectRef, routingConfig)])
                .filter((host) => !hostSet.has(normalizeCaddyHost(host)));
            const studioHosts = uniqueStrings([
                `studio-${projectRef}.${config.baseDomain}`,
                resolveProjectStudioHost(projectRef, routingConfig),
            ]);
            const corsOrigins = buildTenantCorsOrigins(projectRef, routingConfig, [
                ...hosts,
                ...authHosts,
                ...studioHosts,
                ...this.hostsForProjectRoutes(projectRef),
            ]);

            const restOpenApiRoute = this.makeRoute({
                id: caddyRouteId(projectRef, "rest-openapi"),
                hosts,
                path: ["/rest/v1", "/rest/v1/"],
                methods: ["GET", "HEAD"],
                upstream: `${hostIp}:${config.port}`,
                projectRef,
                corsOrigins,
                readTimeout: config.restProxyTimeoutMs,
            });
            restOpenApiRoute.__supacloud_priority = 200;

            const opaqueRoutes = [
                this.makeOpaqueApiKeyProxyRoute({
                    id: caddyRouteId(projectRef, "opaque-rest"),
                    hosts,
                    path: "/rest/v1*",
                    upstream: `${hostIp}:${config.port}`,
                    projectRef,
                    corsOrigins,
                    readTimeout: config.restProxyTimeoutMs,
                }),
                this.makeOpaqueApiKeyProxyRoute({
                    id: caddyRouteId(projectRef, "opaque-graphql"),
                    hosts,
                    path: "/graphql/v1*",
                    upstream: `${hostIp}:${config.port}`,
                    projectRef,
                    corsOrigins,
                    readTimeout: config.restProxyTimeoutMs,
                }),
                ...(!externalAuthUpstream || sharedAuthProxy ? [this.makeOpaqueApiKeyProxyRoute({
                    id: caddyRouteId(projectRef, "opaque-auth"),
                    hosts,
                    path: "/auth/v1*",
                    upstream: `${hostIp}:${config.port}`,
                    projectRef,
                    corsOrigins,
                })] : []),
            ];

            const adminUserDeleteRoute = this.makeRoute({
                id: caddyRouteId(projectRef, "auth-admin-user-delete"),
                hosts: [...hosts, ...authHosts],
                path: "/auth/v1/admin/users/*",
                methods: ["DELETE"],
                pathRegexp: `(?i)^/auth/v1/admin/users/${GOTRUE_USER_ID_POSTGRES_PATTERN.slice(1, -1)}/?$`,
                upstream: `${hostIp}:${config.port}`,
                projectRef,
                corsOrigins,
            });

            const routes = [
                adminUserDeleteRoute,
                restOpenApiRoute,
                ...opaqueRoutes,
                this.makeRoute({ id: caddyRouteId(projectRef, "rest"), hosts, path: "/rest/v1*", upstream: `${hostIp}:${pgrstPort}`, projectRef, stripPrefix: "/rest/v1", corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "graphql"), hosts, path: "/graphql/v1*", upstream: `${hostIp}:${pgrstPort}`, projectRef, rewriteUri: "/rpc/graphql", headers: ["Content-Profile:graphql_public", "Accept-Profile:graphql_public"], corsOrigins }),
                this.makeRoute({
                    id: caddyRouteId(projectRef, "auth"),
                    hosts,
                    path: "/auth/v1*",
                    upstream: authUpstream,
                    projectRef,
                    stripPrefix: sharedAuthProxy ? undefined : "/auth/v1",
                    headers: authProxyHeaders,
                    corsOrigins,
                    upstreamTls: authUpstreamTls,
                    upstreamTlsInsecureSkipVerify: authUpstreamTlsInsecureSkipVerify,
                }),
                this.makeRoute({
                    id: caddyRouteId(projectRef, "gotrue-well-known"),
                    hosts,
                    path: "/.well-known/oauth-authorization-server/auth/v1*",
                    rewriteUri: "/.well-known/oauth-authorization-server",
                    upstream: directAuthUpstream,
                    projectRef,
                    headers: authHeaders,
                    corsOrigins,
                    upstreamTls: authUpstreamTls,
                    upstreamTlsInsecureSkipVerify: authUpstreamTlsInsecureSkipVerify,
                }),
                this.makeRoute({
                    id: caddyRouteId(projectRef, "functions"),
                    hosts,
                    path: "/functions/v1*",
                    upstream: `${hostIp}:${config.port}`,
                    projectRef,
                    headers: [
                        `Host:${projectRef}.api.${config.baseDomain}`,
                        `X-Forwarded-Host:${projectRef}.api.${config.baseDomain}`,
                    ],
                    readTimeout: 500_000,
                    corsOrigins,
                }),
                this.makeRoute({
                    id: caddyRouteId(projectRef, "storage-resumable"),
                    hosts,
                    path: "/storage/v1/upload/resumable*",
                    upstream: `${hostIp}:${opts?.storagePort || config.port}`,
                    projectRef,
                    headers: [
                        `Host:${projectRef}.api.${config.baseDomain}`,
                        `X-Forwarded-Host:${projectRef}.api.${config.baseDomain}`,
                    ],
                    readTimeout: 900_000,
                    corsOrigins,
                    preserveUpstreamCors: true,
                    streaming: false,
                }),
                this.makeRoute({
                    id: caddyRouteId(projectRef, "storage"),
                    hosts,
                    path: "/storage/v1*",
                    upstream: `${hostIp}:${opts?.storagePort || config.port}`,
                    projectRef,
                    headers: [
                        `Host:${projectRef}.api.${config.baseDomain}`,
                        `X-Forwarded-Host:${projectRef}.api.${config.baseDomain}`,
                    ],
                    corsOrigins,
                    preserveUpstreamCors: true,
                    streaming: false,
                }),
                this.makeRoute({ id: caddyRouteId(projectRef, "realtime-api"), hosts, path: "/realtime/v1/api*", upstream: `${hostIp}:${config.port}`, projectRef, readTimeout: 60_000, corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "realtime"), hosts, path: "/realtime/v1/websocket*", upstream: `${hostIp}:${config.port}`, projectRef, readTimeout: 86_400_000, corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "management"), hosts, path: [`/v1/projects/${projectRef}`, `/v1/projects/${projectRef}/*`], upstream: `${hostIp}:${config.port}`, projectRef, corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "acme"), hosts: [...hosts, ...studioHosts], path: "/.well-known/acme-challenge*", upstream: `${hostIp}:${config.port}`, projectRef, corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "studio"), hosts: studioHosts, path: "/*", upstream: `${hostIp}:${config.port}`, projectRef, headers: ["x-supacloud-ui-host:studio"], corsOrigins }),
            ];

            for (const route of routes) this.routesById.set(String(route["@id"]), route);
            if (externalAuthUpstream) {
                this.routesById.delete(caddyRouteId(projectRef, "opaque-auth"));
            }
            if (authHosts.length > 0) {
                if (!externalAuthUpstream) {
                    this.routesById.set(caddyRouteId(projectRef, "opaque-auth-domain"), this.makeOpaqueApiKeyProxyRoute({
                        id: caddyRouteId(projectRef, "opaque-auth-domain"),
                        hosts: authHosts,
                        path: "/auth/v1*",
                        upstream: `${hostIp}:${config.port}`,
                        projectRef,
                        corsOrigins,
                    }));
                } else {
                    this.routesById.delete(caddyRouteId(projectRef, "opaque-auth-domain"));
                }
                this.routesById.set(caddyRouteId(projectRef, "auth-domain-auth"), this.makeRoute({
                    id: caddyRouteId(projectRef, "auth-domain-auth"),
                    hosts: authHosts,
                    path: "/auth/v1*",
                    upstream: authUpstream,
                    projectRef,
                    stripPrefix: sharedAuthProxy ? undefined : "/auth/v1",
                    headers: authProxyHeaders,
                    corsOrigins,
                    upstreamTls: authUpstreamTls,
                    upstreamTlsInsecureSkipVerify: authUpstreamTlsInsecureSkipVerify,
                }));
                this.routesById.set(caddyRouteId(projectRef, "auth-domain-gotrue-well-known"), this.makeRoute({
                    id: caddyRouteId(projectRef, "auth-domain-gotrue-well-known"),
                    hosts: authHosts,
                    path: "/.well-known/oauth-authorization-server/auth/v1*",
                    rewriteUri: "/.well-known/oauth-authorization-server",
                    upstream: directAuthUpstream,
                    projectRef,
                    headers: authHeaders,
                    corsOrigins,
                    upstreamTls: authUpstreamTls,
                    upstreamTlsInsecureSkipVerify: authUpstreamTlsInsecureSkipVerify,
                }));
            } else {
                this.routesById.delete(caddyRouteId(projectRef, "opaque-auth-domain"));
                this.routesById.delete(caddyRouteId(projectRef, "auth-domain-auth"));
                this.routesById.delete(caddyRouteId(projectRef, "auth-domain-gotrue-well-known"));
            }
            await this.persistAndLoad();
            logger.info(`[CaddyGatewayProvider] Routes registered for ${projectRef}`);
            return { success: true };
        } catch (error: unknown) {
            if (preservesGatewayCandidate(error)) throw error;
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`[CaddyGatewayProvider] Failed to setup upstream for ${projectRef}:`, message);
            return { success: false, error: message };
        }
    }

    async addProjectDomains(projectRef: string, apiDomains: string[], studioDomains: string[]): Promise<boolean> {
        return this.serializeOperation(() => this.addProjectDomainsUnlocked(projectRef, apiDomains, studioDomains));
    }

    private async addProjectDomainsUnlocked(projectRef: string, apiDomains: string[], studioDomains: string[]): Promise<boolean> {
        await this.hydrateFromDiskIfUninitialized();
        const existingKinds = ["opaque-rest", "opaque-graphql", "opaque-auth", "auth-admin-user-delete", "rest", "graphql", "auth", "gotrue-well-known", "functions", "storage", "realtime-api", "realtime", "management", "acme"];
        for (const kind of existingKinds) {
            const route = this.routesById.get(caddyRouteId(projectRef, kind));
            const matches = Array.isArray(route?.match) ? route.match as Record<string, unknown>[] : [];
            for (const match of matches) {
                match.host = uniqueStrings([...(Array.isArray(match.host) ? match.host as string[] : []), ...apiDomains]);
            }
        }
        const studio = this.routesById.get(caddyRouteId(projectRef, "studio"));
        const studioMatch = Array.isArray(studio?.match) ? studio.match[0] as Record<string, unknown> | undefined : undefined;
        if (studioMatch) studioMatch.host = uniqueStrings([...(Array.isArray(studioMatch.host) ? studioMatch.host as string[] : []), ...studioDomains]);
        await this.persistAndLoad();
        return true;
    }

    async removeProjectDomains(projectRef: string, apiDomains: string[], studioDomains: string[]): Promise<boolean> {
        return this.serializeOperation(() => this.removeProjectDomainsUnlocked(projectRef, apiDomains, studioDomains));
    }

    private async removeProjectDomainsUnlocked(projectRef: string, apiDomains: string[], studioDomains: string[]): Promise<boolean> {
        await this.hydrateFromDiskIfUninitialized();
        const remove = new Set([...apiDomains, ...studioDomains].map(normalizeCaddyHost));
        for (const route of this.routesById.values()) {
            const id = String(route["@id"] || "");
            if (!id.includes(`-${projectRef}-`)) continue;
            const matches = Array.isArray(route.match) ? route.match as Record<string, unknown>[] : [];
            for (const match of matches) {
                if (Array.isArray(match.host)) {
                    match.host = (match.host as string[]).filter((host) => !remove.has(normalizeCaddyHost(host)));
                }
            }
        }
        await this.persistAndLoad();
        return true;
    }

    async removeService(projectRef: string): Promise<{ success: boolean; error?: string }> {
        return this.serializeOperation(() => this.removeServiceUnlocked(projectRef));
    }

    private async removeServiceUnlocked(projectRef: string): Promise<{ success: boolean; error?: string }> {
        await this.hydrateFromDiskIfUninitialized();
        const ids = Array.from(this.routesById.keys()).filter((id) => id.includes(`-${projectRef}-`) || id.endsWith(`-${projectRef}`));
        await this.removeRoutes(ids);
        return { success: true };
    }

    async addUpstreamTarget(_projectRef: string, _replicaIp: string): Promise<{ success: boolean; error?: string }> {
        return { success: true };
    }

    async removeUpstreamTarget(_projectRef: string, _replicaIp: string): Promise<{ success: boolean; error?: string }> {
        return { success: true };
    }

    async applyConfig(projectRef: string, gatewayConfig: GatewayConfig): Promise<{ success: boolean; message: string }> {
        return this.serializeOperation(() => this.applyConfigUnlocked(projectRef, gatewayConfig));
    }

    private async applyConfigUnlocked(projectRef: string, gatewayConfig: GatewayConfig): Promise<{ success: boolean; message: string }> {
        if (gatewayConfig.jwtSecret) await this.setupJwt(projectRef, gatewayConfig.jwtSecret);
        if (gatewayConfig.rateLimitTier) await this.setRateLimit(projectRef, gatewayConfig.rateLimitTier);
        if (gatewayConfig.corsOrigins) {
            const originsArray = gatewayConfig.corsOrigins.split(",").map((s) => s.trim()).filter(Boolean);
            await this.setCors(projectRef, originsArray.length > 0 ? originsArray : DEFAULT_CORS_ORIGINS);
        }
        if (gatewayConfig.jwtEnabled) await this.enableJwtAuth(projectRef);
        return { success: true, message: "Gateway configuration updated" };
    }

    async rebuildAllTenantConfigs(): Promise<{ success: boolean; updated: number; errors: string[] }> {
        return this.serializeOperation(() => this.rebuildAllTenantConfigsUnlocked());
    }

    private async rebuildAllTenantConfigsUnlocked(): Promise<{ success: boolean; updated: number; errors: string[] }> {
        const errors: string[] = [];
        let updated = 0;
        try {
            const projects = await sql`
                SELECT ref, config FROM projects
                WHERE status = 'active' AND deleted_at IS NULL
            `;
            for (const project of projects) {
                const ref = project.ref as string;
                const cfg = normalizeProjectConfig(project.config);
                const pgrstPort = cfg.postgrest_port as number | undefined;
                const gotruePort = cfg.gotrue_port as number | undefined;
                if (!pgrstPort || !gotruePort) {
                    errors.push(`${ref}: missing port config`);
                    continue;
                }
                const result = await this.setupUpstream(ref, pgrstPort, gotruePort, cfg);
                if (!result.success) {
                    errors.push(`${ref}: ${result.error || "unknown error"}`);
                    continue;
                }
                const customResult = await this.configureCustomGatewayRoutes(ref, normalizeCustomGatewayRoutes(cfg.gateway_routes));
                if (customResult.success) updated++;
                else errors.push(`${ref}: ${customResult.error || "custom route reconcile failed"}`);
            }
            return { success: errors.length === 0, updated, errors };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            return { success: false, updated, errors: [...errors, msg] };
        }
    }

    async setupMasterRoutes(): Promise<void> {
        return this.serializeOperation(() => this.setupMasterRoutesUnlocked());
    }

    private async setupMasterRoutesUnlocked(): Promise<void> {
        await this.hydrateFromDiskIfUninitialized();
        const hostIp = await this.detectHostIp();
        const hosts = uniqueStrings([hostIp, config.baseDomain, `api.${config.baseDomain}`]);
        const corsOrigins = buildTenantCorsOrigins("_management", undefined, hosts);
        this.routesById.set("route-system-management-api", this.makeRoute({
            id: "route-system-management-api",
            hosts,
            path: "/api*",
            upstream: `${hostIp}:${config.port}`,
            projectRef: "_management",
            stripPrefix: "/api",
            corsOrigins,
        }));
        this.routesById.set("route-system-studio-root", this.makeRoute({
            id: "route-system-studio-root",
            hosts,
            path: "/*",
            upstream: `${hostIp}:${config.port}`,
            projectRef: "_system",
            corsOrigins,
        }));
        await this.persistAndLoad();
    }

    async configureStudioDomain(domain: string, port: number): Promise<void> {
        return this.serializeOperation(() => this.configureStudioDomainUnlocked(domain, port));
    }

    private async configureStudioDomainUnlocked(domain: string, port: number): Promise<void> {
        await this.hydrateFromDiskIfUninitialized();
        const host = normalizeCaddyHost(domain);
        if (!host) throw new Error("Studio domain is required");
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error("Studio upstream port must be between 1 and 65535");
        }

        const redirect = makeCustomGatewayRoute("_global", {
            id: "studio-https-redirect",
            hosts: [host],
            path: "/*",
            protocol: "http",
            redirect_to: `https://${host}{http.request.uri}`,
            redirect_status: 308,
            priority: 10_000,
        });
        if (!redirect) throw new Error("Failed to build Studio HTTPS redirect route");

        this.routesById.set(String(redirect["@id"]), redirect);
        this.routesById.set("route-frontend-_global-studio", this.makeRoute({
            id: "route-frontend-_global-studio",
            hosts: [host],
            path: "/*",
            upstream: `127.0.0.1:${port}`,
            projectRef: "_global",
            readTimeout: 60_000,
        }));
        await this.persistAndLoad();
    }

    async upsertCertificateForSnis(opts: { projectRef: string; cert: string; key: string; snis: string[]; existingCertificateId?: string }): Promise<{ success: boolean; certificateId?: string; error?: string }> {
        return this.serializeOperation(() => this.upsertCertificateForSnisUnlocked(opts));
    }

    private async upsertCertificateForSnisUnlocked(opts: { projectRef: string; cert: string; key: string; snis: string[]; existingCertificateId?: string }): Promise<{ success: boolean; certificateId?: string; error?: string }> {
        await this.hydrateFromDiskIfUninitialized();
        const snis = uniqueStrings(opts.snis.map(normalizeCaddyHost));
        if (!opts.cert.trim() || !opts.key.trim()) return { success: false, error: "Certificate and private key are required" };
        if (snis.length === 0) return { success: false, error: "At least one SNI is required" };
        const certificateId = opts.existingCertificateId || `caddy-${opts.projectRef}-${hashStr(snis.join(","))}`;
        const certDir = path.join(config.caddyStateDir, "manual-certs", opts.projectRef);
        await fs.mkdir(certDir, { recursive: true });
        const certPath = path.join(certDir, `${certificateId}.crt`);
        const keyPath = path.join(certDir, `${certificateId}.key`);
        await fs.writeFile(certPath, opts.cert);
        await fs.writeFile(keyPath, opts.key, { mode: 0o600 });
        this.certsById.set(certificateId, { certificate: certPath, key: keyPath });
        await this.persistAndLoad();
        return { success: true, certificateId };
    }

    async configureFrontendRoute(route: FrontendGatewayRoute): Promise<void> {
        return this.serializeOperation(async () => {
            await this.hydrateFromDiskIfUninitialized();
            const routeId = `route-frontend-${route.projectRef}-${route.deploymentId}`;
            const routeIds = this.projectRouteIds(route.projectRef);
            const previous = new Map(routeIds.flatMap((id) => {
                const existing = this.routesById.get(id);
                return existing ? [[id, JSON.parse(JSON.stringify(existing)) as CaddyRoute] as const] : [];
            }));
            const allHosts = uniqueStrings([...this.hostsForProjectRoutes(route.projectRef), ...route.hosts]);
            const origins = buildTenantCorsOrigins(route.projectRef, undefined, allHosts);
            for (const id of routeIds) {
                const projectRoute = this.routesById.get(id);
                if (projectRoute) setRouteCors(projectRoute, origins);
            }
            const frontendRoute = route.mode === "static" || route.root
                ? this.makeStaticFrontendRoute(route)
                : this.proxyFrontendRoute(route, routeId);
            this.routesById.set(routeId, frontendRoute);
            try {
                await this.persistAndLoad();
            } catch (error: unknown) {
                if (!preservesGatewayCandidate(error)) {
                    this.routesById.delete(routeId);
                    for (const [id, projectRoute] of previous) this.routesById.set(id, projectRoute);
                }
                throw error;
            }
        });
    }

    private proxyFrontendRoute(route: FrontendGatewayRoute, routeId: string): CaddyRoute {
        if (!route.port) {
            throw new Error("Caddy proxy frontend routes require an upstream port");
        }
        return this.makeRoute({
            id: routeId,
            hosts: route.hosts,
            path: "/*",
            upstream: `127.0.0.1:${route.port}`,
            projectRef: route.projectRef,
            readTimeout: 60_000,
        });
    }

    async removeFrontendRoute(projectRef: string, deploymentId: string): Promise<void> {
        await this.removeRoutes([`route-frontend-${projectRef}-${deploymentId}`]);
    }

    async readFrontendStaticRoot(projectRef: string, deploymentId: string): Promise<string | null> {
        const response = await this.caddyRequest("/config/apps/http/servers/supacloud/routes");
        if (!response.ok) throw new Error(`Caddy route read-back failed with ${response.status}`);
        const routes = await response.json();
        if (!Array.isArray(routes)) throw new Error("Caddy route read-back is invalid");
        const routeId = `route-frontend-${projectRef}-${deploymentId}`;
        const matchingRoutes = routes.filter((candidate) => candidate?.["@id"] === routeId);
        if (matchingRoutes.length > 1) throw new Error("Caddy frontend route identity is ambiguous");
        const route = matchingRoutes[0];
        if (!route) return null;
        const roots = new Set<string>();
        const visit = (candidate: unknown): void => {
            if (Array.isArray(candidate)) {
                for (const child of candidate) visit(child);
                return;
            }
            if (!candidate || typeof candidate !== "object") return;
            const record = candidate as Record<string, unknown>;
            if (record.handler === "file_server" && typeof record.root === "string") roots.add(record.root);
            for (const child of Object.values(record)) visit(child);
        };
        visit(route);
        if (roots.size !== 1) throw new Error("Caddy frontend route does not have one canonical static root");
        return [...roots][0];
    }

    private async detectHostIp(): Promise<string> {
        if (config.dockerHostIp) return config.dockerHostIp;
        for (const iface of ["podman1", "docker0"]) {
            const result = await $`ip addr show ${iface}`.nothrow().quiet();
            if (result.exitCode === 0) {
                const match = result.text().match(/inet (\d+\.\d+\.\d+\.\d+)/);
                if (match) return match[1];
            }
        }
        return "127.0.0.1";
    }

    /**
     * Register Caddy file_server routes for the hosted auth page.
     * Enabled via HOSTED_AUTH_PAGE_ENABLED=true (legacy: SUPAUTH_HOSTED_LOGIN_ENABLED).
     * Routes created (high priority, before catch-all /*):
     *   - route-supauth-hosted-login: /, /login.html -> authorize.html
     *   - route-supauth-authorize-page: /oauth/authorize* -> authorize.html
     */
    async setupHostedAuthRoutes(): Promise<{ success: boolean; error?: string }> {
        return this.serializeOperation(() => this.setupHostedAuthRoutesUnlocked());
    }

    private async setupHostedAuthRoutesUnlocked(): Promise<{ success: boolean; error?: string }> {
        if (!config.hostedAuthPageEnabled) {
            // 清除已有路由
            await this.hydrateFromDiskIfUninitialized();
            let changed = false;
            for (const id of ["route-supauth-hosted-login", "route-supauth-authorize-page"]) {
                if (this.routesById.has(id)) {
                    this.routesById.delete(id);
                    changed = true;
                }
            }
            if (changed) await this.persistAndLoad();
            return { success: true };
        }

        if (!config.hostedAuthPageHost) {
            logger.warn("[CaddyGatewayProvider] HOSTED_AUTH_PAGE_ENABLED=true but HOSTED_AUTH_PAGE_HOST is not set, skipping");
            return { success: false, error: "HOSTED_AUTH_PAGE_HOST is required when HOSTED_AUTH_PAGE_ENABLED=true" };
        }
        if (!config.hostedAuthPageRoot) {
            logger.warn("[CaddyGatewayProvider] HOSTED_AUTH_PAGE_ENABLED=true but HOSTED_AUTH_PAGE_ROOT is not set, skipping");
            return { success: false, error: "HOSTED_AUTH_PAGE_ROOT is required when HOSTED_AUTH_PAGE_ENABLED=true" };
        }

        await this.hydrateFromDiskIfUninitialized();
        const host = normalizeCaddyHost(config.hostedAuthPageHost);
        const pageRoot = config.hostedAuthPageRoot;

        // hosted login page (covers / and /login.html)
        this.routesById.set("route-supauth-hosted-login", {
            "@id": "route-supauth-hosted-login",
            match: [{
                host: [host],
                path: ["/", "/login.html"],
            }],
            handle: [
                { handler: "rewrite", uri: "/authorize.html" },
                { handler: "file_server", root: pageRoot },
            ],
            terminal: true,
        });

        // authorize page (covers /oauth/authorize*)
        this.routesById.set("route-supauth-authorize-page", {
            "@id": "route-supauth-authorize-page",
            match: [{
                host: [host],
                path: ["/oauth/authorize*"],
            }],
            handle: [
                { handler: "rewrite", uri: "/authorize.html" },
                { handler: "file_server", root: pageRoot },
            ],
            terminal: true,
        });

        await this.persistAndLoad();
        logger.info(`[CaddyGatewayProvider] Hosted auth page routes registered for ${host}`);
        return { success: true };
    }
}

export class GatewayService implements GatewayProvider {
    readonly name = "caddy" as const;
    private readonly provider: GatewayProvider = new CaddyGatewayProvider();

    setupJwt(projectRef: string, jwtSecret: string) { return this.provider.setupJwt(projectRef, jwtSecret); }
    enableJwtAuth(projectRef: string) { return this.provider.enableJwtAuth(projectRef); }
    setIpRestriction(projectRef: string, allowedIps: string[]) { return this.provider.setIpRestriction(projectRef, allowedIps); }
    getRateLimit(projectRef: string) { return this.provider.getRateLimit(projectRef); }
    setRateLimit(projectRef: string, opts?: string | { second?: number; minute?: number; hour?: number }) { return this.provider.setRateLimit(projectRef, opts); }
    setCustomRouteRateLimit(projectRef: string, basePath: string, limits: { second?: number; minute?: number; hour?: number }) { return this.provider.setCustomRouteRateLimit(projectRef, basePath, limits); }
    removeCustomRouteRateLimit(projectRef: string, basePath: string) { return this.provider.removeCustomRouteRateLimit(projectRef, basePath); }
    setCors(projectRef: string, origins?: string[]) { return this.provider.setCors(projectRef, origins); }
    addCorsOriginsForHosts(projectRef: string, hosts: string[]) { return this.provider.addCorsOriginsForHosts(projectRef, hosts); }
    setupUpstream(projectRef: string, pgrstPort: number | string, gotruePort: number | string, projectRouting?: ProjectRoutingConfig | string, opts?: GatewaySetupOptions) { return this.provider.setupUpstream(projectRef, pgrstPort, gotruePort, projectRouting, opts); }
    addProjectDomains(projectRef: string, apiDomains: string[], studioDomains: string[]) { return this.provider.addProjectDomains(projectRef, apiDomains, studioDomains); }
    removeProjectDomains(projectRef: string, apiDomains: string[], studioDomains: string[]) { return this.provider.removeProjectDomains(projectRef, apiDomains, studioDomains); }
    removeService(projectRef: string) { return this.provider.removeService(projectRef); }
    addUpstreamTarget(projectRef: string, replicaIp: string) { return this.provider.addUpstreamTarget(projectRef, replicaIp); }
    removeUpstreamTarget(projectRef: string, replicaIp: string) { return this.provider.removeUpstreamTarget(projectRef, replicaIp); }
    applyConfig(projectRef: string, gatewayConfig: GatewayConfig) { return this.provider.applyConfig(projectRef, gatewayConfig); }
    rebuildAllTenantConfigs() { return this.provider.rebuildAllTenantConfigs(); }
    prepareCleanRebuild() { return this.provider.prepareCleanRebuild(); }
    withDeferredPersist<T>(fn: () => Promise<T>, shouldFlush?: (result: T) => boolean) { return this.provider.withDeferredPersist(fn, shouldFlush); }
    configureCustomGatewayRoutes(projectRef: string, routes: CustomGatewayRouteConfig[]) { return this.provider.configureCustomGatewayRoutes(projectRef, routes); }
    setupMasterRoutes() { return this.provider.setupMasterRoutes(); }
    configureStudioDomain(domain: string, port: number) { return this.provider.configureStudioDomain(domain, port); }
    upsertCertificateForSnis(opts: { projectRef: string; cert: string; key: string; snis: string[]; existingCertificateId?: string }) { return this.provider.upsertCertificateForSnis(opts); }
    configureFrontendRoute(route: FrontendGatewayRoute) { return this.provider.configureFrontendRoute(route); }
    removeFrontendRoute(projectRef: string, deploymentId: string) { return this.provider.removeFrontendRoute(projectRef, deploymentId); }
    readFrontendStaticRoot(projectRef: string, deploymentId: string) { return this.provider.readFrontendStaticRoot(projectRef, deploymentId); }
    setupHostedAuthRoutes() { return this.provider.setupHostedAuthRoutes(); }
    ensureGatewayReady(opts?: { maxAttempts?: number; intervalMs?: number }) { return this.provider.ensureGatewayReady(opts); }
    checkCaddyConnectivity() { return this.provider.checkCaddyConnectivity(); }
    confirmCanonicalState() { return this.provider.confirmCanonicalState(); }
}

export const gatewayService = new GatewayService();

function canonicalReconcileAccepted(state: CanonicalGatewayReconcileState): boolean {
    return state.tenants.success
        && state.hostedAuth.success
        && state.frontends.errors.length === 0;
}

function canonicalReconcileError(state: CanonicalGatewayReconcileState): Error {
    const failures = [
        ...state.tenants.errors.map((message) => `tenant: ${message}`),
        ...(state.hostedAuth.error ? [`hosted auth: ${state.hostedAuth.error}`] : []),
        ...state.frontends.errors.map((message) => `frontend: ${message}`),
    ];
    return new Error(`Canonical gateway reconciliation failed: ${failures.join("; ") || "unknown error"}`);
}

export async function reconcileCanonicalGatewayRoutes(
    dependencies: CanonicalGatewayReconcileDependencies = {},
): Promise<CanonicalGatewayReconcileState> {
    const gateway = dependencies.gateway ?? gatewayService;
    const reconcileFrontends = dependencies.reconcileFrontends ?? (async () => {
        const { frontendService } = await import("./frontend.service");
        return frontendService.reconcileGatewayRoutes();
    });
    const state = await gateway.withDeferredPersist(async () => {
        await gateway.prepareCleanRebuild();
        await gateway.setupMasterRoutes();
        const tenants = await gateway.rebuildAllTenantConfigs();
        const hostedAuth = await gateway.setupHostedAuthRoutes();
        const frontends = await reconcileFrontends();
        return { tenants, hostedAuth, frontends };
    }, canonicalReconcileAccepted);
    if (!canonicalReconcileAccepted(state)) throw canonicalReconcileError(state);
    await gateway.confirmCanonicalState();
    return state;
}
