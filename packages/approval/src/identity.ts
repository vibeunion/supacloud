const ACTOR_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;
const CONTEXT_PART_PATTERN = /^[^\s]{1,512}$/u;

export type ApprovalPrincipalKind = 'user' | 'service';

export interface ApprovalPrincipal {
  readonly kind: ApprovalPrincipalKind;
  readonly issuer: string;
  readonly subject: string;
  readonly clientId?: string;
}

export interface ApprovalIdentityAccess {
  readonly applicationId: string;
  readonly projectId: string;
  readonly tenantId: string;
  /** Application-local actor or membership key used by approval SQL. */
  readonly actorId: string;
  readonly membershipId?: string;
}

export interface ApprovalIdentity {
  readonly principal: ApprovalPrincipal;
  readonly access: ApprovalIdentityAccess;
}

/** Structural subset of the verified SupAuth host context. No SupAuth package is imported. */
export interface VerifiedSupAuthContextLike {
  readonly identity: {
    readonly authenticated: true;
    readonly issuer: string;
    readonly subject: string;
    readonly clientId: string;
  };
  readonly access: {
    readonly projectId: string;
    readonly tenantId: string;
  };
}

export interface ApprovalIdentityInput {
  readonly principal: ApprovalPrincipal;
  readonly applicationId: string;
  readonly projectId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly membershipId?: string;
}

function contextPart(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CONTEXT_PART_PATTERN.test(value)) {
    throw new Error(`APPROVAL_INVALID_IDENTITY_${label.toUpperCase()}`);
  }
  return value;
}

function actor(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ACTOR_PATTERN.test(value)) {
    throw new Error(`APPROVAL_INVALID_IDENTITY_${label.toUpperCase()}`);
  }
  return value;
}

function principal(value: ApprovalPrincipal): ApprovalPrincipal {
  if (!value || typeof value !== 'object' || (value.kind !== 'user' && value.kind !== 'service')) {
    throw new Error('APPROVAL_INVALID_IDENTITY_PRINCIPAL');
  }
  const result: ApprovalPrincipal = {
    kind: value.kind,
    issuer: contextPart(value.issuer, 'issuer'),
    subject: contextPart(value.subject, 'subject'),
    ...(value.clientId === undefined ? {} : { clientId: contextPart(value.clientId, 'client_id') }),
  };
  return Object.freeze(result);
}

/**
 * Binds a verified external principal to application-owned workflow access.
 * The actor and tenant are deliberately supplied by the application resolver,
 * never derived from a request header or copied from the JWT subject.
 */
export function createApprovalIdentity(input: ApprovalIdentityInput): ApprovalIdentity {
  const result: ApprovalIdentity = {
    principal: principal(input.principal),
    access: Object.freeze({
      applicationId: contextPart(input.applicationId, 'application_id'),
      projectId: contextPart(input.projectId, 'project_id'),
      tenantId: actor(input.tenantId, 'tenant'),
      actorId: actor(input.actorId, 'actor'),
      ...(input.membershipId === undefined ? {} : { membershipId: actor(input.membershipId, 'membership_id') }),
    }),
  };
  return Object.freeze(result);
}

/**
 * Creates the workflow binding from @supacloud/elysia's verified SupAuth
 * request context while keeping this package free of an Elysia/SupAuth import.
 */
export function createApprovalIdentityFromSupAuth(
  context: VerifiedSupAuthContextLike,
  input: Omit<ApprovalIdentityInput, 'principal' | 'projectId' | 'tenantId'> & {
    readonly projectId?: string;
  },
): ApprovalIdentity {
  if (context?.identity?.authenticated !== true) throw new Error('APPROVAL_IDENTITY_NOT_VERIFIED');
  if (context.access?.projectId === undefined || context.access.tenantId === undefined) {
    throw new Error('APPROVAL_IDENTITY_ACCESS_MISSING');
  }
  const projectId = input.projectId ?? context.access.projectId;
  if (projectId !== context.access.projectId) throw new Error('APPROVAL_IDENTITY_PROJECT_MISMATCH');
  return createApprovalIdentity({
    ...input,
    projectId,
    tenantId: context.access.tenantId,
    principal: {
      kind: 'user',
      issuer: context.identity.issuer,
      subject: context.identity.subject,
      clientId: context.identity.clientId,
    },
  });
}

/** Only these two fields cross into the generic approval SQL API. */
export function durableApprovalActor(identity: ApprovalIdentity): Readonly<{ tenant: string; actor: string }> {
  const bound = createApprovalIdentity({
    principal: identity.principal,
    applicationId: identity.access.applicationId,
    projectId: identity.access.projectId,
    tenantId: identity.access.tenantId,
    actorId: identity.access.actorId,
    ...(identity.access.membershipId === undefined ? {} : { membershipId: identity.access.membershipId }),
  });
  return Object.freeze({ tenant: bound.access.tenantId, actor: bound.access.actorId });
}
