import { describe, expect, test } from 'bun:test';
import { createDevtoolsSnapshot, redactDevtoolsRecord } from './index';

describe('devtools contract', () => {
  test('redacts secrets recursively', () => {
    expect(redactDevtoolsRecord({
      requestId: 'req-1',
      authorization: 'Bearer secret',
      nested: { service_role_key: 'private' },
    })).toEqual({
      requestId: 'req-1',
      authorization: '[redacted]',
      nested: { service_role_key: '[redacted]' },
    });
  });

  test('creates versioned snapshots without changing trace identity', () => {
    expect(createDevtoolsSnapshot({
      source: 'supacloud',
      requestId: 'req-1',
      traceId: 'trace-1',
      correlationId: 'workflow-1',
      diagnostics: [],
      events: [],
    })).toMatchObject({
      version: 1,
      source: 'supacloud',
      requestId: 'req-1',
      traceId: 'trace-1',
      correlationId: 'workflow-1',
    });
  });
});
