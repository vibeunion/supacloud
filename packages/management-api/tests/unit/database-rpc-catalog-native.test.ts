import { expect, test } from "bun:test";
import { readRpcCatalog } from "../../src/services/database-rpc-catalog.service";
import { withNativePostgres } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native PostgreSQL RPC catalog preserves overloads, strictness, security and config",
  async () => withNativePostgres(async (database) => {
    await database.unsafe(`
      CREATE SCHEMA catalog_fixture;
      CREATE FUNCTION catalog_fixture.lookup() RETURNS text LANGUAGE sql STABLE
        AS $$ SELECT 'value'::text $$;
      CREATE FUNCTION catalog_fixture.lookup(p_id integer) RETURNS integer LANGUAGE sql IMMUTABLE
        STRICT SECURITY DEFINER SET search_path = pg_catalog, catalog_fixture
        AS $$ SELECT p_id $$;
      COMMENT ON FUNCTION catalog_fixture.lookup(integer) IS '@api query';
      CREATE PROCEDURE catalog_fixture.not_a_function() LANGUAGE sql AS $$ SELECT 1 $$;
    `);
    const entries = await readRpcCatalog(database, ["catalog_fixture"]);
    expect(entries).toHaveLength(2);
    const noArgs = entries.find((entry) => entry.identity_args === "");
    const withArgs = entries.find((entry) => entry.identity_args === "p_id integer");
    expect(noArgs).toMatchObject({
      schema_name: "catalog_fixture", function_name: "lookup", return_type: "text",
      volatility: "STABLE", security: "INVOKER", is_strict: false, search_path: null, comment: null,
    });
    expect(withArgs).toMatchObject({
      schema_name: "catalog_fixture", function_name: "lookup", return_type: "integer",
      volatility: "IMMUTABLE", security: "DEFINER", is_strict: true,
      search_path: "pg_catalog, catalog_fixture", smart_tags: { api: "query" },
    });
  }),
  40_000,
);
