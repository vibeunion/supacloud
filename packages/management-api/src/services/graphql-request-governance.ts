import { createHash } from "node:crypto";
import { Kind, parse, print, separateOperations, type DocumentNode, type OperationDefinitionNode } from "graphql";

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

function operationAllowed(name: string | null, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  return name !== null && patterns.some(pattern => pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
}

function operationDefinitions(document: DocumentNode): OperationDefinitionNode[] {
  return document.definitions.filter((definition): definition is OperationDefinitionNode =>
    definition.kind === Kind.OPERATION_DEFINITION);
}

function selectedOperation(document: DocumentNode, operationName: string | null): OperationDefinitionNode | null {
  const operations = operationDefinitions(document);
  if (operationName) return operations.find(operation => operation.name?.value === operationName) ?? null;
  return operations.length === 1 ? operations[0] ?? null : null;
}

function metrics(document: DocumentNode, operation: OperationDefinitionNode): { depth: number; fields: number; complexity: number; pageSizes: number[] } {
  let fields = 0;
  let depth = 0;
  let complexity = 0;
  const pageSizes: number[] = [];
  const fragments = new Map(document.definitions
    .filter((definition): definition is Extract<DocumentNode["definitions"][number], { kind: typeof Kind.FRAGMENT_DEFINITION }> =>
      definition.kind === Kind.FRAGMENT_DEFINITION)
    .map(definition => [definition.name.value, definition]));
  const visitedFragments = new Set<string>();
  const walk = (selectionSet: OperationDefinitionNode["selectionSet"], level: number): void => {
    depth = Math.max(depth, level);
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        if (visitedFragments.has(selection.name.value)) continue;
        const fragment = fragments.get(selection.name.value);
        if (fragment) {
          visitedFragments.add(selection.name.value);
          walk(fragment.selectionSet, level);
        }
        continue;
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        walk(selection.selectionSet, level);
        continue;
      }
      fields += 1;
      complexity += 1;
      for (const argument of selection.arguments ?? []) {
        if (!["first", "last", "limit"].includes(argument.name.value)) continue;
        if (argument.value.kind === Kind.INT) pageSizes.push(Number(argument.value.value));
      }
      if (selection.selectionSet) walk(selection.selectionSet, level + 1);
    }
  };
  walk(operation.selectionSet, 1);
  return { depth, fields, complexity, pageSizes };
}

function invalid(message: string, code = "GRAPHQL_REQUEST_INVALID"): Response {
  return Response.json({ error: message, code }, { status: 400 });
}

function policyNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function normalizeGraphqlRequestGovernancePolicy(value: unknown): GraphqlRequestGovernancePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { enabled: false };
  const candidate = value as Record<string, unknown>;
  const operations = Array.isArray(candidate.operations)
    ? candidate.operations.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;
  return {
    enabled: candidate.enabled === true,
    persistedOnly: candidate.persistedOnly === true,
    ...(operations ? { operations } : {}),
    maxDepth: policyNumber(candidate.maxDepth, 12),
    maxFields: policyNumber(candidate.maxFields, 200),
    maxComplexity: policyNumber(candidate.maxComplexity, 400),
    maxPageSize: policyNumber(candidate.maxPageSize, 1000),
  };
}

export async function governGraphqlRequest(
  request: Request,
  policy: GraphqlRequestGovernancePolicy,
): Promise<Response | GraphqlRequestGovernanceResult> {
  if (policy.enabled === false || request.method === "GET" || request.method === "HEAD") return {
    operationName: null, operationType: "query", sha256: "", depth: 0, fields: 0, complexity: 0,
  };
  let payload: unknown;
  try {
    const text = await request.clone().text();
    if (text.length > 512 * 1024) return invalid("GraphQL request is too large", "GRAPHQL_REQUEST_TOO_LARGE");
    payload = JSON.parse(text);
  } catch {
    return invalid("GraphQL request body must be valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalid("GraphQL request body must be an object");
  const body = payload as Record<string, unknown>;
  if (typeof body.query !== "string" || !body.query.trim()) return invalid("GraphQL query is required");
  let document: DocumentNode;
  try { document = parse(body.query); } catch { return invalid("GraphQL query is invalid"); }
  const operationName = typeof body.operationName === "string" && body.operationName.trim()
    ? body.operationName.trim() : null;
  const operation = selectedOperation(document, operationName);
  if (!operation) return invalid("operationName is required when the document contains multiple operations", "GRAPHQL_OPERATION_REQUIRED");
  const report = metrics(document, operation);
  const selected = separateOperations(document)[operation.name?.value ?? ""] ?? operation;
  const sha256 = createHash("sha256").update(print(selected)).digest("hex");
  const extension = body.extensions && typeof body.extensions === "object" && !Array.isArray(body.extensions)
    ? (body.extensions as Record<string, unknown>).persistedQuery : undefined;
  const persisted = extension && typeof extension === "object" && !Array.isArray(extension)
    ? extension as Record<string, unknown> : null;
  if (policy.persistedOnly && (!persisted || persisted.version !== 1 || persisted.sha256Hash !== sha256)) {
    return invalid("A valid persisted operation is required", "GRAPHQL_PERSISTED_OPERATION_REQUIRED");
  }
  if (persisted && (persisted.version !== 1 || persisted.sha256Hash !== sha256)) {
    return invalid("Persisted operation hash does not match the query", "GRAPHQL_PERSISTED_OPERATION_MISMATCH");
  }
  if (!operationAllowed(operation.name?.value ?? null, policy.operations)) {
    return invalid("GraphQL operation is not allowlisted", "GRAPHQL_OPERATION_DENIED");
  }
  if (operation.operation === "subscription") {
    return invalid("GraphQL subscriptions use Supabase Realtime, not the pg_graphql HTTP endpoint", "GRAPHQL_SUBSCRIPTION_USE_REALTIME");
  }
  if (report.depth > (policy.maxDepth ?? 12)
    || report.fields > (policy.maxFields ?? 200)
    || report.complexity > (policy.maxComplexity ?? 400)
    || report.pageSizes.some(size => size > (policy.maxPageSize ?? 1000))) {
    return invalid("GraphQL operation exceeds the configured execution budget", "GRAPHQL_OPERATION_BUDGET_EXCEEDED");
  }
  return {
    operationName: operation.name?.value ?? null,
    operationType: operation.operation,
    sha256,
    ...report,
  };
}
