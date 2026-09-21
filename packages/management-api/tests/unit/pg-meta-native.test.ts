// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { Value } from "@sinclair/typebox/value";
import * as dbModule from "../../src/db";
import { config } from "../../src/config";
import { projectRepository } from "../../src/repositories/project.repository";
import { createPgMetaRoutes } from "../../src/routes/pg-meta";
import { pgMetaRowSchemas, readPgMetaRows } from "../../src/utils/pg-meta-contract";
import { withNativePostgres } from "../helpers/native-postgres";
import { taskProjectFixture } from "../helpers/task-fixtures";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native PostgreSQL catalog queries satisfy every metadata route contract",
  async () => withNativePostgres(async database => {
    await database.unsafe(`
      CREATE TABLE users (id integer PRIMARY KEY, label varchar(64), amount numeric(10, 2));
      CREATE VIEW fixture_view AS SELECT id FROM users;
      CREATE MATERIALIZED VIEW fixture_matview AS SELECT id FROM users;
      CREATE TYPE fixture_enum AS ENUM ('active', 'paused');
      CREATE FUNCTION fixture_trigger_fn() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RETURN NEW; END $$;
      CREATE TRIGGER fixture_trigger BEFORE INSERT ON users
        FOR EACH ROW EXECUTE FUNCTION fixture_trigger_fn();
      CREATE PROCEDURE fixture_procedure() LANGUAGE SQL AS $$ SELECT 1 $$;
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      CREATE POLICY fixture_policy ON users FOR SELECT TO PUBLIC USING (true);
      CREATE PUBLICATION fixture_publication FOR TABLE users;
      CREATE FOREIGN DATA WRAPPER fixture_fdw;
      CREATE SERVER fixture_server FOREIGN DATA WRAPPER fixture_fdw;
      CREATE FOREIGN TABLE fixture_foreign (id integer) SERVER fixture_server;
      CREATE FOREIGN TABLE fixture_options (id integer) SERVER fixture_server OPTIONS (name 'literal');
      CREATE SCHEMA "quoted'name";
      CREATE TABLE "quoted'name".quoted_table (id integer);
    `);
    const project = spyOn(projectRepository, "findByRef").mockImplementation(async ref =>
      ref === "fixture-project" ? taskProjectFixture({ ref, db_name: "fixture" }) : null);
    const getDatabase = spyOn(dbModule, "getProjectDb").mockReturnValue(database);
    const app = new Elysia().use(createPgMetaRoutes());
    const headers = { Authorization: `Bearer ${config.masterToken}` };
    const request = (path: string) => app.handle(new Request(
      `http://localhost/v1/projects/fixture-project/pg-meta/${path}`, { headers },
    ));
    try {
      const denied = await app.handle(new Request(
        "http://localhost/v1/projects/fixture-project/pg-meta/tables",
      ));
      expect(denied.status).toBe(401);
      expect(getDatabase).not.toHaveBeenCalled();
      for (const [name, schema] of Object.entries(pgMetaRowSchemas)) {
        const response = await request(name);
        const raw: unknown = await response.json();
        expect(response.status, `native ${name}: ${JSON.stringify(raw)}`).toBe(200);
        const rows = readPgMetaRows(schema, raw);
        expect(rows.length, `native ${name} must contain real catalog rows`).toBeGreaterThan(0);
        expect(getDatabase).toHaveBeenLastCalledWith("fixture");
      }
      const foreign = await request("foreign-tables");
      expect(await foreign.json()).toEqual([
        expect.objectContaining({ tablename: "fixture_foreign", ftoptions: null }),
        expect.objectContaining({ tablename: "fixture_options", ftoptions: ["name=literal"] }),
      ]);
      const functions = await request("functions");
      expect(await functions.json()).toContainEqual(expect.objectContaining({
        function_name: "fixture_procedure", prokind: "p", result_type: null,
      }));
      const policies = await request("policies");
      expect(await policies.json()).toContainEqual(expect.objectContaining({
        policyname: "fixture_policy", roles: ["public"], with_check: null,
      }));
      for (const endpoint of ["tables", "columns"]) {
        const quoted = await request(`${endpoint}?schema=${encodeURIComponent("quoted'name")}`);
        expect(quoted.status).toBe(200);
        const rows: unknown = await quoted.json();
        expect(Array.isArray(rows)).toBe(true);
        if (!Array.isArray(rows)) throw new Error("Expected quoted-schema rows");
        expect(rows).toHaveLength(1);
        const schema = endpoint === "tables" ? pgMetaRowSchemas.tables : pgMetaRowSchemas.columns;
        expect(Value.Check(schema, rows[0])).toBe(true);
        const injection = await request(`${endpoint}?schema=${encodeURIComponent("' OR true --")}`);
        expect(injection.status).toBe(200);
        expect(await injection.json()).toEqual([]);
        const wildcard = await request(`${endpoint}?schema=*`);
        expect(wildcard.status).toBe(200);
      }
    } finally {
      getDatabase.mockRestore();
      project.mockRestore();
    }
  }, { logicalReplication: true }),
  40_000,
);
