import { describe, expect, test } from 'bun:test';

import { buildDatabaseManifest, explainObject } from './manifest.js';
import { defineDatabaseModule } from './module.js';

const casesModule = defineDatabaseModule({
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
      tests: ['db/tests/case_create.sql'],
    },
  ],
  triggers: [
    { name: 'cases_updated_at', table: 'public.cases', source: 'db/triggers/cases_updated_at.sql' },
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

const iamModule = defineDatabaseModule({
  name: 'iam',
  tables: ['public.profiles'],
});

describe('buildDatabaseManifest', () => {
  test('结构：version=1 且模块字段完整', () => {
    const manifest = buildDatabaseManifest([casesModule, iamModule]);
    expect(manifest.version).toBe(1);
    expect(manifest.modules).toHaveLength(2);
    expect(manifest.modules[0].name).toBe('cases');
    expect(manifest.modules[0].tables).toEqual(['public.cases']);
    expect(manifest.modules[0].policies).toHaveLength(1);
    expect(manifest.modules[0].functions).toHaveLength(1);
    expect(manifest.modules[0].triggers).toHaveLength(1);
    expect(manifest.modules[0].grants).toHaveLength(1);
    expect(manifest.modules[1].name).toBe('iam');
  });

  test('manifest 可 JSON 序列化', () => {
    const manifest = buildDatabaseManifest([casesModule]);
    const round = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    expect(round).toEqual(manifest);
  });
});

describe('explainObject', () => {
  const manifest = buildDatabaseManifest([casesModule, iamModule]);

  test('函数：输出包含模块、类型、源文件、权限、测试', () => {
    const text = explainObject(manifest, 'public.case_create');
    expect(text).toContain('public.case_create');
    expect(text).toContain('函数');
    expect(text).toContain('cases');
    expect(text).toContain('db/functions/case_create.sql');
    expect(text).toContain('case.create');
    expect(text).toContain('definer');
    expect(text).toContain('db/tests/case_create.sql');
  });

  test('策略：按名字或 table.name 均可命中', () => {
    for (const key of ['cases_select', 'public.cases.cases_select']) {
      const text = explainObject(manifest, key);
      expect(text).toContain('策略');
      expect(text).toContain('db/policies/cases_select.sql');
      expect(text).toContain('authenticated');
    }
  });

  test('表、触发器、授权均可解释', () => {
    expect(explainObject(manifest, 'public.cases')).toContain('表');
    expect(explainObject(manifest, 'cases_updated_at')).toContain('触发器');
    expect(explainObject(manifest, 'public.profiles')).toContain('iam');
  });

  test('未知对象返回未找到提示', () => {
    expect(explainObject(manifest, 'public.nonexistent')).toContain('未找到');
  });
});
