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
import { logger } from "../utils/logger";

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
  .get("/tables", async ({ params, query }) => {
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
  }, {
    query: t.Object({ schema: t.Optional(t.String()) }),
    detail: { tags: ["pg-meta"], summary: "List tables" },
  })

  // ── Columns ─────────────────────────────────────────────────
  .get("/columns", async ({ params, query }) => {
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
  }, {
    query: t.Object({ schema: t.Optional(t.String()) }),
    detail: { tags: ["pg-meta"], summary: "List columns" },
  })

  // ── Indexes ─────────────────────────────────────────────────
  .get("/indexes", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List indexes" },
  })

  // ── Roles ───────────────────────────────────────────────────
  .get("/roles", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List roles" },
  })

  // ── Schemas ─────────────────────────────────────────────────
  .get("/schemas", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List schemas" },
  })

  // ── Functions ───────────────────────────────────────────────
  .get("/functions", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List functions" },
  })

  // ── Triggers ────────────────────────────────────────────────
  .get("/triggers", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List triggers" },
  })

  // ── Policies (RLS) ──────────────────────────────────────────
  .get("/policies", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List RLS policies" },
  })

  // ── Publications ────────────────────────────────────────────
  .get("/publications", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List publications" },
  })

  // ── Views ───────────────────────────────────────────────────
  .get("/views", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List views" },
  })

  // ── Materialized Views ──────────────────────────────────────
  .get("/materialized-views", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List materialized views" },
  })

  // ── Foreign Tables ──────────────────────────────────────────
  .get("/foreign-tables", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List foreign tables" },
  })

  // ── Types (enums + composite) ───────────────────────────────
  .get("/types", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List custom types" },
  })

  // ── Extensions ──────────────────────────────────────────────
  .get("/extensions", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List installed extensions" },
  })

  // ── Constraints ─────────────────────────────────────────────
  .get("/constraints", async ({ params }) => {
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
  }, {
    detail: { tags: ["pg-meta"], summary: "List constraints" },
  });
