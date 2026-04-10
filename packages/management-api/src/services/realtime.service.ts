import { logger } from "../utils/logger";
import { createPgListener, PgListenerHandle } from "./pg-listen";
import { broadcastToTopic } from "../routes/realtime";

interface RealtimeTenantConfig {
    projectRef: string;
    dbName: string;
    dbPassword: string;
    jwtSecret: string;
}

export class RealtimeService {
    // Map of projectRef to pg-listen handle
    private listeners = new Map<string, PgListenerHandle>();

    /**
     * Register a new tenant with the Realtime server.
     * Starts a pg_listen connection to the tenant's DB.
     */
    async registerTenant(config: RealtimeTenantConfig): Promise<boolean> {
        try {
            // If already listening, close existing
            if (this.listeners.has(config.projectRef)) {
                this.listeners.get(config.projectRef)!.close();
            }

            const dbUrl = `postgresql://supabase_admin:${encodeURIComponent(config.dbPassword)}@127.0.0.1:5432/${config.dbName}`;
            
            logger.info(`[Realtime CDC] Connecting native pg-listen for ${config.projectRef}`);
            
            const listener = createPgListener(
                dbUrl,
                ["supabase_realtime_changes"],
                (channel, payload) => {
                    // Trigger broadcast to the topic based on payload contents.
                    // A proper implementation would evaluate RLS against all connected clients.
                    // For now we broadcast the generic payload to clients listening to realtime:*
                    // In supabase-js, postgres_changes events are pushed to topic: realtime:public:* or realtime:projectRef:*
                    let parsed: any;
                    try {
                      parsed = JSON.parse(payload);
                    } catch { return; }
                    
                    const schema = parsed.schema || "public";
                    const table = parsed.table || "*";
                    
                    // Push to the realtime topic for this project
                    // The client joins "realtime:projectRef:db_changes" or "realtime:any"
                    // To keep it simple, broadcast to "realtime-cdc:" + projectRef
                    // Actually, clients join "realtime:any" or custom topics in supabase-js.
                    broadcastToTopic(`realtime:any`, "postgres_changes", parsed);
                }
            );

            this.listeners.set(config.projectRef, listener);
            logger.info(`[Realtime] Tenant natively registered: ${config.projectRef}`);
            return true;
        } catch (err: unknown) {
            logger.error(`[Realtime] Registration error for ${config.projectRef}:`, { error: err instanceof Error ? err.message : String(err) });
            return false;
        }
    }

    async removeTenant(projectRef: string): Promise<boolean> {
        const listener = this.listeners.get(projectRef);
        if (listener) {
            listener.close();
            this.listeners.delete(projectRef);
        }
        logger.info(`[Realtime] Tenant removed: ${projectRef}`);
        return true;
    }

    async updateTenant(config: RealtimeTenantConfig): Promise<boolean> {
        // Just re-register to update passwords etc.
        return this.registerTenant(config);
    }

    async healthCheck(): Promise<{ healthy: boolean; tenants?: number }> {
        return { healthy: true, tenants: this.listeners.size };
    }
}

export const realtimeService = new RealtimeService();
