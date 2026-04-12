import { Elysia, t } from "elysia";
import { projectService } from "../services";
import { db, resolveDbName, getProjectDb } from "../db";

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
                const dbName = await resolveDbName(params.ref);
                const limit = Number(query._limit || query.limit || 50);
                const page = Number(query._page || 1);
                const skip = Number(query.skip || (page - 1) * limit);
                const search = query.q ? String(query.q) : (query.query ? String(query.query) : "");

                const projectDb = getProjectDb(dbName);
                let rows: any[];
                if (search) {
                    rows = await projectDb`
                        SELECT table_name, table_schema, table_type,
                        (SELECT reltuples::bigint FROM pg_class WHERE oid = ('"'||table_schema||'"."'||table_name||'"')::regclass) as row_estimate
                        FROM information_schema.tables
                        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
                        AND table_name ILIKE ${'%' + search + '%'}
                        ORDER BY table_name
                    `;
                } else {
                    rows = await projectDb`
                        SELECT table_name, table_schema, table_type,
                        (SELECT reltuples::bigint FROM pg_class WHERE oid = ('"'||table_schema||'"."'||table_name||'"')::regclass) as row_estimate
                        FROM information_schema.tables
                        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
                        ORDER BY table_name
                    `;
                }

                return {
                    data: rows.slice(skip, skip + limit),
                    total: rows.length
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
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
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
                const dbName = await resolveDbName(params.ref);
                const regex = /^[a-zA-Z_0-9]+$/;
                if (!regex.test(params.schema) || !regex.test(params.table)) {
                     set.status = 400;
                     return { error: "Invalid schema or table name format" };
                }

                const projectDb = getProjectDb(dbName);
                const rows = await projectDb`
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_schema = ${params.schema} AND table_name = ${params.table}
                    ORDER BY ordinal_position
                `;

                return { data: rows };
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
                const dbName = await resolveDbName(params.ref);
                const limit = Math.min(Math.max(Number(query._limit || query.limit || 50), 1), 500);
                const page = Math.max(Number(query._page || 1), 1);
                const skip = Number(query.skip || (page - 1) * limit);

                const regex = /^[a-zA-Z_0-9]+$/;
                if (!regex.test(params.schema) || !regex.test(params.table)) {
                     set.status = 400;
                     return { error: "Invalid schema or table name format" };
                }

                const projectDb = getProjectDb(dbName);
                const rows = await projectDb.unsafe(`SELECT * FROM "${params.schema}"."${params.table}" LIMIT ${limit} OFFSET ${skip}`);
                const countResult = await projectDb.unsafe(`SELECT count(*) as count FROM "${params.schema}"."${params.table}"`);

                return {
                    data: rows || [],
                    total: parseInt(countResult?.[0]?.count || "0")
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

            try {
                const dbName = await resolveDbName(params.ref);
                const sqlQuery = body.query || body.sql;
                if (!sqlQuery) {
                    set.status = 400;
                    return { error: "query or sql is required" };
                }
                const result = await db.executeQuery(dbName, sqlQuery);
                const rows = (result as { rows?: unknown[] }).rows || result;
                return { result: Array.isArray(rows) ? rows : [rows] };
            } catch (error: unknown) {
                set.status = 500;
                return {
                    error: "SQL execution failed",
                    message: error instanceof Error ? error.message : "Unknown error",
                };
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            body: t.Object({
                sql: t.Optional(t.String()),
                query: t.Optional(t.String()),
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

            const dbName = await resolveDbName(params.ref);
            const projectDb = getProjectDb(dbName);

            try {
                const migrationTableExists = await projectDb`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables
                        WHERE table_schema IN ('public', 'supabase_migrations')
                        AND table_name = 'schema_migrations'
                    ) AS exists
                `;

                const tableExists = (migrationTableExists as Array<{ exists: boolean }>)[0]?.exists ?? false;

                if (!tableExists) {
                    await projectDb.unsafe(`CREATE SCHEMA IF NOT EXISTS supabase_migrations`);
                    await projectDb`
                        CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
                            version BIGINT PRIMARY KEY,
                            statements TEXT[],
                            name TEXT
                        )
                    `;
                    await projectDb`
                        CREATE TABLE IF NOT EXISTS public.schema_migrations (
                            version VARCHAR(255) PRIMARY KEY,
                            statements TEXT[],
                            name TEXT
                        )
                    `;
                }

                const isCliFormat = 'query' in body && typeof (body as Record<string, unknown>).query === 'string';
                const isStructuredFormat = 'name' in body && 'sql' in body;

                if (isCliFormat) {
                    const query = (body as Record<string, unknown>).query as string;
                    const version = Math.floor(Date.now() / 1000);

                    const existing = await projectDb`
                        SELECT version FROM supabase_migrations.schema_migrations WHERE version = ${version}
                    `;
                    if (existing.length) {
                        set.status = 409;
                        return { error: "Migration already applied", version };
                    }

                    await projectDb.unsafe(query);
                    await projectDb`INSERT INTO supabase_migrations.schema_migrations (version, statements, name) VALUES (${version}, ARRAY[${query}], 'cli_push')`;
                    await projectDb`INSERT INTO public.schema_migrations (version, statements, name) VALUES (${String(version)}, ARRAY[${query}], 'cli_push')`.catch(() => {});

                    return { version, statements: [query] };
                }

                if (isStructuredFormat) {
                    const { name, sql } = body as { name: string; sql: string };
                    const version = Math.floor(Date.now() / 1000);

                    const existingMigration = await projectDb`
                        SELECT version FROM supabase_migrations.schema_migrations WHERE name = ${name}
                    `;

                    if (existingMigration.length) {
                        set.status = 409;
                        return { error: "Migration already applied", name };
                    }

                    await projectDb.unsafe(sql);
                    await projectDb`INSERT INTO supabase_migrations.schema_migrations (version, statements, name) VALUES (${version}, ARRAY[${sql}], ${name})`;
                    await projectDb`INSERT INTO public.schema_migrations (version, statements, name) VALUES (${String(version)}, ARRAY[${sql}], ${name})`.catch(() => {});

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
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
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
                const dbName = await resolveDbName(params.ref);
                const projectDb = getProjectDb(dbName);
                let rows: Array<Record<string, unknown>> = [];
                try {
                    rows = await projectDb`
                        SELECT version, statements, name FROM supabase_migrations.schema_migrations ORDER BY version ASC
                    ` as Array<Record<string, unknown>>;
                } catch {
                    rows = await projectDb`
                        SELECT version, statements, name FROM public.schema_migrations ORDER BY version ASC
                    ` as Array<Record<string, unknown>>;
                }
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
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
        }
    );
