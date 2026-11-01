import { createHash, randomBytes } from "node:crypto";
import type { SQL } from "bun";
import { getProjectDb, resolveDbName, sql } from "../db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../utils/errors";
import type { InvitationPrincipal } from "./invitation-principal.service";
import type { TrustedPrincipal } from "./bff-proof.service";
import { getAuthRuntimeDescriptor } from "./auth-runtime.service";
import {
  effectiveCollaboratorCapabilities,
  isTeamGrantActor,
  normalizeCapabilityAllowlist,
  ROLE_CAPABILITIES,
  teamGrantActor,
  type CollaboratorCapability,
  type CollaboratorRole,
} from "./collaborator-capabilities";

export type { CollaboratorCapability, CollaboratorRole } from "./collaborator-capabilities";

type AcceptCollaboratorInvitationInput = {
  ref: string;
  invitationId: string;
  token: string;
  principal: InvitationPrincipal;
};

function normalizeRole(value: string, allowOwner = true): CollaboratorRole {
  const role = value.trim().toLowerCase() as CollaboratorRole;
  if (!Object.hasOwn(ROLE_CAPABILITIES, role) || (!allowOwner && role === "owner")) {
    throw new ValidationError(allowOwner
      ? "role must be owner, admin, member or viewer"
      : "invitation role must be admin, member or viewer");
  }
  return role;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("A valid email is required");
  return email;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function invitationToken(): string {
  return `collabinv_${randomBytes(32).toString("base64url")}`;
}

function allowlistFromRow(row: Record<string, unknown>): string[] | null {
  const value = row["capability_allowlist"];
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function publicCollaborator(row: Record<string, unknown>) {
  const role = row["role"] as CollaboratorRole;
  const allowlist = allowlistFromRow(row);
  return {
    ...row,
    scope: "project",
    capability_allowlist: allowlist,
    capabilities: effectiveCollaboratorCapabilities(role, allowlist),
  };
}

async function projectOrThrow(ref: string) {
  const [project] = await sql`SELECT ref FROM projects WHERE ref = ${ref} AND deleted_at IS NULL`;
  if (!project) throw new NotFoundError("Project", ref);
  return project;
}

async function actorCapabilities(ref: string, actor: TrustedPrincipal): Promise<Set<string>> {
  if (actor.platformAdmin) return new Set(ROLE_CAPABILITIES.owner);
  const [collaborator] = await sql`
    SELECT role, capability_allowlist FROM project_collaborators
    WHERE project_ref = ${ref} AND principal_id = ${actor.id} AND status = 'active'
    LIMIT 1
  `;
  if (!collaborator) throw new ForbiddenError("The current principal is not an active project collaborator");
  return new Set(effectiveCollaboratorCapabilities(
    collaborator.role as CollaboratorRole,
    allowlistFromRow(collaborator),
  ));
}

function assertCapabilityPresent(capabilities: Set<string>, capability: CollaboratorCapability): void {
  if (!capabilities.has(capability)) throw new ForbiddenError(`Missing collaborator capability: ${capability}`);
}

async function assertPrincipalExists(ref: string, principalId: string): Promise<void> {
  const authorityRef = getAuthRuntimeDescriptor(ref).authority_project_ref;
  const authorityDb = getProjectDb(await resolveDbName(authorityRef));
  const [user] = await authorityDb`
    SELECT id FROM auth.users
    WHERE id::text = ${principalId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!user) throw new NotFoundError("GoTrue user", principalId);
}

export async function requireCapability(
  ref: string,
  actor: TrustedPrincipal,
  capability: CollaboratorCapability,
): Promise<void> {
  assertCapabilityPresent(await actorCapabilities(ref, actor), capability);
}

function assertInvitationCanBeAccepted(
  invitation: Record<string, unknown> | undefined,
  input: AcceptCollaboratorInvitationInput,
): asserts invitation is Record<string, unknown> {
  if (!invitation) throw new NotFoundError("Collaborator invitation", input.invitationId);
  if (invitation["status"] !== "pending" || new Date(String(invitation["expires_at"])).getTime() <= Date.now()) {
    throw new ConflictError("Invitation is no longer active");
  }
  if (invitation["token_hash"] !== tokenHash(input.token)) throw new ValidationError("Invalid invitation token");
  if (String(invitation["email"]).toLowerCase() !== input.principal.email) {
    throw new ForbiddenError("Invitation email does not match the authenticated GoTrue user");
  }
}

async function existingInvitationCollaborator(
  tx: SQL,
  input: AcceptCollaboratorInvitationInput,
): Promise<Record<string, unknown> | null> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`project-collaborator:${input.ref}:${input.principal.id}`}))`;
  const [existing] = await tx`
    SELECT * FROM project_collaborators
    WHERE project_ref = ${input.ref} AND principal_id = ${input.principal.id}
    FOR UPDATE
  `;
  if (existing?.status === "suspended") {
    throw new ConflictError("A suspended collaborator must be reactivated by an authorized project owner or admin");
  }
  return existing || null;
}

async function createInvitedCollaborator(
  tx: SQL,
  input: AcceptCollaboratorInvitationInput,
  invitation: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [collaborator] = await tx`
    INSERT INTO project_collaborators (project_ref, principal_id, email, role, created_by)
    VALUES (${input.ref}, ${input.principal.id}, ${invitation["email"]}, ${invitation["role"]}, ${invitation["invited_by"]})
    RETURNING *
  `;
  return collaborator;
}

async function lockedCollaborator(tx: SQL, ref: string, collaboratorId: string): Promise<Record<string, unknown>> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`project-owner:${ref}`}))`;
  const [collaborator] = await tx`
    SELECT * FROM project_collaborators
    WHERE project_ref = ${ref} AND id = ${collaboratorId}
    FOR UPDATE
  `;
  if (!collaborator) throw new NotFoundError("Project collaborator", collaboratorId);
  return collaborator;
}

async function assertActiveOwnerRemains(tx: SQL, ref: string, message: string): Promise<void> {
  const [count] = await tx`
    SELECT COUNT(*)::int AS count FROM project_collaborators
    WHERE project_ref = ${ref} AND role = 'owner' AND status = 'active'
  `;
  if (Number(count?.count || 0) <= 1) throw new ConflictError(message);
}

export type TeamGrantEnforcement =
  | "linked"
  | "released"
  | "principal_missing"
  | "skipped_existing_collaborator"
  | "skipped_owner"
  | "not_team_managed";

export async function applyTeamProjectGrant(input: {
  ref: string;
  principalId: string;
  email: string | null;
  role: string;
  teamId: string;
  allowlist: readonly string[] | null;
}): Promise<{ enforcement: TeamGrantEnforcement; collaborator_id?: string }> {
  await projectOrThrow(input.ref);
  const role = normalizeRole(input.role, false);
  const allowlist = normalizeCapabilityAllowlist(role, input.allowlist);
  const marker = teamGrantActor(input.teamId);
  const principalId = input.principalId.trim();
  if (!principalId) throw new ValidationError("principal_id is required");
  try {
    await assertPrincipalExists(input.ref, principalId);
  } catch (error) {
    if (error instanceof NotFoundError) return { enforcement: "principal_missing" };
    throw error;
  }
  const [existing] = await sql`
    SELECT id, role, status, created_by
    FROM project_collaborators
    WHERE project_ref = ${input.ref} AND principal_id = ${principalId}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  if (existing) {
    if (!isTeamGrantActor(existing["created_by"], input.teamId)) {
      return { enforcement: "skipped_existing_collaborator" };
    }
    if (existing["role"] === "owner") return { enforcement: "skipped_owner" };
  }
  const [row] = await sql`
    INSERT INTO project_collaborators (
      project_ref, principal_id, email, role, created_by, capability_allowlist
    ) VALUES (
      ${input.ref}, ${principalId}, ${input.email}, ${role}, ${marker}, ${allowlist}::text[]
    )
    ON CONFLICT (project_ref, principal_id) DO UPDATE SET
      email = EXCLUDED.email,
      role = EXCLUDED.role,
      capability_allowlist = EXCLUDED.capability_allowlist,
      status = 'active',
      updated_at = NOW()
    WHERE project_collaborators.created_by = EXCLUDED.created_by
      AND project_collaborators.role <> 'owner'
    RETURNING id
  ` as Array<{ id?: string }>;
  if (!row?.id) return { enforcement: "skipped_existing_collaborator" };
  return { enforcement: "linked", collaborator_id: String(row.id) };
}

export async function releaseTeamProjectGrant(input: {
  ref: string;
  principalId: string;
  teamId: string;
}): Promise<{ enforcement: TeamGrantEnforcement }> {
  const marker = teamGrantActor(input.teamId);
  const principalId = input.principalId.trim();
  const [existing] = await sql`
    SELECT id, role, created_by
    FROM project_collaborators
    WHERE project_ref = ${input.ref} AND principal_id = ${principalId}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  if (!existing || !isTeamGrantActor(existing["created_by"], input.teamId)) {
    return { enforcement: "not_team_managed" };
  }
  if (existing["role"] === "owner") return { enforcement: "skipped_owner" };
  const [row] = await sql`
    DELETE FROM project_collaborators
    WHERE project_ref = ${input.ref}
      AND principal_id = ${principalId}
      AND created_by = ${marker}
      AND role <> 'owner'
    RETURNING id
  ` as Array<{ id?: string }>;
  return { enforcement: row?.id ? "released" : "not_team_managed" };
}

export const projectCollaboratorService = {
  async list(ref: string, actor: TrustedPrincipal) {
    await projectOrThrow(ref);
    assertCapabilityPresent(await actorCapabilities(ref, actor), "tenant.members.read");
    const rows = await sql`
      SELECT * FROM project_collaborators
      WHERE project_ref = ${ref}
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
               created_at ASC
    ` as Array<Record<string, unknown>>;
    return { items: rows.map(publicCollaborator), total: rows.length, scope: "project" };
  },

  async create(ref: string, input: { principal_id: string; email?: string | null; role: string }, actor: TrustedPrincipal) {
    await projectOrThrow(ref);
    const principalId = input.principal_id.trim();
    if (!principalId) throw new ValidationError("principal_id is required");
    const role = normalizeRole(input.role);
    const capabilities = await actorCapabilities(ref, actor);
    assertCapabilityPresent(capabilities, role === "owner" ? "tenant.owner.transfer" : "tenant.members.manage");
    await assertPrincipalExists(ref, principalId);
    const email = input.email ? normalizeEmail(input.email) : null;
    try {
      const [row] = await sql`
        INSERT INTO project_collaborators (project_ref, principal_id, email, role, created_by)
        VALUES (${ref}, ${principalId}, ${email}, ${role}, ${actor.id})
        RETURNING *
      `;
      return publicCollaborator(row);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
        throw new ConflictError("Collaborator already exists");
      }
      throw error;
    }
  },

  async update(ref: string, collaboratorId: string, input: { role?: string; status?: string }, actor: TrustedPrincipal) {
    await projectOrThrow(ref);
    const capabilities = await actorCapabilities(ref, actor);
    assertCapabilityPresent(capabilities, "tenant.members.manage");
    const role = input.role === undefined ? null : normalizeRole(input.role);
    const nextStatus = input.status?.trim().toLowerCase() || null;
    if (nextStatus && !["active", "suspended"].includes(nextStatus)) {
      throw new ValidationError("status must be active or suspended");
    }
    return sql.begin(async (tx) => {
      const current = await lockedCollaborator(tx, ref, collaboratorId);
      if (current["role"] === "owner" || role === "owner") {
        assertCapabilityPresent(capabilities, "tenant.owner.transfer");
      }
      const removesOwner = current["role"] === "owner"
        && ((role !== null && role !== "owner") || nextStatus === "suspended");
      if (removesOwner) {
        await assertActiveOwnerRemains(tx, ref, "A project must retain at least one active owner");
      }
      const [row] = await tx`
        UPDATE project_collaborators SET
          role = COALESCE(${role}, role),
          status = COALESCE(${nextStatus}, status),
          updated_at = NOW()
        WHERE project_ref = ${ref} AND id = ${collaboratorId}
        RETURNING *
      `;
      return publicCollaborator(row);
    });
  },

  async remove(ref: string, collaboratorId: string, actor: TrustedPrincipal) {
    await projectOrThrow(ref);
    const capabilities = await actorCapabilities(ref, actor);
    assertCapabilityPresent(capabilities, "tenant.members.manage");
    return sql.begin(async (tx) => {
      const current = await lockedCollaborator(tx, ref, collaboratorId);
      if (current["role"] === "owner") assertCapabilityPresent(capabilities, "tenant.owner.transfer");
      if (current["role"] === "owner" && current["status"] === "active") {
        await assertActiveOwnerRemains(tx, ref, "The last active owner cannot be removed");
      }
      const [row] = await tx`
        DELETE FROM project_collaborators
        WHERE project_ref = ${ref} AND id = ${collaboratorId}
        RETURNING *
      `;
      return publicCollaborator(row);
    });
  },

  async listInvitations(ref: string, actor: TrustedPrincipal) {
    await projectOrThrow(ref);
    assertCapabilityPresent(await actorCapabilities(ref, actor), "tenant.members.read");
    const rows = await sql`
      SELECT *, CASE WHEN status = 'pending' AND expires_at <= NOW() THEN 'expired' ELSE status END AS effective_status
      FROM project_collaborator_invitations
      WHERE project_ref = ${ref}
      ORDER BY created_at DESC
    `;
    return {
      items: rows.map(({ token_hash: _tokenHash, ...row }: Record<string, unknown>) => ({ ...row, scope: "project" })),
      total: rows.length,
      scope: "project",
    };
  },

  async invite(ref: string, input: { email: string; role: string; ttl_hours?: number }, actor: TrustedPrincipal) {
    await projectOrThrow(ref);
    assertCapabilityPresent(await actorCapabilities(ref, actor), "tenant.members.manage");
    const email = normalizeEmail(input.email);
    const role = normalizeRole(input.role, false);
    const token = invitationToken();
    const ttlHours = Math.min(720, Math.max(1, input.ttl_hours || 168));
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    const inserted = await sql`
      INSERT INTO project_collaborator_invitations (
        project_ref, email, role, token_hash, invited_by, expires_at
      ) VALUES (${ref}, ${email}, ${role}, ${tokenHash(token)}, ${actor.id}, ${expiresAt})
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    const [row] = inserted.length > 0 ? inserted : await sql`
      UPDATE project_collaborator_invitations
      SET role = ${role}, token_hash = ${tokenHash(token)}, invited_by = ${actor.id},
          expires_at = ${expiresAt}, updated_at = NOW()
      WHERE project_ref = ${ref} AND lower(email) = ${email} AND status = 'pending'
      RETURNING *
    `;
    const { token_hash: _tokenHash, ...publicRow } = row;
    return { ...publicRow, scope: "project", token };
  },

  async resend(ref: string, invitationId: string, actor: TrustedPrincipal) {
    assertCapabilityPresent(await actorCapabilities(ref, actor), "tenant.members.manage");
    const [current] = await sql`
      SELECT email, role FROM project_collaborator_invitations
      WHERE project_ref = ${ref} AND id = ${invitationId} AND status = 'pending'
    `;
    if (!current) throw new NotFoundError("Active collaborator invitation", invitationId);
    return this.invite(ref, { email: String(current.email), role: String(current.role) }, actor);
  },

  async accept(input: AcceptCollaboratorInvitationInput) {
    await projectOrThrow(input.ref);
    return sql.begin(async (tx) => {
      const [invitation] = await tx`
        SELECT * FROM project_collaborator_invitations
        WHERE project_ref = ${input.ref} AND id = ${input.invitationId}
        FOR UPDATE
      `;
      assertInvitationCanBeAccepted(invitation, input);
      const existing = await existingInvitationCollaborator(tx, input);
      const collaborator = existing || await createInvitedCollaborator(tx, input, invitation);
      await tx`
        UPDATE project_collaborator_invitations
        SET status = 'accepted', accepted_principal_id = ${input.principal.id}, accepted_at = NOW(), updated_at = NOW()
        WHERE id = ${input.invitationId}
      `;
      return publicCollaborator(collaborator);
    });
  },

  async revokeInvitation(ref: string, invitationId: string, actor: TrustedPrincipal) {
    assertCapabilityPresent(await actorCapabilities(ref, actor), "tenant.members.manage");
    const [row] = await sql`
      UPDATE project_collaborator_invitations
      SET status = 'revoked', updated_at = NOW()
      WHERE project_ref = ${ref} AND id = ${invitationId} AND status = 'pending'
      RETURNING *
    `;
    if (!row) throw new NotFoundError("Active collaborator invitation", invitationId);
    const { token_hash: _tokenHash, ...publicRow } = row;
    return { ...publicRow, scope: "project" };
  },

  requireCapability,
};
