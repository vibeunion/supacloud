/**
 * pg-meta style typed database metadata routes.
 *
 * Mirrors the shape of Supabase pg-meta so the web console and external tools
 * can consume structured metadata without hand-writing catalog SQL on each
 * page. All endpoints are read-only and run against the tenant database.
 */
import { Elysia, status, t } from "elysia";
import * as authMiddleware from "../middleware/auth";
import { resolveDbName, getProjectDb } from "../db";
import { projectRepository } from "../repositories/project.repository";
import {
  renderDatabaseModelCandidate,
  type DatabaseModelCatalog,
  type DatabaseModelColumn,
  type DatabaseModelForeignKey,
  type DatabaseModelTable,
} from "../services/database-model-candidate";

async function queryTenant(ref: string, sqlText: string): Promise<Record<string, unknown>[]> {
  const dbName = await resolveDbName(ref);
  const db = getProjectDb(dbName);
  const rows = await db.unsafe(sqlText);
  return (rows as unknown as Record<string, unknown>[]) || [];
}

async function projectGuard(ref: string): Promise<boolean> {
  const project = await projectRepository.findByRef(ref);
  return !!project;
}

export const pgMetaRoutes = new Elysia({ prefix: "/v1/projects/:ref/pg-meta" })
  .onBeforeHandle(async ({ params, request }) => {
    const authError = await authMiddleware.requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })

  // ── Tables ──────────────────────────────────────────────────
  .get("/tables", {
    query: t.Object({ schema: t.Optional(t.String()) }),
    detail: { tags: ["pg-meta"], summary: "List tables" },
  }, async ({ params, query }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    const schema = (query.schema as string) || "public";
    const schemasParam = schema === "*" ? "" : `AND schemaname = '${schema.replace(/'/g, "''")}'`;
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT schemaname, tablename, tableowner, tablespace, hasindexes, hasrules, hastriggers
         FROM pg_tables
         WHERE schemaname NOT LIKE 'pg_%' AND schemaname != 'information_schema'
         ${schemasParam}
         ORDER BY schemaname, tablename`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Columns ─────────────────────────────────────────────────
  .get("/columns", {
    query: t.Object({ schema: t.Optional(t.String()) }),
    detail: { tags: ["pg-meta"], summary: "List columns" },
  }, async ({ params, query }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    const schema = (query.schema as string) || "public";
    const schemaFilter = schema === "*" ? "" : `AND table_schema = '${schema.replace(/'/g, "''")}'`;
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT table_schema, table_name, column_name, ordinal_position, data_type,
                udt_name, is_nullable, column_default, character_maximum_length, numeric_precision
         FROM information_schema.columns
         WHERE table_schema NOT LIKE 'pg_%' AND table_schema != 'information_schema'
         ${schemaFilter}
         ORDER BY table_schema, table_name, ordinal_position`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Indexes ─────────────────────────────────────────────────
  .get("/indexes", {
    detail: { tags: ["pg-meta"], summary: "List indexes" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT schemaname, tablename, indexname, indexdef
         FROM pg_indexes
         WHERE schemaname NOT LIKE 'pg_%' AND schemaname != 'information_schema'
         ORDER BY schemaname, tablename, indexname`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Roles ───────────────────────────────────────────────────
  .get("/roles", {
    detail: { tags: ["pg-meta"], summary: "List roles" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
                rolreplication, rolconnlimit
         FROM pg_roles
         WHERE rolname NOT LIKE 'pg_%'
         ORDER BY rolname`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Schemas ─────────────────────────────────────────────────
  .get("/schemas", {
    detail: { tags: ["pg-meta"], summary: "List schemas" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT n.nspname AS schema_name,
                pg_catalog.pg_get_userbyid(n.nspowner) AS schema_owner,
                (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind = 'r')::int AS table_count
         FROM pg_namespace n
         WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname != 'information_schema'
         ORDER BY n.nspname`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Functions ───────────────────────────────────────────────
  .get("/functions", {
    detail: { tags: ["pg-meta"], summary: "List functions" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT n.nspname AS schema_name, p.proname AS function_name,
                pg_catalog.pg_get_function_result(p.oid) AS result_type,
                pg_catalog.pg_get_function_arguments(p.oid) AS arguments,
                l.lanname AS language_name, p.prokind
         FROM pg_proc p
         JOIN pg_namespace n ON p.pronamespace = n.oid
         JOIN pg_language l ON p.prolang = l.oid
         WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname != 'information_schema'
         ORDER BY n.nspname, p.proname`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Triggers ────────────────────────────────────────────────
  .get("/triggers", {
    detail: { tags: ["pg-meta"], summary: "List triggers" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT event_object_schema AS schema_name, event_object_table AS table_name,
                trigger_name, action_timing, event_manipulation, action_statement
         FROM information_schema.triggers
         WHERE event_object_schema NOT LIKE 'pg_%'
         ORDER BY event_object_schema, event_object_table, trigger_name`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Policies (RLS) ──────────────────────────────────────────
  .get("/policies", {
    detail: { tags: ["pg-meta"], summary: "List RLS policies" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
         FROM pg_policies
         WHERE schemaname NOT LIKE 'pg_%'
         ORDER BY schemaname, tablename, policyname`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Publications ────────────────────────────────────────────
  .get("/publications", {
    detail: { tags: ["pg-meta"], summary: "List publications" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT pubname, pubowner, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate
         FROM pg_publication
         ORDER BY pubname`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Views ───────────────────────────────────────────────────
  .get("/views", {
    detail: { tags: ["pg-meta"], summary: "List views" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT schemaname, viewname, viewowner, definition
         FROM pg_views
         WHERE schemaname NOT LIKE 'pg_%' AND schemaname != 'information_schema'
         ORDER BY schemaname, viewname`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Materialized Views ──────────────────────────────────────
  .get("/materialized-views", {
    detail: { tags: ["pg-meta"], summary: "List materialized views" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT schemaname, matviewname, matviewowner, definition
         FROM pg_matviews
         WHERE schemaname NOT LIKE 'pg_%' AND schemaname != 'information_schema'
         ORDER BY schemaname, matviewname`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Foreign Tables ──────────────────────────────────────────
  .get("/foreign-tables", {
    detail: { tags: ["pg-meta"], summary: "List foreign tables" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT schemaname, tablename, ftoptions, ftserver
         FROM pg_foreign_tables
         WHERE schemaname NOT LIKE 'pg_%'
         ORDER BY schemaname, tablename`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Types (enums + composite) ───────────────────────────────
  .get("/types", {
    detail: { tags: ["pg-meta"], summary: "List custom types" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT n.nspname AS schema_name, t.typname AS type_name, t.typtype,
                e.enumlabel AS enum_value
         FROM pg_type t
         JOIN pg_namespace n ON t.typnamespace = n.oid
         LEFT JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname != 'information_schema'
           AND t.typtype IN ('e', 'c')
         ORDER BY n.nspname, t.typname, e.enumsortorder`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Extensions ──────────────────────────────────────────────
  .get("/extensions", {
    detail: { tags: ["pg-meta"], summary: "List installed extensions" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT extname, extversion, nspname AS schema_name
         FROM pg_extension e
         JOIN pg_namespace n ON e.extnamespace = n.oid
         ORDER BY extname`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // ── Constraints ─────────────────────────────────────────────
  .get("/constraints", {
    detail: { tags: ["pg-meta"], summary: "List constraints" },
  }, async ({ params }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    try {
      const rows = await queryTenant(
        params.ref,
        `SELECT n.nspname AS schema_name, c.relname AS table_name,
                con.conname AS constraint_name, con.contype AS constraint_type,
                pg_catalog.pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class c ON con.conrelid = c.oid
         JOIN pg_namespace n ON c.relnamespace = n.oid
         WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname != 'information_schema'
         ORDER BY n.nspname, c.relname, con.conname`,
      );
      return rows;
    } catch (err) {
      return status(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  .get("/model-candidate", {
    query: t.Object({ schema: t.Optional(t.String()) }),
    detail: { tags: ["pg-meta"], summary: "Generate a reviewed ZModel candidate through the project database binding" },
  }, async ({ params, query }) => {
    if (!(await projectGuard(params.ref))) return status(404, { error: "Project not found" });
    const requested = (query.schema ?? "public").split(",").map(value => value.trim()).filter(Boolean);
    if (!requested.length || requested.some(value => !/^[a-z_][a-z0-9_$]*$/i.test(value))) {
      return status(400, { error: "schema must contain PostgreSQL identifiers" });
    }
    const predicate = requested.map(value => `'${value.replaceAll("'", "''")}'`).join(",");
    try {
      const [columns, primaryKeys, foreignKeys, enums, schemas, policies] = await Promise.all([
        queryTenant(params.ref, `
          SELECT n.nspname AS schema, c.relname AS table_name, a.attname AS column_name,
                 format_type(a.atttypid, a.atttypmod) AS data_type,
                 t.typname AS udt_name, type_schema.nspname AS udt_schema,
                 NOT a.attnotnull AS nullable,
                 pg_get_expr(d.adbin, d.adrelid) AS default_expression
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            JOIN pg_type t ON t.oid = a.atttypid
            JOIN pg_namespace type_schema ON type_schema.oid = t.typnamespace
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           WHERE c.relkind IN ('r', 'p') AND n.nspname IN (${predicate})
           ORDER BY n.nspname, c.relname, a.attnum`),
        queryTenant(params.ref, `
          SELECT n.nspname AS schema, c.relname AS table_name, a.attname AS column_name
            FROM pg_constraint con
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key(attnum, position) ON true
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = key.attnum
           WHERE con.contype = 'p' AND n.nspname IN (${predicate})
           ORDER BY n.nspname, c.relname, key.position`),
        queryTenant(params.ref, `
          SELECT n.nspname AS schema, c.relname AS table_name, a.attname AS column_name,
                 fn.nspname AS foreign_schema, fc.relname AS foreign_table, fa.attname AS foreign_column
            FROM pg_constraint con
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_class fc ON fc.oid = con.confrelid
            JOIN pg_namespace fn ON fn.oid = fc.relnamespace
            JOIN LATERAL unnest(con.conkey, con.confkey) AS key(attnum, foreign_attnum) ON true
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = key.attnum
            JOIN pg_attribute fa ON fa.attrelid = fc.oid AND fa.attnum = key.foreign_attnum
           WHERE con.contype = 'f' AND n.nspname IN (${predicate})
           ORDER BY n.nspname, c.relname, a.attname`),
        queryTenant(params.ref, `
          SELECT n.nspname AS schema, t.typname AS name, e.enumlabel AS value
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            JOIN pg_enum e ON e.enumtypid = t.oid
           WHERE n.nspname IN (${predicate})
           ORDER BY n.nspname, t.typname, e.enumsortorder`),
        queryTenant(params.ref, `
          SELECT n.nspname AS schema FROM pg_namespace n
           WHERE n.nspname IN (${predicate}) ORDER BY n.nspname`),
        queryTenant(params.ref, `SELECT count(*)::int AS count FROM pg_policies WHERE schemaname IN (${predicate})`),
      ]);
      const tableMap = new Map<string, { schema: string; name: string; columns: DatabaseModelColumn[]; primaryKey: string[]; foreignKeys: DatabaseModelForeignKey[] }>();
      for (const row of columns) {
        const schema = String(row.schema), name = String(row.table_name), key = `${schema}.${name}`;
        const table = tableMap.get(key) ?? { schema, name, columns: [], primaryKey: [], foreignKeys: [] };
        table.columns.push({ name: String(row.column_name), dataType: String(row.data_type), udtName: String(row.udt_name), udtSchema: row.udt_schema === null ? null : String(row.udt_schema), nullable: row.nullable === true, defaultExpression: row.default_expression === null ? null : String(row.default_expression) });
        tableMap.set(key, table);
      }
      for (const row of primaryKeys) tableMap.get(`${row.schema}.${row.table_name}`)?.primaryKey.push(String(row.column_name));
      for (const row of foreignKeys) tableMap.get(`${row.schema}.${row.table_name}`)?.foreignKeys.push({ column: String(row.column_name), foreignSchema: String(row.foreign_schema), foreignTable: String(row.foreign_table), foreignColumn: String(row.foreign_column) });
      const enumMap = new Map<string, { schema: string; name: string; values: string[] }>();
      for (const row of enums) {
        const key = `${row.schema}.${row.name}`;
        const item = enumMap.get(key) ?? { schema: String(row.schema), name: String(row.name), values: [] };
        item.values.push(String(row.value)); enumMap.set(key, item);
      }
      const catalog: DatabaseModelCatalog = {
        schemas: schemas.map(row => String(row.schema)),
        tables: [...tableMap.values()] as DatabaseModelTable[],
        enums: [...enumMap.values()],
        policyCount: Number(policies[0]?.count ?? 0),
      };
      return renderDatabaseModelCandidate(catalog);
    } catch {
      // Keep catalog adapter errors, including connection details, inside the
      // Management API. The CLI receives only a stable transport error.
      return status(503, { error: "Database model introspection unavailable" });
    }
  });
