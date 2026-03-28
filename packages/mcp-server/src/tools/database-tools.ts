/**
 * Database Tools - SQL execution, table management, migrations
 * Supports multi-tenant project access via Management API
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpTransport } from "../transports/http";

export interface DatabaseToolsConfig {
    readOnly?: boolean;
    projectRef?: string;
}

export function registerDatabaseTools(
    server: McpServer,
    http: HttpTransport,
    config: DatabaseToolsConfig = {}
): void {
    const { readOnly = false, projectRef } = config;

    // ═══════════════════════════════════════
    // SQL Execution
    // ═══════════════════════════════════════

    server.tool(
        "execute_sql",
        readOnly
            ? "Execute read-only SQL query on project database (SELECT only)"
            : "Execute SQL query on project database",
        {
            ref: projectRef
                ? z.never().optional().describe("Project ref (pre-configured)")
                : z.string().describe("Project ref"),
            sql: z.string().describe("SQL query to execute"),
        },
        async (args) => {
            const ref = projectRef || args.ref;
            const sql = args.sql;

            if (readOnly) {
                const sqlUpper = sql.trim().toUpperCase();
                const forbiddenKeywords = [
                    "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER",
                    "TRUNCATE", "GRANT", "REVOKE", "COPY"
                ];
                for (const keyword of forbiddenKeywords) {
                    if (sqlUpper.includes(keyword)) {
                        return {
                            content: [{
                                type: "text",
                                text: `❌ Write operation blocked in read-only mode. Detected: ${keyword}`,
                            }],
                        };
                    }
                }
            }

            const res = await http.post(`/v1/projects/${ref}/database/sql`, { sql });
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? formatSqlResult(res.data)
                        : `❌ Query failed (${res.status}): ${JSON.stringify(res.data)}`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    // Schema Introspection
    // ═══════════════════════════════════════

    server.tool(
        "list_tables",
        "List all tables in project database schemas",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
            schemas: z.array(z.string()).default(["public"]).describe("Schemas to list tables from"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;
            const schemas = (args as { schemas?: string[] }).schemas || ["public"];

            const sql = `
                SELECT schemaname as schema, tablename as table, tableowner as owner
                FROM pg_tables WHERE schemaname = ANY($1)
                ORDER BY schemaname, tablename;
            `;

            const res = await http.post(`/v1/projects/${ref}/database/sql`, {
                sql: sql.replace("$1", `ARRAY[${schemas.map(s => `'${s}'`).join(",")}]`)
            });

            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatTableList(res.data, schemas) : `❌ Failed to list tables (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "list_table_columns",
        "List columns for a specific table",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
            schema: z.string().default("public").describe("Schema name"),
            table: z.string().describe("Table name"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;
            const { schema, table } = args as { schema: string; table: string };

            const sql = `
                SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
                FROM information_schema.columns
                WHERE table_schema = '${schema}' AND table_name = '${table}'
                ORDER BY ordinal_position;
            `;

            const res = await http.post(`/v1/projects/${ref}/database/sql`, { sql });
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatColumnsList(res.data, schema, table) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "list_indexes",
        "List indexes for a specific table",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
            schema: z.string().default("public").describe("Schema name"),
            table: z.string().describe("Table name"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;
            const { schema, table } = args as { schema: string; table: string };

            const sql = `
                SELECT indexname, indexdef
                FROM pg_indexes WHERE schemaname = '${schema}' AND tablename = '${table}';
            `;

            const res = await http.post(`/v1/projects/${ref}/database/sql`, { sql });
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatIndexList(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "list_constraints",
        "List constraints for a specific table",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
            schema: z.string().default("public").describe("Schema name"),
            table: z.string().describe("Table name"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;
            const { schema, table } = args as { schema: string; table: string };

            const sql = `
                SELECT conname as name, contype as type, pg_get_constraintdef(oid) as definition
                FROM pg_constraint WHERE connamespace = '${schema}'::regnamespace AND conrelid = '${schema}.${table}'::regclass;
            `;

            const res = await http.post(`/v1/projects/${ref}/database/sql`, { sql });
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatConstraintList(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "list_extensions",
        "List all PostgreSQL extensions in project database",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;

            const sql = `
                SELECT extname as name, extversion as version, n.nspname as schema
                FROM pg_extension e JOIN pg_namespace n ON e.extnamespace = n.oid
                ORDER BY extname;
            `;

            const res = await http.post(`/v1/projects/${ref}/database/sql`, { sql });
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatExtensionList(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    // RLS (Row Level Security)
    // ═══════════════════════════════════════

    server.tool(
        "get_rls_status",
        "Check RLS enabled/disabled status for tables",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
            schema: z.string().default("public").describe("Schema name"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;
            const { schema } = args as { schema: string };

            const sql = `
                SELECT tablename, rowsecurity as rls_enabled
                FROM pg_tables WHERE schemaname = '${schema}'
                ORDER BY tablename;
            `;

            const res = await http.post(`/v1/projects/${ref}/database/sql`, { sql });
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatRlsStatus(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "list_rls_policies",
        "List Row-Level Security policies for a table",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
            schema: z.string().default("public").describe("Schema name"),
            table: z.string().describe("Table name"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;
            const { schema, table } = args as { schema: string; table: string };

            const sql = `
                SELECT policyname, cmd, permissive, roles, qual, with_check
                FROM pg_policies WHERE schemaname = '${schema}' AND tablename = '${table}';
            `;

            const res = await http.post(`/v1/projects/${ref}/database/sql`, { sql });
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatRlsPolicies(res.data, schema, table) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    // Auth Users
    // ═══════════════════════════════════════

    server.tool(
        "list_auth_users",
        "List users from auth.users table",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
            limit: z.number().default(20).describe("Max users to return"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;
            const { limit } = args as { limit: number };

            const sql = `
                SELECT id, email, role, email_confirmed_at, created_at, last_sign_in_at, is_sso_user
                FROM auth.users ORDER BY created_at DESC LIMIT ${limit};
            `;

            const res = await http.post(`/v1/projects/${ref}/database/sql`, { sql });
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatAuthUsers(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "get_auth_user",
        "Get details for a specific auth user",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
            userId: z.string().describe("User ID (UUID)"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;
            const { userId } = args as { userId: string };

            const sql = `
                SELECT id, email, role, email_confirmed_at, created_at, last_sign_in_at,
                       raw_user_meta_data, is_sso_user, phone
                FROM auth.users WHERE id = '${userId}';
            `;

            const res = await http.post(`/v1/projects/${ref}/database/sql`, { sql });
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatSingleUser(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    // Database Stats
    // ═══════════════════════════════════════

    server.tool(
        "get_database_connections",
        "Show active database connections",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;

            const sql = `
                SELECT pid, usename, application_name, client_addr, state, query_start, query
                FROM pg_stat_activity WHERE datname = current_database()
                ORDER BY query_start DESC LIMIT 50;
            `;

            const res = await http.post(`/v1/projects/${ref}/database/sql`, { sql });
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatConnections(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "get_database_stats",
        "Get database statistics (table sizes, row counts)",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;

            const sql = `
                SELECT
                    schemaname, relname as table_name,
                    n_live_tup as row_count,
                    pg_size_pretty(pg_total_relation_size(schemaname || '.' || relname)) as total_size,
                    pg_size_pretty(pg_relation_size(schemaname || '.' || relname)) as table_size,
                    pg_size_pretty(pg_total_relation_size(schemaname || '.' || relname) - pg_relation_size(schemaname || '.' || relname)) as index_size
                FROM pg_stat_user_tables
                ORDER BY pg_total_relation_size(schemaname || '.' || relname) DESC
                LIMIT 30;
            `;

            const res = await http.post(`/v1/projects/${ref}/database/sql`, { sql });
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatDbStats(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    // Migrations (write operations)
    // ═══════════════════════════════════════

    if (!readOnly) {
        server.tool(
            "create_table_with_rls",
            "Create a secure table by automatically enabling Row Level Security (RLS) and adding a default permissive policy for authenticated users. Always prefer this over raw CREATE TABLE.",
            {
                ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
                schema: z.string().default("public").describe("Schema name (default: public)"),
                table: z.string().describe("Table name (e.g. 'posts')"),
                columns: z.string().describe("Column definitions (e.g. 'id uuid primary key default uuid_generate_v4(), title text not null')"),
            },
            async (args) => {
                const ref = projectRef || (args as { ref?: string }).ref;
                const { schema, table, columns } = args as { schema: string; table: string; columns: string };

                const sql = `
                    BEGIN;
                    CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (
                        ${columns}
                    );
                    ALTER TABLE "${schema}"."${table}" ENABLE ROW LEVEL SECURITY;
                    CREATE POLICY "Enable ALL for authenticated users only" ON "${schema}"."${table}" 
                        FOR ALL TO authenticated USING (true) WITH CHECK (true);
                    COMMIT;
                `;

                const res = await http.post(`/v1/projects/${ref}/database/sql`, { sql });
                return {
                    content: [{
                        type: "text",
                        text: res.ok
                            ? `✅ Secure table '${schema}.${table}' created successfully with RLS enabled.`
                            : `❌ Failed to create table (${res.status}): ${JSON.stringify(res.data)}`,
                    }],
                };
            }
        );

        server.tool(
            "apply_migration",
            "Apply a SQL migration to project database (DDL operations)",
            {
                ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
                name: z.string().describe("Migration name (e.g., 'create_users_table')"),
                sql: z.string().describe("Migration SQL (DDL statements)"),
            },
            async (args) => {
                const ref = projectRef || (args as { ref?: string }).ref;
                const { name, sql } = args as { name: string; sql: string };

                const res = await http.post(`/v1/projects/${ref}/database/migrations`, { name, sql });

                return {
                    content: [{
                        type: "text",
                        text: res.ok
                            ? `✅ Migration '${name}' applied successfully`
                            : `❌ Migration failed (${res.status}): ${JSON.stringify(res.data)}`,
                    }],
                };
            }
        );
    }

    server.tool(
        "list_migrations",
        "List applied database migrations",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;
            const res = await http.get(`/v1/projects/${ref}/database/migrations`);
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatMigrations(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    // Development Tools
    // ═══════════════════════════════════════

    server.tool(
        "get_project_url",
        "Get the API URL for a project",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;
            const res = await http.get(`/v1/projects/${ref}`);
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? JSON.stringify({ url: (res.data as { api?: { url?: string } }).api?.url || `https://${ref}.supabase.co` }, null, 2)
                        : `❌ Failed to get project (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "generate_typescript_types",
        "Generate TypeScript types from database schema",
        {
            ref: projectRef ? z.never().optional() : z.string().describe("Project ref"),
            schemas: z.array(z.string()).default(["public"]).describe("Schemas to generate types for"),
        },
        async (args) => {
            const ref = projectRef || (args as { ref?: string }).ref;
            const schemas = (args as { schemas?: string[] }).schemas || ["public"];

            const sql = `
                SELECT t.table_schema, t.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
                FROM information_schema.tables t
                JOIN information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema
                WHERE t.table_schema = ANY($1) AND t.table_type = 'BASE TABLE'
                ORDER BY t.table_schema, t.table_name, c.ordinal_position;
            `;

            const res = await http.post(`/v1/projects/${ref}/database/sql`, {
                sql: sql.replace("$1", `ARRAY[${schemas.map(s => `'${s}'`).join(",")}]`)
            });

            return {
                content: [{
                    type: "text",
                    text: res.ok ? generateTypeScriptTypes(res.data, schemas) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );
}

// ── Helper Functions ──

function formatSqlResult(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: unknown[]; rowCount?: number };
    if (result.rows && Array.isArray(result.rows)) {
        if (result.rows.length === 0) return "✅ Query executed successfully. No rows returned.";
        return `✅ Query executed successfully. ${result.rowCount || result.rows.length} row(s) returned:\n\n${JSON.stringify(result.rows, null, 2)}`;
    }
    return JSON.stringify(data, null, 2);
}

function formatTableList(data: unknown, schemas: string[]): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: Array<{ schema: string; table: string; owner: string }> };
    const rows = result.rows || [];
    if (rows.length === 0) return `No tables found in schemas: ${schemas.join(", ")}`;
    const grouped: Record<string, Array<{ table: string; owner: string }>> = {};
    for (const row of rows) {
        if (!grouped[row.schema]) grouped[row.schema] = [];
        grouped[row.schema].push({ table: row.table, owner: row.owner });
    }
    let output = "📋 Tables in database:\n\n";
    for (const [schema, tables] of Object.entries(grouped)) {
        output += `Schema: ${schema}\n`;
        for (const t of tables) output += `  - ${t.table} (owner: ${t.owner})\n`;
        output += "\n";
    }
    return output;
}

function formatColumnsList(data: unknown, schema: string, table: string): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null; character_maximum_length: number | null }> };
    const rows = result.rows || [];
    if (rows.length === 0) return `No columns found for ${schema}.${table}`;
    let output = `📋 Columns for ${schema}.${table}:\n\n`;
    for (const col of rows) {
        const type = col.character_maximum_length ? `${col.data_type}(${col.character_maximum_length})` : col.data_type;
        const nullable = col.is_nullable === "YES" ? "NULL" : "NOT NULL";
        const def = col.column_default ? ` DEFAULT ${col.column_default}` : "";
        output += `  - ${col.column_name}: ${type} ${nullable}${def}\n`;
    }
    return output;
}

function formatIndexList(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: Array<{ indexname: string; indexdef: string }> };
    const rows = result.rows || [];
    if (rows.length === 0) return "No indexes found.";
    let output = "📇 Indexes:\n\n";
    for (const idx of rows) {
        output += `  - ${idx.indexname}\n    ${idx.indexdef}\n\n`;
    }
    return output;
}

function formatConstraintList(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: Array<{ name: string; type: string; definition: string }> };
    const rows = result.rows || [];
    if (rows.length === 0) return "No constraints found.";
    const typeMap: Record<string, string> = { p: "PRIMARY KEY", f: "FOREIGN KEY", u: "UNIQUE", c: "CHECK" };
    let output = "🔗 Constraints:\n\n";
    for (const c of rows) {
        output += `  - ${c.name} (${typeMap[c.type] || c.type})\n    ${c.definition}\n\n`;
    }
    return output;
}

function formatExtensionList(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: Array<{ name: string; version: string; schema: string }> };
    const rows = result.rows || [];
    if (rows.length === 0) return "No extensions installed.";
    let output = "🔌 PostgreSQL Extensions:\n\n";
    for (const ext of rows) output += `  - ${ext.name} (v${ext.version}, schema: ${ext.schema})\n`;
    return output;
}

function formatRlsStatus(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: Array<{ tablename: string; rls_enabled: boolean }> };
    const rows = result.rows || [];
    if (rows.length === 0) return "No tables found.";
    let output = "🔒 RLS Status:\n\n";
    for (const t of rows) {
        const status = t.rls_enabled ? "✅ ENABLED" : "❌ DISABLED";
        output += `  - ${t.tablename}: ${status}\n`;
    }
    return output;
}

function formatRlsPolicies(data: unknown, schema: string, table: string): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: Array<{ policyname: string; cmd: string; permissive: string; roles: string[]; qual: string | null; with_check: string | null }> };
    const rows = result.rows || [];
    if (rows.length === 0) return `No RLS policies on ${schema}.${table}.`;
    let output = `🛡️ RLS Policies on ${schema}.${table}:\n\n`;
    for (const p of rows) {
        output += `  - ${p.policyname} (${p.cmd}, ${p.permissive})\n`;
        output += `    Roles: ${p.roles?.join(", ") || "PUBLIC"}\n`;
        if (p.qual) output += `    USING: ${p.qual}\n`;
        if (p.with_check) output += `    WITH CHECK: ${p.with_check}\n`;
        output += "\n";
    }
    return output;
}

function formatAuthUsers(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: Array<{ id: string; email: string; role: string; email_confirmed_at: string | null; created_at: string; last_sign_in_at: string | null; is_sso_user: boolean }> };
    const rows = result.rows || [];
    if (rows.length === 0) return "No auth users found.";
    let output = "👥 Auth Users:\n\n";
    for (const u of rows) {
        const confirmed = u.email_confirmed_at ? "✅" : "⏳";
        output += `  ${confirmed} ${u.email} (${u.role})\n`;
        output += `      ID: ${u.id}\n`;
        output += `      Created: ${u.created_at}\n`;
        if (u.last_sign_in_at) output += `      Last sign in: ${u.last_sign_in_at}\n`;
        output += "\n";
    }
    return output;
}

function formatSingleUser(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: Array<{ id: string; email: string; role: string; email_confirmed_at: string | null; created_at: string; last_sign_in_at: string | null; raw_user_meta_data: unknown; is_sso_user: boolean; phone: string | null }> };
    const user = result.rows?.[0];
    if (!user) return "User not found.";
    let output = `👤 User: ${user.email}\n\n`;
    output += `  ID: ${user.id}\n`;
    output += `  Role: ${user.role}\n`;
    output += `  Phone: ${user.phone || "N/A"}\n`;
    output += `  Email Confirmed: ${user.email_confirmed_at || "Pending"}\n`;
    output += `  Created: ${user.created_at}\n`;
    output += `  Last Sign In: ${user.last_sign_in_at || "Never"}\n`;
    output += `  SSO User: ${user.is_sso_user ? "Yes" : "No"}\n`;
    if (user.raw_user_meta_data) output += `  Metadata: ${JSON.stringify(user.raw_user_meta_data, null, 2)}\n`;
    return output;
}

function formatConnections(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: Array<{ pid: number; usename: string; application_name: string; client_addr: string; state: string; query_start: string; query: string }> };
    const rows = result.rows || [];
    if (rows.length === 0) return "No active connections.";
    let output = `🔗 Active Connections (${rows.length}):\n\n`;
    for (const c of rows) {
        output += `  [${c.pid}] ${c.usename}@${c.client_addr}\n`;
        output += `      App: ${c.application_name || "N/A"} | State: ${c.state}\n`;
        if (c.query && c.state === "active") output += `      Query: ${c.query.substring(0, 100)}${c.query.length > 100 ? "..." : ""}\n`;
        output += "\n";
    }
    return output;
}

function formatDbStats(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: Array<{ schemaname: string; table_name: string; row_count: number; total_size: string; table_size: string; index_size: string }> };
    const rows = result.rows || [];
    if (rows.length === 0) return "No table statistics available.";
    let output = "📊 Database Statistics:\n\n";
    output += "  Table                          | Rows      | Total Size | Table Size | Index Size\n";
    output += "  -------------------------------|-----------|------------|------------|------------\n";
    for (const t of rows) {
        const name = `${t.schemaname}.${t.table_name}`.substring(0, 30).padEnd(30);
        const rows_str = String(t.row_count || 0).padStart(9);
        output += `  ${name} | ${rows_str} | ${t.total_size.padStart(10)} | ${t.table_size.padStart(10)} | ${t.index_size.padStart(10)}\n`;
    }
    return output;
}

function formatMigrations(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { rows?: Array<{ version: string; applied_at: string }> };
    const rows = result.rows || [];
    if (rows.length === 0) return "No migrations applied.";
    let output = "📝 Applied Migrations:\n\n";
    for (const m of rows) {
        output += `  - ${m.version}\n    Applied: ${m.applied_at}\n`;
    }
    return output;
}

function generateTypeScriptTypes(data: unknown, schemas: string[]): string {
    if (!data || typeof data !== "object") return "// Failed to generate types";
    const result = data as { rows?: Array<{ table_schema: string; table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }> };
    const rows = result.rows || [];
    const tables: Record<string, Record<string, { type: string; nullable: boolean }>> = {};
    for (const col of rows) {
        const tableKey = `${col.table_schema}.${col.table_name}`;
        if (!tables[tableKey]) tables[tableKey] = {};
        tables[tableKey][col.column_name] = { type: mapPostgresTypeToTs(col.data_type), nullable: col.is_nullable === "YES" };
    }
    let output = `// Auto-generated TypeScript types\n// Schemas: ${schemas.join(", ")}\n\n`;
    for (const [tableKey, columns] of Object.entries(tables)) {
        const tableName = tableKey.split(".")[1];
        const interfaceName = toPascalCase(tableName);
        output += `// ${tableKey}\nexport interface ${interfaceName} {\n`;
        for (const [colName, colInfo] of Object.entries(columns)) {
            const tsType = colInfo.nullable ? `${colInfo.type} | null` : colInfo.type;
            output += `  ${colName}: ${tsType};\n`;
        }
        output += `}\n\n`;
    }
    output += `export interface Database {\n`;
    for (const tableKey of Object.keys(tables)) {
        const tableName = tableKey.split(".")[1];
        output += `  ${tableName}: ${toPascalCase(tableName)};\n`;
    }
    output += `}\n`;
    return output;
}

function mapPostgresTypeToTs(pgType: string): string {
    const typeMap: Record<string, string> = {
        "integer": "number", "bigint": "number", "smallint": "number", "decimal": "number",
        "numeric": "number", "real": "number", "double precision": "number", "boolean": "boolean",
        "text": "string", "character varying": "string", "varchar": "string", "char": "string",
        "uuid": "string", "date": "string", "timestamp": "string", "timestamp with time zone": "string",
        "timestamptz": "string", "time": "string", "json": "unknown", "jsonb": "unknown",
        "bytea": "Uint8Array", "inet": "string", "cidr": "string", "macaddr": "string",
    };
    const lowerType = pgType.toLowerCase();
    if (typeMap[lowerType]) return typeMap[lowerType];
    if (lowerType.includes("[]")) return "unknown[]";
    return "unknown";
}

function toPascalCase(str: string): string {
    return str.split(/[-_\s]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
}
