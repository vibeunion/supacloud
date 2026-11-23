/**
 * Module declaration: First-class resources for database governance (RLS policies / RPC functions / triggers / grants).
 * Driver-agnostic, pure declaration layer.
 */

export type PolicyOperation = 'select' | 'insert' | 'update' | 'delete' | 'all';

/** Table operations that must have exactly one declared owner. */
export const TABLE_OPERATIONS = ['select', 'insert', 'update', 'delete'] as const;
export type TableOperation = (typeof TABLE_OPERATIONS)[number];

/** Explicit database entrypoint for one table operation. */
export const OPERATION_OWNERS = [
  'postgrest-data-api',
  'durable-command',
  'governed-sql-rpc',
  'legacy-rpc',
] as const;
export type OperationOwner = (typeof OPERATION_OWNERS)[number];

export interface OperationOwnershipDecl {
  /** Schema-qualified table name: public.cases */
  table: string;
  operation: TableOperation;
  /** Exactly one entrypoint owns this table operation. */
  owner: OperationOwner;
}

export interface PolicyDecl {
  /** Policy name, e.g. cases_select */
  name: string;
  /** Schema-qualified table name: public.cases */
  table: string;
  operation: PolicyOperation;
  /** Target roles, e.g. ['authenticated'] */
  roles: string[];
  /** Relative path to SQL source file */
  source: string;
  /** Exact pg_get_expr output; null requires an absent expression. Omit to skip. */
  usingExpr?: string | null;
  /** Exact pg_get_expr output; null requires an absent expression. Omit to skip. */
  checkExpr?: string | null;
  /** Relative path to test file */
  tests?: string[];
}

export interface FunctionDecl {
  /** Schema-qualified function name: public.case_create */
  name: string;
  /** Exact schema.name(oidvectortypes(proargtypes)), e.g. public.case_create(uuid, text). */
  signature?: string;
  source: string;
  /** Business permission identifier, e.g. case.create */
  permission?: string;
  transaction?: 'required' | 'none';
  security: 'invoker' | 'definer';
  audit?: string;
  idempotency?: string;
  tests?: string[];
}

export interface TriggerDecl {
  name: string;
  /** Schema-qualified table name */
  table: string;
  /** Catalog triggers are expected to be enabled unless explicitly overridden. */
  enabled?: boolean;
  source: string;
}

export interface GrantDecl {
  /** Schema-qualified object name: public.cases */
  object: string;
  privilege: string;
  role: string;
  source: string;
}

export type TableRef = string;

export interface DatabaseModuleOptions {
  name: string;
  /** Owning tables: schema-qualified table name */
  tables?: TableRef[];
  policies?: PolicyDecl[];
  functions?: FunctionDecl[];
  triggers?: TriggerDecl[];
  grants?: GrantDecl[];
  /** Explicit operation ownership. Omit only while the table has not been classified yet. */
  operationOwnership?: OperationOwnershipDecl[];
}

export interface DatabaseModule {
  name: string;
  /** Normalized to 'schema.name' table name */
  tables: string[];
  policies: PolicyDecl[];
  functions: FunctionDecl[];
  triggers: TriggerDecl[];
  grants: GrantDecl[];
  /** Explicit ownership declarations; legacy hand-written modules may omit it. */
  operationOwnership?: OperationOwnershipDecl[];
}

function normalizeTable(ref: TableRef): string {
  if (typeof ref !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(ref)) throw new Error('Expected a schema-qualified table name');
  return ref;
}

function normalizeTableOperation(value: unknown): TableOperation {
  if (typeof value !== 'string' || !TABLE_OPERATIONS.includes(value as TableOperation)) {
    throw new Error(`Expected table operation: ${TABLE_OPERATIONS.join(', ')}`);
  }
  return value as TableOperation;
}

function normalizeOperationOwner(value: unknown): OperationOwner {
  if (typeof value !== 'string' || !OPERATION_OWNERS.includes(value as OperationOwner)) {
    throw new Error(`Expected operation owner: ${OPERATION_OWNERS.join(', ')}`);
  }
  return value as OperationOwner;
}

/**
 * Validates explicit table/operation ownership for one module. Every entry names
 * one schema-qualified table, one operation and exactly one owner. A table may
 * only be classified by the module that declares it, and a duplicate
 * table/operation is rejected rather than resolved implicitly.
 */
export function normalizeOperationOwnership(
  value: unknown,
  tables: readonly string[],
): OperationOwnershipDecl[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Operation ownership must be an array');
  const declaredTables = new Set(tables.map(normalizeTable));
  const seen = new Map<string, OperationOwner>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Expected an operation ownership entry');
    }
    const record = entry as Record<string, unknown>;
    const table = normalizeTable(record['table'] as TableRef);
    if (!declaredTables.has(table)) {
      throw new Error(`Operation ownership table is not declared by this module: ${table}`);
    }
    const operation = normalizeTableOperation(record['operation']);
    const owner = normalizeOperationOwner(record['owner']);
    const key = `${table}.${operation}`;
    const existing = seen.get(key);
    if (existing !== undefined) {
      throw new Error(existing === owner
        ? `Duplicate operation ownership for ${key}`
        : `Conflicting operation ownership for ${key}: ${existing} and ${owner}`);
    }
    seen.set(key, owner);
    return { table, operation, owner };
  });
}

export interface OperationOwnershipConflict {
  table: string;
  operation: TableOperation;
  /** Distinct owners declared for the same schema-qualified table operation. */
  owners: OperationOwner[];
  /** Modules that declared the conflicting ownership. */
  modules: string[];
}

/** Cross-module conflicts. A table operation may have many declarations only when they agree. */
export function findOperationOwnershipConflicts(
  modules: readonly DatabaseModule[],
): OperationOwnershipConflict[] {
  const declarations = new Map<string, {
    table: string;
    operation: TableOperation;
    owners: Set<OperationOwner>;
    modules: Set<string>;
  }>();
  for (const module of modules) {
    for (const declaration of module.operationOwnership ?? []) {
      const key = `${declaration.table}.${declaration.operation}`;
      const existing = declarations.get(key);
      if (existing === undefined) {
        declarations.set(key, {
          table: declaration.table,
          operation: declaration.operation,
          owners: new Set([declaration.owner]),
          modules: new Set([module.name]),
        });
        continue;
      }
      existing.owners.add(declaration.owner);
      existing.modules.add(module.name);
    }
  }
  return [...declarations.values()]
    .filter((declaration) => declaration.owners.size > 1)
    .map((declaration) => ({
      table: declaration.table,
      operation: declaration.operation,
      owners: [...declaration.owners].sort((left, right) => left.localeCompare(right)),
      modules: [...declaration.modules].sort((left, right) => left.localeCompare(right)),
    }));
}

export function defineDatabaseModule(options: DatabaseModuleOptions): DatabaseModule {
  const tables = (options.tables ?? []).map(normalizeTable);
  return {
    name: options.name,
    tables,
    policies: options.policies ?? [],
    functions: options.functions ?? [],
    triggers: options.triggers ?? [],
    grants: options.grants ?? [],
    operationOwnership: normalizeOperationOwnership(options.operationOwnership, tables),
  };
}
