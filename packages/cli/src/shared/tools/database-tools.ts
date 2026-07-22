/**
 * Database — Compound tool (18→1)
 * SQL execution, schema introspection, RLS, migrations, stats
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { HttpTransport } from "../transports/http";

export interface DatabaseToolsConfig {
    readOnly?: boolean;
    projectRef?: string;
}

const MAX_MIGRATION_VERSION = 9_223_372_036_854_775_807n;
const FALLBACK_MIGRATION_VERSION_BASE = 8_000_000_000_000_000_000n;
const FALLBACK_MIGRATION_VERSION_RANGE = 1_000_000_000_000_000_000n;
const FALLBACK_MIGRATION_VERSION_LIMIT = FALLBACK_MIGRATION_VERSION_BASE + FALLBACK_MIGRATION_VERSION_RANGE;

interface MigrationFile {
    file: string;
    name: string;
    version: string;
    sql: string;
    rawBytes: Uint8Array;
}

function readMigrationFile(dir: string, file: string): MigrationFile {
    const rawBytes = readFileSync(join(dir, file));
    return {
        file,
        name: basename(file, ".sql"),
        version: migrationVersionFromFilename(file),
        sql: Buffer.from(rawBytes).toString("utf8"),
        rawBytes,
    };
}

export function migrationVersionFromFilename(file: string): string {
    const match = basename(file).match(/^(\d{8,20})[_-]/);
    if (match) {
        const version = BigInt(match[1]);
        if (version < 1n || version > MAX_MIGRATION_VERSION) {
            throw new Error(`Invalid migration version '${match[1]}' in ${basename(file)}: expected 1..${MAX_MIGRATION_VERSION}`);
        }
        if (version >= FALLBACK_MIGRATION_VERSION_BASE && version < FALLBACK_MIGRATION_VERSION_LIMIT) {
            throw new Error(`Invalid migration version '${match[1]}' in ${basename(file)}: version range ${FALLBACK_MIGRATION_VERSION_BASE}..${FALLBACK_MIGRATION_VERSION_LIMIT - 1n} is reserved for non-timestamp migrations`);
        }
        return version.toString();
    }

    const digest = createHash("sha256").update(basename(file)).digest("hex");
    const offset = BigInt(`0x${digest}`) % FALLBACK_MIGRATION_VERSION_RANGE;
    return (FALLBACK_MIGRATION_VERSION_BASE + offset).toString();
}

function sortMigrationFiles(migrations: MigrationFile[]): MigrationFile[] {
    const sorted = [...migrations].sort((a, b) => {
        const versionA = BigInt(a.version);
        const versionB = BigInt(b.version);
        if (versionA < versionB) return -1;
        if (versionA > versionB) return 1;
        return a.file.localeCompare(b.file);
    });
    for (let i = 1; i < sorted.length; i += 1) {
        const previous = sorted[i - 1];
        const current = sorted[i];
        if (previous.version === current.version && (previous.file !== current.file || previous.name !== current.name)) {
            throw new Error(`Migration version collision for ${current.version}: ${previous.file} and ${current.file}`);
        }
    }
    return sorted;
}

function appliedMigrationKeys(data: unknown): Set<string> {
    const rows = Array.isArray(data) ? data : (data as { rows?: unknown[] })?.rows || [];
    const keys = new Set<string>();
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const migration = row as { version?: unknown; name?: unknown };
        if (migration.version != null) keys.add(String(migration.version));
        if (migration.name != null) keys.add(String(migration.name));
    }
    return keys;
}

function migrationRows(data: unknown): Array<Record<string, unknown>> {
    const rows = Array.isArray(data) ? data : (data as { rows?: unknown[] })?.rows || [];
    return Array.isArray(rows)
        ? rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
        : [];
}

function migrationIdentityKey(version: string, name: string): string {
    return `${version}\u0000${name}`;
}

function nameBoundMigrationMarkerKeys(data: unknown): Set<string> {
    const keys = new Set<string>();
    for (const row of migrationRows(data)) {
        if (row.version == null || row.name == null || !Array.isArray(row.statements)) continue;
        if (row.statements.length !== 1) continue;
        const name = String(row.name);
        const marker = row.statements[0];
        if (marker !== `baseline:${name}` && marker !== `direct-apply:${name}`) continue;
        keys.add(migrationIdentityKey(String(row.version), String(row.name)));
    }
    return keys;
}

function historicalChecksumMarkerKeys(
    data: unknown,
    migrationFiles: MigrationFile[],
): Set<string> {
    const filesByKey = new Map(migrationFiles.map((migration) => [migrationIdentityKey(migration.version, migration.name), migration]));
    const keys = new Set<string>();
    for (const row of migrationRows(data)) {
        if (row.version == null || row.name == null || !Array.isArray(row.statements) || row.statements.length !== 1) continue;
        const marker = row.statements[0];
        if (typeof marker !== "string" || !/^sha256:[0-9a-f]{64}$/.test(marker)) continue;
        const key = migrationIdentityKey(String(row.version), String(row.name));
        const migration = filesByKey.get(key);
        if (!migration) continue;
        const checksum = createHash("sha256").update(migration.rawBytes).digest("hex");
        if (marker === `sha256:${checksum}`) keys.add(key);
    }
    return keys;
}

function isAlreadyAppliedMigrationResponse(response: { status: number; data: unknown }): boolean {
    if (response.status !== 409 || !response.data || typeof response.data !== "object") return false;
    const body = response.data as Record<string, unknown>;
    return body.code === "409" && body.message === "Migration already applied";
}

function sqlReferencesVector(sql: string): boolean {
    return /\bvector\s*\(\s*\d+\s*\)/i.test(sql)
        || /::\s*vector\b/i.test(sql)
        || /\bvector_(cosine|l2|ip)_ops\b/i.test(sql)
        || /<=>|<#>|<->/.test(sql);
}

function sqlCreatesVectorExtension(sql: string): boolean {
    return /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?vector["']?/i.test(sql);
}

function extensionRows(data: unknown): Array<Record<string, unknown>> {
    const shaped = data as { rows?: unknown[] };
    const rows = shaped?.rows || [];
    return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

export function vectorWarningsForPendingMigrations(
    migrations: Array<{ file: string; sql: string }>,
    vectorEnabled: boolean | null,
): string[] {
    const warnings: string[] = [];
    const vectorUsers = migrations.filter(({ sql }) => sqlReferencesVector(sql));
    const vectorCreators = migrations.filter(({ sql }) => sqlCreatesVectorExtension(sql));

    if (!vectorUsers.length && !vectorCreators.length) return warnings;

    if (vectorEnabled === false && vectorUsers.length && !vectorCreators.length) {
        warnings.push(
            `vector extension is not enabled, but pending migrations use vector types/operators: ${vectorUsers.map(({ file }) => file).join(", ")}`,
        );
    }

    if (vectorEnabled === false && vectorCreators.length) {
        warnings.push(
            `pending migrations will enable pgvector: ${vectorCreators.map(({ file }) => file).join(", ")}`,
        );
    }

    if (vectorEnabled === null) {
        warnings.push("could not verify whether vector extension is enabled");
    }

    return warnings;
}

export function registerDatabaseTools(
    server: { tool: (...args: any[]) => void },
    http: HttpTransport,
    config: DatabaseToolsConfig = {}
): void {
    const { readOnly = false, projectRef } = config;

    // Build action list dynamically
    const actions = [
        "query", "list_tables", "describe_columns", "list_indexes", "list_constraints",
        "list_extensions", "rls_status", "rls_policies",
        "list_auth_users", "get_auth_user",
        "connections", "stats", "slow_queries",
        "list_migrations", "project_url", "generate_types",
    ] as const;
    const writeActions = ["apply_migration", "push_migrations", "baseline_migrations", "create_table_rls"] as const;
    const allActions = readOnly ? actions : [...actions, ...writeActions];

    server.tool(
        "database",
        `Database operations: query, schema, RLS, migrations, stats.
Actions: ${allActions.join(", ")}${readOnly ? " (read-only mode)" : ""}`,
        {
            action: withDescription(stringEnum(allActions as unknown as [string, ...string[]]), "Action"),
            ref: projectRef ? Type.Optional(Type.String()) : optional(Type.String(), "Project ref"),
            // query
            sql: optional(Type.String(), "[query/apply_migration] SQL statement"),
            file: optional(Type.String(), "[query/apply_migration] Read SQL from local file path (avoids shell escaping issues with $$ and multi-statement DDL)"),
            dir: optional(Type.String(), "[push_migrations/baseline_migrations] Directory containing .sql migration files (default: supabase/migrations)"),
            dry_run: optional(Type.Boolean(), "[push_migrations/baseline_migrations] Preview changes without applying them"),
            // schema
            schema: optional(Type.String(), "[*] Schema name (default: public)"),
            table: optional(Type.String(), "[describe_columns/indexes/constraints/rls_*] Table name"),
            schemas: optional(Type.Array(Type.String()), "[list_tables/generate_types] Schemas array"),
            // auth users
            user_id: optional(Type.String(), "[get_auth_user] User UUID"),
            limit: optional(Type.Number(), "[list_auth_users] Max users (default: 20)"),
            // migration
            name: optional(Type.String(), "[apply_migration] Migration name"),
            // create_table_rls
            columns: optional(Type.String(), "[create_table_rls] Column definitions"),
            policy_mode: optional(stringEnum(["deny_all", "owner"]), "[create_table_rls] RLS policy mode (default: deny_all)"),
            owner_column: optional(Type.String(), "[create_table_rls owner] UUID owner column matched to auth.uid()"),
        },
        async (args: any) => {
            const { action } = args;
            const ref = projectRef || args.ref;
            const schema = args.schema || "public";
            const schemas = args.schemas || ["public"];

            // Resolve SQL from --file if provided (avoids shell $$ and ; escaping)
            if (args.file && !args.sql) {
                try {
                    args.sql = readFileSync(args.file, "utf-8");
                } catch (e: any) {
                    return { content: [{ type: "text" as const, text: `❌ Failed to read file ${args.file}: ${e.message}` }] };
                }
            }

            const execSql = async (sql: string, mode?: "read" | "migration" | "admin") =>
                http.post(`/v1/projects/${ref}/database/sql`, mode ? { sql, mode } : { sql });

            let text: string;
            switch (action) {
                case "query": {
                    if (!args.sql) throw new Error("'sql' required");
                    if (readOnly) {
                        const upper = args.sql.trim().toUpperCase();
                        for (const kw of ["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TRUNCATE"]) {
                            if (upper.startsWith(kw)) return { content: [{ type: "text" as const, text: `❌ Write blocked: ${kw} (read-only mode)` }] };
                        }
                    }
                    const r = await execSql(args.sql);
                    text = r.ok ? formatSqlResult(r.data) : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                case "list_tables": {
                    const sql = `SELECT schemaname as schema, tablename as table, tableowner as owner FROM pg_tables WHERE schemaname = ANY(ARRAY[${schemas.map((s: string) => `'${s}'`).join(",")}]) ORDER BY schemaname, tablename;`;
                    const r = await execSql(sql);
                    text = r.ok ? formatTableList(r.data, schemas) : `❌ Failed (${r.status})`;
                    break;
                }
                case "describe_columns": {
                    if (!args.table) throw new Error("'table' required");
                    const sql = `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${args.table}' ORDER BY ordinal_position;`;
                    const r = await execSql(sql);
                    text = r.ok ? formatColumnsList(r.data, schema, args.table) : `❌ Failed (${r.status})`;
                    break;
                }
                case "list_indexes": {
                    if (!args.table) throw new Error("'table' required");
                    const sql = `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = '${schema}' AND tablename = '${args.table}';`;
                    const r = await execSql(sql);
                    text = r.ok ? formatIndexList(r.data) : `❌ Failed (${r.status})`;
                    break;
                }
                case "list_constraints": {
                    if (!args.table) throw new Error("'table' required");
                    const sql = `SELECT conname as name, contype as type, pg_get_constraintdef(oid) as definition FROM pg_constraint WHERE connamespace = '${schema}'::regnamespace AND conrelid = '${schema}.${args.table}'::regclass;`;
                    const r = await execSql(sql);
                    text = r.ok ? formatConstraintList(r.data) : `❌ Failed (${r.status})`;
                    break;
                }
                case "list_extensions": {
                    const sql = `SELECT extname as name, extversion as version, n.nspname as schema FROM pg_extension e JOIN pg_namespace n ON e.extnamespace = n.oid ORDER BY extname;`;
                    const r = await execSql(sql);
                    text = r.ok ? formatExtensionList(r.data) : `❌ Failed (${r.status})`;
                    break;
                }
                case "rls_status": {
                    const sql = `SELECT tablename, rowsecurity as rls_enabled FROM pg_tables WHERE schemaname = '${schema}' ORDER BY tablename;`;
                    const r = await execSql(sql);
                    text = r.ok ? formatRlsStatus(r.data) : `❌ Failed (${r.status})`;
                    break;
                }
                case "rls_policies": {
                    if (!args.table) throw new Error("'table' required");
                    const sql = `SELECT policyname, cmd, permissive, roles, qual, with_check FROM pg_policies WHERE schemaname = '${schema}' AND tablename = '${args.table}';`;
                    const r = await execSql(sql);
                    text = r.ok ? formatRlsPolicies(r.data, schema, args.table) : `❌ Failed (${r.status})`;
                    break;
                }
                case "list_auth_users": {
                    const lim = args.limit || 20;
                    const sql = `SELECT id, email, role, email_confirmed_at, created_at, last_sign_in_at, is_sso_user FROM auth.users ORDER BY created_at DESC LIMIT ${lim};`;
                    const r = await execSql(sql);
                    text = r.ok ? formatAuthUsers(r.data) : `❌ Failed (${r.status})`;
                    break;
                }
                case "get_auth_user": {
                    if (!args.user_id) throw new Error("'user_id' required");
                    const sql = `SELECT id, email, role, email_confirmed_at, created_at, last_sign_in_at, raw_user_meta_data, is_sso_user, phone FROM auth.users WHERE id = '${args.user_id}';`;
                    const r = await execSql(sql);
                    text = r.ok ? formatSingleUser(r.data) : `❌ Failed (${r.status})`;
                    break;
                }
                case "connections": {
                    const sql = `SELECT pid, usename, application_name, client_addr, state, query_start, query FROM pg_stat_activity WHERE datname = current_database() ORDER BY query_start DESC LIMIT 50;`;
                    const r = await execSql(sql);
                    text = r.ok ? formatConnections(r.data) : `❌ Failed (${r.status})`;
                    break;
                }
                case "stats": {
                    const sql = `SELECT schemaname, relname as table_name, n_live_tup as row_count, pg_size_pretty(pg_total_relation_size(schemaname || '.' || relname)) as total_size, pg_size_pretty(pg_relation_size(schemaname || '.' || relname)) as table_size, pg_size_pretty(pg_total_relation_size(schemaname || '.' || relname) - pg_relation_size(schemaname || '.' || relname)) as index_size FROM pg_stat_user_tables ORDER BY pg_total_relation_size(schemaname || '.' || relname) DESC LIMIT 30;`;
                    const r = await execSql(sql);
                    text = r.ok ? formatDbStats(r.data) : `❌ Failed (${r.status})`;
                    break;
                }
                case "slow_queries": {
                    const sql = `SELECT query, calls, round(total_exec_time::numeric, 2) as total_exec_time_ms, round(mean_exec_time::numeric, 2) as mean_exec_time_ms, rows FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;`;
                    const r = await execSql(sql);
                    text = r.ok ? JSON.stringify(r.data, null, 2) : `❌ Failed (${r.status}): Ensure pg_stat_statements is enabled.`;
                    break;
                }
                case "list_migrations": {
                    const r = await execSql(`SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 50;`);
                    text = r.ok ? formatMigrations(r.data) : `❌ Failed (${r.status})`;
                    break;
                }
                case "project_url": {
                    const r = await http.get(`/v1/projects/${ref}`);
                    text = r.ok ? JSON.stringify({ url: (r.data as any).api?.url || `https://${ref}.supabase.co` }, null, 2) : `❌ Failed (${r.status})`;
                    break;
                }
                case "generate_types": {
                    const sql = `SELECT t.table_schema, t.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default FROM information_schema.tables t JOIN information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema WHERE t.table_schema = ANY(ARRAY[${schemas.map((s: string) => `'${s}'`).join(",")}]) AND t.table_type = 'BASE TABLE' ORDER BY t.table_schema, t.table_name, c.ordinal_position;`;
                    const r = await execSql(sql);
                    text = r.ok ? generateTypeScriptTypes(r.data, schemas) : `❌ Failed (${r.status})`;
                    break;
                }
                case "apply_migration": {
                    if (!args.name || !args.sql) throw new Error("'name' and 'sql' required");
                    const r = await http.post(`/v1/projects/${ref}/database/migrations`, { name: args.name, sql: args.sql });
                    text = r.ok ? `✅ Migration '${args.name}' applied` : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                case "push_migrations": {
                    const dir = args.dir || "supabase/migrations";
                    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
                        throw new Error(`Migration directory not found: ${dir}`);
                    }

                    const files = readdirSync(dir)
                        .filter((file) => file.endsWith(".sql"))
                        .sort();

                    if (!files.length) {
                        text = `No .sql migration files found in ${dir}`;
                        break;
                    }

                    const migrationFiles = sortMigrationFiles(files.map((file) => readMigrationFile(dir, file)));

                    const migrationsResult = await http.get(`/v1/projects/${ref}/database/migrations`);
                    if (!migrationsResult.ok) {
                        text = `❌ Failed to load applied migrations (${migrationsResult.status}): ${JSON.stringify(migrationsResult.data)}`;
                        break;
                    }

                    if (args.dry_run) {
                        const appliedKeys = appliedMigrationKeys(migrationsResult.data);
                        const pending = migrationFiles.filter(({ name, version }) => !appliedKeys.has(name) && !appliedKeys.has(String(version)));
                        const alreadyApplied = migrationFiles.filter(({ name, version }) => appliedKeys.has(name) || appliedKeys.has(String(version)));
                        const pendingWithSql = pending;
                        let vectorEnabled: boolean | null = null;
                        if (pendingWithSql.some(({ sql }) => sqlReferencesVector(sql) || sqlCreatesVectorExtension(sql))) {
                            const extResult = await execSql("SELECT extname AS name FROM pg_extension WHERE extname = 'vector';");
                            vectorEnabled = extResult.ok
                                ? extensionRows(extResult.data).some((row) => row.name === "vector" || row.extname === "vector")
                                : null;
                        }
                        const warnings = vectorWarningsForPendingMigrations(pendingWithSql, vectorEnabled);
                        text = [
                            `Migration dry run for ${dir}`,
                            `Total: ${migrationFiles.length}`,
                            "",
                            "Pending:",
                            ...(pending.length ? pending.map(({ file, version }) => `  - ${file} (${version})`) : ["  - none"]),
                            "",
                            "Already applied:",
                            ...(alreadyApplied.length ? alreadyApplied.map(({ file, version }) => `  - ${file} (${version})`) : ["  - none"]),
                            ...(warnings.length ? ["", "Warnings:", ...warnings.map((warning) => `  - ${warning}`)] : []),
                        ].join("\n");
                        break;
                    }

                    const applied: string[] = [];
                    const skipped: string[] = [];
                    const nameBoundMarkerKeys = nameBoundMigrationMarkerKeys(migrationsResult.data);
                    const historicalChecksumKeys = historicalChecksumMarkerKeys(migrationsResult.data, migrationFiles);
                    for (const { file, name, version, sql } of migrationFiles) {
                        const migrationKey = migrationIdentityKey(version, name);
                        if (nameBoundMarkerKeys.has(migrationKey) || historicalChecksumKeys.has(migrationKey)) {
                            skipped.push(file);
                            continue;
                        }
                        const r = await http.post(`/v1/projects/${ref}/database/migrations`, { name, sql, version });
                        if (r.ok) {
                            applied.push(file);
                        } else if (isAlreadyAppliedMigrationResponse(r)) {
                            skipped.push(file);
                        } else {
                            text = [
                                `❌ Failed to apply ${file} (${r.status})`,
                                JSON.stringify(r.data, null, 2),
                                "",
                                `Applied before failure: ${applied.length}`,
                                `Skipped before failure: ${skipped.length}`,
                            ].join("\n");
                            return { content: [{ type: "text" as const, text }] };
                        }
                    }

                    text = [
                        `✅ Migration push completed for ${dir}`,
                        `Applied: ${applied.length}`,
                        `Skipped: ${skipped.length}`,
                        ...(applied.length ? ["", "Applied files:", ...applied.map((file) => `  - ${file}`)] : []),
                        ...(skipped.length ? ["", "Skipped files:", ...skipped.map((file) => `  - ${file}`)] : []),
                    ].join("\n");
                    break;
                }
                case "baseline_migrations": {
                    const dir = args.dir || "supabase/migrations";
                    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
                        throw new Error(`Migration directory not found: ${dir}`);
                    }

                    const files = readdirSync(dir)
                        .filter((file) => file.endsWith(".sql"))
                        .sort();

                    if (!files.length) {
                        text = `No .sql migration files found in ${dir}`;
                        break;
                    }

                    const migrationFiles = sortMigrationFiles(files.map((file) => readMigrationFile(dir, file)));

                    const r = await http.get(`/v1/projects/${ref}/database/migrations`);
                    if (!r.ok) {
                        text = `❌ Failed to load applied migrations (${r.status}): ${JSON.stringify(r.data)}`;
                        break;
                    }

                    const appliedKeys = appliedMigrationKeys(r.data);
                    const missing = migrationFiles.filter(({ name, version }) => !appliedKeys.has(name) && !appliedKeys.has(String(version)));
                    const alreadyApplied = migrationFiles.filter(({ name, version }) => appliedKeys.has(name) || appliedKeys.has(String(version)));

                    if (args.dry_run) {
                        text = [
                            `Migration baseline dry run for ${dir}`,
                            `Total: ${migrationFiles.length}`,
                            "",
                            "Would mark as applied:",
                            ...(missing.length ? missing.map(({ file, version }) => `  - ${file} (${version})`) : ["  - none"]),
                            "",
                            "Already applied:",
                            ...(alreadyApplied.length ? alreadyApplied.map(({ file, version }) => `  - ${file} (${version})`) : ["  - none"]),
                        ].join("\n");
                        break;
                    }

                    if (!missing.length) {
                        text = [
                            `✅ Migration baseline already aligned for ${dir}`,
                            `Already applied: ${alreadyApplied.length}`,
                        ].join("\n");
                        break;
                    }

                    const baselineSql = buildMigrationBaselineSql(missing);
                    const baselineResult = await execSql(baselineSql, "migration");
                    text = baselineResult.ok
                        ? [
                            `✅ Migration baseline completed for ${dir}`,
                            `Marked applied: ${missing.length}`,
                            `Already applied: ${alreadyApplied.length}`,
                            "",
                            "Marked files:",
                            ...missing.map(({ file, version }) => `  - ${file} (${version})`),
                        ].join("\n")
                        : `❌ Failed (${baselineResult.status}): ${JSON.stringify(baselineResult.data)}`;
                    break;
                }
                case "create_table_rls": {
                    if (!args.table || !args.columns) throw new Error("'table' and 'columns' required");
                    const qualifiedTable = `${quoteIdentifier(schema, "schema")}.${quoteIdentifier(args.table, "table")}`;
                    const columns = validateColumnDefinitions(args.columns);
                    const policyMode = args.policy_mode || "deny_all";
                    if (policyMode !== "deny_all" && policyMode !== "owner") throw new Error("Invalid RLS policy mode");
                    const policySql = buildRlsPolicySql(qualifiedTable, policyMode, args.owner_column);
                    const sql = `BEGIN; CREATE TABLE IF NOT EXISTS ${qualifiedTable} (${columns}); ALTER TABLE ${qualifiedTable} ENABLE ROW LEVEL SECURITY; ${policySql} COMMIT;`;
                    const r = await execSql(sql);
                    text = r.ok
                        ? `✅ Table '${schema}.${args.table}' created with RLS (${policyMode === "owner" ? "auth.uid() owner policy" : "deny-all by default"})`
                        : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                default: text = `❌ Unknown action: ${action}`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );
}

function quoteIdentifier(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
        throw new Error(`Invalid ${label} identifier`);
    }
    return `"${value}"`;
}

function validateColumnDefinitions(value: unknown): string {
    if (typeof value !== "string") throw new Error("Invalid column definitions");
    const columns = value.trim();
    if (!columns || columns.length > 16_384) throw new Error("Invalid column definitions");
    if (
        /[;\0]/.test(columns)
        || /--|\/\*|\*\//.test(columns)
        || /\b(?:ALTER|CREATE|DROP|GRANT|REVOKE|TRUNCATE|COPY|CALL|DO)\b/i.test(columns)
    ) {
        throw new Error("Unsafe column definitions");
    }
    return columns;
}

function buildRlsPolicySql(
    qualifiedTable: string,
    policyMode: "deny_all" | "owner",
    ownerColumnValue: unknown,
): string {
    const policyNames = [
        "Enable ALL for authenticated",
        "SupaCloud owner select",
        "SupaCloud owner insert",
        "SupaCloud owner update",
        "SupaCloud owner delete",
    ];
    const dropPolicies = policyNames
        .map((name) => `DROP POLICY IF EXISTS "${name}" ON ${qualifiedTable};`)
        .join(" ");
    if (policyMode === "deny_all") return dropPolicies;

    const ownerColumn = quoteIdentifier(ownerColumnValue, "owner column");
    const predicate = `auth.uid() IS NOT NULL AND auth.uid() = ${ownerColumn}`;
    return `${dropPolicies}
      CREATE POLICY "SupaCloud owner select" ON ${qualifiedTable} FOR SELECT TO authenticated USING (${predicate});
      CREATE POLICY "SupaCloud owner insert" ON ${qualifiedTable} FOR INSERT TO authenticated WITH CHECK (${predicate});
      CREATE POLICY "SupaCloud owner update" ON ${qualifiedTable} FOR UPDATE TO authenticated USING (${predicate}) WITH CHECK (${predicate});
      CREATE POLICY "SupaCloud owner delete" ON ${qualifiedTable} FOR DELETE TO authenticated USING (${predicate});`;
}

function sqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function buildMigrationBaselineSql(migrations: Array<{ name: string; version: string }>): string {
    const values = migrations
        .map(({ name, version }) => `(${version}, ${sqlString(name)}, ARRAY[${sqlString(`baseline:${name}`)}]::text[])`)
        .join(",\n    ");

    return `
CREATE SCHEMA IF NOT EXISTS supabase_migrations;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version BIGINT PRIMARY KEY,
  statements TEXT[],
  name TEXT
);

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  statements TEXT[],
  name TEXT
);

WITH baseline(version, name, statements) AS (
  VALUES
    ${values}
)
INSERT INTO supabase_migrations.schema_migrations (version, statements, name)
SELECT version, statements, name FROM baseline
ON CONFLICT (version) DO UPDATE
SET statements = EXCLUDED.statements,
    name = EXCLUDED.name;

WITH baseline(version, name, statements) AS (
  VALUES
    ${values}
)
INSERT INTO public.schema_migrations (version, statements, name)
SELECT version::text, statements, name FROM baseline
ON CONFLICT (version) DO UPDATE
SET statements = EXCLUDED.statements,
    name = EXCLUDED.name;
`.trim();
}

// ── Format Helpers ──
function formatSqlResult(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const r = data as { rows?: unknown[]; rowCount?: number };
    if (r.rows?.length) return `✅ ${r.rowCount || r.rows.length} row(s):\n\n${JSON.stringify(r.rows, null, 2)}`;
    if (r.rows && r.rows.length === 0) return "✅ Query OK. No rows returned.";
    return JSON.stringify(data, null, 2);
}

function formatTableList(data: unknown, schemas: string[]): string {
    const rows = (data as any)?.rows || [];
    if (!rows.length) return `No tables in: ${schemas.join(", ")}`;
    const grouped: Record<string, string[]> = {};
    for (const r of rows) { (grouped[r.schema] ??= []).push(r.table); }
    let out = "📋 Tables:\n\n";
    for (const [s, ts] of Object.entries(grouped)) { out += `Schema: ${s}\n${ts.map(t => `  - ${t}`).join("\n")}\n\n`; }
    return out;
}

function formatColumnsList(data: unknown, schema: string, table: string): string {
    const rows = (data as any)?.rows || [];
    if (!rows.length) return `No columns for ${schema}.${table}`;
    let out = `📋 Columns for ${schema}.${table}:\n\n`;
    for (const c of rows) {
        const type = c.character_maximum_length ? `${c.data_type}(${c.character_maximum_length})` : c.data_type;
        out += `  - ${c.column_name}: ${type} ${c.is_nullable === "YES" ? "NULL" : "NOT NULL"}${c.column_default ? ` DEFAULT ${c.column_default}` : ""}\n`;
    }
    return out;
}

function formatIndexList(data: unknown): string {
    const rows = (data as any)?.rows || [];
    if (!rows.length) return "No indexes.";
    return "📇 Indexes:\n\n" + rows.map((i: any) => `  - ${i.indexname}\n    ${i.indexdef}\n`).join("\n");
}

function formatConstraintList(data: unknown): string {
    const rows = (data as any)?.rows || [];
    if (!rows.length) return "No constraints.";
    const types: Record<string, string> = { p: "PK", f: "FK", u: "UNIQUE", c: "CHECK" };
    return "🔗 Constraints:\n\n" + rows.map((c: any) => `  - ${c.name} (${types[c.type] || c.type})\n    ${c.definition}\n`).join("\n");
}

function formatExtensionList(data: unknown): string {
    const rows = (data as any)?.rows || [];
    if (!rows.length) return "No extensions.";
    return "🔌 Extensions:\n\n" + rows.map((e: any) => `  - ${e.name} v${e.version} (${e.schema})`).join("\n");
}

function formatRlsStatus(data: unknown): string {
    const rows = (data as any)?.rows || [];
    if (!rows.length) return "No tables.";
    return "🔒 RLS Status:\n\n" + rows.map((t: any) => `  - ${t.tablename}: ${t.rls_enabled ? "✅ ON" : "❌ OFF"}`).join("\n");
}

function formatRlsPolicies(data: unknown, schema: string, table: string): string {
    const rows = (data as any)?.rows || [];
    if (!rows.length) return `No RLS policies on ${schema}.${table}.`;
    let out = `🛡️ RLS Policies on ${schema}.${table}:\n\n`;
    for (const p of rows) {
        out += `  - ${p.policyname} (${p.cmd}, ${p.permissive})\n    Roles: ${p.roles?.join(", ") || "PUBLIC"}\n`;
        if (p.qual) out += `    USING: ${p.qual}\n`;
        if (p.with_check) out += `    WITH CHECK: ${p.with_check}\n`;
        out += "\n";
    }
    return out;
}

function formatAuthUsers(data: unknown): string {
    const rows = (data as any)?.rows || [];
    if (!rows.length) return "No users.";
    let out = "👥 Auth Users:\n\n";
    for (const u of rows) {
        out += `  ${u.email_confirmed_at ? "✅" : "⏳"} ${u.email} (${u.role})\n      ID: ${u.id}\n      Created: ${u.created_at}\n`;
        if (u.last_sign_in_at) out += `      Last login: ${u.last_sign_in_at}\n`;
        out += "\n";
    }
    return out;
}

function formatSingleUser(data: unknown): string {
    const user = (data as any)?.rows?.[0];
    if (!user) return "User not found.";
    let out = `👤 ${user.email}\n  ID: ${user.id}\n  Role: ${user.role}\n  Phone: ${user.phone || "N/A"}\n`;
    out += `  Confirmed: ${user.email_confirmed_at || "Pending"}\n  Created: ${user.created_at}\n`;
    out += `  Last login: ${user.last_sign_in_at || "Never"}\n  SSO: ${user.is_sso_user ? "Yes" : "No"}\n`;
    if (user.raw_user_meta_data) out += `  Meta: ${JSON.stringify(user.raw_user_meta_data, null, 2)}\n`;
    return out;
}

function formatConnections(data: unknown): string {
    const rows = (data as any)?.rows || [];
    if (!rows.length) return "No active connections.";
    let out = `🔗 Connections (${rows.length}):\n\n`;
    for (const c of rows) {
        out += `  [${c.pid}] ${c.usename}@${c.client_addr} | ${c.state}\n`;
        if (c.query && c.state === "active") out += `      ${c.query.substring(0, 100)}${c.query.length > 100 ? "..." : ""}\n`;
    }
    return out;
}

function formatDbStats(data: unknown): string {
    const rows = (data as any)?.rows || [];
    if (!rows.length) return "No stats.";
    let out = "📊 Stats:\n\n  Table                          | Rows      | Total      | Table      | Index\n  -------------------------------|-----------|------------|------------|----------\n";
    for (const t of rows) {
        out += `  ${`${t.schemaname}.${t.table_name}`.padEnd(30)} | ${String(t.row_count || 0).padStart(9)} | ${t.total_size.padStart(10)} | ${t.table_size.padStart(10)} | ${t.index_size.padStart(10)}\n`;
    }
    return out;
}

function formatMigrations(data: unknown): string {
    const rows = (data as any)?.rows || [];
    if (!rows.length) return "No migrations.";
    return "📝 Migrations:\n\n" + rows.map((m: any) => `  - ${m.version} (${m.applied_at})`).join("\n");
}

function generateTypeScriptTypes(data: unknown, schemas: string[]): string {
    const rows = (data as any)?.rows || [];
    const tables: Record<string, Record<string, { type: string; nullable: boolean }>> = {};
    for (const c of rows) {
        const key = `${c.table_schema}.${c.table_name}`;
        (tables[key] ??= {})[c.column_name] = { type: pgToTs(c.data_type), nullable: c.is_nullable === "YES" };
    }
    let out = `// Types from ${schemas.join(", ")}\n\n`;
    for (const [key, cols] of Object.entries(tables)) {
        const name = key.split(".")[1].split(/[-_]+/).map((w: string) => w[0].toUpperCase() + w.slice(1)).join("");
        out += `export interface ${name} {\n`;
        for (const [col, info] of Object.entries(cols)) out += `  ${col}: ${info.type}${info.nullable ? " | null" : ""};\n`;
        out += "}\n\n";
    }
    return out;
}

function pgToTs(t: string): string {
    const m: Record<string, string> = {
        integer: "number", bigint: "number", smallint: "number", numeric: "number", real: "number",
        "double precision": "number", boolean: "boolean", text: "string", "character varying": "string",
        uuid: "string", date: "string", "timestamp with time zone": "string", timestamptz: "string",
        json: "unknown", jsonb: "unknown",
    };
    return m[t.toLowerCase()] || "unknown";
}
