import { describe, expect, test } from "bun:test";
import { createDeliveryPlan, formatDeliveryPlan } from "./delivery-plan";
import { parseDeliveryOptions, parseDeliveryPlanResult, type DeliveryOptions, type DeliveryPlanResult } from "./delivery-schema";
import { defineSupacloudConfig } from "./config";
import { requireValue } from "./fixtures/helpers";
import type { ApplicationGraph, ModuleNode } from "./types";

function module(name: string, imports: string[] = []): ModuleNode {
  return {
    name, className: `${name}Module`, file: `${name}.ts`, line: 1, imports,
    providers: [], controllers: [], commands: [], queries: [], exports: [],
  };
}

function http(name: string, imports: string[] = []): ModuleNode {
  return { ...module(name, imports), controllers: [{
    className: `${name}Controller`, path: `/${name}`, scope: "application", deps: [],
    file: `${name}.ts`, importPath: name,
    routes: [{ method: "GET", path: "/", handler: "list" }],
  }] };
}

function graph(...modules: ModuleNode[]): ApplicationGraph {
  return { modules, externalTokens: [] };
}

function successful(result: DeliveryPlanResult) {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}

const runtime = { processIsolation: true, durableQueue: true, capabilities: [] } satisfies NonNullable<DeliveryOptions["runtime"]>;
const jobs: ModuleNode = {
  ...module("documents", ["shared"]),
  jobs: [{ name: "documents.render", className: "Render", serviceKey: "Render", scope: "job" }],
  providers: [{
    token: "Render", tokenKind: "class", kind: "class", scope: "job", deps: [],
    exported: false, file: "documents.ts", line: 1,
  }],
};

describe("delivery input and output boundaries", () => {
  test.each([
    null, false, [], {}, { version: 2 }, { version: 1, secret: "REDACTED_FIXTURE" },
    { version: 1, targets: [null] },
    { version: 1, targets: [{ name: "../escape", kind: "api", modules: ["orders"] }] },
    { version: 1, targets: [{ name: "api", kind: "api", modules: [] }] },
    { version: 1, targets: [{ name: "api", kind: "api", modules: ["orders", "orders"] }] },
    { version: 1, targets: [{ name: "api", kind: "api", modules: ["orders"], isolation: "worker" }] },
    { version: 1, runtime: { ...runtime, durableQueue: "true" } },
    { version: 1, runtime: { ...runtime, credentials: "REDACTED_FIXTURE" } },
  ].map((input: unknown) => ({ input })))("rejects malformed configuration without leaking values: %#", ({ input }) => {
    expect(() => parseDeliveryOptions(input)).toThrow("Invalid delivery configuration");
    const result = createDeliveryPlan(graph(), input);
    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(JSON.stringify(result)).not.toContain("REDACTED_FIXTURE");
    expect(result.written).toEqual([]);
  });

  test("config and JSON share one schema and static type", () => {
    const delivery = { version: 1, targets: [{ name: "orders", kind: "api", modules: ["orders"] }] } satisfies DeliveryOptions;
    expect(defineSupacloudConfig({ delivery }).delivery).toEqual(parseDeliveryOptions(delivery));
    expect(defineSupacloudConfig().delivery).toBeUndefined();
  });

  test("rejects malformed deserialized results", () => {
    const result = createDeliveryPlan(graph(http("orders")));
    const wire: unknown = JSON.parse(JSON.stringify(result));
    expect(parseDeliveryPlanResult(wire)).toEqual(result);
    expect(() => parseDeliveryPlanResult({ ...result, written: ["unexpected.ts"] })).toThrow();
    expect(() => parseDeliveryPlanResult({ ...result, ok: false })).toThrow();
  });
});

describe("deterministic workload placement", () => {
  test("defaults to one API, keeps paths, and never claims deployment readiness", () => {
    const plan = successful(createDeliveryPlan(graph(http("orders"), http("users"))));
    const target = requireValue(plan.targets[0]);
    expect(plan.targets).toHaveLength(1);
    expect(target.name).toBe("api");
    expect(target.routes.map((route) => route.path)).toEqual(["/orders", "/users"]);
    expect(target.routes.every((route) => route.reason === "default-http")).toBe(true);
    expect(target.runtimeStatus).toBe("unchecked");
    expect(plan.deploymentReady).toBe(false);
    expect(plan.digestScope).toBe("topology-only");
    expect(formatDeliveryPlan(createDeliveryPlan(graph()))).toContain("not a build hash");
  });

  test("import closure does not expose dependency routes in the importing target", () => {
    const fixture = graph(http("orders", ["shared"]), http("shared", ["storage"]), module("storage"));
    const plan = successful(createDeliveryPlan(fixture, {
      version: 1, targets: [{ name: "orders", kind: "api", modules: ["orders"] }],
    }));
    const orders = requireValue(plan.targets.find((target) => target.name === "orders"));
    const api = requireValue(plan.targets.find((target) => target.name === "api"));
    expect(orders.modules.map((item) => item.name)).toEqual(["orders", "shared", "storage"]);
    expect(orders.modules.find((item) => item.name === "shared")).toEqual({
      name: "shared", reason: "dependency", importedBy: ["orders"],
    });
    expect(orders.routes.map((item) => item.path)).toEqual(["/orders"]);
    expect(api.routes.map((item) => item.path)).toEqual(["/shared"]);
  });

  test("jobs and HTTP in the same module have separate owners without changing HTTP semantics", () => {
    const fixture = graph({ ...jobs, controllers: http("documents").controllers }, module("shared"));
    const missing = createDeliveryPlan(fixture);
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics.map((item) => item.code)).toContain("delivery-queue-required");
    expect(missing.diagnostics.map((item) => item.code)).toContain("delivery-isolation-required");
    const plan = successful(createDeliveryPlan(fixture, { version: 1, runtime }));
    const api = requireValue(plan.targets.find((item) => item.name === "api"));
    const worker = requireValue(plan.targets.find((item) => item.name === "jobs"));
    expect(api.routes).toHaveLength(1);
    expect(api.jobs).toEqual([]);
    expect(worker.routes).toEqual([]);
    expect(worker.jobs.map((item) => item.name)).toEqual(["documents.render"]);
    expect(worker.isolation).toBe("process");
    expect(worker.runtimeStatus).toBe("declared-compatible");
  });

  test("explicit webhook boundaries need capabilities but never change public paths", () => {
    const delivery: DeliveryOptions = {
      version: 1, targets: [{
        name: "hooks", kind: "webhook", modules: ["hooks"],
        isolation: "process", capabilities: ["payments.verify"],
      }],
    };
    const missing = createDeliveryPlan(graph(http("hooks")), delivery);
    expect(missing.diagnostics.map((item) => item.code)).toContain("delivery-capability-required");
    const plan = successful(createDeliveryPlan(graph(http("hooks")), {
      ...delivery, runtime: { ...runtime, capabilities: ["payments.verify"] },
    }));
    expect(requireValue(plan.targets[0]).routes.map((item) => item.path)).toEqual(["/hooks"]);
  });

  test("input ordering and source locations do not change the topology digest", () => {
    const a = http("orders", ["storage", "shared"]);
    const b = http("users", ["shared"]);
    const shared = module("shared");
    const storage = module("storage");
    const config: DeliveryOptions = { version: 1, targets: [
      { name: "shop", kind: "api", modules: ["users", "orders"] },
    ] };
    const before = JSON.stringify([a, b, shared, storage, config]);
    const first = successful(createDeliveryPlan(graph(a, b, shared, storage), config));
    const second = successful(createDeliveryPlan(graph(
      storage, shared, b, { ...a, imports: [...a.imports].reverse(), file: "/another/checkout.ts", line: 9 },
    ), { version: 1, targets: [{ name: "shop", kind: "api", modules: ["orders", "users"] }] }));
    expect(second).toEqual(first);
    expect(JSON.stringify([a, b, shared, storage, config])).toBe(before);
    const changed = successful(createDeliveryPlan(graph(a, b, shared, storage)));
    expect(changed.topologyDigest).not.toBe(first.topologyDigest);
  });

  test.each([
    { targets: [
      { name: "one", kind: "api", modules: ["orders"] },
      { name: "two", kind: "webhook", modules: ["orders"] },
    ], code: "delivery-ownership-conflict" },
    { targets: [
      { name: "one", kind: "api", modules: ["orders"] },
      { name: "one", kind: "api", modules: ["orders"] },
    ], code: "delivery-duplicate-target" },
    { targets: [{ name: "one", kind: "api", modules: ["missing"] }], code: "delivery-unknown-module" },
    { targets: [{ name: "jobs", kind: "api", modules: ["orders"] }], code: "delivery-reserved-target" },
    { targets: [{ name: "one", kind: "jobs", modules: ["orders"] }], code: "delivery-empty-target" },
  ])("rejects invalid ownership: $code", ({ targets, code }) => {
    const result = createDeliveryPlan(graph(http("orders")), { version: 1, targets });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(code);
  });

  test("rejects missing imports and cycles", () => {
    expect(createDeliveryPlan(graph(http("orders", ["missing"]))).diagnostics.map((item) => item.code))
      .toContain("delivery-missing-import");
    expect(createDeliveryPlan(graph(http("orders", ["shared"]), module("shared", ["orders"]))).diagnostics.map((item) => item.code))
      .toContain("delivery-import-cycle");
  });

  test("rejects public path parameter aliases and duplicate job names", () => {
    const a = http("orders");
    const controller = requireValue(a.controllers[0]);
    const b: ModuleNode = { ...http("other"), controllers: [{
      ...controller, className: "Other", routes: [{ method: "GET", path: "/:key", handler: "get" }],
    }] };
    a.controllers = [{ ...controller, routes: [{ method: "GET", path: "/:id", handler: "get" }] }];
    const result = createDeliveryPlan(graph(a, b));
    expect(result.diagnostics.map((item) => item.code)).toContain("delivery-route-conflict");
    const duplicate = createDeliveryPlan(graph(jobs, { ...jobs, name: "other" }, module("shared")), { version: 1, runtime });
    expect(duplicate.diagnostics.map((item) => item.code)).toContain("delivery-job-conflict");
  });

  test("analysis failures prevent a successful plan", () => {
    const result = createDeliveryPlan({ ...graph(http("orders")), diagnostics: [{
      severity: "error", code: "contract-rejected", message: "Invalid response schema",
    }] });
    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.diagnostics.map((item) => item.code)).toContain("contract-rejected");
  });
});
