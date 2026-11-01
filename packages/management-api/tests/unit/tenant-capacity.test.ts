import { expect, test } from "bun:test";
import { TenantCapacityPolicies } from "../../src/services/tenant-capacity";

const budget = {
  cpu: 1,
  memoryMiB: 512,
  connections: 4,
  queue: 2,
  storageBytes: 1000,
  functionConcurrency: 1,
};

test("tenant capacity policy round-trips through the control-plane row", async () => {
  let stored: unknown;
  const database = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("INSERT")) {
      stored = values[1];
      return [{
        project_ref: values[0],
        budget: values[1],
        updated_by: values[2],
        updated_at: "2026-11-01T00:00:00.000Z",
      }];
    }
    return stored ? [{ budget: stored }] : [];
  };
  const policies = new TenantCapacityPolicies(database);
  expect(await policies.read("demo")).toBeNull();
  const saved = await policies.set("demo", budget, "operator");
  expect(saved.budget).toEqual(budget);
  expect(saved.updatedBy).toBe("operator");
  expect((await policies.read("demo"))?.budget).toEqual(budget);
  expect(() => policies.set("BAD", budget)).toThrow("TENANT_CAPACITY_PROJECT_INVALID");
  expect(() => policies.set("demo", { ...budget, queue: 1.2 })).toThrow("TENANT_CAPACITY_BUDGET_INVALID");
});
