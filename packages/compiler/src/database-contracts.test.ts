import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "./typescript";
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
      "db/rpc-registry.json": `[{"name":"create_order"}]`,
      "db/rpc-catalog.json": `{"definitions":[{"name":"public.create_order"}]}`,
      "migrations/001.sql": `CREATE TABLE public.orders(id uuid PRIMARY KEY);`,
    });
    const options = parseDatabaseContractsOptions({
      rootDir: ".", outDir: "generated", role: "authenticated",
      postgrestTypes: "database.types.ts", modelSchema: "db/schema.ts",
      graphql: { schema: "graphql/schema.graphql", documents: ["src/*.graphql"] },
      rpcRegistry: "db/rpc-registry.json", rpcCatalog: "db/rpc-catalog.json",
      migrations: ["migrations/001.sql"],
    }, root);
    const result = await generateDatabaseContracts(options);
    expect(result.written).toContain("database.ts");
    expect(result.manifest.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.hasOwn(result.manifest.inputs, "db/rpc-registry.json")).toBe(true);
    expect(Object.hasOwn(result.manifest.inputs, "db/rpc-catalog.json")).toBe(true);
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
    expect(await generateDatabaseContracts(options).catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(await readFile(join(root, "generated/database.ts"), "utf8")).toBe(barrel);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration rejects unknown options and requires real input paths", () => {
  expect(() => parseDatabaseContractsOptions({ mode: "code-first" }, "/tmp")).toThrow();
});

test("generated barrel retains real PostgREST projections, ZenStack row types and GraphQL result types", async () => {
  const root = await mkdtemp(join(tmpdir(), "database-contract-consumer-"));
  try {
    await symlink(join(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");
    await writeFixtureProject(root, {
      "database.types.ts": `export type Database = { public: {
        Tables: { orders: { Row: { id: string; title: string | null };
          Insert: { id?: string; title?: string | null }; Update: { title?: string | null }; Relationships: [] } };
        Views: {}; Functions: {}; Enums: {}; CompositeTypes: {};
      } };`,
      "schema.ts": await readFile(join(import.meta.dir, "../../db-zenstack/tests/fixtures/model/generated/schema.ts"), "utf8"),
      "schema.graphql": `type Order { id: ID! title: String } type Query { orders: [Order!]! }`,
      "orders.graphql": `query Orders { orders { id title } }`,
      "consumer.ts": `
import { createClient } from "@supabase/supabase-js";
import type { Database, QueryData, ModelSchema, OrdersQuery } from "./generated/database";
const client = createClient<Database>("https://example.test", "public");
const query = client.from("orders").select("id");
type Rows = QueryData<typeof query>;
const rows: Rows = [{ id: "1" }];
// @ts-expect-error Projection must not expose unselected columns.
const extra: Rows = [{ id: "1", title: "hidden" }];
// @ts-expect-error Selected types come from Database.
const wrong: Rows = [{ id: 1 }];
type Row = import("@zenstackhq/orm").ModelResult<ModelSchema["schema"], "Note">;
const row: Row = { id: "1", owner: "alice", value: 1, steps: [] };
// @ts-expect-error ZenStack row shape remains independent from GraphQL envelope.
const invalidRow: Row = { orders: [] };
const result: OrdersQuery = { orders: [{ id: "1", title: null }] };
// @ts-expect-error GraphQL result values remain schema-owned.
const invalidResult: OrdersQuery = { orders: [{ id: 1, title: null }] };
void [rows, extra, wrong, row, invalidRow, result, invalidResult];`,
    });
    await generateDatabaseContracts({
      rootDir: root, outDir: join(root, "generated"), postgrestTypes: "database.types.ts",
      modelSchema: "schema.ts", role: "authenticated", migrations: [],
      graphql: { schema: "schema.graphql", documents: ["orders.graphql"] },
    });
    await using program = (await ts.createProgram([join(root, "consumer.ts")], {
      strict: true, noEmit: true, skipLibCheck: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    }));
    expect((await ts.getPreEmitDiagnostics(program)).map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uses only the protocols named in the configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "database-contracts-protocols-"));
  try {
    await writeFixtureProject(root, {
      "database.types.ts": `export type Database = { public: { Tables: { orders: { Row: { id: string } } } } };`,
      "schema.graphql": `type Query { health: String! }`,
      "health.graphql": `query Health { health }`,
      "db/schema.ts": `export const orders = { id: "uuid" };`,
    });
    expect(() => parseDatabaseContractsOptions({
      rootDir: ".", outDir: "generated", role: "authenticated", migrations: [],
    }, root)).toThrow("postgrestTypes, modelSchema, or graphql");

    const postgrest = parseDatabaseContractsOptions({
      rootDir: ".", outDir: "generated", role: "authenticated", migrations: [],
      postgrestTypes: "database.types.ts",
    }, root);
    expect(postgrest.modelSchema).toBeUndefined();
    expect(postgrest.graphql).toBeUndefined();
    await generateDatabaseContracts(postgrest);
    const postgrestBarrel = await readFile(join(root, "generated/database.ts"), "utf8");
    expect(postgrestBarrel).toContain("export type { Database }");
    expect(postgrestBarrel).not.toContain("ModelSchema");
    expect(postgrestBarrel).not.toContain("./graphql");

    const graphql = parseDatabaseContractsOptions({
      rootDir: ".", outDir: "generated", role: "authenticated", migrations: [],
      graphql: { schema: "schema.graphql", documents: ["*.graphql"] },
    }, root);
    await generateDatabaseContracts(graphql);
    const graphqlBarrel = await readFile(join(root, "generated/database.ts"), "utf8");
    expect(graphqlBarrel).toContain('export * from "./graphql"');
    expect(graphqlBarrel).not.toContain("Database");
    expect(await readFile(join(root, "generated/graphql.ts"), "utf8")).toContain("parseHealthQuery");

    const model = parseDatabaseContractsOptions({
      rootDir: ".", outDir: "generated", role: "authenticated", migrations: [],
      modelSchema: "db/schema.ts",
    }, root);
    await generateDatabaseContracts(model);
    const modelBarrel = await readFile(join(root, "generated/database.ts"), "utf8");
    expect(modelBarrel).toContain("ModelSchema");
    expect(modelBarrel).not.toContain("export type { Database }");
    expect(modelBarrel).not.toContain("./graphql");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
