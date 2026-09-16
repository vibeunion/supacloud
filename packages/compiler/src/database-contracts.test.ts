import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "@typescript/typescript6";
import { generateDatabaseContracts, parseDatabaseContractsOptions } from "./database-contracts";
import { writeFixtureProject } from "./fixtures/helpers";

test("single entry generates native read types, decoders and source/migration drift manifest without executing schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "database-contracts-"));
  try {
    await writeFixtureProject(root, {
      "database.types.ts": `export type Database = { public: { Tables: { orders: { Row: { id: string } } } } };`,
      "db/columns.ts": `export const id = "uuid";`,
      "db/schema.ts": `import { id } from "./columns"; export const orders = { id }; throw new Error("must not execute");`,
      "graphql/schema.graphql": `type Order { id: ID! } type Query { orders: [Order!]! }`,
      "src/orders.graphql": `query Orders { orders { id } }`,
      "migrations/001.sql": `CREATE TABLE public.orders(id uuid PRIMARY KEY);`,
    });
    const options = parseDatabaseContractsOptions({
      rootDir: ".", outDir: "generated", role: "authenticated",
      postgrestTypes: "database.types.ts", drizzleSchema: "db/schema.ts",
      graphql: { schema: "graphql/schema.graphql", documents: ["src/*.graphql"] },
      migrations: ["migrations/001.sql"],
    }, root);
    const result = await generateDatabaseContracts(options);
    expect(result.written).toContain("database.ts");
    const barrel = await readFile(join(root, "generated/database.ts"), "utf8");
    expect(barrel).toContain('export type { Database } from "../database.types"');
    expect(barrel).toContain('QueryData, QueryResult, QueryError');
    expect(await readFile(join(root, "generated/graphql.ts"), "utf8")).toContain("parseOrdersQuery");
    expect((await generateDatabaseContracts(options, true)).upToDate).toBe(true);
    const before = await readFile(join(root, "generated/database.manifest.json"), "utf8");
    await writeFixtureProject(root, { "db/columns.ts": `export const id = "text";` });
    expect((await generateDatabaseContracts(options, true)).mismatches).toContain("database.manifest.json");
    expect(await readFile(join(root, "generated/database.manifest.json"), "utf8")).toBe(before);
    await generateDatabaseContracts(options);
    await writeFixtureProject(root, { "migrations/001.sql": "CREATE TABLE public.orders(id text);" });
    expect((await generateDatabaseContracts(options, true)).upToDate).toBe(false);
    await writeFixtureProject(root, { "src/orders.graphql": "query Orders { missing }" });
    await expect(generateDatabaseContracts(options)).rejects.toThrow();
    expect(await readFile(join(root, "generated/database.ts"), "utf8")).toBe(barrel);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration rejects unknown options and requires real input paths", () => {
  expect(() => parseDatabaseContractsOptions({ mode: "code-first" }, "/tmp")).toThrow();
});

test("generated barrel retains real PostgREST projections, Drizzle row types and GraphQL result types", async () => {
  const root = await mkdtemp(join(tmpdir(), "database-contract-consumer-"));
  try {
    await symlink(join(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");
    await writeFixtureProject(root, {
      "database.types.ts": `export type Database = { public: {
        Tables: { orders: { Row: { id: string; title: string | null };
          Insert: { id?: string; title?: string | null }; Update: { title?: string | null }; Relationships: [] } };
        Views: {}; Functions: {}; Enums: {}; CompositeTypes: {};
      } };`,
      "schema.ts": `import { pgTable, text } from "drizzle-orm/pg-core";
        export const orders = pgTable("orders", { id: text().primaryKey(), title: text() });`,
      "schema.graphql": `type Order { id: ID! title: String } type Query { orders: [Order!]! }`,
      "orders.graphql": `query Orders { orders { id title } }`,
      "consumer.ts": `
import { createClient } from "@supabase/supabase-js";
import type { Database, QueryData, DrizzleSchema, OrdersQuery } from "./generated/database";
const client = createClient<Database>("https://example.test", "public");
const query = client.from("orders").select("id");
type Rows = QueryData<typeof query>;
const rows: Rows = [{ id: "1" }];
// @ts-expect-error Projection must not expose unselected columns.
const extra: Rows = [{ id: "1", title: "hidden" }];
// @ts-expect-error Selected types come from Database.
const wrong: Rows = [{ id: 1 }];
type Row = DrizzleSchema["orders"]["$inferSelect"];
const row: Row = { id: "1", title: null };
// @ts-expect-error Drizzle row shape remains independent from GraphQL envelope.
const invalidRow: Row = { orders: [] };
const result: OrdersQuery = { orders: [{ id: "1", title: null }] };
// @ts-expect-error GraphQL result values remain schema-owned.
const invalidResult: OrdersQuery = { orders: [{ id: 1, title: null }] };
void [rows, extra, wrong, row, invalidRow, result, invalidResult];`,
    });
    await generateDatabaseContracts({
      rootDir: root, outDir: join(root, "generated"), postgrestTypes: "database.types.ts",
      drizzleSchema: "schema.ts", role: "authenticated", migrations: [],
      graphql: { schema: "schema.graphql", documents: ["orders.graphql"] },
    });
    const program = ts.createProgram([join(root, "consumer.ts")], {
      strict: true, noEmit: true, skipLibCheck: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    expect(ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
