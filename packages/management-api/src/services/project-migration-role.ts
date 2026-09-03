import { assertValidDbName, assertValidIdentifier } from "../utils/validation";

interface MigrationAdminSql {
  unsafe(statement: string): Promise<unknown>;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteLiteral(literal: string): string {
  return `'${literal.replace(/'/g, "''")}'`;
}

export function renderProjectMigrationRoleSql(dbName: string, dbUser: string): string {
  assertValidDbName("dbName", dbName);
  assertValidIdentifier("dbUser", dbUser);
  const quotedDatabase = quoteIdentifier(dbName);
  const quotedUser = quoteIdentifier(dbUser);
  const userLiteral = quoteLiteral(dbUser);

  return `
    GRANT CREATE ON DATABASE ${quotedDatabase} TO ${quotedUser};
    -- 迁移 SQL 经 sql-policy 特权扫描后由服务端在受控事务 + ledger lease 中执行，
    -- 不开放客户端直达面；平台表（如 storage.buckets）启用 RLS，迁移角色需要
    -- BYPASSRLS 才能初始化项目私有的平台对象。ALTER ROLE 幂等，重复执行无副作用。
    ALTER ROLE ${quotedUser} BYPASSRLS;
    ALTER SCHEMA public OWNER TO ${quotedUser};
    GRANT USAGE ON SCHEMA supabase_migrations TO ${quotedUser};
    REVOKE ALL ON TABLE supabase_migrations.schema_migrations FROM PUBLIC, anon, authenticated, service_role, ${quotedUser};
    REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC, anon, authenticated, service_role, ${quotedUser};
    GRANT SELECT ON TABLE supabase_migrations.schema_migrations TO ${quotedUser};
    GRANT SELECT ON TABLE public.schema_migrations TO ${quotedUser};
    CREATE TABLE IF NOT EXISTS supabase_migrations.migration_ledger_leases (
      token_hash TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      checksum TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    REVOKE ALL ON TABLE supabase_migrations.migration_ledger_leases
      FROM PUBLIC, anon, authenticated, service_role, ${quotedUser};
    DROP FUNCTION IF EXISTS supabase_migrations.record_schema_migration(TEXT, TEXT[], TEXT, TEXT);
    CREATE OR REPLACE FUNCTION supabase_migrations.record_schema_migration(
      migration_version TEXT,
      migration_statements TEXT[],
      migration_name TEXT,
      migration_checksum TEXT,
      migration_token TEXT
    ) RETURNS VOID
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $record_migration$
    DECLARE
      applied_at TIMESTAMPTZ := clock_timestamp();
      lease_consumed BOOLEAN := FALSE;
    BEGIN
      DELETE FROM supabase_migrations.migration_ledger_leases
      WHERE token_hash = encode(sha256(convert_to(migration_token, 'UTF8')), 'hex')
        AND version = migration_version
        AND checksum = migration_checksum
        AND expires_at > applied_at
      RETURNING TRUE INTO lease_consumed;
      IF lease_consumed IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Invalid or expired migration ledger lease'
          USING ERRCODE = '42501';
      END IF;
      INSERT INTO supabase_migrations.schema_migrations
        (version, statements, name, checksum, inserted_at)
      VALUES
        -- 线上台账表的 version 可能是 bigint（Supabase CLI 约定）或 text，
        -- ::bigint 在两种列类型下均可写入（bigint→text 为赋值转换）。
        (migration_version::bigint, migration_statements, migration_name, migration_checksum, applied_at);
      INSERT INTO public.schema_migrations
        (version, statements, name, checksum, inserted_at)
      VALUES
        (migration_version::bigint, migration_statements, migration_name, migration_checksum, applied_at);
    END
    $record_migration$;
    REVOKE ALL ON FUNCTION supabase_migrations.record_schema_migration(TEXT, TEXT[], TEXT, TEXT, TEXT)
      FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION supabase_migrations.record_schema_migration(TEXT, TEXT[], TEXT, TEXT, TEXT)
      TO ${quotedUser};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedUser} IN SCHEMA public
      GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedUser} IN SCHEMA public
      GRANT ALL ON SEQUENCES TO service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedUser} IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO service_role;
    DO $migration_owner$
    DECLARE
      object_row RECORD;
      routine_kind TEXT;
    BEGIN
      FOR object_row IN
        SELECT c.relkind, n.nspname, c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname <> 'schema_migrations'
          AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
          AND pg_get_userbyid(c.relowner) <> ${userLiteral}
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.classid = 'pg_class'::regclass
              AND d.objid = c.oid
              AND d.deptype = 'e'
          )
        ORDER BY CASE WHEN c.relkind = 'S' THEN 1 ELSE 0 END, c.oid
      LOOP
        routine_kind := CASE object_row.relkind
          WHEN 'S' THEN 'SEQUENCE'
          WHEN 'v' THEN 'VIEW'
          WHEN 'm' THEN 'MATERIALIZED VIEW'
          WHEN 'f' THEN 'FOREIGN TABLE'
          ELSE 'TABLE'
        END;
        EXECUTE format(
          'ALTER %s %I.%I OWNER TO %I',
          routine_kind,
          object_row.nspname,
          object_row.relname,
          ${userLiteral}
        );
      END LOOP;

      FOR object_row IN
        SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
               CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END AS routine_kind
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND pg_get_userbyid(p.proowner) <> ${userLiteral}
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.classid = 'pg_proc'::regclass
              AND d.objid = p.oid
              AND d.deptype = 'e'
          )
      LOOP
        EXECUTE format(
          'ALTER %s %I.%I(%s) OWNER TO %I',
          object_row.routine_kind,
          object_row.nspname,
          object_row.proname,
          object_row.arguments,
          ${userLiteral}
        );
      END LOOP;

      FOR object_row IN
        SELECT n.nspname, t.typname
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typtype IN ('c', 'd', 'e', 'r', 'm')
          AND (
            t.typrelid = 0
            OR EXISTS (
              SELECT 1 FROM pg_class type_relation
              WHERE type_relation.oid = t.typrelid
                AND type_relation.relkind = 'c'
            )
          )
          AND pg_get_userbyid(t.typowner) <> ${userLiteral}
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.classid = 'pg_type'::regclass
              AND d.objid = t.oid
              AND d.deptype = 'e'
          )
      LOOP
        EXECUTE format(
          'ALTER TYPE %I.%I OWNER TO %I',
          object_row.nspname,
          object_row.typname,
          ${userLiteral}
        );
      END LOOP;
    END
    $migration_owner$;
  `;
}

export async function prepareProjectMigrationRole(
  adminDb: MigrationAdminSql,
  dbName: string,
  dbUser: string,
): Promise<void> {
  await adminDb.unsafe(renderProjectMigrationRoleSql(dbName, dbUser));
}
