import { EventEmitter } from 'events';
import type { JWTPayload } from 'jose';
import { logger } from '../utils/logger';
import { databaseService } from './database.service';
import { resolveDbName, getProjectDb, resolveSlotName } from '../db';
import { SQL_MODULES } from '../db/sql-modules';
import { verifyProjectJwtPayload } from '../utils/project-jwt';

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function validatePgIdentifier(name: string, label: string): string {
    if (!IDENTIFIER_REGEX.test(name)) {
        throw new Error(`Invalid ${label}: ${name}`);
    }
    return name;
}

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

interface RealtimeSubscriptionState {
    id: string;
    subscriptions: PostgresChangeConfig[];
    token?: string;
}

class RealtimeBunService {
    private tenantListeners = new Map<string, any>();
    public events = new EventEmitter();
    private tenantSubscriptions = new Map<string, RealtimeSubscriptionState[]>();
    private subscriptionIdMap = new Map<string, Map<number, string>>();
    private ensuredTriggers = new Set<string>();
    private wal2jsonAvailable = new Map<string, boolean>();
    private walPollingIntervals = new Map<string, NodeJS.Timeout>();
    private subscriptionCounter = 0;

    public async subscribeTenant(
        projectRef: string,
        subscriptions?: PostgresChangeConfig[],
        token?: string
    ): Promise<string | null> {
        let subscriptionStateId: string | null = null;
        if (subscriptions) {
            const states = this.tenantSubscriptions.get(projectRef) || [];
            subscriptionStateId = `${projectRef}:${++this.subscriptionCounter}`;
            states.push({ id: subscriptionStateId, subscriptions, token });
            this.tenantSubscriptions.set(projectRef, states);
        }

        if (subscriptions && subscriptions.length > 0) {
            await this.ensureTriggers(projectRef, subscriptions);
        }

        if (this.tenantListeners.has(projectRef)) return subscriptionStateId;

        try {
            const dbName = await resolveDbName(projectRef);
            let db: any;
            try {
                db = getProjectDb(dbName);
            } catch {
                return subscriptionStateId;
            }

            if (!db) return subscriptionStateId;

            const hasWal2json = await this.detectWal2json(db, projectRef);

            if (hasWal2json) {
                this.startWalPolling(projectRef, db);
            } else {
                const listener = await db.listen('realtime_changes', async (payload: string) => {
                    try {
                        const parsed = JSON.parse(payload);
                        await this.filterAndEmit(projectRef, parsed);
                    } catch (err: unknown) {
                        logger.error(`[RealtimeBun] Failed to parse NOTIFY payload for ${projectRef}`, { error: String(err) });
                    }
                });

                this.tenantListeners.set(projectRef, listener);
            }

            logger.info(`[RealtimeBun] Started listening for ${projectRef} (wal2json: ${hasWal2json})`);
        } catch (err: unknown) {
            logger.error(`[RealtimeBun] Failed to subscribe to tenant ${projectRef}`, { error: String(err) });
        }

        return subscriptionStateId;
    }

    private async detectWal2json(db: any, projectRef: string): Promise<boolean> {
        const cached = this.wal2jsonAvailable.get(projectRef);
        if (cached !== undefined) return cached;

        try {
            const [row] = await db`
                SELECT COUNT(*) > 0 as available
                FROM pg_available_extensions
                WHERE name = 'wal2json'
            `;
            const available = row?.available || false;
            if (available) {
                const [slotRow] = await db`
                    SELECT COUNT(*) > 0 as exists
                    FROM pg_replication_slots
                    WHERE slot_name = ${resolveSlotName(projectRef)} AND active = false
                `;
                const hasSlot = slotRow?.exists || false;
                this.wal2jsonAvailable.set(projectRef, hasSlot);
                return hasSlot;
            }
            this.wal2jsonAvailable.set(projectRef, false);
            return false;
        } catch {
            this.wal2jsonAvailable.set(projectRef, false);
            return false;
        }
    }

    private startWalPolling(projectRef: string, db: any) {
        if (this.walPollingIntervals.has(projectRef)) return;

        const poll = async () => {
            try {
                const changes = await db`
                    SELECT data FROM pg_logical_slot_get_changes(${resolveSlotName(projectRef)}, NULL, NULL)
                `;
                if (Array.isArray(changes) && changes.length > 0) {
                    for (const change of changes) {
                        try {
                            const walData = typeof change.data === 'string' ? JSON.parse(change.data) : change.data;
                            const formatted = this.wal2jsonToChangeEvent(walData);
                            if (formatted) {
                                await this.filterAndEmit(projectRef, formatted);
                            }
                        } catch { /* skip malformed WAL entries */ }
                    }
                }
            } catch (err: unknown) {
                logger.warn(`[RealtimeBun] WAL polling error for ${projectRef}`, { error: String(err) });
            }
        };

        const interval = setInterval(poll, 100);
        this.walPollingIntervals.set(projectRef, interval as unknown as NodeJS.Timeout);
        poll();
    }

    private wal2jsonToChangeEvent(walData: any): any | null {
        if (!walData?.change || !Array.isArray(walData.change)) return null;

        const results: any[] = [];
        for (const entry of walData.change) {
            const kind = entry.kind;
            const schema = entry.schema;
            const table = entry.table;

            let type: string;
            if (kind === 'insert') type = 'INSERT';
            else if (kind === 'update') type = 'UPDATE';
            else if (kind === 'delete') type = 'DELETE';
            else continue;

            const record: Record<string, any> = {};
            const oldRecord: Record<string, any> = {};

            if (entry.columnnames && entry.columnvalues) {
                for (let i = 0; i < entry.columnnames.length; i++) {
                    record[entry.columnnames[i]] = entry.columnvalues[i];
                }
            }
            if (entry.oldkeys?.keynames && entry.oldkeys?.keyvalues) {
                for (let i = 0; i < entry.oldkeys.keynames.length; i++) {
                    oldRecord[entry.oldkeys.keynames[i]] = entry.oldkeys.keyvalues[i];
                }
            }

            results.push({
                type,
                schema,
                table,
                record: type !== 'DELETE' ? record : null,
                old_record: type !== 'INSERT' ? oldRecord : null,
                commit_timestamp: new Date().toISOString(),
                columns: (entry.columnnames || []).map((name: string, i: number) => ({
                    name,
                    type: entry.columntypes?.[i] || 'text'
                }))
            });
        }

        return results.length === 1 ? results[0] : results.length > 0 ? results : null;
    }

    private async ensureTriggers(projectRef: string, subscriptions: PostgresChangeConfig[]) {
        const dbName = await resolveDbName(projectRef);
        let db: any;
        try {
            db = getProjectDb(dbName);
        } catch { return; }
        if (!db) return;

        try {
            await db.unsafe(`
                ${SQL_MODULES["realtime-notify-payload"]}

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

                    PERFORM realtime.notify_change_payload(payload);
                    RETURN COALESCE(NEW, OLD);
                END;
                $$ LANGUAGE plpgsql;
            `);

            for (const sub of subscriptions) {
                const rawSchema = sub.schema || 'public';
                const rawTable = sub.table;
                if (!rawTable) continue;

                let schema: string;
                let table: string;
                try {
                    schema = validatePgIdentifier(rawSchema, 'schema');
                    table = validatePgIdentifier(rawTable, 'table');
                } catch {
                    logger.warn(`[RealtimeBun] Skipping invalid identifier: ${rawSchema}.${rawTable}`);
                    continue;
                }

                const triggerKey = `${projectRef}:${schema}:${table}`;
                if (this.ensuredTriggers.has(triggerKey)) continue;

                const triggerName = `supacloud_rlt_${schema}_${table}`;
                try {
                    await db.unsafe(`
                        DROP TRIGGER IF EXISTS "${triggerName}" ON "${schema}"."${table}";
                        CREATE TRIGGER "${triggerName}"
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

    public unsubscribeSubscription(projectRef: string, subscriptionStateId: string): void {
        const states = this.tenantSubscriptions.get(projectRef);
        if (!states) return;
        const idx = states.findIndex((state) => state.id === subscriptionStateId);
        if (idx >= 0) states.splice(idx, 1);
        if (states.length === 0) {
            this.tenantSubscriptions.delete(projectRef);
        }
    }

    private async filterAndEmit(projectRef: string, raw: any): Promise<void> {
        const inner = raw.payload || raw;
        const states = this.tenantSubscriptions.get(projectRef);
        const changeType = inner.type || inner.event || '';
        const schema = inner.schema || 'public';
        const table = inner.table || '';

        if (!states || states.length === 0) return;

        const idMap = this.subscriptionIdMap.get(projectRef);
        for (const state of states) {
            const matchingIds: string[] = [];
            for (let i = 0; i < state.subscriptions.length; i++) {
                const sub = state.subscriptions[i];
                if (sub.event !== '*' && sub.event !== changeType) continue;
                if (sub.schema !== schema) continue;
                if (sub.table && sub.table !== table) continue;
                if (sub.filter && !this.matchesFilter(sub.filter, inner.record || {})) continue;
                const serverSubId = idMap?.get(typeof sub.id === 'number' ? sub.id : parseInt(String(sub.id), 10));
                matchingIds.push(serverSubId || String(sub.id ?? i));
            }

            if (matchingIds.length === 0) continue;

            const visibilityRecord = changeType === 'DELETE' ? inner.old_record || {} : inner.record || {};
            if (!(await this.isVisibleForSubscription(projectRef, schema, table, visibilityRecord, changeType, state.token))) {
                continue;
            }

            const formatted = this.formatEvent(inner, matchingIds);
            this.events.emit(`change:${state.id}`, formatted);
        }
    }

    private async isVisibleForSubscription(
        projectRef: string,
        schema: string,
        table: string,
        record: Record<string, any>,
        changeType: string,
        token?: string
    ): Promise<boolean> {
        if (!token) return false;

        const jwtPayload = await this.verifyRealtimeJwt(projectRef, token);
        if (!jwtPayload) return false;

        const allowServiceRole = (jwtPayload as Record<string, unknown>).__allow_service_role === true;
        if (allowServiceRole && jwtPayload.role === 'service_role') {
            return true;
        }
        if (jwtPayload.role !== 'anon' && jwtPayload.role !== 'authenticated') {
            return false;
        }

        return this.checkRlsVisibility(projectRef, schema, table, record, jwtPayload, changeType);
    }

    private async verifyRealtimeJwt(projectRef: string, token: string): Promise<JWTPayload | null> {
        try {
            const verification = await verifyProjectJwtPayload(projectRef, token);
            if (!verification || typeof verification.payload.role !== 'string') return null;
            return { ...verification.payload, __allow_service_role: verification.isServiceRole };
        } catch {
            return null;
        }
    }

    private async checkRlsVisibility(
        projectRef: string,
        schema: string,
        table: string,
        record: Record<string, any>,
        jwtPayload: JWTPayload,
        changeType: string
    ): Promise<boolean> {
        try {
            let safeSchema: string;
            let safeTable: string;
            try {
                safeSchema = validatePgIdentifier(schema, 'schema');
                safeTable = validatePgIdentifier(table, 'table');
            } catch {
                return false;
            }

            const dbName = await resolveDbName(projectRef);
            const db = getProjectDb(dbName);
            if (!db) return false;

            const pkCols = await db`
                SELECT a.attname
                FROM pg_index i
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                JOIN pg_class c ON c.oid = i.indrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = ${safeSchema}
                  AND c.relname = ${safeTable}
                  AND i.indisprimary
            `.catch(() => null);

            if (!pkCols || !Array.isArray(pkCols) || pkCols.length === 0) return false;

            const pkValues: unknown[] = [];
            for (const col of pkCols) {
                const colName = (col as Record<string, unknown>).attname as string;
                const val = record[colName];
                if (val === undefined) return false;
                pkValues.push(val);
            }

            const allowServiceRole = (jwtPayload as Record<string, unknown>).__allow_service_role === true;
            const role = jwtPayload.role === 'authenticated' || (allowServiceRole && jwtPayload.role === 'service_role') ? jwtPayload.role : 'anon';
            const claims = JSON.stringify({ ...jwtPayload, role });

            const whereParts = pkCols.map((col, i) => {
                const colName = validatePgIdentifier((col as Record<string, unknown>).attname as string, 'column');
                return `"${colName}" = $${i + 1}`;
            });

            return await db.begin(async (tx) => {
                await tx.unsafe(`SET LOCAL ROLE "${role}"`);
                await tx`SELECT set_config('request.jwt.claims', ${claims}, true)`;
                await tx`SELECT set_config('request.jwt.claim.sub', ${String(jwtPayload.sub || '')}, true)`;
                await tx`SELECT set_config('request.jwt.claim.role', ${role}, true)`;

                const selectResult = await tx.unsafe(
                    `SELECT 1 FROM "${safeSchema}"."${safeTable}" WHERE ${whereParts.join(' AND ')} LIMIT 1`,
                    pkValues
                );

                return Array.isArray(selectResult) && selectResult.length > 0;
            });
        } catch {
            return false;
        }
    }

    private matchesFilter(filter: string, record: Record<string, any>): boolean {
        const parts = filter.split('=');
        if (parts.length !== 2) return false;
        const column = parts[0].trim();
        const valuePart = parts[1].trim();
        const dotIdx = valuePart.indexOf('.');
        if (dotIdx === -1) return false;
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
            default: return false;
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
            } catch (err: unknown) {/* ignore */}
        }
        this.tenantListeners.delete(projectRef);
        this.tenantSubscriptions.delete(projectRef);
        this.subscriptionIdMap.delete(projectRef);

        const walInterval = this.walPollingIntervals.get(projectRef);
        if (walInterval) {
            clearInterval(walInterval);
            this.walPollingIntervals.delete(projectRef);
        }

        if (listener || walInterval) {
            logger.info(`[RealtimeBun] Stopped listening to tenant ${projectRef}`);
        }
    }
}

export const realtimeBunService = new RealtimeBunService();
