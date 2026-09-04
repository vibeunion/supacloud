import { describe, expect, test } from 'bun:test';

import { applyModulePlan } from './apply.js';
import type { QueryExecutor } from './catalog.js';
import { defineDatabaseModule } from './module.js';
import { planModule, type ModulePlan } from './plan.js';

interface CapturedCall {
  sql: string;
  params?: unknown[];
}

const files: Record<string, string> = {
  'db/functions/case_create.sql':
    'create or replace function public.case_create() returns int language sql security definer set search_path = public as $$ select 1 $$;',
  'db/policies/cases_select.sql':
    'drop policy if exists cases_select on public.cases;\ncreate policy cases_select on public.cases for select to authenticated using (true);',
  'db/triggers/cases_updated_at.sql':
    'drop trigger if exists cases_updated_at on public.cases;\ncreate trigger cases_updated_at before update on public.cases for each row execute function public.set_updated_at();',
  'db/grants/cases.sql': 'grant select on public.cases to authenticated;',
};

const readFile = (path: string): Promise<string> => {
  const content = files[path];
  if (content === undefined) return Promise.reject(new Error(`missing file: ${path}`));
  return Promise.resolve(content);
};

function testModule() {
  return defineDatabaseModule({
    name: 'cases',
    tables: ['public.cases'],
    functions: [
      {
        name: 'public.case_create',
        source: 'db/functions/case_create.sql',
        security: 'definer',
      },
    ],
    policies: [
      {
        name: 'cases_select',
        table: 'public.cases',
        operation: 'select',
        roles: ['authenticated'],
        source: 'db/policies/cases_select.sql',
      },
    ],
    triggers: [
      {
        name: 'cases_updated_at',
        table: 'public.cases',
        source: 'db/triggers/cases_updated_at.sql',
      },
    ],
    grants: [
      {
        object: 'public.cases',
        privilege: 'SELECT',
        role: 'authenticated',
        source: 'db/grants/cases.sql',
      },
    ],
  });
}

const STEP_NAMES = [
  'public.case_create',
  'public.cases.cases_select',
  'public.cases.cases_updated_at',
  'public.cases:SELECT:authenticated',
];

/** Fixed rows used for post-apply catalog readback verification (covering all four declared objects) */
const HAPPY_CATALOG_ROUTES = [
  { match: 'pg_class c\nJOIN pg_namespace', rows: [] },
  {
    match: 'pg_policy',
    rows: [
      {
        schema: 'public',
        table: 'cases',
        name: 'cases_select',
        command: 'r',
        roles: ['authenticated'],
        using_expr: 'true',
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
        language: 'sql',
      },
    ],
  },
  {
    match: 'pg_trigger',
    rows: [{ schema: 'public', table: 'cases', name: 'cases_updated_at', enabled: true }],
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

interface MockOptions {
  /** Throws error when step.sql contains this fragment to simulate execution failure */
  failOn?: string;
  /** Provides transaction(fn) to use managed transaction path */
  withTransaction?: boolean;
}

/**
 * In-memory mock executor: simulates _supacloud.db_object_ledger with Map,
 * where begin/commit/rollback semantics actually take effect (writes to pending in tx, commits to ledger, drops on rollback).
 */
function mockApplyExecutor(options: MockOptions = {}): {
  executor: QueryExecutor;
  calls: CapturedCall[];
  ledger: Map<string, { module: string; sha256: string }>;
} {
  const calls: CapturedCall[] = [];
  const ledger = new Map<string, { module: string; sha256: string }>();
  let pending: Map<string, { module: string; sha256: string }> | null = null;

  const beginTx = () => {
    pending = new Map();
  };
  const commitTx = () => {
    if (pending) {
      for (const [key, value] of pending) ledger.set(key, value);
    }
    pending = null;
  };
  const rollbackTx = () => {
    pending = null;
  };

  const executor: QueryExecutor = {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      calls.push({ sql, params });
      const head = sql.trim().toLowerCase();
      if (head === 'begin') {
        beginTx();
        return Promise.resolve([]);
      }
      if (head === 'commit') {
        commitTx();
        return Promise.resolve([]);
      }
      if (head === 'rollback') {
        rollbackTx();
        return Promise.resolve([]);
      }
      if (options.failOn && sql.includes(options.failOn)) {
        return Promise.reject(new Error(`boom: ${options.failOn}`));
      }
      if (sql.includes('db_object_ledger where object_identity')) {
        const identity = params?.[0] as string;
        // In-transaction read: check transaction buffer first, then fall back to committed ledger (read-your-writes + committed visibility)
        const row = pending?.get(identity) ?? ledger.get(identity);
        return Promise.resolve((row ? [{ sha256: row.sha256 }] : []) as T[]);
      }
      if (sql.includes('insert into _supacloud.db_object_ledger')) {
        const store = pending ?? ledger;
        store.set(params?.[0] as string, {
          module: params?.[1] as string,
          sha256: params?.[2] as string,
        });
        return Promise.resolve([]);
      }
      const route = HAPPY_CATALOG_ROUTES.find((r) => sql.includes(r.match));
      return Promise.resolve((route?.rows ?? []) as T[]);
    },
  };

  if (options.withTransaction) {
    executor.transaction = async <T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> => {
      beginTx();
      try {
        const value = await fn(executor);
        commitTx();
        return value;
      } catch (error) {
        rollbackTx();
        throw error;
      }
    };
  }

  return { executor, calls, ledger };
}

async function makePlan(): Promise<ModulePlan> {
  return planModule(testModule(), readFile);
}

function sqls(calls: CapturedCall[]): string[] {
  return calls.map((call) => call.sql);
}

describe('applyModulePlan', () => {
  test('全绿路径：账本为空时全部 applied 并 verified', async () => {
    const { executor, ledger } = mockApplyExecutor();
    const result = await applyModulePlan(executor, await makePlan());
    expect(result.module).toBe('cases');
    expect(result.applied).toEqual(STEP_NAMES);
    expect(result.skipped).toEqual([]);
    expect(result.verified).toEqual(STEP_NAMES);
    expect(result.failed).toBeUndefined();
    expect(ledger.size).toBe(4);
  });

  test('幂等：ledger 已有同 sha256 时全部 skipped，不重复执行 SQL', async () => {
    const { executor, calls, ledger } = mockApplyExecutor();
    const plan = await makePlan();
    await applyModulePlan(executor, plan);
    expect(ledger.size).toBe(4);

    calls.length = 0;
    const second = await applyModulePlan(executor, plan);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(STEP_NAMES);
    expect(second.verified).toEqual(STEP_NAMES);
    expect(second.failed).toBeUndefined();
    const executed = sqls(calls);
    expect(executed.some((sql) => sql.includes('create or replace function'))).toBe(false);
    expect(executed.some((sql) => sql.includes('create policy'))).toBe(false);
  });

  test('失败回滚：第二步抛错则 ROLLBACK，ledger 无写入，后续 step 不执行', async () => {
    const { executor, calls, ledger } = mockApplyExecutor({ failOn: 'create policy' });
    const result = await applyModulePlan(executor, await makePlan());
    expect(result.failed?.step).toBe('public.cases.cases_select');
    expect(result.failed?.error).toContain('boom');
    expect(result.applied).toEqual([]);
    expect(result.verified).toEqual([]);
    const executed = sqls(calls);
    expect(executed.filter((sql) => sql.trim() === 'rollback')).toHaveLength(1);
    expect(executed.some((sql) => sql.trim() === 'commit')).toBe(false);
    expect(executed.some((sql) => sql.includes('create trigger'))).toBe(false);
    expect(ledger.size).toBe(0);
  });

  test('error 级 risk 直接拒绝执行，不触碰数据库', async () => {
    const badModule = defineDatabaseModule({
      name: 'bad',
      functions: [{ name: 'public.f', source: 'f.sql', security: 'definer' }],
    });
    const plan = await planModule(badModule, () =>
      Promise.resolve(
        'create function public.f() returns int language sql security definer as $$ select 1 $$;',
      ),
    );
    const { executor, calls } = mockApplyExecutor();
    await expect(applyModulePlan(executor, plan)).rejects.toThrow('拒绝执行');
    expect(calls).toHaveLength(0);
  });

  test('advisory lock/unlock 成对调用且包裹事务', async () => {
    const { executor, calls } = mockApplyExecutor();
    await applyModulePlan(executor, await makePlan());
    const executed = sqls(calls);
    const lockIndex = executed.findIndex((sql) => sql.includes('pg_advisory_lock'));
    const unlockIndex = executed.findIndex((sql) => sql.includes('pg_advisory_unlock'));
    const beginIndex = executed.findIndex((sql) => sql.trim() === 'begin');
    const commitIndex = executed.findIndex((sql) => sql.trim() === 'commit');
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(unlockIndex).toBeGreaterThan(commitIndex);
    expect(lockIndex).toBeLessThan(beginIndex);
    // Failure paths must also unlock
    const failing = mockApplyExecutor({ failOn: 'create policy' });
    await applyModulePlan(failing.executor, await makePlan());
    const failingSqls = sqls(failing.calls);
    expect(failingSqls.some((sql) => sql.includes('pg_advisory_lock'))).toBe(true);
    expect(failingSqls.some((sql) => sql.includes('pg_advisory_unlock'))).toBe(true);
  });

  test('executor 提供 transaction 时走托管事务，不直接执行 begin/commit', async () => {
    const { executor, calls, ledger } = mockApplyExecutor({ withTransaction: true });
    const result = await applyModulePlan(executor, await makePlan());
    expect(result.applied).toEqual(STEP_NAMES);
    expect(result.failed).toBeUndefined();
    expect(ledger.size).toBe(4);
    const executed = sqls(calls);
    expect(executed.some((sql) => sql.trim() === 'begin')).toBe(false);
    expect(executed.some((sql) => sql.trim() === 'commit')).toBe(false);
  });

  test('托管事务路径失败同样回滚并返回 failed', async () => {
    const { executor, ledger } = mockApplyExecutor({
      withTransaction: true,
      failOn: 'create policy',
    });
    const result = await applyModulePlan(executor, await makePlan());
    expect(result.failed?.step).toBe('public.cases.cases_select');
    expect(ledger.size).toBe(0);
  });
});
