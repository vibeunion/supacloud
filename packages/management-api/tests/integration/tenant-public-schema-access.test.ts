import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { TENANT_PUBLIC_SCHEMA_ACCESS_SQL } from "../../src/services/tenant-public-schema-access";

// Opt in to an explicitly selected local PostgreSQL container; never discover a
// server or reuse the management service's DATABASE_URL for this DDL fixture.
const container = process.env.SUPACLOUD_TEST_PG_CONTAINER;
const postgresTests = container ? describe : describe.skip;

postgresTests("tenant runtime application ACL preservation (PostgreSQL)", () => {
  test("repeated maintenance preserves least privilege and explicitly granted commands", () => {
    const sql = `
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;
CREATE SCHEMA tenant_acl_fixture;
CREATE TABLE public.tenant_acl_fixture_records(id bigint PRIMARY KEY);
CREATE SEQUENCE public.tenant_acl_fixture_sequence;
CREATE FUNCTION public.tenant_acl_fixture_internal() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION public.tenant_acl_fixture_command() RETURNS integer LANGUAGE sql AS $$ SELECT 2 $$;
REVOKE ALL ON TABLE public.tenant_acl_fixture_records FROM PUBLIC, service_role;
GRANT SELECT ON TABLE public.tenant_acl_fixture_records TO service_role;
REVOKE ALL ON SEQUENCE public.tenant_acl_fixture_sequence FROM PUBLIC, service_role;
GRANT USAGE ON SEQUENCE public.tenant_acl_fixture_sequence TO service_role;
REVOKE ALL ON FUNCTION public.tenant_acl_fixture_internal() FROM PUBLIC, service_role;
REVOKE ALL ON FUNCTION public.tenant_acl_fixture_command() FROM PUBLIC, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_acl_fixture_command() TO service_role;
CREATE FUNCTION tenant_acl_fixture.permissions() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'select', has_table_privilege('service_role', 'public.tenant_acl_fixture_records', 'SELECT'),
    'insert', has_table_privilege('service_role', 'public.tenant_acl_fixture_records', 'INSERT'),
    'update', has_table_privilege('service_role', 'public.tenant_acl_fixture_records', 'UPDATE'),
    'delete', has_table_privilege('service_role', 'public.tenant_acl_fixture_records', 'DELETE'),
    'truncate', has_table_privilege('service_role', 'public.tenant_acl_fixture_records', 'TRUNCATE'),
    'references', has_table_privilege('service_role', 'public.tenant_acl_fixture_records', 'REFERENCES'),
    'trigger', has_table_privilege('service_role', 'public.tenant_acl_fixture_records', 'TRIGGER'),
    'sequenceUsage', has_sequence_privilege('service_role', 'public.tenant_acl_fixture_sequence', 'USAGE'),
    'sequenceSelect', has_sequence_privilege('service_role', 'public.tenant_acl_fixture_sequence', 'SELECT'),
    'sequenceUpdate', has_sequence_privilege('service_role', 'public.tenant_acl_fixture_sequence', 'UPDATE'),
    'internal', has_function_privilege('service_role', 'public.tenant_acl_fixture_internal()', 'EXECUTE'),
    'command', has_function_privilege('service_role', 'public.tenant_acl_fixture_command()', 'EXECUTE')
  )
$$;
SELECT tenant_acl_fixture.permissions();
${TENANT_PUBLIC_SCHEMA_ACCESS_SQL}
SELECT tenant_acl_fixture.permissions();
${TENANT_PUBLIC_SCHEMA_ACCESS_SQL}
SELECT tenant_acl_fixture.permissions();
ROLLBACK;
`;
    const result = spawnSync("docker", ["exec", "-i", container!, "psql", "-X", "-qAt",
      "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], {
      input: sql, encoding: "utf8", timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const rows = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      select: true, insert: false, update: false, delete: false, truncate: false,
      references: false, trigger: false, sequenceUsage: true, sequenceSelect: false,
      sequenceUpdate: false, internal: false, command: true,
    });
    expect(rows[1]).toEqual(rows[0]);
    expect(rows[2]).toEqual(rows[0]);
  }, 35_000);
});
