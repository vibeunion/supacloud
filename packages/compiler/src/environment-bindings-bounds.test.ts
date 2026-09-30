import { expect, test } from "bun:test";
import {
  parseEnvironmentBindings, resolveEnvironmentBindings, formatEnvironmentBindings,
  ENVIRONMENT_BINDINGS_LIMITS,
} from "./environment-bindings";
import type { ApplicationGraph } from "./types";

const graph = (names: string[]) => ({ resources: names.map(name => ({ name, kind: "database" })) }) as ApplicationGraph;
const document = (bindings: Record<string, string>) => parseEnvironmentBindings({
  schema: "supacloud.environments.v1", environments: { test: { bindings } },
});

test("bounds JSON and text bytes including multibyte names and diagnostics", () => {
  const names = Array.from({ length: 64 }, (_, index) => `r${index}${"界".repeat(500)}`);
  expect(() => resolveEnvironmentBindings(graph(names), document(Object.fromEntries(names.map(name => [name, "local"]))), "test"))
    .toThrow("ENVIRONMENT_BINDINGS_TOO_LARGE");
  expect(() => resolveEnvironmentBindings(graph([]), document(Object.fromEntries(names.map(name => [name, "local"]))), "test"))
    .toThrow("ENVIRONMENT_BINDINGS_TOO_LARGE");
  const result = resolveEnvironmentBindings(graph(["orders"]), document({ orders: "local" }), "test");
  expect(Buffer.byteLength(JSON.stringify({ ...result.projection, diagnostics: result.diagnostics }, null, 2)) + 1)
    .toBeLessThanOrEqual(ENVIRONMENT_BINDINGS_LIMITS.outputBytes);
  result.diagnostics.push({ code: "invalid-environment-binding", severity: "error", environment: "test", message: "界".repeat(30_000) });
  expect(() => formatEnvironmentBindings(result)).toThrow("ENVIRONMENT_BINDINGS_TOO_LARGE");
});

test("rejects newline-terminated references without leaking the submitted value", () => {
  for (const binding of ["local\n", "secret:orders\n", "local\r\n", "postgres://private:password@host/db"]) {
    const result = resolveEnvironmentBindings(graph(["orders"]), document({ orders: binding }), "test");
    expect(result.projection.bindings).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("invalid-environment-binding");
    expect(JSON.stringify(result)).not.toContain("password");
  }
});

test("prototype properties are neither environments nor resource bindings", () => {
  expect(() => resolveEnvironmentBindings(graph([]), document({}), "constructor"))
    .toThrow("ENVIRONMENT_BINDINGS_UNKNOWN_ENVIRONMENT");
  const result = resolveEnvironmentBindings(graph(["constructor", "toString"]), document({}), "test");
  expect(result.diagnostics.map(item => item.code)).toEqual(["missing-environment-binding", "missing-environment-binding"]);
});

test("parsing detaches input and resolution revalidates mutated documents", () => {
  const raw = { schema: "supacloud.environments.v1", environments: { test: { bindings: { orders: "local" } } } };
  const parsed = parseEnvironmentBindings(raw);
  raw.environments.test.bindings.orders = "project:other";
  expect(parsed.environments.test?.bindings.orders).toBe("local");
  Object.assign(parsed.environments.test!, { unknown: "private" });
  expect(() => resolveEnvironmentBindings(graph(["orders"]), parsed, "test")).toThrow("ENVIRONMENT_BINDINGS_INVALID");
});
