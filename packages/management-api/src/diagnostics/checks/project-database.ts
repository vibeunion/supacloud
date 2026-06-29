/**
 * Project-level database checks.
 * Covers schema integrity, RLS, permissions, and Supabase-compat structures.
 */
import { resolveDbName, getProjectDb } from "../../db";
import { hashPayload, statusForHash } from "../hash";
import { registerCheck } from "../../services/diagnostics.registry";
import type { DiagnosticCheckResult, DiagnosticRepairResult } from "../../services/diagnostics.types";

function quotedStringList(values: string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

// --- Required schema existence ---
registerCheck({
  id: "project-required-schemas",
  name: "Required Schemas",
  description: "Check that auth, storage, public, supabase_functions, supabase_migrations schemas exist",
  category: "supabase_compat",
  scope: "project",
  severity: "critical",
  repairable: true,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    if (!ctx.projectRef) return null;
    try {
      const dbName = await resolveDbName(ctx.projectRef);
      const db = getProjectDb(dbName);

      const requiredSchemas = ["public", "auth", "storage", "supabase_functions", "supabase_migrations"];
      const rows = await db.unsafe(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name IN (${quotedStringList(requiredSchemas)})
      `);
      const found = new Set((rows as any[]).map((r) => r.schema_name));
      const missing = requiredSchemas.filter((s) => !found.has(s));

      if (missing.length > 0) {
        return {
          checkId: "project-required-schemas",
          status: "missing",
          message: `Missing schemas: ${missing.join(", ")}`,
          detail: `Found: ${[...found].join(", ")}`,
          repairPreview: "Restart project runtime to re-initialize tenant schemas",
          repairCommand: `tenantRuntimeService.restartRuntime(${ctx.projectRef})`,
          metadata: { missing, found: [...found] },
        };
      }

      return {
        checkId: "project-required-schemas",
        status: "pass",
        message: `All ${requiredSchemas.length} required schemas present`,
      };
    } catch (err: unknown) {
      return {
        checkId: "project-required-schemas",
        status: "unreachable",
        message: `Cannot query tenant DB: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  async repair(ctx): Promise<DiagnosticRepairResult> {
    if (!ctx.projectRef) return { success: false, message: "No project ref" };
    try {
      const { tenantRuntimeService } = await import("../../services/tenant-runtime.service");
      await tenantRuntimeService.restartRuntime(ctx.projectRef);
      return {
        success: true,
        message: "Project runtime restarted (re-creates missing schemas)",
        appliedCommand: `tenantRuntimeService.restartRuntime(${ctx.projectRef})`,
      };
    } catch (err: unknown) {
      return { success: false, message: `Repair failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

// --- RLS check on public tables ---
registerCheck({
  id: "project-rls-status",
  name: "Row Level Security",
  description: "Check if public tables have RLS enabled (security best practice)",
  category: "database_permissions",
  scope: "project",
  severity: "warning",
  repairable: true,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    if (!ctx.projectRef) return null;
    try {
      const dbName = await resolveDbName(ctx.projectRef);
      const db = getProjectDb(dbName);

      const rows = await db`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = pg_tables.tablename AND c.relrowsecurity = true
          )
        ORDER BY tablename
      `;

      const unprotected = (rows as any[]).map((r) => r.tablename);
      const userTables = unprotected.filter(
        (t) => !t.startsWith("pg_") && !t.startsWith("sql_") && t !== "schema_migrations",
      );

      if (userTables.length > 0) {
        return {
          checkId: "project-rls-status",
          status: "drift",
          message: `${userTables.length} public tables without RLS: ${userTables.slice(0, 10).join(", ")}${userTables.length > 10 ? "..." : ""}`,
          repairPreview: "ALTER TABLE ... ENABLE ROW LEVEL SECURITY for each unprotected table",
          repairCommand: userTables.map((t) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`).join("\n"),
          metadata: { unprotectedTables: userTables },
        };
      }

      return {
        checkId: "project-rls-status",
        status: "pass",
        message: "All public tables have RLS enabled",
      };
    } catch (err: unknown) {
      return {
        checkId: "project-rls-status",
        status: "error",
        message: `Cannot check RLS: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  async repair(ctx): Promise<DiagnosticRepairResult> {
    if (!ctx.projectRef) return { success: false, message: "No project ref" };
    try {
      const dbName = await resolveDbName(ctx.projectRef);
      const db = getProjectDb(dbName);

      const rows = await db`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = pg_tables.tablename AND c.relrowsecurity = true
          )
      `;

      let enabled = 0;
      for (const r of rows as any[]) {
        const t = r.tablename;
        if (t.startsWith("pg_") || t.startsWith("sql_") || t === "schema_migrations") continue;
        await db.unsafe(`ALTER TABLE public."${t}" ENABLE ROW LEVEL SECURITY`);
        enabled++;
      }

      return {
        success: true,
        message: `Enabled RLS on ${enabled} tables`,
        appliedCommand: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY x${enabled}`,
      };
    } catch (err: unknown) {
      return { success: false, message: `Repair failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

// --- Primary key check ---
registerCheck({
  id: "project-primary-keys",
  name: "Primary Keys",
  description: "Check all public tables have a primary key",
  category: "database_schema",
  scope: "project",
  severity: "critical",
  repairable: false,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    if (!ctx.projectRef) return null;
    try {
      const dbName = await resolveDbName(ctx.projectRef);
      const db = getProjectDb(dbName);

      const rows = await db`
        SELECT t.table_name
        FROM information_schema.tables t
        LEFT JOIN information_schema.table_constraints tc
          ON tc.table_schema = t.table_schema AND tc.table_name = t.table_name AND tc.constraint_type = 'PRIMARY KEY'
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND tc.constraint_name IS NULL
        ORDER BY t.table_name
      `;

      const withoutPK = (rows as any[]).map((r) => r.table_name);

      if (withoutPK.length > 0) {
        return {
          checkId: "project-primary-keys",
          status: "missing",
          message: `${withoutPK.length} tables without primary key: ${withoutPK.join(", ")}`,
          detail: "Tables without PKs cause replication and performance issues",
          metadata: { tables: withoutPK },
        };
      }

      return {
        checkId: "project-primary-keys",
        status: "pass",
        message: "All public tables have primary keys",
      };
    } catch (err: unknown) {
      return {
        checkId: "project-primary-keys",
        status: "error",
        message: `Cannot check primary keys: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

// --- Auth schema core tables ---
registerCheck({
  id: "project-auth-schema",
  name: "Auth Schema",
  description: "Check auth.users, auth.sessions, auth.refresh_tokens, auth.identities exist",
  category: "supabase_compat",
  scope: "project",
  severity: "critical",
  repairable: true,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    if (!ctx.projectRef) return null;
    try {
      const dbName = await resolveDbName(ctx.projectRef);
      const db = getProjectDb(dbName);

      const requiredTables = ["users", "sessions", "refresh_tokens", "identities"];
      const rows = await db.unsafe(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'auth' AND table_name IN (${quotedStringList(requiredTables)})
      `);
      const found = new Set((rows as any[]).map((r) => r.table_name));
      const missing = requiredTables.filter((t) => !found.has(t));

      if (missing.length > 0) {
        return {
          checkId: "project-auth-schema",
          status: "missing",
          message: `Missing auth tables: ${missing.join(", ")}`,
          repairPreview: "Restart project runtime to re-initialize auth schema",
          repairCommand: `tenantRuntimeService.restartRuntime(${ctx.projectRef})`,
          metadata: { missing },
        };
      }

      return {
        checkId: "project-auth-schema",
        status: "pass",
        message: "Auth schema core tables present",
      };
    } catch (err: unknown) {
      return {
        checkId: "project-auth-schema",
        status: "unreachable",
        message: `Cannot check auth schema: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  async repair(ctx): Promise<DiagnosticRepairResult> {
    if (!ctx.projectRef) return { success: false, message: "No project ref" };
    try {
      const { tenantRuntimeService } = await import("../../services/tenant-runtime.service");
      await tenantRuntimeService.restartRuntime(ctx.projectRef);
      return {
        success: true,
        message: "Project runtime restarted (re-creates auth schema)",
        appliedCommand: `tenantRuntimeService.restartRuntime(${ctx.projectRef})`,
      };
    } catch (err: unknown) {
      return { success: false, message: `Repair failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

// --- Storage schema ---
registerCheck({
  id: "project-storage-schema",
  name: "Storage Schema",
  description: "Check storage.buckets and storage.objects exist with correct structure",
  category: "supabase_compat",
  scope: "project",
  severity: "critical",
  repairable: true,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    if (!ctx.projectRef) return null;
    try {
      const dbName = await resolveDbName(ctx.projectRef);
      const db = getProjectDb(dbName);

      const rows = await db`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'storage' AND table_name IN ('buckets', 'objects')
      `;
      const found = new Set((rows as any[]).map((r) => r.table_name));
      const missing: string[] = [];
      if (!found.has("buckets")) missing.push("storage.buckets");
      if (!found.has("objects")) missing.push("storage.objects");

      if (missing.length > 0) {
        return {
          checkId: "project-storage-schema",
          status: "missing",
          message: `Missing: ${missing.join(", ")}`,
          repairPreview: "Re-create storage schema tables",
          repairCommand: "Storage schema DDL re-initialization",
          metadata: { missing },
        };
      }

      return {
        checkId: "project-storage-schema",
        status: "pass",
        message: "Storage schema tables present",
      };
    } catch (err: unknown) {
      return {
        checkId: "project-storage-schema",
        status: "unreachable",
        message: `Cannot check storage schema: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  async repair(ctx): Promise<DiagnosticRepairResult> {
    if (!ctx.projectRef) return { success: false, message: "No project ref" };
    try {
      const dbName = await resolveDbName(ctx.projectRef);
      const db = getProjectDb(dbName);
      await db.unsafe(`
        CREATE SCHEMA IF NOT EXISTS storage;
        CREATE TABLE IF NOT EXISTS storage.buckets (
          id text NOT NULL PRIMARY KEY, name text NOT NULL, owner uuid,
          created_at timestamptz default now(), updated_at timestamptz default now(),
          public boolean default false, file_size_limit bigint, allowed_mime_types text[]
        );
        CREATE TABLE IF NOT EXISTS storage.objects (
          id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
          bucket_id text REFERENCES storage.buckets, name text, owner uuid,
          created_at timestamptz default now(), updated_at timestamptz default now(),
          last_accessed_at timestamptz default now(), metadata jsonb,
          path_tokens text[] generated always as (string_to_array(name, '/')) stored,
          version text default gen_random_uuid()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_objects_bucketid_name ON storage.objects (bucket_id, name);
      `);
      return { success: true, message: "Storage schema tables re-created" };
    } catch (err: unknown) {
      return { success: false, message: `Repair failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

// --- FK index check ---
registerCheck({
  id: "project-fk-indexes",
  name: "Foreign Key Indexes",
  description: "Check foreign key columns have indexes for join performance",
  category: "database_schema",
  scope: "project",
  severity: "info",
  repairable: false,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    if (!ctx.projectRef) return null;
    try {
      const dbName = await resolveDbName(ctx.projectRef);
      const db = getProjectDb(dbName);

      const rows = await db`
        SELECT tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_indexes pi
            WHERE pi.schemaname = tc.table_schema
              AND pi.tablename = tc.table_name
              AND pi.indexdef LIKE '%' || kcu.column_name || '%'
          )
        ORDER BY tc.table_name, kcu.column_name
      `;

      const missing = (rows as any[]).map((r) => `${r.table_name}.${r.column_name}`);

      if (missing.length > 0) {
        return {
          checkId: "project-fk-indexes",
          status: "drift",
          message: `${missing.length} FK columns without indexes`,
          detail: missing.slice(0, 15).join(", "),
          metadata: { columns: missing },
        };
      }

      return {
        checkId: "project-fk-indexes",
        status: "pass",
        message: "All FK columns indexed",
      };
    } catch (err: unknown) {
      return {
        checkId: "project-fk-indexes",
        status: "error",
        message: `Cannot check FK indexes: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

// --- PostgREST health ---
registerCheck({
  id: "project-postgrest-health",
  name: "PostgREST Health",
  description: "Probe PostgREST health endpoint for this project",
  category: "api_probe",
  scope: "project",
  severity: "critical",
  repairable: true,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    if (!ctx.projectRef) return null;
    try {
      const { tenantRuntimeService } = await import("../../services/tenant-runtime.service");
      const status = await tenantRuntimeService.statusPostgrest(ctx.projectRef);

      if (status.health === "healthy") {
        return {
          checkId: "project-postgrest-health",
          status: "pass",
          message: `PostgREST healthy (port ${status.port || "?"})`,
        };
      }

      return {
        checkId: "project-postgrest-health",
        status: "degraded",
        message: `PostgREST unhealthy: ${status.health}`,
        detail: status.last_error || undefined,
        repairPreview: "Restart PostgREST for this project",
        repairCommand: `tenantRuntimeService.restartPostgrest(${ctx.projectRef})`,
        metadata: { health: status.health, actual: status.actual, lastError: status.last_error },
      };
    } catch (err: unknown) {
      return {
        checkId: "project-postgrest-health",
        status: "error",
        message: `Cannot check PostgREST: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  async repair(ctx): Promise<DiagnosticRepairResult> {
    if (!ctx.projectRef) return { success: false, message: "No project ref" };
    try {
      const { tenantRuntimeService } = await import("../../services/tenant-runtime.service");
      await tenantRuntimeService.restartPostgrest(ctx.projectRef);
      return {
        success: true,
        message: "PostgREST restarted",
        appliedCommand: `tenantRuntimeService.restartPostgrest(${ctx.projectRef})`,
      };
    } catch (err: unknown) {
      return { success: false, message: `Repair failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

// --- Schema hash baseline ---
registerCheck({
  id: "project-schema-hash",
  name: "Schema Baseline",
  description: "Hash table, column, constraint and index definitions for drift detection",
  category: "database_schema",
  scope: "project",
  severity: "critical",
  repairable: false,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    if (!ctx.projectRef) return null;
    try {
      const db = getProjectDb(await resolveDbName(ctx.projectRef));
      const [columns, constraints, indexes] = await Promise.all([
        db`
          SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default, ordinal_position
          FROM information_schema.columns
          WHERE table_schema IN ('public', 'auth', 'storage', 'realtime', 'supabase_functions', 'supabase_migrations')
          ORDER BY table_schema, table_name, ordinal_position
        `,
        db`
          SELECT table_schema, table_name, constraint_name, constraint_type
          FROM information_schema.table_constraints
          WHERE table_schema IN ('public', 'auth', 'storage', 'realtime', 'supabase_functions', 'supabase_migrations')
          ORDER BY table_schema, table_name, constraint_name
        `,
        db`
          SELECT schemaname, tablename, indexname, indexdef
          FROM pg_indexes
          WHERE schemaname IN ('public', 'auth', 'storage', 'realtime', 'supabase_functions', 'supabase_migrations')
          ORDER BY schemaname, tablename, indexname
        `,
      ]);
      const hash = hashPayload({ columns, constraints, indexes });
      const baseline = await statusForHash(ctx, "project-schema-hash", hash);

      return {
        checkId: "project-schema-hash",
        status: baseline.status,
        message: baseline.status === "tampered" ? "Schema hash differs from trusted baseline" : "Schema hash matches baseline or no baseline exists",
        detail: `sha256:${hash}`,
        metadata: {
          hash,
          baselineHash: baseline.baselineHash,
          columns: columns.length,
          constraints: constraints.length,
          indexes: indexes.length,
        },
      };
    } catch (err: unknown) {
      return {
        checkId: "project-schema-hash",
        status: "error",
        message: `Cannot compute schema hash: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

// --- Function definition hash baseline ---
registerCheck({
  id: "project-functiondef-hash",
  name: "Function Definition Baseline",
  description: "Hash PostgreSQL function definitions outside system schemas",
  category: "database_functions",
  scope: "project",
  severity: "critical",
  repairable: false,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    if (!ctx.projectRef) return null;
    try {
      const db = getProjectDb(await resolveDbName(ctx.projectRef));
      const functions = await db`
        SELECT n.nspname AS schema_name,
               p.proname AS function_name,
               pg_get_function_identity_arguments(p.oid) AS arguments,
               pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'auth', 'storage', 'realtime', 'supabase_functions', 'graphql_public')
        ORDER BY n.nspname, p.proname, arguments
      `;
      const hash = hashPayload(functions);
      const baseline = await statusForHash(ctx, "project-functiondef-hash", hash);

      return {
        checkId: "project-functiondef-hash",
        status: baseline.status,
        message: baseline.status === "tampered" ? "Function definitions differ from trusted baseline" : "Function definition hash matches baseline or no baseline exists",
        detail: `sha256:${hash}`,
        metadata: { hash, baselineHash: baseline.baselineHash, functions: functions.length },
      };
    } catch (err: unknown) {
      return {
        checkId: "project-functiondef-hash",
        status: "error",
        message: `Cannot compute function definition hash: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

// --- Trigger hash baseline ---
registerCheck({
  id: "project-trigger-hash",
  name: "Trigger Baseline",
  description: "Hash trigger definitions for tamper detection",
  category: "database_schema",
  scope: "project",
  severity: "critical",
  repairable: false,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    if (!ctx.projectRef) return null;
    try {
      const db = getProjectDb(await resolveDbName(ctx.projectRef));
      const triggers = await db`
        SELECT event_object_schema, event_object_table, trigger_name, event_manipulation, action_timing, action_statement
        FROM information_schema.triggers
        WHERE event_object_schema IN ('public', 'auth', 'storage', 'realtime', 'supabase_functions')
        ORDER BY event_object_schema, event_object_table, trigger_name, event_manipulation
      `;
      const hash = hashPayload(triggers);
      const baseline = await statusForHash(ctx, "project-trigger-hash", hash);

      return {
        checkId: "project-trigger-hash",
        status: baseline.status,
        message: baseline.status === "tampered" ? "Trigger hash differs from trusted baseline" : "Trigger hash matches baseline or no baseline exists",
        detail: `sha256:${hash}`,
        metadata: { hash, baselineHash: baseline.baselineHash, triggers: triggers.length },
      };
    } catch (err: unknown) {
      return {
        checkId: "project-trigger-hash",
        status: "error",
        message: `Cannot compute trigger hash: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

// --- Project config hash baseline ---
registerCheck({
  id: "project-config-hash",
  name: "Project Config Baseline",
  description: "Hash non-secret project configuration and runtime desired state",
  category: "configuration",
  scope: "project",
  severity: "critical",
  repairable: false,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    if (!ctx.projectRef) return null;
    try {
      const [project] = await ctx.metaDb`
        SELECT ref, status, postgrest_desired, region, config
        FROM projects
        WHERE ref = ${ctx.projectRef} AND deleted_at IS NULL
        LIMIT 1
      `;
      if (!project) {
        return {
          checkId: "project-config-hash",
          status: "missing",
          message: "Project metadata not found",
        };
      }

      const hash = hashPayload(project);
      const baseline = await statusForHash(ctx, "project-config-hash", hash);

      return {
        checkId: "project-config-hash",
        status: baseline.status,
        message: baseline.status === "tampered" ? "Project config differs from trusted baseline" : "Project config hash matches baseline or no baseline exists",
        detail: `sha256:${hash}`,
        metadata: { hash, baselineHash: baseline.baselineHash },
      };
    } catch (err: unknown) {
      return {
        checkId: "project-config-hash",
        status: "error",
        message: `Cannot compute project config hash: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
