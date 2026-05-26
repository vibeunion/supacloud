import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(import.meta.dir, "../..", relativePath), "utf8");
}

describe("supabase bootstrap schema", () => {
  test("does not switch SQL role inside set_request_context", () => {
    const schema = readRepoFile("src/db/schemas/supabase.sql");
    const start = schema.indexOf(
      "CREATE OR REPLACE FUNCTION public.set_request_context()",
    );
    const end = schema.indexOf("$$ LANGUAGE plpgsql SECURITY DEFINER;", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const fnBody = schema.slice(start, end);
    expect(fnBody).toContain(
      "PERFORM set_config('request.jwt.claim.role', role_claim, true);",
    );
    expect(fnBody).not.toContain("SET LOCAL ROLE");
  });

  test("tenant schema migration adds columns before dependent indexes", () => {
    for (const filePath of [
      "src/services/tenant-runtime.service.ts",
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

  test("one_time_tokens user_id migration adds the foreign key separately", () => {
    for (const filePath of [
      "src/services/tenant-runtime.service.ts",
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
    for (const filePath of [
      "src/db/schemas/supabase.sql",
      "src/services/tenant-runtime.service.ts",
      "src/scripts/migrate-tenant-schema.ts",
    ]) {
      const source = readRepoFile(filePath);

      expect(source).toContain("CREATE EXTENSION IF NOT EXISTS pgmq");
      expect(source).toContain("CREATE SCHEMA IF NOT EXISTS pgmq_public");
      expect(source).toContain("CREATE OR REPLACE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)");
      expect(source).toContain("CREATE OR REPLACE FUNCTION pgmq_public.pop(queue_name text)");
      expect(source).toContain('CREATE OR REPLACE FUNCTION pgmq_public."delete"(queue_name text, message_id bigint)');
      expect(source).toContain("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq_public TO anon, authenticated, service_role");
    }
  });

  test("PostgREST tenant config exposes pgmq_public for supabase-js schema rpc", () => {
    for (const filePath of [
      "src/services/tenant-runtime.service.ts",
      "../../scripts/lib/tenant_runtime.sh",
      "../../docker/self-host/docker-compose.yml",
      "../../docker/self-host/.env.example",
      "../../docker/self-host/init-env.py",
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
      "src/services/tenant-runtime.service.ts",
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
