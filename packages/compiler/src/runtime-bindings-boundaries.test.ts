import { expect, test } from "bun:test";
import {
  ENVIRONMENT_BINDINGS_LIMITS, ENVIRONMENT_BINDINGS_SCHEMA,
  EnvironmentBindingError, parseEnvironmentBindings,
  resolveEnvironmentBindings, resolveRuntimeBindings, formatRuntimeBindings,
} from "./environment-bindings";
import type { ApplicationGraph } from "./types";

function fixture(names: string[], binding: (index: number) => string = () => "local") {
  const graph: ApplicationGraph = {
    modules: [], externalTokens: [],
    resources: names.map(name => ({
      name, kind: "database" as const, className: "Database", file: "resource.ts", line: 1, importPath: "./resource",
    })),
  };
  const document = parseEnvironmentBindings({
    schema: ENVIRONMENT_BINDINGS_SCHEMA,
    environments: { staging: { bindings: Object.fromEntries(names.map((name, index) => [name, binding(index)])) } },
  });
  return { graph, document };
}

const names = Array.from({ length: 65 }, (_, index) => `resource-${String(index).padStart(3, "0")}`);

test("fast refuses a nonlocal resource beyond the 64-entry display cap", () => {
  const { graph, document } = fixture(names, index => index === 64 ? "project:external" : "local");
  const result = resolveRuntimeBindings(graph, document, "staging", "fast");
  expect(result.diagnostics).toEqual([{
    code: "invalid-environment-binding", severity: "error", environment: "staging", resource: names[64],
    message: `Profile 'fast' requires '${names[64]}' to bind to 'local'`,
  }]);
  expect(result.projection.bindings).toHaveLength(64);
  expect(result.projection.omitted.resources).toBe(0);
});

test("integration reports all valid bindings omitted from its display slice", () => {
  const { graph, document } = fixture(names, () => "project:external");
  const result = resolveRuntimeBindings(graph, document, "staging", "integration");
  expect(result.diagnostics).toEqual([]);
  expect(result.projection.bindings).toHaveLength(64);
  expect(result.projection.omitted.resources).toBe(1);
  expect(formatRuntimeBindings(result)).toContain("omitted: 1");
});

test("production-shaped references are refused even in an innocently named environment", () => {
  const { graph, document } = fixture(names, index => index === 64 ? "project:production" : "local");
  expect(() => resolveRuntimeBindings(graph, document, "staging", "integration"))
    .toThrow(new EnvironmentBindingError("ENVIRONMENT_BINDINGS_PRODUCTION_FORBIDDEN"));
});

test("runtime diagnostics obey the output budget rather than inheriting static success", () => {
  const longNames = Array.from({ length: 128 }, (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(490)}`);
  const { graph, document } = fixture(longNames, () => "project:external");
  expect(resolveEnvironmentBindings(graph, document, "staging").diagnostics).toEqual([]);
  expect(() => resolveRuntimeBindings(graph, document, "staging", "fast"))
    .toThrow(new EnvironmentBindingError("ENVIRONMENT_BINDINGS_TOO_LARGE"));
});

test("runtime metadata cannot push a near-limit UTF-8 static projection over budget", () => {
  let exercised = false;
  for (let length = 200; length <= 400; length++) {
    const { graph, document } = fixture(Array.from({ length: 64 }, (_, index) => `${String(index).padStart(3, "0")}-${"测".repeat(length)}`));
    let result: ReturnType<typeof resolveEnvironmentBindings>;
    try { result = resolveEnvironmentBindings(graph, document, "staging"); }
    catch (error) {
      if (error instanceof EnvironmentBindingError && error.code === "ENVIRONMENT_BINDINGS_TOO_LARGE") continue;
      throw error;
    }
    const bytes = Buffer.byteLength(JSON.stringify({ ...result.projection, diagnostics: result.diagnostics }, null, 2)) + 1;
    if (bytes < ENVIRONMENT_BINDINGS_LIMITS.outputBytes - 500) continue;
    expect(() => resolveRuntimeBindings(graph, document, "staging", "integration"))
      .toThrow(new EnvironmentBindingError("ENVIRONMENT_BINDINGS_TOO_LARGE"));
    exercised = true;
    break;
  }
  expect(exercised).toBe(true);
});
