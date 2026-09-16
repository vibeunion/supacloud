import { $ } from "bun";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getProjectDb, resolveDbName } from "../db";
import { notifyPostgrestSchemaReload } from "./database-schema-notify";
import { reconcileGraphqlEntrypoint } from "./graphql-extension";
import { assertExtensionMutation, extensionIdentifier, ExtensionOperationError } from "./extension-policy";
import { readPgflowState, setPgflowEnabled } from "./pgflow.service";

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
type SystemExtensionInfo = { name: string; version: string; status: string; description: string };

function validatePgIdentifier(name: string, label: string): string {
    if (!IDENTIFIER_REGEX.test(name)) {
        throw new Error(`Invalid ${label}: ${name}`);
    }
    return name;
}

const ExtensionInfoSchema = Type.Object({
    name: Type.String(),
    default_version: Type.String(),
    installed_version: Type.Union([Type.String(), Type.Null()]),
    comment: Type.String(),
    is_installed: Type.Boolean(),
    is_enabled: Type.Optional(Type.Boolean()),
    schema: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type ExtensionInfo = Static<typeof ExtensionInfoSchema>;
const ExtensionResultSchema = Type.Array(ExtensionInfoSchema, { minItems: 1, maxItems: 1 });

export function parsePigExtensionList(text: string): SystemExtensionInfo[] {
    const hasStatusVersionHeader = text
        .split('\n')
        .some((line: string) => /^name\s+status\s+version\b/i.test(line.trim()));
    const rows = text
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => {
            if (!line) return false;
            if (/^[\s\u2500-\u257F\-+|]+$/.test(line)) return false;
            if (/^\(\d+\s+rows?\)$/i.test(line)) return false;
            if (/^[\u2713\u2714\u2611]?\s*Found\s+\d+\s+extensions?/i.test(line)) return false;
            if (/^name\s+(status|version|cate|flags)\b/i.test(line)) return false;
            if (/^[#=]/.test(line)) return false;
            return true;
        });

    const tableRows = rows
        .map((line: string) => line.replace(/\u2502/g, '|'))
        .filter((line: string) => line.includes('|'));

    if (tableRows.length > 0) {
        return tableRows
            .map((line: string) => {
                const parts = line.split('|').map((part: string) => part.trim());
                if (parts[0] === '') parts.shift();
                if (parts[parts.length - 1] === '') parts.pop();
                return parts;
            })
            .filter((parts: string[]) => parts.length > 0 && !/^name$/i.test(parts[0] || ''))
            .map((parts: string[]) => ({
                name: parts[0] || '',
                version: parts[1] || '',
                status: parts[2] || 'available',
                description: parts.slice(3).join(' | ').trim() || '',
            }))
            .filter((extension: SystemExtensionInfo) => extension.name);
    }

    return rows
        .map((line: string) => {
            const parts = line.split(/\s+/);
            if (hasStatusVersionHeader) {
                return {
                    name: parts[0] || '',
                    version: parts[2] || '',
                    status: parts[1] || 'available',
                    description: parts.slice(5).join(' ') || parts.slice(3).join(' ') || '',
                };
            }
            return { name: parts[0] || '', version: parts[1] || '', status: parts[2] || 'available', description: parts.slice(3).join(' ') || '' };
        })
        .filter((extension: SystemExtensionInfo) => extension.name);
}

export class ExtensionService {
    async listExtensionCatalog(ref: string) {
        const db = getProjectDb(await resolveDbName(ref));
        const native = await this.listExtensions(ref);
        const state = await readPgflowState(db, ref);
        const [durable] = await db`SELECT current_database() = current_setting('pg_durable.database',true)
            AND 'pg_durable' = ANY(string_to_array(replace(current_setting('shared_preload_libraries'),' ',''),',')) AS ready`;
        const [workers] = state.managed ? await db`
            SELECT count(*)::int AS count FROM pgflow.workers
            WHERE stopped_at IS NULL AND deprecated_at IS NULL AND last_heartbeat_at > clock_timestamp()-interval '30 seconds'
        ` : [{ count: 0 }];
        const rows = native.map(row => {
            let blocked: string | null = null;
            try { assertExtensionMutation(row.name, !row.is_installed); }
            catch (error) { blocked = error instanceof Error ? error.message : "Manual maintenance required"; }
            if (row.name === "pg_durable" && !row.is_installed && durable?.ready !== true) {
                blocked = "Administrator preload/restart and the configured pg_durable database are required";
            }
            return { ...row, kind: "extension", available: true,
                can_enable: !row.is_installed && !blocked, can_disable: row.is_installed && !blocked, blocked_reason: blocked };
        });
        return [...rows, { name: "pgflow", default_version: "0.16.0", installed_version: state.version,
            is_installed: state.installed, is_enabled: state.enabled, kind: "workflow", schema: "pgflow",
            runtime_status: !state.installed ? "not_installed" : !state.managed ? "unmanaged"
                : !state.enabled ? "paused" : Number(workers?.count) > 0 ? "running" : "worker_not_ready",
            available: true, can_enable: !state.enabled && (!state.installed || state.managed && state.profile === "shared"),
            can_disable: state.enabled && state.managed && state.profile === "shared",
            comment: "Canonical SupaCloud worker runtime; pausing preserves workflow history.",
            blocked_reason: state.installed && !state.managed ? "Unmanaged schema; reviewed adoption required"
                : state.installed && state.profile !== "shared" ? "Dedicated profile requires a reviewed control upgrade" : null }];
    }

    async configurePgflow(ref: string, enabled: boolean): Promise<ExtensionInfo> {
        const db = getProjectDb(await resolveDbName(ref));
        const state = await setPgflowEnabled(db, ref, enabled);
        await notifyPostgrestSchemaReload(db, ref);
        return { name: "pgflow", default_version: "0.16.0", installed_version: state.version,
            is_installed: state.installed, is_enabled: state.enabled, schema: "pgflow",
            comment: "Canonical SupaCloud pgflow installation" };
    }
    async listExtensions(projectRef: string): Promise<ExtensionInfo[]> {
        const dbName = await resolveDbName(projectRef);
        const db = getProjectDb(dbName);
        const rows = await db`
            SELECT
                name,
                default_version,
                installed_version,
                comment,
                installed_version IS NOT NULL AS is_installed
            FROM pg_available_extensions
            ORDER BY name
        `;
        return rows as ExtensionInfo[];
    }

    async enableExtension(projectRef: string, extension: string, schema?: string, version?: string): Promise<ExtensionInfo> {
        const safeExt = extensionIdentifier(extension);
        if (safeExt === "pgflow") {
            if (schema && schema !== "pgflow" || version && version !== "0.16.0") throw new ExtensionOperationError("pgflow uses its fixed schema and bundled version", 400);
            return this.configurePgflow(projectRef, true);
        }
        assertExtensionMutation(safeExt, true);
        const safeSchema = schema ? validatePgIdentifier(schema, 'schema') : null;
        const dbName = await resolveDbName(projectRef);
        const db = getProjectDb(dbName);
        if (safeExt === "pg_durable") {
            const [ready] = await db`SELECT current_database() = current_setting('pg_durable.database',true)
                AND 'pg_durable' = ANY(string_to_array(replace(current_setting('shared_preload_libraries'),' ',''),',')) AS ready`;
            if (ready?.ready !== true) throw new ExtensionOperationError("pg_durable requires preload/restart and its configured database");
        }
        return db.begin(async (transaction) => {
            let sql = `CREATE EXTENSION IF NOT EXISTS "${safeExt}"`;
            if (safeSchema) sql += ` SCHEMA "${safeSchema}"`;
            if (version) sql += ` VERSION '${version.replace(/'/g, "''")}'`;
            sql += ` CASCADE`;
            await transaction.unsafe(sql);
            if (safeExt === "pg_graphql") {
                await reconcileGraphqlEntrypoint(transaction);
            }
            const rows: unknown = await transaction`
                SELECT name, default_version, installed_version, coalesce(comment, '') AS comment,
                    installed_version IS NOT NULL AS is_installed
                FROM pg_available_extensions WHERE name = ${extension}
            `;
            if (!Value.Check(ExtensionResultSchema, rows)) {
                throw new Error(`Invalid installed extension state: ${extension}`);
            }
            const result = rows[0];
            if (!result || !result.is_installed || result.installed_version === null || result.name !== extension) {
                throw new Error(`Missing installed extension state: ${extension}`);
            }
            await notifyPostgrestSchemaReload(transaction, projectRef);
            return result;
        });
    }

    async disableExtension(projectRef: string, extension: string): Promise<ExtensionInfo> {
        const safeExt = extensionIdentifier(extension);
        if (safeExt === "pgflow") return this.configurePgflow(projectRef, false);
        assertExtensionMutation(safeExt, false);
        const dbName = await resolveDbName(projectRef);
        const db = getProjectDb(dbName);
        await db.begin(async (transaction) => {
            await transaction.unsafe(`DROP EXTENSION IF EXISTS "${safeExt}" RESTRICT`);
            await notifyPostgrestSchemaReload(transaction, projectRef);
        });

        const rows = await db`
            SELECT name, default_version, installed_version, comment,
                installed_version IS NOT NULL AS is_installed
            FROM pg_available_extensions WHERE name = ${extension}
        `;
        if (!Value.Check(ExtensionResultSchema, rows)) throw new ExtensionOperationError("Extension removal could not be confirmed");
        const result = rows[0];
        if (!result || result.name !== extension || result.is_installed || result.installed_version !== null) {
            throw new ExtensionOperationError("Extension removal could not be confirmed");
        }
        return result;
    }

    async listSystemExtensions(): Promise<SystemExtensionInfo[]> {
        try {
            const result = await $`pig ext list`.nothrow().quiet();
            if (result.exitCode !== 0) {
                return await this.listSystemExtensionsFromDb();
            }
            return parsePigExtensionList(result.text());
        } catch {
            return await this.listSystemExtensionsFromDb();
        }
    }

    private async listSystemExtensionsFromDb(): Promise<SystemExtensionInfo[]> {
        try {
            const { sql } = await import("../db");
            const rows = await sql`
                SELECT name, default_version, installed_version, comment
                FROM pg_available_extensions
                ORDER BY name
            `;
            return (rows as Array<{ name: string; default_version: string | null; installed_version: string | null; comment: string | null }>).map(row => ({
                name: row.name,
                version: row.default_version || '-',
                status: row.installed_version ? 'installed' : 'available',
                description: row.comment || '',
            }));
        } catch {
            return [];
        }
    }

    async installSystemExtension(name: string): Promise<{ success: boolean; message: string }> {
        try {
            const result = await $`sudo pig ext install ${name} -y`.nothrow().quiet();
            if (result.exitCode !== 0) {
                return { success: false, message: `Failed to install ${name}: ${result.stderr.toString().slice(0, 500)}` };
            }
            return { success: true, message: `Extension package '${name}' installed successfully` };
        } catch (err: unknown) {
            return { success: false, message: (err instanceof Error ? err.message : String(err)) };
        }
    }

    async removeSystemExtension(name: string): Promise<{ success: boolean; message: string }> {
        try {
            const result = await $`sudo pig ext remove ${name} -y`.nothrow().quiet();
            if (result.exitCode !== 0) {
                return { success: false, message: `Failed to remove ${name}: ${result.stderr.toString().slice(0, 500)}` };
            }
            return { success: true, message: `Extension package '${name}' removed successfully` };
        } catch (err: unknown) {
            return { success: false, message: (err instanceof Error ? err.message : String(err)) };
        }
    }
}

export const extensionService = new ExtensionService();
