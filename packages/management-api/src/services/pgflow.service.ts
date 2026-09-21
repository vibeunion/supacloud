import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { PGFLOW_VERSION, PGFLOW_BUNDLE_SHA256, PGFLOW_MIGRATIONS } from "../db/pgflow-bundle";
import platformSql from "../db/pgflow-platform.sql" with { type: "text" };
import finalizeSql from "../db/pgflow-platform-finalize.sql" with { type: "text" };
import { executeSqlStatements } from "../db/sql-statements";
import { ExtensionOperationError } from "./extension-policy";

export { PGFLOW_VERSION };
export const PGFLOW_RUNTIME_SHA256 = createHash("sha256")
    .update(PGFLOW_BUNDLE_SHA256).update(platformSql).update(finalizeSql).digest("hex");

export interface PgflowState {
    installed: boolean;
    enabled: boolean;
    version: string | null;
    managed: boolean;
    runtime_status?: "not_installed" | "unmanaged" | "paused" | "worker_not_ready" | "running";
    active_workers?: number;
}

export async function readPgflowState(db: SQL): Promise<PgflowState> {
    const [schema] = await db`
        SELECT to_regnamespace('pgflow') IS NOT NULL AS installed,
            to_regclass('pgflow._supacloud_state') IS NOT NULL AS managed
    `;
    if (!schema?.managed) {
        return { installed: schema?.installed === true, managed: false, enabled: false, version: null,
            runtime_status: schema?.installed ? "unmanaged" : "not_installed", active_workers: 0 };
    }
    const [state] = await db`SELECT version, bundle_sha256, enabled FROM pgflow._supacloud_state WHERE singleton`;
    if (!state || state.version !== PGFLOW_VERSION || state.bundle_sha256 !== PGFLOW_RUNTIME_SHA256
        || typeof state.enabled !== "boolean") {
        throw new ExtensionOperationError("pgflow bundle/version mismatch; an explicit reviewed upgrade is required.");
    }
    const [workers] = await db`
        SELECT count(*)::integer AS count FROM pgflow.workers w
        JOIN pgflow.worker_functions f USING (function_name)
        WHERE f.enabled AND w.stopped_at IS NULL AND w.deprecated_at IS NULL
            AND w.last_heartbeat_at > clock_timestamp() - interval '30 seconds'
    `;
    const activeWorkers = Number(workers?.count ?? 0);
    return { installed: true, managed: true, enabled: state.enabled, version: state.version,
        active_workers: activeWorkers,
        runtime_status: !state.enabled ? "paused" : activeWorkers > 0 ? "running" : "worker_not_ready" };
}

export async function setPgflowEnabled(db: SQL, enabled: boolean): Promise<PgflowState> {
    return db.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock(1937076332, 1)`;
        let state = await readPgflowState(transaction);
        if (state.installed && !state.managed) {
            throw new ExtensionOperationError("An unmanaged pgflow schema exists. Back up and explicitly migrate it before platform adoption.");
        }
        if (!state.installed && enabled) {
            // Everything, including PGMQ installation, rolls back on failure.
            await transaction.unsafe('CREATE EXTENSION IF NOT EXISTS pgmq CASCADE');
            await transaction.unsafe('CREATE SCHEMA pgflow');
            await executeSqlStatements(transaction, platformSql);
            for (const migration of PGFLOW_MIGRATIONS) {
                if (migration.sql.trim()) await executeSqlStatements(transaction, migration.sql);
            }
            await executeSqlStatements(transaction, finalizeSql);
            await transaction`
                INSERT INTO pgflow._supacloud_state(version, bundle_sha256, enabled)
                VALUES (${PGFLOW_VERSION}, ${PGFLOW_RUNTIME_SHA256}, false)
            `;
            state = await readPgflowState(transaction);
        }
        if (!state.installed) return state;
        await transaction`
            UPDATE pgflow._supacloud_state SET enabled = ${enabled}, updated_at = clock_timestamp()
            WHERE singleton
        `;
        const confirmed = await readPgflowState(transaction);
        if (confirmed.enabled !== enabled) throw new ExtensionOperationError("pgflow state could not be confirmed.");
        return confirmed;
    });
}

export async function registerPgflowWorker(db: SQL, name: string, enabled: boolean): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
        throw new ExtensionOperationError("Invalid pgflow worker function name", 400);
    }
    await db.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock(1937076332, 1)`;
        const state = await readPgflowState(transaction);
        if (!state.managed) throw new ExtensionOperationError("Enable the bundled pgflow core before registering workers.");
        await transaction`
            INSERT INTO pgflow.worker_functions(function_name, enabled, start_mode)
            VALUES (${name}, ${enabled}, 'http')
            ON CONFLICT (function_name) DO UPDATE
            SET enabled = EXCLUDED.enabled, updated_at = clock_timestamp()
        `;
        const [worker] = await transaction`SELECT enabled FROM pgflow.worker_functions WHERE function_name = ${name}`;
        if (worker?.enabled !== enabled) throw new ExtensionOperationError("Worker state could not be confirmed");
    });
}

export async function grantPgflowWorker(db: SQL, role: string): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role)) {
        throw new ExtensionOperationError("Invalid PostgreSQL worker role", 400);
    }
    await db`SELECT pgflow._supacloud_grant_worker(${role})`;
}
