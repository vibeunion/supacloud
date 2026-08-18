import { createHash, randomBytes } from "node:crypto";
import type { SQL } from "bun";
import { getProjectDb, resolveDbName, sql } from "../db";
import {
  CapabilityUnavailableError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../utils/errors";
import type { InvitationPrincipal } from "./invitation-principal.service";
import { getAuthRuntimeDescriptor } from "./auth-runtime.service";
import { enqueueWebhookEventInTransaction } from "./webhook-delivery.service";

type AcceptOrganizationInvitationInput = {
  ref: string;
  organizationId: string;
  invitationId: string;
  token: string;
  principal: InvitationPrincipal;
};

type AddOrganizationMemberInput = {
  userId: string;
  role?: string;
  actor: string;
};

type InviteOrganizationMemberInput = {
  ref: string;
  organizationId: string;
  email: string;
  role?: string;
  actor: string;
  ttlHours?: number;
};

type OrganizationMemberEventType = "organization.member_added" | "organization.member_updated";

type OrganizationMemberMutation = {
  member: Record<string, unknown>;
  eventType: OrganizationMemberEventType | null;
};

const MEMBER_ROLES = new Set(["member", "admin"]);
const MAX_JIT_MEMBERSHIPS = 50;
const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ORGANIZATION_NAME_LENGTH = 120;
const SENSITIVE_BRANDING_KEYS = new Set([
  "authorization",
  "cookie",
  "token",
  "password",
  "secret",
  "clientsecret",
  "apikey",
  "privatekey",
]);

function validateBrandingValue(value: unknown, depth = 0): void {
  if (depth > 8) throw new ValidationError("branding must not exceed 8 nested levels");
  if (Array.isArray(value)) {
    for (const item of value) validateBrandingValue(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replaceAll(/[_-]/g, "").toLowerCase();
    if (SENSITIVE_BRANDING_KEYS.has(normalized)) {
      throw new ValidationError(`branding must not contain credential field ${key}`);
    }
    validateBrandingValue(item, depth + 1);
  }
}

function normalizedEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError("A valid email is required");
  }
  return email;
}

function normalizedRole(value: string | undefined): string {
  const role = (value || "member").trim().toLowerCase();
  if (!MEMBER_ROLES.has(role)) throw new ValidationError("role must be member or admin");
  return role;
}

function normalizedSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (slug.length < 2 || slug.length > 120) throw new ValidationError("slug must contain 2 to 120 URL-safe characters");
  return slug;
}

function validatedOrganizationSlug(value: string): string {
  if (value.length < 2 || value.length > 120 || !ORGANIZATION_SLUG_PATTERN.test(value)) {
    throw new ValidationError("slug must be 2 to 120 lowercase letters or numbers separated by single hyphens");
  }
  return value;
}

function validatedOrganizationName(rawName: string): string {
  const name = rawName.trim();
  if (!name || name.length > MAX_ORGANIZATION_NAME_LENGTH) {
    throw new ValidationError("name must contain 1 to 120 characters");
  }
  return name;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: string }).code === "23505";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function inviteToken(): string {
  return `orginv_${randomBytes(32).toString("base64url")}`;
}

async function projectExists(ref: string): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM projects WHERE ref = ${ref} AND deleted_at IS NULL`;
  return Boolean(row);
}

async function organizationOrThrow(ref: string, organizationId: string) {
  const [row] = await sql`
    SELECT * FROM project_business_organizations
    WHERE project_ref = ${ref} AND id = ${organizationId}
  `;
  if (!row) throw new NotFoundError("Business organization", organizationId);
  return row;
}

async function authorityAuthDb(ref: string) {
  const authorityRef = getAuthRuntimeDescriptor(ref).authority_project_ref;
  return getProjectDb(await resolveDbName(authorityRef));
}

async function assertGoTrueUser(ref: string, userId: string): Promise<void> {
  const tenantDb = await authorityAuthDb(ref);
  const [user] = await tenantDb`
    SELECT id FROM auth.users
    WHERE id::text = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!user) throw new NotFoundError("GoTrue user", userId);
}

async function readGoTrueUserEmail(ref: string, userId: string): Promise<string | null> {
  const tenantDb = await authorityAuthDb(ref);
  const [user] = await tenantDb`
    SELECT id, lower(email) AS email
    FROM auth.users
    WHERE id::text = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!user) throw new NotFoundError("GoTrue user", userId);
  return typeof user.email === "string" && user.email.includes("@") ? user.email : null;
}

function emailDomain(email: string | null): string | null {
  if (!email) return null;
  const domain = email.split("@").pop()?.trim().toLowerCase() || "";
  return domain || null;
}

async function materializeJitMemberships(ref: string, userId: string, domain: string | null) {
  return sql.begin(async (transaction) => {
    if (domain) {
      await transaction`
        INSERT INTO project_business_organization_members (organization_id, user_id, role)
        SELECT organization.id, ${userId}, 'member'
        FROM project_business_organizations organization
        WHERE organization.project_ref = ${ref}
          AND organization.jit_enabled = true
          AND EXISTS (
            SELECT 1 FROM unnest(organization.jit_domains) AS configured_domain(value)
            WHERE lower(configured_domain.value) = ${domain}
          )
        ON CONFLICT (organization_id, user_id) DO NOTHING
      `;
    }
    const memberships = await transaction`
      SELECT organization.id::text AS organization_id,
             organization.slug,
             membership.role,
             COUNT(*) OVER()::int AS total
      FROM project_business_organization_members membership
      JOIN project_business_organizations organization
        ON organization.id = membership.organization_id
      WHERE organization.project_ref = ${ref} AND membership.user_id = ${userId}
      ORDER BY organization.created_at ASC, organization.id ASC
      LIMIT ${MAX_JIT_MEMBERSHIPS}
    `;
    return memberships as Array<Record<string, unknown>>;
  });
}

async function assertGoTrueApplication(ref: string, applicationId: string): Promise<void> {
  try {
    const tenantDb = await authorityAuthDb(ref);
    const [application] = await tenantDb`
      SELECT id FROM auth.oauth_clients
      WHERE id::text = ${applicationId} AND deleted_at IS NULL
      LIMIT 1
    `;
    if (!application) throw new NotFoundError("GoTrue OAuth client", applicationId);
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null ? String((error as { code?: unknown }).code || "") : "";
    if (code === "42P01" || code === "42703") {
      throw new CapabilityUnavailableError("gotrue_oauth_server", "gotrue_oauth_server_not_available");
    }
    throw error;
  }
}

async function organizationMember(
  database: SQL,
  organizationId: string,
  userId: string,
) {
  const [member] = await database`
    SELECT * FROM project_business_organization_members
    WHERE organization_id = ${organizationId} AND user_id = ${userId}
    FOR UPDATE
  `;
  return member as Record<string, unknown> | undefined;
}

async function organizationMemberByKey(database: SQL, organizationId: string, memberKey: string) {
  const [member] = await database`
    SELECT * FROM project_business_organization_members
    WHERE organization_id = ${organizationId}
      AND (id::text = ${memberKey} OR user_id = ${memberKey})
    FOR UPDATE
  `;
  return member as Record<string, unknown> | undefined;
}

async function updateOrganizationMemberRole(database: SQL, memberId: string, role: string) {
  const [updatedMember] = await database`
    UPDATE project_business_organization_members
    SET role = ${role}, updated_at = NOW()
    WHERE id = ${memberId}
    RETURNING *
  `;
  if (!updatedMember) throw new ConflictError("Organization membership changed concurrently");
  return updatedMember as Record<string, unknown>;
}

async function changeOrganizationMemberRole(
  database: SQL,
  existingMember: Record<string, unknown>,
  role: string,
): Promise<OrganizationMemberMutation> {
  if (existingMember.role === role) return { member: existingMember, eventType: null };
  const member = await updateOrganizationMemberRole(database, String(existingMember.id), role);
  return { member, eventType: "organization.member_updated" };
}

async function mutateOrganizationMember(
  database: SQL,
  organizationId: string,
  userId: string,
  role: string,
): Promise<OrganizationMemberMutation> {
  const lockKey = `organization-member:${organizationId}:${userId}`;
  await database`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  const existingMember = await organizationMember(database, organizationId, userId);
  if (existingMember) return changeOrganizationMemberRole(database, existingMember, role);
  const [member] = await database`
    INSERT INTO project_business_organization_members (organization_id, user_id, role)
    VALUES (${organizationId}, ${userId}, ${role})
    RETURNING *
  `;
  return { member, eventType: "organization.member_added" } as OrganizationMemberMutation;
}

function organizationMemberEventKey(eventType: OrganizationMemberEventType, member: Record<string, unknown>): string {
  if (eventType === "organization.member_added") return `${eventType}:${String(member.id)}`;
  const updatedAt = member.updated_at instanceof Date
    ? member.updated_at.toISOString()
    : String(member.updated_at);
  return `${eventType}:${String(member.id)}:${updatedAt}`;
}

async function enqueueOrganizationMemberMutation(
  database: SQL,
  ref: string,
  actor: string,
  mutation: OrganizationMemberMutation,
): Promise<void> {
  if (!mutation.eventType) return;
  await enqueueWebhookEventInTransaction(database, {
    projectRef: ref,
    event: {
      type: mutation.eventType,
      payload: {
        org_id: mutation.member.organization_id,
        member_id: mutation.member.id,
        user_id: mutation.member.user_id,
        role: mutation.member.role,
      },
    },
    idempotencyKey: organizationMemberEventKey(mutation.eventType, mutation.member),
    actor,
  });
}

export const projectOrganizationService = {
  async list(ref: string, input: { page?: number; limit?: number; search?: string; application_id?: string }) {
    if (!(await projectExists(ref))) throw new NotFoundError("Project", ref);
    const page = Math.max(1, Math.trunc(input.page || 1));
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit || 50)));
    const offset = (page - 1) * limit;
    const search = input.search?.trim() || null;
    const applicationId = input.application_id?.trim() || null;
    const rows = await sql`
      SELECT o.*,
             COUNT(*) OVER()::int AS total,
             (SELECT COUNT(*)::int FROM project_business_organization_members m WHERE m.organization_id = o.id) AS member_count,
             (SELECT COUNT(*)::int FROM project_business_organization_applications a WHERE a.organization_id = o.id) AS application_count
      FROM project_business_organizations o
      WHERE o.project_ref = ${ref}
        AND (${search}::text IS NULL OR o.name ILIKE ${search ? `%${search}%` : null} OR o.slug ILIKE ${search ? `%${search}%` : null})
        AND (${applicationId}::text IS NULL OR EXISTS (
          SELECT 1 FROM project_business_organization_applications binding
          WHERE binding.organization_id = o.id AND binding.application_id = ${applicationId}
        ))
      ORDER BY o.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    ` as Array<Record<string, unknown>>;
    return { items: rows.map(({ total: _total, ...row }: Record<string, unknown>) => row), total: Number(rows[0]?.total || 0), page, limit };
  },

  async get(ref: string, organizationId: string) {
    return organizationOrThrow(ref, organizationId);
  },

  async create(ref: string, input: { name: string; slug?: string; description?: string | null; branding?: Record<string, unknown>; jit_enabled?: boolean; jit_domains?: string[] }, actor: string) {
    if (!(await projectExists(ref))) throw new NotFoundError("Project", ref);
    const name = validatedOrganizationName(input.name);
    const explicitSlug = input.slug === undefined ? null : validatedOrganizationSlug(input.slug);
    const slug = explicitSlug ?? normalizedSlug(name);
    validateBrandingValue(input.branding || {});
    const domains = [...new Set((input.jit_domains || []).map((item) => item.trim().toLowerCase()).filter(Boolean))];
    try {
      return await sql.begin(async (transaction) => {
        const jitDomains = transaction.array(domains, "TEXT");
        const [organization] = await transaction`
          INSERT INTO project_business_organizations (
            project_ref, name, slug, description, branding, jit_enabled, jit_domains, created_by
          ) VALUES (
            ${ref}, ${name}, ${slug}, ${input.description ?? null}, ${JSON.stringify(input.branding || {})}::jsonb,
            ${input.jit_enabled ?? false}, ${jitDomains}, ${actor}
          ) RETURNING *
        `;
        await enqueueWebhookEventInTransaction(transaction, {
          projectRef: ref,
          event: {
            type: "organization.created",
            payload: { org_id: organization.id, name: organization.name },
          },
          idempotencyKey: `organization.created:${organization.id}`,
          actor,
        });
        return organization;
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("An organization with this slug already exists");
      }
      throw error;
    }
  },

  async update(ref: string, organizationId: string, input: { name?: string; slug?: string; description?: string | null; branding?: Record<string, unknown>; jit_enabled?: boolean; jit_domains?: string[] }) {
    await organizationOrThrow(ref, organizationId);
    const name = input.name === undefined
      ? undefined
      : validatedOrganizationName(input.name);
    const slug = input.slug === undefined ? null : validatedOrganizationSlug(input.slug);
    if (input.branding !== undefined) validateBrandingValue(input.branding);
    const domains = input.jit_domains === undefined
      ? null
      : [...new Set(input.jit_domains.map((item) => item.trim().toLowerCase()).filter(Boolean))];
    const jitDomains = domains === null ? null : sql.array(domains, "TEXT");
    try {
      const [row] = await sql`
        UPDATE project_business_organizations SET
          name = COALESCE(${name ?? null}, name),
          slug = COALESCE(${slug}, slug),
          description = CASE WHEN ${input.description !== undefined} THEN ${input.description ?? null} ELSE description END,
          branding = CASE WHEN ${input.branding !== undefined} THEN ${JSON.stringify(input.branding || {})}::jsonb ELSE branding END,
          jit_enabled = CASE WHEN ${input.jit_enabled !== undefined} THEN ${input.jit_enabled ?? false} ELSE jit_enabled END,
          jit_domains = CASE WHEN ${jitDomains !== null} THEN ${jitDomains} ELSE jit_domains END,
          updated_at = NOW()
        WHERE project_ref = ${ref} AND id = ${organizationId}
        RETURNING *
      `;
      return row;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("An organization with this slug already exists");
      }
      throw error;
    }
  },

  async remove(ref: string, organizationId: string) {
    await organizationOrThrow(ref, organizationId);
    const [counts] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM project_business_organization_members WHERE organization_id = ${organizationId}) AS members,
        (SELECT COUNT(*)::int FROM project_business_organization_applications WHERE organization_id = ${organizationId}) AS applications
    `;
    if (Number(counts?.members || 0) > 0 || Number(counts?.applications || 0) > 0) {
      throw new ConflictError("Remove organization members and application bindings before deleting the organization");
    }
    const [row] = await sql`
      DELETE FROM project_business_organizations
      WHERE project_ref = ${ref} AND id = ${organizationId}
      RETURNING *
    `;
    return row;
  },

  async listMembers(ref: string, organizationId: string) {
    await organizationOrThrow(ref, organizationId);
    const rows = await sql`
      SELECT * FROM project_business_organization_members
      WHERE organization_id = ${organizationId}
      ORDER BY created_at ASC
    `;
    return { items: rows, total: rows.length };
  },

  async listForUser(ref: string, userId: string) {
    if (!(await projectExists(ref))) throw new NotFoundError("Project", ref);
    await assertGoTrueUser(ref, userId);
    const rows = await sql`
      SELECT o.*, membership.role AS member_role, membership.created_at AS joined_at
      FROM project_business_organizations o
      JOIN project_business_organization_members membership
        ON membership.organization_id = o.id
      WHERE o.project_ref = ${ref} AND membership.user_id = ${userId}
      ORDER BY o.created_at DESC
    `;
    return { items: rows, total: rows.length };
  },

  async reconcileJitMemberships(ref: string, userId: string) {
    if (!(await projectExists(ref))) throw new NotFoundError("Project", ref);
    const email = await readGoTrueUserEmail(ref, userId);
    const rows = await materializeJitMemberships(ref, userId, emailDomain(email));
    const total = Number(rows[0]?.total || 0);
    const items = rows.map(({ total: _total, ...membership }) => membership);
    return {
      items,
      total,
      limit: MAX_JIT_MEMBERSHIPS,
      truncated: total > items.length,
    };
  },

  async addMember(ref: string, organizationId: string, input: AddOrganizationMemberInput) {
    await organizationOrThrow(ref, organizationId);
    await assertGoTrueUser(ref, input.userId);
    const normalized = normalizedRole(input.role);
    return sql.begin(async (transaction) => {
      const mutation = await mutateOrganizationMember(
        transaction,
        organizationId,
        input.userId,
        normalized,
      );
      await enqueueOrganizationMemberMutation(transaction, ref, input.actor, mutation);
      return mutation.member;
    });
  },

  async updateMember(
    ref: string,
    organizationId: string,
    memberKey: string,
    input: { role: string; actor: string },
  ) {
    await organizationOrThrow(ref, organizationId);
    const normalized = normalizedRole(input.role);
    return sql.begin(async (transaction) => {
      const existingMember = await organizationMemberByKey(transaction, organizationId, memberKey);
      if (!existingMember) throw new NotFoundError("Organization member", memberKey);
      const mutation = await changeOrganizationMemberRole(transaction, existingMember, normalized);
      await enqueueOrganizationMemberMutation(transaction, ref, input.actor, mutation);
      return mutation.member;
    });
  },

  async removeMember(ref: string, organizationId: string, memberKey: string, actor: string) {
    await organizationOrThrow(ref, organizationId);
    return sql.begin(async (transaction) => {
      const [member] = await transaction`
        DELETE FROM project_business_organization_members
        WHERE organization_id = ${organizationId}
          AND (id::text = ${memberKey} OR user_id = ${memberKey})
        RETURNING *
      `;
      if (!member) throw new NotFoundError("Organization member", memberKey);
      await enqueueWebhookEventInTransaction(transaction, {
        projectRef: ref,
        event: {
          type: "organization.member_removed",
          payload: {
            org_id: member.organization_id,
            member_id: member.id,
            user_id: member.user_id,
            role: member.role,
          },
        },
        idempotencyKey: `organization.member_removed:${member.id}`,
        actor,
      });
      return member;
    });
  },

  async listInvitations(ref: string, organizationId: string) {
    await organizationOrThrow(ref, organizationId);
    const rows = await sql`
      SELECT *, CASE WHEN status = 'pending' AND expires_at <= NOW() THEN 'expired' ELSE status END AS effective_status
      FROM project_business_organization_invitations
      WHERE organization_id = ${organizationId}
      ORDER BY created_at DESC
    ` as Array<Record<string, unknown>>;
    return { items: rows.map(({ token_hash: _tokenHash, ...row }: Record<string, unknown>) => row), total: rows.length };
  },

  async invite(input: InviteOrganizationMemberInput) {
    await organizationOrThrow(input.ref, input.organizationId);
    const email = normalizedEmail(input.email);
    const normalized = normalizedRole(input.role);
    const token = inviteToken();
    const tokenHash = hashToken(token);
    const ttlHours = input.ttlHours ?? 168;
    const expiresAt = new Date(Date.now() + Math.min(30 * 24, Math.max(1, ttlHours)) * 60 * 60 * 1000);
    return sql.begin(async (transaction) => {
      const inserted = await transaction`
        INSERT INTO project_business_organization_invitations (
          organization_id, email, role, token_hash, invited_by, expires_at
        ) VALUES (${input.organizationId}, ${email}, ${normalized}, ${tokenHash}, ${input.actor}, ${expiresAt})
        ON CONFLICT DO NOTHING
        RETURNING *
      `;
      const [invitation] = inserted.length > 0 ? inserted : await transaction`
        UPDATE project_business_organization_invitations
        SET role = ${normalized}, token_hash = ${tokenHash}, invited_by = ${input.actor},
            expires_at = ${expiresAt}, updated_at = NOW()
        WHERE organization_id = ${input.organizationId} AND lower(email) = ${email} AND status = 'pending'
        RETURNING *
      `;
      await enqueueWebhookEventInTransaction(transaction, {
        projectRef: input.ref,
        event: {
          type: "organization.invitation_created",
          payload: {
            org_id: invitation.organization_id,
            invitation_id: invitation.id,
            email: invitation.email,
            role: invitation.role,
          },
        },
        idempotencyKey: `organization.invitation_created:${invitation.id}`,
        actor: input.actor,
      });
      const { token_hash: _tokenHash, ...publicInvitation } = invitation;
      return { ...publicInvitation, token };
    });
  },

  async acceptInvitation(input: AcceptOrganizationInvitationInput) {
    await organizationOrThrow(input.ref, input.organizationId);
    return sql.begin(async (tx) => {
      const [invitation] = await tx`
        SELECT * FROM project_business_organization_invitations
        WHERE organization_id = ${input.organizationId} AND id = ${input.invitationId}
        FOR UPDATE
      `;
      if (!invitation) throw new NotFoundError("Organization invitation", input.invitationId);
      if (invitation.status !== "pending" || new Date(invitation.expires_at as string).getTime() <= Date.now()) {
        throw new ConflictError("Invitation is no longer active");
      }
      if (invitation.token_hash !== hashToken(input.token)) throw new ValidationError("Invalid invitation token");
      if (String(invitation.email).toLowerCase() !== input.principal.email) {
        throw new ForbiddenError("Invitation email does not match the authenticated GoTrue user");
      }
      const [member] = await tx`
        INSERT INTO project_business_organization_members (organization_id, user_id, role)
        VALUES (${input.organizationId}, ${input.principal.id}, ${invitation.role})
        ON CONFLICT (organization_id, user_id)
        DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()
        RETURNING *
      `;
      await tx`
        UPDATE project_business_organization_invitations
        SET status = 'accepted', accepted_user_id = ${input.principal.id}, accepted_at = NOW(), updated_at = NOW()
        WHERE id = ${input.invitationId}
      `;
      await enqueueWebhookEventInTransaction(tx, {
        projectRef: input.ref,
        event: {
          type: "organization.member_added",
          payload: {
            org_id: member.organization_id,
            member_id: member.id,
            user_id: member.user_id,
            role: member.role,
          },
        },
        idempotencyKey: `organization.member_added:${member.id}`,
        actor: input.principal.id,
      });
      return member;
    });
  },

  async revokeInvitation(ref: string, organizationId: string, invitationId: string) {
    await organizationOrThrow(ref, organizationId);
    const [row] = await sql`
      UPDATE project_business_organization_invitations
      SET status = 'revoked', updated_at = NOW()
      WHERE organization_id = ${organizationId} AND id = ${invitationId} AND status = 'pending'
      RETURNING *
    `;
    if (!row) throw new NotFoundError("Active organization invitation", invitationId);
    const { token_hash: _tokenHash, ...publicRow } = row;
    return publicRow;
  },

  async listApplications(ref: string, organizationId: string) {
    await organizationOrThrow(ref, organizationId);
    const rows = await sql`
      SELECT * FROM project_business_organization_applications
      WHERE organization_id = ${organizationId}
      ORDER BY created_at ASC
    `;
    return { items: rows, total: rows.length };
  },

  async bindApplication(ref: string, organizationId: string, applicationId: string, actor: string) {
    await organizationOrThrow(ref, organizationId);
    await assertGoTrueApplication(ref, applicationId);
    const [row] = await sql`
      INSERT INTO project_business_organization_applications (organization_id, application_id, created_by)
      VALUES (${organizationId}, ${applicationId}, ${actor})
      ON CONFLICT (organization_id, application_id) DO UPDATE SET application_id = EXCLUDED.application_id
      RETURNING *
    `;
    return row;
  },

  async unbindApplication(ref: string, organizationId: string, applicationId: string) {
    await organizationOrThrow(ref, organizationId);
    const [row] = await sql`
      DELETE FROM project_business_organization_applications
      WHERE organization_id = ${organizationId} AND application_id = ${applicationId}
      RETURNING *
    `;
    if (!row) throw new NotFoundError("Organization application binding", applicationId);
    return row;
  },
};
