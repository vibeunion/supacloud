import { describe, expect, test } from 'bun:test';

import { lintModule, lintSql } from './lint.js';
import { defineDatabaseModule } from './module.js';

function codes(issues: Array<{ code: string }>): string[] {
  return issues.map((issue) => issue.code);
}

describe('lintSql', () => {
  test('definer-no-search-path：security definer 缺少 set search_path', () => {
    const sql = `create function public.f() returns int language sql security definer as $$ select 1 $$;`;
    const issues = lintSql(sql, 'f.sql');
    expect(codes(issues)).toContain('definer-no-search-path');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].file).toBe('f.sql');
    expect(issues[0].line).toBe(1);
  });

  test('definer-no-search-path：带 set search_path 时不命中', () => {
    const sql = `create function public.f() returns int language sql security definer set search_path = public as $$ select 1 $$;`;
    expect(codes(lintSql(sql, 'f.sql'))).not.toContain('definer-no-search-path');
  });

  test('grant-to-public：授予 PUBLIC 报错', () => {
    const issues = lintSql('grant select on table public.cases to public;', 'g.sql');
    expect(codes(issues)).toContain('grant-to-public');
    expect(issues[0].severity).toBe('error');
  });

  test('grant-to-public：授予具名角色不命中', () => {
    const issues = lintSql('grant select on table public.cases to authenticated;', 'g.sql');
    expect(codes(issues)).not.toContain('grant-to-public');
  });

  test('drop-without-if-exists：命中与豁免', () => {
    expect(codes(lintSql('drop table public.old;', 'm.sql'))).toContain(
      'drop-without-if-exists',
    );
    expect(codes(lintSql('alter table t drop column c;', 'm.sql'))).toContain(
      'drop-without-if-exists',
    );
    expect(codes(lintSql('drop table if exists public.old;', 'm.sql'))).not.toContain(
      'drop-without-if-exists',
    );
    expect(codes(lintSql('alter table t drop column if exists c;', 'm.sql'))).not.toContain(
      'drop-without-if-exists',
    );
  });

  test('line 指向命中行', () => {
    const sql = `create table t (id int);\n\ndrop table t;`;
    const issues = lintSql(sql, 'm.sql');
    expect(issues[0].line).toBe(3);
  });

  test('non-idempotent-policy：create policy 前缺少 drop policy if exists', () => {
    const issues = lintSql(
      'create policy cases_select on public.cases for select to authenticated using (true);',
      'p.sql',
    );
    expect(codes(issues)).toContain('non-idempotent-policy');
    expect(issues[0].severity).toBe('warn');
  });

  test('non-idempotent-policy：先 drop policy if exists 则不命中', () => {
    const sql =
      'drop policy if exists cases_select on public.cases;\ncreate policy cases_select on public.cases for select to authenticated using (true);';
    expect(codes(lintSql(sql, 'p.sql'))).not.toContain('non-idempotent-policy');
  });

  test('non-idempotent-policy：drop 在 create 之后仍然命中', () => {
    const sql =
      'create policy cases_select on public.cases for select to authenticated using (true);\ndrop policy if exists cases_select on public.cases;';
    expect(codes(lintSql(sql, 'p.sql'))).toContain('non-idempotent-policy');
  });
});

describe('lintModule', () => {
  const files: Record<string, string> = {
    'db/policies/cases_select.sql':
      'alter table public.cases enable row level security;\ndrop policy if exists cases_select on public.cases;\ncreate policy cases_select on public.cases for select to authenticated using (true);',
    'db/functions/case_create.sql':
      'create function public.case_create() returns int language sql security definer set search_path = public as $$ select 1 $$;',
  };
  const readFile = (path: string): Promise<string> => {
    const content = files[path];
    if (content === undefined) return Promise.reject(new Error(`missing file: ${path}`));
    return Promise.resolve(content);
  };

  test('干净模块无 lint 问题', async () => {
    const module = defineDatabaseModule({
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
          tests: ['db/tests/case_create.sql'],
        },
      ],
    });
    expect(await lintModule(module, readFile)).toEqual([]);
  });

  test('missing-rls-enable：有策略但源文件未开启 RLS', async () => {
    const module = defineDatabaseModule({
      name: 'cases',
      policies: [
        {
          name: 'cases_select',
          table: 'public.cases',
          operation: 'select',
          roles: ['authenticated'],
          source: 'db/functions/case_create.sql',
          tests: ['t.sql'],
        },
      ],
    });
    const issues = await lintModule(module, readFile);
    expect(codes(issues)).toContain('missing-rls-enable');
  });

  test('policy-without-test：策略/函数缺 tests 条目', async () => {
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
        { name: 'public.case_create', source: 'db/functions/case_create.sql', security: 'definer' },
      ],
    });
    const issues = await lintModule(module, readFile);
    const noTest = issues.filter((i) => i.code === 'policy-without-test');
    expect(noTest).toHaveLength(2);
    expect(noTest.every((i) => i.severity === 'warn')).toBe(true);
  });

  test('源文件中的 SQL 问题被聚合上报', async () => {
    const module = defineDatabaseModule({
      name: 'cases',
      grants: [
        {
          object: 'public.cases',
          privilege: 'SELECT',
          role: 'authenticated',
          source: 'db/policies/cases_select.sql',
        },
      ],
    });
    // Reuse file containing grant scenario: directly inject file with 'to public'
    const issues = await lintModule(module, (path) =>
      Promise.resolve(path.endsWith('.sql') ? 'grant select on public.cases to public;' : ''),
    );
    expect(codes(issues)).toContain('grant-to-public');
  });
});
