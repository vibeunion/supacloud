import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { databaseService } from './database.service';

interface PostgresChangeConfig {
    id?: string | number;
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
        errors: string[];
    };
    ids: string[];
}

class RealtimeBunService {
    private tenantListeners = new Map<string, any>();
    public events = new EventEmitter();
    private tenantSubscriptions = new Map<string, PostgresChangeConfig[]>();
    private tenantTokens = new Map<string, string>();
    private subscriptionIdMap = new Map<string, Map<number, string>>();
    private ensuredTriggers = new Set<string>();

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

        if (subscriptions && subscriptions.length > 0) {
            await this.ensureTriggers(projectRef, subscriptions);
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

            const listener = await db.listen('realtime_changes', async (payload: string) => {
                try {
                    const parsed = JSON.parse(payload);
                    const filtered = await this.filterAndFormat(projectRef, parsed);
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

    private async ensureTriggers(projectRef: string, subscriptions: PostgresChangeConfig[]) {
        const dbName = `supa_${projectRef}`;
        let db: any;
        try {
            db = (databaseService as any).getTenantDb(dbName);
        } catch { return; }
        if (!db) return;

        try {
            await db.unsafe(`
                CREATE OR REPLACE FUNCTION realtime_supacloud_notify()
                RETURNS TRIGGER AS $$
                DECLARE
                    payload JSONB;
                    old_data JSONB := '{}';
                    new_data JSONB := '{}';
                    cols JSONB;
                BEGIN
                    IF TG_OP = 'INSERT' THEN
                        new_data = to_jsonb(NEW);
                    ELSIF TG_OP = 'UPDATE' THEN
                        new_data = to_jsonb(NEW);
                        old_data = to_jsonb(OLD);
                    ELSIF TG_OP = 'DELETE' THEN
                        old_data = to_jsonb(OLD);
                    END IF;

                    SELECT jsonb_agg(jsonb_build_object('name', col, 'type', typ))
                    INTO cols
                    FROM (
                        SELECT column_name AS col, data_type AS typ
                        FROM information_schema.columns
                        WHERE table_schema = TG_TABLE_SCHEMA AND table_name = TG_TABLE_NAME
                    ) sub;

                    payload = jsonb_build_object(
                        'type', TG_OP,
                        'schema', TG_TABLE_SCHEMA,
                        'table', TG_TABLE_NAME,
                        'record', new_data,
                        'old_record', old_data,
                        'columns', COALESCE(cols, '[]'::jsonb),
                        'commit_timestamp', now()::text
                    );

                    PERFORM pg_notify('realtime_changes', payload::text);
                    RETURN COALESCE(NEW, OLD);
                END;
                $$ LANGUAGE plpgsql;
            `);

            for (const sub of subscriptions) {
                const schema = sub.schema || 'public';
                const table = sub.table;
                if (!table) continue;

                const triggerKey = `${projectRef}:${schema}:${table}`;
                if (this.ensuredTriggers.has(triggerKey)) continue;

                const triggerName = `supacloud_rlt_${schema}_${table}`;
                try {
                    await db.unsafe(`
                        DROP TRIGGER IF EXISTS ${triggerName} ON "${schema}"."${table}";
                        CREATE TRIGGER ${triggerName}
                            AFTER INSERT OR UPDATE OR DELETE ON "${schema}"."${table}"
                            FOR EACH ROW EXECUTE FUNCTION realtime_supacloud_notify();
                    `);
                    this.ensuredTriggers.add(triggerKey);
                    logger.info(`[RealtimeBun] Auto-created trigger ${triggerName} on ${schema}.${table}`);
                } catch (err: unknown) {
                    logger.warn(`[RealtimeBun] Could not create trigger on ${schema}.${table}: ${String(err)}`);
                }
            }
        } catch (err: unknown) {
            logger.error(`[RealtimeBun] Failed to ensure triggers for ${projectRef}`, { error: String(err) });
        }
    }

    public registerSubscriptionIds(projectRef: string, mappings: Array<{ id: number; subscription_id: string }>) {
        let map = this.subscriptionIdMap.get(projectRef);
        if (!map) {
            map = new Map();
            this.subscriptionIdMap.set(projectRef, map);
        }
        for (const m of mappings) {
            map.set(m.id, m.subscription_id);
        }
    }

    private async filterAndFormat(projectRef: string, raw: any): Promise<ChangeEvent | null> {
        const inner = raw.payload || raw;
        const subs = this.tenantSubscriptions.get(projectRef);
        const changeType = inner.type || inner.event || '';
        const schema = inner.schema || 'public';
        const table = inner.table || '';

        if (!subs || subs.length === 0) {
            return this.formatEvent(inner, []);
        }

        const matchingIds: string[] = [];
        const idMap = this.subscriptionIdMap.get(projectRef);
        for (let i = 0; i < subs.length; i++) {
            const sub = subs[i];
            if (sub.event !== '*' && sub.event !== changeType) continue;
            if (sub.schema !== schema) continue;
            if (sub.table && sub.table !== table) continue;
            if (sub.filter && !this.matchesFilter(sub.filter, inner.record || {})) continue;
            const serverSubId = idMap?.get(typeof sub.id === 'number' ? sub.id : parseInt(String(sub.id), 10));
            matchingIds.push(serverSubId || String(sub.id ?? i));
        }

        if (matchingIds.length === 0) return null;

        const token = this.tenantTokens.get(projectRef);
        if (token) {
            try {
                const jwtPayload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
                if (jwtPayload.role === 'service_role' || jwtPayload.role === 'postgres' || jwtPayload.role === 'supabase_admin') {
                    return this.formatEvent(inner, matchingIds);
                }
                if (jwtPayload.role !== 'anon' && jwtPayload.role !== 'authenticated') {
                    return null;
                }

                const rlsOk = await this.checkRlsVisibility(projectRef, schema, table, inner.record || {}, jwtPayload.role, changeType);
                if (!rlsOk) return null;
            } catch { return null; }
        }

        return this.formatEvent(inner, matchingIds);
    }

    private async checkRlsVisibility(
        projectRef: string,
        schema: string,
        table: string,
        record: Record<string, any>,
        role: string,
        changeType: string
    ): Promise<boolean> {
        try {
            const dbName = `supa_${projectRef}`;
            const db = (databaseService as any).getTenantDb(dbName);
            if (!db) return true;

            const hasPrimaryKey = record.id !== undefined;
            if (!hasPrimaryKey) return true;

            const pkVal = record.id;
            const pkType = typeof pkVal === 'number' ? pkVal : `'${String(pkVal).replace(/'/g, "''")}'`;

            const rlsCheck = await db.unsafe(`
                SET LOCAL role ${role};
                SELECT 1 FROM "${schema}"."${table}" WHERE id = ${pkType} LIMIT 1;
            `).catch(() => null);

            if (!rlsCheck || !Array.isArray(rlsCheck) || rlsCheck.length === 0) {
                return false;
            }
            return true;
        } catch {
            return true;
        }
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
            case 'in': {
                const inValues = val.replace(/^\(|\)$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, ''));
                return inValues.includes(recordVal);
            }
            default: return true;
        }
    }

    private formatEvent(inner: any, ids: string[]): ChangeEvent {
        const record = inner.record || inner.new || {};
        const oldRecord = inner.old_record || inner.old || null;

        const columns = Array.isArray(inner.columns) && inner.columns[0]?.name && inner.columns[0]?.type
            ? inner.columns
            : Object.keys(record).map(k => ({
                name: k,
                type: inner.columns?.[k] || (typeof record[k] === 'number' ? 'int8' : 'text')
            }));

        return {
            data: {
                columns,
                commit_timestamp: inner.commit_timestamp || new Date().toISOString(),
                record,
                ...(oldRecord ? { old_record: oldRecord } : {}),
                schema: inner.schema || 'public',
                table: inner.table || '',
                type: inner.type || inner.event || 'INSERT',
                errors: []
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
                this.subscriptionIdMap.delete(projectRef);
                logger.info(`[RealtimeBun] Stopped listening to tenant ${projectRef}`);
            } catch (err: unknown) {/* ignore */}
        }
    }
}

export const realtimeBunService = new RealtimeBunService();
