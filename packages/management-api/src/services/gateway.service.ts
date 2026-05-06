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
    "x-supacloud-trace-id",
];
export const DEFAULT_CORS_EXPOSED = [
    "Content-Length", "Content-Range", "X-Content-Range", "X-JSON",
    "x-supabase-api-version", "X-Client-Info", "Prefer",
    "Content-Profile", "accept-profile", "Range", "Range-Unit",
    "X-Relay-Error", "link", "x-total-count",
];
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

export class GatewayService {
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

    // --- Consumer & JWT ---

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

    private getRateLimitConfig(tier: string): RateLimitConfig {
        switch (tier) {
            case "pro": return { second: 100, minute: 2000, hour: 50000 };
            case "enterprise": return { second: 1000, minute: 50000, hour: 1000000 };
            default: return { second: 10, minute: 100, hour: 1000 };
        }
    }

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
                ({ second, minute, hour } = this.getRateLimitConfig(opts));
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

    private hashStr(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = (hash << 5) - hash + str.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
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

            const routeName = `route-custom-${projectRef}-${this.hashStr(basePath)}`;

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
            const routeName = `route-custom-${projectRef}-${this.hashStr(basePath)}`;
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
            const routes = ['pgrst', 'graphql', 'gotrue', 'realtime', 'realtime-api', 'storage', 'functions', 'api-root'].map(r => `route-svc-${r}-${projectRef}`);
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
                protocols: ["http", "https", "grpc", "grpcs", "ws", "wss"],
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
                hosts,
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
            const servicePrefixes = ["svc-pgrst-", "svc-graphql-", "svc-gotrue-", "svc-functions-", "svc-storage-", "svc-realtime-", "svc-realtime-api-", "svc-api-root-"];
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
            const servicePrefixes = ["svc-pgrst-", "svc-graphql-", "svc-gotrue-", "svc-functions-", "svc-storage-", "svc-realtime-", "svc-realtime-api-", "svc-api-root-"];
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

            logger.info(`[GatewayService] Rebuilt global management routes to port ${config.port}`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[GatewayService] Failed to setup Master Routes:`, msg);
        }
    }
}

export const gatewayService = new GatewayService();
