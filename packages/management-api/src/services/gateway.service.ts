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
import { normalizeProjectConfig, normalizeThirdPartyAuthConfig } from "../utils/project-config";
import { uniqueStrings } from "../utils/strings";
import {
    type CaddyHeaderValue,
    type CaddyRoute,
    type CustomGatewayRouteConfig,
    DEFAULT_CORS_ORIGINS,
    buildTenantCorsOrigins,
    customGatewayRouteId,
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
    buildTenantCorsOrigins,
    normalizeCustomGatewayRoute,
    normalizeCustomGatewayRoutes,
} from "./gateway-route-builders";
export type { CustomGatewayRouteConfig } from "./gateway-route-builders";

import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface GatewayConfig {
    rateLimitTier?: "free" | "pro" | "enterprise";
    corsOrigins?: string;
    jwtEnabled?: boolean;
    jwtSecret?: string;
}

interface RateLimitConfig {
    second: number;
    minute: number;
    hour: number;
}

type GatewaySetupOptions = { functionsPort?: number; storagePort?: number; realtimeApiPort?: number; realtimeWsPort?: number };

export interface FrontendGatewayRoute {
    projectRef: string;
    deploymentId: string;
    hosts: string[];
    port?: number;
    root?: string;
    mode?: "proxy" | "static";
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
    upsertCertificateForSnis(opts: { projectRef: string; cert: string; key: string; snis: string[]; existingCertificateId?: string }): Promise<{ success: boolean; certificateId?: string; error?: string }>;
    configureFrontendRoute(route: FrontendGatewayRoute): Promise<void>;
    removeFrontendRoute(projectRef: string, deploymentId: string): Promise<void>;
    setupHostedAuthRoutes(): Promise<{ success: boolean; error?: string }>;
    ensureGatewayReady(opts?: { maxAttempts?: number; intervalMs?: number }): Promise<{ ready: boolean; error?: string }>;
    checkCaddyConnectivity(): Promise<boolean>;
}

function getRateLimitConfig(tier: string): RateLimitConfig {
    switch (tier) {
        case "pro": return { second: 100, minute: 2000, hour: 50000 };
        case "enterprise": return { second: 1000, minute: 50000, hour: 1000000 };
        default: return { second: 10, minute: 100, hour: 1000 };
    }
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

const CADDY_GENERATED_CONFIG_NOTICE_LOG =
    "supacloud_notice_do_not_edit_caddy_config_json_use_supacloud_cli_management_api_or_web_console";
const CADDY_UNMATCHED_HOST_ROUTE_ID = "route-system-unmatched-host-404";

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
    private hydrated = false;

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

    // 带（指数）退避的 Caddy 就绪探测：caddy 容器在 docker 模式下晚于 management-api 启动，
    // 首次 persistAndLoad 的 POST /load 往往因 caddy 尚未监听而失败。该方法轮询 Admin API
    // 直到可达，再补一次 persistAndLoad 让 JSON 路由真正接管 bootstrap Caddyfile。
    async ensureGatewayReady(opts?: { maxAttempts?: number; intervalMs?: number }): Promise<{ ready: boolean; error?: string }> {
        const maxAttempts = Math.max(1, Math.trunc(opts?.maxAttempts ?? 30));
        const intervalMs = Math.max(1, Math.trunc(opts?.intervalMs ?? 1000));
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const reachable = await this.checkCaddyConnectivity();
            if (reachable) {
                try {
                    await this.persistAndLoad();
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
                        policies: [{ on_demand: true, key_type: "p256" }],
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

    private async hydrateFromDisk(): Promise<void> {
        if (this.hydrated) return;
        this.hydrated = true;

        try {
            const raw = await fs.readFile(config.caddyConfigPath, "utf8");
            const parsed = JSON.parse(raw) as CaddyConfig;
            const routes = parsed.apps?.http?.servers?.supacloud?.routes;
            if (Array.isArray(routes)) {
                for (const route of routes) {
                    const id = typeof route?.["@id"] === "string" ? route["@id"] : "";
                    if (!id) continue;
                    if (!this.routesById.has(id)) this.routesById.set(id, this.migrateHydratedRoute(id, route));
                    this.hydrateRateLimitFromRoute(id, route);
                }
            }

            this.hydrateCertificatesFromConfig(parsed);
        } catch (error: unknown) {
            const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
            if (code !== "ENOENT") {
                logger.warn(`[CaddyGatewayProvider] Failed to hydrate existing Caddy config: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
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
        try {
            const raw = await fs.readFile(config.caddyConfigPath, "utf8");
            this.hydrateCertificatesFromConfig(JSON.parse(raw) as CaddyConfig);
        } catch (error: unknown) {
            const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
            if (code !== "ENOENT") {
                logger.warn(`[CaddyGatewayProvider] Failed to hydrate existing Caddy certificates: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    async prepareCleanRebuild(): Promise<void> {
        await this.hydrateCertificatesFromDisk();
        this.routesById.clear();
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
        for (const zone of Object.values(zones as Record<string, any>)) {
            const window = String(zone?.window || "");
            const maxEvents = Number(zone?.max_events || 0);
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
        return aid.localeCompare(bid);
    }

    private makeRateLimitHandler(projectRef: string, limits: { second: number; minute: number; hour: number }, suffix = "default"): Record<string, unknown> {
        const zones: Record<string, unknown> = {};
        const entries: Array<[string, number, string]> = [
            ["second", limits.second, "1s"],
            ["minute", limits.minute, "1m"],
            ["hour", limits.hour, "1h"],
        ];

        for (const [name, maxEvents, window] of entries) {
            if (!Number.isFinite(maxEvents) || maxEvents <= 0) continue;
            zones[`supacloud_${sanitizeCaddyId(projectRef)}_${sanitizeCaddyId(suffix)}_${name}`] = {
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

    private async validateCandidateConfig(candidatePath: string): Promise<void> {
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
    }

    private async writeAndLoadCurrentConfig(): Promise<void> {
        const next = this.baseConfig();
        await fs.mkdir(path.dirname(config.caddyConfigPath), { recursive: true });
        const tmpPath = `${config.caddyConfigPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await fs.writeFile(tmpPath, JSON.stringify(next, null, 2));

        try {
            await this.validateCandidateConfig(tmpPath);
            const res = await this.caddyRequest("/load", "POST", next);
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`Caddy /load failed with ${res.status}: ${text}`);
            }
            await fs.rename(tmpPath, config.caddyConfigPath);
            await fs.writeFile(path.join(path.dirname(config.caddyConfigPath), "DO-NOT-EDIT.txt"), caddyGeneratedConfigNotice());
        } catch (error) {
            await fs.unlink(tmpPath).catch(() => undefined);
            throw error;
        }
    }

    private async persistAndLoad(): Promise<void> {
        if (this.deferredPersistDepth > 0) {
            this.deferredPersistPending = true;
            return;
        }

        const previous = this.persistAndLoadTail.catch(() => undefined);
        const current = previous.then(() => this.writeAndLoadCurrentConfig());
        this.persistAndLoadTail = current.catch(() => undefined);
        await current;
    }

    async withDeferredPersist<T>(fn: () => Promise<T>, shouldFlush: (result: T) => boolean = () => true): Promise<T> {
        this.deferredPersistDepth++;
        let completed = false;
        let result: T;
        try {
            result = await fn();
            completed = true;
            return result;
        } finally {
            this.deferredPersistDepth--;
            if (this.deferredPersistDepth === 0) {
                const flush = completed && this.deferredPersistPending && shouldFlush(result!);
                this.deferredPersistPending = false;
                if (flush) await this.persistAndLoad();
            }
        }
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
        const corsSubroute = opts.corsOrigins ? makeCorsSubroute(opts.corsOrigins) : null;
        if (corsSubroute) handle.push(corsSubroute);
        if (opts.rewriteUri) handle.push({ handler: "rewrite", uri: opts.rewriteUri });
        else if (opts.stripPrefix) handle.push({ handler: "rewrite", strip_path_prefix: opts.stripPrefix });
        handle.push(makeReverseProxy(opts.upstream, requestHeaders, opts.readTimeout, opts.preserveUpstreamCors, opts.streaming, opts.upstreamTls, opts.upstreamTlsInsecureSkipVerify));

        return {
            "@id": opts.id,
            match: [{
                host: uniqueStrings(opts.hosts.map(normalizeCaddyHost)),
                path: Array.isArray(opts.path) ? opts.path : [opts.path],
            }],
            handle,
            terminal: true,
        };
    }

    private async putRoute(route: CaddyRoute): Promise<void> {
        const id = String(route["@id"]);
        this.routesById.set(id, route);
        await this.persistAndLoad();
    }

    private async removeRoutes(ids: string[]): Promise<void> {
        for (const id of ids) this.routesById.delete(id);
        await this.persistAndLoad();
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
        await this.hydrateFromDiskIfUninitialized();
        const limits = typeof opts === "string" ? getRateLimitConfig(opts) : {
            second: opts.second ?? 10,
            minute: opts.minute ?? 100,
            hour: opts.hour ?? 1000,
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
        await this.hydrateFromDiskIfUninitialized();
        const routeId = `route-custom-${projectRef}-${hashStr(basePath)}`;
        this.customRateLimits.delete(routeId);
        this.routesById.delete(routeId);
        await this.persistAndLoad();
        return true;
    }

    async configureCustomGatewayRoutes(projectRef: string, routes: CustomGatewayRouteConfig[]): Promise<{ success: boolean; error?: string }> {
        try {
            await this.hydrateFromDiskIfUninitialized();
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
        await this.hydrateFromDiskIfUninitialized();
        const allHosts = uniqueStrings([...this.hostsForProjectRoutes(projectRef), ...hosts]);
        return this.setCors(projectRef, buildTenantCorsOrigins(projectRef, undefined, allHosts));
    }

    async setupUpstream(projectRef: string, pgrstPort: number | string, gotruePort: number | string, projectRouting?: ProjectRoutingConfig | string, opts?: GatewaySetupOptions): Promise<{ success: boolean; error?: string }> {
        try {
            const hostIp = await this.detectHostIp();
            const projectConfig = normalizeProjectConfig(projectRouting);
            const routingConfig = normalizeProjectRoutingConfig(projectRouting);
            const authConfig = projectConfig.auth && typeof projectConfig.auth === "object" && !Array.isArray(projectConfig.auth)
                ? projectConfig.auth as Record<string, unknown>
                : {};
            const thirdPartyAuth = normalizeThirdPartyAuthConfig(authConfig.third_party_auth);
            const externalAuthUpstream = thirdPartyAuth.enabled && thirdPartyAuth.auth_endpoint_mode === "external" && thirdPartyAuth.auth_upstream
                ? normalizeCustomUpstream(thirdPartyAuth.auth_upstream)
                : null;
            const authUpstream = externalAuthUpstream?.dial || `${hostIp}:${gotruePort}`;
            const authHeaders = externalAuthUpstream && thirdPartyAuth.auth_host_header
                ? [`Host:${thirdPartyAuth.auth_host_header}`, `X-Forwarded-Host:${thirdPartyAuth.auth_host_header}`]
                : undefined;
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

            const routes = [
                this.makeRoute({ id: caddyRouteId(projectRef, "rest"), hosts, path: "/rest/v1*", upstream: `${hostIp}:${pgrstPort}`, projectRef, stripPrefix: "/rest/v1", corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "graphql"), hosts, path: "/graphql/v1*", upstream: `${hostIp}:${pgrstPort}`, projectRef, rewriteUri: "/rpc/graphql", headers: ["Content-Profile:graphql_public", "Accept-Profile:graphql_public"], corsOrigins }),
                this.makeRoute({
                    id: caddyRouteId(projectRef, "auth"),
                    hosts,
                    path: "/auth/v1*",
                    upstream: authUpstream,
                    projectRef,
                    stripPrefix: "/auth/v1",
                    headers: authHeaders,
                    corsOrigins,
                    upstreamTls: externalAuthUpstream?.tls,
                    upstreamTlsInsecureSkipVerify: thirdPartyAuth.auth_upstream_tls_insecure_skip_verify,
                }),
                this.makeRoute({
                    id: caddyRouteId(projectRef, "gotrue-well-known"),
                    hosts,
                    path: "/.well-known/oauth-authorization-server/auth/v1*",
                    upstream: authUpstream,
                    projectRef,
                    headers: authHeaders,
                    corsOrigins,
                    upstreamTls: externalAuthUpstream?.tls,
                    upstreamTlsInsecureSkipVerify: thirdPartyAuth.auth_upstream_tls_insecure_skip_verify,
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
            if (authHosts.length > 0) {
                this.routesById.set(caddyRouteId(projectRef, "auth-domain-auth"), this.makeRoute({
                    id: caddyRouteId(projectRef, "auth-domain-auth"),
                    hosts: authHosts,
                    path: "/auth/v1*",
                    upstream: authUpstream,
                    projectRef,
                    stripPrefix: "/auth/v1",
                    headers: authHeaders,
                    corsOrigins,
                    upstreamTls: externalAuthUpstream?.tls,
                    upstreamTlsInsecureSkipVerify: thirdPartyAuth.auth_upstream_tls_insecure_skip_verify,
                }));
                this.routesById.set(caddyRouteId(projectRef, "auth-domain-gotrue-well-known"), this.makeRoute({
                    id: caddyRouteId(projectRef, "auth-domain-gotrue-well-known"),
                    hosts: authHosts,
                    path: "/.well-known/oauth-authorization-server/auth/v1*",
                    upstream: authUpstream,
                    projectRef,
                    headers: authHeaders,
                    corsOrigins,
                    upstreamTls: externalAuthUpstream?.tls,
                    upstreamTlsInsecureSkipVerify: thirdPartyAuth.auth_upstream_tls_insecure_skip_verify,
                }));
            } else {
                this.routesById.delete(caddyRouteId(projectRef, "auth-domain-auth"));
                this.routesById.delete(caddyRouteId(projectRef, "auth-domain-gotrue-well-known"));
            }
            await this.persistAndLoad();
            logger.info(`[CaddyGatewayProvider] Routes registered for ${projectRef}`);
            return { success: true };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`[CaddyGatewayProvider] Failed to setup upstream for ${projectRef}:`, message);
            return { success: false, error: message };
        }
    }

    async addProjectDomains(projectRef: string, apiDomains: string[], studioDomains: string[]): Promise<boolean> {
        await this.hydrateFromDiskIfUninitialized();
        const existingKinds = ["rest", "graphql", "auth", "gotrue-well-known", "functions", "storage", "realtime-api", "realtime", "management", "acme"];
        for (const kind of existingKinds) {
            const route = this.routesById.get(caddyRouteId(projectRef, kind));
            const match = Array.isArray(route?.match) ? route.match[0] as Record<string, unknown> | undefined : undefined;
            if (match) match.host = uniqueStrings([...(Array.isArray(match.host) ? match.host as string[] : []), ...apiDomains]);
        }
        const studio = this.routesById.get(caddyRouteId(projectRef, "studio"));
        const studioMatch = Array.isArray(studio?.match) ? studio.match[0] as Record<string, unknown> | undefined : undefined;
        if (studioMatch) studioMatch.host = uniqueStrings([...(Array.isArray(studioMatch.host) ? studioMatch.host as string[] : []), ...studioDomains]);
        await this.persistAndLoad();
        return true;
    }

    async removeProjectDomains(projectRef: string, apiDomains: string[], studioDomains: string[]): Promise<boolean> {
        await this.hydrateFromDiskIfUninitialized();
        const remove = new Set([...apiDomains, ...studioDomains].map(normalizeCaddyHost));
        for (const route of this.routesById.values()) {
            const id = String(route["@id"] || "");
            if (!id.includes(`-${projectRef}-`)) continue;
            const match = Array.isArray(route.match) ? route.match[0] as Record<string, unknown> | undefined : undefined;
            if (match && Array.isArray(match.host)) {
                match.host = (match.host as string[]).filter((host) => !remove.has(normalizeCaddyHost(host)));
            }
        }
        await this.persistAndLoad();
        return true;
    }

    async removeService(projectRef: string): Promise<{ success: boolean; error?: string }> {
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

    async upsertCertificateForSnis(opts: { projectRef: string; cert: string; key: string; snis: string[]; existingCertificateId?: string }): Promise<{ success: boolean; certificateId?: string; error?: string }> {
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
        if (route.mode === "static" || route.root) {
            await this.addCorsOriginsForHosts(route.projectRef, route.hosts);
            await this.putRoute(this.makeStaticFrontendRoute(route));
            return;
        }
        if (!route.port) {
            throw new Error("Caddy proxy frontend routes require an upstream port");
        }
        await this.addCorsOriginsForHosts(route.projectRef, route.hosts);
        await this.putRoute(this.makeRoute({
            id: `route-frontend-${route.projectRef}-${route.deploymentId}`,
            hosts: route.hosts,
            path: "/*",
            upstream: `127.0.0.1:${route.port}`,
            projectRef: route.projectRef,
            readTimeout: 60_000,
        }));
    }

    async removeFrontendRoute(projectRef: string, deploymentId: string): Promise<void> {
        await this.removeRoutes([`route-frontend-${projectRef}-${deploymentId}`]);
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
    upsertCertificateForSnis(opts: { projectRef: string; cert: string; key: string; snis: string[]; existingCertificateId?: string }) { return this.provider.upsertCertificateForSnis(opts); }
    configureFrontendRoute(route: FrontendGatewayRoute) { return this.provider.configureFrontendRoute(route); }
    removeFrontendRoute(projectRef: string, deploymentId: string) { return this.provider.removeFrontendRoute(projectRef, deploymentId); }
    setupHostedAuthRoutes() { return this.provider.setupHostedAuthRoutes(); }
    ensureGatewayReady(opts?: { maxAttempts?: number; intervalMs?: number }) { return this.provider.ensureGatewayReady(opts); }
    checkCaddyConnectivity() { return this.provider.checkCaddyConnectivity(); }
}

export const gatewayService = new GatewayService();
