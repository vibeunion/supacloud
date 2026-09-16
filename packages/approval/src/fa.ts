import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ApprovalContractError, immutableData } from './validation.js';
import type { ApprovalObservation } from './index.js';
import { intakeDefinition, reportDefinition, type IntakeEvent, type IntakeState, type ReportEvent, type ReportState } from './fa-models.js';
export * from './fa-models.js';

const Id = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
});
const Text = Type.String({ minLength: 1, maxLength: 256, pattern: '\\S' });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const ScopeSchema = Type.Object({
  tenantId: Text, entityId: Id, requestId: Id, actorId: Text, definitionVersion: Text,
}, { additionalProperties: false });
const ReportReceiptSchema = Type.Object({
  reportVersionId: Id, rowVersion: Version,
  status: Type.String(), reviewStage: Type.String(),
  idempotent: Type.Optional(Type.Boolean()),
  decision: Type.Optional(Type.Union([Type.Literal('approve'), Type.Literal('reject')])),
  signatureKind: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  signatureManifestChecksumSha256: Type.Optional(Type.Union([
    Type.String({ pattern: '^[a-fA-F0-9]{64}$' }), Type.Null(),
  ])),
}, { additionalProperties: true });
const IntakeReceiptSchema = Type.Object({
  orderId: Id, approvalRequestId: Id, rowVersion: Version, idempotent: Type.Boolean(),
  status: Type.Union(['pending_approval', 'submitted', 'confirmed'].map(state => Type.Literal(state))),
  decisionKind: Type.Optional(Type.Union([Type.Literal('automatic'), Type.Literal('manual')])),
}, { additionalProperties: true });

/** Identity captured from the authenticated invocation, not from a browser or a prediction. */
export interface FaReceiptScope {
  readonly tenantId: string;
  readonly entityId: string;
  readonly requestId: string;
  readonly actorId: string;
  readonly definitionVersion: string;
}

export type FaReportInvocation = FaReceiptScope & (
  | { readonly command: 'report.submit_internal' | 'report.complete_internal' }
  | {
    readonly command: 'report.internal_technical_decide' | 'report.internal_quality_decide';
    readonly decision: 'approve' | 'reject';
  }
);

function scopeOf(invocation: FaReceiptScope): FaReceiptScope {
  const scope = immutableData({
    tenantId: invocation.tenantId, entityId: invocation.entityId,
    requestId: invocation.requestId, actorId: invocation.actorId, definitionVersion: invocation.definitionVersion,
  }, 'observation');
  if (!Value.Check(ScopeSchema, scope)) throw new ApprovalContractError('observation');
  return scope;
}

function committed<State extends string>(
  scope: FaReceiptScope, key: string, state: State, rowVersion: number, event: string, idempotent: boolean,
): ApprovalObservation<State> {
  return Object.freeze({
    kind: 'committed', requestId: scope.requestId, actorId: scope.actorId, event, idempotent,
    snapshot: Object.freeze({
      definitionKey: key, definitionVersion: scope.definitionVersion,
      tenantId: scope.tenantId, entityId: scope.entityId, state, rowVersion,
    }),
  });
}

/** Decode a successful RPC receipt only. An HTTP/DB error must never be passed as a receipt. */
export function observeFaReportReceipt(
  invocation: FaReportInvocation, value: unknown,
): ApprovalObservation<ReportState> {
  const scope = scopeOf(invocation);
  const receipt = immutableData(value, 'observation');
  if (!Value.Check(ReportReceiptSchema, receipt)
    || receipt.reportVersionId.toLowerCase() !== scope.entityId.toLowerCase()) {
    throw new ApprovalContractError('observation');
  }
  let event: ReportEvent;
  let states: readonly ReportState[];
  switch (invocation.command) {
    case 'report.submit_internal':
      event = 'submit'; states = ['internal_technical', 'internal_quality'];
      break;
    case 'report.complete_internal':
      event = 'sign'; states = ['signed'];
      break;
    case 'report.internal_technical_decide':
    case 'report.internal_quality_decide': {
      if (invocation.decision !== 'approve' && invocation.decision !== 'reject') {
        throw new ApprovalContractError('observation');
      }
      const technical = invocation.command === 'report.internal_technical_decide';
      event = technical
        ? (invocation.decision === 'approve' ? 'technical_approve' : 'technical_reject')
        : (invocation.decision === 'approve' ? 'quality_approve' : 'quality_reject');
      states = invocation.decision === 'reject' ? ['drafting'] : technical ? ['internal_quality'] : ['signing'];
      if (receipt.decision !== invocation.decision) throw new ApprovalContractError('observation');
      break;
    }
    default:
      throw new ApprovalContractError('observation');
  }
  const state = states.find(candidate => candidate === receipt.reviewStage);
  if (!state) throw new ApprovalContractError('observation');
  const status = state === 'drafting' ? 'returned'
    : state === 'signed' ? 'signed' : state === 'signing' ? 'reviewing' : 'internal_reviewing';
  if (receipt.status !== status || (event !== 'submit' && typeof receipt.idempotent !== 'boolean')) {
    throw new ApprovalContractError('observation');
  }
  if (event === 'sign' && (receipt.decision !== 'approve'
    || receipt.signatureKind !== 'business_attestation'
    || typeof receipt.signatureManifestChecksumSha256 !== 'string')) {
    throw new ApprovalContractError('observation');
  }
  return committed(scope, reportDefinition.key, state, receipt.rowVersion, event, receipt.idempotent === true);
}

export function observeFaIntakeReceipt(
  invocation: FaReceiptScope & {
    readonly event: IntakeEvent;
    /** Required for decisions; the submit RPC creates this identity. */
    readonly approvalRequestId?: string;
  },
  value: unknown,
): ApprovalObservation<IntakeState> {
  const scope = scopeOf(invocation);
  const receipt = immutableData(value, 'observation');
  if (!Value.Check(IntakeReceiptSchema, receipt)
    || receipt.orderId.toLowerCase() !== scope.entityId.toLowerCase()
    || !['submit', 'approve_manual', 'approve_automatic', 'reject'].includes(invocation.event)) {
    throw new ApprovalContractError('observation');
  }
  if (invocation.event !== 'submit' && (!Value.Check(Id, invocation.approvalRequestId)
    || receipt.approvalRequestId.toLowerCase() !== invocation.approvalRequestId?.toLowerCase())) {
    throw new ApprovalContractError('observation');
  }
  // The HTTP service can submit AND auto-approve inline. It is not the one-step submit RPC.
  if (invocation.event === 'submit' && receipt.status === 'confirmed') return { kind: 'unknown' };
  const expected = invocation.event === 'submit' ? 'pending_approval'
    : invocation.event === 'reject' ? 'submitted' : 'confirmed';
  const decisionKind = invocation.event === 'approve_automatic' ? 'automatic' : 'manual';
  if (receipt.status !== expected || (invocation.event !== 'submit' && receipt.decisionKind !== decisionKind)) {
    throw new ApprovalContractError('observation');
  }
  return committed(scope, intakeDefinition.key, expected, receipt.rowVersion, invocation.event, receipt.idempotent);
}
