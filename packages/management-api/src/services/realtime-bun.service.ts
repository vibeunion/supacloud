import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { databaseService } from './database.service';

interface PostgresChangeConfig {
    event: string;
    schema: string;
    table?: string;
    filter?: string;
}

interface ChangeEvent {
    data: {
        columns: Array<{ name: string; type: string }>;
        commit_timestamp: string;
        record: Record<string, any>;
        old_record?: Record<string, any>;
        schema: string;
        table: string;
        type: 'INSERT' | 'UPDATE' | 'DELETE';
        errors: string | null;
    };
    ids: number[];
}

class RealtimeBunService {
    private tenantListeners = new Map<string, any>();
    public events = new EventEmitter();
    private tenantSubscriptions = new Map<string, PostgresChangeConfig[]>();
    private tenantTokens = new Map<string, string>();

    public async subscribeTenant(
        projectRef: string,
        subscriptions?: PostgresChangeConfig[],
        token?: string
    ) {
        if (subscriptions) {
            this.tenantSubscriptions.set(projectRef, subscriptions);
        }
        if (token) {
            this.tenantTokens.set(projectRef, token);
        }

        if (this.tenantListeners.has(projectRef)) return;

        try {
            const dbName = `supa_${projectRef}`;
            let db: any;
            try {
                db = (databaseService as any).getTenantDb(dbName);
            } catch {
                return;
            }

            if (!db) return;

            const listener = await db.listen('realtime_changes', (payload: string) => {
                try {
                    const parsed = JSON.parse(payload);
                    const filtered = this.filterAndFormat(projectRef, parsed);
                    if (filtered) {
                        this.events.emit(`change:${projectRef}`, filtered);
                    }
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

    private filterAndFormat(projectRef: string, raw: any): ChangeEvent | null {
        const subs = this.tenantSubscriptions.get(projectRef);
        const changeType = raw.type || raw.event || '';
        const schema = raw.schema || 'public';
        const table = raw.table || '';

        if (!subs || subs.length === 0) {
            return this.formatEvent(raw, [0]);
        }

        const matchingIndices: number[] = [];
        for (let i = 0; i < subs.length; i++) {
            const sub = subs[i];
            if (sub.event !== '*' && sub.event !== changeType) continue;
            if (sub.schema !== schema) continue;
            if (sub.table && sub.table !== table) continue;
            if (sub.filter && !this.matchesFilter(sub.filter, raw.record || {})) continue;
            matchingIndices.push(i);
        }

        if (matchingIndices.length === 0) return null;

        return this.formatEvent(raw, matchingIndices);
    }

    private matchesFilter(filter: string, record: Record<string, any>): boolean {
        const parts = filter.split('=');
        if (parts.length !== 2) return true;
        const column = parts[0].trim();
        const valuePart = parts[1].trim();
        const dotIdx = valuePart.indexOf('.');
        if (dotIdx === -1) return true;
        const op = valuePart.substring(0, dotIdx);
        const val = valuePart.substring(dotIdx + 1);
        const recordVal = String(record[column] ?? '');
        switch (op) {
            case 'eq': return recordVal === val;
            case 'neq': return recordVal !== val;
            case 'gt': return recordVal > val;
            case 'gte': return recordVal >= val;
            case 'lt': return recordVal < val;
            case 'lte': return recordVal <= val;
            case 'like': return new RegExp(val.replace(/%/g, '.*')).test(recordVal);
            case 'ilike': return new RegExp(val.replace(/%/g, '.*'), 'i').test(recordVal);
            default: return true;
        }
    }

    private formatEvent(raw: any, ids: number[]): ChangeEvent {
        const record = raw.record || raw.new || {};
        const oldRecord = raw.old_record || raw.old || null;
        const columns = Object.keys(record).map(k => ({
            name: k,
            type: raw.columns?.[k] || 'text'
        }));

        return {
            data: {
                columns,
                commit_timestamp: raw.commit_timestamp || new Date().toISOString(),
                record,
                ...(oldRecord ? { old_record: oldRecord } : {}),
                schema: raw.schema || 'public',
                table: raw.table || '',
                type: raw.type || raw.event || 'INSERT',
                errors: null
            },
            ids
        };
    }

    public async unsubscribeTenant(projectRef: string) {
        const listener = this.tenantListeners.get(projectRef);
        if (listener) {
            try {
                await listener.unlisten();
                this.tenantListeners.delete(projectRef);
                this.tenantSubscriptions.delete(projectRef);
                this.tenantTokens.delete(projectRef);
                logger.info(`[RealtimeBun] Stopped listening to tenant ${projectRef}`);
            } catch (err: unknown) {/* ignore */}
        }
    }
}

export const realtimeBunService = new RealtimeBunService();
