import { config } from "../config";
import { $ } from "bun";
import { logger } from "../utils/logger";
import { sql } from "../db";
import {
    type ProjectRoutingConfig,
    normalizeProjectRoutingConfig,
    resolveProjectApiHost,
    resolveProjectStudioHost,
} from "../utils/project-routing";
import { normalizeProjectConfig } from "../utils/project-config";

export const DEFAULT_CORS_HEADERS = [
    "Accept", "Accept-Language", "Authorization", "Content-Language", "Content-Type",
    "apikey", "x-client-info", "x-project-ref", "X-Api-Version", "x-supabase-api-version",
    "Prefer", "Content-Profile", "accept-profile", "Range", "Range-Unit",
    "x-upsert", "Cache-Control", "x-retry-count", "x-metadata",
    "x-supacloud-async", "x-supacloud-timeout", "x-supacloud-retries",
    "x-supacloud-idempotency-key", "x-supacloud-function-version",
    "x-supacloud-trace-id", "x-supacloud-correlation-id",
    "x-supacloud-business-task-id", "x-supacloud-task-metadata",
];
export const DEFAULT_CORS_EXPOSED = [
    "Content-Length", "Content-Range", "X-Content-Range", "X-JSON",
    "x-supabase-api-version", "X-Client-Info", "Prefer",
    "Content-Profile", "accept-profile", "Range", "Range-Unit",
    "X-Relay-Error", "link", "x-total-count",
];
const UPSTREAM_CORS_RESPONSE_HEADERS = [
    "Access-Control-Allow-Origin",
    "Access-Control-Allow-Credentials",
    "Access-Control-Allow-Methods",
    "Access-Control-Allow-Headers",
    "Access-Control-Expose-Headers",
    "Access-Control-Max-Age",
] as const;
export const DEFAULT_CORS_ORIGINS = [
    "~^https?://.*\\.dbbaby\\.top$",
    "~^https?://localhost(:[0-9]+)?$",
    "~^https?://127\\.0\\.0\\.1(:[0-9]+)?$",
];

function hostToCorsOrigins(host: string): string[] {
    const trimmed = host.trim();
    if (!trimmed) return [];

    try {
        const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
        const hostname = parsed.host;
        if (!hostname) return [];
        if (hostname.startsWith("localhost") || hostname.startsWith("127.0.0.1")) {
            return [`http://${hostname}`, `https://${hostname}`];
        }
        return [`https://${hostname}`];
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
    const hosts = [
        `${projectRef}.api.${config.baseDomain}`,
        resolveProjectApiHost(projectRef, routingConfig),
        `studio-${projectRef}.${config.baseDomain}`,
        resolveProjectStudioHost(projectRef, routingConfig),
        ...extraHosts,
    ];

    return Array.from(new Set([
        ...DEFAULT_CORS_ORIGINS,
        ...hosts.flatMap(hostToCorsOrigins),
    ]));
}

import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface GatewayConfig {
    rateLimitTier?: "free" | "pro" | "enterprise";
    corsOrigins?: string;
    jwtEnabled?: boolean;
    jwtSecret?: string;
}

export interface KongResponse {
    data?: Array<Record<string, unknown>>;
    id?: string;
    [key: string]: unknown;
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
    readonly name: "caddy" | "kong";
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
    setupMasterRoutes(): Promise<void>;
    upsertCertificateForSnis(opts: { projectRef: string; cert: string; key: string; snis: string[]; existingCertificateId?: string }): Promise<{ success: boolean; certificateId?: string; error?: string }>;
    configureFrontendRoute(route: FrontendGatewayRoute): Promise<void>;
    removeFrontendRoute(projectRef: string, deploymentId: string): Promise<void>;
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

export class KongGatewayProvider implements GatewayProvider {
    readonly name = "kong" as const;
    private readonly KONG_ADMIN_URL = config.kongAdminUrl;
    private readonly TENANT_DIR = config.tenantConfigDir;

    // --- Kong Admin API helper methods ---
    private async kongRequest(path: string, method: string = "GET", body?: Record<string, unknown>): Promise<KongResponse> {
        const init: RequestInit = {
            method,
            headers: { "Content-Type": "application/json" },
        };
        if (body) {
            init.body = JSON.stringify(body);
        }
        const res = await fetch(`${this.KONG_ADMIN_URL}${path}`, init);
        const text = await res.text();
        if (!res.ok && res.status !== 409) {
            logger.warn(`Kong API ${method} ${path} returned ${res.status}: ${text}`);
        }
        return text ? JSON.parse(text) : {};
    }

    async checkKongConnectivity(): Promise<boolean> {
        try {
            const res = await fetch(`${this.KONG_ADMIN_URL}/status`, {
                method: "GET",
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
                logger.info(`[GatewayService] Kong Admin API is reachable at ${this.KONG_ADMIN_URL}`);
                return true;
            }
            logger.warn(`[GatewayService] Kong Admin API returned ${res.status} at ${this.KONG_ADMIN_URL}`);
            return false;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[GatewayService] Kong Admin API is unreachable at ${this.KONG_ADMIN_URL}: ${msg}`);
            logger.error(`[GatewayService] Ensure Kong is running and KONG_ADMIN_URL is correctly configured`);
            return false;
        }
    }

    // --- Consumer & JWT ---

    async upsertCertificateForSnis(opts: {
        projectRef: string;
        cert: string;
        key: string;
        snis: string[];
        existingCertificateId?: string;
    }): Promise<{ success: boolean; certificateId?: string; error?: string }> {
        const snis = Array.from(new Set(opts.snis.map((sni) => sni.trim().toLowerCase()).filter(Boolean)));
        if (!opts.cert.trim() || !opts.key.trim()) {
            return { success: false, error: "Certificate and private key are required" };
        }
        if (snis.length === 0) {
            return { success: false, error: "At least one SNI is required" };
        }

        const tags = [`supacloud`, `supacloud-project:${opts.projectRef}`];
        const payload = {
            cert: opts.cert,
            key: opts.key,
            tags,
        };

        try {
            let certificateId = opts.existingCertificateId || "";

            if (certificateId) {
                const patched = await this.kongRequest(`/certificates/${certificateId}`, "PATCH", payload);
                certificateId = String(patched.id || certificateId);
            }

            if (!certificateId) {
                const existing = await this.kongRequest(`/certificates?tags=supacloud-project:${encodeURIComponent(opts.projectRef)}`);
                const match = existing.data?.find((item) => Array.isArray(item.tags) && (item.tags as string[]).includes(`supacloud-project:${opts.projectRef}`));
                if (match?.id) {
                    const patched = await this.kongRequest(`/certificates/${match.id}`, "PATCH", payload);
                    certificateId = String(patched.id || match.id);
                }
            }

            if (!certificateId) {
                const created = await this.kongRequest("/certificates", "POST", payload);
                certificateId = String(created.id || "");
            }

            if (!certificateId) {
                return { success: false, error: "Kong did not return a certificate id" };
            }

            for (const name of snis) {
                await this.kongRequest(`/snis/${encodeURIComponent(name)}`, "PUT", {
                    name,
                    certificate: { id: certificateId },
                    tags,
                });
            }

            return { success: true, certificateId };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`[GatewayService] Failed to upsert certificate for ${opts.projectRef}`, { error: message });
            return { success: false, error: message };
        }
    }

    async ensureConsumer(projectRef: string): Promise<void> {
        await this.kongRequest("/consumers", "POST", {
            username: projectRef,
            custom_id: projectRef,
        });
    }

    async setupJwt(projectRef: string, jwtSecret: string): Promise<boolean> {
        try {
            await this.ensureConsumer(projectRef);

            // Delete old JWT credentials
            const existing = await this.kongRequest(`/consumers/${projectRef}/jwt`);
            for (const cred of existing?.data ?? []) {
                await this.kongRequest(`/consumers/${projectRef}/jwt/${cred.id}`, "DELETE");
            }

            // Create new credentials
            await this.kongRequest(`/consumers/${projectRef}/jwt`, "POST", {
                key: "supabase",
                secret: jwtSecret,
                algorithm: "HS256",
            });
            return true;
        } catch (error: unknown) {
            logger.error(`Failed to setup JWT for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    // --- Rate Limiting ---

    /** Query current rate-limit config from Kong Admin API */
    async getRateLimit(projectRef: string): Promise<{ tier: string; second: number; minute: number; hour: number; enabled: boolean } | null> {
        try {
            // Try all possible route name patterns
            for (const routeName of [`route-svc-pgrst-${projectRef}`, `route-${projectRef}`]) {
                const pluginsRes = await this.kongRequest(`/routes/${routeName}/plugins`);
                const existing = pluginsRes?.data?.find((p: Record<string, unknown>) => p.name === "rate-limiting");
                if (existing) {
                    const cfg = existing.config as Record<string, unknown>;
                    const second = (cfg?.second as number) || 0;
                    const minute = (cfg?.minute as number) || 0;
                    const hour = (cfg?.hour as number) || 0;
                    // Reverse-detect tier
                    let tier = "custom";
                    if (second === 10 && minute === 100 && hour === 1000) tier = "free";
                    else if (second === 100 && minute === 2000 && hour === 50000) tier = "pro";
                    else if (second === 1000 && minute === 50000 && hour === 1000000) tier = "enterprise";
                    return { tier, second, minute, hour, enabled: (existing.enabled as boolean) ?? true };
                }
            }
            return { tier: "none", second: 0, minute: 0, hour: 0, enabled: false };
        } catch (error: unknown) {
            logger.error(`Failed to get rate limit for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return null;
        }
    }

    /** Set rate limit — accepts tier name OR custom numeric values */
    async setRateLimit(projectRef: string, opts: string | { second?: number; minute?: number; hour?: number } = "free"): Promise<boolean> {
        try {
            let second: number, minute: number, hour: number;
            if (typeof opts === "string") {
                ({ second, minute, hour } = getRateLimitConfig(opts));
            } else {
                ({ second = 10, minute = 100, hour = 1000 } = opts);
            }

            // Apply to the primary API route
            const routeName = `route-svc-pgrst-${projectRef}`;
            const pluginsRes = await this.kongRequest(`/routes/${routeName}/plugins`);
            const existing = pluginsRes?.data?.find((p: Record<string, unknown>) => p.name === "rate-limiting");

            const payload = {
                name: "rate-limiting",
                config: { second, minute, hour, policy: "local" },
            };

            if (existing) {
                await this.kongRequest(`/plugins/${existing.id}`, "PATCH", payload);
            } else {
                await this.kongRequest(`/routes/${routeName}/plugins`, "POST", payload);
            }
            return true;
        } catch (error: unknown) {
            logger.error(`Failed to set rate limit for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    // --- Custom Rate Limiting ---

    private readonly MAX_RATE_LIMIT = { second: 100, minute: 2000, hour: 50000 };

    private getServiceForPath(basePath: string, projectRef: string): string | null {
        if (basePath.startsWith("/rest/v1")) return `svc-pgrst-${projectRef}`;
        if (basePath.startsWith("/graphql/v1")) return `svc-graphql-${projectRef}`;
        if (basePath.startsWith("/auth/v1")) return `svc-gotrue-${projectRef}`;
        if (basePath.startsWith("/functions/v1")) return `svc-functions-${projectRef}`;
        if (basePath.startsWith("/storage/v1")) return `svc-storage-${projectRef}`;
        if (basePath.startsWith("/realtime/v1")) return `svc-realtime-${projectRef}`;
        return null;
    }

    async setCustomRouteRateLimit(projectRef: string, basePath: string, limits: { second?: number; minute?: number; hour?: number }): Promise<boolean> {
        try {
            const serviceName = this.getServiceForPath(basePath, projectRef);
            if (!serviceName) {
                logger.error(`[GatewayService] Cannot determine upstream service for custom path: ${basePath}`);
                return false;
            }

            // Cap limits by platform max
            const second = Math.min(limits.second ?? this.MAX_RATE_LIMIT.second, this.MAX_RATE_LIMIT.second);
            const minute = Math.min(limits.minute ?? this.MAX_RATE_LIMIT.minute, this.MAX_RATE_LIMIT.minute);
            const hour = Math.min(limits.hour ?? this.MAX_RATE_LIMIT.hour, this.MAX_RATE_LIMIT.hour);

            const routeName = `route-custom-${projectRef}-${hashStr(basePath)}`;

            // 1. Check if we need to infer hosts from parent route
            const parentRouteName = `route-${serviceName}`;
            const parentRes = await this.kongRequest(`/routes/${parentRouteName}`);
            const hosts = parentRes?.hosts as string[] | undefined;

            // 2. Upsert custom route
            await this.kongRequest(`/routes/${routeName}`, "PUT", {
                name: routeName,
                service: { name: serviceName },
                paths: [basePath],
                hosts: (hosts && hosts.length > 0) ? hosts : undefined,
                strip_path: parentRes?.strip_path ?? true,
                preserve_host: true,
            });

            // 3. Re-attach necessary routing plugins from the parent (e.g., request-transformer, cors)
            // They are crucial for tenant context.
            await this.upsertRoutePlugin(routeName, "request-transformer", {
                add: { headers: [`x-project-ref:${projectRef}`] }
            });
            await this.upsertRoutePlugin(routeName, "cors", {
                origins: DEFAULT_CORS_ORIGINS,
                methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                headers: DEFAULT_CORS_HEADERS,
                exposed_headers: DEFAULT_CORS_EXPOSED,
                credentials: true,
                max_age: 3600,
            });

            // 4. Apply rate limiting plugin
            const pluginsRes = await this.kongRequest(`/routes/${routeName}/plugins`);
            const existingRl = pluginsRes?.data?.find((p: Record<string, unknown>) => p.name === "rate-limiting");
            
            const payload = {
                name: "rate-limiting",
                config: { second, minute, hour, policy: "local" },
            };

            if (existingRl) {
                await this.kongRequest(`/plugins/${existingRl.id}`, "PATCH", payload);
            } else {
                await this.kongRequest(`/routes/${routeName}/plugins`, "POST", payload);
            }

            logger.info(`[GatewayService] Custom rate limit set for ${projectRef} at ${basePath}`);
            return true;
        } catch (error: unknown) {
            logger.error(`Failed to set custom rate limit for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    async removeCustomRouteRateLimit(projectRef: string, basePath: string): Promise<boolean> {
        try {
            const routeName = `route-custom-${projectRef}-${hashStr(basePath)}`;
            await this.kongRequest(`/routes/${routeName}`, "DELETE");
            logger.info(`[GatewayService] Custom rate limit removed for ${projectRef} at ${basePath}`);
            return true;
        } catch (error: unknown) {
            logger.error(`Failed to remove custom rate limit for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    // --- CORS ---

    async setCors(projectRef: string, origins: string[] = DEFAULT_CORS_ORIGINS): Promise<boolean> {
        try {
            const routes = ['pgrst', 'graphql', 'gotrue', 'gotrue-well-known', 'realtime', 'realtime-api', 'storage', 'functions', 'api-root'].map(r => `route-svc-${r}-${projectRef}`);
            let allSuccess = true;
            for (const routeName of routes) {
                try {
                    const pluginsRes = await this.kongRequest(`/routes/${routeName}/plugins?name=cors`);
                    const existing = pluginsRes?.data?.[0];

                    const payload = {
                        name: "cors",
                        config: {
                            origins,
                            methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                            headers: DEFAULT_CORS_HEADERS,
                            exposed_headers: DEFAULT_CORS_EXPOSED,
                            credentials: false,
                            max_age: 86400,
                            preflight_continue: false,
                        },
                    };

                    if (existing) {
                        await this.kongRequest(`/plugins/${existing.id}`, "PATCH", payload);
                    } else {
                        await this.kongRequest(`/routes/${routeName}/plugins`, "POST", payload);
                    }
                } catch (e: unknown) {
                    allSuccess = false;
                    logger.error(`Failed to set CORS for route ${routeName}:`, (e instanceof Error ? e.message : String(e)));
                }
            }
            return allSuccess;
        } catch (error: unknown) {
            logger.error(`Failed to set CORS for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    async addCorsOriginsForHosts(projectRef: string, hosts: string[]): Promise<boolean> {
        return this.setCors(projectRef, buildTenantCorsOrigins(projectRef, undefined, hosts));
    }

    // --- JWT Auth Plugin ---

    async enableJwtAuth(projectRef: string): Promise<boolean> {
        try {
            const routes = ['pgrst', 'graphql', 'gotrue', 'realtime', 'realtime-api', 'storage', 'functions', 'api-root'].map(r => `route-svc-${r}-${projectRef}`);
            let allSuccess = true;
            for (const routeName of routes) {
                try {
                    const pluginsRes = await this.kongRequest(`/routes/${routeName}/plugins`);
                    const hasJwt = pluginsRes?.data?.some((p: Record<string, unknown>) => p.name === "jwt");
                    if (!hasJwt) {
                        await this.kongRequest(`/routes/${routeName}/plugins`, "POST", {
                            name: "jwt",
                            config: { key_claim_name: "iss", claims_to_verify: ["exp"] },
                        });
                    }
                } catch (e: unknown) {
                    allSuccess = false;
                    logger.error(`Failed to enable JWT auth for route ${routeName}:`, (e instanceof Error ? e.message : String(e)));
                }
            }
            return allSuccess;
        } catch (error: unknown) {
            logger.error(`Failed to enable JWT auth for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    // --- IP Restriction Plugin ---

    async setIpRestriction(projectRef: string, allowedIps: string[]): Promise<boolean> {
        try {
            const routeName = `route-svc-pgrst-${projectRef}`; // Network restrictions apply heavily to API layer
            const pluginsRes = await this.kongRequest(`/routes/${routeName}/plugins`);
            const existing = pluginsRes?.data?.find((p: Record<string, unknown>) => p.name === "ip-restriction");

            if (allowedIps.length === 0) {
                // If empty list, remove Restriction
                if (existing) await this.kongRequest(`/plugins/${existing.id}`, "DELETE");
                return true;
            }

            const payload = {
                name: "ip-restriction",
                config: { allow: allowedIps },
            };

            if (existing) {
                await this.kongRequest(`/plugins/${existing.id}`, "PATCH", payload);
            } else {
                await this.kongRequest(`/routes/${routeName}/plugins`, "POST", payload);
            }
            return true;
        } catch (error: unknown) {
            logger.error(`Failed to set IP restrictions for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    // --- Plugin Upsert Helper ---

    private async upsertRoutePlugin(routeName: string, pluginName: string, config: Record<string, unknown>): Promise<void> {
        try {
            const pluginsRes = await this.kongRequest(`/routes/${routeName}/plugins`);
            const existing = pluginsRes?.data?.find((p: Record<string, unknown>) => p.name === pluginName);

            const payload = {
                name: pluginName,
                config
            };

            if (existing) {
                await this.kongRequest(`/plugins/${existing.id}`, "PATCH", payload);
            } else {
                await this.kongRequest(`/routes/${routeName}/plugins`, "POST", payload);
            }
        } catch (error: unknown) {
            logger.error(`Failed to upsert plugin ${pluginName} for route ${routeName}:`, error instanceof Error ? error.message : String(error));
        }
    }

    // --- Pure Native Kong REST Management (Replaces Declarative YAML) ---

    private async ensureServiceAndRoute(opts: {
        name: string;
        url: string;
        paths: string[];
        hosts: string[];
        projectRef: string;
        stripPath?: boolean;
        readTimeout?: number;
        protocols?: string[];
        headers?: string[];
        requestBuffering?: boolean;
        responseBuffering?: boolean;
        corsOrigins?: string[];
    }): Promise<void> {
        // 1. Upsert Service
        await this.kongRequest(`/services/${opts.name}`, "PUT", {
            name: opts.name,
            url: opts.url,
            connect_timeout: 5000,
            read_timeout: opts.readTimeout || 500_000,  // default 500s — covers long AI/OCR inference
            write_timeout: 500_000,
        });

        // 2. Upsert Route matching by Domain (hosts) and Path
        const routeName = `route-${opts.name}`;
        await this.kongRequest(`/routes/${routeName}`, "PUT", {
            name: routeName,
            service: { name: opts.name },
            paths: opts.paths,
            hosts: opts.hosts.length > 0 ? opts.hosts : undefined,
            strip_path: opts.stripPath ?? true,
            preserve_host: true,
            protocols: opts.protocols || ["http", "https"],
            request_buffering: opts.requestBuffering,
            response_buffering: opts.responseBuffering,
        });

        // 3. Inject x-project-ref and any custom headers using request-transformer plugin
        const headersToAdd = [`x-project-ref:${opts.projectRef}`];
        if (opts.headers && opts.headers.length > 0) {
            headersToAdd.push(...opts.headers);
        }
        await this.upsertRoutePlugin(routeName, "request-transformer", {
            add: { headers: headersToAdd }
        });

        // 4. Attach CORS plugin globally for this route
        await this.upsertRoutePlugin(routeName, "cors", {
            origins: opts.corsOrigins || DEFAULT_CORS_ORIGINS,
            methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            headers: DEFAULT_CORS_HEADERS,
            exposed_headers: DEFAULT_CORS_EXPOSED,
            credentials: false,
            max_age: 86400,
            preflight_continue: false,
        });

        // 5. Removed: Access-Control-Allow-Origin:* via response-transformer
        // Kong's CORS plugin handles origin reflection dynamically when credentials are true.
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

        logger.warn("Could not detect container bridge IP, defaulting to 127.0.0.1");
        return "127.0.0.1";
    }

    // --- Core reload logic ---

    async setupUpstream(projectRef: string, pgrstPort: number | string, gotruePort: number | string, projectRouting?: ProjectRoutingConfig | string, opts?: { functionsPort?: number; storagePort?: number; realtimeApiPort?: number; realtimeWsPort?: number }): Promise<{ success: boolean; error?: string }> {
        try {
            const hostIp = await this.detectHostIp();
            
            // Get base domains
            const baseApiDomain = `${projectRef}.api.${config.baseDomain}`;
            const routingConfig = normalizeProjectRoutingConfig(projectRouting);
            const hosts = Array.from(new Set([
                baseApiDomain,
                resolveProjectApiHost(projectRef, routingConfig),
            ]));
            const studioDomain = `studio-${projectRef}.${config.baseDomain}`;
            const studioHosts = Array.from(new Set([
                studioDomain,
                resolveProjectStudioHost(projectRef, routingConfig),
            ]));
            const corsOrigins = buildTenantCorsOrigins(projectRef, routingConfig, [...hosts, ...studioHosts]);

            await this.ensureServiceAndRoute({ name: `svc-pgrst-${projectRef}`, url: `http://${hostIp}:${pgrstPort}`, paths: ["/rest/v1"], hosts, projectRef, corsOrigins });
            await this.ensureServiceAndRoute({ 
                name: `svc-graphql-${projectRef}`, 
                url: `http://${hostIp}:${pgrstPort}/rpc/graphql`, 
                paths: ["/graphql/v1"], 
                hosts, 
                projectRef, 
                stripPath: true,
                headers: ["Content-Profile:graphql_public", "Accept-Profile:graphql_public"],
                corsOrigins,
            });
            await this.ensureServiceAndRoute({ name: `svc-gotrue-${projectRef}`, url: `http://${hostIp}:${gotruePort}`, paths: ["/auth/v1"], hosts, projectRef, corsOrigins });
            await this.ensureServiceAndRoute({
                name: `svc-gotrue-well-known-${projectRef}`,
                url: `http://${hostIp}:${gotruePort}`,
                paths: ["/.well-known/oauth-authorization-server/auth/v1"],
                hosts,
                projectRef,
                stripPath: false,
                corsOrigins,
            });
            // Route public function traffic through management-api first so sdk-proxy can
            // apply background_routes policy before forwarding synchronous invokes to the
            // edge runtime.
            await this.ensureServiceAndRoute({
                name: `svc-functions-${projectRef}`,
                url: `http://${hostIp}:${config.port}`,
                paths: ["/functions/v1"],
                hosts,
                projectRef,
                stripPath: false,
                readTimeout: 500_000,
                corsOrigins,
            });
            await this.ensureServiceAndRoute({
                name: `svc-storage-${projectRef}`,
                url: `http://${hostIp}:${opts?.storagePort || config.port}`,
                paths: ["/storage/v1/"],
                hosts,
                projectRef,
                requestBuffering: false,
                responseBuffering: false,
                corsOrigins,
            });
            await this.ensureServiceAndRoute({
                name: `svc-realtime-api-${projectRef}`,
                url: `http://${hostIp}:${opts?.realtimeApiPort || 4000}/api`,
                paths: ["/realtime/v1/api"],
                hosts,
                projectRef,
                stripPath: true,
                readTimeout: 60000,
                protocols: ["http", "https"],
                corsOrigins,
            });
            await this.ensureServiceAndRoute({
                name: `svc-realtime-${projectRef}`,
                url: `http://${hostIp}:${config.port}`,
                paths: ["/realtime/v1/websocket"],
                hosts,
                projectRef,
                stripPath: false,
                readTimeout: 86400000,
                // Kong models websocket proxying through the http/https protocols.
                // The management API's Bun.serve fetch handler upgrades /realtime/v1/*
                // requests directly, so route this path to the root server rather than
                // the Elysia /ws helper routes.
                protocols: ["http", "https"],
                corsOrigins,
            });
            await this.ensureServiceAndRoute({
                name: `svc-api-root-${projectRef}`,
                url: `http://${hostIp}:${config.port}`,
                paths: ["/.well-known/acme-challenge"],
                hosts: Array.from(new Set([...hosts, ...studioHosts])),
                projectRef,
                stripPath: false,
                corsOrigins,
            });

            // Ensure Studio routes (Management API proxy loopback for SPA fallback)
            await this.ensureServiceAndRoute({
                name: `svc-studio-${projectRef}`,
                url: `http://${hostIp}:${config.port}`,
                paths: ["/"],
                hosts: studioHosts,
                projectRef,
                stripPath: false,
                headers: ["x-supacloud-ui-host:studio"],
                corsOrigins,
            });

            logger.info(`Kong upstream dynamically registered via REST for ${projectRef} (pgrst:${pgrstPort}, gotrue:${gotruePort})`);
            return { success: true };
        } catch (error: unknown) {
            logger.error(`Failed to setup upstream natively for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return { success: false, error: (error instanceof Error ? error.message : String(error)) };
        }
    }

    async addProjectDomains(projectRef: string, apiDomains: string[], studioDomains: string[]): Promise<boolean> {
        try {
            const servicePrefixes = ["svc-pgrst-", "svc-graphql-", "svc-gotrue-", "svc-gotrue-well-known-", "svc-functions-", "svc-storage-", "svc-realtime-", "svc-realtime-api-", "svc-api-root-"];
            for (const prefix of servicePrefixes) {
                const routeName = `route-${prefix}${projectRef}`;
                const route = await this.kongRequest(`/routes/${routeName}`);
                if (route?.id) {
                    const existingHosts = (route.hosts as string[] | undefined) || [];
                    const uniqueHosts = Array.from(new Set([...existingHosts, ...apiDomains]));
                    await this.kongRequest(`/routes/${route.id}`, "PATCH", { hosts: uniqueHosts });
                }
            }
            await this.setCors(projectRef, buildTenantCorsOrigins(projectRef, undefined, [...apiDomains, ...studioDomains]));
            
            // Studio domains
            const studioRouteName = `route-svc-studio-${projectRef}`;
            const sRoute = await this.kongRequest(`/routes/${studioRouteName}`);
            if (sRoute?.id) {
                const existingSHosts = (sRoute.hosts as string[] | undefined) || [];
                const uniqueSHosts = Array.from(new Set([...existingSHosts, ...studioDomains]));
                await this.kongRequest(`/routes/${sRoute.id}`, "PATCH", { hosts: uniqueSHosts });
            }
            
            return true;
        } catch (error: unknown) {
            logger.error(`Failed to add domains for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    async removeProjectDomains(projectRef: string, apiDomains: string[], studioDomains: string[]): Promise<boolean> {
        try {
            const servicePrefixes = ["svc-pgrst-", "svc-graphql-", "svc-gotrue-", "svc-gotrue-well-known-", "svc-functions-", "svc-storage-", "svc-realtime-", "svc-realtime-api-", "svc-api-root-"];
            for (const prefix of servicePrefixes) {
                const routeName = `route-${prefix}${projectRef}`;
                const route = await this.kongRequest(`/routes/${routeName}`);
                if (route?.id && route.hosts) {
                    const existingHosts = (route.hosts as string[]) || [];
                    const newHosts = existingHosts.filter((h: string) => !apiDomains.includes(h));
                    if (newHosts.length > 0) {
                        await this.kongRequest(`/routes/${route.id}`, "PATCH", { hosts: newHosts });
                    }
                }
            }
            
            // Studio domains
            const studioRouteName = `route-svc-studio-${projectRef}`;
            const sRoute = await this.kongRequest(`/routes/${studioRouteName}`);
            if (sRoute?.id && sRoute.hosts) {
                const existingSHosts = (sRoute.hosts as string[]) || [];
                const newSHosts = existingSHosts.filter((h: string) => !studioDomains.includes(h));
                if (newSHosts.length > 0) {
                    await this.kongRequest(`/routes/${sRoute.id}`, "PATCH", { hosts: newSHosts });
                }
            }
            
            return true;
        } catch (error: unknown) {
            logger.error(`Failed to remove domains for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    async removeService(projectRef: string): Promise<{ success: boolean; error?: string }> {
        try {
            const servicePrefixes = ["svc-pgrst-", "svc-graphql-", "svc-gotrue-", "svc-functions-", "svc-storage-", "svc-realtime-", "svc-realtime-api-"];
            for (const prefix of servicePrefixes) {
                const name = `${prefix}${projectRef}`;
                const routeName = `route-${name}`;
                
                // Delete route first
                await this.kongRequest(`/routes/${routeName}`, "DELETE").catch(() => null);
                // Then delete service
                await this.kongRequest(`/services/${name}`, "DELETE").catch(() => null);
            }

            logger.info(`Kong service and routes explicitly removed for ${projectRef}`);
            return { success: true };
        } catch (error: unknown) {
            logger.error(`Failed to remove service dynamically for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return { success: false, error: (error instanceof Error ? error.message : String(error)) };
        }
    }

    async addUpstreamTarget(projectRef: string, replicaIp: string): Promise<{ success: boolean; error?: string }> {
        try {
            const upstreamName = `upstream-${projectRef}-ro`;
            await this.kongRequest(`/upstreams`, "POST", { name: upstreamName });
            await this.kongRequest(`/upstreams/${upstreamName}/targets`, "POST", {
                target: `${replicaIp}:5432`,
                weight: 100,
            });
            return { success: true };
        } catch (error: unknown) {
            return { success: false, error: (error instanceof Error ? error.message : String(error)) };
        }
    }

    async removeUpstreamTarget(projectRef: string, replicaIp: string): Promise<{ success: boolean; error?: string }> {
        try {
            const upstreamName = `upstream-${projectRef}-ro`;
            await this.kongRequest(`/upstreams/${upstreamName}/targets`, "POST", {
                target: `${replicaIp}:5432`,
                weight: 0,
            });
            return { success: true };
        } catch (error: unknown) {
            return { success: false, error: (error instanceof Error ? error.message : String(error)) };
        }
    }

    async applyConfig(projectRef: string, config: GatewayConfig): Promise<{ success: boolean; message: string }> {
        if (config.jwtSecret) await this.setupJwt(projectRef, config.jwtSecret);
        if (config.rateLimitTier) await this.setRateLimit(projectRef, config.rateLimitTier);
        if (config.corsOrigins) {
           const originsArray = config.corsOrigins.split(",").map(s => s.trim()).filter(Boolean);
           await this.setCors(projectRef, originsArray.length > 0 ? originsArray : DEFAULT_CORS_ORIGINS);
        }
        if (config.jwtEnabled) await this.enableJwtAuth(projectRef);
        return { success: true, message: "Gateway configuration updated" };
    }

    /**
     * Propagate templates via native REST APIs instead of declarative YAML
     */
    async rebuildAllTenantConfigs(): Promise<{ success: boolean; updated: number; errors: string[] }> {
        const errors: string[] = [];
        let updated = 0;

        try {
            // Query all active projects with their port config
            const projects = await sql`
                SELECT ref, config FROM projects
                WHERE status != 'deleted' AND deleted_at IS NULL
            `;

            for (const project of projects) {
                const ref = project.ref as string;
                const cfg = normalizeProjectConfig(project.config);
                const pgrstPort = cfg.postgrest_port as number | undefined;
                const gotruePort = cfg.gotrue_port as number | undefined;

                if (!pgrstPort || !gotruePort) {
                    logger.warn(`[GatewayService] Skipping ${ref}: missing port config`);
                    errors.push(`${ref}: missing port config`);
                    continue;
                }

                try {
                    await this.setupUpstream(ref, pgrstPort, gotruePort, cfg);
                    
                    // Re-apply keys & limits if configured (assuming user will call applyConfig separately or we re-trigger it)
                    // (Omitted for brevity, typically applyConfig runs on tenant boot)
                    updated++;
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.error(`[GatewayService] Failed to regenerate HTTP routes for ${ref}:`, msg);
                    errors.push(`${ref}: ${msg}`);
                }
            }

            logger.info(`[GatewayService] Rebuilt Kong config securely for ${updated} tenant(s).`);

            return { success: true, updated, errors };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[GatewayService] rebuildAllTenantConfigs failed:`, msg);
            return { success: false, updated, errors: [...errors, msg] };
        }
    }

    // --- Global Master Routes ---
    async setupMasterRoutes(): Promise<void> {
        const kongOk = await this.checkKongConnectivity();
        if (!kongOk) return;

        try {
            const hostIp = await this.detectHostIp();
            
            // 1. Create Core Management Service
            await this.kongRequest(`/services/svc-management-api`, "PUT", {
                name: "svc-management-api",
                url: `http://${hostIp}:${config.port}`,
                connect_timeout: 5000,
                read_timeout: 60000,
                write_timeout: 60000
            });

            const apiHosts = [hostIp];

            await this.ensureServiceAndRoute({
                name: "svc-management-api",
                url: `http://${hostIp}:${config.port}`,
                paths: ["/api"],
                hosts: apiHosts,
                projectRef: "_management",
                stripPath: true,
                corsOrigins: apiHosts,
            });

            // Patch the existing management API route instead of creating
            // a second /api route with a different request-transformer config.
            try {
                const existingRoute = await this.kongRequest(`/routes/route-svc-management-api`, "GET");
                if (existingRoute) {
                    const existingHosts = Array.isArray(existingRoute.hosts)
                        ? existingRoute.hosts.filter((host): host is string => typeof host === "string")
                        : [];
                    const desiredHosts = [hostIp, ...(config.baseDomain ? [config.baseDomain] : [])];
                    const missingHosts = desiredHosts.filter(h => !existingHosts.includes(h));
                    if (missingHosts.length > 0) {
                        await this.kongRequest(`/routes/route-svc-management-api`, "PATCH", {
                            hosts: [...existingHosts, ...missingHosts],
                        });
                        logger.info(`[GatewayService] Patched route-svc-management-api hosts: +${missingHosts.join(", ")}`);
                    }
                }
            } catch {
                // Route may not exist yet if no project has been created; skip silently
            }

            // Create Studio root route for bare IP access
            await this.ensureServiceAndRoute({
                name: "studio-root",
                url: `http://${hostIp}:${config.port}`,
                paths: ["/"],
                hosts: [hostIp],
                projectRef: "_system",
                stripPath: false,
            });

            logger.info(`[GatewayService] Rebuilt global management routes to port ${config.port}`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[GatewayService] Failed to setup Master Routes:`, msg);
        }
    }

    async configureFrontendRoute(route: FrontendGatewayRoute): Promise<void> {
        if (!route.port) {
            throw new Error("Kong frontend routes require an upstream port");
        }
        const serviceName = `svc-frontend-${route.projectRef}-${route.deploymentId}`;
        const routeName = `route-frontend-${route.projectRef}-${route.deploymentId}`;

        await this.addCorsOriginsForHosts(route.projectRef, route.hosts);
        await this.kongRequest(`/services/${serviceName}`, "PUT", {
            name: serviceName,
            url: `http://127.0.0.1:${route.port}`,
            connect_timeout: 5000,
            read_timeout: 60000,
            write_timeout: 60000,
        });
        await this.kongRequest(`/routes/${routeName}`, "PUT", {
            name: routeName,
            service: { name: serviceName },
            paths: ["/"],
            hosts: route.hosts.length > 0 ? route.hosts : undefined,
            strip_path: false,
            preserve_host: true,
            request_buffering: false,
            response_buffering: false,
        });
    }

    async removeFrontendRoute(projectRef: string, deploymentId: string): Promise<void> {
        const serviceName = `svc-frontend-${projectRef}-${deploymentId}`;
        const routeName = `route-frontend-${projectRef}-${deploymentId}`;
        await this.kongRequest(`/routes/${routeName}`, "DELETE").catch(() => null);
        await this.kongRequest(`/services/${serviceName}`, "DELETE").catch(() => null);
    }
}

type CaddyHeaderValue = string | string[];
type CaddyRoute = Record<string, unknown>;
type CaddyMatcher = Record<string, unknown>;
type CaddyServer = {
    listen: string[];
    routes: CaddyRoute[];
};

type CaddyConfig = {
    admin?: Record<string, unknown>;
    storage?: Record<string, unknown>;
    apps: {
        tls?: Record<string, unknown>;
        http: {
            servers: Record<string, CaddyServer>;
        };
    };
};

function uniqueStrings(values: Array<string | undefined | null>): string[] {
    return Array.from(new Set(values.map((v) => String(v || "").trim()).filter(Boolean)));
}

function caddyRouteId(projectRef: string, kind: string): string {
    return `route-project-${projectRef}-${kind}`;
}

function normalizeCaddyHost(host: string): string {
    return host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/:\d+$/, "");
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

function caddyDial(upstream: string): string {
    return upstream.replace(/^https?:\/\//, "").split("/")[0] || upstream;
}

function sanitizeCaddyId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const CADDY_PROJECT_ROUTE_KINDS = [
    "rest",
    "graphql",
    "auth",
    "gotrue-well-known",
    "functions",
    "storage",
    "realtime-api",
    "realtime",
    "acme",
    "studio",
];

export class CaddyGatewayProvider implements GatewayProvider {
    readonly name = "caddy" as const;
    private readonly routesById = new Map<string, CaddyRoute>();
    private readonly certsById = new Map<string, { certificate: string; key: string }>();
    private readonly rateLimits = new Map<string, { tier: string; second: number; minute: number; hour: number; enabled: boolean }>();
    private readonly customRateLimits = new Map<string, { second: number; minute: number; hour: number }>();
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

    private baseConfig(): CaddyConfig {
        const routes = Array.from(this.routesById.values())
            .sort((a, b) => this.compareRoutesForCaddy(a, b))
            .map((route) => this.renderRouteForCaddy(route));

        return {
            admin: { listen: caddyAdminListen() },
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
                    if (!this.routesById.has(id)) this.routesById.set(id, route);
                    this.hydrateRateLimitFromRoute(id, route);
                }
            }

            const certs = (parsed.apps?.tls as Record<string, any> | undefined)?.certificates?.load_files;
            if (Array.isArray(certs)) {
                for (const cert of certs) {
                    if (typeof cert?.certificate !== "string" || typeof cert?.key !== "string") continue;
                    const id = `disk-${hashStr(`${cert.certificate}:${cert.key}`)}`;
                    if (!this.certsById.has(id)) {
                        this.certsById.set(id, { certificate: cert.certificate, key: cert.key });
                    }
                }
            }
        } catch (error: unknown) {
            const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
            if (code !== "ENOENT") {
                logger.warn(`[CaddyGatewayProvider] Failed to hydrate existing Caddy config: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
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
        const aCustom = aid.startsWith("route-custom-");
        const bCustom = bid.startsWith("route-custom-");
        if (aCustom !== bCustom) return aCustom ? -1 : 1;

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

    private async persistAndLoad(): Promise<void> {
        await this.hydrateFromDisk();
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
        } catch (error) {
            await fs.unlink(tmpPath).catch(() => undefined);
            throw error;
        }
    }

    private makeReverseProxy(upstream: string, headers: Record<string, CaddyHeaderValue>, readTimeoutMs?: number): Record<string, unknown> {
        return {
            handler: "reverse_proxy",
            upstreams: [{ dial: caddyDial(upstream) }],
            flush_interval: -1,
            headers: {
                request: {
                    set: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value : [value]])),
                },
                response: {
                    delete: [...UPSTREAM_CORS_RESPONSE_HEADERS],
                },
            },
            transport: {
                protocol: "http",
                read_timeout: `${Math.ceil((readTimeoutMs || 500_000) / 1000)}s`,
                write_timeout: "500s",
            },
        };
    }

    private makeCorsHeaderHandler(): Record<string, unknown> {
        return {
            handler: "headers",
            response: {
                set: {
                    "Access-Control-Allow-Origin": ["{http.request.header.Origin}"],
                    "Access-Control-Allow-Credentials": ["true"],
                    "Access-Control-Allow-Methods": ["GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD"],
                    "Access-Control-Allow-Headers": [DEFAULT_CORS_HEADERS.join(", ")],
                    "Access-Control-Expose-Headers": [DEFAULT_CORS_EXPOSED.join(", ")],
                    "Access-Control-Max-Age": ["86400"],
                    "Vary": ["Origin, Access-Control-Request-Headers, Accept-Encoding"],
                },
            },
        };
    }

    private makeCorsOriginMatchers(origins: string[], extra: CaddyMatcher = {}): CaddyMatcher[] {
        const exactOrigins = uniqueStrings(origins
            .map((origin) => origin.trim())
            .filter((origin) => origin && !origin.startsWith("~")));
        const regexOrigins = origins
            .map((origin) => origin.trim())
            .filter((origin) => origin.startsWith("~"))
            .map((origin) => origin.slice(1).trim())
            .filter(Boolean);

        const matchers: CaddyMatcher[] = [];
        if (exactOrigins.length > 0) {
            matchers.push({
                ...extra,
                header: { Origin: exactOrigins },
            });
        }
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

    private makeCorsSubroute(origins: string[]): Record<string, unknown> | null {
        const preflightMatchers = this.makeCorsOriginMatchers(origins, { method: ["OPTIONS"] });
        const originMatchers = this.makeCorsOriginMatchers(origins);
        if (preflightMatchers.length === 0 && originMatchers.length === 0) return null;

        const routes: CaddyRoute[] = [];
        if (preflightMatchers.length > 0) {
            routes.push({
                match: preflightMatchers,
                handle: [
                    this.makeCorsHeaderHandler(),
                    { handler: "static_response", status_code: 204 },
                ],
                terminal: true,
            });
        }
        if (originMatchers.length > 0) {
            routes.push({
                match: originMatchers,
                handle: [this.makeCorsHeaderHandler()],
            });
        }

        return {
            handler: "subroute",
            routes,
        };
    }

    private isCorsHeaderHandler(handler: Record<string, unknown>): boolean {
        return handler.handler === "headers" &&
            typeof (handler.response as any)?.set?.["Access-Control-Allow-Origin"] !== "undefined";
    }

    private isCorsSubroute(handler: Record<string, unknown>): boolean {
        if (handler.handler !== "subroute" || !Array.isArray(handler.routes)) return false;
        return handler.routes.some((route: any) =>
            Array.isArray(route?.handle) &&
            route.handle.some((item: any) => this.isCorsHeaderHandler(item)),
        );
    }

    private setRouteCors(route: CaddyRoute, origins: string[]): void {
        const corsSubroute = this.makeCorsSubroute(origins);
        const handle = Array.isArray(route.handle) ? route.handle as Record<string, unknown>[] : [];
        const withoutCors = handle.filter((handler) =>
            !this.isCorsHeaderHandler(handler) && !this.isCorsSubroute(handler),
        );
        route.handle = corsSubroute ? [corsSubroute, ...withoutCors] : withoutCors;
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
                    "Strict-Transport-Security": ["max-age=31536000; includeSubDomains"],
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
                        "/index.html",
                    ],
                },
            }],
            handle: [{
                handler: "rewrite",
                uri: "{http.matchers.file.relative}",
            }],
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
            }],
        };
    }

    private makeStaticFileServer(root: string): Record<string, unknown> {
        return {
            handler: "file_server",
            root,
            index_names: ["index.html"],
            precompressed: {
                br: {},
                zstd: {},
                gzip: {},
            },
            precompressed_order: ["br", "zstd", "gzip"],
            hide: [".git", ".env", "deployment.json"],
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
                        {
                            match: [{ path: ["/_app/*", "/assets/*"] }],
                            handle: [this.makeStaticCacheHeaders(immutableCache)],
                        },
                        {
                            match: [{ path: ["/", "*.html"] }],
                            handle: [this.makeStaticCacheHeaders("no-cache")],
                        },
                        this.makeStaticImageVariantRoute(route.root, "image/avif", ".avif"),
                        this.makeStaticImageVariantRoute(route.root, "image/webp", ".webp"),
                        this.makeStaticTryFilesRoute(route.root),
                        {
                            handle: [this.makeStaticFileServer(route.root)],
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
        path: string;
        upstream: string;
        projectRef: string;
        stripPrefix?: string;
        rewriteUri?: string;
        headers?: string[];
        corsOrigins?: string[];
        readTimeout?: number;
    }): CaddyRoute {
        const requestHeaders: Record<string, CaddyHeaderValue> = {
            "X-Project-Ref": opts.projectRef,
            "X-Forwarded-Host": "{http.request.host}",
        };
        for (const header of opts.headers || []) {
            const [key, ...rest] = header.split(":");
            if (key && rest.length > 0) requestHeaders[key.trim()] = rest.join(":").trim();
        }

        const handle: Record<string, unknown>[] = [];
        const corsSubroute = opts.corsOrigins ? this.makeCorsSubroute(opts.corsOrigins) : null;
        if (corsSubroute) handle.push(corsSubroute);
        if (opts.rewriteUri) handle.push({ handler: "rewrite", uri: opts.rewriteUri });
        else if (opts.stripPrefix) handle.push({ handler: "rewrite", strip_path_prefix: opts.stripPrefix });
        handle.push(this.makeReverseProxy(opts.upstream, requestHeaders, opts.readTimeout));

        return {
            "@id": opts.id,
            match: [{
                host: uniqueStrings(opts.hosts.map(normalizeCaddyHost)),
                path: [opts.path],
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
        await this.hydrateFromDisk();
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
        await this.hydrateFromDisk();
        const routeId = `route-custom-${projectRef}-${hashStr(basePath)}`;
        this.customRateLimits.delete(routeId);
        this.routesById.delete(routeId);
        await this.persistAndLoad();
        return true;
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
        await this.hydrateFromDisk();
        for (const id of this.projectRouteIds(projectRef)) {
            const route = this.routesById.get(id);
            if (route) this.setRouteCors(route, origins);
        }
        await this.persistAndLoad();
        return true;
    }

    async addCorsOriginsForHosts(projectRef: string, hosts: string[]): Promise<boolean> {
        await this.hydrateFromDisk();
        const allHosts = uniqueStrings([...this.hostsForProjectRoutes(projectRef), ...hosts]);
        return this.setCors(projectRef, buildTenantCorsOrigins(projectRef, undefined, allHosts));
    }

    async setupUpstream(projectRef: string, pgrstPort: number | string, gotruePort: number | string, projectRouting?: ProjectRoutingConfig | string, opts?: GatewaySetupOptions): Promise<{ success: boolean; error?: string }> {
        try {
            await this.hydrateFromDisk();
            const hostIp = await this.detectHostIp();
            const routingConfig = normalizeProjectRoutingConfig(projectRouting);
            const hosts = uniqueStrings([
                `${projectRef}.api.${config.baseDomain}`,
                resolveProjectApiHost(projectRef, routingConfig),
            ]);
            const studioHosts = uniqueStrings([
                `studio-${projectRef}.${config.baseDomain}`,
                resolveProjectStudioHost(projectRef, routingConfig),
            ]);
            const corsOrigins = buildTenantCorsOrigins(projectRef, routingConfig, [
                ...hosts,
                ...studioHosts,
                ...this.hostsForProjectRoutes(projectRef),
            ]);

            const routes = [
                this.makeRoute({ id: caddyRouteId(projectRef, "rest"), hosts, path: "/rest/v1*", upstream: `${hostIp}:${pgrstPort}`, projectRef, stripPrefix: "/rest/v1", corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "graphql"), hosts, path: "/graphql/v1*", upstream: `${hostIp}:${pgrstPort}`, projectRef, rewriteUri: "/rpc/graphql", headers: ["Content-Profile:graphql_public", "Accept-Profile:graphql_public"], corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "auth"), hosts, path: "/auth/v1*", upstream: `${hostIp}:${gotruePort}`, projectRef, stripPrefix: "/auth/v1", corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "gotrue-well-known"), hosts, path: "/.well-known/oauth-authorization-server/auth/v1*", upstream: `${hostIp}:${gotruePort}`, projectRef, corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "functions"), hosts, path: "/functions/v1*", upstream: `${hostIp}:${config.port}`, projectRef, readTimeout: 500_000, corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "storage"), hosts, path: "/storage/v1*", upstream: `${hostIp}:${opts?.storagePort || config.port}`, projectRef, corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "realtime-api"), hosts, path: "/realtime/v1/api*", upstream: `${hostIp}:${config.port}`, projectRef, readTimeout: 60_000, corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "realtime"), hosts, path: "/realtime/v1/websocket*", upstream: `${hostIp}:${config.port}`, projectRef, readTimeout: 86_400_000, corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "acme"), hosts: [...hosts, ...studioHosts], path: "/.well-known/acme-challenge*", upstream: `${hostIp}:${config.port}`, projectRef, corsOrigins }),
                this.makeRoute({ id: caddyRouteId(projectRef, "studio"), hosts: studioHosts, path: "/*", upstream: `${hostIp}:${config.port}`, projectRef, headers: ["x-supacloud-ui-host:studio"], corsOrigins }),
            ];

            for (const route of routes) this.routesById.set(String(route["@id"]), route);
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
        await this.hydrateFromDisk();
        const existingKinds = ["rest", "graphql", "auth", "gotrue-well-known", "functions", "storage", "realtime-api", "realtime", "acme"];
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
        await this.hydrateFromDisk();
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
        await this.hydrateFromDisk();
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
                WHERE status != 'deleted' AND deleted_at IS NULL
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
                if (result.success) updated++;
                else errors.push(`${ref}: ${result.error || "unknown error"}`);
            }
            return { success: errors.length === 0, updated, errors };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            return { success: false, updated, errors: [...errors, msg] };
        }
    }

    async setupMasterRoutes(): Promise<void> {
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
}

export class GatewayService implements GatewayProvider {
    readonly name = config.gatewayProvider;
    private readonly provider: GatewayProvider = config.gatewayProvider === "kong"
        ? new KongGatewayProvider()
        : new CaddyGatewayProvider();

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
    setupMasterRoutes() { return this.provider.setupMasterRoutes(); }
    upsertCertificateForSnis(opts: { projectRef: string; cert: string; key: string; snis: string[]; existingCertificateId?: string }) { return this.provider.upsertCertificateForSnis(opts); }
    configureFrontendRoute(route: FrontendGatewayRoute) { return this.provider.configureFrontendRoute(route); }
    removeFrontendRoute(projectRef: string, deploymentId: string) { return this.provider.removeFrontendRoute(projectRef, deploymentId); }
}

export const gatewayService = new GatewayService();
