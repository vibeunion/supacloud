import { expect, test } from "bun:test";
import { createApplicationDevelopmentContext, parseApplicationDevelopmentContext } from "./application-development";
import type { ApplicationDevelopmentContext } from "./application-development";
import type { ApplicationGraph } from "./types";
import type { DeliveryTarget } from "./delivery-schema";
import { renderDeliveryTarget } from "./delivery-render";

function graph(): ApplicationGraph {
  return { externalTokens: [], modules: [{
    name: "orders", className: "OrdersModule", file: "src/orders.ts", line: 1,
    imports: [], providers: [], controllers: [{ className: "OrdersController", path: "/orders",
      file: "src/orders.ts", importPath: "src/orders", scope: "application", deps: [],
      routes: [{ method: "POST", path: "/", handler: "create", command: "CreateOrder",
        schemaKinds: { body: "declared" }, aspects: [{ name: "Trace", expression: "PRIVATE" }] }],
    }], commands: [{ name: "orders.create", className: "CreateOrder", transaction: "required", idempotency: "required" }],
    jobs: [{ name: "orders.cleanup", className: "Cleanup", serviceKey: "Cleanup", scope: "job", mode: "task" }],
    queries: [], exports: [],
  }], resources: [{ name: "cleanup-queue", kind: "queue", className: "Queue", file: "src/queue.ts", line: 1, importPath: "src/queue" }],
  resourceUses: [{ module: "orders", job: "orders.cleanup", resource: "cleanup-queue", resourceClass: "Queue", operations: ["consume"] }],
  diagnostics: [{ code: "test-warning", severity: "warn", file: "src/orders.ts", line: 1, message: "PRIVATE",
    fix: { type: "add_provider", targetFile: "src/orders.ts", module: "orders", token: "PRIVATE" } }],
  };
}
const target: DeliveryTarget = {
  name: "api", kind: "api", isolation: "shared", roots: ["orders"],
  modules: [{ name: "orders", reason: "owner", importedBy: [] }],
  routes: [{ module: "orders", controller: "OrdersController", handler: "create", method: "POST", path: "/orders", command: "orders.create", reason: "default-http" }],
  jobs: [], externalTokens: [], requirements: { processIsolation: false, durableQueue: false, capabilities: [] }, runtimeStatus: "unchecked",
};
const render = (source: ApplicationGraph) => renderDeliveryTarget(source, target, { rootDir: "/project/src", outDir: "/project/generated" });

test("serialized development context round trips without retaining caller-owned objects", () => {
  const context = createApplicationDevelopmentContext(graph());
  const parsed = parseApplicationDevelopmentContext(context);
  expect(parsed).toEqual(context);
  expect(parsed).not.toBe(context);
  parsed.modules[0]!.name = "changed";
  expect(context.modules[0]!.name).toBe("orders");
});

const invalid: [string, (context: ApplicationDevelopmentContext) => void][] = [
  ["null module", c => { Object.assign(c, { modules: [null] }); }],
  ["array limits", c => { Object.assign(c, { limits: [] }); }],
  ["array omission counters", c => { Object.assign(c, { omitted: [] }); }],
  ["incorrect limits", c => { c.limits = { ...c.limits, outputBytes: 1 }; }],
  ["negative omission", c => { c.omitted.routes = -1; }],
  ["fractional omission", c => { c.omitted.routes = 0.5; }],
  ["unsafe integer omission", c => { c.omitted.routes = Number.MAX_SAFE_INTEGER + 1; }],
  ["top-level credential", c => { Object.assign(c, { secret: "PRIVATE" }); }],
  ["module expression", c => { Object.assign(c.modules[0]!, { expression: "PRIVATE" }); }],
  ["route payload", c => { Object.assign(c.routes[0]!, { body: "PRIVATE" }); }],
  ["diagnostic message", c => { Object.assign(c.diagnostics[0]!, { message: "PRIVATE" }); }],
  ["repair replacement", c => { Object.assign(c.diagnostics[0]!.repair!, { value: "PRIVATE" }); }],
  ["invalid repair kind", c => { c.diagnostics[0]!.repair!.type = "PRIVATE"; }],
  ["invalid diagnostic line", c => { c.diagnostics[0]!.line = 0; }],
  ["traversing source", c => { c.modules[0]!.file = "../PRIVATE.ts"; }],
  ["absolute source", c => { c.diagnostics[0]!.file = "C:\\PRIVATE\\a.ts"; }],
  ["invalid HTTP method", c => { c.routes[0]!.method = "PRIVATE"; }],
  ["invalid schema key", c => { c.routes[0]!.schemaKinds = { PRIVATE: "declared" }; }],
  ["invalid job mode", c => { c.jobs[0]!.mode = "PRIVATE"; }],
  ["invalid resource kind", c => { c.resources[0]!.kind = "PRIVATE"; }],
  ["invalid operation", c => { c.resourceUses[0]!.operations = ["PRIVATE"]; }],
  ["invalid execution stage", c => { c.executionPlans[0]!.stages = ["PRIVATE"]; }],
  ["source expression in plan", c => { Object.assign(c.executionPlans[0]!, { expression: "PRIVATE" }); }],
  ["control characters", c => { c.modules[0]!.name = "PRIVATE\n"; }],
  ["module cap", c => { c.modules = Array.from({ length: 65 }, () => c.modules[0]!); }],
  ["document-wide provider cap", c => { c.modules[0]!.providers = Array.from({ length: 129 }, (_, i) => `p${i}`); }],
];
test.each(invalid)("rejects %s without echoing input", (_name, mutate) => {
  const context = createApplicationDevelopmentContext(graph());
  mutate(context);
  expect(() => parseApplicationDevelopmentContext(context)).toThrow("APPLICATION_DEVELOPMENT_INVALID");
});

test("delivery projection excludes resource uses and declarations for jobs outside the target", () => {
  const context = parseApplicationDevelopmentContext(JSON.parse(render(graph()).applicationDevelopment));
  expect(context.jobs).toEqual([]);
  expect(context.resourceUses).toEqual([]);
  expect(context.resources).toEqual([]);
  expect(context.executionPlans.some(plan => plan.kind === "job")).toBe(false);
});

test("delivery writer never emits an archive that exceeds its reader's byte budget", () => {
  const source = graph();
  source.modules[0]!.tags = Array.from({ length: 1600 }, (_, i) => `tag-${i}-${"x".repeat(380)}`);
  expect(() => render(source)).toThrow("APPLICATION_DEVELOPMENT_TOO_LARGE");
});
