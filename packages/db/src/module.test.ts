import { describe, expect, test } from 'bun:test';

import { defineDatabaseModule, findOperationOwnershipConflicts } from './module.js';

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

describe('operation ownership', () => {
  test('keeps explicit table/operation owners', () => {
    const module = defineDatabaseModule({
      name: 'cases',
      tables: ['public.cases'],
      operationOwnership: [
        { table: 'public.cases', operation: 'select', owner: 'postgrest-data-api' },
        { table: 'public.cases', operation: 'insert', owner: 'durable-command' },
      ],
    });
    expect(module.operationOwnership).toEqual([
      { table: 'public.cases', operation: 'select', owner: 'postgrest-data-api' },
      { table: 'public.cases', operation: 'insert', owner: 'durable-command' },
    ]);
  });

  test('rejects implicit or malformed ownership', () => {
    const table = 'public.cases';
    const invalid = [
      [{ table, operation: 'select' }],
      [{ table, operation: 'select', owner: 'orm' }],
      [{ table, operation: 'truncate', owner: 'legacy-rpc' }],
      [{ table: 'public.other', operation: 'select', owner: 'legacy-rpc' }],
      [{ table: 'cases', operation: 'select', owner: 'legacy-rpc' }],
    ];
    for (const operationOwnership of invalid) {
      expect(() => defineDatabaseModule({
        name: 'cases', tables: [table],
        operationOwnership: operationOwnership as never,
      })).toThrow();
    }
  });

  test('rejects duplicate and conflicting ownership for the same table operation', () => {
    for (const owner of ['postgrest-data-api', 'legacy-rpc'] as const) {
      expect(() => defineDatabaseModule({
        name: 'cases', tables: ['public.cases'],
        operationOwnership: [
          { table: 'public.cases', operation: 'select', owner: 'postgrest-data-api' },
          { table: 'public.cases', operation: 'select', owner },
        ],
      })).toThrow(owner === 'postgrest-data-api' ? /Duplicate/ : /Conflicting/);
    }
  });

  test('finds cross-module conflicts only when owners disagree', () => {
    const first = defineDatabaseModule({
      name: 'first', tables: ['public.cases'],
      operationOwnership: [{ table: 'public.cases', operation: 'select', owner: 'postgrest-data-api' }],
    });
    const same = defineDatabaseModule({
      name: 'same', tables: ['public.cases'],
      operationOwnership: [{ table: 'public.cases', operation: 'select', owner: 'postgrest-data-api' }],
    });
    const conflicting = defineDatabaseModule({
      name: 'second', tables: ['public.cases'],
      operationOwnership: [
        { table: 'public.cases', operation: 'select', owner: 'durable-command' },
        { table: 'public.cases', operation: 'update', owner: 'durable-command' },
      ],
    });
    expect(findOperationOwnershipConflicts([first, same])).toEqual([]);
    expect(findOperationOwnershipConflicts([first, same, conflicting])).toEqual([{
      table: 'public.cases',
      operation: 'select',
      owners: ['durable-command', 'postgrest-data-api'],
      modules: ['first', 'same', 'second'],
    }]);
  });
});
