import { PostgresMeta } from '@supabase/postgres-meta';
import { logger } from '../utils/logger';


class PgMetaManager {
    private instances = new Map<string, { meta: PostgresMeta; lastUpdated: number }>();
    private readonly ttlMs = 5 * 60 * 1000; // 5 minutes completely idle TTL
    private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Get or create a PostgresMeta instance for a specific connection string.
     */
    getInstance(connectionString: string): PostgresMeta {
        const now = Date.now();
        const existing = this.instances.get(connectionString);

        if (existing) {
            existing.lastUpdated = now;
            return existing.meta;
        }

        logger.info(`[PgMetaManager] Initializing new PostgresMeta instance for tenant.`);

        // Initialize new instance with a small pool size to conserve memory
        const meta = new PostgresMeta({ connectionString, max: 2, idleTimeoutMillis: 30000 });

        this.instances.set(connectionString, { meta, lastUpdated: now });
        this.scheduleCleanup();

        return meta;
    }

    private scheduleCleanup() {
        if (this.cleanupTimer) return;

        // Check every minute
        this.cleanupTimer = setTimeout(async () => {
            this.cleanupTimer = null;
            const now = Date.now();

            for (const [connStr, data] of this.instances.entries()) {
                if (now - data.lastUpdated > this.ttlMs) {
                    try {
                        logger.info(`[PgMetaManager] Closing idle PostgresMeta instance.`);
                        if (typeof data.meta.end === 'function') {
                            await data.meta.end().catch(e => logger.warn(`[PgMetaManager] Ignored meta.end() error: ${e}`));
                        }
                    } catch (e) {
                        logger.error(`[PgMetaManager] Error closing pg-meta idle connection: ${e}`);
                    } finally {
                        this.instances.delete(connStr);
                    }
                }
            }

            if (this.instances.size > 0) {
                this.scheduleCleanup();
            }
        }, 60 * 1000);
    }

    /**
     * Gracefully close all managed instances.
     */
    async closeAll() {
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        const promises = Array.from(this.instances.values()).map(data => data.meta.end().catch(e => {
            logger.error(`[PgMetaManager] Error during closeAll: ${e}`);
        }));
        await Promise.all(promises);
        this.instances.clear();
    }
}

export const pgMetaManager = new PgMetaManager();
