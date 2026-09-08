import { resolve } from "node:path";
import * as ts from "@typescript/typescript6";
import type { CompileOptions } from "./types";
import { assertGraphqlOptions } from "./graphql-options";

/** Shared inventory keeps optional GraphQL inputs in the incremental cache without loading codegen. */
export function graphqlInputPaths(options: CompileOptions): string[] {
  if (!options.graphql) return [];
  try {
    assertGraphqlOptions(options.graphql);
  } catch {
    // Rendering reports the structured error; invalid sources must not enter the file inventory.
    return [];
  }
  const root = resolve(options.rootDir);
  const schema = resolve(root, options.graphql.schema);
  const documents = ts.sys.readDirectory(
    root,
    [".graphql", ".gql"],
    ["**/node_modules/**", "**/.git/**", resolve(options.outDir)],
    options.graphql.documents ?? ["**/*.graphql", "**/*.gql"],
  ).map((path) => resolve(path)).filter((path) => path !== schema);
  return [schema, ...[...new Set(documents)].sort()];
}
