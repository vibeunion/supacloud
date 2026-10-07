import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  isInterfaceType,
  isObjectType,
  isInputObjectType,
  Kind,
  parse,
  validate,
  type DocumentNode,
  type GraphQLField,
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";
import { graphqlSchemaHashes } from "./graphql-schema-hashes";

export type GraphqlSeverity = "error" | "warn";

export interface GraphqlGovernanceDiagnostic {
  severity: GraphqlSeverity;
  code: string;
  message: string;
  file?: string;
  line?: number;
  operation?: string;
}

export interface GraphqlGovernancePolicy {
  /** Exact operation names or simple '*' suffix patterns. */
  operations?: string[];
  maxDepth?: number;
  maxFields?: number;
  maxComplexity?: number;
  maxPageSize?: number;
}

export interface GraphqlOperationReport {
  name: string;
  operation: "query" | "mutation" | "subscription";
  depth: number;
  fields: number;
  complexity: number;
  pageSizes: number[];
  allowed: boolean;
}

export interface GraphqlFeatureMatrix {
  pgGraphql: "schema-snapshot";
  query: boolean;
  mutation: boolean;
  subscription: boolean;
  relayConnections: boolean;
  filtering: boolean;
  ordering: boolean;
  aggregation: boolean;
  byPk: boolean;
  functions: boolean;
}

export interface GraphqlCompatibilityReport {
  ok: boolean;
  schema: { path: string; schemaHash: string; schemaNormalizedHash: string };
  features: GraphqlFeatureMatrix;
  operations: GraphqlOperationReport[];
  diagnostics: GraphqlGovernanceDiagnostic[];
}

export interface GraphqlSchemaChange {
  severity: "breaking" | "non-breaking";
  code: string;
  message: string;
  path: string;
}

export interface GraphqlSchemaDiff {
  ok: boolean;
  breaking: GraphqlSchemaChange[];
  nonBreaking: GraphqlSchemaChange[];
}

export interface GraphqlRoleSnapshot {
  role: string;
  schema: string;
  schemaHash: string;
  schemaNormalizedHash: string;
}

export interface GraphqlRoleSnapshotReport {
  ok: boolean;
  roles: GraphqlRoleSnapshot[];
  diagnostics: GraphqlGovernanceDiagnostic[];
}

export function schemaFromSource(source: string, path = "schema.graphql"): GraphQLSchema {
  if (path.endsWith(".json")) {
    const json = JSON.parse(source) as { data?: IntrospectionQuery };
    return buildClientSchema((json.data ?? json) as IntrospectionQuery);
  }
  return buildSchema(source);
}

export async function readGraphqlSchema(path: string): Promise<{
  path: string;
  source: string;
  schema: GraphQLSchema;
  schemaHash: string;
  schemaNormalizedHash: string;
}> {
  const absolute = resolve(path);
  const source = await readFile(absolute, "utf8");
  const hashes = graphqlSchemaHashes(source);
  return { path: absolute, source, schema: schemaFromSource(source, absolute), ...hashes };
}

export function graphqlFeatureMatrix(schema: GraphQLSchema): GraphqlFeatureMatrix {
  const query = schema.getQueryType();
  const mutation = schema.getMutationType();
  const subscription = schema.getSubscriptionType();
  const rootFields = query ? Object.values(query.getFields()) : [];
  const names = rootFields.map((field) => field.name);
  return {
    pgGraphql: "schema-snapshot",
    query: Boolean(query),
    mutation: Boolean(mutation),
    subscription: Boolean(subscription),
    relayConnections: rootFields.some((field) => field.type.toString().includes("Connection")),
    filtering: names.some((name) => name === "filter" || name.endsWith("Collection")),
    ordering: names.some((name) => name === "orderBy" || name.endsWith("Collection")),
    aggregation: names.some((name) => name.toLowerCase().includes("aggregate")),
    byPk: names.some((name) => name.endsWith("ByPk")),
    functions: Boolean(query && Object.values(query.getFields()).some((field) => !field.name.endsWith("Collection") && !field.name.endsWith("ByPk"))),
  };
}

function allowedOperation(name: string, operations: readonly string[] | undefined): boolean {
  if (!operations || operations.length === 0) return true;
  return operations.some((pattern) => pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : name === pattern);
}

function unwrapNamed(type: GraphQLField<unknown, unknown>["type"]): GraphQLNamedType {
  let current = type;
  while ("ofType" in current) current = current.ofType;
  return current;
}

function numericLiteral(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function operationReport(
  schema: GraphQLSchema,
  operation: Extract<DocumentNode["definitions"][number], { kind: typeof Kind.OPERATION_DEFINITION }>,
  fragmentDefinitions: ReadonlyMap<string, Extract<DocumentNode["definitions"][number], { kind: typeof Kind.FRAGMENT_DEFINITION }>>,
  policy: GraphqlGovernancePolicy,
): { report: GraphqlOperationReport; diagnostics: GraphqlGovernanceDiagnostic[] } {
  const diagnostics: GraphqlGovernanceDiagnostic[] = [];
  const name = operation.name?.value ?? "<anonymous>";
  const pageSizes: number[] = [];
  let maxDepth = 0;
  let fields = 0;
  let complexity = 0;
  const variables = new Map(
    (operation.variableDefinitions ?? [])
      .filter((definition) => definition.defaultValue?.kind === Kind.INT)
      .map((definition) => [
        definition.variable.name.value,
        definition.defaultValue?.kind === Kind.INT ? numericLiteral(definition.defaultValue.value) : undefined,
      ] as const),
  );
  const visitedFragments = new Set<string>();
  const root = operation.operation === "query" ? schema.getQueryType()
    : operation.operation === "mutation" ? schema.getMutationType() : schema.getSubscriptionType();
  const walk = (
    selectionSet: NonNullable<typeof operation.selectionSet>,
    parent: GraphQLObjectType | GraphQLInterfaceType | undefined,
    depth: number,
  ): void => {
    if (!selectionSet) return;
    maxDepth = Math.max(maxDepth, depth);
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD || selection.kind === Kind.INLINE_FRAGMENT) {
        if (selection.kind === Kind.INLINE_FRAGMENT) walk(selection.selectionSet, parent, depth);
        else {
          const fragment = fragmentDefinitions.get(selection.name.value);
          if (fragment && !visitedFragments.has(fragment.name.value)) {
            visitedFragments.add(fragment.name.value);
            walk(fragment.selectionSet, parent, depth);
          }
        }
        continue;
      }
      fields += 1;
      complexity += 1;
      const field = parent?.getFields()[selection.name.value] as GraphQLField<unknown, unknown> | undefined;
      if (!field) continue;
      const pageArgument = (selection.arguments ?? []).find((argument) => ["first", "last", "limit"].includes(argument.name.value));
      const pageValue = pageArgument?.value.kind === Kind.INT
        ? numericLiteral(pageArgument.value.value)
        : pageArgument?.value.kind === Kind.STRING ? numericLiteral(pageArgument.value.value)
          : pageArgument?.value.kind === Kind.VARIABLE ? variables.get(pageArgument.value.name.value) : undefined;
      if (pageValue !== undefined) pageSizes.push(pageValue);
      const child = unwrapNamed(field.type);
      if (selection.selectionSet && (isObjectType(child) || isInterfaceType(child))) {
        walk(selection.selectionSet, child, depth + 1);
      }
    }
  };
  walk(operation.selectionSet, root as GraphQLObjectType | GraphQLInterfaceType | undefined, 1);
  const limit = policy.maxPageSize ?? 100;
  if (pageSizes.some((size) => size > limit)) {
    diagnostics.push({ severity: "error", code: "graphql-page-size", message: `Operation ${name} exceeds max page size ${limit}.`, operation: name });
  }
  if (policy.maxDepth !== undefined && maxDepth > policy.maxDepth) {
    diagnostics.push({ severity: "error", code: "graphql-depth", message: `Operation ${name} has depth ${maxDepth}; maximum is ${policy.maxDepth}.`, operation: name });
  }
  if (policy.maxFields !== undefined && fields > policy.maxFields) {
    diagnostics.push({ severity: "error", code: "graphql-fields", message: `Operation ${name} selects ${fields} fields; maximum is ${policy.maxFields}.`, operation: name });
  }
  if (policy.maxComplexity !== undefined && complexity > policy.maxComplexity) {
    diagnostics.push({ severity: "error", code: "graphql-complexity", message: `Operation ${name} has complexity ${complexity}; maximum is ${policy.maxComplexity}.`, operation: name });
  }
  const allowed = allowedOperation(name, policy.operations);
  if (!allowed) diagnostics.push({ severity: "error", code: "graphql-operation-denied", message: `Operation ${name} is not present in the GraphQL operation allowlist.`, operation: name });
  return { report: { name, operation: operation.operation, depth: maxDepth, fields, complexity, pageSizes, allowed }, diagnostics };
}

export function checkGraphqlCompatibility(
  schema: GraphQLSchema,
  documents: readonly { source: string; path?: string }[],
  policy: GraphqlGovernancePolicy = {},
): Omit<GraphqlCompatibilityReport, "schema"> {
  const diagnostics: GraphqlGovernanceDiagnostic[] = [];
  const operations: GraphqlOperationReport[] = [];
  for (const document of documents) {
    let parsed: DocumentNode;
    try {
      parsed = parse(document.source);
    } catch (error) {
      diagnostics.push({ severity: "error", code: "graphql-document-invalid", message: error instanceof Error ? error.message : String(error), file: document.path });
      continue;
    }
    diagnostics.push(...validate(schema, parsed).map((error) => ({
      severity: "error" as const,
      code: "graphql-validation",
      message: error.message,
      file: document.path,
      line: error.locations?.[0]?.line,
    })));
    const fragmentDefinitions = new Map(parsed.definitions
      .filter((definition): definition is Extract<DocumentNode["definitions"][number], { kind: typeof Kind.FRAGMENT_DEFINITION }> =>
        definition.kind === Kind.FRAGMENT_DEFINITION)
      .map((definition) => [definition.name.value, definition]));
    for (const definition of parsed.definitions) {
      if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
      const result = operationReport(schema, definition, fragmentDefinitions, policy);
      operations.push(result.report);
      diagnostics.push(...result.diagnostics.map((item) => ({ ...item, file: document.path })));
    }
  }
  return { ok: diagnostics.every((item) => item.severity !== "error"), features: graphqlFeatureMatrix(schema), operations, diagnostics };
}

function namedTypes(schema: GraphQLSchema): Map<string, GraphQLNamedType> {
  return new Map(Object.values(schema.getTypeMap()).filter((type) => !type.name.startsWith("__")).map((type) => [type.name, type]));
}

function addChange(target: GraphqlSchemaDiff, change: GraphqlSchemaChange): void {
  target[change.severity === "breaking" ? "breaking" : "nonBreaking"].push(change);
}

export function diffGraphqlSchemas(previous: GraphQLSchema, current: GraphQLSchema): GraphqlSchemaDiff {
  const result: GraphqlSchemaDiff = { ok: true, breaking: [], nonBreaking: [] };
  const before = namedTypes(previous);
  const after = namedTypes(current);
  for (const [name, oldType] of before) {
    const newType = after.get(name);
    if (!newType) {
      addChange(result, { severity: "breaking", code: "type-removed", message: `Type ${name} was removed.`, path: name });
      continue;
    }
    if ((isObjectType(oldType) || isInterfaceType(oldType))
      && (isObjectType(newType) || isInterfaceType(newType))) {
      const oldFields = oldType.getFields();
      const newFields = newType.getFields();
      for (const fieldName of Object.keys(oldFields)) {
        if (!newFields[fieldName]) {
          addChange(result, { severity: "breaking", code: "field-removed", message: `Field ${name}.${fieldName} was removed.`, path: `${name}.${fieldName}` });
        }
      }
      for (const fieldName of Object.keys(newFields)) {
        if (!oldFields[fieldName]) {
          addChange(result, { severity: "non-breaking", code: "field-added", message: `Field ${name}.${fieldName} was added.`, path: `${name}.${fieldName}` });
          continue;
        }
        if (String(oldFields[fieldName]!.type) !== String(newFields[fieldName]!.type)) {
          addChange(result, {
            severity: "breaking",
            code: "field-type-changed",
            message: `Field ${name}.${fieldName} changed from ${oldFields[fieldName]!.type} to ${newFields[fieldName]!.type}.`,
            path: `${name}.${fieldName}`,
          });
        }
        const oldArgs = new Map(oldFields[fieldName]!.args.map((argument) => [argument.name, argument]));
        const newArgs = new Map(newFields[fieldName]!.args.map((argument) => [argument.name, argument]));
        for (const argumentName of oldArgs.keys()) {
          if (!newArgs.has(argumentName)) {
            addChange(result, { severity: "breaking", code: "argument-removed", message: `Argument ${name}.${fieldName}(${argumentName}:) was removed.`, path: `${name}.${fieldName}(${argumentName}:)` });
          }
        }
        for (const [argumentName, argument] of newArgs) {
          const oldArgument = oldArgs.get(argumentName);
          if (!oldArgument) {
            const required = String(argument.type).endsWith("!");
            addChange(result, {
              severity: required ? "breaking" : "non-breaking",
              code: required ? "required-argument-added" : "optional-argument-added",
              message: `Argument ${name}.${fieldName}(${argumentName}: ${argument.type}) was added.`,
              path: `${name}.${fieldName}(${argumentName}:)`,
            });
          } else if (String(oldArgument.type) !== String(argument.type)) {
            addChange(result, {
              severity: "breaking",
              code: "argument-type-changed",
              message: `Argument ${name}.${fieldName}(${argumentName}:) changed from ${oldArgument.type} to ${argument.type}.`,
              path: `${name}.${fieldName}(${argumentName}:)`,
            });
          }
        }
      }
    }
    if (isInputObjectType(oldType) && isInputObjectType(newType)) {
      const oldFields = oldType.getFields();
      const newFields = newType.getFields();
      for (const fieldName of Object.keys(oldFields)) {
        if (!newFields[fieldName]) {
          addChange(result, { severity: "breaking", code: "input-field-removed", message: `Input field ${name}.${fieldName} was removed.`, path: `${name}.${fieldName}` });
        }
      }
    }
  }
  for (const name of after.keys()) {
    if (!before.has(name)) addChange(result, { severity: "non-breaking", code: "type-added", message: `Type ${name} was added.`, path: name });
  }
  result.ok = result.breaking.length === 0;
  return result;
}

export function createRoleSnapshotReport(
  roles: readonly { role: string; path: string; source: string }[],
): GraphqlRoleSnapshotReport {
  const diagnostics: GraphqlGovernanceDiagnostic[] = [];
  const snapshots: GraphqlRoleSnapshot[] = [];
  for (const role of roles) {
    try {
      const schema = schemaFromSource(role.source, role.path);
      void schema;
      const hashes = graphqlSchemaHashes(role.source);
      snapshots.push({ role: role.role, schema: role.path, ...hashes });
    } catch (error) {
      diagnostics.push({ severity: "error", code: "graphql-role-schema-invalid", message: error instanceof Error ? error.message : String(error), file: role.path });
    }
  }
  return { ok: diagnostics.length === 0, roles: snapshots, diagnostics };
}

export function introspectionQuery(): string {
  return getIntrospectionQuery();
}
