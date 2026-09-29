import { describe, expect, test } from "bun:test";
import { Command, getCommandMeta, getInfraResourceMeta, getJobMeta, getModuleMeta, InfraResource, Job, Module } from "./decorators";

describe("infrastructure declaration metadata", () => {
  test("resource metadata contains only the logical name and kind", () => {
    class Database {}
    const declaration = { name: "orders-db", kind: "database" as const, connectionString: "not-a-real-credential" };
    InfraResource(declaration)(Database);
    expect(getInfraResourceMeta(Database)).toEqual({ name: "orders-db", kind: "database" });
    expect(getInfraResourceMeta(class Undeclared {})).toBeUndefined();
  });

  test("module, command and job metadata preserve explicit resource references", () => {
    class Database {}
    InfraResource({ name: "orders-db", kind: "database" })(Database);
    class CreateOrder {}
    class Cleanup {}
    class Orders {}
    const uses = [{ resource: Database, operations: ["read" as const, "write" as const] }];
    Command({ name: "orders.create", permission: "orders.create", uses })(CreateOrder);
    Job({ name: "orders.cleanup", uses })(Cleanup);
    Module({ name: "orders", resources: [Database], commands: [CreateOrder], jobs: [Cleanup] })(Orders);
    expect(getCommandMeta(CreateOrder)?.uses).toEqual(uses);
    expect(getJobMeta(Cleanup)?.uses).toEqual(uses);
    expect(getModuleMeta(Orders)?.resources).toEqual([Database]);
  });

  test("omitted resources stay absent from legacy module metadata", () => {
    class Orders {}
    Module({ name: "orders" })(Orders);
    expect(getModuleMeta(Orders)?.resources).toBeUndefined();
  });
});
