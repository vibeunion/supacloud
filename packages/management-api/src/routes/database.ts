import { Elysia, t } from "elysia";
import { projectService } from "../services";
import { db } from "../db";

export const databaseRoutes = new Elysia({ prefix: "/v1/projects/:ref/database" })
    .get(
        "/tables",
        async ({ params, query, set }) => {
            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { error: "Project not found" };
            }

            try {
                const dbName = `supa_${params.ref}`;
                const limit = Number(query._limit || query.limit || 50);
                const page = Number(query._page || 1);
                const skip = Number(query.skip || (page - 1) * limit);
                const search = query.q ? String(query.q) : (query.query ? String(query.query) : "");
                
                let whereClause = "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'";
                if (search) {
                    // Quick safe sanitization for table names
                    const safeSearch = search.replace(/'/g, "''");
                    whereClause += ` AND table_name ILIKE '%${safeSearch}%'`;
                }

                const sql = `
                    SELECT table_name, table_schema, table_type,
                    (SELECT reltuples::bigint FROM pg_class WHERE oid = ('"'||table_schema||'"."'||table_name||'"')::regclass) as row_estimate
                    FROM information_schema.tables
                    ${whereClause}
                    ORDER BY table_name;
                `;

                const result = await db.executeQuery(dbName, sql);
                const allTables = ((result as unknown as { rows: Record<string, unknown>[] }).rows) || [];

                return {
                    data: allTables.slice(skip, skip + limit),
                    total: allTables.length
                };
            } catch (error: unknown) {
                set.status = 500;
                return {
                    error: "Failed to list tables",
                    message: error instanceof Error ? error.message : "Unknown error",
                };
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
            }),
            query: t.Object({
                skip: t.Optional(t.String()),
                limit: t.Optional(t.String()),
                _page: t.Optional(t.String()),
                _limit: t.Optional(t.String()),
                _sort: t.Optional(t.String()),
                _order: t.Optional(t.String()),
                query: t.Optional(t.String()),
                q: t.Optional(t.String()),
            }, { additionalProperties: true })
        }
    )
    .get(
        "/tables/:schema/:table/columns",
        async ({ params, set }) => {
            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { error: "Project not found" };
            }

            try {
                const dbName = `supa_${params.ref}`;
                // Quick and safe parameterized query logic for schema inspection
                // Use ::regclass format if possible, or just exact string match 
                const schema = params.schema.replace(/'/g, "''");
                const table = params.table.replace(/'/g, "''");

                const sql = `
                    SELECT column_name, data_type, is_nullable, column_default 
                    FROM information_schema.columns 
                    WHERE table_schema = '${schema}' AND table_name = '${table}'
                    ORDER BY ordinal_position;
                `;

                const result = await db.executeQuery(dbName, sql);
                return {
                    data: ((result as unknown as { rows: Record<string, unknown>[] }).rows) || []
                };
            } catch (error: unknown) {
                set.status = 500;
                return {
                    error: "Failed to list columns",
                    message: error instanceof Error ? error.message : "Unknown error",
                };
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
                schema: t.String({ minLength: 1 }),
                table: t.String({ minLength: 1 }),
            })
        }
    )
    .get(
        "/tables/:schema/:table/rows",
        async ({ params, query, set }) => {
            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { error: "Project not found" };
            }

            try {
                const dbName = `supa_${params.ref}`;
                const limit = Number(query._limit || query.limit || 50);
                const page = Number(query._page || 1);
                const skip = Number(query.skip || (page - 1) * limit);

                // Sanitize schema and table to avoid injection
                const regex = /^[a-zA-Z_0-9]+$/;
                if (!regex.test(params.schema) || !regex.test(params.table)) {
                     set.status = 400;
                     return { error: "Invalid schema or table name format" };
                }

                const sql = `SELECT * FROM "${params.schema}"."${params.table}" LIMIT ${limit} OFFSET ${skip};`;
                const countSql = `SELECT count(*) as count FROM "${params.schema}"."${params.table}";`;

                const [resRows, resCount] = await Promise.all([
                    db.executeQuery(dbName, sql),
                    db.executeQuery(dbName, countSql)
                ]);

                return {
                    data: ((resRows as unknown as { rows: Record<string, unknown>[] }).rows) || [],
                    total: parseInt(((resCount as unknown as { rows: { count: string }[] }).rows)[0]?.count || "0")
                };
            } catch (error: unknown) {
                set.status = 500;
                return {
                    error: "Failed to fetch rows",
                    message: error instanceof Error ? error.message : "Unknown error",
                };
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
                schema: t.String({ minLength: 1 }),
                table: t.String({ minLength: 1 }),
            }),
            query: t.Object({
                skip: t.Optional(t.String()),
                limit: t.Optional(t.String()),
                _page: t.Optional(t.String()),
                _limit: t.Optional(t.String()),
                _sort: t.Optional(t.String()),
                _order: t.Optional(t.String()),
                q: t.Optional(t.String()),
            }, { additionalProperties: true })
        }
    )
    .post(
        "/sql",
        async ({ params, body, set }) => {
            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { error: "Project not found" };
            }

            const { sql } = body;

            try {
                const dbName = `supa_${params.ref}`;
                const result = await db.executeQuery(dbName, sql);
                return result;
            } catch (error: unknown) {
                set.status = 500;
                return {
                    error: "SQL execution failed",
                    message: error instanceof Error ? error.message : "Unknown error",
                };
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
            }),
            body: t.Object({
                sql: t.String({ minLength: 1 }),
            }),
        }
    )

    .post(
        "/migrations",
        async ({ params, body, set }) => {
            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { error: "Project not found" };
            }

            const dbName = `supa_${params.ref}`;

            try {
                const migrationTableExists = await db.executeQuery(
                    dbName,
                    `SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = 'public' 
                        AND table_name = 'schema_migrations'
                    );`
                );

                const tableExists = (migrationTableExists as { rows?: Array<{ exists: boolean }> }).rows?.[0]?.exists ?? false;

                if (!tableExists) {
                    await db.executeQuery(dbName, `
                        CREATE TABLE IF NOT EXISTS schema_migrations (
                            version VARCHAR(255) PRIMARY KEY,
                            statements TEXT[],
                            name TEXT
                        );
                    `);
                }

                // CLI `supabase db push` sends { query } — treat as raw SQL migration
                // Studio / custom sends { name, sql } — structured migration
                const isCliFormat = 'query' in body && typeof (body as Record<string, unknown>).query === 'string';
                const isStructuredFormat = 'name' in body && 'sql' in body;

                if (isCliFormat) {
                    const query = (body as Record<string, unknown>).query as string;
                    const now = new Date();
                    const ts = now.getFullYear().toString() +
                        String(now.getMonth() + 1).padStart(2, '0') +
                        String(now.getDate()).padStart(2, '0') +
                        String(now.getHours()).padStart(2, '0') +
                        String(now.getMinutes()).padStart(2, '0') +
                        String(now.getSeconds()).padStart(2, '0');
                    const version = ts;

                    const existing = await db.executeQuery(
                        dbName,
                        `SELECT version FROM schema_migrations WHERE version = '${version}'`
                    );
                    if ((existing as { rows?: unknown[] }).rows?.length) {
                        set.status = 409;
                        return { error: "Migration already applied", version };
                    }

                    await db.executeQuery(dbName, query);
                    await db.executeQuery(dbName, `INSERT INTO schema_migrations (version, statements, name) VALUES ('${version}', ARRAY['${query.replace(/'/g, "''")}'], 'cli_push');`);

                    return { version, statements: [query] };
                }

                if (isStructuredFormat) {
                    const { name, sql } = body as { name: string; sql: string };

                    const now = new Date();
                    const ts = now.getFullYear().toString() +
                        String(now.getMonth() + 1).padStart(2, '0') +
                        String(now.getDate()).padStart(2, '0') +
                        String(now.getHours()).padStart(2, '0') +
                        String(now.getMinutes()).padStart(2, '0') +
                        String(now.getSeconds()).padStart(2, '0');
                    const version = `${ts}_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;

                    const existingMigration = await db.executeQuery(
                        dbName,
                        `SELECT version FROM schema_migrations WHERE version LIKE '%${name.replace(/[^a-zA-Z0-9_]/g, "_")}%'`
                    );

                    if ((existingMigration as { rows?: unknown[] }).rows?.length) {
                        set.status = 409;
                        return { error: "Migration already applied", name };
                    }

                    await db.executeQuery(dbName, sql);
                    await db.executeQuery(dbName, `INSERT INTO schema_migrations (version, statements, name) VALUES ('${version}', ARRAY['${sql.replace(/'/g, "''")}'], '${name.replace(/'/g, "''")}');`);

                    return { version, name };
                }

                set.status = 400;
                return { error: "Body must contain {query} or {name, sql}" };
            } catch (error: unknown) {
                set.status = 500;
                return {
                    error: "Migration failed",
                    message: error instanceof Error ? error.message : "Unknown error",
                };
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
            }),
            body: t.Record(t.String(), t.Unknown()),
        }
    )

    .get(
        "/migrations",
        async ({ params, set }) => {
            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { error: "Project not found" };
            }

            try {
                const dbName = `supa_${params.ref}`;
                const result = await db.executeQuery(
                    dbName,
                    `SELECT version, statements, name FROM schema_migrations ORDER BY version ASC;`
                );
                const rows = (result as { rows?: Array<Record<string, unknown>> }).rows || [];
                return rows.map((row) => ({
                    version: row.version,
                    statements: row.statements || [],
                    name: row.name || null,
                }));
            } catch (error: unknown) {
                return [];
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
            }),
        }
    );
