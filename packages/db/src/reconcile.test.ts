import { describe, expect, test } from 'bun:test';

import type { DatabaseCatalog } from './catalog.js';
import { defineDatabaseModule } from './module.js';
import { reconcileModule } from './reconcile.js';

const baseModule = defineDatabaseModule({
  name: 'cases',
  tables: ['public.cases'],
  policies: [
    {
      name: 'cases_select',
      table: 'public.cases',
      operation: 'select',
      roles: ['authenticated'],
      source: 'db/policies/cases_select.sql',
      tests: ['db/tests/cases_select.sql'],
    },
  ],
  functions: [
    {
      name: 'public.case_create',
      source: 'db/functions/case_create.sql',
      security: 'definer',
      permission: 'case.create',
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

const baseCatalog: DatabaseCatalog = {
  tables: [
    { schema: 'public', name: 'cases', rlsEnabled: true, rlsForced: false },
  ],
  policies: [
    {
      schema: 'public',
      table: 'cases',
      name: 'cases_select',
      command: 'select',
      roles: ['authenticated'],
      usingExpr: 'tenant_id = current_tenant()',
    },
  ],
  functions: [
    {
      schema: 'public',
      name: 'case_create',
      security: 'definer',
      searchPath: 'public',
      language: 'plpgsql',
    },
  ],
  grants: [
    {
      objectSchema: 'public',
      objectName: 'cases',
      privilege: 'SELECT',
      grantee: 'authenticated',
    },
  ],
};

function cloneCatalog(): DatabaseCatalog {
  return structuredClone(baseCatalog);
}

function codes(report: ReturnType<typeof reconcileModule>): string[] {
  return report.issues.map((issue) => issue.code);
}

describe('reconcileModule', () => {
  test('全一致时 ok=true 且无 issue', () => {
    const report = reconcileModule(baseModule, cloneCatalog());
    expect(report.module).toBe('cases');
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('missing-policy：声明的策略在 catalog 中不存在', () => {
    const catalog = cloneCatalog();
    catalog.policies = [];
    const report = reconcileModule(baseModule, catalog);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('missing-policy');
  });

  test('missing-function：声明的函数在 catalog 中不存在', () => {
    const catalog = cloneCatalog();
    catalog.functions = [];
    const report = reconcileModule(baseModule, catalog);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('missing-function');
  });

  test('undeclared-policy：归属表上的额外策略告警，非归属表不告警', () => {
    const catalog = cloneCatalog();
    catalog.policies.push(
      {
        schema: 'public',
        table: 'cases',
        name: 'cases_extra',
        command: 'delete',
        roles: ['authenticated'],
      },
      {
        schema: 'public',
        table: 'other_table',
        name: 'other_policy',
        command: 'select',
        roles: ['authenticated'],
      },
    );
    const report = reconcileModule(baseModule, catalog);
    const undeclared = report.issues.filter((i) => i.code === 'undeclared-policy');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0].severity).toBe('warn');
    expect(undeclared[0].object).toContain('cases_extra');
    expect(report.ok).toBe(true);
  });

  test('rls-disabled：归属表未开启 RLS', () => {
    const catalog = cloneCatalog();
    catalog.tables[0].rlsEnabled = false;
    const report = reconcileModule(baseModule, catalog);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('rls-disabled');
  });

  test('definer-without-search-path：searchPath 为 null', () => {
    const catalog = cloneCatalog();
    catalog.functions[0].searchPath = null;
    const report = reconcileModule(baseModule, catalog);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('definer-without-search-path');
  });

  test('definer-without-search-path：searchPath 含 pg_temp 或空元素', () => {
    for (const bad of ['public, pg_temp', 'public, ', '"$user", public,,']) {
      const catalog = cloneCatalog();
      catalog.functions[0].searchPath = bad;
      const report = reconcileModule(baseModule, catalog);
      expect(codes(report)).toContain('definer-without-search-path');
    }
  });

  test('security-mismatch：声明 invoker 但 catalog 为 definer（路径固定则不报 error）', () => {
    const module = defineDatabaseModule({
      ...baseModule,
      functions: [{ ...baseModule.functions[0], security: 'invoker' }],
    });
    const report = reconcileModule(module, cloneCatalog());
    expect(codes(report)).toContain('security-mismatch');
    expect(codes(report)).not.toContain('definer-without-search-path');
    expect(report.ok).toBe(true);
  });

  test('wildcard-grant：归属表上存在授予 PUBLIC 的权限', () => {
    const catalog = cloneCatalog();
    catalog.grants.push({
      objectSchema: 'public',
      objectName: 'cases',
      privilege: 'SELECT',
      grantee: 'PUBLIC',
    });
    const report = reconcileModule(baseModule, catalog);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('wildcard-grant');
  });

  test('grant-drift：声明的授权在 catalog 中不存在', () => {
    const catalog = cloneCatalog();
    catalog.grants = [];
    const report = reconcileModule(baseModule, catalog);
    expect(codes(report)).toContain('grant-drift');
    expect(report.ok).toBe(true);
  });
});
