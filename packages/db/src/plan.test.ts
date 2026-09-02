import { describe, expect, test } from 'bun:test';

import { defineDatabaseModule } from './module.js';
import { planModule } from './plan.js';

export const planFiles: Record<string, string> = {
  'db/functions/case_create.sql':
    'create or replace function public.case_create() returns int language sql security definer set search_path = public as $$ select 1 $$;',
  'db/policies/cases_select.sql':
    'drop policy if exists cases_select on public.cases;\ncreate policy cases_select on public.cases for select to authenticated using (true);',
  'db/triggers/cases_updated_at.sql':
    'drop trigger if exists cases_updated_at on public.cases;\ncreate trigger cases_updated_at before update on public.cases for each row execute function public.set_updated_at();',
  'db/grants/cases.sql': 'grant select on public.cases to authenticated;',
};

export function planReadFile(path: string): Promise<string> {
  const content = planFiles[path];
  if (content === undefined) return Promise.reject(new Error(`missing file: ${path}`));
  return Promise.resolve(content);
}

/** 四种对象各一条，声明顺序故意打乱以验证 step 依赖序 */
export function planTestModule() {
  return defineDatabaseModule({
    name: 'cases',
    tables: ['public.cases'],
    grants: [
      {
        object: 'public.cases',
        privilege: 'SELECT',
        role: 'authenticated',
        source: 'db/grants/cases.sql',
      },
    ],
    triggers: [
      {
        name: 'cases_updated_at',
        table: 'public.cases',
        source: 'db/triggers/cases_updated_at.sql',
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
    functions: [
      {
        name: 'public.case_create',
        source: 'db/functions/case_create.sql',
        security: 'definer',
      },
    ],
  });
}

describe('planModule', () => {
  test('step 依赖序为 function -> policy -> trigger -> grant', async () => {
    const plan = await planModule(planTestModule(), planReadFile);
    expect(plan.version).toBe(1);
    expect(plan.module).toBe('cases');
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'function',
      'policy',
      'trigger',
      'grant',
    ]);
    expect(plan.steps.map((step) => step.name)).toEqual([
      'public.case_create',
      'public.cases.cases_select',
      'public.cases.cases_updated_at',
      'public.cases:SELECT:authenticated',
    ]);
  });

  test('sha256 与 digest 对同一输入稳定', async () => {
    const a = await planModule(planTestModule(), planReadFile);
    const b = await planModule(planTestModule(), planReadFile);
    expect(a.steps.map((step) => step.sha256)).toEqual(
      b.steps.map((step) => step.sha256),
    );
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('源文件内容变化时 sha256 与 digest 变化', async () => {
    const a = await planModule(planTestModule(), planReadFile);
    const b = await planModule(planTestModule(), (path) =>
      Promise.resolve(path.endsWith('grants/cases.sql') ? 'grant insert on public.cases to authenticated;' : planFiles[path]),
    );
    expect(b.steps[3].sha256).not.toBe(a.steps[3].sha256);
    expect(b.digest).not.toBe(a.digest);
  });

  test('error 级 lint 原样进入 step.risk', async () => {
    const module = defineDatabaseModule({
      name: 'bad',
      functions: [
        { name: 'public.f', source: 'f.sql', security: 'definer' },
      ],
    });
    const plan = await planModule(module, () =>
      Promise.resolve(
        'create function public.f() returns int language sql security definer as $$ select 1 $$;',
      ),
    );
    expect(plan.steps[0].risk).toEqual([
      {
        severity: 'error',
        code: 'definer-no-search-path',
        message: 'security definer 函数必须显式 set search_path，避免 search_path 劫持',
      },
    ]);
  });

  test('non-idempotent-policy：policy 源文件缺 drop policy if exists 时进 step.risk', async () => {
    const module = defineDatabaseModule({
      name: 'cases',
      policies: [
        {
          name: 'cases_select',
          table: 'public.cases',
          operation: 'select',
          roles: ['authenticated'],
          source: 'p.sql',
        },
      ],
    });
    const plan = await planModule(module, () =>
      Promise.resolve(
        'create policy cases_select on public.cases for select to authenticated using (true);',
      ),
    );
    expect(plan.steps[0].risk).toHaveLength(1);
    expect(plan.steps[0].risk[0].severity).toBe('warn');
    expect(plan.steps[0].risk[0].code).toBe('non-idempotent-policy');
  });

  test('干净模块的 step.risk 为空', async () => {
    const plan = await planModule(planTestModule(), planReadFile);
    for (const step of plan.steps) {
      expect(step.risk).toEqual([]);
    }
  });
});
