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
  specifiedRules,
  NoUnusedFragmentsRule,
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
import { renderGraphqlValidators, type GraphqlOperationKind } from "./graphql-runtime";
import { graphqlSchemaHashes } from "./graphql-schema-hashes";

export interface GraphqlArtifacts {
  diagnostics: Diagnostic[];
  files: Record<string, string>;
  contract?: GraphqlContractSummary;
}

function persistedOperationHash(document: DocumentNode): string {
  return createHash("sha256").update(print(document)).digest("hex");
}

function sdkMethodName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
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
    mode: options.graphql.mutations ? "query-mutation" : "query-only",
    documents: paths.slice(1).map(localPath),
    operations: [],
  };
  const operationKinds = new Map<string, GraphqlOperationKind>();
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
    Object.assign(contract, graphqlSchemaHashes(schemaContent));
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
    if (definition.operation === "subscription") {
      result.diagnostics.push({
        severity: "error",
        code: "graphql-query-only",
        message: "GraphQL subscriptions are not supported by the HTTP contract compiler. Use the governed Realtime transport for subscriptions.",
        file: definition.loc ? localPath(definition.loc.source.name) : undefined,
        line: definition.loc?.startToken.line,
        suggestion: "Remove this subscription from the GraphQL documents and use the supported Realtime contract.",
      });
    } else if (definition.operation === "mutation" && !options.graphql.mutations) {
      result.diagnostics.push({
        severity: "error",
        code: "graphql-query-only",
        message: "GraphQL mutations are disabled by default. Set graphql.mutations to true only after reviewing database grants, RLS, audit and idempotency behavior.",
        file: definition.loc ? localPath(definition.loc.source.name) : undefined,
        line: definition.loc?.startToken.line,
        suggestion: "Keep business writes in the governed Command API, or explicitly opt in with graphql.mutations: true.",
      });
    }
    if (!definition.name) {
      diagnostic("graphql-operation-name-required", new GraphQLError("Name each query to generate a stable client method.", { nodes: definition }));
    } else {
      if (definition.operation !== "subscription") {
        operationKinds.set(definition.name.value, definition.operation);
      }
      queryEntries.push({
        name: definition.name.value,
        file: localPath(definition.loc!.source.name),
        line: definition.loc!.startToken.line,
      });
    }
  }
  // Fragment-only files are valid inputs for incremental authoring. A fragment
  // can be temporarily unused while an operation is being edited; schema and
  // operation validation must still remain strict.
  for (const error of validate(
    schema,
    combined,
    specifiedRules.filter(rule => rule !== NoUnusedFragmentsRule),
  )) diagnostic("graphql-validation", error);
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
      const operation = document.definitions.find((node) => node.kind === Kind.OPERATION_DEFINITION);
      if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) throw new Error("Missing query operation");
      const suffix = operation.operation === "mutation" ? "Mutation" : "Query";
      const required = operation.variableDefinitions?.some((variable) =>
        variable.type.kind === Kind.NON_NULL_TYPE && !variable.defaultValue);
    return `    async ${sdkMethodName(name)}(variables${required ? "" : "?"}: ${name}${suffix}Variables, options?: C): Promise<${name}${suffix}> {
      return parse${name}${suffix}(await requester(${JSON.stringify(print(document))}, variables, options, {
        name: ${JSON.stringify(name)}, sha256: ${JSON.stringify(persistedOperationHash(document))},
      }));
    }`;
    });
    const facade = `
export type Requester<C> = (
  query: string, variables?: unknown, options?: C, operation?: GraphqlOperationMetadata,
) => Promise<unknown>;
export function getSdk<C>(requester: Requester<C>) {
  return {
${methods.join(",\n")}
  };
}
`;
    const validators = renderGraphqlValidators(generated, queryEntries.map((entry) => entry.name), operationKinds);
    result.files["graphql.ts"] = "// GENERATED BY @supacloud/compiler. DO NOT EDIT.\n"
      + generated + validators + facade + GRAPHQL_CLIENT_SOURCE;
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
      mode: options.graphql.mutations ? "query-mutation" : "query-only",
      ...contract,
      operations: queryEntries.sort((a, b) => a.name.localeCompare(b.name)),
      persisted_operations: Object.entries(separated)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, document]) => ({
          name,
          sha256: persistedOperationHash(document),
          query: print(document),
        })),
    }, null, 2) + "\n";
  } catch (error) {
    diagnostic("graphql-generation-failed", error);
  }
  return result;
}
