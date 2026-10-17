import { describe, expect, test } from 'bun:test';

import { readCatalog, type DatabaseCatalog, type QueryExecutor } from './catalog.js';
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
      identityArguments: '',
      security: 'definer',
      searchPath: 'public',
      language: 'plpgsql',
    },
  ],
  triggers: [
    { schema: 'public', table: 'cases', name: 'cases_updated_at', enabled: true },
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
  test('catalog maps canonical input types without parameter names', async () => {
    const executor: QueryExecutor = {
      async query<T>(sql: string): Promise<T[]> {
        if (!sql.includes('FROM pg_proc')) return [];
        expect(sql).toContain('pg_catalog.oidvectortypes(p.proargtypes)');
        return [{
          schema: 'public', name: 'case_create', identity_arguments: 'uuid, text',
          security_definer: true, config: ['search_path=""'], language: 'sql',
        }] as T[];
      },
    };
    const catalog = await readCatalog(executor);
    expect(catalog.functions[0].identityArguments).toBe('uuid, text');
    expect(reconcileModule(defineDatabaseModule({
      name: 'rpc',
      functions: [{
        name: 'public.case_create', signature: 'public.case_create(uuid, text)',
        security: 'definer', source: 'rpc.sql',
      }],
    }), catalog).ok).toBe(true);
  });

  test('policy role sets ignore ordering but preserve identifier case', () => {
    const catalog = cloneCatalog();
    const module = structuredClone(baseModule);
    module.policies[0].roles = ['authenticated', 'Reviewer'];
    catalog.policies[0].roles = ['Reviewer', 'authenticated', 'Reviewer'];
    expect(reconcileModule(module, catalog).ok).toBe(true);
    catalog.policies[0].roles = ['reviewer', 'authenticated'];
    expect(codes(reconcileModule(module, catalog))).toContain('policy-roles-mismatch');
  });

  test('policy expressions preserve literal whitespace and explicit absence', () => {
    const catalog = cloneCatalog();
    const module = structuredClone(baseModule);
    module.policies[0].usingExpr = "label = 'a  b'";
    module.policies[0].checkExpr = null;
    catalog.policies[0].usingExpr = "label = 'a b'";
    expect(codes(reconcileModule(module, catalog))).toContain('policy-using-mismatch');
    catalog.policies[0].usingExpr = module.policies[0].usingExpr;
    expect(reconcileModule(module, catalog).ok).toBe(true);
    catalog.policies[0].checkExpr = 'true';
    expect(codes(reconcileModule(module, catalog))).toContain('policy-check-mismatch');
  });

  test('explicit signatures cannot fall back to another overload or unknown metadata', () => {
    const catalog = cloneCatalog();
    const module = structuredClone(baseModule);
    module.functions[0].signature = 'public.case_create(uuid)';
    expect(codes(reconcileModule(module, catalog))).toContain('missing-function');
    catalog.functions.push({
      ...catalog.functions[0], identityArguments: 'uuid', searchPath: null,
    });
    expect(codes(reconcileModule(module, catalog))).toContain('definer-without-search-path');
    catalog.functions.reverse();
    expect(codes(reconcileModule(module, catalog))).toContain('definer-without-search-path');
    catalog.functions = [{ ...baseCatalog.functions[0] }];
    delete catalog.functions[0].identityArguments;
    expect(codes(reconcileModule(module, catalog))).toContain('missing-function');
    delete module.functions[0].signature;
    expect(reconcileModule(module, catalog).ok).toBe(true);
  });

  test('declared disabled triggers must remain disabled', () => {
    const module = structuredClone(baseModule);
    module.triggers[0].enabled = false;
    const catalog = cloneCatalog();
    expect(codes(reconcileModule(module, catalog))).toContain('trigger-enabled-mismatch');
    catalog.triggers[0].enabled = false;
    expect(reconcileModule(module, catalog).ok).toBe(true);
  });

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

  test('missing-table：声明的表在 catalog 中不存在', () => {
    const catalog = cloneCatalog();
    catalog.tables = [];
    const report = reconcileModule(baseModule, catalog);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('missing-table');
  });

  test('policy contract：操作、角色和声明的表达式必须与 catalog 一致', () => {
    const module = defineDatabaseModule({
      ...baseModule,
      policies: [{
        ...baseModule.policies[0],
        operation: 'update',
        roles: ['anon'],
        usingExpr: 'tenant_id = other_tenant()',
        checkExpr: 'tenant_id = current_tenant()',
      }],
    });
    const report = reconcileModule(module, cloneCatalog());
    expect(codes(report)).toEqual(expect.arrayContaining([
      'policy-command-mismatch',
      'policy-roles-mismatch',
      'policy-using-mismatch',
      'policy-check-mismatch',
    ]));
    expect(report.ok).toBe(false);
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
    for (const bad of ['public, pg_temp', 'public, ', '"$user", public,,', '"$user", public']) {
      const catalog = cloneCatalog();
      catalog.functions[0].searchPath = bad;
      const report = reconcileModule(baseModule, catalog);
      expect(codes(report)).toContain('definer-without-search-path');
    }
  });

  test('definer-without-search-path：显式空 search_path 是合法的固定路径', () => {
    for (const path of ['', '""']) {
      const catalog = cloneCatalog();
      catalog.functions[0].searchPath = path;
      expect(reconcileModule(baseModule, catalog).ok).toBe(true);
    }
  });

  test('function overload：同名重载必须通过完整 signature 选择', () => {
    const catalog = cloneCatalog();
    catalog.functions.push({
      ...catalog.functions[0],
      identityArguments: 'uuid',
    });
    expect(codes(reconcileModule(baseModule, catalog))).toContain('ambiguous-function-overload');

    const module = defineDatabaseModule({
      ...baseModule,
      functions: [{ ...baseModule.functions[0], signature: 'public.case_create()' }],
    });
    expect(codes(reconcileModule(module, catalog))).not.toContain('ambiguous-function-overload');
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

  test('missing-trigger：声明的触发器在 catalog 中不存在', () => {
    const catalog = cloneCatalog();
    catalog.triggers = [];
    const report = reconcileModule(baseModule, catalog);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('missing-trigger');
  });

  test('undeclared-trigger：归属表上的额外触发器告警（含已禁用），非归属表不告警', () => {
    const catalog = cloneCatalog();
    catalog.triggers.push(
      { schema: 'public', table: 'cases', name: 'cases_extra', enabled: true },
      { schema: 'public', table: 'cases', name: 'cases_disabled', enabled: false },
      { schema: 'public', table: 'other_table', name: 'other_trigger', enabled: true },
    );
    const report = reconcileModule(baseModule, catalog);
    const undeclared = report.issues.filter((i) => i.code === 'undeclared-trigger');
    expect(undeclared).toHaveLength(2);
    expect(undeclared.every((i) => i.severity === 'warn')).toBe(true);
    expect(undeclared.map((i) => i.object)).toEqual([
      'public.cases.cases_extra',
      'public.cases.cases_disabled',
    ]);
    expect(undeclared[1].message).toContain('已禁用');
    expect(report.ok).toBe(true);
  });

  test('已声明的禁用触发器不报 undeclared-trigger', () => {
    const catalog = cloneCatalog();
    catalog.triggers[0].enabled = false;
    const report = reconcileModule(baseModule, catalog);
    expect(codes(report)).not.toContain('undeclared-trigger');
    expect(codes(report)).toContain('disabled-trigger');
  });
});
