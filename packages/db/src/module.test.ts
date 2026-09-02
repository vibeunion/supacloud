import { describe, expect, test } from 'bun:test';

import { defineDatabaseModule } from './module.js';

describe('defineDatabaseModule', () => {
  test('空选项归一化为空数组', () => {
    const module = defineDatabaseModule({ name: 'cases' });
    expect(module.name).toBe('cases');
    expect(module.tables).toEqual([]);
    expect(module.policies).toEqual([]);
    expect(module.functions).toEqual([]);
    expect(module.triggers).toEqual([]);
    expect(module.grants).toEqual([]);
  });

  test('字符串表名原样保留', () => {
    const module = defineDatabaseModule({
      name: 'cases',
      tables: ['public.cases', 'app.orders'],
    });
    expect(module.tables).toEqual(['public.cases', 'app.orders']);
  });

  test('drizzle 形表对象提取 schema.name', () => {
    const casesTable = { _: { name: 'cases', schema: 'public' } };
    const module = defineDatabaseModule({
      name: 'cases',
      tables: [casesTable],
    });
    expect(module.tables).toEqual(['public.cases']);
  });

  test('drizzle 形表对象无 schema 时默认 public', () => {
    const profilesTable = { _: { name: 'profiles' } };
    const module = defineDatabaseModule({
      name: 'iam',
      tables: [profilesTable],
    });
    expect(module.tables).toEqual(['public.profiles']);
  });

  test('声明数组原样透传', () => {
    const module = defineDatabaseModule({
      name: 'cases',
      policies: [
        {
          name: 'cases_select',
          table: 'public.cases',
          operation: 'select',
          roles: ['authenticated'],
          source: 'db/policies/cases_select.sql',
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
    });
    expect(module.policies).toHaveLength(1);
    expect(module.functions[0].security).toBe('definer');
  });
});
