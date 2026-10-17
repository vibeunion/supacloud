import { createHash } from "node:crypto";
import { GraphQLInt, Kind, coerceInputLiteral, coerceInputValue, parse, print, type DocumentNode, type OperationDefinitionNode, type ValueNode } from "graphql";

export interface GraphqlRequestGovernancePolicy {
  enabled?: boolean;
  persistedOnly?: boolean;
  operations?: string[];
  maxDepth?: number;
  maxFields?: number;
  maxComplexity?: number;
  maxPageSize?: number;
}

export interface GraphqlRequestGovernanceResult {
  operationName: string | null;
  operationType: "query" | "mutation" | "subscription";
  sha256: string;
  depth: number;
  fields: number;
  complexity: number;
}

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_PARSE_TOKENS = 20_000;
const MAX_SELECTION_VISITS = 20_000;
const emptyReport = (): GraphqlRequestGovernanceResult => ({
  operationName: null, operationType: "query", sha256: "", depth: 0, fields: 0, complexity: 0,
});
class GovernanceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(message: string, code = "GRAPHQL_REQUEST_INVALID"): Response {
  return Response.json({ error: message, code }, { status: 400 });
}
function invalidInput(): never {
  throw new GovernanceError("GRAPHQL_REQUEST_INVALID", "GraphQL request is invalid");
}
function budgetExceeded(): never {
  throw new GovernanceError("GRAPHQL_OPERATION_BUDGET_EXCEEDED", "GraphQL operation exceeds the configured execution budget");
}
function tooLarge(): never {
  throw new GovernanceError("GRAPHQL_REQUEST_TOO_LARGE", "GraphQL request exceeds the analysis budget");
}
function policyNumber(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("GRAPHQL_POLICY_INVALID");
  }
  return value;
}

export function normalizeGraphqlRequestGovernancePolicy(value: unknown): GraphqlRequestGovernancePolicy {
  if (value === undefined || value === null) return { enabled: false };
  if (!object(value)) throw new Error("GRAPHQL_POLICY_INVALID");
  for (const key of ["enabled", "persistedOnly"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error("GRAPHQL_POLICY_INVALID");
  }
  let operations: string[] | undefined;
  if (value.operations !== undefined) {
    if (!Array.isArray(value.operations) || value.operations.length > 1000
      || value.operations.some(item => typeof item !== "string" || !/^(?:\*|[A-Za-z_][A-Za-z0-9_]*\*?)$/.test(item))) {
      throw new Error("GRAPHQL_POLICY_INVALID");
    }
    operations = [...value.operations];
  }
  return {
    enabled: value.enabled === true,
    persistedOnly: value.persistedOnly === true,
    ...(operations ? { operations } : {}),
    maxDepth: policyNumber(value.maxDepth, 12),
    maxFields: policyNumber(value.maxFields, 200),
    maxComplexity: policyNumber(value.maxComplexity, 400),
    maxPageSize: policyNumber(value.maxPageSize, 1000),
  };
}

/** Unavailable or corrupt policy storage must not become an absent/disabled policy. */
export async function governGraphqlProjectRequest(
  request: Request, readConfig: () => Promise<unknown>,
): Promise<Response | GraphqlRequestGovernanceResult> {
  // Preflight cannot execute an operation; preserve the upstream CORS path.
  if (request.method === "OPTIONS") return emptyReport();
  let policy: GraphqlRequestGovernancePolicy;
  try {
    let config = await readConfig();
    if (typeof config === "string") config = JSON.parse(config);
    if (config !== null && config !== undefined && !object(config)) throw new Error("GRAPHQL_POLICY_INVALID");
    policy = normalizeGraphqlRequestGovernancePolicy(object(config) ? config.graphql_governance : undefined);
  } catch {
    return Response.json({ error: "GraphQL policy is unavailable", code: "GRAPHQL_POLICY_UNAVAILABLE" }, { status: 503 });
  }
  return governGraphqlRequest(request, policy);
}

async function payloadOf(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") {
    if (new TextEncoder().encode(request.url).byteLength > MAX_REQUEST_BYTES) tooLarge();
    const params = new URL(request.url).searchParams;
    const body: Record<string, unknown> = {};
    for (const key of ["query", "operationName", "variables", "extensions"]) {
      const values = params.getAll(key);
      if (values.length > 1) invalidInput();
      if (values.length === 1) body[key] = key === "variables" || key === "extensions"
        ? JSON.parse(values[0]!) : values[0];
    }
    return body;
  }
  if (request.method !== "POST") invalidInput();
  const reader = request.clone().body?.getReader();
  if (!reader) invalidInput();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        // A tee cancellation can wait for the original request branch. Observe
        // it, but do not await it while rejecting an oversized request.
        void reader.cancel().catch(() => {});
        tooLarge();
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!object(payload)) invalidInput();
  return payload;
}

function metrics(
  document: DocumentNode, operation: OperationDefinitionNode,
  variables: Record<string, unknown>, policy: GraphqlRequestGovernancePolicy,
) {
  let fields = 0;
  let depth = 0;
  let visits = 0;
  const pageSizes: number[] = [];
  const usedFragments = new Set<string>();
  const activeFragments = new Set<string>();
  const fragments = new Map(document.definitions
    .filter((definition): definition is Extract<DocumentNode["definitions"][number], { kind: typeof Kind.FRAGMENT_DEFINITION }> =>
      definition.kind === Kind.FRAGMENT_DEFINITION)
    .map(definition => [definition.name.value, definition]));
  const definitions = new Map((operation.variableDefinitions ?? []).map(definition => [definition.variable.name.value, definition]));
  if (definitions.size !== (operation.variableDefinitions ?? []).length) invalidInput();
  const maxDepth = policyNumber(policy.maxDepth, 12);
  const maxFields = policyNumber(policy.maxFields, 200);
  const maxComplexity = policyNumber(policy.maxComplexity, 400);
  const maxPageSize = policyNumber(policy.maxPageSize, 1000);

  const pageSize = (value: ValueNode): number | null | undefined => {
    let result: unknown;
    if (value.kind === Kind.VARIABLE) {
      const definition = definitions.get(value.name.value);
      if (!definition) invalidInput();
      const required = definition.type.kind === Kind.NON_NULL_TYPE;
      const type = definition.type.kind === Kind.NON_NULL_TYPE ? definition.type.type : definition.type;
      if (type.kind !== Kind.NAMED_TYPE || type.name.value !== "Int") invalidInput();
      if (Object.hasOwn(variables, value.name.value)) {
        result = variables[value.name.value];
      } else if (definition.defaultValue !== undefined) {
        result = definition.defaultValue.kind === Kind.NULL ? null : coerceInputLiteral(definition.defaultValue, GraphQLInt);
      } else {
        if (required) invalidInput();
        return undefined; // Omitted is distinct from null; leave schema defaults to pg_graphql.
      }
      if (result === null) {
        if (required) invalidInput();
        return null;
      }
      result = coerceInputValue(result, GraphQLInt);
    } else {
      if (value.kind === Kind.NULL) return null;
      result = coerceInputLiteral(value, GraphQLInt);
    }
    if (typeof result !== "number" || result < 0) invalidInput();
    return result;
  };

  const walk = (selectionSet: OperationDefinitionNode["selectionSet"], level: number, stackDepth: number): void => {
    if (stackDepth > 256) tooLarge();
    depth = Math.max(depth, level);
    if (depth > maxDepth) budgetExceeded();
    for (const selection of selectionSet.selections) {
      if (++visits > MAX_SELECTION_VISITS) tooLarge();
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const name = selection.name.value;
        const fragment = fragments.get(name);
        if (!fragment || activeFragments.has(name)) invalidInput();
        activeFragments.add(name);
        usedFragments.add(name);
        try { walk(fragment.selectionSet, level, stackDepth + 1); }
        finally { activeFragments.delete(name); }
        continue;
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        walk(selection.selectionSet, level, stackDepth + 1);
        continue;
      }
      fields += 1;
      if (fields > maxFields || fields > maxComplexity) budgetExceeded();
      for (const argument of selection.arguments ?? []) {
        if (!["first", "last", "limit"].includes(argument.name.value)) continue;
        const size = pageSize(argument.value);
        if (size !== undefined && size !== null) {
          if (size > maxPageSize) budgetExceeded();
          pageSizes.push(size);
        }
      }
      if (selection.selectionSet) walk(selection.selectionSet, level + 1, stackDepth + 1);
    }
  };
  walk(operation.selectionSet, 1, 1);
  const selected: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: document.definitions.filter(definition => definition === operation
      || (definition.kind === Kind.FRAGMENT_DEFINITION && usedFragments.has(definition.name.value))),
  };
  return { depth, fields, complexity: fields, pageSizes, selected };
}

export async function governGraphqlRequest(
  request: Request, policy: GraphqlRequestGovernancePolicy,
): Promise<Response | GraphqlRequestGovernanceResult> {
  if (policy.enabled === false || request.method === "OPTIONS") return emptyReport();
  try {
    const body = await payloadOf(request);
    if (typeof body.query !== "string" || !body.query.trim()) invalidInput();
    if (body.operationName !== undefined && body.operationName !== null
      && (typeof body.operationName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.operationName))) invalidInput();
    if (body.variables !== undefined && body.variables !== null && !object(body.variables)) invalidInput();
    const variables = object(body.variables) ? body.variables : {};
    const document = parse(body.query, { maxTokens: MAX_PARSE_TOKENS });
    const operations: OperationDefinitionNode[] = [];
    const names = new Set<string>();
    const fragmentNames = new Set<string>();
    for (const definition of document.definitions) {
      if (definition.kind === Kind.OPERATION_DEFINITION) {
        const name = definition.name?.value ?? "";
        if (names.has(name)) invalidInput();
        names.add(name);
        operations.push(definition);
      } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        if (fragmentNames.has(definition.name.value)) invalidInput();
        fragmentNames.add(definition.name.value);
      } else invalidInput();
    }
    const operationName = typeof body.operationName === "string" ? body.operationName : null;
    const operation = operationName ? operations.find(item => item.name?.value === operationName)
      : operations.length === 1 ? operations[0] : undefined;
    if (!operation) return invalid("Select exactly one GraphQL operation", "GRAPHQL_OPERATION_REQUIRED");
    if (operation.operation === "subscription") {
      return invalid("GraphQL subscriptions use Supabase Realtime, not the pg_graphql HTTP endpoint", "GRAPHQL_SUBSCRIPTION_USE_REALTIME");
    }
    if ((request.method === "GET" || request.method === "HEAD") && operation.operation !== "query") {
      return invalid("GraphQL mutations require POST", "GRAPHQL_GET_MUTATION_DENIED");
    }
    const { selected, ...report } = metrics(document, operation, variables, policy);
    const sha256 = createHash("sha256").update(print(selected)).digest("hex");
    const persisted = object(body.extensions) && object(body.extensions.persistedQuery)
      ? body.extensions.persistedQuery : null;
    if (policy.persistedOnly && (!persisted || persisted.version !== 1 || persisted.sha256Hash !== sha256)) {
      return invalid("A valid persisted operation is required", "GRAPHQL_PERSISTED_OPERATION_REQUIRED");
    }
    if (persisted && (persisted.version !== 1 || persisted.sha256Hash !== sha256)) {
      return invalid("Persisted operation hash does not match the query", "GRAPHQL_PERSISTED_OPERATION_MISMATCH");
    }
    if (policy.operations?.length && (!operation.name || !policy.operations.some(pattern => pattern.endsWith("*")
      ? operation.name!.value.startsWith(pattern.slice(0, -1)) : operation.name!.value === pattern))) {
      return invalid("GraphQL operation is not allowlisted", "GRAPHQL_OPERATION_DENIED");
    }
    return { operationName: operation.name?.value ?? null, operationType: operation.operation, sha256, ...report };
  } catch (error) {
    return error instanceof GovernanceError ? invalid(error.message, error.code)
      : invalid("GraphQL request is invalid");
  }
}
