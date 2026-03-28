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
                const skip = Number(query.skip || 0);
                const limit = Number(query.limit || 50);
                const search = query.query ? String(query.query) : "";
                
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
                const allTables = (result as any).rows || [];

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
                query: t.Optional(t.String()),
            })
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

            const { name, sql } = body;

            try {
                const dbName = `supa_${params.ref}`;

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
                            applied_at TIMESTAMPTZ DEFAULT NOW()
                        );
                    `);
                }

                const version = `${Date.now()}_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
                const existingMigration = await db.executeQuery(
                    dbName,
                    `SELECT version FROM schema_migrations WHERE version LIKE '%${name.replace(/[^a-zA-Z0-9_]/g, "_")}%'`
                );

                if ((existingMigration as { rows?: unknown[] }).rows && (existingMigration as { rows?: unknown[] }).rows!.length > 0) {
                    set.status = 409;
                    return { error: "Migration already applied", name };
                }

                await db.executeQuery(dbName, sql);

                await db.executeQuery(dbName, `INSERT INTO schema_migrations (version) VALUES ('${version}');`);

                return { success: true, version, name };
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
            body: t.Object({
                name: t.String({ minLength: 1 }),
                sql: t.String({ minLength: 1 }),
            }),
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
                    `SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC;`
                );
                return result;
            } catch (error: unknown) {
                return { rows: [] };
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
            }),
        }
    );
