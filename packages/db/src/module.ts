/**
 * Module declaration: First-class resources for database governance (RLS policies / RPC functions / triggers / grants).
 * Driver-agnostic, pure declaration layer.
 */

export type PolicyOperation = 'select' | 'insert' | 'update' | 'delete' | 'all';

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
  /** Relative path to test file */
  tests?: string[];
}

export interface FunctionDecl {
  /** Schema-qualified function name: public.case_create */
  name: string;
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
  source: string;
}

export interface GrantDecl {
  /** Schema-qualified object name: public.cases */
  object: string;
  privilege: string;
  role: string;
  source: string;
}

/** Internal structure shape of Drizzle Table (type-level compatibility only, does not import drizzle-orm) */
export interface DrizzleTableLike {
  _: { name: string; schema?: string };
}

export type TableRef = string | DrizzleTableLike;

export interface DatabaseModuleOptions {
  name: string;
  /** Owning tables: Drizzle table object or schema-qualified table name */
  tables?: TableRef[];
  policies?: PolicyDecl[];
  functions?: FunctionDecl[];
  triggers?: TriggerDecl[];
  grants?: GrantDecl[];
}

export interface DatabaseModule {
  name: string;
  /** Normalized to 'schema.name' table name */
  tables: string[];
  policies: PolicyDecl[];
  functions: FunctionDecl[];
  triggers: TriggerDecl[];
  grants: GrantDecl[];
}

function normalizeTable(ref: TableRef): string {
  if (typeof ref === 'string') return ref;
  const schema = ref._.schema ?? 'public';
  return `${schema}.${ref._.name}`;
}

export function defineDatabaseModule(options: DatabaseModuleOptions): DatabaseModule {
  return {
    name: options.name,
    tables: (options.tables ?? []).map(normalizeTable),
    policies: options.policies ?? [],
    functions: options.functions ?? [],
    triggers: options.triggers ?? [],
    grants: options.grants ?? [],
  };
}
