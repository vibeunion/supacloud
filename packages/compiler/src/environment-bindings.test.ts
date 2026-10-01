import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "./analyze";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";
import { writeFixtureProject } from "./fixtures/helpers";
import {
  ENVIRONMENT_BINDINGS_LIMITS,
  ENVIRONMENT_BINDINGS_SCHEMA,
  EnvironmentBindingError,
  formatEnvironmentBindings,
  formatRuntimeBindings,
  parseEnvironmentBindings,
  resolveEnvironmentBindings,
  resolveRuntimeBindings,
} from "./environment-bindings";
import type { ApplicationGraph } from "./types";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const RESOURCES = `import { InfraResource } from "../../runtime";

@InfraResource({ name: "orders-db", kind: "database" })
export class OrdersDatabase {}

@InfraResource({ name: "attachments", kind: "bucket" })
export class AttachmentsBucket {}
`;

async function graph(): Promise<ApplicationGraph> {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-environment-bindings-"));
  roots.push(rootDir);
  await writeFixtureProject(rootDir, {
    "tsconfig.json": FIXTURE_TSCONFIG,
    "src/runtime.ts": RUNTIME_SOURCE,
    "src/features/orders/resources.ts": RESOURCES,
  });
  return analyzeProject(rootDir);
}

function document(environments: Record<string, Record<string, string>>) {
  return parseEnvironmentBindings({
    schema: ENVIRONMENT_BINDINGS_SCHEMA,
    environments: Object.fromEntries(Object.entries(environments).map(([name, bindings]) => [name, { bindings }])),
  });
}

const complete = { "orders-db": "project:orders", attachments: "bucket:attachments" };

test("resolves a complete static projection deterministically", async () => {
  const result = resolveEnvironmentBindings(await graph(), document({ production: complete }), "production");
  expect(result.diagnostics).toEqual([]);
  expect(result.projection.schema).toBe("supacloud.environment-bindings.v1");
  expect(result.projection.bindings).toEqual([
    { resource: "attachments", kind: "bucket", binding: "bucket:attachments" },
    { resource: "orders-db", kind: "database", binding: "project:orders" },
  ]);
  expect(formatEnvironmentBindings(result)).toContain("attachments (bucket) -> bucket:attachments");
});

test("reports missing, unknown and credential-shaped bindings", async () => {
  const result = resolveEnvironmentBindings(await graph(), document({
    test: { "orders-db": "postgres://user:pass@host/orders", obsolete: "local" },
  }), "test");
  const codes = result.diagnostics.map((diagnostic) => diagnostic.code).sort();
  expect(codes).toEqual(["invalid-environment-binding", "missing-environment-binding", "unknown-environment-binding"]);
  expect(result.projection.bindings).toEqual([]);
});

test("accepts local and namespaced references and rejects an unknown environment", async () => {
  const graphValue = await graph();
  expect(resolveEnvironmentBindings(graphValue, document({ local: { "orders-db": "local", attachments: "local" } }), "local")
    .diagnostics).toEqual([]);
  expect(() => resolveEnvironmentBindings(graphValue, document({ local: complete }), "staging"))
    .toThrow(new EnvironmentBindingError("ENVIRONMENT_BINDINGS_UNKNOWN_ENVIRONMENT"));
});

test("rejects malformed documents before resolution", () => {
  const cases: unknown[] = [
    null,
    { schema: "supacloud.environments.v2", environments: {} },
    { schema: ENVIRONMENT_BINDINGS_SCHEMA, environments: { "Bad Name": { bindings: {} } } },
    { schema: ENVIRONMENT_BINDINGS_SCHEMA, environments: { test: { bindings: { "orders-db": 3 } } } },
    { schema: ENVIRONMENT_BINDINGS_SCHEMA, environments: { test: { bindings: {} }, extra: {} } },
  ];
  for (const value of cases) expect(() => parseEnvironmentBindings(value)).toThrow();
});

test("bounds the environment and binding counts", () => {
  const environments = Object.fromEntries(Array.from({ length: ENVIRONMENT_BINDINGS_LIMITS.environments + 1 },
    (_, index) => [`env-${String(index).padStart(2, "0")}`, { bindings: {} }]));
  expect(() => parseEnvironmentBindings({ schema: ENVIRONMENT_BINDINGS_SCHEMA, environments }))
    .toThrow(new EnvironmentBindingError("ENVIRONMENT_BINDINGS_TOO_LARGE"));

  const bindings = Object.fromEntries(Array.from({ length: ENVIRONMENT_BINDINGS_LIMITS.bindings + 1 },
    (_, index) => [`resource-${index}`, "local"]));
  expect(() => parseEnvironmentBindings({ schema: ENVIRONMENT_BINDINGS_SCHEMA, environments: { test: { bindings } } }))
    .toThrow(new EnvironmentBindingError("ENVIRONMENT_BINDINGS_TOO_LARGE"));
});
test("fast resolves every resource to an ephemeral local binding", async () => {
  const result = resolveRuntimeBindings(await graph(),
    document({ fast: { "orders-db": "local", attachments: "local" } }), "fast", "fast");
  expect(result.diagnostics).toEqual([]);
  expect(result.projection.credentials).toBe("resolved-by-local-runner");
  expect(result.projection.bindings.every((entry) => entry.mode === "ephemeral")).toBe(true);
  expect(formatRuntimeBindings(result)).toContain("[ephemeral]");
});

test("fast rejects a non-local binding and integration keeps it external", async () => {
  const graphValue = await graph();
  const fast = resolveRuntimeBindings(graphValue, document({ fast: complete }), "fast", "fast");
  expect(fast.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["invalid-environment-binding", "invalid-environment-binding"]);
  expect(fast.projection.bindings).toEqual([]);

  const integration = resolveRuntimeBindings(graphValue, document({ integration: complete }), "integration", "integration");
  expect(integration.diagnostics).toEqual([]);
  expect(integration.projection.bindings.every((entry) => entry.mode === "external")).toBe(true);
});

test("refuses a production-shaped environment before reading anything", async () => {
  const graphValue = await graph();
  for (const environment of ["production", "prod", "prod-eu", "live"]) {
    expect(() => resolveRuntimeBindings(graphValue, document({ [environment]: complete }), environment, "fast"))
      .toThrow(new EnvironmentBindingError("ENVIRONMENT_BINDINGS_PRODUCTION_FORBIDDEN"));
  }
});
