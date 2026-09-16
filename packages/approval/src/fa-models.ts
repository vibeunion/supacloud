import {
  createApprovalModel,
  type ApprovalDefinition,
  type ApprovalGuard,
  type GuardDecision,
} from './index.js';

// These facts must come from the FA server, not from browser-supplied permissions.
export interface FaFacts {
  readonly actor: {
    readonly kind: 'human' | 'system';
    readonly id: string;
    readonly tenantId: string;
    readonly active: boolean;
    readonly roles: readonly string[];
  };
  readonly tenantId: string;
  readonly entityId: string;
  readonly rowVersion: number;
  readonly authorization: {
    readonly actorId: string;
    readonly tenantId: string;
    readonly entityId: string;
    readonly event: string;
    readonly allowed: boolean;
  };
  readonly snapshotMatches: boolean;
}

const decision = (allowed: boolean, reason: string): GuardDecision =>
  allowed ? { allowed: true } : { allowed: false, reason };

function boundGuards<Context extends FaFacts>(
  guards: Readonly<Record<string, (facts: Context) => GuardDecision>>,
): Readonly<Record<string, ApprovalGuard<Context>>> {
  return Object.fromEntries(Object.entries(guards).map(([key, guard]) => [
    key,
    (facts: Context, scope: Parameters<ApprovalGuard<Context>>[1]): GuardDecision =>
      facts.tenantId !== scope.snapshot.tenantId || facts.entityId !== scope.snapshot.entityId
        || facts.rowVersion !== scope.snapshot.rowVersion || facts.actor.id !== scope.actorId
        ? decision(false, 'FA_FACTS_SCOPE_MISMATCH')
        : guard(facts),
  ]));
}

function common(facts: FaFacts, event: string): GuardDecision {
  const { actor, authorization } = facts;
  if (actor.active !== true || !actor.id.trim() || !facts.entityId.trim()
    || !facts.tenantId.trim() || actor.tenantId !== facts.tenantId
    || authorization.actorId !== actor.id || authorization.tenantId !== facts.tenantId
    || authorization.entityId !== facts.entityId || authorization.event !== event
    || authorization.allowed !== true) {
    return decision(false, 'FA_AUTHORIZATION_REQUIRED');
  }
  return decision(facts.snapshotMatches === true, 'FA_SUBMISSION_SNAPSHOT_CHANGED');
}

function human(facts: FaFacts, event: string): GuardDecision {
  const base = common(facts, event);
  return base.allowed ? decision(facts.actor.kind === 'human', 'FA_HUMAN_REQUIRED') : base;
}

export type IntakeState = 'draft' | 'submitted' | 'pending_approval' | 'confirmed';
export type IntakeEvent = 'submit' | 'approve_manual' | 'approve_automatic' | 'reject';
export interface IntakeFacts extends FaFacts {
  readonly policyMode: 'manual' | 'automatic';
  readonly frozenPolicyVersion: number;
  readonly authorizedPolicyVersion: number;
}

export const intakeDefinition = {
  key: 'fa.intake-approval',
  version: '1',
  initial: 'draft',
  states: ['draft', 'submitted', 'pending_approval', 'confirmed'],
  terminal: ['confirmed'],
  transitions: [
    { from: 'draft', event: 'submit', to: 'pending_approval', guard: 'submit' },
    { from: 'submitted', event: 'submit', to: 'pending_approval', guard: 'submit' },
    { from: 'pending_approval', event: 'approve_manual', to: 'confirmed', guard: 'manual' },
    { from: 'pending_approval', event: 'approve_automatic', to: 'confirmed', guard: 'automatic' },
    { from: 'pending_approval', event: 'reject', to: 'submitted', guard: 'reject' },
  ],
} as const satisfies ApprovalDefinition<IntakeState, IntakeEvent>;

export function createFaIntakeModel() {
  function manual(facts: IntakeFacts, event: IntakeEvent): GuardDecision {
    const base = human(facts, event);
    return base.allowed ? decision(facts.actor.roles.includes('fa_admin'), 'FA_ADMIN_REQUIRED') : base;
  }
  return createApprovalModel<IntakeState, IntakeEvent, IntakeFacts>(intakeDefinition, boundGuards<IntakeFacts>({
    submit: facts => human(facts, 'submit'),
    manual: facts => manual(facts, 'approve_manual'),
    reject: facts => manual(facts, 'reject'),
    automatic: facts => {
      const base = common(facts, 'approve_automatic');
      if (!base.allowed) return base;
      return decision(
        facts.actor.kind === 'system' && facts.policyMode === 'automatic'
        && Number.isSafeInteger(facts.frozenPolicyVersion) && facts.frozenPolicyVersion >= 0
        && facts.frozenPolicyVersion === facts.authorizedPolicyVersion,
        'FA_AUTOMATIC_POLICY_REQUIRED',
      );
    },
  }));
}

export type ReportState = 'drafting' | 'internal_technical' | 'internal_quality' | 'signing' | 'signed';
export type ReportEvent = 'submit' | 'technical_approve' | 'technical_reject'
  | 'quality_approve' | 'quality_reject' | 'sign';
export interface ReportFacts extends FaFacts {
  readonly contributors: readonly string[];
  readonly latestTechnical: {
    readonly decision: 'approve' | 'reject';
    readonly reviewerId: string;
  } | null;
  readonly approvedTechnicalReviewerIds: readonly string[];
  readonly qualityApproval: {
    readonly reviewerId: string;
    readonly round: number;
  } | null;
  readonly reviewRound: number;
  readonly signatureReady: boolean;
  readonly rejectionReason: string;
}

export const reportDefinition = {
  key: 'fa.formal-report-review',
  version: '1',
  initial: 'drafting',
  states: ['drafting', 'internal_technical', 'internal_quality', 'signing', 'signed'],
  terminal: ['signed'],
  transitions: [
    { from: 'drafting', event: 'submit', to: 'internal_technical', guard: 'submitTechnical' },
    { from: 'drafting', event: 'submit', to: 'internal_quality', guard: 'submitQuality' },
    { from: 'internal_technical', event: 'technical_approve', to: 'internal_quality', guard: 'technicalApprove' },
    { from: 'internal_technical', event: 'technical_reject', to: 'drafting', guard: 'technicalReject' },
    { from: 'internal_quality', event: 'quality_approve', to: 'signing', guard: 'qualityApprove' },
    { from: 'internal_quality', event: 'quality_reject', to: 'drafting', guard: 'qualityReject' },
    { from: 'signing', event: 'sign', to: 'signed', guard: 'sign' },
  ],
} as const satisfies ApprovalDefinition<ReportState, ReportEvent>;

export function createFaReportModel() {
  function reviewer(facts: ReportFacts, event: ReportEvent, quality: boolean): GuardDecision {
    const base = human(facts, event);
    if (!base.allowed) return base;
    // Role exceptions and project assignment remain in the authoritative FA authorization projection.
    if (facts.contributors.includes(facts.actor.id) && !facts.actor.roles.includes('fa_admin')) {
      return decision(false, 'FA_AUTHOR_CANNOT_REVIEW');
    }
    if (quality && (facts.latestTechnical?.decision !== 'approve'
      || facts.latestTechnical.reviewerId === facts.actor.id
      || facts.approvedTechnicalReviewerIds.includes(facts.actor.id))) {
      return decision(false, 'FA_TECHNICAL_QUALITY_SEPARATION_REQUIRED');
    }
    if (event.endsWith('_reject') && !facts.rejectionReason.trim()) {
      return decision(false, 'FA_REJECTION_REASON_REQUIRED');
    }
    return { allowed: true };
  }
  function submit(facts: ReportFacts, retainTechnical: boolean): GuardDecision {
    const base = human(facts, 'submit');
    return base.allowed
      ? decision((facts.latestTechnical?.decision === 'approve') === retainTechnical, 'FA_REVIEW_ROUTE_NOT_SELECTED')
      : base;
  }
  return createApprovalModel<ReportState, ReportEvent, ReportFacts>(reportDefinition, boundGuards<ReportFacts>({
    submitTechnical: facts => submit(facts, false),
    submitQuality: facts => submit(facts, true),
    technicalApprove: facts => reviewer(facts, 'technical_approve', false),
    technicalReject: facts => reviewer(facts, 'technical_reject', false),
    qualityApprove: facts => reviewer(facts, 'quality_approve', true),
    qualityReject: facts => reviewer(facts, 'quality_reject', true),
    sign: facts => {
      const base = human(facts, 'sign');
      if (!base.allowed) return base;
      const quality = facts.qualityApproval;
      return decision(
        facts.actor.roles.includes('authorized_signer') && facts.signatureReady === true
        && facts.latestTechnical?.decision === 'approve'
        && facts.latestTechnical.reviewerId.trim().length > 0
        && quality !== null && quality.reviewerId !== facts.actor.id
        && quality.reviewerId.trim().length > 0
        && quality.reviewerId !== facts.latestTechnical.reviewerId
        && Number.isSafeInteger(facts.reviewRound) && facts.reviewRound > 0
        && quality.round === facts.reviewRound,
        'FA_AUTHORIZED_SIGNER_REQUIRED',
      );
    },
  }));
}
