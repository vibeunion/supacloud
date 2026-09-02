import { describe, expect, test } from 'bun:test';

import {
  extractSearchPath,
  readCatalog,
  type QueryExecutor,
} from './catalog.js';

interface CapturedCall {
  sql: string;
  params?: unknown[];
}

/** 按 SQL 关键字路由返回固定行的 mock executor */
function mockExecutor(routes: Array<{ match: string; rows: unknown[] }>): {
  executor: QueryExecutor;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const executor: QueryExecutor = {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      calls.push({ sql, params });
      const route = routes.find((r) => sql.includes(r.match));
      return Promise.resolve((route?.rows ?? []) as T[]);
    },
  };
  return { executor, calls };
}

const FULL_ROWS = [
  {
    match: 'pg_class c\nJOIN pg_namespace',
    rows: [
      { schema: 'public', name: 'cases', rls_enabled: true, rls_forced: false },
    ],
  },
  {
    match: 'pg_policy',
    rows: [
      {
        schema: 'public',
        table: 'cases',
        name: 'cases_select',
        command: 'r',
        roles: ['authenticated'],
        using_expr: 'tenant_id = current_tenant()',
        check_expr: null,
      },
      {
        schema: 'public',
        table: 'cases',
        name: 'cases_all_admin',
        command: '*',
        roles: ['service_role'],
        using_expr: null,
        check_expr: null,
      },
    ],
  },
  {
    match: 'pg_proc',
    rows: [
      {
        schema: 'public',
        name: 'case_create',
        security_definer: true,
        config: ['search_path=public'],
        language: 'plpgsql',
      },
      {
        schema: 'public',
        name: 'case_list',
        security_definer: false,
        config: null,
        language: 'sql',
      },
    ],
  },
  {
    match: 'role_table_grants',
    rows: [
      {
        object_schema: 'public',
        object_name: 'cases',
        privilege: 'SELECT',
        grantee: 'authenticated',
      },
    ],
  },
];

describe('readCatalog', () => {
  test('默认 schema 过滤为 public 且参数化 $1', async () => {
    const { executor, calls } = mockExecutor([]);
    await readCatalog(executor);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.sql).toContain('$1');
      expect(call.params).toEqual([['public']]);
    }
  });

  test('自定义 schemas 透传为参数', async () => {
    const { executor, calls } = mockExecutor([]);
    await readCatalog(executor, ['public', 'app']);
    expect(calls[0].params).toEqual([['public', 'app']]);
  });

  test('表行映射 rls 字段', async () => {
    const { executor } = mockExecutor(FULL_ROWS);
    const catalog = await readCatalog(executor);
    expect(catalog.tables).toEqual([
      { schema: 'public', name: 'cases', rlsEnabled: true, rlsForced: false },
    ]);
  });

  test('polcmd 映射为语义化操作名', async () => {
    const { executor } = mockExecutor(FULL_ROWS);
    const catalog = await readCatalog(executor);
    expect(catalog.policies[0].command).toBe('select');
    expect(catalog.policies[0].usingExpr).toBe('tenant_id = current_tenant()');
    expect(catalog.policies[0].checkExpr).toBeUndefined();
    expect(catalog.policies[1].command).toBe('all');
    expect(catalog.policies[1].roles).toEqual(['service_role']);
  });

  test('prosecdef 映射 security，proconfig 提取 search_path', async () => {
    const { executor } = mockExecutor(FULL_ROWS);
    const catalog = await readCatalog(executor);
    expect(catalog.functions[0].security).toBe('definer');
    expect(catalog.functions[0].searchPath).toBe('public');
    expect(catalog.functions[0].language).toBe('plpgsql');
    expect(catalog.functions[1].security).toBe('invoker');
    expect(catalog.functions[1].searchPath).toBeNull();
  });

  test('grants 行原样映射', async () => {
    const { executor } = mockExecutor(FULL_ROWS);
    const catalog = await readCatalog(executor);
    expect(catalog.grants).toEqual([
      {
        objectSchema: 'public',
        objectName: 'cases',
        privilege: 'SELECT',
        grantee: 'authenticated',
      },
    ]);
  });
});

describe('extractSearchPath', () => {
  test('从 proconfig 数组提取 search_path', () => {
    expect(extractSearchPath(['search_path=public, extensions'])).toBe(
      'public, extensions',
    );
  });

  test('无 search_path 配置返回 null', () => {
    expect(extractSearchPath(['work_mem=64MB'])).toBeNull();
    expect(extractSearchPath([])).toBeNull();
    expect(extractSearchPath(null)).toBeNull();
  });
});
