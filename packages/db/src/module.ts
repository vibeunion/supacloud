/**
 * 模块声明：数据库治理的一等资源（RLS 策略 / RPC 函数 / 触发器 / 授权）。
 * driver 无关，纯声明层。
 */

export type PolicyOperation = 'select' | 'insert' | 'update' | 'delete' | 'all';

export interface PolicyDecl {
  /** 策略名，如 cases_select */
  name: string;
  /** 带 schema 的表名：public.cases */
  table: string;
  operation: PolicyOperation;
  /** 适用角色，如 ['authenticated'] */
  roles: string[];
  /** SQL 源文件相对路径 */
  source: string;
  /** 测试文件相对路径 */
  tests?: string[];
}

export interface FunctionDecl {
  /** 带 schema 的函数名：public.case_create */
  name: string;
  source: string;
  /** 业务权限标识，如 case.create */
  permission?: string;
  transaction?: 'required' | 'none';
  security: 'invoker' | 'definer';
  audit?: string;
  idempotency?: string;
  tests?: string[];
}

export interface TriggerDecl {
  name: string;
  /** 带 schema 的表名 */
  table: string;
  source: string;
}

export interface GrantDecl {
  /** 带 schema 的对象名：public.cases */
  object: string;
  privilege: string;
  role: string;
  source: string;
}

/** drizzle Table 的内部结构形状（仅类型层兼容，不 import drizzle-orm） */
export interface DrizzleTableLike {
  _: { name: string; schema?: string };
}

export type TableRef = string | DrizzleTableLike;

export interface DatabaseModuleOptions {
  name: string;
  /** 归属表：drizzle 表对象或带 schema 表名均可 */
  tables?: TableRef[];
  policies?: PolicyDecl[];
  functions?: FunctionDecl[];
  triggers?: TriggerDecl[];
  grants?: GrantDecl[];
}

export interface DatabaseModule {
  name: string;
  /** 归一化为 'schema.name' 形式的表名 */
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
