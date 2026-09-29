import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "./analyze";
import { renderApplication } from "./generate";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";
import { writeFixtureProject } from "./fixtures/helpers";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function analyze(files: Record<string, string>) {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-resource-review-"));
  roots.push(rootDir);
  await writeFixtureProject(rootDir, { "tsconfig.json": FIXTURE_TSCONFIG, "src/runtime.ts": RUNTIME_SOURCE, ...files });
  return { rootDir, graph: await analyzeProject(rootDir) };
}
const RESOURCES = `import { InfraResource } from "../../runtime";
@InfraResource({ name: "orders-db", kind: "database" }) export class OrdersDatabase {}
@InfraResource({ name: "attachments", kind: "bucket" }) export class AttachmentsBucket {}`;
const JOB = `import { Job } from "../../runtime";
import { AttachmentsBucket } from "./resources";
@Job({ name: "orders.cleanup", uses: [{ resource: AttachmentsBucket, operations: ["write"] }] }) export class CleanupJob {}`;
function errorsOf(graph: Awaited<ReturnType<typeof analyzeProject>>, code: string) {
  return (graph.diagnostics ?? []).filter((diagnostic) => diagnostic.code === code);
}

function expectResourceError(graph: Awaited<ReturnType<typeof analyzeProject>>, code: string, errorCode: string) {
  const diagnostics = errorsOf(graph, code);
  expect(diagnostics.length).toBeGreaterThan(0);
  for (const diagnostic of diagnostics) {
    expect(diagnostic).toMatchObject({ severity: "error", errorCode });
    expect(diagnostic.file).toBeTruthy();
    expect(diagnostic.line).toBeGreaterThan(0);
  }
}

function resourceCommandFiles(uses: string, moduleResources = "[OrdersDatabase]", extra = "") {
  return {
    "src/features/orders/resources.ts": RESOURCES,
    "src/features/orders/orders.command.ts": `import { Command } from "../../runtime";
import { OrdersDatabase } from "./resources";
${extra}
@Command({ name: "orders.create", permission: "orders.create", uses: ${uses} })
export class CreateOrderCommand {}`,
    "src/features/orders/orders.module.ts": `import { Module } from "../../runtime";
import { OrdersDatabase } from "./resources";
import { CreateOrderCommand } from "./orders.command";
@Module({ name: "orders", resources: ${moduleResources}, commands: [CreateOrderCommand] })
export class OrdersModule {}`,
  };
}

describe("resource model review regressions", () => {
  test("same-named classes in different files remain different resources", async () => {
    const { graph } = await analyze({
      "src/features/orders/first.ts": `import { InfraResource } from "../../runtime";
@InfraResource({ name: "first-db", kind: "database" }) export class Database {}`,
      "src/features/orders/second.ts": `import { InfraResource } from "../../runtime";
@InfraResource({ name: "second-db", kind: "database" }) export class Database {}`,
      "src/features/orders/orders.module.ts": `import { Module } from "../../runtime";
import { Database as First } from "./first";
import { Database as Second } from "./second";
@Module({ name: "orders", resources: [First, Second] }) export class OrdersModule {}`,
    });
    expect(graph.diagnostics).toEqual([]);
    expect(graph.resources?.map((resource) => resource.name)).toEqual(["first-db", "second-db"]);
    expect(graph.modules[0]?.resources).toEqual(["first-db", "second-db"]);
  });

  test("duplicate logical names are rejected even when class names also match", async () => {
    const { graph } = await analyze({
      "src/features/orders/first.ts": `import { InfraResource } from "../../runtime";
@InfraResource({ name: "orders-db", kind: "database" }) export class Database {}`,
      "src/features/orders/second.ts": `import { InfraResource } from "../../runtime";
@InfraResource({ name: "orders-db", kind: "database" }) export class Database {}`,
    });
    expectResourceError(graph, "duplicate-resource", "SC8101");
  });

  test("a non-resource class cannot borrow metadata from a namesake", async () => {
    const { graph } = await analyze({
      "src/features/orders/resources.ts": RESOURCES,
      "src/features/orders/plain.ts": "export class OrdersDatabase {}",
      "src/features/orders/orders.module.ts": `import { Module } from "../../runtime";
import { OrdersDatabase } from "./plain";
@Module({ name: "orders", resources: [OrdersDatabase] }) export class OrdersModule {}`,
    });
    expectResourceError(graph, "unknown-resource", "SC8102");
    expect(graph.modules[0]?.resources).toBeUndefined();
  });

  test("an unresolved identifier cannot resolve by class name alone", async () => {
    const { graph } = await analyze({
      "src/features/orders/resources.ts": RESOURCES,
      "src/features/orders/orders.module.ts": `import { Module } from "../../runtime";
@Module({ name: "orders", resources: [OrdersDatabase] }) export class OrdersModule {}`,
    });
    expectResourceError(graph, "unknown-resource", "SC8102");
  });

  test("namespace and barrel aliases resolve to the same declaration", async () => {
    const { graph } = await analyze({
      "src/features/orders/resources.ts": RESOURCES,
      "src/features/orders/barrel.ts": "export { OrdersDatabase as DB } from './resources';",
      "src/features/orders/orders.module.ts": `import { Module, Command } from "../../runtime";
import * as Infra from "./barrel";
import { DB as Database } from "./barrel";
@Command({ name: "orders.create", permission: "orders.create", uses: [{ resource: Infra.DB }] })
export class CreateOrderCommand {}
@Module({ name: "orders", resources: [Database, Infra.DB], commands: [CreateOrderCommand] })
export class OrdersModule {}`,
    });
    expect(graph.diagnostics).toEqual([]);
    expect(graph.modules[0]?.resources).toEqual(["orders-db"]);
    expect(graph.resourceUses?.[0]?.operations).toEqual(["read"]);
  });

  for (const resources of ["null", "OrdersDatabase", "[...[]]"]) {
    test(`malformed module resources fails closed: ${resources}`, async () => {
      const { graph } = await analyze(resourceCommandFiles("[]", resources));
      expectResourceError(graph, "unknown-resource", "SC8102");
    });
  }

  for (const uses of ["null", "OrdersDatabase", "[OrdersDatabase]", "[{}]", "[{ resource: OrdersDatabase, ...{} }]"]) {
    test(`malformed uses fails closed: ${uses}`, async () => {
      const { graph } = await analyze(resourceCommandFiles(uses));
      expectResourceError(graph, "unknown-resource", "SC8102");
    });
  }

  for (const operations of ["[]", "null", "undefined", '"write"', "[read]", "[...[]]", '["read", "delete"]']) {
    test(`invalid operations never becomes an implicit read: ${operations}`, async () => {
      const { graph } = await analyze(resourceCommandFiles(
        `[{ resource: OrdersDatabase, operations: ${operations} }]`, "[OrdersDatabase]", 'const read = "delete";',
      ));
      expectResourceError(graph, "invalid-resource-operation", "SC8105");
      expect(graph.modules[0]?.commands[0]?.uses).toBeUndefined();
      expect(graph.resourceUses).toBeUndefined();
    });
  }

  test("shorthand operations cannot silently use the default", async () => {
    const { graph } = await analyze(resourceCommandFiles(
      "[{ resource: OrdersDatabase, operations }]", "[OrdersDatabase]", 'const operations = ["delete"];',
    ));
    expectResourceError(graph, "unknown-resource", "SC8102");
    expect(graph.resourceUses).toBeUndefined();
  });

  test("shorthand uses cannot silently disappear", async () => {
    const files = resourceCommandFiles("[]");
    files["src/features/orders/orders.command.ts"] = `import { Command } from "../../runtime";
const uses = null;
@Command({ name: "orders.create", permission: "orders.create", uses }) export class CreateOrderCommand {}`;
    const { graph } = await analyze(files);
    expectResourceError(graph, "unknown-resource", "SC8102");
  });

  test("only omitted operations defaults to read; wrappers preserve static literals", async () => {
    const { graph } = await analyze(resourceCommandFiles(
      "([{ resource: (OrdersDatabase) }] as const)", "([OrdersDatabase] as const)",
    ));
    expect(graph.diagnostics).toEqual([]);
    expect(graph.modules[0]?.commands[0]?.uses).toEqual([{ resource: "orders-db", operations: ["read"] }]);
  });

  test("repeated uses merge and operation ordering is canonical in graph and manifest", async () => {
    const { rootDir, graph } = await analyze(resourceCommandFiles(
      '[{ resource: OrdersDatabase, operations: ["write", "read", "write"] }, { resource: OrdersDatabase, operations: ["publish"] }]',
    ));
    expect(graph.diagnostics).toEqual([]);
    expect(graph.modules[0]?.commands[0]?.uses).toEqual([{ resource: "orders-db", operations: ["read", "write", "publish"] }]);
    expect(graph.resourceUses).toHaveLength(1);
    const rendered = renderApplication(graph, { rootDir, outDir: join(rootDir, "generated") });
    expect(JSON.parse(rendered.manifestJson).resourceUses).toEqual(graph.resourceUses);
  });

  for (const declared of [false, true]) {
    test(`standalone command respects an existing app module declaration: ${declared}`, async () => {
      const { graph } = await analyze({
        "src/features/orders/resources.ts": RESOURCES,
        "src/features/orders/orders.command.ts": `import { Command } from "../../runtime";
import { OrdersDatabase } from "./resources";
@Command({ name: "orders.create", permission: "orders.create", standalone: true, uses: [{ resource: OrdersDatabase }] })
export class CreateOrderCommand {}`,
        "src/features/orders/app.module.ts": `import { Module } from "../../runtime";
import { OrdersDatabase } from "./resources";
@Module({ name: "app", resources: ${declared ? "[OrdersDatabase]" : "[]"} }) export class AppModule {}`,
      });
      if (declared) expect(graph.diagnostics).toEqual([]);
      else expectResourceError(graph, "undeclared-resource-use", "SC8103");
    });
  }

  test("a synthetic root does not grant standalone commands implicit resource access", async () => {
    const { graph } = await analyze({
      "src/features/orders/resources.ts": RESOURCES,
      "src/features/orders/orders.command.ts": `import { Command } from "../../runtime";
import { OrdersDatabase } from "./resources";
@Command({ name: "orders.create", permission: "orders.create", standalone: true, uses: [{ resource: OrdersDatabase }] })
export class CreateOrderCommand {}`,
    });
    expectResourceError(graph, "undeclared-resource-use", "SC8103");
  });

  test("jobs also reject use outside their module's resource declarations", async () => {
    const { graph } = await analyze({
      "src/features/orders/resources.ts": RESOURCES,
      "src/features/orders/orders.job.ts": JOB,
      "src/features/orders/orders.module.ts": `import { Module } from "../../runtime";
import { CleanupJob } from "./orders.job";
@Module({ name: "orders", jobs: [CleanupJob] }) export class OrdersModule {}`,
    });
    expectResourceError(graph, "undeclared-resource-use", "SC8103");
  });

  for (const metadata of ['name: "   ", kind: "database"', 'name: "orders-db", kind: "database", ...{}']) {
    test(`resource metadata must be a stable declaration: ${metadata}`, async () => {
      const { graph } = await analyze({
        "src/features/orders/resources.ts": `import { InfraResource } from "../../runtime";
@InfraResource({ ${metadata} }) export class Database {}`,
      });
      expectResourceError(graph, "invalid-resource-kind", "SC8104");
    });
  }

  test("applications without resource declarations retain their existing graph shape", async () => {
    const { graph } = await analyze({
      "src/features/orders/orders.module.ts": `import { Module } from "../../runtime";
@Module({ name: "orders" }) export class OrdersModule {}`,
    });
    expect(graph.diagnostics).toEqual([]);
    expect(graph.resources).toBeUndefined();
    expect(graph.resourceUses).toBeUndefined();
    expect(graph.modules[0]?.resources).toBeUndefined();
  });
});
