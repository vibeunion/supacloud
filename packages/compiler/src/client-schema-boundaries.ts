import { resolve } from "node:path";
import type { ApplicationGraph, CompileOptions, Diagnostic } from "./types";

/** Detect direct schema imports from known application runtime modules without evaluating source. */
export function validateClientSchemaBoundaries(
  graph: ApplicationGraph,
  options: Pick<CompileOptions, "rootDir" | "generateClient">,
): Diagnostic[] {
  if (!options.generateClient) return [];
  const identity = (path: string) => resolve(options.rootDir, path).replace(/\.(?:[cm]?ts|[cm]?js)$/, "");
  const runtimeModules = new Set(graph.modules.flatMap(module => [
    module.file,
    ...module.controllers.map(controller => controller.file),
    ...module.providers.map(provider => provider.file),
  ]).filter((file): file is string => typeof file === "string").map(identity));
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const module of graph.modules) {
    for (const controller of module.controllers) {
      for (const route of controller.routes) {
        const symbols = [
          route.body, route.params, route.query, route.headers, route.cookie,
          ...(route.responses && Object.keys(route.responses).length ? Object.values(route.responses) : [route.response]),
        ];
        for (const symbol of symbols) {
          if (!symbol) continue;
          const importedFrom = controller.schemaImports?.[symbol];
          if (!importedFrom || !runtimeModules.has(identity(importedFrom))) continue;
          const key = `${identity(importedFrom)}:${symbol}`;
          if (seen.has(key)) continue;
          seen.add(key);
          diagnostics.push({
            severity: "warn",
            code: "client-schema-runtime-import",
            file: controller.file,
            message: `Generated client schema "${symbol}" imports application runtime module "${importedFrom}". Move the schema to a shared contract-only module and import it into the controller. This also avoids checking server decorators in the browser TypeScript project.`,
          });
        }
      }
    }
  }
  return diagnostics;
}
