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
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-resource-model-"));
  roots.push(rootDir);
  await writeFixtureProject(rootDir, { "tsconfig.json": FIXTURE_TSCONFIG, "src/runtime.ts": RUNTIME_SOURCE, ...files });
  return { rootDir, graph: await analyzeProject(rootDir) };
}

const RESOURCES = `import { InfraResource } from "../../runtime";

@InfraResource({ name: "orders-db", kind: "database" })
export class OrdersDatabase {}

@InfraResource({ name: "attachments", kind: "bucket" })
export class AttachmentsBucket {}
`;

const COMMAND = `import { Command } from "../../runtime";
import { OrdersDatabase } from "./resources";

@Command({
  name: "orders.create",
  permission: "orders.create",
  uses: [{ resource: OrdersDatabase, operations: ["read", "write"] }],
})
export class CreateOrderCommand {}
`;

const JOB = `import { Job } from "../../runtime";
import { AttachmentsBucket } from "./resources";

@Job({
  name: "orders.cleanup",
  uses: [{ resource: AttachmentsBucket, operations: ["publish"] }],
})
export class CleanupJob {}
`;

const MODULE = `import { Module } from "../../runtime";
import { AttachmentsBucket, OrdersDatabase } from "./resources";
import { CreateOrderCommand } from "./orders.command";
import { CleanupJob } from "./orders.job";

@Module({
  name: "orders",
  resources: [OrdersDatabase, AttachmentsBucket],
  commands: [CreateOrderCommand],
  jobs: [CleanupJob],
})
export class OrdersModule {}
`;

function errorsOf(graph: Awaited<ReturnType<typeof analyzeProject>>, code: string) {
  return (graph.diagnostics ?? []).filter((diagnostic) => diagnostic.code === code);
}

describe("ApplicationGraph 资源模型", () => {
  test("声明资源、模块使用关系与 command/job uses 进入应用图", async () => {
    const { graph } = await analyze({
      "src/features/orders/resources.ts": RESOURCES,
      "src/features/orders/orders.command.ts": COMMAND,
      "src/features/orders/orders.job.ts": JOB,
      "src/features/orders/orders.module.ts": MODULE,
    });

    expect(graph.diagnostics ?? []).toEqual([]);
    expect(graph.resources?.map((resource) => [resource.name, resource.kind, resource.className])).toEqual([
      ["attachments", "bucket", "AttachmentsBucket"],
      ["orders-db", "database", "OrdersDatabase"],
    ]);
    expect(graph.resources?.every((resource) => resource.importPath.startsWith("src/features/orders/"))).toBe(true);

    const orders = graph.modules.find((module) => module.name === "orders");
    expect(orders?.resources).toEqual(["attachments", "orders-db"]);

    // Sorted deterministically by module:owner:resource.
    expect(graph.resourceUses).toEqual([
      {
        module: "orders",
        job: "orders.cleanup",
        resource: "attachments",
        resourceClass: "AttachmentsBucket",
        operations: ["publish"],
      },
      {
        module: "orders",
        command: "orders.create",
        resource: "orders-db",
        resourceClass: "OrdersDatabase",
        operations: ["read", "write"],
      },
    ]);
  });

  test("resources/resourceUses 进入 app.manifest.json", async () => {
    const { rootDir, graph } = await analyze({
      "src/features/orders/resources.ts": RESOURCES,
      "src/features/orders/orders.command.ts": COMMAND,
      "src/features/orders/orders.job.ts": JOB,
      "src/features/orders/orders.module.ts": MODULE,
    });
    const rendered = renderApplication(graph, { rootDir, outDir: join(rootDir, "generated") });
    const manifest = JSON.parse(rendered.manifestJson);
    expect(manifest.resources).toHaveLength(2);
    expect(manifest.resourceUses).toHaveLength(2);
  });

  test("未声明为 @InfraResource 的引用报告 unknown-resource", async () => {
    const { graph } = await analyze({
      "src/features/orders/orders.module.ts": `import { Module } from "../../runtime";
class NotAResource {}
@Module({ name: "orders", resources: [NotAResource] })
export class OrdersModule {}
`,
    });
    const diagnostics = errorsOf(graph, "unknown-resource");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "error", errorCode: "SC8102" });
  });

  test("command 使用模块未声明的资源报告 undeclared-resource-use", async () => {
    const { graph } = await analyze({
      "src/features/orders/resources.ts": RESOURCES,
      "src/features/orders/orders.command.ts": COMMAND,
      "src/features/orders/orders.module.ts": `import { Module } from "../../runtime";
import { CreateOrderCommand } from "./orders.command";
@Module({ name: "orders", commands: [CreateOrderCommand] })
export class OrdersModule {}
`,
    });
    const diagnostics = errorsOf(graph, "undeclared-resource-use");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "error", errorCode: "SC8103" });
  });

  test("重复逻辑名报告 duplicate-resource", async () => {
    const { graph } = await analyze({
      "src/features/orders/resources.ts": `import { InfraResource } from "../../runtime";
@InfraResource({ name: "orders-db", kind: "database" })
export class First {}
@InfraResource({ name: "orders-db", kind: "bucket" })
export class Second {}
`,
    });
    const diagnostics = errorsOf(graph, "duplicate-resource");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "error", errorCode: "SC8101" });
  });

  test("无效 kind 报告 invalid-resource-kind", async () => {
    const { graph } = await analyze({
      "src/features/orders/resources.ts": `import { InfraResource } from "../../runtime";
@InfraResource({ name: "cache", kind: "redis" })
export class Cache {}
`,
    });
    const diagnostics = errorsOf(graph, "invalid-resource-kind");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "error", errorCode: "SC8104" });
  });

  test("无效 operations 报告 invalid-resource-operation", async () => {
    const { graph } = await analyze({
      "src/features/orders/resources.ts": RESOURCES,
      "src/features/orders/orders.command.ts": `import { Command } from "../../runtime";
import { OrdersDatabase } from "./resources";
@Command({
  name: "orders.create",
  permission: "orders.create",
  uses: [{ resource: OrdersDatabase, operations: ["delete"] }],
})
export class CreateOrderCommand {}
`,
      "src/features/orders/orders.module.ts": `import { Module } from "../../runtime";
import { OrdersDatabase } from "./resources";
import { CreateOrderCommand } from "./orders.command";
@Module({ name: "orders", resources: [OrdersDatabase], commands: [CreateOrderCommand] })
export class OrdersModule {}
`,
    });
    const diagnostics = errorsOf(graph, "invalid-resource-operation");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "error", errorCode: "SC8105" });
  });
});