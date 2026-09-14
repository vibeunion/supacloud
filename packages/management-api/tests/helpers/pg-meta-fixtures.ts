import type { Static } from "@sinclair/typebox";
import type { pgMetaRowSchemas } from "../../src/utils/pg-meta-contract";

export const pgMetaFixtures: {
  [K in keyof typeof pgMetaRowSchemas]: Static<(typeof pgMetaRowSchemas)[K]>
} = {
  tables: {
    schemaname: "public", tablename: "users", tableowner: "fixture", tablespace: null,
    hasindexes: true, hasrules: false, hastriggers: false,
  },
  columns: {
    table_schema: "public", table_name: "users", column_name: "id",
    ordinal_position: 1, data_type: "integer", udt_name: "int4", is_nullable: "NO",
    column_default: null, character_maximum_length: null, numeric_precision: 32,
  },
  indexes: {
    schemaname: "public", tablename: "users", indexname: "users_pkey",
    indexdef: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
  },
  roles: {
    rolname: "fixture", rolsuper: false, rolinherit: true, rolcreaterole: false,
    rolcreatedb: false, rolcanlogin: true, rolreplication: false, rolconnlimit: -1,
  },
  schemas: { schema_name: "public", schema_owner: "fixture", table_count: 0 },
  functions: {
    schema_name: "public", function_name: "fixture_fn", result_type: null,
    arguments: "", language_name: "sql", prokind: "p",
  },
  triggers: {
    schema_name: "public", table_name: "users", trigger_name: "fixture_trigger",
    action_timing: "BEFORE", event_manipulation: "INSERT",
    action_statement: "EXECUTE FUNCTION fixture_fn()",
  },
  policies: {
    schemaname: "public", tablename: "users", policyname: "fixture_policy",
    permissive: "PERMISSIVE", roles: ["public"], cmd: "SELECT", qual: "true", with_check: null,
  },
  publications: {
    pubname: "fixture_publication", pubowner: 42, puballtables: false,
    pubinsert: true, pubupdate: true, pubdelete: true, pubtruncate: true,
  },
  views: {
    schemaname: "public", viewname: "fixture_view", viewowner: "fixture", definition: "SELECT 1;",
  },
  "materialized-views": {
    schemaname: "public", matviewname: "fixture_matview", matviewowner: "fixture", definition: "SELECT 1;",
  },
  "foreign-tables": {
    schemaname: "public", tablename: "fixture_foreign", ftoptions: null, ftserver: 42,
  },
  types: { schema_name: "public", type_name: "fixture_enum", typtype: "e", enum_value: "active" },
  extensions: { extname: "plpgsql", extversion: "1.0", schema_name: "pg_catalog" },
  constraints: {
    schema_name: "public", table_name: "users", constraint_name: "users_pkey",
    constraint_type: "p", definition: "PRIMARY KEY (id)",
  },
};
