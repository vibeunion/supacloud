import { config } from "../config";
import { sql, resolveSlotName, resolveRoleName } from "../db";
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

const REALTIME_ADMIN_URL = config.realtimeAdminUrl;
const REALTIME_API_SECRET = config.realtimeApiSecret || config.jwtSecret;
if (!REALTIME_API_SECRET) {
    logger.error("FATAL: REALTIME_API_SECRET or JWT_SECRET must be set for RealtimeService.");
}
const PG_HOST = (process.env.CI || process.env.GITHUB_ACTIONS) ? "postgres" : config.pgHost;
const PG_PORT = String(config.pgPort);

interface RealtimeTenantConfig {
    projectRef: string;
    dbName: string;
    dbUser?: string;
    dbPassword: string;
    jwtSecret: string;
}

export interface RealtimeCdcPrerequisites {
    ok: boolean;
    walLevel: string;
    supabaseAdminExists: boolean;
    supabaseAdminHasReplication: boolean;
    checks: {
        walLevelLogical: boolean;
        roleExists: boolean;
        roleReplication: boolean;
    };
    messages: string[];
}

export class RealtimeService {
    private readonly adminUrl: string;
    private readonly apiSecret: string;

    constructor() {
        this.adminUrl = REALTIME_ADMIN_URL;
        this.apiSecret = REALTIME_API_SECRET as string; // Assert string since it's checked above
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
        const globalConfig = (await import("../config")).config;
        const adminDbUser = "supabase_admin";
        const adminDbPassword = globalConfig.pgPassword || config.dbPassword || "postgres";
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
                                db_user: adminDbUser,
                                db_password: adminDbPassword,
                                ssl_enforced: false,
                                region: "us-east-1",
                                poll_interval_ms: 100,
                                poll_max_changes: 100,
                                poll_max_record_bytes: 1048576,
                                slot_name: resolveSlotName(config.projectRef),
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
     * Get a registered tenant from the Realtime server.
     * Returns true if the tenant exists and is healthy.
     */
    async getTenant(projectRef: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.adminUrl}/api/tenants/${projectRef}`, {
                method: "GET",
                headers: await this.authHeaders(),
            });
            return res.ok;
        } catch {
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
        const globalConfig = (await import("../config")).config;
        const adminDbUser = "supabase_admin";
        const adminDbPassword = globalConfig.pgPassword || config.dbPassword || "postgres";
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
                                db_user: adminDbUser,
                                db_password: adminDbPassword,
                                ssl_enforced: false,
                                region: "us-east-1",
                                poll_interval_ms: 100,
                                slot_name: resolveSlotName(config.projectRef),
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
        } catch (err: unknown) {
            logger.debug("[Realtime] Health check failed:", (err instanceof Error ? err.message : String(err)));
            return { healthy: false };
        }
    }

    /**
     * Check Postgres prerequisites required by official Realtime CDC:
     * 1) wal_level must be logical
     * 2) supabase_admin role must exist
     * 3) supabase_admin must have REPLICATION attribute
     */
    async checkCdcPrerequisites(): Promise<RealtimeCdcPrerequisites> {
        const messages: string[] = [];
        try {
            const walRows = await sql`SELECT setting FROM pg_settings WHERE name = 'wal_level' LIMIT 1`;
            const walLevel = String(walRows[0]?.setting || "unknown");

            const roleRows = await sql`
              SELECT rolname, rolreplication
              FROM pg_roles
              WHERE rolname = 'supabase_admin'
              LIMIT 1
            `;

            const supabaseAdminExists = roleRows.length > 0;
            const supabaseAdminHasReplication = Boolean(roleRows[0]?.rolreplication);

            const walLevelLogical = walLevel === "logical";
            const roleExists = supabaseAdminExists;
            const roleReplication = supabaseAdminHasReplication;
            const ok = walLevelLogical && roleExists && roleReplication;

            if (!walLevelLogical) messages.push(`wal_level is '${walLevel}', expected 'logical'`);
            if (!roleExists) messages.push("role 'supabase_admin' does not exist");
            if (roleExists && !roleReplication) messages.push("role 'supabase_admin' is missing REPLICATION");
            if (ok) messages.push("Realtime CDC prerequisites are satisfied");

            return {
                ok,
                walLevel,
                supabaseAdminExists,
                supabaseAdminHasReplication,
                checks: {
                    walLevelLogical,
                    roleExists,
                    roleReplication,
                },
                messages,
            };
        } catch (err: unknown) {
            return {
                ok: false,
                walLevel: "unknown",
                supabaseAdminExists: false,
                supabaseAdminHasReplication: false,
                checks: {
                    walLevelLogical: false,
                    roleExists: false,
                    roleReplication: false,
                },
                messages: [`Failed to check prerequisites: ${err instanceof Error ? err.message : String(err)}`],
            };
        }
    }

    /**
     * Ensure supabase_admin exists and has REPLICATION attribute.
     * Note: wal_level=logical is cluster-level and still needs postgresql.conf/reload.
     */
    async ensureSupabaseAdminReplication(): Promise<{ success: boolean; changed: boolean; error?: string }> {
        try {
            const before = await sql`
              SELECT rolreplication
              FROM pg_roles
              WHERE rolname = 'supabase_admin'
              LIMIT 1
            `;

            const beforeExists = before.length > 0;
            const beforeReplication = Boolean(before[0]?.rolreplication);

            if (!beforeExists) {
                const { config: globalConfig } = await import("../config");
                const password = globalConfig.pgPassword || "postgres";
                await sql`CREATE ROLE supabase_admin LOGIN BYPASSRLS REPLICATION PASSWORD ${password}`;
            }
            if (!beforeReplication) {
                await sql`ALTER ROLE supabase_admin WITH REPLICATION`;
            }

            const changed = !beforeExists || !beforeReplication;
            return { success: true, changed };
        } catch (err: unknown) {
            return {
                success: false,
                changed: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
}

export const realtimeService = new RealtimeService();
