import { Elysia, t } from "elysia";
import { projectService } from "../services";
import { db, getProjectDb, getProjectRoleDb, resolveDbName, sql as metaSql, type SqlExecutionMode } from "../db";
import { requireAdminAuth, requireProjectOrAdminAuth } from "../middleware/auth";

export type MigrationBody =
  | { query: string; version?: number | string }
  | { name: string; sql?: string; statements?: string[]; version?: number | string };

export function resolveMigrationStatements(body: MigrationBody): string[] {
  if ("query" in body && typeof body.query === "string") {
    return [body.query];
  }

  if ("statements" in body && Array.isArray(body.statements) && body.statements.length > 0) {
    return body.statements.filter((statement: unknown): statement is string => typeof statement === "string" && statement.trim().length > 0);
  }

  if ("sql" in body && typeof body.sql === "string" && body.sql.trim().length > 0) {
    return [body.sql];
  }

  return [];
}

export function sqlRouteResponse(result: Awaited<ReturnType<typeof db.executeQuery>>) {
  return {
    rows: result.rows,
    rowCount: result.rowCount,
    command: result.command,
    fields: result.fields || [],
    notices: result.notices || [],
  };
}

async function getProjectDatabaseCredentials(ref: string) {
  const [project] = await metaSql`
    SELECT db_name, db_user, db_password
    FROM projects
    WHERE ref = ${ref} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!project) return null;
  return {
    db_name: String(project.db_name),
    db_user: String(project.db_user),
    db_password: String(project.db_password),
  };
}

async function getProjectSql(ref: string) {
  const credentials = await getProjectDatabaseCredentials(ref);
  if (!credentials) return null;
  return getProjectRoleDb(credentials.db_name, credentials.db_user, credentials.db_password);
}

function resolveSqlMode(body: Record<string, unknown>): SqlExecutionMode {
  const mode = typeof body.mode === "string" ? body.mode : "read";
  if (mode === "migration" || mode === "admin") return mode;
  return "read";
}

function requireAdminMode(body: Record<string, unknown>): boolean {
  return body.mode === "admin" && body.admin === true;
}

const ensuredMigrationTables = new Set<string>();

export function resetEnsuredMigrationTablesForTests(): void {
  ensuredMigrationTables.clear();
}

export async function ensureMigrationTables(dbName: string, projectDb: ReturnType<typeof getProjectDb>): Promise<void> {
  if (ensuredMigrationTables.has(dbName)) return;

  const existing = await projectDb<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'supabase_migrations'
        AND table_name = 'schema_migrations'
    ) AS exists
  `;

  if (!existing[0]?.exists) {
    await projectDb.unsafe(`CREATE SCHEMA IF NOT EXISTS supabase_migrations`);
    await projectDb`
      CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
        version BIGINT PRIMARY KEY,
        statements TEXT[],
        name TEXT
      )
    `;
  }

  await projectDb`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      statements TEXT[],
      name TEXT
    )
  `;

  ensuredMigrationTables.add(dbName);
}

export async function ensureTasksRealtimePublication(projectDb: ReturnType<typeof getProjectDb>): Promise<void> {
  try {
    await projectDb`SELECT realtime.ensure_tasks_publication()`;
  } catch {
    // Older tenants may not have the helper yet, and some deployments run without
    // logical Realtime enabled. Migrations must remain authoritative even then.
  }
}

function projectAuthResponse(authError: { status: number; body: { error: string } }, set: { status?: number | string }) {
  set.status = authError.status;
  return { message: authError.body.error, code: String(authError.status), status: authError.status };
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizePagination(
  query: Record<string, unknown>,
  defaultLimit = 50,
  maxLimit = Number.MAX_SAFE_INTEGER,
) {
  const limit = normalizePositiveInteger(query._limit ?? query.limit, defaultLimit, 1, maxLimit);
  const page = normalizePositiveInteger(query._page, 1, 1, Number.MAX_SAFE_INTEGER);
  const defaultSkip = (page - 1) * limit;
  const skip = normalizePositiveInteger(query.skip, defaultSkip, 0, Number.MAX_SAFE_INTEGER);
  return { limit, page, skip };
}

export const databaseRoutes = new Elysia({ prefix: "/v1/projects/:ref/database" })
    .get(
        "/tables",
        async ({ params, query, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const { limit, skip } = normalizePagination(query as Record<string, unknown>);
                const search = query.q ? String(query.q) : (query.query ? String(query.query) : "");

                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
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
                    message: "Failed to list tables",
                    code: "500",
                    status: 500,
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
            }, { additionalProperties: true }),
            detail: { tags: ["projects"], summary: "List database tables" },
        }
    )
    .get(
        "/tables/:schema/:table/columns",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const regex = /^[a-zA-Z_0-9]+$/;
                if (!regex.test(params.schema) || !regex.test(params.table)) {
                     set.status = 400;
                     return { message: "Invalid schema or table name format", code: "400", status: 400 };
                }

                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
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
                    message: "Failed to list columns",
                    code: "500",
                    status: 500,
                };
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
                schema: t.String({ minLength: 1 }),
                table: t.String({ minLength: 1 }),
            }),
            detail: { tags: ["projects"], summary: "List columns for a database table" },
        }
    )
    .get(
        "/tables/:schema/:table/rows",
        async ({ params, query, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const { limit, skip } = normalizePagination(query as Record<string, unknown>, 50, 500);

                const regex = /^[a-zA-Z_0-9]+$/;
                if (!regex.test(params.schema) || !regex.test(params.table)) {
                     set.status = 400;
                     return { message: "Invalid schema or table name format", code: "400", status: 400 };
                }

                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const rows = await projectDb.unsafe(`SELECT * FROM "${params.schema}"."${params.table}" LIMIT ${limit} OFFSET ${skip}`);
                const countResult = await projectDb.unsafe(`SELECT count(*) as count FROM "${params.schema}"."${params.table}"`);

                return {
                    data: rows || [],
                    total: parseInt(countResult?.[0]?.count || "0")
                };
            } catch (error: unknown) {
                set.status = 500;
                return {
                    message: "Failed to fetch rows",
                    code: "500",
                    status: 500,
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
            }, { additionalProperties: true }),
            detail: { tags: ["projects"], summary: "List rows in a database table" },
        }
    )
    .post(
        "/query",
        async ({ params, body, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const credentials = await getProjectDatabaseCredentials(params.ref);
                if (!credentials) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const result = await db.executeQuery(credentials.db_name, body.query, {
                    mode: "read",
                    username: credentials.db_user,
                    password: credentials.db_password,
                });
                return sqlRouteResponse(result);
            } catch (error: unknown) {
                set.status = 400;
                const pgErr = error as Record<string, unknown>;
                return {
                    code: pgErr.code || "42601",
                    message: pgErr.message || "SQL execution failed",
                    details: pgErr.details || null,
                    hint: pgErr.hint || null,
                    status: 400,
                };
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            body: t.Object({
                query: t.String(),
            }),
            detail: { tags: ["projects"], summary: "Execute a read-only SQL query" },
        }
    )
    .post(
        "/sql",
        async ({ params, body, set, request }) => {
            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const sqlQuery = body.query || body.sql;
                if (!sqlQuery) {
                    set.status = 400;
                    return { message: "query or sql is required", code: "400", status: 400 };
                }
                const mode = resolveSqlMode(body as Record<string, unknown>);
                const authError = await requireProjectOrAdminAuth(request, params.ref);
                if (authError) return projectAuthResponse(authError, set);

                if (mode === "admin") {
                    if (!requireAdminMode(body as Record<string, unknown>)) {
                        set.status = 403;
                        return { message: "Admin SQL requires mode=admin and admin=true", code: "403", status: 403 };
                    }
                    const authError = await requireAdminAuth(request);
                    if (authError) {
                        set.status = authError.status;
                        return { message: authError.body.error, code: String(authError.status), status: authError.status };
                    }
                }
                const credentials = await getProjectDatabaseCredentials(params.ref);
                if (!credentials) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const useRoleConnection = mode !== "admin";
                const result = await db.executeQuery(credentials.db_name, sqlQuery, {
                    mode,
                    ...(useRoleConnection ? { username: credentials.db_user, password: credentials.db_password } : {}),
                });
                return sqlRouteResponse(result);
            } catch (error: unknown) {
                set.status = 400;
                const pgErr = error as Record<string, unknown>;
                return {
                    code: pgErr.code || "42601",
                    message: pgErr.message || "SQL execution failed",
                    details: pgErr.details || null,
                    hint: pgErr.hint || null,
                    status: 400,
                };
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            body: t.Object({
                sql: t.Optional(t.String()),
                query: t.Optional(t.String()),
                mode: t.Optional(t.Union([t.Literal("read"), t.Literal("migration"), t.Literal("admin")])),
                admin: t.Optional(t.Boolean()),
            }),
            detail: { tags: ["projects"], summary: "Execute a SQL statement with mode control" },
        }
    )
    .post(
        "/migrations",
        async ({ params, body, request, set }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) {
                set.status = authError.status;
                return { message: authError.body.error, code: String(authError.status), status: authError.status };
            }

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            const dbName = await resolveDbName(params.ref);
            const projectDb = getProjectDb(dbName);

            try {
                await ensureMigrationTables(dbName, projectDb);

                const isCliFormat = 'query' in body && typeof (body as Record<string, unknown>).query === 'string';
                const isStructuredFormat = ('name' in body && 'sql' in body) || ('name' in body && 'statements' in body);

                if (isCliFormat) {
                    const query = (body as Record<string, unknown>).query as string;
                    const version = (body as Record<string, unknown>).version
                        ? Number((body as Record<string, unknown>).version)
                        : Math.floor(Date.now() / 1000);
                    const statements = resolveMigrationStatements(body as MigrationBody);

                    const txnResult = await projectDb.begin(async (tx) => {
                        const existing = await tx`
                            SELECT version FROM supabase_migrations.schema_migrations WHERE version = ${version}
                        `;
                        if (existing.length) {
                            return { conflict: true as const };
                        }

                        await tx.unsafe(query);
                        await tx`INSERT INTO supabase_migrations.schema_migrations (version, statements, name) VALUES (${version}, ARRAY[${statements[0]}]::text[], 'cli_push')`;
                        await tx`INSERT INTO public.schema_migrations (version, statements, name) VALUES (${String(version)}, ARRAY[${statements[0]}]::text[], 'cli_push')`.catch(() => {});
                        return { conflict: false as const };
                    });

                    if (txnResult.conflict) {
                        set.status = 409;
                        return { message: "Migration already applied", code: "409", version };
                    }

                    await ensureTasksRealtimePublication(projectDb);

                    return { version, statements };
                }

                if (isStructuredFormat) {
                    const { name } = body as { name: string; version?: number | string; statements?: string[]; sql?: string };
                    const statements = resolveMigrationStatements(body as MigrationBody);
                    const sql = statements.join(';');
                    const version = (body as Record<string, unknown>).version
                        ? Number((body as Record<string, unknown>).version)
                        : Math.floor(Date.now() / 1000);

                    const txnResult = await projectDb.begin(async (tx) => {
                        const existingMigration = await tx`
                            SELECT version FROM supabase_migrations.schema_migrations WHERE name = ${name}
                        `;

                        if (existingMigration.length) {
                            return { conflict: true as const };
                        }

                        await tx.unsafe(sql);
                        await tx`INSERT INTO supabase_migrations.schema_migrations (version, statements, name) VALUES (${version}, ARRAY[${sql}]::text[], ${name})`;
                        await tx`INSERT INTO public.schema_migrations (version, statements, name) VALUES (${String(version)}, ARRAY[${sql}]::text[], ${name})`.catch(() => {});
                        return { conflict: false as const };
                    });

                    if (txnResult.conflict) {
                        set.status = 409;
                        return { message: "Migration already applied", code: "409", name };
                    }

                    await ensureTasksRealtimePublication(projectDb);

                    return { version, name };
                }

                set.status = 400;
                return { message: "Body must contain {query} or {name, sql}", code: "400", status: 400 };
            } catch (error: unknown) {
                set.status = 500;
                const detail = error instanceof Error ? error.message : String(error);
                return {
                    message: "Migration failed",
                    detail,
                    code: "500",
                    status: 500,
                };
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            body: t.Record(t.String(), t.Unknown()),
            detail: { tags: ["projects"], summary: "Apply a database migration" },
        }
    )
    .get(
        "/migrations",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
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
                    version: String(row.version),
                    statements: row.statements || [],
                    name: row.name || null,
                }));
            } catch (error: unknown) {
                return [];
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            detail: { tags: ["projects"], summary: "List applied database migrations" },
        }
    )
    .get(
        "/constraints",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }
            try {
                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const rows = await projectDb`
                    SELECT
                        c.oid as id,
                        con.conname as name,
                        con.contype as type,
                        nsp.nspname as schema,
                        rel.relname as table_name,
                        con.conkey as column_indices,
                        fnsp.nspname as foreign_table_schema,
                        frel.relname as foreign_table_name,
                        con.confkey as foreign_column_indices
                    FROM pg_constraint con
                    JOIN pg_class rel ON rel.oid = con.conrelid
                    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
                    LEFT JOIN pg_class frel ON frel.oid = con.confrelid
                    LEFT JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
                    WHERE nsp.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                    ORDER BY nsp.nspname, rel.relname, con.conname
                `;
                return rows.map((r: Record<string, unknown>) => ({
                    id: r.id,
                    name: r.name,
                    type: r.type,
                    schema: r.schema,
                    table_name: r.table_name,
                    column_indices: r.column_indices,
                    foreign_table_schema: r.foreign_table_schema,
                    foreign_table_name: r.foreign_table_name,
                    foreign_column_indices: r.foreign_column_indices,
                }));
            } catch {
                return [];
            }
        },
        { params: t.Object({ ref: t.String({ minLength: 1 }) }), detail: { tags: ["projects"], summary: "List database constraints" } }
    )
    .get(
        "/functions",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }
            try {
                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const rows = await projectDb`
                    SELECT
                        p.oid as id,
                        p.proname as name,
                        n.nspname as schema,
                        pg_get_functiondef(p.oid) as definition,
                        l.lanname as language,
                        pg_get_function_result(p.oid) as return_type,
                        p.provolatile as volatility,
                        p.proisstrict as is_strict,
                        p.prosecdef as security_definer
                    FROM pg_proc p
                    JOIN pg_namespace n ON n.oid = p.pronamespace
                    JOIN pg_language l ON l.oid = p.prolang
                    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY n.nspname, p.proname
                `;
                return rows.map((r: Record<string, unknown>) => ({
                    id: r.id,
                    name: r.name,
                    schema: r.schema,
                    definition: r.definition,
                    language: r.language,
                    return_type: r.return_type,
                    volatility: r.volatility,
                    is_strict: r.is_strict,
                    security_definer: r.security_definer,
                }));
            } catch {
                return [];
            }
        },
        { params: t.Object({ ref: t.String({ minLength: 1 }) }), detail: { tags: ["projects"], summary: "List database functions" } }
    )
    .get(
        "/triggers",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }
            try {
                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const rows = await projectDb`
                    SELECT
                        t.oid as id,
                        t.tgname as name,
                        n.nspname as schema,
                        c.relname as table_name,
                        p.proname as function_name,
                        CASE t.tgtype
                            WHEN 1 THEN 'BEFORE'
                            WHEN 2 THEN 'AFTER'
                            WHEN 3 THEN 'INSTEAD OF'
                        END as timing,
                        CASE
                            WHEN t.tgtype & 4 = 4 THEN 'INSERT'
                            WHEN t.tgtype & 8 = 8 THEN 'DELETE'
                            WHEN t.tgtype & 16 = 16 THEN 'UPDATE'
                            WHEN t.tgtype & 32 = 32 THEN 'TRUNCATE'
                            ELSE 'UNKNOWN'
                        END as event,
                        t.tgenabled as enabled
                    FROM pg_trigger t
                    JOIN pg_class c ON c.oid = t.tgrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    LEFT JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE NOT t.tgisinternal
                    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY n.nspname, c.relname, t.tgname
                `;
                return rows.map((r: Record<string, unknown>) => ({
                    id: r.id,
                    name: r.name,
                    schema: r.schema,
                    table_name: r.table_name,
                    function_name: r.function_name,
                    timing: r.timing,
                    event: r.event,
                    enabled: r.enabled === 'O' || r.enabled === 'D',
                }));
            } catch {
                return [];
            }
        },
        { params: t.Object({ ref: t.String({ minLength: 1 }) }), detail: { tags: ["projects"], summary: "List database triggers" } }
    )
    .get(
        "/publications",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }
            try {
                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const rows = await projectDb`
                    SELECT
                        p.oid as id,
                        p.pubname as name,
                        p.pubinsert as publish_insert,
                        p.pubupdate as publish_update,
                        p.pubdelete as publish_delete,
                        p.pubtruncate as publish_truncate,
                        p.puballtables as all_tables
                    FROM pg_publication p
                    ORDER BY p.pubname
                `;
                const result = [];
                for (const row of rows) {
                    const r = row as Record<string, unknown>;
                    let tables: Array<Record<string, unknown>> = [];
                    try {
                        tables = await projectDb`
                            SELECT schemaname as schema, tablename as name
                            FROM pg_publication_tables
                            WHERE pubname = ${r.name as string}
                        ` as Array<Record<string, unknown>>;
                    } catch {}
                    result.push({
                        id: r.id,
                        name: r.name,
                        publish_insert: r.publish_insert,
                        publish_update: r.publish_update,
                        publish_delete: r.publish_delete,
                        publish_truncate: r.publish_truncate,
                        all_tables: r.all_tables,
                        tables: tables.map((t: Record<string, unknown>) => ({ schema: t.schema, name: t.name })),
                    });
                }
                return result;
            } catch {
                return [];
            }
        },
        { params: t.Object({ ref: t.String({ minLength: 1 }) }), detail: { tags: ["projects"], summary: "List database publications" } }
    );
