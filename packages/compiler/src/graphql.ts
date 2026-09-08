import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import {
  buildClientSchema,
  buildSchema,
  concatAST,
  GraphQLError,
  Kind,
  parse,
  print,
  printSchema,
  separateOperations,
  Source,
  validate,
  validateSchema,
  type DocumentNode,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";
import { codegen } from "@graphql-codegen/core";
import * as operations from "@graphql-codegen/typescript-operations";
import type { CompileOptions, Diagnostic, GraphqlContractSummary } from "./types";
import { GRAPHQL_CLIENT_SOURCE } from "./graphql-client";
import { graphqlInputPaths } from "./graphql-inputs";
import { assertGraphqlOptions } from "./graphql-options";

export interface GraphqlArtifacts {
  diagnostics: Diagnostic[];
  files: Record<string, string>;
  contract?: GraphqlContractSummary;
}

/** Offline only: schema authority and role selection belong to the explicit snapshot workflow. */
export async function renderGraphql(options: CompileOptions): Promise<GraphqlArtifacts> {
  const result: GraphqlArtifacts = { diagnostics: [], files: {} };
  if (!options.graphql) return result;
  try {
    assertGraphqlOptions(options.graphql);
  } catch (error) {
    result.diagnostics.push({
      code: "graphql-config-invalid",
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
      suggestion: "Use a local role-scoped snapshot exported by graphql-schema. Change database declarations and re-export; author only queries and fragments.",
    });
    return result;
  }
  const paths = graphqlInputPaths(options);
  const schemaPath = paths[0]!;
  const localPath = (path: string): string => relative(options.rootDir, path).split(sep).join("/");
  const contract: GraphqlContractSummary = {
    schema: localPath(schemaPath),
    documents: paths.slice(1).map(localPath),
    operations: [],
  };
  result.contract = contract;
  const diagnostic = (code: string, error: unknown, file?: string): void => {
    const gql = error instanceof GraphQLError ? error : undefined;
    const source = gql?.source?.name ?? gql?.nodes?.[0]?.loc?.source.name ?? file;
    result.diagnostics.push({
      severity: "error",
      code,
      message: error instanceof Error ? error.message : String(error),
      file: source ? localPath(source) : undefined,
      line: gql?.locations?.[0]?.line,
      suggestion: "Update the role-scoped local schema snapshot or correct the query, then recompile.",
    });
  };
  let schema: GraphQLSchema;
  let schemaContent: string;
  try {
    schemaContent = await readFile(schemaPath, "utf8");
    contract.schemaHash = createHash("sha256").update(schemaContent).digest("hex");
    if (schemaPath.endsWith(".json")) {
      const json = JSON.parse(schemaContent) as { data?: IntrospectionQuery; __schema?: unknown };
      schema = buildClientSchema((json.data ?? json) as IntrospectionQuery);
    } else {
      schema = buildSchema(new Source(schemaContent, schemaPath));
    }
    for (const error of validateSchema(schema)) diagnostic("graphql-schema-invalid", error, schemaPath);
  } catch (error) {
    diagnostic("graphql-schema-invalid", error, schemaPath);
    return result;
  }
  if (result.diagnostics.length) return result;
  const documents: Array<{ location: string; document: DocumentNode }> = [];
  for (const path of paths.slice(1)) {
    try {
      documents.push({ location: path, document: parse(new Source(await readFile(path, "utf8"), path)) });
    } catch (error) {
      diagnostic("graphql-document-invalid", error, path);
    }
  }
  if (result.diagnostics.length) return result;
  if (!documents.length) {
    diagnostic("graphql-documents-missing", new Error("No GraphQL query documents matched the configured patterns."), schemaPath);
    return result;
  }
  const combined = concatAST(documents.map(({ document }) => document));
  const queryEntries = contract.operations;
  for (const definition of combined.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION && definition.kind !== Kind.FRAGMENT_DEFINITION) {
      diagnostic("graphql-document-invalid", new GraphQLError("Query documents may contain only operations and fragments.", { nodes: definition }));
    }
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    if (definition.operation !== "query") {
      result.diagnostics.push({
        severity: "error",
        code: "graphql-query-only",
        message: "Only GraphQL queries are supported. Use the governed Command API for business writes; subscriptions require a separate transport.",
        file: definition.loc ? localPath(definition.loc.source.name) : undefined,
        line: definition.loc?.startToken.line,
        suggestion: "Remove this operation from the query documents. Do not bypass Command permissions, audit or transaction governance.",
      });
    }
    if (!definition.name) {
      diagnostic("graphql-operation-name-required", new GraphQLError("Name each query to generate a stable client method.", { nodes: definition }));
    } else {
      queryEntries.push({
        name: definition.name.value,
        file: localPath(definition.loc!.source.name),
        line: definition.loc!.startToken.line,
      });
    }
  }
  for (const error of validate(schema, combined)) diagnostic("graphql-validation", error);
  if (result.diagnostics.length) return result;
  try {
    const config = {
      useTypeImports: true,
      nonOptionalTypename: false,
      enumType: "string-literal",
      namingConvention: "keep",
      dedupeOperationSuffix: false,
      omitOperationSuffix: false,
      defaultScalarType: "unknown",
      scalars: { ID: { input: "string", output: "string" }, ...options.graphql.scalars },
    } satisfies operations.TypeScriptDocumentsPluginConfig;
    const generated = await codegen({
      filename: "graphql.ts",
      schema: parse(printSchema(schema)),
      schemaAst: schema,
      documents,
      config,
      // Operations v6 owns referenced enums and inputs as well as operation types.
      plugins: [{ operations: {} }],
      pluginMap: { operations },
    });
    const separated = separateOperations(combined);
    const methods = Object.entries(separated).sort(([a], [b]) => a.localeCompare(b)).map(([name, document]) => {
      const operation = document.definitions.find((node) => node.kind === Kind.OPERATION_DEFINITION)!;
      if (operation.kind !== Kind.OPERATION_DEFINITION) throw new Error("Missing query operation");
      const required = operation.variableDefinitions?.some((variable) =>
        variable.type.kind === Kind.NON_NULL_TYPE && !variable.defaultValue);
      return `    ${JSON.stringify(name)}(variables${required ? "" : "?"}: ${name}QueryVariables, options?: C): Promise<${name}Query> {
      return requester<${name}Query, ${name}QueryVariables>(${JSON.stringify(print(document))}, variables, options);
    }`;
    });
    const facade = `
export type Requester<C> = <R, V>(query: string, variables?: V, options?: C) => Promise<R>;
export function getSdk<C>(requester: Requester<C>) {
  return {
${methods.join(",\n")}
  };
}
`;
    result.files["graphql.ts"] = "// GENERATED BY @supacloud/compiler. DO NOT EDIT.\n" + generated + facade + GRAPHQL_CLIENT_SOURCE;
    if (options.graphql.typedDocuments) {
      const typedDocuments = await import("@graphql-codegen/typed-document-node");
      result.files["graphql.documents.ts"] = "// GENERATED BY @supacloud/compiler. DO NOT EDIT.\n" + await codegen({
        filename: "graphql.documents.ts",
        schema: parse(printSchema(schema)),
        schemaAst: schema,
        documents,
        config,
        plugins: [{ operations: {} }, { typedDocuments: {} }],
        pluginMap: { operations, typedDocuments },
      });
    }
    result.files["graphql.manifest.json"] = JSON.stringify({
      version: 1,
      mode: "query-only",
      ...contract,
      operations: queryEntries.sort((a, b) => a.name.localeCompare(b.name)),
    }, null, 2) + "\n";
  } catch (error) {
    diagnostic("graphql-generation-failed", error);
  }
  return result;
}
