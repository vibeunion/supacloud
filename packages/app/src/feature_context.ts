export interface FeatureRequestContext {
  readonly requestId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly permissions: readonly string[];
  readonly idempotencyKey?: string;
}

/**
 * Business-owned work invoked by a compiler-emitted Feature Job.
 * Queue leasing, retries, receipts and durable status remain host-owned.
 */
export interface FeatureJobPort<Input, Output = void> {
  run(context: FeatureRequestContext, input: Input): Promise<Output>;
}

export interface FeatureOperationLookupInput {
  readonly id: string;
  readonly operationId: string;
}

export interface FeatureOperationResult {
  readonly id: string;
  readonly operationId: string;
}

export class FeatureContextError extends Error {
  readonly _tag = "FEATURE_CONTEXT_REQUIRED" as const;

  constructor() {
    super("FEATURE_CONTEXT_REQUIRED");
    this.name = "FeatureContextError";
  }
}

export class FeatureAdapterError extends Error {
  readonly _tag = "FEATURE_ADAPTER_UNAVAILABLE" as const;

  constructor(readonly adapter: string) {
    super(`FEATURE_ADAPTER_UNAVAILABLE:${adapter}`);
    this.name = "FeatureAdapterError";
  }
}

export class FeatureOperationError extends Error {
  readonly _tag = "FEATURE_OPERATION_RESULT_MISMATCH" as const;

  constructor() {
    super("FEATURE_OPERATION_RESULT_MISMATCH");
    this.name = "FeatureOperationError";
  }
}

export function requireFeatureOperationResult<T extends FeatureOperationResult>(
  input: FeatureOperationLookupInput,
  value: unknown,
): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !("id" in value) || value.id !== input.id
    || !("operationId" in value) || value.operationId !== input.operationId) {
    throw new FeatureOperationError();
  }
  return value as T;
}

/**
 * Read-only operation state owned by the application's durable command or
 * workflow adapter. The framework supplies the trusted request context.
 */
export interface FeatureOperationPort<Output> {
  lookup(context: FeatureRequestContext, input: FeatureOperationLookupInput): Promise<Output>;
}

interface RecordValue {
  readonly [key: string]: unknown;
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Normalize the trusted request shape shared by SupaAuth and edge runtimes.
 * Feature adapters must use this context instead of accepting tenant or actor
 * identity from command bodies, query parameters, or forwarded headers.
 */
export function requireFeatureRequestContext(value: unknown): FeatureRequestContext {
  const context = record(value);
  const identity = record(context?.["identity"]);
  const access = record(context?.["access"]);
  const permissions = access?.["permissions"];
  const permissionValues = Array.isArray(permissions) ? permissions as unknown[] : undefined;
  const requestId = context?.["requestId"];
  const tenantId = access?.["tenantId"];
  const actorId = identity?.["subject"];
  const idempotencyKey = context?.["idempotencyKey"];
  const normalizedPermissions = permissionValues?.filter(nonEmptyString);
  if (
    !nonEmptyString(requestId)
    || identity?.["authenticated"] !== true
    || !nonEmptyString(actorId)
    || !nonEmptyString(tenantId)
    || permissionValues === undefined
    || normalizedPermissions === undefined
    || normalizedPermissions.length !== permissionValues.length
    || (idempotencyKey !== undefined && !nonEmptyString(idempotencyKey))
  ) {
    throw new FeatureContextError();
  }
  return Object.freeze({
    requestId,
    tenantId,
    actorId,
    permissions: Object.freeze([...new Set(normalizedPermissions)]),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
}
