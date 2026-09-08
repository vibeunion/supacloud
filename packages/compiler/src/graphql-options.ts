import { extname } from "node:path";
import type { GraphqlOptions } from "./types";

const optionNames = new Set(["schema", "documents", "scalars", "typedDocuments"]);

export class GraphqlConfigurationError extends Error {
  readonly code = "graphql-config-invalid";

  constructor(detail: string) {
    super(`GraphQL supports Database First only. ${detail}`);
    this.name = "GraphqlConfigurationError";
  }
}

/** Validate before resolving paths so URLs cannot turn into apparently local filenames. */
export function assertGraphqlOptions(value: unknown): asserts value is GraphqlOptions {
  function fail(detail: string): never {
    throw new GraphqlConfigurationError(detail);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Configure a local role-scoped database snapshot using graphql.schema.");
  }
  const options = value as Record<string, unknown>;
  const unsupported = Object.keys(options).filter((key) => !optionNames.has(key)).sort();
  if (unsupported.length) {
    fail(`Unsupported options: ${unsupported.join(", ")}. Configure only schema, documents, scalars and typedDocuments; server schema authoring modes are not supported.`);
  }
  const schema = options.schema;
  if (typeof schema !== "string" || !schema.trim() || schema !== schema.trim() || /[\r\n\0]/.test(schema)
    || (/^[a-z][a-z0-9+.-]*:/i.test(schema) && !/^[a-z]:[\\/]/i.test(schema))
    || ![".graphql", ".gql", ".json"].includes(extname(schema))) {
    fail("graphql.schema must be a local .graphql, .gql or .json database snapshot. Export it with graphql-schema; URLs, inline SDL and executable schema sources are not supported.");
  }
  if (options.documents !== undefined && (!Array.isArray(options.documents)
    || options.documents.some((pattern) => typeof pattern !== "string" || !pattern.trim()))) {
    fail("graphql.documents must contain local query/fragment glob strings.");
  }
  if (options.typedDocuments !== undefined && typeof options.typedDocuments !== "boolean") {
    fail("graphql.typedDocuments must be a boolean output option.");
  }
  if (options.scalars !== undefined) {
    if (!options.scalars || typeof options.scalars !== "object" || Array.isArray(options.scalars)) {
      fail("graphql.scalars must be a map of explicit wire types.");
    }
    for (const mapping of Object.values(options.scalars)) {
      if (typeof mapping === "string" && mapping.trim()) continue;
      if (mapping && typeof mapping === "object" && !Array.isArray(mapping)
        && "input" in mapping && typeof mapping.input === "string" && mapping.input.trim()
        && "output" in mapping && typeof mapping.output === "string" && mapping.output.trim()) continue;
      fail("Each scalar mapping must be a type string or an object with input and output type strings.");
    }
  }
}
