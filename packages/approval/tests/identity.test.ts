import { expect, test } from 'bun:test';
import {
  createApprovalIdentity,
  createApprovalIdentityFromSupAuth,
  durableApprovalActor,
} from '../src/durable.js';

const context = {
  identity: {
    authenticated: true as const,
    issuer: 'https://identity.example/auth/v1',
    subject: 'user-123',
    clientId: 'client-fa',
  },
  access: {
    projectId: 'project-fa',
    tenantId: 'tenant-a',
  },
};

test('binds verified SupAuth identity to application-local workflow actor', () => {
  const identity = createApprovalIdentityFromSupAuth(context, {
    applicationId: 'xigu-fa',
    actorId: 'membership-123',
    membershipId: 'membership-123',
  });
  expect(identity.principal).toEqual({
    kind: 'user', issuer: context.identity.issuer, subject: context.identity.subject, clientId: context.identity.clientId,
  });
  expect(identity.access).toEqual({
    applicationId: 'xigu-fa', projectId: 'project-fa', tenantId: 'tenant-a',
    actorId: 'membership-123', membershipId: 'membership-123',
  });
  expect(durableApprovalActor(identity)).toEqual({ tenant: 'tenant-a', actor: 'membership-123' });
  expect(Object.isFrozen(identity)).toBe(true);
  expect(Object.isFrozen(identity.access)).toBe(true);
});

test('does not treat the JWT subject as the business actor', () => {
  const identity = createApprovalIdentityFromSupAuth(context, {
    applicationId: 'xigu-fa', actorId: 'local-membership',
  });
  expect(durableApprovalActor(identity).actor).toBe('local-membership');
  expect(durableApprovalActor(identity).actor).not.toBe(context.identity.subject);
});

test('rejects unverified or cross-project contexts before binding access', () => {
  expect(() => createApprovalIdentityFromSupAuth({
    ...context, identity: { ...context.identity, authenticated: false as false },
  }, { applicationId: 'xigu-fa', actorId: 'member' })).toThrow('APPROVAL_IDENTITY_NOT_VERIFIED');
  expect(() => createApprovalIdentityFromSupAuth(context, {
    applicationId: 'xigu-fa', projectId: 'project-other', actorId: 'member',
  })).toThrow('APPROVAL_IDENTITY_PROJECT_MISMATCH');
});

test('validates service principals and rejects forged identity fields', () => {
  const identity = createApprovalIdentity({
    principal: { kind: 'service', issuer: 'https://identity.example', subject: 'worker-1' },
    applicationId: 'xigu-fa', projectId: 'project-fa', tenantId: 'tenant-a', actorId: 'worker-1',
  });
  expect(identity.principal.kind).toBe('service');
  expect(() => createApprovalIdentity({
    principal: { kind: 'user', issuer: 'https://identity.example', subject: 'forged actor' },
    applicationId: 'xigu-fa', projectId: 'project-fa', tenantId: 'tenant-a', actorId: 'member',
  })).toThrow('APPROVAL_INVALID_IDENTITY_SUBJECT');
});
