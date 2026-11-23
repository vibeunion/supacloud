import { describe, expect, test } from 'bun:test';

import { defineDatabaseModule, type DatabaseModule } from './module.js';
import { suggestOperationOwnership } from './ownership-suggestion.js';

function grant(privilege: string, role = 'authenticated') {
  return { object: 'public.cases', privilege, role, source: `db/grants/cases_${privilege.toLowerCase()}.sql` };
}

describe('suggestOperationOwnership', () => {
  test('explicit declarations pass without consulting grants', () => {
    const module = defineDatabaseModule({
      name: 'cases',
      tables: ['public.cases'],
      grants: [grant('ALL', 'anon')],
      operationOwnership: [
        { table: 'public.cases', operation: 'update', owner: 'durable-command' },
      ],
    });
    const update = suggestOperationOwnership([module]).find((item) => item.operation === 'update');
    expect(update).toMatchObject({
      status: 'declared',
      owner: 'durable-command',
      confidence: 'explicit',
      reason: 'explicit-declaration',
    });
    expect(update?.evidence).toEqual([
      expect.objectContaining({ kind: 'declaration', detail: expect.stringContaining('module cases') }),
    ]);
  });

  test('a client SELECT grant is high-confidence evidence for the Data API', () => {
    const module = defineDatabaseModule({
      name: 'cases',
      tables: ['public.cases'],
      grants: [grant('SELECT')],
    });
    expect(suggestOperationOwnership([module]).find((item) => item.operation === 'select')).toEqual({
      table: 'public.cases',
      operation: 'select',
      status: 'suggested',
      owner: 'postgrest-data-api',
      candidates: [],
      confidence: 'high',
      reason: 'client-select-grant',
      evidence: [{
        kind: 'grant',
        detail: 'GRANT SELECT ON public.cases TO authenticated (db/grants/cases_select.sql)',
        role: 'authenticated',
        privilege: 'SELECT',
        source: 'db/grants/cases_select.sql',
      }],
    });
  });

  test('client write grants stay ambiguous instead of guessing an owner', () => {
    const module = defineDatabaseModule({
      name: 'cases',
      tables: ['public.cases'],
      grants: [grant('ALL', 'anon')],
    });
    const suggestions = suggestOperationOwnership([module]);
    for (const operation of ['insert', 'update', 'delete'] as const) {
      expect(suggestions.find((item) => item.operation === operation)).toMatchObject({
        status: 'ambiguous',
        owner: null,
        confidence: 'ambiguous',
        reason: 'write-grant-ambiguous',
        candidates: ['durable-command', 'postgrest-data-api'],
      });
    }
    expect(suggestions.find((item) => item.operation === 'select')).toMatchObject({
      status: 'suggested',
      owner: 'postgrest-data-api',
      confidence: 'high',
    });
  });

  test('grants to non-client roles or other tables do not count as evidence', () => {
    const module = defineDatabaseModule({
      name: 'cases',
      tables: ['public.cases', 'public.cases_audit'],
      grants: [
        { object: 'public.cases', privilege: 'SELECT', role: 'service_role', source: 'db/grants/service.sql' },
        { object: 'public.cases_audit', privilege: 'SELECT', role: 'authenticated', source: 'db/grants/audit.sql' },
      ],
    });
    const suggestions = suggestOperationOwnership([module]);
    const caseSuggestions = suggestions.filter((item) => item.table === 'public.cases');
    expect(caseSuggestions.every((item) => item.status === 'unknown' && item.owner === null)).toBe(true);
    expect(caseSuggestions.every((item) => item.reason === 'no-evidence')).toBe(true);
    expect(caseSuggestions[0]?.evidence).toEqual([
      expect.objectContaining({ kind: 'missing-grant', detail: expect.stringContaining('public.cases SELECT') }),
    ]);
    expect(suggestions.filter((item) => item.table === 'public.cases_audit' && item.operation === 'select'))
      .toMatchObject([{ status: 'suggested', owner: 'postgrest-data-api' }]);
  });

  test('conflicting declarations are ambiguous, never silently resolved', () => {
    const modules: DatabaseModule[] = [
      defineDatabaseModule({
        name: 'reader',
        tables: ['public.cases'],
        operationOwnership: [{ table: 'public.cases', operation: 'select', owner: 'postgrest-data-api' }],
      }),
      defineDatabaseModule({
        name: 'writer',
        tables: ['public.cases'],
        operationOwnership: [{ table: 'public.cases', operation: 'select', owner: 'durable-command' }],
      }),
    ];
    expect(suggestOperationOwnership(modules).find((item) => item.operation === 'select')).toMatchObject({
      status: 'ambiguous',
      owner: null,
      candidates: ['durable-command', 'postgrest-data-api'],
      reason: 'conflicting-declarations',
    });
  });

  test('output is deterministic and covers every declared table operation', () => {
    const first = defineDatabaseModule({
      name: 'z', tables: ['public.zeta'], grants: [grant('SELECT')],
    });
    const second = defineDatabaseModule({ name: 'a', tables: ['public.alpha'] });
    const suggestions = suggestOperationOwnership([first, second]);
    expect(suggestions.map((item) => `${item.table}.${item.operation}`)).toEqual([
      'public.alpha.select', 'public.alpha.insert', 'public.alpha.update', 'public.alpha.delete',
      'public.zeta.select', 'public.zeta.insert', 'public.zeta.update', 'public.zeta.delete',
    ]);
    expect(suggestOperationOwnership([first, second])).toEqual(suggestions);
  });
});