import { describe, expect, test } from 'bun:test';
import {
  compareApprovalOutcome,
  createApprovalModel,
  type ApprovalDefinition,
  type ApprovalEvaluation,
  type ApprovalSnapshot,
  type ApprovalGuard,
  ApprovalContractError,
  decodeApprovalDefinition,
  decodeApprovalInput,
  decodeApprovalObservation,
  runApprovalShadow,
  type ApprovalShadowMetric,
} from '../src/index.js';
import { observeFaIntakeReceipt, observeFaReportReceipt } from '../src/fa.js';
import {
  createFaIntakeModel,
  createFaReportModel,
  intakeDefinition,
  reportDefinition,
  type IntakeEvent,
  type IntakeFacts,
  type IntakeState,
  type ReportEvent,
  type ReportFacts,
  type ReportState,
} from '../examples/fa-models.js';

const definition = {
  key: 'example.approval',
  version: '1',
  initial: 'pending',
  states: ['pending', 'approved'],
  terminal: ['approved'],
  transitions: [{ from: 'pending', event: 'approve', to: 'approved', guard: 'eligible' }],
} as const;
type State = typeof definition.states[number];
const model = () => createApprovalModel<State, 'approve', { eligible: boolean }>(definition, {
  eligible: context => context.eligible
    ? { allowed: true } : { allowed: false, reason: 'not_eligible' },
});

function snapshot<S extends string>(
  key: string, state: S, overrides: Partial<ApprovalSnapshot<S>> = {},
): ApprovalSnapshot<S> {
  return {
    definitionKey: key, definitionVersion: '1',
    tenantId: 'tenant-a', entityId: 'entity-1', rowVersion: 7, state,
    ...overrides,
  };
}

const input = () => ({
  snapshot: snapshot<State>(definition.key, 'pending'),
  expectedRowVersion: 7,
  requestId: 'request-1',
  actorId: 'member-1',
  event: 'approve' as const,
  context: { eligible: true },
});

describe('pure approval definition and evaluator', () => {
  test('uses a guarded XState transition without mutating the domain snapshot', () => {
    const original = input();
    const result = model().evaluate(original);
    expect(result).toMatchObject({ kind: 'proposal', nextState: 'approved' });
    expect(original.snapshot.state).toBe('pending');
    expect(original.snapshot.rowVersion).toBe(7);
    expect(Object.isFrozen(result.before)).toBe(true);
    expect(result).not.toHaveProperty('rowVersion');
  });

  test('pins a copied definition and guard registry', () => {
    const mutable = {
      ...definition,
      transitions: definition.transitions.map(edge => ({ ...edge, to: edge.to as State })),
    };
    const guards = { eligible: () => ({ allowed: true as const }) };
    const evaluator = createApprovalModel(mutable, guards);
    const edge = mutable.transitions[0];
    if (!edge) throw new Error('Missing fixture transition');
    edge.to = 'pending';
    guards.eligible = () => { throw new Error('changed'); };
    expect(evaluator.evaluate(input())).toMatchObject({ kind: 'proposal', nextState: 'approved' });
    expect(Object.isFrozen(evaluator.definition.transitions[0])).toBe(true);
  });

  test.each([
    ['stale version', { expectedRowVersion: 6 }, 'stale_version'],
    ['invalid version', { expectedRowVersion: NaN }, 'invalid_snapshot'],
    ['missing request identity', { requestId: '' }, 'invalid_snapshot'],
    ['denied guard', { context: { eligible: false } }, 'guard_denied'],
  ] as const)('%s fails closed', (_name, patch, code) => {
    expect(model().evaluate({ ...input(), ...patch })).toMatchObject({ kind: 'blocked', code });
  });

  test.each([
    ['definition key', { definitionKey: 'other' }, 'definition_mismatch'],
    ['definition version', { definitionVersion: '2' }, 'definition_mismatch'],
    ['tenant identity', { tenantId: '' }, 'invalid_snapshot'],
    ['entity identity', { entityId: '' }, 'invalid_snapshot'],
    ['unsafe integer', { rowVersion: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_snapshot'],
    ['terminal state', { state: 'approved' }, 'invalid_transition'],
  ] as const)('%s is checked before guards', (_name, patch, code) => {
    expect(model().evaluate({ ...input(), snapshot: { ...input().snapshot, ...patch } }))
      .toMatchObject({ kind: 'blocked', code });
  });

  test('exceptions are blocked without leaking guard errors', () => {
    const evaluator = createApprovalModel(definition, {
      eligible: () => { throw new Error('private document data'); },
    });
    const result = evaluator.evaluate(input());
    expect(result).toMatchObject({ kind: 'blocked', code: 'guard_failed', reasons: [] });
    expect(JSON.stringify(result)).not.toContain('private document data');
  });

  test('rejects overlapping conditional branches instead of choosing by array order', () => {
    const evaluator = createApprovalModel({
      ...definition,
      transitions: [...definition.transitions, {
        from: 'pending', event: 'approve', to: 'approved', guard: 'alsoEligible',
      }],
    }, {
      eligible: () => ({ allowed: true }),
      alsoEligible: () => ({ allowed: true }),
    });
    expect(evaluator.evaluate(input())).toMatchObject({ kind: 'blocked', code: 'ambiguous_transition' });
  });

  const invalidDefinitions: ApprovalDefinition<string, string>[] = [
    { ...definition, version: '' },
    { ...definition, initial: 'absent' },
    { ...definition, states: ['pending', 'pending', 'approved'] },
    { ...definition, states: ['pending', 'approved', 'unreachable'] },
    { ...definition, terminal: [] },
    { ...definition, terminal: ['pending'] },
    { ...definition, transitions: [] },
    { ...definition, transitions: [...definition.transitions, ...definition.transitions] },
    { ...definition, transitions: [{ from: 'pending', event: 'approve', to: 'absent', guard: 'eligible' }] },
    { ...definition, transitions: [{ from: 'pending', event: '*', to: 'approved', guard: 'eligible' }] },
    { ...definition, transitions: [{ from: 'pending', event: 'report.*', to: 'approved', guard: 'eligible' }] },
    { ...definition, transitions: [{ from: 'pending', event: 'approve', to: 'approved', guard: 'toString' }] },
    { ...definition, states: ['pending', 'constructor'] },
  ];
  test.each(invalidDefinitions)('rejects invalid or incomplete graph %#', invalid => {
    expect(() => createApprovalModel(invalid, { eligible: () => ({ allowed: true }) })).toThrow();
  });
});

describe('shadow comparison, not execution', () => {
  const proposal = () => model().evaluate(input());
  const committed = () => ({
    kind: 'committed' as const, event: 'approve', requestId: 'request-1', actorId: 'member-1', idempotent: false,
    snapshot: snapshot<State>(definition.key, 'approved', { rowVersion: 8 }),
  });

  test('matches a committed outcome, and supports more than one domain version increment', () => {
    expect(compareApprovalOutcome(proposal(), committed()).kind).toBe('match');
    expect(compareApprovalOutcome(proposal(), {
      ...committed(), snapshot: { ...committed().snapshot, rowVersion: 9 },
    }).kind).toBe('match');
  });
  test('unknown and replayed outcomes cannot claim parity', () => {
    expect(compareApprovalOutcome(proposal(), { kind: 'unknown' }).kind).toBe('inconclusive');
    expect(compareApprovalOutcome(proposal(), { ...committed(), idempotent: true }).kind).toBe('inconclusive');
  });
  test.each([
    { tenantId: 'tenant-b' }, { entityId: 'other' }, { definitionVersion: '2' },
    { rowVersion: 7 }, { state: 'pending' as const },
  ])('detects a mismatched receipt %#', patch => {
    expect(compareApprovalOutcome(proposal(), {
      ...committed(), snapshot: { ...committed().snapshot, ...patch },
    }).kind).toBe('mismatch');
  });
  test('binds the receipt to the original request and event', () => {
    expect(compareApprovalOutcome(proposal(), { ...committed(), requestId: 'other' }).kind).toBe('mismatch');
    expect(compareApprovalOutcome(proposal(), { ...committed(), event: 'reject' }).kind).toBe('mismatch');
  });
  test('distinguishes rejected commands from transport failures and state changes', () => {
    const blocked = model().evaluate({ ...input(), context: { eligible: false } });
    const rejected = { ...committed(), kind: 'rejected' as const, snapshot: input().snapshot };
    expect(compareApprovalOutcome(blocked, rejected).kind).toBe('match');
    expect(compareApprovalOutcome(proposal(), rejected).kind).toBe('mismatch');
    expect(compareApprovalOutcome(blocked, committed()).kind).toBe('mismatch');
    expect(compareApprovalOutcome(blocked, {
      ...rejected, snapshot: { ...rejected.snapshot, rowVersion: 8 },
    }).kind).toBe('mismatch');
  });
});

function facts(event: string): IntakeFacts {
  return {
    tenantId: 'tenant-a', entityId: 'entity-1', rowVersion: 7,
    actor: { kind: 'human', id: 'member-1', tenantId: 'tenant-a', active: true, roles: ['fa_admin'] },
    authorization: {
      actorId: 'member-1', tenantId: 'tenant-a', entityId: 'entity-1', event, allowed: true,
    },
    snapshotMatches: true, policyMode: 'manual', frozenPolicyVersion: 1, authorizedPolicyVersion: 1,
  };
}

function reportFacts(event: ReportEvent): ReportFacts {
  return {
    ...facts(event), contributors: [], latestTechnical: null, approvedTechnicalReviewerIds: [],
    qualityApproval: null, reviewRound: 1, signatureReady: true, rejectionReason: 'Needs correction',
  };
}

function intake(state: IntakeState, event: IntakeEvent, context: IntakeFacts = facts(event)) {
  return createFaIntakeModel().evaluate({
    snapshot: snapshot(intakeDefinition.key, state),
    expectedRowVersion: 7, requestId: 'request-1', actorId: context.actor.id, event, context,
  });
}

function report(state: ReportState, event: ReportEvent, context: ReportFacts = reportFacts(event)) {
  return createFaReportModel().evaluate({
    snapshot: snapshot(reportDefinition.key, state),
    expectedRowVersion: 7, requestId: 'request-1', actorId: context.actor.id, event, context,
  });
}

function expectNext<S extends string>(result: ApprovalEvaluation<S>, state: S): void {
  expect(result).toMatchObject({ kind: 'proposal', nextState: state });
}

describe('FA intake approval reference', () => {
  test('submits frozen content, rejects to submitted, and can submit again', () => {
    expectNext(intake('draft', 'submit'), 'pending_approval');
    expectNext(intake('pending_approval', 'reject'), 'submitted');
    expectNext(intake('submitted', 'submit'), 'pending_approval');
    expectNext(intake('pending_approval', 'approve_manual'), 'confirmed');
  });
  test('does not invent a completed state for repeated approval or submission', () => {
    expect(intake('confirmed', 'approve_manual').kind).toBe('blocked');
    expect(intake('pending_approval', 'submit').kind).toBe('blocked');
  });
  test.each([
    { snapshotMatches: false }, { rowVersion: 6 }, { entityId: 'entity-2' }, { tenantId: 'tenant-b' },
  ])('rejects changed content or mismatched facts %#', patch => {
    expect(intake('draft', 'submit', { ...facts('submit'), ...patch }).kind).toBe('blocked');
  });
  test('cannot reuse authorization for another event, actor, or tenant', () => {
    const base = facts('approve_manual');
    for (const patch of [
      { event: 'submit' }, { actorId: 'other' }, { tenantId: 'other' },
      { entityId: 'other' }, { allowed: false },
    ]) {
      expect(intake('pending_approval', 'approve_manual', {
        ...base, authorization: { ...base.authorization, ...patch },
      }).kind).toBe('blocked');
    }
  });
  test('automatic approval needs a system actor and the frozen policy version', () => {
    const base = facts('approve_automatic');
    const system: IntakeFacts = {
      ...base, policyMode: 'automatic', actor: { ...base.actor, kind: 'system', roles: [] },
    };
    expectNext(intake('pending_approval', 'approve_automatic', system), 'confirmed');
    expect(intake('pending_approval', 'approve_automatic', base).kind).toBe('blocked');
    expect(intake('pending_approval', 'approve_automatic', {
      ...system, authorizedPolicyVersion: 2,
    }).kind).toBe('blocked');
    expect(intake('pending_approval', 'approve_automatic', {
      ...system, policyMode: 'manual',
    }).kind).toBe('blocked');
    expect(system.actor.kind).toBe('system');
  });
});

describe('FA formal report reference', () => {
  const technical = { decision: 'approve' as const, reviewerId: 'technical-reviewer' };
  test('technical, quality, and signing are separate stages', () => {
    expectNext(report('drafting', 'submit'), 'internal_technical');
    expectNext(report('internal_technical', 'technical_approve'), 'internal_quality');
    expectNext(report('internal_quality', 'quality_approve', {
      ...reportFacts('quality_approve'), latestTechnical: technical,
    }), 'signing');
    expect(report('internal_quality', 'sign').kind).toBe('blocked');
  });
  test('quality return retains technical approval and resubmits directly to quality', () => {
    expectNext(report('internal_quality', 'quality_reject', {
      ...reportFacts('quality_reject'), latestTechnical: technical,
    }), 'drafting');
    expectNext(report('drafting', 'submit', {
      ...reportFacts('submit'), latestTechnical: technical, reviewRound: 2,
    }), 'internal_quality');
    expectNext(report('drafting', 'submit', {
      ...reportFacts('submit'), latestTechnical: { ...technical, decision: 'reject' },
    }), 'internal_technical');
  });
  test('quality cannot be reviewed by a current or earlier approving technical reviewer', () => {
    const base = { ...reportFacts('quality_approve'), latestTechnical: technical };
    expect(report('internal_quality', 'quality_approve', {
      ...base, latestTechnical: { ...technical, reviewerId: base.actor.id },
    }).kind).toBe('blocked');
    expect(report('internal_quality', 'quality_approve', {
      ...base, approvedTechnicalReviewerIds: [base.actor.id],
    }).kind).toBe('blocked');
  });
  test('reject requires a reason; contributors and inactive members cannot normally review', () => {
    expect(report('internal_technical', 'technical_reject', {
      ...reportFacts('technical_reject'), rejectionReason: ' ',
    }).kind).toBe('blocked');
    const base = reportFacts('technical_approve');
    expect(report('internal_technical', 'technical_approve', {
      ...base, contributors: [base.actor.id], actor: { ...base.actor, roles: ['technical_reviewer'] },
    }).kind).toBe('blocked');
    expect(report('internal_technical', 'technical_approve', {
      ...base, actor: { ...base.actor, active: false },
    }).kind).toBe('blocked');
  });
  test('signing requires explicit signer qualification, independent quality approval and current round', () => {
    const base = reportFacts('sign');
    const eligible: ReportFacts = {
      ...base, actor: { ...base.actor, roles: ['authorized_signer'] },
      latestTechnical: technical, qualityApproval: { reviewerId: 'quality-reviewer', round: 1 },
    };
    expectNext(report('signing', 'sign', eligible), 'signed');
    for (const patch of [
      { actor: { ...base.actor, roles: ['fa_admin'] } },
      { qualityApproval: { reviewerId: base.actor.id, round: 1 } },
      { qualityApproval: { reviewerId: 'quality-reviewer', round: 0 } },
      { signatureReady: false },
      { latestTechnical: null },
    ]) {
      expect(report('signing', 'sign', { ...eligible, ...patch }).kind).toBe('blocked');
    }
  });
});

describe('production contract boundaries', () => {
  test('decodes input without coercion and rejects malformed or oversized definition data', () => {
    const decodeFacts = (value: unknown): { eligible: boolean } => {
      if (!value || typeof value !== 'object' || !('eligible' in value) || typeof value.eligible !== 'boolean') {
        throw new ApprovalContractError('facts');
      }
      return { eligible: value.eligible };
    };
    expect(decodeApprovalInput(input(), decodeFacts)).toEqual(input());
    expect(() => decodeApprovalInput({ ...input(), expectedRowVersion: '7' }, decodeFacts)).toThrow(ApprovalContractError);
    expect(() => decodeApprovalInput({ ...input(), context: { eligible: 'true' } }, decodeFacts)).toThrow();
    expect(() => decodeApprovalDefinition({ ...definition, script: 'unregistered action' })).toThrow();
    expect(() => decodeApprovalDefinition({
      ...definition, states: Array.from({ length: 129 }, (_, i) => `state${i}`),
    })).toThrow();
  });

  test('does not invoke getters while cloning a JSON boundary', () => {
    let calls = 0;
    const unsafe = Object.defineProperty({}, 'key', { enumerable: true, get: () => { calls++; return 'unsafe'; } });
    expect(() => decodeApprovalDefinition(unsafe)).toThrow();
    expect(calls).toBe(0);
  });

  test('clones and freezes facts so a faulty guard cannot modify application data', () => {
    const context = { nested: { eligible: true } };
    const evaluator = createApprovalModel(definition, {
      eligible: (value: Readonly<typeof context>) => {
        value.nested.eligible = false;
        return { allowed: true };
      },
    });
    expect(evaluator.evaluate({ ...input(), context })).toMatchObject({ kind: 'blocked', code: 'guard_failed' });
    expect(context.nested.eligible).toBe(true);
  });

  test('rejects cycles, class instances, sparse arrays and excessive facts', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const evaluator = createApprovalModel(definition, { eligible: () => ({ allowed: true }) });
    for (const context of [cyclic, new Date(), Array(10), { text: 'x'.repeat(65_537) }]) {
      expect(evaluator.evaluate({ ...input(), context })).toMatchObject({ kind: 'blocked', code: 'guard_failed' });
    }
  });

  test('async guards fail closed without unhandled promise rejection', async () => {
    const guard = (async () => { throw new Error('private async error'); }) as unknown as ApprovalGuard<unknown>;
    expect(createApprovalModel(definition, { eligible: guard }).evaluate(input()))
      .toMatchObject({ kind: 'blocked', code: 'guard_failed' });
    await Promise.resolve();
  });

  test('guard failures and invalid receipts are not successful parity evidence', () => {
    const prediction = createApprovalModel(definition, {
      eligible: () => { throw new Error('failure'); },
    }).evaluate(input());
    const rejected = {
      kind: 'rejected' as const, requestId: 'request-1', actorId: 'member-1', event: 'approve',
      snapshot: input().snapshot, idempotent: false,
    };
    expect(compareApprovalOutcome(prediction, rejected)).toEqual({ kind: 'inconclusive', reason: 'model_unavailable' });
    expect(() => decodeApprovalObservation({ ...rejected, idempotent: 'false' })).toThrow();
    expect(compareApprovalOutcome(model().evaluate(input()), {
      ...rejected, snapshot: { ...rejected.snapshot, rowVersion: NaN },
    }).kind).toBe('inconclusive');
    expect(compareApprovalOutcome(model().evaluate(input()), { ...rejected, actorId: 'another-member' }))
      .toEqual({ kind: 'mismatch', reason: 'identity_mismatch' });
  });
});

describe('isolated shadow execution', () => {
  const observe = () => ({
    kind: 'committed' as const, requestId: 'request-1', actorId: 'member-1', event: 'approve',
    snapshot: snapshot<State>(definition.key, 'approved', { rowVersion: 8 }), idempotent: false,
  });
  const fail = () => { throw new Error('shadow callback must not run'); };

  test('is disabled by default and invokes the original command exactly once', async () => {
    let calls = 0;
    const value = { status: 'original' };
    expect(await runApprovalShadow(async () => { calls++; return value; }, {
      predict: fail, observe: fail, record: fail,
    })).toBe(value);
    expect(calls).toBe(1);
  });

  test('preserves committed results when prediction or observability fails', async () => {
    let calls = 0;
    const value = { status: 'original' };
    for (const predict of [() => model().evaluate(input()), fail]) {
      expect(await runApprovalShadow(async () => { calls++; return value; }, {
        enabled: true, predict, observe, record: async () => { throw new Error('monitor failed'); },
      })).toBe(value);
    }
    expect(calls).toBe(2);
  });

  test('preserves the exact command error and never retries or claims rejection', async () => {
    let calls = 0;
    const error = new Error('response lost, outcome unknown');
    const metrics: ApprovalShadowMetric[] = [];
    const result = runApprovalShadow(async () => { calls++; throw error; }, {
      enabled: true, predict: () => model().evaluate(input()), observe: fail,
      record: metric => { metrics.push(metric); },
    });
    await expect(result).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(metrics).toEqual([{
      schema: 'supacloud.approval.shadow.v1', kind: 'inconclusive', reason: 'command_outcome_unknown',
    }]);
  });

  test('observes real command output without exposing payloads or identifiers to metrics', async () => {
    const value = { sensitive: 'document body' };
    const metrics: ApprovalShadowMetric[] = [];
    const result = await runApprovalShadow(async () => value, {
      enabled: true, predict: () => model().evaluate(input()),
      observe: received => { expect(received).toBe(value); return observe(); },
      record: metric => { metrics.push(metric); },
    });
    expect(result).toBe(value);
    expect(metrics).toEqual([{
      schema: 'supacloud.approval.shadow.v1', kind: 'match', reason: 'committed_as_predicted',
    }]);
    expect(JSON.stringify(metrics)).not.toContain('member-1');
    expect(JSON.stringify(metrics)).not.toContain('document body');
  });

  test('ignores observer errors and does not wait for a hanging metrics sink', async () => {
    expect(await runApprovalShadow(async () => 'original', {
      enabled: true, predict: () => model().evaluate(input()), observe: fail,
      record: () => new Promise<void>(() => undefined),
    })).toBe('original');
  });

  test('does not share mutable state across concurrent invocations', async () => {
    const evaluator = model();
    let executed = 0;
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) =>
      runApprovalShadow(async () => { executed++; return i; }, {
        enabled: true, predict: () => evaluator.evaluate(input()), observe,
      })));
    expect(executed).toBe(100);
    expect(new Set(results).size).toBe(100);
    expect(evaluator.evaluate(input())).toMatchObject({ kind: 'proposal', nextState: 'approved' });
  });
});

describe('FA command receipt adapters', () => {
  const entityId = '10000000-0000-4000-8000-000000000001';
  const approvalId = '20000000-0000-4000-8000-000000000001';
  const scope = {
    tenantId: 'tenant-a', entityId, definitionVersion: '1', actorId: 'member-1',
    requestId: '30000000-0000-4000-8000-000000000001',
  };
  const review = {
    reportVersionId: entityId, rowVersion: 8, idempotent: false,
    status: 'reviewing', reviewStage: 'signing', decision: 'approve',
    signatureKind: null, signatureManifestChecksumSha256: null,
  };

  test('quality approval projects waiting for signing, never a completed signature', () => {
    expect(observeFaReportReceipt({
      ...scope, command: 'report.internal_quality_decide', decision: 'approve',
    }, review)).toMatchObject({ kind: 'committed', event: 'quality_approve', snapshot: { state: 'signing' } });
  });

  test('checks command, decision, entity, state and version together', () => {
    for (const patch of [
      { reportVersionId: approvalId }, { decision: 'reject' }, { reviewStage: 'signed' },
      { rowVersion: '8' }, { rowVersion: Number.MAX_SAFE_INTEGER + 1 }, { idempotent: 'false' },
      { status: 'signed' },
    ]) {
      expect(() => observeFaReportReceipt({
        ...scope, command: 'report.internal_quality_decide', decision: 'approve',
      }, { ...review, ...patch })).toThrow(ApprovalContractError);
    }
  });

  test('reject and resubmit preserve the actual report stage vocabulary', () => {
    expect(observeFaReportReceipt({
      ...scope, command: 'report.internal_quality_decide', decision: 'reject',
    }, { ...review, status: 'returned', reviewStage: 'drafting', decision: 'reject' }))
      .toMatchObject({ event: 'quality_reject', snapshot: { state: 'drafting' } });
    expect(observeFaReportReceipt({ ...scope, command: 'report.submit_internal' }, {
      reportVersionId: entityId, rowVersion: 9, status: 'internal_reviewing', reviewStage: 'internal_quality',
    })).toMatchObject({ event: 'submit', snapshot: { state: 'internal_quality' } });
  });

  test('signed receipts need the expected signature kind and checksum', () => {
    const signed = { ...review, status: 'signed', reviewStage: 'signed' };
    expect(() => observeFaReportReceipt({ ...scope, command: 'report.complete_internal' }, signed)).toThrow();
    expect(observeFaReportReceipt({ ...scope, command: 'report.complete_internal' }, {
      ...signed, signatureKind: 'business_attestation', signatureManifestChecksumSha256: 'a'.repeat(64),
    })).toMatchObject({ event: 'sign', snapshot: { state: 'signed' } });
  });

  test('intake rejects to submitted and binds the approval request identity', () => {
    const receipt = {
      orderId: entityId, approvalRequestId: approvalId, rowVersion: 8, idempotent: false,
      status: 'submitted', decisionKind: 'manual',
    };
    const invocation = { ...scope, event: 'reject' as const, approvalRequestId: approvalId };
    expect(observeFaIntakeReceipt(invocation, receipt)).toMatchObject({
      event: 'reject', snapshot: { state: 'submitted' },
    });
    expect(() => observeFaIntakeReceipt({ ...invocation, approvalRequestId: entityId }, receipt)).toThrow();
    expect(() => observeFaIntakeReceipt({ ...scope, event: 'reject' }, receipt)).toThrow();
  });

  test('inline submit plus automatic approval is not falsely compared as a single transition', () => {
    const receipt = {
      orderId: entityId, approvalRequestId: approvalId, rowVersion: 9, idempotent: false,
      status: 'confirmed', decisionKind: 'automatic',
    };
    expect(observeFaIntakeReceipt({ ...scope, event: 'submit' }, receipt)).toEqual({ kind: 'unknown' });
    expect(observeFaIntakeReceipt({
      ...scope, event: 'approve_automatic', approvalRequestId: approvalId,
    }, receipt)).toMatchObject({ event: 'approve_automatic', snapshot: { state: 'confirmed' } });
  });
});
