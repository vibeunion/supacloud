/**
 * RealtimeService - Manages Supabase Realtime tenant registration
 * 
 * The official supabase/realtime container supports multi-tenancy natively
 * through its Tenant Management API. This service wraps that API to:
 *   - Register a tenant when a new project is created
 *   - Remove a tenant when a project is deleted
 *   - Update tenant config (e.g., on password rotation)
 *   - Health check
 */
import { logger } from "../utils/logger";

const REALTIME_ADMIN_URL = process.env.REALTIME_ADMIN_URL || "http://127.0.0.1:4000";
const REALTIME_API_SECRET = process.env.REALTIME_API_SECRET || process.env.JWT_SECRET || "super-secret-jwt-token";
const PG_HOST = process.env.POSTGRES_HOST || "10.2.0.14";
const PG_PORT = process.env.POSTGRES_PORT || "5432";

interface RealtimeTenantConfig {
    projectRef: string;
    dbName: string;
    dbPassword: string;
    jwtSecret: string;
}

export class RealtimeService {
    private readonly adminUrl: string;
    private readonly apiSecret: string;

    constructor() {
        this.adminUrl = REALTIME_ADMIN_URL;
        this.apiSecret = REALTIME_API_SECRET;
    }

    /**
     * Generate HS256 JWT for Realtime Admin API authentication.
     * The Realtime container verifies tokens signed with API_JWT_SECRET.
     */
    private async signJwt(): Promise<string> {
        const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
        const now = Math.floor(Date.now() / 1000);
        const payload = Buffer.from(JSON.stringify({
            iss: "supabase",
            role: "supabase_admin",
            iat: now,
            exp: now + 3600,
        })).toString("base64url");

        const { createHmac } = await import("crypto");
        const signature = createHmac("sha256", this.apiSecret)
            .update(`${header}.${payload}`)
            .digest("base64url");

        return `${header}.${payload}.${signature}`;
    }

    private async authHeaders(): Promise<Record<string, string>> {
        const jwt = await this.signJwt();
        return {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${jwt}`,
        };
    }

    /**
     * Register a new tenant with the Realtime server.
     * Called during project provisioning.
     */
    async registerTenant(config: RealtimeTenantConfig): Promise<boolean> {
        try {
            const res = await fetch(`${this.adminUrl}/api/tenants`, {
                method: "POST",
                headers: await this.authHeaders(),
                body: JSON.stringify({
                    tenant: {
                        external_id: config.projectRef,
                        name: `Project ${config.projectRef}`,
                        jwt_secret: config.jwtSecret,
                        extensions: [{
                            type: "postgres_cdc_rls",
                            settings: {
                                db_host: PG_HOST,
                                db_port: PG_PORT,
                                db_name: config.dbName,
                                db_user: "supabase_admin",
                                db_password: config.dbPassword,
                                region: "us-east-1",
                                poll_interval_ms: 100,
                                poll_max_changes: 100,
                                poll_max_record_bytes: 1048576,
                                slot_name: `supabase_realtime_${config.projectRef}`,
                            },
                        }],
                    },
                }),
            });

            if (res.ok || res.status === 409) {
                // 409 = tenant already exists, that's fine
                logger.info(`[Realtime] Tenant registered: ${config.projectRef}`);
                return true;
            }

            const errText = await res.text();
            logger.error(`[Realtime] Failed to register tenant ${config.projectRef}:`, { status: res.status, error: errText });
            return false;
        } catch (err: unknown) {
            logger.error(`[Realtime] Registration error for ${config.projectRef}:`, { error: err instanceof Error ? err.message : String(err) });
            return false;
        }
    }

    /**
     * Remove a tenant from the Realtime server.
     * Called during project deletion.
     */
    async removeTenant(projectRef: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.adminUrl}/api/tenants/${projectRef}`, {
                method: "DELETE",
                headers: await this.authHeaders(),
            });

            if (res.ok || res.status === 404) {
                logger.info(`[Realtime] Tenant removed: ${projectRef}`);
                return true;
            }

            const errText = await res.text();
            logger.error(`[Realtime] Failed to remove tenant ${projectRef}:`, { status: res.status, error: errText });
            return false;
        } catch (err: unknown) {
            logger.error(`[Realtime] Removal error for ${projectRef}:`, { error: err instanceof Error ? err.message : String(err) });
            return false;
        }
    }

    /**
     * Update tenant configuration (e.g., after password rotation).
     */
    async updateTenant(config: RealtimeTenantConfig): Promise<boolean> {
        try {
            const res = await fetch(`${this.adminUrl}/api/tenants/${config.projectRef}`, {
                method: "PUT",
                headers: await this.authHeaders(),
                body: JSON.stringify({
                    tenant: {
                        jwt_secret: config.jwtSecret,
                        extensions: [{
                            type: "postgres_cdc_rls",
                            settings: {
                                db_host: PG_HOST,
                                db_port: PG_PORT,
                                db_name: config.dbName,
                                db_user: "supabase_admin",
                                db_password: config.dbPassword,
                                region: "us-east-1",
                                poll_interval_ms: 100,
                                slot_name: `supabase_realtime_${config.projectRef}`,
                            },
                        }],
                    },
                }),
            });

            if (res.ok) {
                logger.info(`[Realtime] Tenant updated: ${config.projectRef}`);
                return true;
            }

            const errText = await res.text();
            logger.error(`[Realtime] Failed to update tenant ${config.projectRef}:`, { status: res.status, error: errText });
            return false;
        } catch (err: unknown) {
            logger.error(`[Realtime] Update error for ${config.projectRef}:`, { error: err instanceof Error ? err.message : String(err) });
            return false;
        }
    }

    /**
     * Health check for the Realtime service.
     */
    async healthCheck(): Promise<{ healthy: boolean; tenants?: number }> {
        try {
            const res = await fetch(`${this.adminUrl}/api/tenants`, {
                headers: await this.authHeaders(),
            });
            if (res.ok) {
                const data = await res.json() as unknown[];
                return { healthy: true, tenants: Array.isArray(data) ? data.length : 0 };
            }
            return { healthy: false };
        } catch {
            return { healthy: false };
        }
    }
}

export const realtimeService = new RealtimeService();
