import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitPolicyRls } from "@supacloud/db/source-contracts";
import { generateDatabaseContracts, parseDatabaseContractsOptions } from "./database-contracts";
import {
  CLUSTER_LOGIN_ROLES,
  DATA_CATALOG_GAPS,
  DATA_PLANE_ROLES,
  DataCatalogError,
  PUBLIC_GRAPHQL_CONTRACT,
  compileDataCatalog,
  parseDataCatalogConfig,
  parseDataCatalogDocument,
} from "./data-catalog";
import { writeFixtureProject } from "./fixtures/helpers";

const orders = `datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}
enum Status {
  open
  closed @map("CLOSED")
}
type Principal {
  id String
  tenantId String
  @@auth()
}
model Order {
  id String @id @default(uuid())
  tenantId String @map("tenant_id")
  title String?
  status Status @default(open)
  items Item[]
  geo Unsupported("circle")
  @@schema("app")
  @@map("model_orders")
  @@allow("read", auth() != null && tenantId == auth().tenantId)
}
model Item {
  id String @id
  order Order @relation(fields: [orderId], references: [id])
  orderId String
  secret String @ignore
  @@unique([orderId])
}
model Hidden {
  id String @id
  @@ignore
  @@map("hidden_orders")
}
`;

test("binds REST execution and public GraphQL to one ZenStack schema", async () => {
  const catalog = await compileDataCatalog({
    source: orders,
    schemaPath: "zenstack/schema.zmodel",
    restExecution: "postrust",
  });
  expect(catalog.schemaOwner).toBe("zenstack");
  expect(catalog.schemaHash).toBe(createHash("sha256").update(orders).digest("hex"));
  expect(catalog.authType).toBe("Principal");
  expect(catalog.authClaims).toEqual(["id", "tenantId"]);
  expect(catalog.enums).toEqual([{ name: "Status", values: [{ name: "open", value: "open" }, { name: "closed", value: "CLOSED" }] }]);
  const order = catalog.models.find((model) => model.name === "Order");
  expect(order).toMatchObject({ schema: "app", table: "model_orders", identity: "field", ignored: false });
  expect(order?.fields.find((field) => field.name === "tenantId")).toMatchObject({ column: "tenant_id", kind: "scalar" });
  expect(order?.fields.find((field) => field.name === "title")).toMatchObject({ optional: true, kind: "scalar" });
  expect(order?.fields.find((field) => field.name === "status")).toMatchObject({ kind: "enum", typeName: "Status" });
  expect(order?.fields.find((field) => field.name === "items")).toMatchObject({ kind: "relation", array: true });
  expect(order?.fields.find((field) => field.name === "geo")).toMatchObject({ kind: "unsupported" });
  expect(catalog.models.find((model) => model.name === "Item")?.fields.find((field) => field.name === "secret")?.ignored).toBe(true);
  expect(catalog.models.find((model) => model.name === "Hidden")).toMatchObject({ ignored: true, table: "hidden_orders" });
  expect(catalog.authorization.roles).toEqual(DATA_PLANE_ROLES);
  expect(catalog.authorization.clusterLoginRolesUnchanged).toEqual(CLUSTER_LOGIN_ROLES);
  expect(catalog.authorization.identity).toBe("gotrue-jwt");
  expect(catalog.authorization.enforcement).toBe("postgresql-grant-and-rls");
  expect(catalog.authorization.isolation).toBe("one-database-per-project");
  expect(catalog.authorization.emittedGrant).toBe(false);
  expect(catalog.authorization.emittedRowPolicy).toBe(true);
  expect(catalog.rest).toMatchObject({
    schemaOwner: "zenstack",
    execution: "postrust",
    executionIsSchemaOwner: false,
    servesPublicRest: false,
    contract: "postgrest-compatible",
    generatedFromCatalog: false,
    openApi: "not-emitted",
  });
  expect(catalog.graphql).toEqual({
    schemaOwner: "zenstack",
    publicPath: "/graphql/v1",
    rewritePath: "/v1/graphql",
    acceptProfile: null,
    contentProfile: null,
    dialect: "postrust-hasura",
    generatedFromCatalog: false,
    clientDefault: "/graphql/v1",
    postrustHasuraDialect: "public-contract",
  });
  expect(catalog.graphql.publicPath).toBe(PUBLIC_GRAPHQL_CONTRACT.path);
  expect(catalog.gaps).toEqual(DATA_CATALOG_GAPS);
  const projected = emitPolicyRls(orders);
  expect(catalog.policyRls).toEqual({
    status: "projected",
    reading: "row-policies-emitted",
    role: "authenticated",
    statementCount: projected.statements.length,
    hash: createHash("sha256").update(projected.sql).digest("hex"),
    reason: null,
  });
  expect(parseDataCatalogDocument(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog);
});

test("records a model with no row policy and does not emit GRANT", async () => {
  const source = "model Note {\n  id String @id\n  title String\n}\n";
  const catalog = await compileDataCatalog({ source, schemaPath: "schema.zmodel", restExecution: "postgrest" });
  expect(catalog.policyRls.status).toBe("no-row-policy");
  expect(catalog.policyRls.reading).toBe("no-row-policy-declared");
  expect(catalog.policyRls.statementCount).toBe(0);
  expect(catalog.policyRls.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(catalog.policyRls.reason).toBeNull();
  expect(catalog.authorization.emittedRowPolicy).toBe(false);
  expect(catalog.authorization.emittedGrant).toBe(false);
  expect(catalog.rest.execution).toBe("postgrest");
  expect(catalog.rest.servesPublicRest).toBe(true);
  expect(catalog.graphql.publicPath).toBe("/graphql/v1");
});

test("records an unprojected row policy without claiming GRANT or a generated GraphQL schema", async () => {
  const source = `type Principal { id String @@auth() }
model Review {
  id String @id
  ownerId String
  @@allow("read", auth() != null)
}
model Attachment {
  id String @id
  review Review
  @@allow("read", review.ownerId == auth().id)
}
`;
  const catalog = await compileDataCatalog({ source, schemaPath: "schema.zmodel", restExecution: "lite" });
  expect(catalog.policyRls.status).toBe("not-projected");
  expect(catalog.policyRls.reading).toBe("projection-incomplete");
  expect(catalog.policyRls.hash).toBeNull();
  expect(catalog.policyRls.reason).toContain("relation predicate");
  expect(catalog.rest.servesPublicRest).toBe(false);
  const incomplete = JSON.parse(JSON.stringify(catalog)) as { policyRls: { hash: string | null; reading: string } };
  incomplete.policyRls.hash = "a".repeat(64);
  incomplete.policyRls.reading = "no-row-policy-declared";
  expect(() => parseDataCatalogDocument(incomplete)).toThrow(/Invalid ZenStack data catalog/);
  const emptyWithoutHash = JSON.parse(JSON.stringify(catalog)) as { policyRls: { status: string; reading: string; hash: string | null; reason: null } };
  emptyWithoutHash.policyRls.status = "no-row-policy";
  emptyWithoutHash.policyRls.reading = "no-row-policy-declared";
  emptyWithoutHash.policyRls.hash = null;
  emptyWithoutHash.policyRls.reason = null;
  expect(() => parseDataCatalogDocument(emptyWithoutHash)).toThrow(/Invalid ZenStack data catalog/);
  const postrustServing = JSON.parse(JSON.stringify(catalog)) as { rest: { execution: string; servesPublicRest: boolean } };
  postrustServing.rest.execution = "postrust";
  postrustServing.rest.servesPublicRest = true;
  expect(() => parseDataCatalogDocument(postrustServing)).toThrow(/Invalid ZenStack data catalog/);
  expect(catalog.authorization.emittedRowPolicy).toBe(false);
  expect(catalog.authorization.emittedGrant).toBe(false);
  expect(catalog.models.map((model) => model.name).sort()).toEqual(["Attachment", "Review"]);
  expect(catalog.graphql.generatedFromCatalog).toBe(false);
  expect(catalog.rest.generatedFromCatalog).toBe(false);
  expect(catalog.rest.execution).toBe("lite");
});

test("rejects Postrust GraphQL, renamed roles, and a non-PostgreSQL schema as the catalog owner", async () => {
  expect(() => parseDataCatalogConfig({
    schema: "schema.zmodel",
    restExecution: "postrust",
    graphqlDialect: "hasura",
  }, "/tmp/app")).toThrow(/public dialect is Postrust Hasura/);
  expect(() => parseDataCatalogConfig({
    schema: "schema.zmodel",
    restExecution: "postrust",
    publicPath: "/v1/graphql",
  }, "/tmp/app")).toThrow(/public GraphQL path stays \/graphql\/v1/);
  expect(() => parseDataCatalogConfig({
    schema: "schema.zmodel",
    restExecution: "postrust",
    roles: ["supabase_admin"],
  }, "/tmp/app")).toThrow(/anon, authenticated, and service_role/);
  expect(() => parseDataCatalogConfig({
    schema: "schema.zmodel",
    restExecution: "postrust-graphql",
  }, "/tmp/app")).toThrow(/does not own GraphQL/);
  expect(() => parseDataCatalogConfig({ schema: "https://example.test/schema.zmodel", restExecution: "postgrest" }, "/tmp/app")).toThrow(DataCatalogError);
  const sqlite = `datasource db { provider = "sqlite" url = "file:dev.db" }
model Note { id String @id }
`;
  await expect(compileDataCatalog({ source: sqlite, schemaPath: "schema.zmodel", restExecution: "postgrest" })).rejects.toThrow(/not postgresql/);
  const duplicate = `model A { id String @id @@map("same") }
model B { id String @id @@map("same") }
`;
  await expect(compileDataCatalog({ source: duplicate, schemaPath: "schema.zmodel", restExecution: "postgrest" })).rejects.toThrow(/mapped by more than one model/);
});

test("keeps the compiler GraphQL client and schema export on /graphql/v1", async () => {
  const client = await readFile(join(import.meta.dir, "graphql-client.ts"), "utf8");
  const exporter = await readFile(join(import.meta.dir, "graphql-schema.ts"), "utf8");
  expect(client).toContain('"/graphql/v1"');
  expect(exporter).toContain('"/graphql/v1"');
  expect(client).not.toContain("/v1/graphql");
  expect(exporter).not.toContain("/v1/graphql");
  expect(client).not.toContain("/internal/postrust/graphql");
  expect(exporter).not.toContain("/internal/postrust/graphql");
  expect(client).toContain("Postrust Hasura");
  expect(exporter).toContain("Postrust Hasura");
  expect(PUBLIC_GRAPHQL_CONTRACT).toEqual({
    path: "/graphql/v1",
    rewritePath: "/v1/graphql",
    acceptProfile: null,
    contentProfile: null,
    dialect: "postrust-hasura",
  });
});

test("database-contracts writes the catalog beside the existing contract and checks drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "zenstack-catalog-"));
  try {
    await writeFixtureProject(root, {
      "schema.zmodel": orders,
      "other.zmodel": "model Note { id String @id }\n",
      "migrations/001.sql": `${emitPolicyRls(orders).statements.join("\n")}\n`,
    });
    const options = parseDatabaseContractsOptions({
      rootDir: ".",
      outDir: "generated",
      role: "authenticated",
      catalog: { schema: "schema.zmodel", restExecution: "postrust" },
      modelPolicy: "schema.zmodel",
      migrations: ["migrations/001.sql"],
    }, root);
    const written = await generateDatabaseContracts(options);
    expect(written.written).toContain("data-catalog.json");
    expect(written.written).toContain("rls.sql");
    const document = JSON.parse(await readFile(join(root, "generated/data-catalog.json"), "utf8"));
    expect(document.rest.execution).toBe("postrust");
    expect(document.rest.servesPublicRest).toBe(false);
    expect(document.policyRls.reading).toBe("row-policies-emitted");
    expect(document.graphql.publicPath).toBe("/graphql/v1");
    expect(document.graphql.dialect).toBe("postrust-hasura");
    expect(document.graphql.rewritePath).toBe("/v1/graphql");
    expect(document.graphql.acceptProfile).toBeNull();
    expect(document.graphql.generatedFromCatalog).toBe(false);
    expect(document.schemaPath).toBe("schema.zmodel");
    expect(await readFile(join(root, "generated/database.ts"), "utf8")).toContain("Public GraphQL is /graphql/v1 (Postrust Hasura)");
    expect((await generateDatabaseContracts(options, true)).upToDate).toBe(true);
    const before = await readFile(join(root, "generated/data-catalog.json"), "utf8");
    await writeFixtureProject(root, { "schema.zmodel": orders.replace("title String?", "title String") });
    const drifted = await generateDatabaseContracts(options, true);
    expect(drifted.upToDate).toBe(false);
    expect(drifted.mismatches).toContain("data-catalog.json");
    expect(await readFile(join(root, "generated/data-catalog.json"), "utf8")).toBe(before);
    await expect(generateDatabaseContracts(parseDatabaseContractsOptions({
      rootDir: ".",
      outDir: "generated",
      role: "authenticated",
      catalog: { schema: "schema.zmodel", restExecution: "postgrest" },
      modelPolicy: "other.zmodel",
      migrations: [],
    }, root))).rejects.toThrow(/same file/);
    expect(await readFile(join(root, "generated/data-catalog.json"), "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
