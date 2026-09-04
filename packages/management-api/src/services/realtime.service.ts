import { readFileSync } from "node:fs";
import { config } from "../config";
import { sql, resolveSlotName } from "../db";
import { buildRealtimeTenantPayload } from "./realtime-tenant-payload";
import { resolveProjectJwtVerificationMaterial } from "../utils/project-jwt";
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

// Determines whether error is a connection-level failure caused by container not ready (retryable), distinct from logic errors.
function isConnectionError(msg: string): boolean {
    return /Unable to connect|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|other side closed/i.test(msg);
}

const REALTIME_ADMIN_URL = config.realtimeAdminUrl;

function readEnvFileValue(filePath: string, key: string): string {
    try {
        const line = readFileSync(filePath, "utf8")
            .split(/\r?\n/)
            .find((candidate) => candidate.trimStart().startsWith(`${key}=`));
        if (!line) return "";
        const envEntry = line.slice(line.indexOf("=") + 1).trim();
        return ((envEntry.startsWith('"') && envEntry.endsWith('"')) || (envEntry.startsWith("'") && envEntry.endsWith("'")))
            ? envEntry.slice(1, -1)
            : envEntry;
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return "";
        }
        throw error;
    }
}

export function assertRealtimeSecretAlignment(input: {
    canonicalSecret: string;
    configuredApiSecret?: string;
    containerApiSecret?: string;
    requireContainerApiSecret?: boolean;
}): void {
    const {
        canonicalSecret,
        configuredApiSecret = "",
        containerApiSecret = "",
        requireContainerApiSecret = false,
    } = input;
    if (!canonicalSecret) {
        throw new Error("Realtime canonical JWT secret is missing");
    }
    if (requireContainerApiSecret && !containerApiSecret.trim()) {
        throw new Error("Realtime container API JWT secret is missing");
    }
    if (configuredApiSecret && configuredApiSecret !== canonicalSecret) {
        throw new Error("Realtime API secret does not match the canonical JWT secret");
    }
    if (containerApiSecret && containerApiSecret !== canonicalSecret) {
        throw new Error("Realtime container API JWT secret does not match the canonical JWT secret");
    }
}

export function validateRealtimeSecretConfiguration(containerEnvFile = config.realtimeContainerEnvFile): void {
    const containerApiSecret = readEnvFileValue(containerEnvFile, "API_JWT_SECRET");
    assertRealtimeSecretAlignment({
        canonicalSecret: config.jwtSecret,
        configuredApiSecret: config.realtimeApiSecret,
        containerApiSecret,
        requireContainerApiSecret: true,
    });
}

const REALTIME_API_SECRET = config.jwtSecret;
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
    projectConfig?: unknown;
    jwtJwks?: unknown;
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

    private async authoritativeTenantPayload(tenantConfig: RealtimeTenantConfig) {
        const globalConfig = (await import("../config")).config;
        const jwtMaterial = resolveProjectJwtVerificationMaterial(
            tenantConfig.projectConfig,
            tenantConfig.jwtSecret,
        );
        return buildRealtimeTenantPayload({
            projectRef: tenantConfig.projectRef,
            dbHost: PG_HOST,
            dbPort: PG_PORT,
            dbName: tenantConfig.dbName,
            adminDbPassword: globalConfig.pgPassword || tenantConfig.dbPassword || "postgres",
            jwtSecret: tenantConfig.jwtSecret,
            jwtJwks: tenantConfig.projectConfig !== undefined
                ? jwtMaterial.jwtJwks
                : tenantConfig.jwtJwks,
            slotName: resolveSlotName(tenantConfig.projectRef),
        });
    }

    /**
     * Register a new tenant with the Realtime server.
     * Called during project provisioning.
     *
     * Realtime containers (especially during CI cold starts) can take longer to get ready, so
     * provision_realtime may execute before the container is ready. Perform bounded retries on
     * connection-level failures (fetch throws) while waiting for container startup; HTTP response-level
     * errors (4xx/5xx, excluding 409) are not retried, as they are logic errors that must fail fast.
     */
    async registerTenant(config: RealtimeTenantConfig): Promise<boolean> {
        const tenantPayload = await this.authoritativeTenantPayload(config);
        // CI cold start Realtime containers often require ~20-40s before accepting connections; provide sufficient retry window.
        const MAX_ATTEMPTS = Number(process.env.REALTIME_REGISTER_MAX_ATTEMPTS || 12);
        const BACKOFF_MS = Number(process.env.REALTIME_REGISTER_BACKOFF_MS || 3000);
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const res = await fetch(`${this.adminUrl}/api/tenants`, {
                    method: "POST",
                    headers: await this.authHeaders(),
                    body: JSON.stringify(tenantPayload),
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
                const msg = err instanceof Error ? err.message : String(err);
                // Connection-level failure (container not ready): retry instead of immediately failing, avoiding CI race conditions.
                if (attempt < MAX_ATTEMPTS && isConnectionError(msg)) {
                    logger.warn(`[Realtime] Registration deferred for ${config.projectRef} (container not ready, attempt ${attempt}/${MAX_ATTEMPTS}):`, { error: msg });
                    await new Promise((r) => setTimeout(r, BACKOFF_MS));
                    continue;
                }
                logger.error(`[Realtime] Registration error for ${config.projectRef}:`, { error: msg });
                return false;
            }
        }
        return false;
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
        const tenantPayload = await this.authoritativeTenantPayload(config);
        try {
            const res = await fetch(`${this.adminUrl}/api/tenants/${config.projectRef}`, {
                method: "PUT",
                headers: await this.authHeaders(),
                body: JSON.stringify(tenantPayload),
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
