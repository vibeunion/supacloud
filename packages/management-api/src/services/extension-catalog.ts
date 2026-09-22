import type { ExtensionInfo } from "./extension.service";
import { assertExtensionMutation } from "./extension-policy";
import type { PgflowState } from "./pgflow.service";

// Version SupaCloud installs and supervises for the bundled pgflow core.
const PGFLOW_VERSION = "0.16.0";
export type PgflowRuntimeStatus = "not_installed" | "unmanaged" | "paused" | "worker_not_ready" | "running";

const RECOMMENDED_EXTENSIONS: ReadonlyArray<readonly [string, string]> = [
    ["pg_stat_statements", "Query execution statistics and slow-query analysis."],
    ["pg_trgm", "Indexed substring and similarity search."],
    ["pg_jsonschema", "Validate JSON documents against JSON Schema."],
    ["pg_cron", "Schedule database maintenance and recurring SQL jobs."],
    ["pgmq", "Persistent message queues; consumers run separately."],
    ["vector", "Vector storage and similarity search for embeddings."],
    ["pgroonga", "Multilingual full-text search, including Chinese."],
    ["pg_net", "Asynchronous HTTP requests after transaction commit."],
    ["supabase_vault", "Encrypted storage of secrets used by database jobs."],
    ["pg_partman", "Automated native partition creation and retention."],
    ["pgaudit", "Database operation audit logging."],
    ["postgis", "Spatial types, indexes and geographic queries."],
    ["wrappers", "Foreign data wrappers for external data sources."],
    ["index_advisor", "Index recommendations for specific SQL queries."],
    ["hypopg", "Hypothetical indexes for query-plan evaluation."],
    ["pgtap", "SQL-level database tests."],
    ["plpgsql_check", "Static checking of PL/pgSQL functions."],
    ["pg_repack", "Table and index reorganization; requires a separate client."],
    ["pg_durable", "Durable SQL workflows; requires a configured background worker."],
];

export interface ExtensionRuntime {
    durable_ready: boolean;
    pgflow_schema: boolean;
    pgflow?: PgflowState;
}

export interface ManagedExtensionInfo extends ExtensionInfo {
    kind: "extension" | "workflow";
    available: boolean;
    can_enable: boolean;
    can_disable: boolean;
    blocked_reason: string | null;
    runtime_status?: PgflowRuntimeStatus;
    active_workers?: number;
    is_enabled?: boolean;
    schema?: string | null;
}

export function extensionCatalog(
    installed: readonly ExtensionInfo[],
    runtime: ExtensionRuntime,
): ManagedExtensionInfo[] {
    const rows = new Map(installed.map((row) => [row.name, row]));
    for (const [name, comment] of RECOMMENDED_EXTENSIONS) {
        if (!rows.has(name)) {
            rows.set(name, { name, comment, default_version: "", installed_version: null, is_installed: false });
        }
    }
    const available = new Set(installed.map((row) => row.name));
    const result: ManagedExtensionInfo[] = [...rows.values()].map((row) => {
        let blocked_reason: string | null = null;
        if (!available.has(row.name)) {
            blocked_reason = "The extension package is not available on this database server. Administrator installation is required.";
        } else if (!row.is_installed && row.name === "pg_durable" && !runtime.durable_ready) {
            blocked_reason = "Administrator preload/restart is required; this database must match pg_durable.database.";
        } else {
            try {
                assertExtensionMutation(row.name, !row.is_installed);
            } catch (error) {
                blocked_reason = error instanceof Error ? error.message : "Manual maintenance is required.";
            }
        }
        return {
            ...row,
            kind: "extension",
            available: available.has(row.name),
            can_enable: !row.is_installed && blocked_reason === null,
            can_disable: row.is_installed && blocked_reason === null,
            blocked_reason,
        };
    });
    const pgflow = runtime.pgflow;
    const pgflowBlocked = pgflow?.installed && !pgflow.managed
        || !pgflow && runtime.pgflow_schema;
    result.push({
        name: "pgflow",
        kind: "workflow",
        default_version: PGFLOW_VERSION,
        installed_version: pgflow?.version ?? null,
        is_installed: pgflow?.installed ?? false,
        is_enabled: pgflow?.enabled ?? false,
        runtime_status: pgflow === undefined || !pgflow.installed ? "not_installed"
            : !pgflow.managed ? "unmanaged"
                : !pgflow.enabled ? "paused" : "running",
        active_workers: 0,
        schema: pgflow?.installed || runtime.pgflow_schema ? "pgflow" : null,
        comment: "Bundled workflow core. SupaCloud supervises registered workers; pause preserves workflow and queue data.",
        available: true,
        can_enable: !pgflowBlocked && !pgflow?.enabled && (available.has("pgmq") || pgflow?.managed === true),
        can_disable: !pgflowBlocked && pgflow?.enabled === true,
        blocked_reason: pgflowBlocked
            ? "Unmanaged pgflow schema detected. Explicit migration/adoption is required; existing data will not be replaced."
            : !available.has("pgmq") && !pgflow?.managed ? "PGMQ package is required before enabling the bundled pgflow core." : null,
    });
    return result.sort((a, b) => a.name.localeCompare(b.name));
}
