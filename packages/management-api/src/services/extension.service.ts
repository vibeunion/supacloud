import { logger } from "../utils/logger";
import { getProjectDb, resolveDbName } from "../db";
import { $ } from "bun";

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function validatePgIdentifier(name: string, label: string): string {
    if (!IDENTIFIER_REGEX.test(name)) {
        throw new Error(`Invalid ${label}: ${name}`);
    }
    return name;
}

export interface ExtensionInfo {
    name: string;
    default_version: string;
    installed_version: string | null;
    comment: string;
    is_installed: boolean;
}

export class ExtensionService {
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
        const safeExt = validatePgIdentifier(extension, 'extension');
        const safeSchema = schema ? validatePgIdentifier(schema, 'schema') : null;
        const dbName = await resolveDbName(projectRef);
        const db = getProjectDb(dbName);
        if (safeExt === "pg_graphql") {
            const rows = await db`
                SELECT installed_version
                FROM pg_available_extensions
                WHERE name = 'pg_graphql'
            `;
            const isInstalled = rows.some((row: { installed_version?: string | null }) => row.installed_version);
            if (!isInstalled) {
                await db.unsafe(`
                    DROP FUNCTION IF EXISTS graphql_public.graphql(text, text, jsonb, jsonb);
                    DROP FUNCTION IF EXISTS graphql_public.graphql(text, text, jsonb);
                `);
            }
        }
        let sql = `CREATE EXTENSION IF NOT EXISTS "${safeExt}"`;
        if (safeSchema) sql += ` SCHEMA "${safeSchema}"`;
        if (version) sql += ` VERSION '${version.replace(/'/g, "''")}'`;
        sql += ` CASCADE`;
        await db.unsafe(sql);

        const rows = await db`
            SELECT name, default_version, installed_version, comment,
                installed_version IS NOT NULL AS is_installed
            FROM pg_available_extensions WHERE name = ${extension}
        `;
        return (rows[0] as ExtensionInfo) || { name: extension, default_version: version || '', installed_version: version || null, comment: '', is_installed: true };
    }

    async disableExtension(projectRef: string, extension: string): Promise<ExtensionInfo> {
        const safeExt = validatePgIdentifier(extension, 'extension');
        const dbName = await resolveDbName(projectRef);
        const db = getProjectDb(dbName);
        await db.unsafe(`DROP EXTENSION IF EXISTS "${safeExt}" CASCADE`);

        const rows = await db`
            SELECT name, default_version, installed_version, comment,
                installed_version IS NOT NULL AS is_installed
            FROM pg_available_extensions WHERE name = ${extension}
        `;
        return (rows[0] as ExtensionInfo) || { name: extension, default_version: '', installed_version: null, comment: '', is_installed: false };
    }

    async listSystemExtensions(): Promise<{ name: string; version: string; status: string; description: string }[]> {
        try {
            const result = await $`pig ext list`.nothrow().quiet();
            if (result.exitCode !== 0) {
                return await this.listSystemExtensionsFromDb();
            }
            const text = result.text();
            const rawLines = text.split('\n');
            // Filter out decorative/header/summary lines from pig ext list output
            const isDataLine = (l: string): boolean => {
                const trimmed = l.trim();
                if (!trimmed) return false;
                // Skip Unicode box-drawing separator lines
                if (/^[\s\u2500-\u257F\-+|]+$/.test(trimmed)) return false;
                // Skip header row (Name | Version | ...)
                if (/^\s*name\s*\|/i.test(trimmed)) return false;
                // Skip summary lines like "(464 Rows)"
                if (/^\(\d+\s+Rows?\)/.test(trimmed)) return false;
                // Skip banner lines like checkmark + "Found N extensions"
                if (/^\u2713/.test(trimmed)) return false;
                // Skip comment and decoration lines
                if (/^[#=]/.test(trimmed)) return false;
                return true;
            };
            const dataLines = rawLines.filter(isDataLine);
            // Try pipe-delimited parsing first (table output)
            if (dataLines.some((l: string) => l.includes('|'))) {
                return dataLines
                    .map((l: string) => {
                        const parts = l.split('|').map((p: string) => p.trim());
                        return { name: parts[0] || '', version: parts[1] || '', status: parts[2] || 'available', description: parts.slice(3).join(' | ').trim() || '' };
                    })
                    .filter((e: { name: string }) => e.name);
            }
            // Fallback: space-delimited parsing
            return dataLines
                .map((l: string) => {
                    const parts = l.split(/\s+/);
                    return { name: parts[0] || '', version: parts[1] || '', status: parts[2] || 'available', description: parts.slice(3).join(' ') || '' };
                })
                .filter((e: { name: string }) => e.name);
        } catch {
            return await this.listSystemExtensionsFromDb();
        }
    }

    private async listSystemExtensionsFromDb(): Promise<{ name: string; version: string; status: string; description: string }[]> {
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
