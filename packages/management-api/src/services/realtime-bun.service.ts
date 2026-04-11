import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { databaseService } from './database.service';

/**
 * Native Bun implementation of PostgreSQL LISTEN/NOTIFY for Supabase Realtime.
 * Uses event-driven architecture to intercept Postgres changes without logical replication / WAL requirements.
 */
class RealtimeBunService {
    private tenantListeners = new Map<string, any>();
    public events = new EventEmitter();

    /**
     * Start listening to a tenant's NOTIFY events.
     */
    public async subscribeTenant(projectRef: string) {
        if (this.tenantListeners.has(projectRef)) return;
        
        try {
            const dbName = `supa_${projectRef}`;
            let db: any;
            try {
                // @ts-ignore
                db = databaseService.getTenantDb(dbName);
            } catch {
                return;
            }

            if (!db) return;

            // Wait until postgres establishes listener
            const listener = await db.listen('realtime_changes', (payload: string) => {
                try {
                    const parsed = JSON.parse(payload);
                    this.events.emit(`change:${projectRef}`, parsed);
                } catch (err: unknown) {
                    logger.error(`[RealtimeBun] Failed to parse NOTIFY payload for ${projectRef}`, { error: String(err) });
                }
            });

            this.tenantListeners.set(projectRef, listener);
            logger.info(`[RealtimeBun] Started listening to realtime_changes for tenant ${projectRef}`);
        } catch (err: unknown) {
            logger.error(`[RealtimeBun] Failed to subscribe to tenant ${projectRef}`, { error: String(err) });
        }
    }

    /**
     * Stop listening
     */
    public async unsubscribeTenant(projectRef: string) {
        const listener = this.tenantListeners.get(projectRef);
        if (listener) {
            try {
                await listener.unlisten();
                this.tenantListeners.delete(projectRef);
                logger.info(`[RealtimeBun] Stopped listening to tenant ${projectRef}`);
            } catch (err: unknown) {/* ignore */}
        }
    }
}

export const realtimeBunService = new RealtimeBunService();
