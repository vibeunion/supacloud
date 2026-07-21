import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SQL_MODULES } from "../../src/db/sql-modules";
import { ALTER_TENANT_SQL } from "../../src/services/tenant-runtime-migration";

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(import.meta.dir, "../..", relativePath), "utf8");
}

describe("supabase bootstrap schema", () => {
  test("exports the extracted tenant runtime migration used by the service", () => {
    const service = readRepoFile("src/services/tenant-runtime.service.ts");

    expect(service).toContain('import { ALTER_TENANT_SQL } from "./tenant-runtime-migration"');
    expect(service).toContain("Bun.write(tmpFile, ALTER_TENANT_SQL)");
    expect(ALTER_TENANT_SQL.length).toBeGreaterThan(25_000);
    expect(ALTER_TENANT_SQL).not.toContain("CREATE TABLE IF NOT EXISTS auth.webauthn_credentials");
    expect(ALTER_TENANT_SQL).toContain("CREATE OR REPLACE FUNCTION realtime.notify_postgres_changes()");
    expect(ALTER_TENANT_SQL).toContain("CREATE TABLE IF NOT EXISTS public.background_task_mirrors");
    expect(ALTER_TENANT_SQL).not.toContain("CREATE TRIGGER auth_users_delete_fence");
  });

  test("does not switch SQL role inside set_request_context", () => {
    const functionSources = [
      SQL_MODULES["postgrest-request-context"],
      ALTER_TENANT_SQL,
      readRepoFile("src/db/schemas/supabase.sql"),
      readRepoFile("src/services/tenant-runtime.service.ts"),
    ];
    for (const schema of functionSources) {
      const start = schema.indexOf(
        "CREATE OR REPLACE FUNCTION public.set_request_context()",
      );
      const securityClause = "$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog;";
      const end = schema.indexOf(securityClause, start);

      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);

      const fnBody = schema.slice(start, end);
      expect(fnBody).toContain(
        "PERFORM set_config('request.jwt.claim.sub', coalesce(claims ->> 'sub', ''), true);",
      );
      expect(fnBody).toContain(
        "PERFORM set_config('request.jwt.claim.email', coalesce(claims ->> 'email', ''), true);",
      );
      expect(fnBody).toContain(
        "PERFORM set_config('request.jwt.claim.role', role_claim, true);",
      );
      expect(fnBody).not.toContain("SET LOCAL ROLE");
      expect(fnBody).not.toContain("LANGUAGE plpgsql STABLE SECURITY DEFINER");
      expect(schema.slice(start, end + securityClause.length)).toContain(securityClause);
    }

    for (const filePath of [
      "src/services/tenant-runtime-migration.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ]) {
      expect(readRepoFile(filePath)).toContain('${SQL_MODULES["postgrest-request-context"]}');
    }
  });

  test("tenant migrations reuse the fail-closed realtime auto-attach module", () => {
    const autoAttachSql = SQL_MODULES["realtime-auto-attach-trigger"];

    for (const filePath of [
      "src/services/tenant-runtime-migration.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ]) {
      expect(readRepoFile(filePath)).toContain(
        '${SQL_MODULES["realtime-auto-attach-trigger"]}',
      );
    }

    expect(ALTER_TENANT_SQL).toContain(autoAttachSql);
    expect(autoAttachSql).toContain(
      "ddl.classid = 'pg_catalog.pg_class'::pg_catalog.regclass",
    );
    expect(autoAttachSql).toContain("AND NOT ddl.in_extension");
    expect(autoAttachSql).toContain("AND n.nspname = 'public'");
    expect(autoAttachSql).toContain("AND c.relkind IN ('r', 'p')");
    expect(autoAttachSql).toContain("AND NOT c.relispartition");
    expect(autoAttachSql).toContain("GROUP BY c.oid, n.nspname, c.relname");
    expect(autoAttachSql).toContain("ON %I.%I");
    expect(autoAttachSql).toContain(
      "LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog",
    );
    expect(autoAttachSql).not.toContain("DROP TRIGGER");
    expect(autoAttachSql).not.toContain("WHEN duplicate_object");
    expect(autoAttachSql).not.toContain("WHEN OTHERS");
  });

  test("all realtime trigger generators reuse the byte-safe notify module", () => {
    const notifyPayloadSql = SQL_MODULES["realtime-notify-payload"];
    const migrationPaths = [
      "src/services/tenant-runtime-migration.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ];

    expect(notifyPayloadSql).toContain("payload_text text := payload::text");
    expect(notifyPayloadSql).toContain("octet_length(payload_text) >= 8000");
    expect(notifyPayloadSql).toContain(
      "pg_catalog.pg_notify('realtime_changes', payload_text)",
    );
    expect(notifyPayloadSql).toContain("WHEN SQLSTATE '22023' THEN RETURN");
    expect(notifyPayloadSql).toContain(
      "LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog",
    );
    expect(notifyPayloadSql).not.toContain("SECURITY DEFINER");
    expect(notifyPayloadSql).not.toContain("WHEN OTHERS");

    for (const filePath of migrationPaths) {
      const migrationSource = readRepoFile(filePath);
      expect(migrationSource).toContain('${SQL_MODULES["realtime-notify-payload"]}');
      expect(migrationSource).toContain("PERFORM realtime.notify_change_payload(payload)");
      expect(migrationSource).not.toContain(
        "PERFORM pg_notify('realtime_changes', payload::text)",
      );
    }

    expect(ALTER_TENANT_SQL).toContain(notifyPayloadSql);

    const realtimeBunSource = readRepoFile("src/services/realtime-bun.service.ts");
    expect(realtimeBunSource).toContain('${SQL_MODULES["realtime-notify-payload"]}');
    expect(realtimeBunSource).toContain("PERFORM realtime.notify_change_payload(payload)");
    const realtimeBunTriggerStart = realtimeBunSource.indexOf(
      "CREATE OR REPLACE FUNCTION realtime_supacloud_notify()",
    );
    const realtimeBunTriggerEnd = realtimeBunSource.indexOf(
      "$$ LANGUAGE plpgsql SECURITY INVOKER;",
      realtimeBunTriggerStart,
    );
    expect(realtimeBunTriggerStart).toBeGreaterThanOrEqual(0);
    expect(realtimeBunTriggerEnd).toBeGreaterThan(realtimeBunTriggerStart);
    expect(realtimeBunSource).not.toContain(
      "PERFORM pg_notify('realtime_changes', payload::text)",
    );

    const initialSchema = readRepoFile("src/db/schemas/supabase.sql");
    expect(initialSchema).toContain(notifyPayloadSql);
  });

  test("auth helpers preserve claims-only user identity for modern PostgREST", () => {
    for (const schema of [
      SQL_MODULES["auth-jwt-helpers"],
      ALTER_TENANT_SQL,
      readRepoFile("src/db/schemas/supabase.sql"),
    ]) {
      const helperStart = schema.lastIndexOf("CREATE OR REPLACE FUNCTION auth.uid()");
      const helperEnd = schema.indexOf("$$ LANGUAGE plpgsql STABLE;", helperStart);
      const helperBody = schema.slice(helperStart, helperEnd);

      expect(helperStart).toBeGreaterThanOrEqual(0);
      expect(helperEnd).toBeGreaterThan(helperStart);
      expect(helperBody).toContain("current_setting('request.jwt.claim.sub', true)");
      expect(helperBody).toContain("current_setting('request.jwt.claims', true)");
      expect(helperBody).toContain("->> 'sub'");
      expect(schema).toContain("CREATE OR REPLACE FUNCTION auth.jwt()");
      expect(schema).toContain("CREATE OR REPLACE FUNCTION auth.role()");
    }

    for (const filePath of [
      "src/services/tenant-runtime-migration.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ]) {
      expect(readRepoFile(filePath)).toContain('${SQL_MODULES["auth-jwt-helpers"]}');
    }
  });

  test("tenant schema migration adds columns before dependent indexes", () => {
    for (const filePath of [
      "src/services/tenant-runtime-migration.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ]) {
      const source = readRepoFile(filePath);
      const userIdAlter = source.indexOf(
        "ALTER TABLE auth.one_time_tokens ADD COLUMN IF NOT EXISTS user_id",
      );
      const userIdIndex = source.indexOf(
        "CREATE UNIQUE INDEX IF NOT EXISTS one_time_tokens_user_id_token_type_key",
      );

      expect(userIdAlter).toBeGreaterThanOrEqual(0);
      expect(userIdIndex).toBeGreaterThanOrEqual(0);
      expect(userIdAlter).toBeLessThan(userIdIndex);
    }
  });

  test("tenant migration preserves complete legacy migration ledger metadata", () => {
    const runtimeMigration = readFileSync(
      new URL("../../src/services/tenant-runtime-migration.ts", import.meta.url),
      "utf8",
    );
    const scriptMigration = readFileSync(
      new URL("../../src/scripts/migrate-tenant-schema.ts", import.meta.url),
      "utf8",
    );

    for (const source of [runtimeMigration, scriptMigration]) {
      expect(source).toContain("SELECT version::text, statements, name, checksum, inserted_at");
      expect(source).toContain("canonical.checksum IS NULL");
      expect(source).not.toContain("SELECT version, version FROM public.schema_migrations");
    }
  });

  test("normalizes the MFA AMR primary key name expected by GoTrue migrations", () => {
    for (const filePath of [
      "src/services/tenant-runtime-migration.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ]) {
      const source = readRepoFile(filePath);
      const start = source.indexOf(
        "-- auth.mfa_amr_claims: add id and factor_id columns",
      );
      const end = source.indexOf("-- auth.sessions:", start);
      const migration = source.slice(start, end);

      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      expect(migration).toContain(
        "ADD CONSTRAINT amr_id_pk PRIMARY KEY (id)",
      );
      expect(migration).toContain("RENAME CONSTRAINT %I TO amr_id_pk");
      expect(migration).toContain("contype = 'p'");
      expect(migration).not.toContain(
        "ADD CONSTRAINT mfa_amr_claims_pkey PRIMARY KEY (id)",
      );
    }
  });

  test("keeps GoTrue authoritative for auth.users while retaining task mirrors", () => {
    for (const source of [
      SQL_MODULES["background-task-mirror-up"],
      ALTER_TENANT_SQL,
      readRepoFile("../../scripts/004_background_task_mirror_migration.sql"),
    ]) {
      expect(source).toContain("CREATE TABLE IF NOT EXISTS public.background_task_mirrors");
      expect(source).toContain("DROP TRIGGER IF EXISTS auth_users_delete_fence ON auth.users;");
      expect(source).not.toContain("CREATE TRIGGER auth_users_delete_fence");
      expect(source).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+auth\.users/i);
      expect(source).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(?:soft_delete_user_if_no_active_tasks|hard_delete_soft_deleted_users|has_active_background_tasks)/i);
    }

    for (const filePath of [
      "src/services/tenant-runtime-migration.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ]) {
      expect(readRepoFile(filePath)).toContain('${SQL_MODULES["background-task-mirror-up"]}');
    }

    const rollback = SQL_MODULES["background-task-mirror-down"];
    expect(rollback).toContain("DROP TABLE IF EXISTS public.background_task_mirrors;");
    expect(rollback).not.toContain("CREATE TRIGGER auth_users_delete_fence");
    expect(rollback).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+auth\.users/i);

    const pigstyUpgrade = readRepoFile("../../scripts/upgrade_pigsty_4_4_compat.sh");
    expect(pigstyUpgrade).toContain("apply_background_task_mirror_compat");
    expect(pigstyUpgrade).toContain("check_background_task_mirror_compat");
    expect(pigstyUpgrade).toContain("supacloud:pigsty-4.4-background-task-mirror:v3");
    expect(pigstyUpgrade).toContain(
      "-- supacloud:sql-module:background-task-mirror-up:start",
    );
    expect(pigstyUpgrade).toContain("to_regprocedure('public.soft_delete_user_if_no_active_tasks()') IS NOT NULL");
    expect(pigstyUpgrade).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+auth\.users/i);
  });

  test("tenant auth bootstrap reuses the canonical JWT helper module", () => {
    const runtimeSource = readRepoFile("src/services/tenant-runtime.service.ts");
    expect(runtimeSource).toContain('${SQL_MODULES["auth-jwt-helpers"]}');
    expect(runtimeSource).not.toContain(
      "CREATE OR REPLACE FUNCTION auth.uid() returns uuid as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;",
    );
  });

  test("one_time_tokens user_id migration adds the foreign key separately", () => {
    for (const filePath of [
      "src/services/tenant-runtime-migration.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ]) {
      const source = readRepoFile(filePath);

      expect(source).toContain(
        "ALTER TABLE auth.one_time_tokens ADD COLUMN IF NOT EXISTS user_id UUID;",
      );
      expect(source).not.toContain(
        "ALTER TABLE auth.one_time_tokens ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users",
      );
      expect(source).toContain("c.confrelid = 'auth.users'::regclass");
      expect(source).toContain(
        "c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'auth.one_time_tokens'::regclass AND attname = 'user_id')]",
      );
      expect(source).toContain(
        "FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE",
      );
    }
  });

  test("tenant runtime migration stops on psql errors", () => {
    const source = readRepoFile("src/services/tenant-runtime.service.ts");

    expect(source).toContain("-v ON_ERROR_STOP=1");
    expect(source).toContain("throw new Error(`psql exited with code");
  });

  test("one_time_tokens/graphql runtime migration stops on psql errors", () => {
    const source = readRepoFile("src/services/tenant-runtime.service.ts");
    const start = source.indexOf("private async ensureOneTimeTokensAndGraphQL");
    const end = source.indexOf("private async ensurePostgrestPrerequest", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const migrationBody = source.slice(start, end);
    expect(migrationBody).toContain("-v ON_ERROR_STOP=1");
    expect(migrationBody).toContain("throw new Error(`psql exited with code");
  });

  test("PostgREST repair path reapplies pre-request function", () => {
    const source = readRepoFile("src/services/tenant-runtime.service.ts");
    const prerequestStart = source.indexOf("private async ensurePostgrestPrerequest");
    const prerequestEnd = source.indexOf("public async startRuntime", prerequestStart);
    const prepareStart = source.indexOf("private async preparePostgrestRuntime");
    const prepareEnd = source.indexOf("private async persistPostgrestObservation", prepareStart);

    expect(prerequestStart).toBeGreaterThanOrEqual(0);
    expect(prerequestEnd).toBeGreaterThan(prerequestStart);
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(prepareEnd).toBeGreaterThan(prepareStart);

    const prerequestBody = source.slice(prerequestStart, prerequestEnd);
    const prepareBody = source.slice(prepareStart, prepareEnd);
    expect(prerequestBody).toContain("-v ON_ERROR_STOP=1");
    expect(prerequestBody).toContain("throw new Error(`psql exited with code");
    expect(prepareBody).toContain("await this.ensureTenantSchemaMigrations(ref);");
    expect(prepareBody).toContain("await this.ensurePostgrestPrerequest(");
    expect(prepareBody).toContain("jwtPolicy.thirdPartyJwtPolicy");
    expect(prepareBody).toContain("jwtPolicy.localJwtIssuer");
  });

  test("project service status accepts the deployed Realtime container fallback", () => {
    const source = readRepoFile("src/services/tenant-runtime.service.ts");

    expect(source).toContain("private async checkContainerService");
    expect(source).toContain('container: "supacloud-realtime"');
    expect(source).toContain('typeof containerName !== "string"');
    expect(source).toContain("return this.checkContainerService(containerName);");
  });

  test("graphql fallback does not replace an existing pg_graphql RPC", () => {
    for (const filePath of [
      "src/db/schemas/supabase.sql",
      "src/services/tenant-runtime.service.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ]) {
      const source = readRepoFile(filePath);

      expect(source).not.toContain(
        "CREATE OR REPLACE FUNCTION graphql_public.graphql",
      );
      expect(source).toContain(
        "to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)')",
      );
      expect(source).toContain("extensions jsonb DEFAULT NULL");
    }
  });

  test("tenant schema exposes Supabase Queues PGMQ public RPCs", () => {
    for (const source of [
      SQL_MODULES["pgmq-public"],
      readRepoFile("src/db/schemas/supabase.sql"),
    ]) {
      expect(source).toContain("CREATE EXTENSION IF NOT EXISTS pgmq");
      expect(source).toContain("CREATE SCHEMA IF NOT EXISTS pgmq_public");
      expect(source).toContain("CREATE OR REPLACE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)");
      expect(source).toContain("CREATE OR REPLACE FUNCTION pgmq_public.pop(queue_name text)");
      expect(source).toContain('CREATE OR REPLACE FUNCTION pgmq_public."delete"(queue_name text, message_id bigint)');
      expect(source).toContain("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq_public TO anon, authenticated, service_role");
    }

    for (const filePath of [
      "src/services/tenant-runtime.service.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ]) {
      expect(readRepoFile(filePath)).toContain('${SQL_MODULES["pgmq-public"]}');
    }
  });

  test("tenant auth schema stops creating WebAuthn artifacts without destructive cleanup", () => {
    for (const filePath of [
      "src/db/schemas/supabase.sql",
      "src/services/tenant-runtime-migration.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ]) {
      const source = readRepoFile(filePath);

      expect(source).not.toContain("CREATE TABLE IF NOT EXISTS auth.webauthn_credentials");
      expect(source).not.toContain("CREATE TABLE IF NOT EXISTS auth.webauthn_challenges");
      expect(source).not.toContain("ADD COLUMN IF NOT EXISTS web_authn_credential");
      expect(source).not.toContain("ADD COLUMN IF NOT EXISTS web_authn_aaguid");
      expect(source).not.toContain("ADD COLUMN IF NOT EXISTS last_webauthn_challenge_data");
      expect(source).not.toMatch(/DROP\s+(?:TABLE|COLUMN).*web_?authn/i);
      expect(source).toContain("CREATE TABLE IF NOT EXISTS auth.mfa_factors");
    }
  });

  test("new public tables are not exposed to the Data API by default", () => {
    const schema = readRepoFile("src/db/schemas/supabase.sql");
    const databaseService = readRepoFile("src/services/database.service.ts");

    for (const source of [schema, databaseService]) {
      expect(source).not.toMatch(/ALTER DEFAULT PRIVILEGES(?: FOR ROLE postgres)? IN SCHEMA public GRANT .* TO .*anon/i);
      expect(source).not.toMatch(/ALTER DEFAULT PRIVILEGES(?: FOR ROLE postgres)? IN SCHEMA public GRANT .* TO .*authenticated/i);
      expect(source).not.toMatch(/ALTER DEFAULT PRIVILEGES(?: FOR ROLE postgres)? IN SCHEMA public GRANT .* TO .*service_role/i);
    }
    expect(schema).toContain("Tenants must grant anon/authenticated/service_role privileges explicitly in migrations.");
  });

  test("PostgREST tenant config keeps pgmq_public out of safe defaults", () => {
    for (const filePath of [
      "../../docker/dev/docker-compose.yml",
      "../../docker/self-host/docker-compose.yml",
      "../../docker/self-host/.env.example",
      "../../docker/self-host/init-env.py",
    ]) {
      const source = readRepoFile(filePath);
      expect(source).toContain("public,storage,graphql_public");
      expect(source).not.toContain("public,storage,graphql_public,pgmq_public");
    }
  });

  test("tenant runtime only exposes pgmq_public after detecting wrapper schema", () => {
    for (const filePath of [
      "src/services/tenant-runtime.service.ts",
      "../../scripts/lib/tenant_runtime.sh",
    ]) {
      const source = readRepoFile(filePath);
      expect(source).toContain("pgmq_public");
    }
  });

  test("self-host postgres image installs and bootstraps PGMQ", () => {
    const dockerfile = readRepoFile("../../docker/self-host/postgres/Dockerfile");
    const bootstrap = readRepoFile("../../docker/self-host/postgres/initdb/01-bootstrap-extensions.sql");

    expect(dockerfile).toContain("postgresql-18-pgmq");
    expect(bootstrap).toContain("'pgmq'");
  });

  test("tenant schema migration creates realtime schema before realtime objects", () => {
    for (const filePath of [
      "src/services/tenant-runtime-migration.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ]) {
      const source = readRepoFile(filePath);
      const schema = source.indexOf("CREATE SCHEMA IF NOT EXISTS realtime;");
      const messages = source.indexOf("CREATE TABLE IF NOT EXISTS realtime.messages");
      const notifyFn = source.indexOf(
        "CREATE OR REPLACE FUNCTION realtime.notify_postgres_changes()",
      );

      expect(schema).toBeGreaterThanOrEqual(0);
      expect(messages).toBeGreaterThan(schema);
      expect(notifyFn).toBeGreaterThan(schema);
    }
  });

  test("AoristCross initial schema includes task queue compatibility patch", () => {
    const initialSchema = readFileSync(
      resolve(import.meta.dir, "../../../../scripts/001_initial_schema.sql"),
      "utf8",
    );
    const compatibilityPatch = readFileSync(
      resolve(import.meta.dir, "../../../../scripts/002_tasks_queue_schema_patch.sql"),
      "utf8",
    );

    for (const source of [initialSchema, compatibilityPatch]) {
      expect(source).toContain("payload");
      expect(source).toContain("'crop'");
      expect(source).toContain("'matting'");
      expect(source).toContain("'cancelled'");
      expect(source).toContain("idx_tasks_user_created_desc");
      expect(source).toContain("idx_tasks_user_status_created_desc");
    }
  });
});

describe("storage RLS policies and grants", () => {
  test("supabase.sql grants restrict anon to SELECT on storage tables", () => {
    const schema = readRepoFile("src/db/schemas/supabase.sql");
    // anon should only have SELECT on storage tables, not ALL (INSERT/UPDATE/DELETE)
    const anonStorageGrantMatch = schema.match(/GRANT\s+(\w+(?:\s*,\s*\w+)*)\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+storage\s+TO\s+anon/i);
    expect(anonStorageGrantMatch).not.toBeNull();
    const grantedActions = anonStorageGrantMatch![1].toUpperCase().replace(/\s+/g, "");
    expect(grantedActions).toBe("SELECT");
  });

  test("supabase.sql grants service_role full DML on storage tables", () => {
    const schema = readRepoFile("src/db/schemas/supabase.sql");
    const serviceRoleGrantMatch = schema.match(/GRANT\s+ALL\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+storage\s+TO\s+service_role/i);
    expect(serviceRoleGrantMatch).not.toBeNull();
  });

  test("supabase.sql grants authenticated full DML on storage tables (constrained by RLS)", () => {
    const schema = readRepoFile("src/db/schemas/supabase.sql");
    const authGrantMatch = schema.match(/GRANT\s+ALL\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+storage\s+TO\s+authenticated/i);
    expect(authGrantMatch).not.toBeNull();
  });

  test("supabase.sql enables RLS on storage.objects and multipart uploads", () => {
    const schema = readRepoFile("src/db/schemas/supabase.sql");
    expect(schema).toContain("ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY");
    expect(schema).toContain("ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY");
    expect(schema).toContain("ALTER TABLE storage.s3_multipart_uploads ENABLE ROW LEVEL SECURITY");
    expect(schema).toContain("ALTER TABLE storage.s3_multipart_uploads_parts ENABLE ROW LEVEL SECURITY");
  });

  test("auth.uid helper is created before storage policies reference it", () => {
    const schema = readRepoFile("src/db/schemas/supabase.sql");
    const helperIndex = schema.indexOf("CREATE OR REPLACE FUNCTION auth.uid()");
    const policyIndex = schema.indexOf("Allow authenticated read on storage.objects");
    expect(helperIndex).toBeGreaterThanOrEqual(0);
    expect(policyIndex).toBeGreaterThan(helperIndex);
  });

  test("supabase.sql creates storage.objects RLS policies for public read and authenticated CRUD", () => {
    const schema = readRepoFile("src/db/schemas/supabase.sql");
    // Public read from public buckets
    expect(schema).toContain("Allow public read on storage.objects");
    expect(schema).toContain("bucket_id IN (SELECT id FROM storage.buckets WHERE public = true)");
    // Authenticated users can read and write only their own private objects by default
    expect(schema).toContain("Allow authenticated read on storage.objects");
    expect(schema).toContain("FOR SELECT TO authenticated USING (auth.uid() = owner)");
    // Authenticated insert
    expect(schema).toContain("Allow authenticated insert on storage.objects");
    expect(schema).toContain("FOR INSERT TO authenticated WITH CHECK (bucket_id IN (SELECT id FROM storage.buckets) AND auth.uid() = owner)");
    // Authenticated update (owner check)
    expect(schema).toContain("Allow authenticated update on storage.objects");
    expect(schema).toContain("auth.uid() = owner");
    // Authenticated delete (owner check)
    expect(schema).toContain("Allow authenticated delete on storage.objects");
  });

  test("supabase.sql scopes multipart upload policies to the authenticated owner", () => {
    const schema = readRepoFile("src/db/schemas/supabase.sql");
    expect(schema).toContain("FOR ALL TO authenticated USING (owner_id = auth.uid()::text) WITH CHECK (owner_id = auth.uid()::text)");
  });

  test("supabase.sql does not grant anon ALL on storage tables (tightened)", () => {
    const schema = readRepoFile("src/db/schemas/supabase.sql");
    // This pattern should NOT appear anymore — anon gets only SELECT
    expect(schema).not.toMatch(/GRANT\s+ALL\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+storage\s+TO\s+anon/i);
  });
});

describe("storage RLS migration for existing tenants", () => {
  test("migrate-tenant-schema creates storage.objects RLS policies with idempotent DO $$ blocks", () => {
    const source = readRepoFile("src/scripts/migrate-tenant-schema.ts");
    // Each policy should be wrapped in DO $$ ... EXCEPTION WHEN duplicate_object
    const policyNames = [
      "Public buckets are viewable by everyone.",
      "Authenticated users can view all buckets.",
      "Allow public read on storage.objects",
      "Allow authenticated read on storage.objects",
      "Allow authenticated insert on storage.objects",
      "Allow authenticated update on storage.objects",
      "Allow authenticated delete on storage.objects",
      "Allow authenticated multipart uploads",
      "Allow authenticated multipart upload parts",
    ];
    for (const policyName of policyNames) {
      expect(source).toContain(policyName);
      // Verify the EXCEPTION WHEN duplicate_object guard exists for this policy
      const policyIdx = source.indexOf(`"${policyName}"`);
      const exceptionIdx = source.indexOf("EXCEPTION WHEN duplicate_object THEN NULL; END $$;", policyIdx);
      expect(exceptionIdx).toBeGreaterThan(policyIdx);
    }
  });

  test("migrate-tenant-schema tightens anon storage grants to SELECT only", () => {
    const source = readRepoFile("src/scripts/migrate-tenant-schema.ts");
    expect(source).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA storage FROM anon");
    expect(source).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA storage TO anon");
  });

  test("migrate-tenant-schema ensures service_role and authenticated have full DML on storage", () => {
    const source = readRepoFile("src/scripts/migrate-tenant-schema.ts");
    expect(source).toContain("GRANT ALL ON ALL TABLES IN SCHEMA storage TO service_role");
    expect(source).toContain("GRANT ALL ON ALL TABLES IN SCHEMA storage TO authenticated");
  });

  test("migrate-tenant-schema enables RLS on multipart upload tables", () => {
    const source = readRepoFile("src/scripts/migrate-tenant-schema.ts");
    expect(source).toContain("ALTER TABLE storage.s3_multipart_uploads ENABLE ROW LEVEL SECURITY");
    expect(source).toContain("ALTER TABLE storage.s3_multipart_uploads_parts ENABLE ROW LEVEL SECURITY");
  });
});
